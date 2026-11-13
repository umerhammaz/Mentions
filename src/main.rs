#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hook;
mod injector;
mod server;
mod store;
mod suggest;
mod tray;

use std::io::Write;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use store::AppState;

pub const PRIMARY_CONTROLLER_URL: &str = "https://mentions.umer.ai";
pub const CONTROLLER_URL: &str = PRIMARY_CONTROLLER_URL;

fn main() {
    #[cfg(windows)]
    tray::install_shortcuts_if_needed();

    let state = Arc::new(Mutex::new(AppState::load()));
    let port = {
        let s = state.lock().unwrap();
        store::sync_autostart(s.settings.autostart);
        s.settings.port
    };

    let _instance_guard = match acquire_or_replace_instance(port) {
        Some(g) => g,
        None => {
            tray::open_browser(CONTROLLER_URL);
            return;
        }
    };

    let ws_hub = server::WsHub::new();

    injector::init_injector_state(Arc::clone(&state));
    suggest::start_suggest_engine();
    hook::start_hook_engine(Arc::clone(&state));
    server::start_http_server(Arc::clone(&state), ws_hub.clone());
    tray::run_tray_loop(state, ws_hub);
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
    store::flush_pending_saves();
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
struct InstanceGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
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
        Some(InstanceGuard(handle))
    }
}

#[cfg(not(windows))]
struct InstanceGuard;

#[cfg(not(windows))]
fn acquire_single_instance() -> Option<InstanceGuard> {
    Some(InstanceGuard)
}