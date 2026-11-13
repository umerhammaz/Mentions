use crate::store::AppState;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub const SELF_STAMP: usize = 0x4D45_4E54;

struct ExpandJob {
    id: u64,
    erase_count: usize,
    command_id: String,
    restore_clipboard: bool,
    fallback: String,
    target_hwnd: isize,
}

static JOB_SEQ: AtomicU64 = AtomicU64::new(0);
static APP_STATE: OnceLock<Arc<Mutex<AppState>>> = OnceLock::new();
static WORKER: OnceLock<Arc<(Mutex<VecDeque<ExpandJob>>, Condvar)>> = OnceLock::new();

pub fn init_injector_state(state: Arc<Mutex<AppState>>) {
    let _ = APP_STATE.set(state);
}

#[cfg(windows)]
fn lookup_enabled_text(command_id: &str) -> Option<String> {
    let cell = APP_STATE.get()?;
    let guard = cell.lock().ok()?;
    guard.get_enabled_text_by_id(command_id)
}

#[cfg(windows)]
pub fn expand_command_by_id(
    erase_count: usize,
    command_id: &str,
    restore_clipboard: bool,
    fallback: &str,
    target_hwnd: isize,
) {
    let id = JOB_SEQ.fetch_add(1, Ordering::AcqRel) + 1;
    let queue = get_worker_queue();
    let (lock, cvar) = &**queue;
    if let Ok(mut q) = lock.lock() {
        q.push_back(ExpandJob {
            id,
            erase_count,
            command_id: command_id.to_string(),
            restore_clipboard,
            fallback: fallback.to_string(),
            target_hwnd,
        });
        cvar.notify_all();
    }
}

#[cfg(not(windows))]
pub fn expand_command_by_id(
    _erase_count: usize,
    _command_id: &str,
    _restore_clipboard: bool,
    _fallback: &str,
    _target_hwnd: isize,
) {
}

#[cfg(windows)]
fn get_worker_queue() -> &'static Arc<(Mutex<VecDeque<ExpandJob>>, Condvar)> {
    WORKER.get_or_init(|| {
        let pair = Arc::new((Mutex::new(VecDeque::new()), Condvar::new()));
        let worker_pair = Arc::clone(&pair);
        thread::spawn(move || unsafe {
            run_worker(worker_pair);
        });
        pair
    })
}

#[cfg(windows)]
struct ClipboardSnapshot {
    was_empty: bool,
    formats: Vec<(u32, Vec<u8>)>,
}

#[cfg(windows)]
const MAX_TEXT_FORMAT_BYTES: usize = 2 * 1024 * 1024;
#[cfg(windows)]
const MAX_IMAGE_FORMAT_BYTES: usize = 4 * 1024 * 1024;
#[cfg(windows)]
const MAX_SNAPSHOT_TOTAL_BYTES: usize = 8 * 1024 * 1024;
#[cfg(windows)]
const BACKSPACE_SETTLE_MS: u64 = 30;
#[cfg(windows)]
const PASTE_SETTLE_MS: u64 = 15;
#[cfg(windows)]
const RESTORE_BASE_MS: u64 = 400;
#[cfg(windows)]
const OPEN_CLIPBOARD_POLL_MS: u64 = 25;
#[cfg(windows)]
const OPEN_CLIPBOARD_MAX_POLLS: usize = 32;
#[cfg(windows)]
const UNICODE_CHUNK_CHARS: usize = 32;

