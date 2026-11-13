use crate::injector;
use crate::server::{self, WsHub};
use crate::store::{self, AppState};
use crate::tray;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

const RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/umerhammaz/Mentions/releases/latest";
const MIN_EXE_BYTES: usize = 200 * 1024;
const MAX_EXE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct UpdateStatus {
    pub checking: bool,
    pub installing: bool,
    pub available_version: Option<String>,
    pub download_url: Option<String>,
    pub sha256_url: Option<String>,
    pub last_error: Option<String>,
    pub just_updated_from: Option<String>,
}

struct UpdaterCtx {
    state: Arc<Mutex<AppState>>,
    ws_hub: WsHub,
}

static STATUS: OnceLock<Mutex<UpdateStatus>> = OnceLock::new();
static CTX: OnceLock<UpdaterCtx> = OnceLock::new();
static INSTALL_ACTIVE: AtomicBool = AtomicBool::new(false);

fn status_cell() -> &'static Mutex<UpdateStatus> {
    STATUS.get_or_init(|| Mutex::new(UpdateStatus::default()))
}

pub fn set_just_updated_from(ver: Option<String>) {
    if let Ok(mut s) = status_cell().lock() {
        s.just_updated_from = ver;
    }
}

pub fn get_status() -> UpdateStatus {
    status_cell()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

pub fn status_json() -> Value {
    let s = get_status();
    json!({
        "checking": s.checking,
        "installing": s.installing,
        "availableVersion": s.available_version,
        "lastError": s.last_error,
        "justUpdatedFrom": s.just_updated_from,
    })
}

pub fn cleanup_old_files() {
    thread::spawn(|| {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let old_path = with_suffix(&exe, ".old");
        let new_path = with_suffix(&exe, ".new");
        for _ in 0..15 {
            let mut done = true;
            if old_path.exists() && fs::remove_file(&old_path).is_err() {
                done = false;
            }
            if new_path.exists() && fs::remove_file(&new_path).is_err() {
                done = false;
            }
            if done {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
}

pub fn start_updater_loop(state: Arc<Mutex<AppState>>, ws_hub: WsHub) {
    let _ = CTX.set(UpdaterCtx { state, ws_hub });

    #[cfg(windows)]
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(10));
        loop {
            let auto_update = CTX
                .get()
                .and_then(|c| c.state.lock().ok().map(|s| s.settings.auto_update))
                .unwrap_or(true);
            let _ = check_now_internal(auto_update, true);
            thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

pub fn trigger_check(install_if_auto: bool) {
    #[cfg(windows)]
    thread::spawn(move || {
        let _ = check_now_internal(install_if_auto, false);
    });
    #[cfg(not(windows))]
    {
        let _ = install_if_auto;
    }
}

pub fn trigger_install() {
    #[cfg(windows)]
    thread::spawn(|| {
        let _ = check_now_internal(true, false);
    });
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

fn parse_semver(raw: &str) -> Option<(u32, u32, u32)> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let core = trimmed.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    Some((major, minor, patch))
}

fn is_newer(remote: &str, local: &str) -> bool {
    match (parse_semver(remote), parse_semver(local)) {
        (Some(r), Some(l)) => r > l,
        _ => false,
    }
}

fn is_allowed_github_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    host == "github.com"
        || host == "api.github.com"
        || host == "objects.githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

#[cfg(windows)]
fn check_now_internal(allow_install: bool, quiet: bool) -> Result<(), String> {
    {
        let mut s = status_cell().lock().unwrap();
        if s.checking || s.installing {
            return Ok(());
        }
        s.checking = true;
        s.last_error = None;
    }

    let res = run_check_flow(allow_install, quiet);
    if let Ok(mut s) = status_cell().lock() {
        s.checking = false;
        if let Err(ref e) = res {
            s.last_error = Some(e.clone());
        }
    }
    res
}

#[cfg(windows)]
fn run_check_flow(allow_install: bool, quiet: bool) -> Result<(), String> {
    let meta_bytes = http_get_bytes(
        RELEASES_LATEST_URL,
        Some("Accept: application/vnd.github.v3+json\r\n"),
        512 * 1024,
    )?;
    let release: Value = serde_json::from_slice(&meta_bytes).map_err(|_| "Bad update data")?;
    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();

    if tag.is_empty() || !is_newer(&tag, env!("CARGO_PKG_VERSION")) {
        if let Ok(mut s) = status_cell().lock() {
            s.available_version = None;
            s.download_url = None;
            s.sha256_url = None;
        }
        return Ok(());
    }

    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing release files".to_string())?;

    let mut exe_url: Option<String> = None;
    let mut sha_url: Option<String> = None;
    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let url = asset
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !is_allowed_github_url(url) {
            continue;
        }
        if name.eq_ignore_ascii_case("mentions-daemon.exe") {
            exe_url = Some(url.to_string());
        } else if name.eq_ignore_ascii_case("mentions-daemon.exe.sha256") {
            sha_url = Some(url.to_string());
        }
    }

    let exe_url = exe_url.ok_or_else(|| "Windows binary missing from release".to_string())?;

    let prev_announced = status_cell()
        .lock()
        .ok()
        .and_then(|s| s.available_version.clone());

    if let Ok(mut s) = status_cell().lock() {
        s.available_version = Some(tag.clone());
        s.download_url = Some(exe_url.clone());
        s.sha256_url = sha_url.clone();
    }

    if !allow_install {
        if prev_announced.as_deref() != Some(tag.as_str()) || !quiet {
            tray::show_balloon(
                "Mentions update available",
                &format!("Version v{} is ready. Open Settings or tray menu to update.", tag),
            );
        }
        return Ok(());
    }

    install_release(&tag, &exe_url, sha_url.as_deref())
}

#[cfg(windows)]
fn install_release(tag: &str, exe_url: &str, sha_url: Option<&str>) -> Result<(), String> {
    if INSTALL_ACTIVE.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    struct InstallReset;
    impl Drop for InstallReset {
        fn drop(&mut self) {
            INSTALL_ACTIVE.store(false, Ordering::Release);
            if let Ok(mut s) = status_cell().lock() {
                s.installing = false;
            }
        }
    }
    let _reset = InstallReset;

    if let Ok(mut s) = status_cell().lock() {
        s.installing = true;
    }

    let cur_exe = std::env::current_exe().map_err(|_| "Cannot find current exe".to_string())?;
    let exe_dir = cur_exe
        .parent()
        .ok_or_else(|| "Invalid exe folder".to_string())?;
    let probe = exe_dir.join(".mentions-write-check");
    if File::create(&probe).is_err() {
        tray::show_balloon(
            "Mentions update available",
            &format!("v{} is ready, but this folder is read-only. Download manually.", tag),
        );
        return Err("Install folder is read-only".to_string());
    }
    let _ = fs::remove_file(&probe);

    let expected_sha = if let Some(url) = sha_url {
        let bytes = http_get_bytes(url, None, 4096)?;
        let txt = String::from_utf8_lossy(&bytes);
        let hex = txt.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            Some(hex)
        } else {
            return Err("Invalid SHA-256 checksum file".to_string());
        }
    } else {
        None
    };

    let new_path = with_suffix(&cur_exe, ".new");
    let old_path = with_suffix(&cur_exe, ".old");
    let _ = fs::remove_file(&new_path);

    let actual_sha = http_download_to_file(exe_url, &new_path)?;
    if let Some(expected) = expected_sha {
        if actual_sha != expected {
            let _ = fs::remove_file(&new_path);
            return Err("Downloaded file checksum mismatch".to_string());
        }
    }

    if !is_valid_pe_exe(&new_path) {
        let _ = fs::remove_file(&new_path);
        return Err("Downloaded file is not a valid Windows executable".to_string());
    }

    if let Some(ctx) = CTX.get() {
        ctx.ws_hub
            .broadcast(&json!({ "type": "daemon.updating", "version": tag }));
    }
    tray::show_balloon(
        "Updating Mentions",
        &format!("Installing v{} and restarting...", tag),
    );

    for _ in 0..40 {
        if !injector::is_busy() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    store::flush_pending_saves();
    server::stop_http_server();
    crate::release_instance_guard();

    let _ = fs::remove_file(&old_path);
    if fs::rename(&cur_exe, &old_path).is_err() {
        let _ = fs::remove_file(&new_path);
        return Err("Could not rename running executable".to_string());
    }

    if fs::rename(&new_path, &cur_exe).is_err() {
        let _ = fs::rename(&old_path, &cur_exe);
        return Err("Could not move new executable into place".to_string());
    }

    let spawn_res = std::process::Command::new(&cur_exe)
        .args(["--updated-from", env!("CARGO_PKG_VERSION")])
        .spawn();

    if spawn_res.is_err() {
        let _ = fs::rename(&cur_exe, &new_path);
        let _ = fs::rename(&old_path, &cur_exe);
        return Err("Failed to start new version".to_string());
    }

    std::process::exit(0);
}

fn is_valid_pe_exe(path: &Path) -> bool {
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    let Ok(meta) = f.metadata() else {
        return false;
    };
    let len = meta.len() as usize;
    if !(MIN_EXE_BYTES..=MAX_EXE_BYTES).contains(&len) {
        return false;
    }
    let mut head = [0u8; 64];
    if f.read_exact(&mut head).is_err() {
        return false;
    }
    if &head[0..2] != b"MZ" {
        return false;
    }
    let pe_off = u32::from_le_bytes([head[60], head[61], head[62], head[63]]) as u64;
    if pe_off + 4 > len as u64 {
        return false;
    }
    if f.seek(SeekFrom::Start(pe_off)).is_err() {
        return false;
    }
    let mut sig = [0u8; 4];
    if f.read_exact(&mut sig).is_err() {
        return false;
    }
    &sig == b"PE\0\0"
}

#[cfg(windows)]
fn split_https_url(url: &str) -> Result<(String, String), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| "Only HTTPS URLs allowed".to_string())?;
    let (host, path) = match rest.split_once('/') {
        Some((h, p)) => (h.to_string(), format!("/{}", p)),
        None => (rest.to_string(), "/".to_string()),
    };
    if host.is_empty() {
        return Err("Empty host".to_string());
    }
    Ok((host, path))
}

#[cfg(windows)]
struct WinHttpHandle(*mut core::ffi::c_void);

#[cfg(windows)]
impl Drop for WinHttpHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Networking::WinHttp::WinHttpCloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
fn http_open_request(
    url: &str,
    extra_headers: Option<&str>,
) -> Result<(WinHttpHandle, WinHttpHandle, WinHttpHandle), String> {
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders, WinHttpQueryOption,
        WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetTimeouts,
        INTERNET_DEFAULT_HTTPS_PORT, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE,
        WINHTTP_OPTION_URL, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    if !is_allowed_github_url(url) {
        return Err("Blocked non-GitHub URL".to_string());
    }
    let (host, path) = split_https_url(url)?;
    let agent: Vec<u16> = format!("Mentions-Daemon/{}\0", env!("CARGO_PKG_VERSION"))
        .encode_utf16()
        .collect();
    let host_w: Vec<u16> = format!("{}\0", host).encode_utf16().collect();
    let path_w: Vec<u16> = format!("{}\0", path).encode_utf16().collect();
    let verb_w: Vec<u16> = "GET\0".encode_utf16().collect();

    unsafe {
        let session = WinHttpHandle(WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        if session.0.is_null() {
            return Err("Could not open network session".to_string());
        }
        WinHttpSetTimeouts(session.0, 10_000, 10_000, 15_000, 30_000);

        let conn = WinHttpHandle(WinHttpConnect(
            session.0,
            host_w.as_ptr(),
            INTERNET_DEFAULT_HTTPS_PORT,
            0,
        ));
        if conn.0.is_null() {
            return Err("Could not connect to GitHub".to_string());
        }

        let req = WinHttpHandle(WinHttpOpenRequest(
            conn.0,
            verb_w.as_ptr(),
            path_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ));
        if req.0.is_null() {
            return Err("Could not create request".to_string());
        }

        let headers_w: Option<Vec<u16>> = extra_headers.map(|h| format!("{}\0", h).encode_utf16().collect());
        let (h_ptr, h_len) = match headers_w.as_ref() {
            Some(w) => (w.as_ptr(), (w.len() - 1) as u32),
            None => (std::ptr::null(), 0),
        };

        if WinHttpSendRequest(req.0, h_ptr, h_len, std::ptr::null(), 0, 0, 0) == 0 {
            return Err("Could not send request to GitHub".to_string());
        }
        if WinHttpReceiveResponse(req.0, std::ptr::null_mut()) == 0 {
            return Err("No response from GitHub".to_string());
        }

        let mut status: u32 = 0;
        let mut status_len: u32 = 4;
        if WinHttpQueryHeaders(
            req.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            std::ptr::null(),
            (&mut status as *mut u32).cast(),
            &mut status_len,
            std::ptr::null_mut(),
        ) == 0
            || status != 200
        {
            return Err(format!("GitHub returned HTTP {}", status));
        }

        let mut final_url = [0u16; 1024];
        let mut url_bytes = (final_url.len() * 2) as u32;
        if WinHttpQueryOption(
            req.0,
            WINHTTP_OPTION_URL,
            final_url.as_mut_ptr().cast(),
            &mut url_bytes,
        ) != 0
        {
            let chars = (url_bytes as usize / 2).min(final_url.len());
            let resolved = String::from_utf16_lossy(&final_url[..chars])
                .trim_end_matches('\0')
                .to_string();
            if !is_allowed_github_url(&resolved) {
                return Err("Redirect blocked".to_string());
            }
        }

        Ok((session, conn, req))
    }
}

#[cfg(windows)]
fn http_get_bytes(
    url: &str,
    extra_headers: Option<&str>,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Networking::WinHttp::{WinHttpQueryDataAvailable, WinHttpReadData};

    let (_session, _conn, req) = http_open_request(url, extra_headers)?;
    let mut out = Vec::new();
    let mut chunk = [0u8; 16384];

    unsafe {
        loop {
            let mut avail: u32 = 0;
            if WinHttpQueryDataAvailable(req.0, &mut avail) == 0 {
                return Err("Failed reading response".to_string());
            }
            if avail == 0 {
                break;
            }
            let to_read = (avail as usize).min(chunk.len()) as u32;
            let mut read: u32 = 0;
            if WinHttpReadData(req.0, chunk.as_mut_ptr().cast(), to_read, &mut read) == 0 {
                return Err("Failed reading data".to_string());
            }
            if read == 0 {
                break;
            }
            if out.len() + read as usize > max_bytes {
                return Err("Response too large".to_string());
            }
            out.extend_from_slice(&chunk[..read as usize]);
        }
    }
    Ok(out)
}

#[cfg(windows)]
fn http_download_to_file(url: &str, dest: &Path) -> Result<String, String> {
    use windows_sys::Win32::Networking::WinHttp::{WinHttpQueryDataAvailable, WinHttpReadData};
    use windows_sys::Win32::Security::Cryptography::{
        BCryptCloseAlgorithmProvider, BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash,
        BCryptGetProperty, BCryptHashData, BCryptOpenAlgorithmProvider,
    };

    let (_session, _conn, req) = http_open_request(url, None)?;
    let mut file = File::create(dest).map_err(|_| "Could not write update file".to_string())?;

    unsafe {
        let alg_w: Vec<u16> = "SHA256\0".encode_utf16().collect();
        let prop_w: Vec<u16> = "ObjectLength\0".encode_utf16().collect();
        let mut alg: *mut core::ffi::c_void = std::ptr::null_mut();
        if BCryptOpenAlgorithmProvider(&mut alg, alg_w.as_ptr(), std::ptr::null(), 0) < 0 {
            return Err("Could not start checksum engine".to_string());
        }
        struct AlgGuard(*mut core::ffi::c_void);
        impl Drop for AlgGuard {
            fn drop(&mut self) {
                unsafe {
                    BCryptCloseAlgorithmProvider(self.0, 0);
                }
            }
        }
        let _alg_guard = AlgGuard(alg);

        let mut obj_len_buf = [0u8; 4];
        let mut res_len: u32 = 0;
        if BCryptGetProperty(
            alg,
            prop_w.as_ptr(),
            obj_len_buf.as_mut_ptr(),
            4,
            &mut res_len,
            0,
        ) < 0
        {
            return Err("Could not prepare checksum".to_string());
        }
        let obj_len = u32::from_ne_bytes(obj_len_buf) as usize;
        let mut hash_obj = vec![0u8; obj_len];
        let mut hash_handle: *mut core::ffi::c_void = std::ptr::null_mut();
        if BCryptCreateHash(
            alg,
            &mut hash_handle,
            hash_obj.as_mut_ptr(),
            hash_obj.len() as u32,
            std::ptr::null(),
            0,
            0,
        ) < 0
        {
            return Err("Could not create checksum state".to_string());
        }
        struct HashGuard(*mut core::ffi::c_void);
        impl Drop for HashGuard {
            fn drop(&mut self) {
                unsafe {
                    BCryptDestroyHash(self.0);
                }
            }
        }
        let _hash_guard = HashGuard(hash_handle);

        let mut total: usize = 0;
        let mut chunk = [0u8; 65536];
        loop {
            let mut avail: u32 = 0;
            if WinHttpQueryDataAvailable(req.0, &mut avail) == 0 {
                return Err("Download interrupted".to_string());
            }
            if avail == 0 {
                break;
            }
            let to_read = (avail as usize).min(chunk.len()) as u32;
            let mut read: u32 = 0;
            if WinHttpReadData(req.0, chunk.as_mut_ptr().cast(), to_read, &mut read) == 0 {
                return Err("Download read failed".to_string());
            }
            if read == 0 {
                break;
            }
            total += read as usize;
            if total > MAX_EXE_BYTES {
                return Err("Download exceeds max size".to_string());
            }
            file.write_all(&chunk[..read as usize])
                .map_err(|_| "Disk write failed".to_string())?;
            if BCryptHashData(hash_handle, chunk.as_ptr(), read, 0) < 0 {
                return Err("Checksum step failed".to_string());
            }
        }

        file.sync_all().map_err(|_| "Disk sync failed".to_string())?;
        let mut digest = [0u8; 32];
        if BCryptFinishHash(hash_handle, digest.as_mut_ptr(), 32, 0) < 0 {
            return Err("Checksum finish failed".to_string());
        }
        let mut hex = String::with_capacity(64);
        for b in digest {
            hex.push_str(&format!("{:02x}", b));
        }
        Ok(hex)
    }
}