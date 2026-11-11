use std::thread;
use std::time::Duration;

pub const SELF_STAMP: usize = 0x4D45_4E54;

#[cfg(windows)]
pub fn expand_text(erase_count: usize, text: &str, restore_clipboard: bool, fallback: &str) {
    let text_owned = text.to_string();
    let fallback_owned = fallback.to_string();
    thread::spawn(move || unsafe {
        release_held_modifiers();
        send_backspaces(erase_count);

        if fallback_owned == "unicode" && text_owned.len() <= 512 {
            send_unicode_string(&text_owned);
            return;
        }

        let previous_clip = if restore_clipboard {
            read_clipboard_unicode()
        } else {
            None
        };

        if write_stealth_clipboard(&text_owned) {
            thread::sleep(Duration::from_millis(15));
            send_ctrl_v();
            if restore_clipboard {
                let seq_after_set =
                    windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber();
                thread::sleep(Duration::from_millis(120));
                let seq_now =
                    windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber();
                if seq_now == seq_after_set {
                    if let Some(old) = previous_clip {
                        let _ = write_stealth_clipboard(&old);
                    }
                }
            }
        } else {
            send_unicode_string(&text_owned);
        }
    });
}

#[cfg(not(windows))]
pub fn expand_text(_erase_count: usize, _text: &str, _restore_clipboard: bool, _fallback: &str) {}

#[cfg(windows)]
unsafe fn release_held_modifiers() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        VK_LMENU, VK_LSHIFT, VK_RMENU, VK_RSHIFT, VK_SHIFT,
    };

    let mods = [VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_LMENU, VK_RMENU];
    let mut inputs: Vec<INPUT> = Vec::new();
    for vk in mods {
        if (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: SELF_STAMP,
                    },
                },
            });
        }
    }
    if !inputs.is_empty() {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

#[cfg(windows)]
unsafe fn send_backspaces(count: usize) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_BACK,
    };

    let mut inputs: Vec<INPUT> = Vec::with_capacity(count * 2);
    for _ in 0..count {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_BACK,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        });
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_BACK,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        });
    }
    if !inputs.is_empty() {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

#[cfg(windows)]
unsafe fn send_ctrl_v() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_V,
    };

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        },
    ];

    SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        std::mem::size_of::<INPUT>() as i32,
    );
}

#[cfg(windows)]
unsafe fn send_unicode_string(text: &str) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VK_RETURN,
    };

    let mut inputs: Vec<INPUT> = Vec::with_capacity(text.len() * 2);
    for ch in text.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RETURN,
                        wScan: 0,
                        dwFlags: 0,
                        time: 0,
                        dwExtraInfo: SELF_STAMP,
                    },
                },
            });
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RETURN,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: SELF_STAMP,
                    },
                },
            });
            continue;
        }
        let mut utf16 = [0u16; 2];
        for unit in ch.encode_utf16(&mut utf16) {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: *unit,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: SELF_STAMP,
                    },
                },
            });
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: *unit,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: SELF_STAMP,
                    },
                },
            });
        }
    }
    if !inputs.is_empty() {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

#[cfg(windows)]
unsafe fn read_clipboard_unicode() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;
    if OpenClipboard(std::ptr::null_mut()) == 0 {
        return None;
    }
    let handle = GetClipboardData(CF_UNICODETEXT);
    if handle.is_null() {
        CloseClipboard();
        return None;
    }
    let ptr = GlobalLock(handle) as *const u16;
    if ptr.is_null() {
        CloseClipboard();
        return None;
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    let result = String::from_utf16_lossy(slice);
    GlobalUnlock(handle);
    CloseClipboard();
    Some(result)
}

#[cfg(windows)]
unsafe fn write_stealth_clipboard(text: &str) -> bool {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    const CF_UNICODETEXT: u32 = 13;

    let mut opened = false;
    for _ in 0..5 {
        if OpenClipboard(std::ptr::null_mut()) != 0 {
            opened = true;
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    if !opened {
        return false;
    }

    EmptyClipboard();

    let mut wide: Vec<u16> = Vec::with_capacity(text.len() + 16);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                let _ = chars.next();
            }
            wide.extend_from_slice(&[b'\r' as u16, b'\n' as u16]);
        } else if c == '\n' {
            wide.extend_from_slice(&[b'\r' as u16, b'\n' as u16]);
        } else {
            let mut buf = [0u16; 2];
            for u in c.encode_utf16(&mut buf) {
                wide.push(*u);
            }
        }
    }
    wide.push(0);

    let byte_len = wide.len() * 2;
    let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len);
    if hmem.is_null() {
        CloseClipboard();
        return false;
    }
    let dst = GlobalLock(hmem) as *mut u16;
    if dst.is_null() {
        CloseClipboard();
        return false;
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
    GlobalUnlock(hmem);
    SetClipboardData(CF_UNICODETEXT, hmem);

    set_clipboard_dword_flag("ExcludeClipboardContentFromMonitorProcessing\0", 1);
    set_clipboard_dword_flag("CanIncludeInClipboardHistory\0", 0);
    set_clipboard_dword_flag("CanUploadToCloudClipboard\0", 0);

    CloseClipboard();
    true
}

#[cfg(windows)]
unsafe fn set_clipboard_dword_flag(name: &str, value: u32) {
    use windows_sys::Win32::System::DataExchange::{RegisterClipboardFormatW, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let wide: Vec<u16> = name.encode_utf16().collect();
    let fmt = RegisterClipboardFormatW(wide.as_ptr());
    if fmt == 0 {
        return;
    }
    let hmem = GlobalAlloc(GMEM_MOVEABLE, 4);
    if hmem.is_null() {
        return;
    }
    let ptr = GlobalLock(hmem) as *mut u32;
    if !ptr.is_null() {
        *ptr = value;
        GlobalUnlock(hmem);
        SetClipboardData(fmt, hmem);
    }
}