#[cfg(windows)]
unsafe fn run_worker(queue: Arc<(Mutex<VecDeque<ExpandJob>>, Condvar)>) {
    use windows_sys::Win32::System::DataExchange::{
        GetClipboardSequenceNumber, GetOpenClipboardWindow,
    };

    let owner_hwnd = create_clipboard_owner_window();

    loop {
        let job = pop_next_job(&queue);
        pump_owner_messages(owner_hwnd);

        let Some(text) = lookup_enabled_text(&job.command_id) else {
            continue;
        };

        if !is_same_target_window(job.target_hwnd) {
            continue;
        }

        release_held_modifiers();

        if job.erase_count > 0 && !send_backspaces(job.erase_count) {
            continue;
        }

        if job.erase_count > 0 {
            thread::sleep(Duration::from_millis(BACKSPACE_SETTLE_MS));
        }

        if !is_same_target_window(job.target_hwnd) {
            continue;
        }

        if job.fallback == "unicode" && text.len() <= 512 {
            send_unicode_string_safe(&text, job.target_hwnd);
            continue;
        }

        let snapshot = if job.restore_clipboard {
            read_clipboard_snapshot(owner_hwnd)
        } else {
            None
        };

        if !write_stealth_clipboard(owner_hwnd, &text) {
            send_unicode_string_safe(&text, job.target_hwnd);
            continue;
        }

        let seq_after_set = GetClipboardSequenceNumber();
        thread::sleep(Duration::from_millis(PASTE_SETTLE_MS));

        if !is_same_target_window(job.target_hwnd)
            || JOB_SEQ.load(Ordering::Acquire) != job.id
            || GetClipboardSequenceNumber() != seq_after_set
        {
            continue;
        }

        if !send_ctrl_v() {
            continue;
        }

        if let Some(snap) = snapshot {
            let extra_ms = ((text.len() / 2000).min(5) as u64) * 50;
            let floor = Duration::from_millis(RESTORE_BASE_MS + extra_ms);
            if wait_cancelable(&queue, owner_hwnd, job.id, seq_after_set, floor) {
                continue;
            }
            for _ in 0..OPEN_CLIPBOARD_MAX_POLLS {
                if GetOpenClipboardWindow().is_null() {
                    break;
                }
                if wait_cancelable(
                    &queue,
                    owner_hwnd,
                    job.id,
                    seq_after_set,
                    Duration::from_millis(OPEN_CLIPBOARD_POLL_MS),
                ) {
                    break;
                }
            }
            if JOB_SEQ.load(Ordering::Acquire) == job.id
                && GetClipboardSequenceNumber() == seq_after_set
            {
                restore_clipboard_snapshot(owner_hwnd, &snap, seq_after_set);
            }
        }
    }
}

#[cfg(windows)]
fn pop_next_job(queue: &Arc<(Mutex<VecDeque<ExpandJob>>, Condvar)>) -> ExpandJob {
    let (lock, cvar) = &**queue;
    let mut q = lock.lock().unwrap();
    loop {
        if let Some(job) = q.pop_front() {
            return job;
        }
        q = cvar.wait(q).unwrap();
    }
}

#[cfg(windows)]
unsafe fn wait_cancelable(
    queue: &Arc<(Mutex<VecDeque<ExpandJob>>, Condvar)>,
    owner_hwnd: windows_sys::Win32::Foundation::HWND,
    my_id: u64,
    seq_after_set: u32,
    duration: Duration,
) -> bool {
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let (lock, cvar) = &**queue;
    let deadline = Instant::now() + duration;
    let mut q = lock.lock().unwrap();
    loop {
        if !q.is_empty() || JOB_SEQ.load(Ordering::Acquire) != my_id {
            return true;
        }
        if GetClipboardSequenceNumber() != seq_after_set {
            return true;
        }
        drop(q);
        pump_owner_messages(owner_hwnd);
        q = lock.lock().unwrap();
        if !q.is_empty() || JOB_SEQ.load(Ordering::Acquire) != my_id {
            return true;
        }
        if GetClipboardSequenceNumber() != seq_after_set {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let step = (deadline - now).min(Duration::from_millis(50));
        let (guard, _) = cvar.wait_timeout(q, step).unwrap();
        q = guard;
    }
}

#[cfg(windows)]
unsafe fn is_same_target_window(target_hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    target_hwnd == 0 || (GetForegroundWindow() as isize) == target_hwnd
}

#[cfg(windows)]
unsafe fn create_clipboard_owner_window() -> windows_sys::Win32::Foundation::HWND {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, WNDCLASSW,
    };

    let hinstance = GetModuleHandleW(std::ptr::null());
    let class_name: Vec<u16> = "MentionsClipboardOwnerClass\0".encode_utf16().collect();
    let wc = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(DefWindowProcW),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    RegisterClassW(&wc);
    CreateWindowExW(
        0,
        class_name.as_ptr(),
        class_name.as_ptr(),
        0,
        0,
        0,
        0,
        0,
        (-3isize) as HWND,
        std::ptr::null_mut(),
        hinstance,
        std::ptr::null(),
    )
}

#[cfg(windows)]
unsafe fn pump_owner_messages(owner_hwnd: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };

    if owner_hwnd.is_null() {
        return;
    }
    let mut msg: MSG = std::mem::zeroed();
    while PeekMessageW(&mut msg, owner_hwnd, 0, 0, PM_REMOVE) != 0 {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

#[cfg(windows)]
unsafe fn release_held_modifiers() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VK_LCONTROL, VK_LMENU,
        VK_LSHIFT, VK_LWIN, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
    };

    let mods = [
        (VK_LSHIFT, false),
        (VK_RSHIFT, false),
        (VK_LCONTROL, false),
        (VK_RCONTROL, true),
        (VK_LMENU, false),
        (VK_RMENU, true),
        (VK_LWIN, false),
        (VK_RWIN, false),
    ];
    let mut inputs: Vec<INPUT> = Vec::new();
    for (vk, extended) in mods {
        if (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 {
            let scan = MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16;
            let flags = KEYEVENTF_KEYUP | if extended { KEYEVENTF_EXTENDEDKEY } else { 0 };
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: scan,
                        dwFlags: flags,
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
unsafe fn send_backspaces(count: usize) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        MAPVK_VK_TO_VSC, VK_BACK,
    };

    let scan = MapVirtualKeyW(VK_BACK as u32, MAPVK_VK_TO_VSC) as u16;
    let mut inputs: Vec<INPUT> = Vec::with_capacity(count * 2);
    for _ in 0..count {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_BACK,
                    wScan: scan,
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
                    wScan: scan,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        });
    }
    if inputs.is_empty() {
        return true;
    }
    let sent = SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        std::mem::size_of::<INPUT>() as i32,
    );
    sent == inputs.len() as u32
}

