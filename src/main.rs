#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hook;
mod injector;
mod server;
mod store;
mod suggest;
mod tray;
mod updater;

use std::io::Write;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use store::AppState;

pub const PRIMARY_CONTROLLER_URL: &str = "https://mentions.umer.ai";
pub const CONTROLLER_URL: &str = PRIMARY_CONTROLLER_URL;

static INSTANCE_GUARD: Mutex<Option<InstanceGuard>> = Mutex::new(None);

pub fn release_instance_guard() {
    if let Ok(mut guard) = INSTANCE_GUARD.lock() {
        *guard = None;
    }
}

fn parse_updated_from_arg() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--updated-from" {
            return args.next();
        }
    }
    None
}

fn main() {
    let updated_from = parse_updated_from_arg();
    updater::set_just_updated_from(updated_from.clone());
    updater::cleanup_old_files();

    #[cfg(windows)]
    tray::install_shortcuts_if_needed();

    let state = Arc::new(Mutex::new(AppState::load()));
    let port = {
        let s = state.lock().unwrap();
        store::sync_autostart(s.settings.autostart);
        s.settings.port
    };

    let guard = match acquire_or_replace_instance(port) {
        Some(g) => g,
        None => {
            tray::open_browser(CONTROLLER_URL);
            return;
        }
    };
    if let Ok(mut slot) = INSTANCE_GUARD.lock() {
        *slot = Some(guard);
    }

    let ws_hub = server::WsHub::new();

    injector::init_injector_state(Arc::clone(&state));
    suggest::start_suggest_engine();
    hook::start_hook_engine(Arc::clone(&state));
    server::start_http_server(Arc::clone(&state), ws_hub.clone());
    updater::start_updater_loop(Arc::clone(&state), ws_hub.clone());
    tray::run_tray_loop(state, ws_hub, updated_from);
}

fn acquire_or_replace_instance(port: u16) -> Option<InstanceGuard> {
    if let Some(guard) = acquire_single_instance() {
        return Some(guard);
    }
    request_previous_shutdown(port);
    for _ in 0..15 {
        thread::sleep(Duration::from_millis(80));
        if let Some(guard) = acquire_single_instance() {
            return Some(guard);
        }
    }
    None
}

pub fn restart_daemon() {
    for _ in 0..40 {
        if !injector::is_busy() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    store::flush_pending_saves();
    server::stop_http_server();
    release_instance_guard();
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
        std::process::exit(0);
    }
}

fn request_previous_shutdown(port: u16) {
    let addr = format!("127.0.0.1:{}", port);
    if let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:31415".parse().unwrap()),
        Duration::from_millis(300),
    ) {
        let req = format!(
            "POST /api/internal/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            port
        );
        let _ = stream.write_all(req.as_bytes());
    }
}

#[cfg(windows)]
struct InstanceGuard(isize);

#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(
                    self.0 as windows_sys::Win32::Foundation::HANDLE,
                );
            }
        }
    }
}

#[cfg(windows)]
fn acquire_single_instance() -> Option<InstanceGuard> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = "Global\\MentionsDaemonSingleInstance\0"
        .encode_utf16()
        .collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
        if handle.is_null() {
            return None;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            windows_sys::Win32::Foundation::CloseHandle(handle);
            return None;
        }
        Some(InstanceGuard(handle as isize))
    }
}

#[cfg(not(windows))]
struct InstanceGuard;

#[cfg(not(windows))]
fn acquire_single_instance() -> Option<InstanceGuard> {
    Some(InstanceGuard)
}