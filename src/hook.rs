use crate::injector::{self, SELF_STAMP};
use crate::store::AppState;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

#[derive(Debug)]
enum InputSignal {
    Key {
        vk: u32,
        scan: u32,
        ch: Option<char>,
        ctrl_or_alt: bool,
    },
    ResetBuffer,
}

static SIGNAL_TX: OnceLock<Sender<InputSignal>> = OnceLock::new();

pub fn start_hook_engine(state: Arc<Mutex<AppState>>) {
    let (tx, rx) = mpsc::channel::<InputSignal>();
    let _ = SIGNAL_TX.set(tx);

    thread::spawn(move || {
        run_brain_loop(rx, state);
    });

    #[cfg(windows)]
    thread::spawn(|| {
        run_windows_ear_loop();
    });
}

fn run_brain_loop(rx: mpsc::Receiver<InputSignal>, state: Arc<Mutex<AppState>>) {
    let mut buffer = String::with_capacity(64);
    let mut last_hwnd: isize = 0;

    while let Ok(sig) = rx.recv() {
        #[cfg(windows)]
        {
            let cur_hwnd = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as isize
            };
            if cur_hwnd != last_hwnd {
                buffer.clear();
                last_hwnd = cur_hwnd;
            }
        }

        match sig {
            InputSignal::ResetBuffer => {
                buffer.clear();
            }
            InputSignal::Key {
                vk,
                ch,
                ctrl_or_alt,
                ..
            } => {
                if ctrl_or_alt {
                    buffer.clear();
                    continue;
                }

                if vk == 0x08 {
                    buffer.pop();
                    continue;
                }

                if is_navigation_key(vk) {
                    buffer.clear();
                    continue;
                }

                let (paused, terminator) = {
                    let s = state.lock().unwrap();
                    (s.settings.paused, s.settings.terminator.clone())
                };

                if paused {
                    buffer.clear();
                    continue;
                }

                if is_terminator_key(vk, &terminator) {
                    if let Some(at_idx) = buffer.rfind('@') {
                        let candidate = &buffer[at_idx..];
                        if candidate.len() >= 2 && candidate.len() <= 32 {
                            let matched = {
                                let s = state.lock().unwrap();
                                s.commands
                                    .iter()
                                    .find(|c| {
                                        c.enabled && c.trigger.eq_ignore_ascii_case(candidate)
                                    })
                                    .map(|c| {
                                        (
                                            c.text.clone(),
                                            s.settings.restore_clipboard,
                                            s.settings.injection_fallback.clone(),
                                        )
                                    })
                            };

                            if let Some((text, restore_clip, fallback)) = matched {
                                let erase_count = candidate.chars().count() + 1;
                                buffer.clear();
                                injector::expand_text(
                                    erase_count,
                                    &text,
                                    restore_clip,
                                    &fallback,
                                );
                                continue;
                            }
                        }
                    }
                    buffer.clear();
                    continue;
                }

                if let Some(c) = ch {
                    if c == '@' {
                        buffer.clear();
                        buffer.push('@');
                    } else if !buffer.is_empty() {
                        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                            buffer.push(c.to_ascii_lowercase());
                            if buffer.len() > 32 {
                                buffer.clear();
                            }
                        } else {
                            buffer.clear();
                        }
                    }
                }
            }
        }
    }
}

fn is_terminator_key(vk: u32, terminator: &str) -> bool {
    match terminator {
        "enter" => vk == 0x0D,
        "tab" => vk == 0x09,
        _ => vk == 0x20,
    }
}

fn is_navigation_key(vk: u32) -> bool {
    matches!(
        vk,
        0x1B | 0x21 | 0x22 | 0x23 | 0x24 | 0x25 | 0x26 | 0x27 | 0x28 | 0x2E
    )
}

#[cfg(windows)]
fn run_windows_ear_loop() {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL,
        WM_KEYDOWN, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN, WM_SYSKEYDOWN,
    };

    unsafe extern "system" fn keyboard_proc(
        code: i32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if code >= 0 && (wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize) {
            let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
            if kb.dwExtraInfo != SELF_STAMP && (kb.flags & LLKHF_INJECTED) == 0 {
                if let Some(tx) = SIGNAL_TX.get() {
                    let vk = kb.vkCode;
                    if !is_modifier_vk(vk) {
                        let ctrl_or_alt = is_ctrl_or_alt_pressed();
                        let ch = if !ctrl_or_alt {
                            translate_vk_to_char(vk, kb.scanCode)
                        } else {
                            None
                        };
                        let _ = tx.send(InputSignal::Key {
                            vk,
                            scan: kb.scanCode,
                            ch,
                            ctrl_or_alt,
                        });
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0
            && (wparam == WM_LBUTTONDOWN as usize
                || wparam == WM_RBUTTONDOWN as usize
                || wparam == WM_MBUTTONDOWN as usize)
        {
            if let Some(tx) = SIGNAL_TX.get() {
                let _ = tx.send(InputSignal::ResetBuffer);
            }
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
unsafe fn translate_vk_to_char(vk: u32, scan: u32) -> Option<char> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetKeyboardLayout, GetKeyboardState, ToUnicodeEx, VK_CAPITAL, VK_SHIFT,
    };
    let mut state = [0u8; 256];
    let _ = GetKeyboardState(state.as_mut_ptr());
    if (GetAsyncKeyState(VK_SHIFT as i32) as u16 & 0x8000) != 0 {
        state[VK_SHIFT as usize] = 0x80;
    }
    if (GetAsyncKeyState(VK_CAPITAL as i32) as u16 & 1) != 0 {
        state[VK_CAPITAL as usize] = 0x01;
    }
    let mut buf = [0u16; 4];
    let layout = GetKeyboardLayout(0);
    let len = ToUnicodeEx(vk, scan, state.as_ptr(), buf.as_mut_ptr(), 4, 0, layout);
    if len == 1 {
        char::from_u32(buf[0] as u32)
    } else {
        None
    }
}