#[cfg(windows)]
unsafe fn send_ctrl_v() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        MAPVK_VK_TO_VSC, VK_LCONTROL, VK_V,
    };

    let ctrl_scan = MapVirtualKeyW(VK_LCONTROL as u32, MAPVK_VK_TO_VSC) as u16;
    let v_scan = MapVirtualKeyW(VK_V as u32, MAPVK_VK_TO_VSC) as u16;
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_LCONTROL,
                    wScan: ctrl_scan,
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
                    wScan: v_scan,
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
                    wScan: v_scan,
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
                    wVk: VK_LCONTROL,
                    wScan: ctrl_scan,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: SELF_STAMP,
                },
            },
        },
    ];

    let sent = SendInput(
        inputs.len() as u32,
        inputs.as_ptr(),
        std::mem::size_of::<INPUT>() as i32,
    );
    sent == inputs.len() as u32
}

#[cfg(windows)]
unsafe fn is_browser_or_chat_window(target_hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;

    if target_hwnd == 0 {
        return false;
    }
    let mut buf = [0u16; 128];
    let len = GetClassNameW(target_hwnd as HWND, buf.as_mut_ptr(), buf.len() as i32);
    if len <= 0 {
        return false;
    }
    let name = String::from_utf16_lossy(&buf[..len as usize]);
    name.starts_with("Chrome_WidgetWin")
        || name == "MozillaWindowClass"
        || name == "ApplicationFrameWindow"
        || name == "CefBrowserWindow"
}

