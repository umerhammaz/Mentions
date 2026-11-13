use crate::injector;
use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Clone)]
pub struct SuggestItem {
    pub id: String,
    pub trigger: String,
    pub preview: String,
}

#[derive(Clone)]
pub struct SuggestRequest {
    pub word_id: u64,
    pub erase_count: usize,
    pub target_hwnd: isize,
    pub restore_clipboard: bool,
    pub fallback: String,
    pub last_click: Option<(isize, i32, i32)>,
    pub items: Vec<SuggestItem>,
}

static CURRENT_WORD_ID: AtomicU64 = AtomicU64::new(0);
static VISIBLE_WORD_ID: AtomicU64 = AtomicU64::new(0);
static POPUP_HWND: AtomicIsize = AtomicIsize::new(0);

#[cfg(windows)]
static PENDING: OnceLock<Mutex<Option<SuggestRequest>>> = OnceLock::new();
#[cfg(windows)]
static ACTIVE: OnceLock<Mutex<Option<ActivePopupState>>> = OnceLock::new();

#[cfg(windows)]
struct ActivePopupState {
    req: SuggestRequest,
    selected: usize,
    anchor: Option<(i32, i32, i32)>,
    last_mouse_xy: (i32, i32),
    row_height: i32,
    pad_y: i32,
}

#[cfg(windows)]
const WM_APP_SYNC: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 10;
#[cfg(windows)]
const WM_APP_MOVE: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 11;

pub fn next_word_id() -> u64 {
    CURRENT_WORD_ID.fetch_add(1, Ordering::AcqRel) + 1
}

pub fn current_word_id() -> u64 {
    CURRENT_WORD_ID.load(Ordering::Acquire)
}

pub fn is_visible_for(word_id: u64) -> bool {
    word_id != 0 && VISIBLE_WORD_ID.load(Ordering::Acquire) == word_id
}

#[cfg(windows)]
pub fn start_suggest_engine() {
    let _ = PENDING.get_or_init(|| Mutex::new(None));
    let _ = ACTIVE.get_or_init(|| Mutex::new(None));
    std::thread::spawn(|| unsafe {
        run_popup_loop();
    });
}

#[cfg(not(windows))]
pub fn start_suggest_engine() {}

#[cfg(windows)]
pub fn show_or_update(req: SuggestRequest) {
    let cell = PENDING.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cell.lock() {
        *guard = Some(req);
    }
    let hwnd = POPUP_HWND.load(Ordering::Acquire);
    if hwnd != 0 {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                hwnd as windows_sys::Win32::Foundation::HWND,
                WM_APP_SYNC,
                0,
                0,
            );
        }
    }
}

#[cfg(not(windows))]
pub fn show_or_update(_req: SuggestRequest) {}

#[cfg(windows)]
pub fn hide_popup() {
    VISIBLE_WORD_ID.store(0, Ordering::Release);
    if let Some(cell) = PENDING.get() {
        if let Ok(mut guard) = cell.lock() {
            *guard = None;
        }
    }
    let hwnd = POPUP_HWND.load(Ordering::Acquire);
    if hwnd != 0 {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                hwnd as windows_sys::Win32::Foundation::HWND,
                WM_APP_SYNC,
                0,
                0,
            );
        }
    }
}

#[cfg(not(windows))]
pub fn hide_popup() {}

#[cfg(windows)]
pub fn move_selection(delta: isize, word_id: u64) {
    let hwnd = POPUP_HWND.load(Ordering::Acquire);
    if hwnd != 0 {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                hwnd as windows_sys::Win32::Foundation::HWND,
                WM_APP_MOVE,
                delta as usize,
                word_id as isize,
            );
        }
    }
}

#[cfg(not(windows))]
pub fn move_selection(_delta: isize, _word_id: u64) {}

