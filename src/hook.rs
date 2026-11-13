use crate::injector::{self, SELF_STAMP};
use crate::store::AppState;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Default)]
struct HookSnapshot {
    paused: bool,
    terminator: String,
    restore_clipboard: bool,
    injection_fallback: String,
    commands: Vec<(String, String)>,
}

static HOOK_SNAPSHOT: OnceLock<Mutex<Arc<HookSnapshot>>> = OnceLock::new();

pub fn start_hook_engine(state: Arc<Mutex<AppState>>) {
    {
        let s = state.lock().unwrap();
        refresh_hook_snapshot(&s);
    }

    #[cfg(windows)]
    std::thread::spawn(|| {
        run_windows_ear_loop();
    });
}

pub fn refresh_hook_snapshot(state: &AppState) {
    let commands = state
        .commands
        .iter()
        .filter(|c| c.enabled)
        .map(|c| (c.trigger.to_ascii_lowercase(), c.text.clone()))
        .collect();

    let next = Arc::new(HookSnapshot {
        paused: state.settings.paused,
        terminator: state.settings.terminator.clone(),
        restore_clipboard: state.settings.restore_clipboard,
        injection_fallback: state.settings.injection_fallback.clone(),
        commands,
    });

    let cell = HOOK_SNAPSHOT.get_or_init(|| Mutex::new(Arc::clone(&next)));
    if let Ok(mut guard) = cell.lock() {
        *guard = next;
    }
}

#[cfg(windows)]
fn is_terminator_key(vk: u32, terminator: &str) -> bool {
    match terminator {
        "enter" => vk == 0x0D,
        "tab" => vk == 0x09,
        _ => vk == 0x20,
    }
}

#[cfg(windows)]
fn is_navigation_key(vk: u32) -> bool {
    matches!(
        vk,
        0x1B | 0x21 | 0x22 | 0x23 | 0x24 | 0x25 | 0x26 | 0x27 | 0x28 | 0x2E
    )
}

#[cfg(windows)]
fn run_windows_ear_loop() {
    use std::cell::RefCell;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
        WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    struct HookTrack {
        buffer: String,
        last_hwnd: isize,
        swallowed_vk: Option<u32>,
    }

    thread_local! {
        static TRACK: RefCell<HookTrack> = RefCell::new(HookTrack {
            buffer: String::with_capacity(64),
            last_hwnd: 0,
            swallowed_vk: None,
        });
    }

    unsafe extern "system" fn keyboard_proc(
        code: i32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if code < 0 {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        if kb.dwExtraInfo == SELF_STAMP || (kb.flags & LLKHF_INJECTED) != 0 {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let vk = kb.vkCode;
        let is_up = wparam == WM_KEYUP as usize || wparam == WM_SYSKEYUP as usize;
        if is_up {
            let swallow = TRACK.with(|cell| {
                let mut t = cell.borrow_mut();
                if t.swallowed_vk == Some(vk) {
                    t.swallowed_vk = None;
                    true
                } else {
                    false
                }
            });
            if swallow {
                return 1;
            }
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let is_down = wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize;
        if !is_down {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let repeat_swallow = TRACK.with(|cell| cell.borrow().swallowed_vk == Some(vk));
        if repeat_swallow {
            return 1;
        }

        if is_modifier_vk(vk) {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let cur_hwnd = GetForegroundWindow() as isize;

        let swallow = TRACK.with(|cell| {
            let mut t = cell.borrow_mut();
            t.swallowed_vk = None;
            if cur_hwnd != t.last_hwnd {
                t.buffer.clear();
                t.last_hwnd = cur_hwnd;
            }

            if is_ctrl_or_alt_pressed() {
                t.buffer.clear();
                return false;
            }

            if vk == 0x08 {
                t.buffer.pop();
                return false;
            }

            if vk == 0xE5 || is_navigation_key(vk) {
                t.buffer.clear();
                return false;
            }

            let snap = HOOK_SNAPSHOT
                .get()
                .and_then(|m| m.try_lock().ok().map(|g| Arc::clone(&*g)));

            let Some(snap) = snap else {
                t.buffer.clear();
                return false;
            };

            if snap.paused {
                t.buffer.clear();
                return false;
            }

            if is_terminator_key(vk, &snap.terminator) {
                if let Some(at_idx) = t.buffer.rfind('@') {
                    let candidate = &t.buffer[at_idx..];
                    if candidate.len() >= 2 && candidate.len() <= 32 {
                        if let Some((_, text)) =
                            snap.commands.iter().find(|(trig, _)| trig == candidate)
                        {
                            let erase_count = candidate.chars().count();
                            t.buffer.clear();
                            t.swallowed_vk = Some(vk);
                            injector::expand_text(
                                erase_count,
                                text,
                                snap.restore_clipboard,
                                &snap.injection_fallback,
                                cur_hwnd,
                            );
                            return true;
                        }
                    }
                }
                t.buffer.clear();
                return false;
            }

            if let Some(c) = translate_vk_to_char(vk, kb.scanCode, cur_hwnd) {
                if c == '@' {
                    t.buffer.clear();
                    t.buffer.push('@');
                } else if !t.buffer.is_empty() {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        t.buffer.push(c.to_ascii_lowercase());
                        if t.buffer.len() > 32 {
                            t.buffer.clear();
                        }
                    } else {
                        t.buffer.clear();
                    }
                }
            }
            false
        });

        if swallow {
            return 1;
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0
            && (wparam == WM_LBUTTONDOWN as usize
                || wparam == WM_RBUTTONDOWN as usize
                || wparam == WM_MBUTTONDOWN as usize)
        {
            TRACK.with(|cell| cell.borrow_mut().buffer.clear());
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    unsafe {
        let hmod = GetModuleHandleW(std::ptr::null());
        let kb_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), hmod, 0);
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        if !kb_hook.is_null() {
            UnhookWindowsHookEx(kb_hook);
        }
        if !mouse_hook.is_null() {
            UnhookWindowsHookEx(mouse_hook);
        }
    }
}

#[cfg(windows)]
fn is_modifier_vk(vk: u32) -> bool {
    matches!(
        vk,
        0x10 | 0x11 | 0x12 | 0x5B | 0x5C | 0xA0 | 0xA1 | 0xA2 | 0xA3 | 0xA4 | 0xA5
    )
}

#[cfg(windows)]
unsafe fn is_ctrl_or_alt_pressed() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN,
    };
    let down = |vk: u16| (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0;
    down(VK_CONTROL) || down(VK_MENU) || down(VK_LWIN) || down(VK_RWIN)
}

#[cfg(windows)]
unsafe fn translate_vk_to_char(vk: u32, scan: u32, cur_hwnd: isize) -> Option<char> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetKeyboardLayout, GetKeyboardState, ToUnicodeEx, VK_CAPITAL, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut state = [0u8; 256];
    let _ = GetKeyboardState(state.as_mut_ptr());
    if (GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000) != 0 {
        state[VK_SHIFT as usize] = 0x80;
    }
    if (GetAsyncKeyState(VK_CAPITAL as i32) as u16 & 1) != 0 {
        state[VK_CAPITAL as usize] = 0x01;
    }
    let mut buf = [0u16; 4];
    let tid = if cur_hwnd != 0 {
        GetWindowThreadProcessId(cur_hwnd as HWND, std::ptr::null_mut())
    } else {
        0
    };
    let layout = GetKeyboardLayout(tid);
    let len = ToUnicodeEx(vk, scan, state.as_ptr(), buf.as_mut_ptr(), 4, 4, layout);
    if len == 1 {
        char::from_u32(buf[0] as u32)
    } else {
        None
    }
}