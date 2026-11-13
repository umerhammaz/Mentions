use crate::injector::{self, SELF_STAMP};
use crate::store::AppState;
use crate::suggest::{self, SuggestItem, SuggestRequest};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone)]
struct HookCommand {
    trigger_lower: String,
    group_lower: String,
    preview: String,
    text: String,
}

#[derive(Clone, Default)]
struct HookSnapshot {
    paused: bool,
    terminator: String,
    restore_clipboard: bool,
    injection_fallback: String,
    suggest_popup: bool,
    suggest_accept_key: String,
    commands: Vec<HookCommand>,
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
    let mut commands: Vec<HookCommand> = state
        .commands
        .iter()
        .filter(|c| c.enabled)
        .map(|c| HookCommand {
            trigger_lower: c.trigger.to_ascii_lowercase(),
            group_lower: c.group.as_deref().unwrap_or("").to_ascii_lowercase(),
            preview: compact_preview(&c.text, 56),
            text: c.text.clone(),
        })
        .collect();
    commands.sort_by(|a, b| a.trigger_lower.cmp(&b.trigger_lower));

    let next = Arc::new(HookSnapshot {
        paused: state.settings.paused,
        terminator: state.settings.terminator.clone(),
        restore_clipboard: state.settings.restore_clipboard,
        injection_fallback: state.settings.injection_fallback.clone(),
        suggest_popup: state.settings.suggest_popup,
        suggest_accept_key: state.settings.suggest_accept_key.clone(),
        commands,
    });

    let cell = HOOK_SNAPSHOT.get_or_init(|| Mutex::new(Arc::clone(&next)));
    if let Ok(mut guard) = cell.lock() {
        *guard = next;
    }
}