#[cfg(windows)]
pub fn take_selected_for_word(word_id: u64) -> Option<(usize, String, bool, String, isize)> {
    VISIBLE_WORD_ID.store(0, Ordering::Release);
    let active_cell = ACTIVE.get()?;
    let mut guard = active_cell.lock().ok()?;
    let active = guard.as_ref()?;
    if active.req.word_id != word_id {
        return None;
    }
    let item = active.req.items.get(active.selected)?;
    let result = (
        active.req.erase_count,
        item.id.clone(),
        active.req.restore_clipboard,
        active.req.fallback.clone(),
        active.req.target_hwnd,
    );
    *guard = None;
    drop(guard);
    hide_popup();
    Some(result)
}

#[cfg(not(windows))]
pub fn take_selected_for_word(_word_id: u64) -> Option<(usize, String, bool, String, isize)> {
    None
}

#[cfg(windows)]
pub fn is_cursor_inside_popup() -> bool {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, WindowFromPoint};

    let popup = POPUP_HWND.load(Ordering::Acquire);
    if popup == 0 || VISIBLE_WORD_ID.load(Ordering::Acquire) == 0 {
        return false;
    }
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return false;
        }
        (WindowFromPoint(pt) as isize) == popup
    }
}

#[cfg(not(windows))]
pub fn is_cursor_inside_popup() -> bool {
    false
}

#[cfg(windows)]
struct ComPtr(*mut core::ffi::c_void);

#[cfg(windows)]
impl Drop for ComPtr {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let vt = *(self.0 as *const *const usize);
                let release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32 =
                    *vt.add(2).cast();
                let _ = release(self.0);
            }
        }
    }
}

#[cfg(windows)]
unsafe fn com_fn<T: Copy>(obj: *mut core::ffi::c_void, slot: usize) -> T {
    let vt = *(obj as *const *const usize);
    *(vt.add(slot) as *const T)
}

#[cfg(windows)]
struct UiaState {
    ptr: *mut core::ffi::c_void,
}

#[cfg(windows)]
impl Drop for UiaState {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe {
                let release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32 =
                    com_fn(self.ptr, 2);
                let _ = release(self.ptr);
            }
        }
    }
}

#[cfg(windows)]
thread_local! {
    static UIA_INST: std::cell::RefCell<Option<UiaState>> = const { std::cell::RefCell::new(None) };
}

#[cfg(windows)]
unsafe fn get_uia_ptr() -> *mut core::ffi::c_void {
    use windows_sys::core::GUID;
    use windows_sys::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows_sys::Win32::UI::Accessibility::CUIAutomation;

    UIA_INST.with(|cell| {
        let mut slot = cell.borrow_mut();
        if let Some(existing) = slot.as_ref() {
            return existing.ptr;
        }
        let iid_uia = GUID::from_u128(0x30cbe57d_d9d0_452a_ab13_7ac5ac4825ee);
        let mut out: *mut core::ffi::c_void = std::ptr::null_mut();
        let hr = CoCreateInstance(
            &CUIAutomation,
            std::ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &iid_uia,
            &mut out,
        );
        if hr >= 0 && !out.is_null() {
            *slot = Some(UiaState { ptr: out });
            out
        } else {
            std::ptr::null_mut()
        }
    })
}

