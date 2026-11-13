use crate::server::WsHub;
use crate::store::AppState;
use serde_json::json;
use std::sync::{Arc, Mutex, OnceLock};

struct TrayContext {
    state: Arc<Mutex<AppState>>,
    ws_hub: WsHub,
}

static TRAY_CTX: OnceLock<TrayContext> = OnceLock::new();

#[cfg(windows)]
const WM_TRAYICON: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 1;
const ID_VERSION: usize = 1000;
const ID_OPEN: usize = 1001;
const ID_OPEN_LOCAL: usize = 1005;
const ID_PAIR: usize = 1002;
const ID_COPY_PAIR: usize = 1007;
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
        DispatchMessageW, GetCursorPos, GetMessageW, PostQuitMessage, RegisterClassW,
        SetForegroundWindow, TrackPopupMenu, TranslateMessage, CW_USEDEFAULT,
        MF_DISABLED, MF_GRAYED, MF_SEPARATOR, MF_STRING, MSG, TPM_BOTTOMALIGN, TPM_LEFTALIGN,
        WM_COMMAND, WM_DESTROY, WM_LBUTTONDBLCLK, WM_RBUTTONUP, WNDCLASSW,
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
                    ID_COPY_PAIR => copy_pair_code_to_clipboard(),
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
            let c = s.get_or_create_pair_code();
            (s.settings.paused, c)
        };

        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }

        let ver_str = format!("Mentions v{}\0", env!("CARGO_PKG_VERSION"));
        let ver_lbl: Vec<u16> = ver_str.encode_utf16().collect();
        let open_lbl: Vec<u16> = "Open Web Controller\0".encode_utf16().collect();
        let local_lbl: Vec<u16> = "Open Local Controller (Offline)\0".encode_utf16().collect();
        let pair_lbl: Vec<u16> = format!("Pair Browser (Code: {})\0", code)
            .encode_utf16()
            .collect();
        let copy_pair_lbl: Vec<u16> = format!("Copy Pair Code ({})\0", code)
            .encode_utf16()
            .collect();
        let pause_lbl: Vec<u16> = if paused {
            "Resume Expansion\0".encode_utf16().collect()
        } else {
            "Pause Expansion\0".encode_utf16().collect()
        };
        let restart_lbl: Vec<u16> = "Restart Mentions\0".encode_utf16().collect();
        let quit_lbl: Vec<u16> = "Quit Mentions\0".encode_utf16().collect();

        AppendMenuW(menu, MF_STRING | MF_DISABLED | MF_GRAYED, ID_VERSION, ver_lbl.as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(menu, MF_STRING, ID_OPEN, open_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_OPEN_LOCAL, local_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_PAIR, pair_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_COPY_PAIR, copy_pair_lbl.as_ptr());
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
            let code = s.get_or_create_pair_code();
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
            (s.get_or_create_pair_code(), s.settings.port)
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
            (s.get_or_create_pair_code(), s.settings.port)
        };
        let url = format!("{}/pair?code={}&port={}", super::CONTROLLER_URL, code, port);
        open_browser(&url);
    }

    fn copy_pair_code_to_clipboard() {
        let Some(ctx) = TRAY_CTX.get() else {
            return;
        };
        let code = {
            let mut s = ctx.state.lock().unwrap();
            s.get_or_create_pair_code()
        };

        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::DataExchange::{
                CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
            };
            use windows_sys::Win32::System::Memory::{
                GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
            };

            const CF_UNICODETEXT: u32 = 13;
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                EmptyClipboard();
                let mut wide: Vec<u16> = code.encode_utf16().collect();
                wide.push(0);
                let byte_len = wide.len() * 2;
                let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
                if !hmem.is_null() {
                    let dst = GlobalLock(hmem) as *mut u16;
                    if !dst.is_null() {
                        std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
                        GlobalUnlock(hmem);
                        SetClipboardData(CF_UNICODETEXT, hmem);
                    }
                }
                CloseClipboard();
            }
        }
    }

    fn toggle_pause() {
        let Some(ctx) = TRAY_CTX.get() else {
            return;
        };
        let next = {
            let mut s = ctx.state.lock().unwrap();
            s.settings.paused = !s.settings.paused;
            s.save_settings();
            crate::hook::refresh_hook_snapshot(&s);
            s.settings.paused
        };
        ctx.ws_hub
            .broadcast(&json!({ "type": "hook.state", "paused": next }));
    }

    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name: Vec<u16> = "MentionsTrayWindowClass\0".encode_utf16().collect();

        let app_icon = create_icon_from_png(include_bytes!("../assets/mentions_icon.png"));

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

        let tip_str = format!("Mentions v{} · Active\0", env!("CARGO_PKG_VERSION"));
        let tip: Vec<u16> = tip_str.encode_utf16().collect();
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
unsafe fn create_icon_from_png(bytes: &[u8]) -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIconFromResourceEx, LoadIconW, IDI_APPLICATION, LR_DEFAULTCOLOR,
    };

    let icon = CreateIconFromResourceEx(
        bytes.as_ptr(),
        bytes.len() as u32,
        1,
        0x00030000,
        32,
        32,
        LR_DEFAULTCOLOR,
    );

    if icon.is_null() {
        LoadIconW(std::ptr::null_mut(), IDI_APPLICATION)
    } else {
        icon
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
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('{}'); $s.TargetPath = '{}'; $s.WorkingDirectory = '{}'; $s.IconLocation = '{},0'; $s.Description = 'Mentions Text Expansion'; $s.Save()",
        link_path.display(),
        target_exe.display(),
        target_exe.parent().map(|p| p.display().to_string()).unwrap_or_default(),
        target_exe.display()
    );

    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .status();
}

#[cfg(not(windows))]
pub fn run_tray_loop(_state: Arc<Mutex<AppState>>, _ws_hub: WsHub) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

#[cfg(not(windows))]
pub fn install_shortcuts_if_needed() {}