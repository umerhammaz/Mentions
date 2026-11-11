use crate::server::WsHub;
use crate::store::AppState;
use crate::CONTROLLER_URL;
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
const ID_PAIR: usize = 1002;
const ID_TOGGLE_PAUSE: usize = 1003;
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
                    ID_PAIR => launch_pairing(),
                    ID_TOGGLE_PAUSE => toggle_pause(),
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
            if crate::store::now_secs() > s.pair_expires_at {
                s.refresh_pair_code();
            }
            (s.settings.paused, s.pair_code.clone())
        };

        let menu = CreatePopupMenu();
        if menu.is_null() {
            return;
        }

        let open_lbl: Vec<u16> = "Open Mentions Controller\0".encode_utf16().collect();
        let pair_lbl: Vec<u16> = format!("Pair Browser (Code: {})\0", code)
            .encode_utf16()
            .collect();
        let pause_lbl: Vec<u16> = if paused {
            "Resume Expansion\0".encode_utf16().collect()
        } else {
            "Pause Expansion\0".encode_utf16().collect()
        };
        let quit_lbl: Vec<u16> = "Quit Mentions\0".encode_utf16().collect();

        AppendMenuW(menu, MF_STRING, ID_OPEN, open_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_PAIR, pair_lbl.as_ptr());
        AppendMenuW(menu, MF_STRING, ID_TOGGLE_PAUSE, pause_lbl.as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
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
        let Some(ctx) = TRAY_CTX.get() else {
            open_browser(CONTROLLER_URL);
            return;
        };
        let (needs_pair, code, port) = {
            let mut s = ctx.state.lock().unwrap();
            let code = s.refresh_pair_code();
            (s.tokens.is_empty(), code, s.settings.port)
        };
        if needs_pair {
            let url = format!("{}/pair?code={}&port={}", CONTROLLER_URL, code, port);
            open_browser(&url);
        } else if port != 31415 {
            let url = format!("{}/?port={}", CONTROLLER_URL, port);
            open_browser(&url);
        } else {
            open_browser(CONTROLLER_URL);
        }
    }

    fn launch_pairing() {
        let Some(ctx) = TRAY_CTX.get() else {
            return;
        };
        let (code, port) = {
            let mut s = ctx.state.lock().unwrap();
            (s.refresh_pair_code(), s.settings.port)
        };
        let url = format!("{}/pair?code={}&port={}", CONTROLLER_URL, code, port);
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

        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: LoadIconW(std::ptr::null_mut(), IDI_APPLICATION),
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
        nid.hIcon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);

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

#[cfg(not(windows))]
pub fn run_tray_loop(_state: Arc<Mutex<AppState>>, _ws_hub: WsHub) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}