#[cfg(windows)]
unsafe fn run_popup_loop() {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW,
        CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, FrameRect,
        GetMonitorInfoW, InvalidateRect, MonitorFromPoint, SelectObject, SetBkMode, SetTextColor,
        CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DT_END_ELLIPSIS,
        DT_LEFT, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD,
        MONITORINFO, MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY,
        TRANSPARENT,
    };
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW,
        RegisterClassW, SetWindowPos, ShowWindow, TranslateMessage, HWND_TOPMOST, MA_NOACTIVATE,
        MSG, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WM_ERASEBKGND, WM_LBUTTONDOWN,
        WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    let _ = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);

    unsafe extern "system" fn popup_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_MOUSEACTIVATE => MA_NOACTIVATE as isize,
            WM_ERASEBKGND => 1,
            WM_APP_SYNC => {
                handle_sync(hwnd);
                0
            }
            WM_APP_MOVE => {
                let delta = wparam as isize;
                let expected_id = lparam as u64;
                handle_move(hwnd, delta, expected_id);
                0
            }
            WM_MOUSEMOVE => {
                let x = (lparam & 0xFFFF) as i16 as i32;
                let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
                handle_mouse_move(hwnd, x, y);
                0
            }
            WM_LBUTTONDOWN => {
                let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;
                handle_mouse_click(hwnd, y);
                0
            }
            WM_PAINT => {
                paint_popup(hwnd);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe fn handle_sync(hwnd: HWND) {
        let pending_req = PENDING
            .get()
            .and_then(|c| c.lock().ok().and_then(|mut g| g.take()));

        let Some(req) = pending_req else {
            if let Some(cell) = ACTIVE.get() {
                if let Ok(mut guard) = cell.lock() {
                    *guard = None;
                }
            }
            VISIBLE_WORD_ID.store(0, Ordering::Release);
            ShowWindow(hwnd, SW_HIDE);
            return;
        };

        if req.items.is_empty() || CURRENT_WORD_ID.load(Ordering::Acquire) != req.word_id {
            VISIBLE_WORD_ID.store(0, Ordering::Release);
            ShowWindow(hwnd, SW_HIDE);
            return;
        }

        let prev_anchor = ACTIVE
            .get()
            .and_then(|c| c.lock().ok())
            .and_then(|g| {
                g.as_ref()
                    .filter(|a| a.req.word_id == req.word_id)
                    .and_then(|a| a.anchor)
            });

        let anchor = if let Some(a) = prev_anchor {
            Some(a)
        } else {
            locate_caret_anchor(req.target_hwnd, req.last_click)
        };

        if CURRENT_WORD_ID.load(Ordering::Acquire) != req.word_id {
            VISIBLE_WORD_ID.store(0, Ordering::Release);
            ShowWindow(hwnd, SW_HIDE);
            return;
        }

        let dpi = GetDpiForWindow(hwnd).max(96) as i32;
        let row_h = (32 * dpi) / 96;
        let pad_y = (6 * dpi) / 96;
        let width = (360 * dpi) / 96;
        let count = req.items.len().min(6) as i32;
        let height = count * row_h + pad_y * 2;

        let (ax, ay_top, ay_bottom) = anchor.unwrap_or((120, 120, 140));
        let (x, y) = fit_on_monitor(ax, ay_top, ay_bottom, width, height, dpi);

        if let Some(cell) = ACTIVE.get() {
            if let Ok(mut guard) = cell.lock() {
                *guard = Some(ActivePopupState {
                    req: req.clone(),
                    selected: 0,
                    anchor,
                    last_mouse_xy: (-1, -1),
                    row_height: row_h,
                    pad_y,
                });
            }
        }

        VISIBLE_WORD_ID.store(req.word_id, Ordering::Release);
        InvalidateRect(hwnd, std::ptr::null(), 0);
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }

    unsafe fn handle_move(hwnd: HWND, delta: isize, expected_id: u64) {
        let mut changed = false;
        if let Some(cell) = ACTIVE.get() {
            if let Ok(mut guard) = cell.lock() {
                if let Some(active) = guard.as_mut() {
                    if active.req.word_id == expected_id && !active.req.items.is_empty() {
                        let len = active.req.items.len() as isize;
                        let cur = active.selected as isize;
                        active.selected = (((cur + delta) % len + len) % len) as usize;
                        changed = true;
                    }
                }
            }
        }
        if changed {
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }
    }

    unsafe fn handle_mouse_move(hwnd: HWND, x: i32, y: i32) {
        let mut changed = false;
        if let Some(cell) = ACTIVE.get() {
            if let Ok(mut guard) = cell.lock() {
                if let Some(active) = guard.as_mut() {
                    if active.last_mouse_xy == (x, y) {
                        return;
                    }
                    active.last_mouse_xy = (x, y);
                    let rel = y - active.pad_y;
                    if rel >= 0 && active.row_height > 0 {
                        let idx = (rel / active.row_height) as usize;
                        if idx < active.req.items.len() && idx != active.selected {
                            active.selected = idx;
                            changed = true;
                        }
                    }
                }
            }
        }
        if changed {
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }
    }

    unsafe fn handle_mouse_click(hwnd: HWND, y: i32) {
        let picked = ACTIVE.get().and_then(|cell| {
            let mut guard = cell.lock().ok()?;
            let active = guard.as_ref()?;
            if CURRENT_WORD_ID.load(Ordering::Acquire) != active.req.word_id {
                return None;
            }
            let rel = y - active.pad_y;
            let idx = if rel >= 0 && active.row_height > 0 {
                (rel / active.row_height) as usize
            } else {
                active.selected
            };
            let item = active.req.items.get(idx)?;
            let out = (
                active.req.erase_count,
                item.id.clone(),
                active.req.restore_clipboard,
                active.req.fallback.clone(),
                active.req.target_hwnd,
            );
            *guard = None;
            Some(out)
        });

        let _ = next_word_id();
        VISIBLE_WORD_ID.store(0, Ordering::Release);
        ShowWindow(hwnd, SW_HIDE);

        if let Some((erase_count, command_id, restore_clip, fallback, target_hwnd)) = picked {
            injector::expand_command_by_id(
                erase_count,
                &command_id,
                restore_clip,
                &fallback,
                target_hwnd,
            );
        }
    }

    unsafe fn fit_on_monitor(
        ax: i32,
        ay_top: i32,
        ay_bottom: i32,
        width: i32,
        height: i32,
        dpi: i32,
    ) -> (i32, i32) {
        let gap = (6 * dpi) / 96;
        let pt = POINT { x: ax, y: ay_bottom };
        let mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi) == 0 {
            return (ax, ay_bottom + gap);
        }
        let work = mi.rcWork;
        let mut x = ax;
        if x + width > work.right {
            x = (work.right - width).max(work.left);
        }
        if x < work.left {
            x = work.left;
        }
        let mut y = ay_bottom + gap;
        if y + height > work.bottom {
            let above = ay_top - height - gap;
            if above >= work.top {
                y = above;
            } else {
                y = (work.bottom - height).max(work.top);
            }
        }
        if y < work.top {
            y = work.top;
        }
        (x, y)
    }

    unsafe fn paint_popup(hwnd: HWND) {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);
        if hdc.is_null() {
            return;
        }

        let snapshot = ACTIVE
            .get()
            .and_then(|c| c.lock().ok())
            .and_then(|g| g.as_ref().map(|a| (a.req.items.clone(), a.selected, a.row_height, a.pad_y)));

        let Some((items, selected, row_h, pad_y)) = snapshot else {
            EndPaint(hwnd, &ps);
            return;
        };

        let mut rc: RECT = std::mem::zeroed();
        windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rc);
        let w = (rc.right - rc.left).max(1);
        let h = (rc.bottom - rc.top).max(1);

        let mem_dc = CreateCompatibleDC(hdc);
        let mem_bmp = CreateCompatibleBitmap(hdc, w, h);
        let old_bmp = SelectObject(mem_dc, mem_bmp);

        let bg_brush = CreateSolidBrush(0x0021_2224);
        let sel_brush = CreateSolidBrush(0x0033_3538);
        let border_brush = CreateSolidBrush(0x0041_4448);
        FillRect(mem_dc, &rc, bg_brush);

        let dpi = GetDpiForWindow(hwnd).max(96) as i32;
        let font_h = -((13 * dpi) / 96);
        let small_h = -((12 * dpi) / 96);
        let mono_name: Vec<u16> = "Consolas\0".encode_utf16().collect();
        let sans_name: Vec<u16> = "Segoe UI\0".encode_utf16().collect();

        let mono_font = CreateFontW(
            font_h,
            0,
            0,
            0,
            FW_SEMIBOLD as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_QUALITY as u32,
            DEFAULT_PITCH as u32 | FF_DONTCARE as u32,
            mono_name.as_ptr(),
        );
        let sans_font = CreateFontW(
            small_h,
            0,
            0,
            0,
            FW_NORMAL as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_QUALITY as u32,
            DEFAULT_PITCH as u32 | FF_DONTCARE as u32,
            sans_name.as_ptr(),
        );

        SetBkMode(mem_dc, TRANSPARENT as i32);
        let pad_x = (12 * dpi) / 96;
        let trig_w = (128 * dpi) / 96;
        let old_font = SelectObject(mem_dc, mono_font);

        for (i, item) in items.iter().take(6).enumerate() {
            let top = pad_y + (i as i32) * row_h;
            let row_rc = RECT {
                left: 1,
                top,
                right: w - 1,
                bottom: top + row_h,
            };
            if i == selected {
                FillRect(mem_dc, &row_rc, sel_brush);
            }

            let mut trig_rc = RECT {
                left: pad_x,
                top,
                right: (pad_x + trig_w).min(w - pad_x),
                bottom: top + row_h,
            };
            let trig_wide: Vec<u16> = item.trigger.encode_utf16().collect();
            SelectObject(mem_dc, mono_font);
            SetTextColor(mem_dc, 0x00EC_F0F2);
            DrawTextW(
                mem_dc,
                trig_wide.as_ptr(),
                trig_wide.len() as i32,
                &mut trig_rc,
                DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
            );

            let mut prev_rc = RECT {
                left: trig_rc.right + (8 * dpi) / 96,
                top,
                right: w - pad_x,
                bottom: top + row_h,
            };
            if prev_rc.right > prev_rc.left {
                let prev_wide: Vec<u16> = item.preview.encode_utf16().collect();
                SelectObject(mem_dc, sans_font);
                SetTextColor(mem_dc, if i == selected { 0x00CC_CFCE } else { 0x009C_A1A6 });
                DrawTextW(
                    mem_dc,
                    prev_wide.as_ptr(),
                    prev_wide.len() as i32,
                    &mut prev_rc,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
                );
            }
        }

        FrameRect(mem_dc, &rc, border_brush);
        BitBlt(hdc, 0, 0, w, h, mem_dc, 0, 0, SRCCOPY);

        SelectObject(mem_dc, old_font);
        DeleteObject(mono_font);
        DeleteObject(sans_font);
        DeleteObject(bg_brush);
        DeleteObject(sel_brush);
        DeleteObject(border_brush);
        SelectObject(mem_dc, old_bmp);
        DeleteObject(mem_bmp);
        DeleteDC(mem_dc);
        EndPaint(hwnd, &ps);
    }

    let hinstance = GetModuleHandleW(std::ptr::null());
    let class_name: Vec<u16> = "MentionsSuggestPopupClass\0".encode_utf16().collect();
    let wc = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(popup_wnd_proc),
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

    let hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        class_name.as_ptr(),
        class_name.as_ptr(),
        WS_POPUP,
        0,
        0,
        1,
        1,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        hinstance,
        std::ptr::null(),
    );

    POPUP_HWND.store(hwnd as isize, Ordering::Release);

    let mut msg: MSG = std::mem::zeroed();
    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    POPUP_HWND.store(0, Ordering::Release);
    CoUninitialize();
}