#[cfg(windows)]
unsafe fn send_unicode_string_safe(text: &str, target_hwnd: isize) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VK_LSHIFT, VK_RETURN,
    };

    let shift_newlines = is_browser_or_chat_window(target_hwnd);
    let shift_scan = MapVirtualKeyW(VK_LSHIFT as u32, MAPVK_VK_TO_VSC) as u16;
    let ret_scan = MapVirtualKeyW(VK_RETURN as u32, MAPVK_VK_TO_VSC) as u16;
    let mut batch: Vec<INPUT> = Vec::with_capacity(UNICODE_CHUNK_CHARS * 4);
    let mut char_count = 0usize;

    for ch in text.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            if shift_newlines {
                batch.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_LSHIFT,
                            wScan: shift_scan,
                            dwFlags: 0,
                            time: 0,
                            dwExtraInfo: SELF_STAMP,
                        },
                    },
                });
            }
            batch.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RETURN,
                        wScan: ret_scan,
                        dwFlags: 0,
                        time: 0,
                        dwExtraInfo: SELF_STAMP,
                    },
                },
            });
            batch.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_RETURN,
                        wScan: ret_scan,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: SELF_STAMP,
                    },
                },
            });
            if shift_newlines {
                batch.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_LSHIFT,
                            wScan: shift_scan,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: SELF_STAMP,
                        },
                    },
                });
            }
        } else {
            let mut utf16 = [0u16; 2];
            for unit in ch.encode_utf16(&mut utf16) {
                batch.push(INPUT {
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
                batch.push(INPUT {
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
        char_count += 1;
        if char_count >= UNICODE_CHUNK_CHARS {
            if !is_same_target_window(target_hwnd) {
                return;
            }
            SendInput(
                batch.len() as u32,
                batch.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            );
            batch.clear();
            char_count = 0;
            thread::sleep(Duration::from_millis(2));
        }
    }

    if !batch.is_empty() && is_same_target_window(target_hwnd) {
        SendInput(
            batch.len() as u32,
            batch.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

#[cfg(windows)]
unsafe fn open_clipboard_with_retry(
    owner_hwnd: windows_sys::Win32::Foundation::HWND,
    tries: usize,
) -> bool {
    use windows_sys::Win32::System::DataExchange::OpenClipboard;

    for i in 0..tries {
        if OpenClipboard(owner_hwnd) != 0 {
            return true;
        }
        if i + 1 < tries {
            thread::sleep(Duration::from_millis(5));
        }
    }
    false
}

#[cfg(windows)]
unsafe fn allowed_format_limit(fmt: u32) -> Option<usize> {
    use windows_sys::Win32::System::DataExchange::GetClipboardFormatNameW;

    match fmt {
        1 | 7 | 13 => Some(MAX_TEXT_FORMAT_BYTES),
        16 => Some(64),
        15 => Some(512 * 1024),
        8 | 17 => Some(MAX_IMAGE_FORMAT_BYTES),
        _ if fmt >= 0xC000 => {
            let mut buf = [0u16; 128];
            let len = GetClipboardFormatNameW(fmt, buf.as_mut_ptr(), buf.len() as i32);
            if len <= 0 {
                return None;
            }
            let name = String::from_utf16_lossy(&buf[..len as usize]);
            match name.as_str() {
                "HTML Format"
                | "Rich Text Format"
                | "Rich Text Format Without Objects"
                | "text/html"
                | "text/plain"
                | "UniformResourceLocator"
                | "UniformResourceLocatorW"
                | "Csv" => Some(MAX_TEXT_FORMAT_BYTES),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(windows)]
unsafe fn read_clipboard_snapshot(
    owner_hwnd: windows_sys::Win32::Foundation::HWND,
) -> Option<ClipboardSnapshot> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EnumClipboardFormats, GetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    if !open_clipboard_with_retry(owner_hwnd, 15) {
        return None;
    }

    let first = EnumClipboardFormats(0);
    if first == 0 {
        CloseClipboard();
        return Some(ClipboardSnapshot {
            was_empty: true,
            formats: Vec::new(),
        });
    }

    let mut formats = Vec::new();
    let mut total_bytes = 0usize;
    let mut fmt = first;
    while fmt != 0 {
        if let Some(limit) = allowed_format_limit(fmt) {
            let handle = GetClipboardData(fmt);
            if !handle.is_null() {
                let size = GlobalSize(handle);
                if size > 0 && size <= limit && total_bytes + size <= MAX_SNAPSHOT_TOTAL_BYTES {
                    let ptr = GlobalLock(handle) as *const u8;
                    if !ptr.is_null() {
                        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
                        GlobalUnlock(handle);
                        total_bytes += size;
                        formats.push((fmt, bytes));
                    }
                }
            }
        }
        fmt = EnumClipboardFormats(fmt);
    }

    CloseClipboard();
    Some(ClipboardSnapshot {
        was_empty: false,
        formats,
    })
}

#[cfg(windows)]
unsafe fn restore_clipboard_snapshot(
    owner_hwnd: windows_sys::Win32::Foundation::HWND,
    snap: &ClipboardSnapshot,
    expected_seq: u32,
) {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    if !snap.was_empty && snap.formats.is_empty() {
        return;
    }
    if !open_clipboard_with_retry(owner_hwnd, 10) {
        return;
    }
    if GetClipboardSequenceNumber() != expected_seq {
        CloseClipboard();
        return;
    }
    if EmptyClipboard() == 0 {
        CloseClipboard();
        return;
    }
    for (fmt, bytes) in &snap.formats {
        let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if hmem.is_null() {
            continue;
        }
        let dst = GlobalLock(hmem) as *mut u8;
        if dst.is_null() {
            GlobalFree(hmem);
            continue;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        GlobalUnlock(hmem);
        if SetClipboardData(*fmt, hmem).is_null() {
            GlobalFree(hmem);
        }
    }
    CloseClipboard();
}

#[cfg(windows)]
unsafe fn write_stealth_clipboard(
    owner_hwnd: windows_sys::Win32::Foundation::HWND,
    text: &str,
) -> bool {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    const CF_UNICODETEXT: u32 = 13;

    if !open_clipboard_with_retry(owner_hwnd, 15) {
        return false;
    }

    if EmptyClipboard() == 0 {
        CloseClipboard();
        return false;
    }

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
        GlobalFree(hmem);
        CloseClipboard();
        return false;
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
    GlobalUnlock(hmem);
    if SetClipboardData(CF_UNICODETEXT, hmem).is_null() {
        GlobalFree(hmem);
        CloseClipboard();
        return false;
    }

    set_clipboard_dword_flag("ExcludeClipboardContentFromMonitorProcessing\0", 1);
    set_clipboard_dword_flag("CanIncludeInClipboardHistory\0", 0);
    set_clipboard_dword_flag("CanUploadToCloudClipboard\0", 0);

    CloseClipboard();
    true
}

#[cfg(windows)]
unsafe fn set_clipboard_dword_flag(name: &str, value: u32) {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{RegisterClipboardFormatW, SetClipboardData};
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

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
    if ptr.is_null() {
        GlobalFree(hmem);
        return;
    }
    *ptr = value;
    GlobalUnlock(hmem);
    if SetClipboardData(fmt, hmem).is_null() {
        GlobalFree(hmem);
    }
}