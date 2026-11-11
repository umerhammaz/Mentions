#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hook;
mod injector;
mod server;
mod store;
mod tray;

use std::sync::{Arc, Mutex};
use store::AppState;

pub const CONTROLLER_URL: &str = "https://mentions-but.pages.dev";

fn main() {
    let _instance_guard = match acquire_single_instance() {
        Some(g) => g,
        None => {
            tray::open_browser(CONTROLLER_URL);
            return;
        }
    };

    let state = Arc::new(Mutex::new(AppState::load()));
    {
        let s = state.lock().unwrap();
        store::sync_autostart(s.settings.autostart);
    }

    let ws_hub = server::WsHub::new();

    hook::start_hook_engine(Arc::clone(&state));
    server::start_http_server(Arc::clone(&state), ws_hub.clone());
    tray::run_tray_loop(state, ws_hub);
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