#[cfg(windows)]
unsafe fn locate_caret_anchor(
    target_hwnd: isize,
    last_click: Option<(isize, i32, i32)>,
) -> Option<(i32, i32, i32)> {
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetGUIThreadInfo, GetWindowRect, GetWindowThreadProcessId, GUITHREADINFO,
    };

    if target_hwnd == 0 {
        return None;
    }
    let fg = target_hwnd as HWND;
    let tid = GetWindowThreadProcessId(fg, std::ptr::null_mut());
    let mut gui: GUITHREADINFO = std::mem::zeroed();
    gui.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    let has_gui = GetGUIThreadInfo(tid, &mut gui) != 0;

    if has_gui && !gui.hwndCaret.is_null() {
        let rc = gui.rcCaret;
        if rc.bottom > rc.top {
            let mut top_left = POINT { x: rc.left, y: rc.top };
            let mut bottom_left = POINT { x: rc.left, y: rc.bottom };
            if ClientToScreen(gui.hwndCaret, &mut top_left) != 0
                && ClientToScreen(gui.hwndCaret, &mut bottom_left) != 0
            {
                return Some((top_left.x, top_left.y, bottom_left.y));
            }
        }
    }

    let focus_hwnd = if has_gui && !gui.hwndFocus.is_null() {
        gui.hwndFocus
    } else {
        fg
    };

    if let Some(a) = locate_msaa_caret(focus_hwnd) {
        return Some(a);
    }

    if let Some(a) = locate_uia_caret() {
        return Some(a);
    }

    let mut focus_rect: RECT = std::mem::zeroed();
    let has_rect = GetWindowRect(focus_hwnd, &mut focus_rect) != 0;

    if let Some((click_hwnd, cx, cy)) = last_click {
        if click_hwnd == target_hwnd {
            let inside = !has_rect
                || (cx >= focus_rect.left
                    && cx <= focus_rect.right
                    && cy >= focus_rect.top
                    && cy <= focus_rect.bottom);
            if inside {
                return Some((cx, cy - 18, cy + 6));
            }
        }
    }

    if has_rect && focus_rect.right > focus_rect.left {
        return Some((focus_rect.left + 16, focus_rect.top + 16, focus_rect.top + 38));
    }
    None
}

