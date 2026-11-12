use crate::server::{self as _server, WsHub};
use crate::store::{self, AppState};
use serde_json::json;
use std::sync::{Arc, Mutex, OnceLock};

struct TrayContext {
    state: Arc<Mutex<AppState>>,
    ws_hub: WsHub,
}

static TRAY_CTX: OnceLock<TrayContext> = OnceLock::new();

#[cfg(windows)]
const WM_TRAYICON: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 1;
const ID_OPEN: usize = 1001;
const ID_OPEN_LOCAL: usize = 1005;
const ID_PAIR: usize = 1002;
const ID_TOGGLE_PAUSE: usize = 1003;
const ID_RESTART: usize = 1006;
const ID_QUIT: usize = 1004;

pub fn open_browser(url: &str) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let op: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = format!("{}\0", url).encode_utf16().collect();
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        );
    }
    #[cfg(not(windows))]
    {
        let _ = url;
    }
}

#[cfg(windows)]
pub fn run_tray_loop(state: Arc<Mutex<AppState>>, ws_hub: WsHub) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
        DispatchMessageW, GetCursorPos, GetMessageW, LoadIconW, PostQuitMessage, RegisterClassW,
        SetForegroundWindow, TrackPopupMenu, TranslateMessage, CW_USEDEFAULT, IDI_APPLICATION,
        MF_SEPARATOR, MF_STRING, MSG, TPM_BOTTOMALIGN, TPM_LEFTALIGN, WM_COMMAND, WM_DESTROY,
        WM_LBUTTONDBLCLK, WM_RBUTTONUP, WNDCLASSW,
    };

    let _ = TRAY_CTX.set(TrayContext { state, ws_hub });

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        match msg {
            WM_TRAYICON => {
                let event = (lparam as u32) & 0xFFFF;
                if event == WM_RBUTTONUP {
                    show_context_menu(hwnd);
                } else if event == WM_LBUTTONDBLCLK {
                    launch_controller();
                }
                0
            }
            WM_COMMAND => {
                let cmd = wparam & 0xFFFF;
                match cmd {
                    ID_OPEN => launch_controller(),
                    ID_OPEN_LOCAL => launch_local_controller(),
                    ID_PAIR => launch_pairing(),
                    ID_TOGGLE_PAUSE => toggle_pause(),
                    ID_RESTART => crate::restart_daemon(),
                    ID_QUIT => {
                        if let Some(ctx) = TRAY_CTX.get() {
                            ctx.ws_hub.broadcast(&json!({ "type": "daemon.stopping" }));
                        }
                        PostQuitMessage(0);
                    }
                    _ => {}
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe fn show_context_menu(hwnd: HWND) {
        let Some(ctx) = TRAY_CTX.get() else {
            return;
        };
        let (paused, code) = {
            let mut s = ctx.state.lock().unwrap();
            if store::now_secs() > s.pair_expires_at {
                s.refresh_pair_code();
            }
            (s.settings.paused, s.pair_code.clone())
        };

        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }

        let open_lbl: Vec<u16> = "Open Web Controller\0".encode_utf16().collect();
        let local_lbl: Vec<u16> = "Open Local Controller (Offline)\0".encode_utf16().collect();
        let pair_lbl: Vec<u16> = format!("Pair Browser (Code: {})\0", code)
            .encode_utf16()
            .collect();
        let pause_lbl: Vec<u16> = if paused {
            "Resume Expansion\0".encode_utf16().collect()
        } else {
            "Pause Expansion\0".encode_utf16().collect()
        };
        let restart_lbl: Vec<u16> = "Restart Mentions\0".encode_utf16().collect();
        let quit_lbl: Vec<u16> = "Quit Mentions\0".encode_utf16().collect();

        AppendMenuW(menu, MF_STRING, ID_OPEN, open_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_OPEN_LOCAL, local_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_PAIR, pair_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_TOGGLE_PAUSE, pause_lbl.as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(menu, MF_STRING, ID_RESTART, restart_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_QUIT, quit_lbl.as_ptr());

        let mut pt = std::mem::zeroed();
        GetCursorPos(&mut pt);
        SetForegroundWindow(hwnd);
        TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_BOTTOMALIGN,
            pt.x,
            pt.y,
            0,
            hwnd,
            std::ptr::null(),
        );
        DestroyMenu(menu);
    }

    fn launch_controller() {
        let base = super::CONTROLLER_URL;
        let Some(ctx) = TRAY_CTX.get() else {
            open_browser(base);
            return;
        };
        let (needs_pair, code, port) = {
            let mut s = ctx.state.lock().unwrap();
            let code = s.refresh_pair_code();
            (s.tokens.is_empty(), code, s.settings.port)
        };
        if needs_pair {
            let url = format!("{}/pair?code={}&port={}", base, code, port);
            open_browser(&url);
        } else if port != 31415 {
            let url = format!("{}/?port={}", base, port);
            open_browser(&url);
        } else {
            open_browser(base);
        }
    }

    fn launch_local_controller() {
        let Some(ctx) = TRAY_CTX.get() else {
            open_browser("http://127.0.0.1:31415");
            return;
        };
        let (code, port) = {
            let mut s = ctx.state.lock().unwrap();
            (s.refresh_pair_code(), s.settings.port)
        };
        let url = format!("http://127.0.0.1:{}/pair?code={}&port={}", port, code, port);
        open_browser(&url);
    }

    fn launch_pairing() {
        let Some(ctx) = TRAY_CTX.get() else {
            return;
        };
        let (code, port) = {
            let mut s = ctx.state.lock().unwrap();
            (s.refresh_pair_code(), s.settings.port)
        };
        let url = format!("{}/pair?code={}&port={}", super::CONTROLLER_URL, code, port);
        open_browser(&url);
    }

    fn toggle_pause() {
        let Some(ctx) = TRAY_CTX.get() else {
            return;
        };
        let next = {
            let mut s = ctx.state.lock().unwrap();
            s.settings.paused = !s.settings.paused;
            s.save_settings();
            s.settings.paused
        };
        ctx.ws_hub
            .broadcast(&json!({ "type": "hook.state", "paused": next }));
    }

    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name: Vec<u16> = "MentionsTrayWindowClass\0".encode_utf16().collect();

        let mut app_icon = LoadIconW(hinstance, 1 as *const u16);
        if app_icon.is_null() {
            app_icon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
        }

        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: app_icon,
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );

        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        nid.uCallbackMessage = WM_TRAYICON;
        nid.hIcon = app_icon;

        let tip: Vec<u16> = "Mentions · Active\0".encode_utf16().collect();
        for (i, &ch) in tip.iter().take(nid.szTip.len()).enumerate() {
            nid.szTip[i] = ch;
        }

        Shell_NotifyIconW(NIM_ADD, &nid);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}