fn compact_preview(s: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(max_chars + 4);
    let mut prev_space = false;
    for ch in s.chars() {
        if out.chars().count() >= max_chars {
            out.push_str("...");
            break;
        }
        if ch == '\r' || ch == '\n' || ch == '\t' || ch == ' ' {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
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
fn is_suggest_accept_key(vk: u32, accept_key: &str) -> bool {
    match accept_key {
        "enter" => vk == 0x0D,
        "both" => vk == 0x09 || vk == 0x0D,
        _ => vk == 0x09,
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
fn find_suggest_matches(query: &str, commands: &[HookCommand]) -> Vec<SuggestItem> {
    if query.is_empty() || !query.starts_with('@') {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(6);
    if query == "@" {
        for cmd in commands.iter().take(6) {
            out.push(SuggestItem {
                trigger: cmd.trigger_lower.clone(),
                preview: cmd.preview.clone(),
                text: cmd.text.clone(),
            });
        }
        return out;
    }

    let needle = &query[1..];
    for cmd in commands {
        if cmd.trigger_lower.starts_with(query) {
            out.push(SuggestItem {
                trigger: cmd.trigger_lower.clone(),
                preview: cmd.preview.clone(),
                text: cmd.text.clone(),
            });
            if out.len() >= 6 {
                return out;
            }
        }
    }
    for cmd in commands {
        if !cmd.trigger_lower.starts_with(query) && cmd.trigger_lower.contains(needle) {
            out.push(SuggestItem {
                trigger: cmd.trigger_lower.clone(),
                preview: cmd.preview.clone(),
                text: cmd.text.clone(),
            });
            if out.len() >= 6 {
                return out;
            }
        }
    }
    for cmd in commands {
        if !cmd.trigger_lower.contains(needle) && cmd.group_lower.contains(needle) {
            out.push(SuggestItem {
                trigger: cmd.trigger_lower.clone(),
                preview: cmd.preview.clone(),
                text: cmd.text.clone(),
            });
            if out.len() >= 6 {
                return out;
            }
        }
    }
    out
}

#[cfg(windows)]
fn run_windows_ear_loop() {
    use std::cell::RefCell;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetCursorPos, GetForegroundWindow, GetMessageW,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
        LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN,
        WM_MBUTTONDOWN, WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    struct HookTrack {
        buffer: String,
        last_hwnd: isize,
        swallowed_vk: Option<u32>,
        prev_was_word_char: bool,
        word_id: u64,
        last_click: Option<(isize, i32, i32)>,
    }

    thread_local! {
        static TRACK: RefCell<HookTrack> = RefCell::new(HookTrack {
            buffer: String::with_capacity(64),
            last_hwnd: 0,
            swallowed_vk: None,
            prev_was_word_char: false,
            word_id: 0,
            last_click: None,
        });
    }

    fn reset_word(t: &mut HookTrack) {
        if !t.buffer.is_empty() || t.word_id != 0 {
            t.buffer.clear();
            t.word_id = suggest::next_word_id();
            suggest::hide_popup();
        }
    }

    fn sync_popup_for_buffer(t: &mut HookTrack, snap: &HookSnapshot, cur_hwnd: isize) {
        if !snap.suggest_popup || t.buffer.is_empty() {
            if t.word_id != 0 {
                t.word_id = suggest::next_word_id();
                suggest::hide_popup();
            }
            return;
        }
        let matches = find_suggest_matches(&t.buffer, &snap.commands);
        if matches.is_empty() {
            t.word_id = suggest::next_word_id();
            suggest::hide_popup();
            return;
        }
        if t.word_id == 0 || t.word_id != suggest::current_word_id() {
            t.word_id = suggest::next_word_id();
        }
        suggest::show_or_update(SuggestRequest {
            word_id: t.word_id,
            erase_count: t.buffer.chars().count(),
            target_hwnd: cur_hwnd,
            restore_clipboard: snap.restore_clipboard,
            fallback: snap.injection_fallback.clone(),
            last_click: t.last_click,
            items: matches,
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

        let repeat_swallow = TRACK.with(|cell| {
            let t = cell.borrow();
            t.swallowed_vk == Some(vk) && vk != 0x26 && vk != 0x28
        });
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

            if t.word_id != 0 && t.word_id != suggest::current_word_id() {
                t.buffer.clear();
                t.word_id = 0;
                t.prev_was_word_char = false;
            }

            if cur_hwnd != t.last_hwnd {
                reset_word(&mut t);
                t.last_hwnd = cur_hwnd;
                t.prev_was_word_char = false;
                t.last_click = None;
            }

            if is_ctrl_or_alt_pressed() {
                reset_word(&mut t);
                t.prev_was_word_char = false;
                return false;
            }

            let snap = HOOK_SNAPSHOT
                .get()
                .and_then(|m| m.try_lock().ok().map(|g| Arc::clone(&*g)));

            let Some(snap) = snap else {
                reset_word(&mut t);
                return false;
            };

            if snap.paused {
                reset_word(&mut t);
                return false;
            }

            let popup_open = snap.suggest_popup && suggest::is_visible_for(t.word_id);
            if popup_open {
                if vk == 0x26 || vk == 0x28 {
                    let delta = if vk == 0x28 { 1 } else { -1 };
                    suggest::move_selection(delta, t.word_id);
                    t.swallowed_vk = Some(vk);
                    return true;
                }
                if vk == 0x1B {
                    reset_word(&mut t);
                    t.prev_was_word_char = false;
                    t.swallowed_vk = Some(vk);
                    return true;
                }
                if is_suggest_accept_key(vk, &snap.suggest_accept_key) {
                    if let Some((erase_count, text, restore_clip, fallback, target_hwnd)) =
                        suggest::take_selected_for_word(t.word_id)
                    {
                        t.buffer.clear();
                        t.word_id = suggest::next_word_id();
                        t.prev_was_word_char = false;
                        t.swallowed_vk = Some(vk);
                        injector::expand_text(
                            erase_count,
                            &text,
                            restore_clip,
                            &fallback,
                            target_hwnd,
                        );
                        return true;
                    }
                }
            }

            if vk == 0x08 {
                if !t.buffer.is_empty() {
                    t.buffer.pop();
                    if t.buffer.is_empty() {
                        reset_word(&mut t);
                        t.prev_was_word_char = false;
                    } else {
                        sync_popup_for_buffer(&mut t, &snap, cur_hwnd);
                    }
                } else {
                    t.prev_was_word_char = false;
                }
                return false;
            }

            if vk == 0xE5 || is_navigation_key(vk) {
                reset_word(&mut t);
                t.prev_was_word_char = false;
                t.last_click = None;
                return false;
            }

            if is_terminator_key(vk, &snap.terminator) {
                let mut matched_text: Option<(usize, String)> = None;
                if let Some(at_idx) = t.buffer.rfind('@') {
                    let candidate = &t.buffer[at_idx..];
                    if candidate.len() >= 2 && candidate.len() <= 32 {
                        if let Some(cmd) = snap
                            .commands
                            .iter()
                            .find(|c| c.trigger_lower == candidate)
                        {
                            matched_text = Some((candidate.chars().count(), cmd.text.clone()));
                        }
                    }
                }
                reset_word(&mut t);
                t.prev_was_word_char = false;
                if vk == 0x09 {
                    t.last_click = None;
                }
                if let Some((erase_count, text)) = matched_text {
                    t.swallowed_vk = Some(vk);
                    injector::expand_text(
                        erase_count,
                        &text,
                        snap.restore_clipboard,
                        &snap.injection_fallback,
                        cur_hwnd,
                    );
                    return true;
                }
                return false;
            }

            if let Some(c) = translate_vk_to_char(vk, kb.scanCode, cur_hwnd) {
                if c == '@' {
                    if !t.prev_was_word_char {
                        t.buffer.clear();
                        t.buffer.push('@');
                        t.word_id = suggest::next_word_id();
                        sync_popup_for_buffer(&mut t, &snap, cur_hwnd);
                    } else {
                        reset_word(&mut t);
                    }
                    t.prev_was_word_char = true;
                } else if !t.buffer.is_empty() {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        t.buffer.push(c.to_ascii_lowercase());
                        if t.buffer.len() > 32 {
                            reset_word(&mut t);
                        } else {
                            sync_popup_for_buffer(&mut t, &snap, cur_hwnd);
                        }
                        t.prev_was_word_char = true;
                    } else {
                        reset_word(&mut t);
                        t.prev_was_word_char = c.is_ascii_alphanumeric() || c == '.';
                    }
                } else {
                    t.prev_was_word_char = c.is_ascii_alphanumeric() || c == '.' || c == '_';
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
            if wparam == WM_LBUTTONDOWN as usize && suggest::is_cursor_inside_popup() {
                return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
            }
            let cur_hwnd = GetForegroundWindow() as isize;
            let mut pt = POINT { x: 0, y: 0 };
            let has_pt = GetCursorPos(&mut pt) != 0;
            TRACK.with(|cell| {
                let mut t = cell.borrow_mut();
                t.buffer.clear();
                t.prev_was_word_char = false;
                t.word_id = suggest::next_word_id();
                if wparam == WM_LBUTTONDOWN as usize && has_pt && cur_hwnd != 0 {
                    t.last_click = Some((cur_hwnd, pt.x, pt.y));
                }
            });
            suggest::hide_popup();
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