#[cfg(windows)]
unsafe fn locate_msaa_caret(focus_hwnd: windows_sys::Win32::Foundation::HWND) -> Option<(i32, i32, i32)> {
    use windows_sys::core::GUID;
    use windows_sys::Win32::UI::Accessibility::AccessibleObjectFromWindow;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ChildIdVariant {
        vt: u16,
        r1: u16,
        r2: u16,
        r3: u16,
        lval: i32,
        pad1: i32,
        pad2: usize,
    }

    let iid_acc = GUID::from_u128(0x618736e0_3c3d_11cf_810c_00aa00389b71);
    let mut obj: *mut core::ffi::c_void = std::ptr::null_mut();
    let objid_caret = (-8i32) as u32;
    if AccessibleObjectFromWindow(focus_hwnd, objid_caret, &iid_acc, &mut obj) < 0 || obj.is_null() {
        return None;
    }
    let _guard = ComPtr(obj);
    let acc_location: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut i32,
        *mut i32,
        *mut i32,
        *mut i32,
        ChildIdVariant,
    ) -> i32 = com_fn(obj, 22);

    let (mut left, mut top, mut width, mut height) = (0, 0, 0, 0);
    let var_self = ChildIdVariant {
        vt: 3,
        r1: 0,
        r2: 0,
        r3: 0,
        lval: 0,
        pad1: 0,
        pad2: 0,
    };
    if acc_location(obj, &mut left, &mut top, &mut width, &mut height, var_self) == 0 && height > 0 {
        return Some((left, top, top + height));
    }
    None
}