#[cfg(windows)]
pub fn install_shortcuts_if_needed() {
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };

    let user_profile = match std::env::var("USERPROFILE") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => return,
    };

    let appdata = match std::env::var("APPDATA") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => return,
    };

    let desktop_shortcut = user_profile.join("Desktop").join("Mentions.lnk");
    let start_menu_shortcut = appdata
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Mentions.lnk");

    if !desktop_shortcut.exists() {
        create_windows_shortcut(&current_exe, &desktop_shortcut);
    }
    if !start_menu_shortcut.exists() {
        create_windows_shortcut(&current_exe, &start_menu_shortcut);
    }
}

#[cfg(windows)]
fn create_windows_shortcut(target_exe: &std::path::Path, link_path: &std::path::Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoCreateInstance, CoInitialize, CoUninitialize, CLSCTX_INPROC_SERVER,
    };
    use windows_sys::Win32::UI::Shell::{IShellLinkW, IPersistFile};

    const CLSID_SHELL_LINK: windows_sys::core::GUID = windows_sys::core::GUID {
        data1: 0x00021401,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    const IID_ISHELL_LINK_W: windows_sys::core::GUID = windows_sys::core::GUID {
        data1: 0x000214F9,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    const IID_IPERSIST_FILE: windows_sys::core::GUID = windows_sys::core::GUID {
        data1: 0x0000010B,
        data2: 0x0000,
        data3: 0x0000,
        data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    unsafe {
        CoInitialize(std::ptr::null_mut());

        let mut shell_link_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        if CoCreateInstance(
            &CLSID_SHELL_LINK,
            std::ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &IID_ISHELL_LINK_W,
            &mut shell_link_ptr,
        ) == 0
        {
            let shell_link = &*(shell_link_ptr as *mut IShellLinkW);

            let mut target_w: Vec<u16> = target_exe.as_os_str().encode_wide().collect();
            target_w.push(0);
            (shell_link.lpVtbl.SetPath)(shell_link_ptr as _, target_w.as_ptr());

            if let Some(parent) = target_exe.parent() {
                let mut dir_w: Vec<u16> = parent.as_os_str().encode_wide().collect();
                dir_w.push(0);
                (shell_link.lpVtbl.SetWorkingDirectory)(shell_link_ptr as _, dir_w.as_ptr());
            }

            let desc: Vec<u16> = "Mentions Text Expansion\0".encode_utf16().collect();
            (shell_link.lpVtbl.SetDescription)(shell_link_ptr as _, desc.as_ptr());

            let mut persist_file_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            if (shell_link.lpVtbl.QueryInterface)(
                shell_link_ptr as _,
                &IID_IPERSIST_FILE,
                &mut persist_file_ptr,
            ) == 0
            {
                let persist_file = &*(persist_file_ptr as *mut IPersistFile);
                let mut link_w: Vec<u16> = link_path.as_os_str().encode_wide().collect();
                link_w.push(0);
                let _ = (persist_file.lpVtbl.Save)(persist_file_ptr as _, link_w.as_ptr(), 1);
                (persist_file.lpVtbl.Release)(persist_file_ptr as _);
            }

            (shell_link.lpVtbl.Release)(shell_link_ptr as _);
        }

        CoUninitialize();
    }
}

#[cfg(not(windows))]
pub fn run_tray_loop(_state: Arc<Mutex<AppState>>, _ws_hub: WsHub) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

#[cfg(not(windows))]
pub fn install_shortcuts_if_needed() {}