#[cfg(windows)]
unsafe fn locate_uia_caret() -> Option<(i32, i32, i32)> {
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::System::Com::SAFEARRAY;
    use windows_sys::Win32::System::Ole::{
        SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
        SafeArrayUnaccessData,
    };
    use windows_sys::Win32::System::Variant::{VariantClear, VARIANT};
    use windows_sys::Win32::UI::Accessibility::{
        UIA_BoundingRectanglePropertyId, UIA_TextPattern2Id, UIA_TextPatternId,
    };

    let uia = get_uia_ptr();
    if uia.is_null() {
        return None;
    }

    let get_focused: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *mut *mut core::ffi::c_void,
    ) -> i32 = com_fn(uia, 8);
    let mut el_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    if get_focused(uia, &mut el_ptr) < 0 || el_ptr.is_null() {
        return None;
    }
    let _el = ComPtr(el_ptr);

    let get_pattern: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        i32,
        *mut *mut core::ffi::c_void,
    ) -> i32 = com_fn(el_ptr, 16);

    unsafe fn read_rect_from_range(range_ptr: *mut core::ffi::c_void) -> Option<(i32, i32, i32)> {
        let get_rects: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *mut *mut SAFEARRAY,
        ) -> i32 = com_fn(range_ptr, 10);
        let mut psa: *mut SAFEARRAY = std::ptr::null_mut();
        if get_rects(range_ptr, &mut psa) < 0 || psa.is_null() {
            return None;
        }
        let result = read_safearray_rect(psa);
        SafeArrayDestroy(psa);
        result
    }

    unsafe fn read_safearray_rect(psa: *const SAFEARRAY) -> Option<(i32, i32, i32)> {
        let (mut lb, mut ub) = (0i32, 0i32);
        if SafeArrayGetLBound(psa, 1, &mut lb) < 0 || SafeArrayGetUBound(psa, 1, &mut ub) < 0 {
            return None;
        }
        if ub - lb + 1 < 4 {
            return None;
        }
        let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
        if SafeArrayAccessData(psa, &mut data) < 0 || data.is_null() {
            return None;
        }
        let vals = std::slice::from_raw_parts(data as *const f64, 4);
        let (left, top, height) = (vals[0], vals[1], vals[3]);
        let _ = SafeArrayUnaccessData(psa);
        if height > 0.0 {
            Some((
                left.round() as i32,
                top.round() as i32,
                (top + height).round() as i32,
            ))
        } else {
            None
        }
    }

    let mut pat2_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    if get_pattern(el_ptr, UIA_TextPattern2Id as i32, &mut pat2_ptr) >= 0 && !pat2_ptr.is_null() {
        let _pat2 = ComPtr(pat2_ptr);
        let get_caret: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *mut BOOL,
            *mut *mut core::ffi::c_void,
        ) -> i32 = com_fn(pat2_ptr, 10);
        let mut active: BOOL = 0;
        let mut range_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        if get_caret(pat2_ptr, &mut active, &mut range_ptr) >= 0 && !range_ptr.is_null() {
            let _range = ComPtr(range_ptr);
            if let Some(r) = read_rect_from_range(range_ptr) {
                return Some(r);
            }
        }
    }

    let mut pat_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
    if get_pattern(el_ptr, UIA_TextPatternId as i32, &mut pat_ptr) >= 0 && !pat_ptr.is_null() {
        let _pat = ComPtr(pat_ptr);
        let get_sel: unsafe extern "system" fn(
            *mut core::ffi::c_void,
            *mut *mut core::ffi::c_void,
        ) -> i32 = com_fn(pat_ptr, 5);
        let mut arr_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        if get_sel(pat_ptr, &mut arr_ptr) >= 0 && !arr_ptr.is_null() {
            let _arr = ComPtr(arr_ptr);
            let get_len: unsafe extern "system" fn(*mut core::ffi::c_void, *mut i32) -> i32 =
                com_fn(arr_ptr, 3);
            let mut len = 0i32;
            if get_len(arr_ptr, &mut len) >= 0 && len > 0 {
                let get_el: unsafe extern "system" fn(
                    *mut core::ffi::c_void,
                    i32,
                    *mut *mut core::ffi::c_void,
                ) -> i32 = com_fn(arr_ptr, 4);
                let mut range_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
                if get_el(arr_ptr, 0, &mut range_ptr) >= 0 && !range_ptr.is_null() {
                    let _range = ComPtr(range_ptr);
                    if let Some(r) = read_rect_from_range(range_ptr) {
                        return Some(r);
                    }
                    let expand: unsafe extern "system" fn(*mut core::ffi::c_void, i32) -> i32 =
                        com_fn(range_ptr, 6);
                    if expand(range_ptr, 0) >= 0 {
                        if let Some(r) = read_rect_from_range(range_ptr) {
                            return Some(r);
                        }
                    }
                }
            }
        }
    }

    let get_prop: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        i32,
        *mut VARIANT,
    ) -> i32 = com_fn(el_ptr, 10);
    let mut var: VARIANT = std::mem::zeroed();
    if get_prop(el_ptr, UIA_BoundingRectanglePropertyId as i32, &mut var) >= 0 {
        let base = &var as *const VARIANT as *const u8;
        let vt = *(base as *const u16);
        let mut out = None;
        if vt == 0x2005 {
            let psa = *(base.add(8) as *const *const SAFEARRAY);
            if !psa.is_null() {
                if let Some((left, top, bottom)) = read_safearray_rect(psa) {
                    out = Some((left + 12, top, (top + 24).min(bottom)));
                }
            }
        }
        let _ = VariantClear(&mut var);
        return out;
    }

    None
}