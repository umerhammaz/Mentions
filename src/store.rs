use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommandItem {
    pub id: String,
    pub trigger: String,
    pub text: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub port: u16,
    pub terminator: String,
    #[serde(rename = "restoreClipboard")]
    pub restore_clipboard: bool,
    #[serde(rename = "injectionFallback")]
    pub injection_fallback: String,
    pub autostart: bool,
    #[serde(rename = "statsEnabled")]
    pub stats_enabled: bool,
    pub paused: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 31415,
            terminator: "space".to_string(),
            restore_clipboard: true,
            injection_fallback: "clipboard".to_string(),
            autostart: false,
            stats_enabled: false,
            paused: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct TokenFile {
    tokens: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CommandsFile {
    commands: Vec<CommandItem>,
}

pub struct AppState {
    pub commands: Vec<CommandItem>,
    pub settings: Settings,
    pub tokens: Vec<String>,
    pub pair_code: String,
    pub pair_expires_at: u64,
    pub failed_pair_attempts: u32,
    pub pair_lock_until: u64,
    data_dir: PathBuf,
}

impl AppState {
    pub fn load() -> Self {
        let data_dir = resolve_data_dir();
        let _ = fs::create_dir_all(&data_dir);

        let commands_path = data_dir.join("commands.json");
        let settings_path = data_dir.join("settings.json");
        let tokens_path = data_dir.join("tokens.json");

        let commands = load_with_backup::<CommandsFile>(&commands_path)
            .map(|f| f.commands)
            .or_else(|| load_with_backup::<Vec<CommandItem>>(&commands_path))
            .unwrap_or_else(default_commands);

        let settings = load_with_backup::<Settings>(&settings_path).unwrap_or_default();
        let tokens = load_with_backup::<TokenFile>(&tokens_path)
            .map(|t| t.tokens)
            .unwrap_or_default();

        let (code, exp) = generate_pair_code();
        let state = Self {
            commands,
            settings,
            tokens,
            pair_code: code,
            pair_expires_at: exp,
            failed_pair_attempts: 0,
            pair_lock_until: 0,
            data_dir,
        };
        state.save_commands();
        state.save_settings();
        state.save_tokens();
        state
    }

    pub fn refresh_pair_code(&mut self) -> String {
        let (code, exp) = generate_pair_code();
        self.pair_code = code.clone();
        self.pair_expires_at = exp;
        code
    }

    pub fn verify_pair_code(&mut self, candidate: &str) -> Result<String, Option<u64>> {
        let now = now_secs();
        if now < self.pair_lock_until {
            return Err(Some(self.pair_lock_until - now));
        }
        if now > self.pair_expires_at {
            self.refresh_pair_code();
        }
        if candidate.trim().eq_ignore_ascii_case(&self.pair_code) {
            self.failed_pair_attempts = 0;
            self.pair_lock_until = 0;
            let token = format!("mnt_{}_{}", random_hex(16), random_hex(16));
            self.tokens.push(token.clone());
            self.save_tokens();
            Ok(token)
        } else {
            self.failed_pair_attempts += 1;
            if self.failed_pair_attempts >= 5 {
                self.pair_lock_until = now + 30;
                self.failed_pair_attempts = 0;
                Err(Some(30))
            } else {
                Err(None)
            }
        }
    }

    pub fn is_valid_token(&self, auth_header: Option<&str>) -> bool {
        let raw = match auth_header {
            Some(h) => h.trim(),
            None => return false,
        };
        let tok = match raw.strip_prefix("Bearer ") {
            Some(t) => t.trim(),
            None => return false,
        };
        !tok.is_empty() && self.tokens.iter().any(|x| x == tok)
    }

    pub fn is_valid_raw_token(&self, tok: &str) -> bool {
        !tok.is_empty() && self.tokens.iter().any(|x| x == tok)
    }

    pub fn save_commands(&self) {
        let wrapper = CommandsFile {
            commands: self.commands.clone(),
        };
        atomic_write_json(&self.data_dir.join("commands.json"), &wrapper);
    }

    pub fn save_settings(&self) {
        atomic_write_json(&self.data_dir.join("settings.json"), &self.settings);
    }

    pub fn save_tokens(&self) {
        let wrapper = TokenFile {
            tokens: self.tokens.clone(),
        };
        atomic_write_json(&self.data_dir.join("tokens.json"), &wrapper);
    }
}

fn resolve_data_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("Mentions")
    } else if let Ok(home) = std::env::var("USERPROFILE") {
        PathBuf::from(home).join("AppData").join("Roaming").join("Mentions")
    } else {
        PathBuf::from(".").join("mentions-data")
    }
}

fn load_with_backup<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(parsed) = serde_json::from_str::<T>(&raw) {
            return Some(parsed);
        }
        let corrupt = path.with_extension("json.corrupt");
        let _ = fs::copy(path, corrupt);
    }
    let bak = path.with_extension("json.bak");
    if let Ok(raw) = fs::read_to_string(&bak) {
        if let Ok(parsed) = serde_json::from_str::<T>(&raw) {
            let _ = fs::copy(&bak, path);
            return Some(parsed);
        }
    }
    None
}

fn atomic_write_json<T: Serialize>(path: &PathBuf, data: &T) {
    let Ok(serialized) = serde_json::to_vec_pretty(data) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    let bak = path.with_extension("json.bak");
    if let Ok(mut file) = fs::File::create(&tmp) {
        if file.write_all(&serialized).is_ok() && file.sync_all().is_ok() {
            drop(file);
            if path.exists() {
                let _ = fs::copy(path, &bak);
            }
            let _ = fs::rename(&tmp, path);
        }
    }
}

fn default_commands() -> Vec<CommandItem> {
    let now = iso_now();
    vec![
        CommandItem {
            id: new_id(),
            trigger: "@sig".to_string(),
            text: "Best regards,\nAyesha Khan · Product".to_string(),
            enabled: true,
            group: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        },
        CommandItem {
            id: new_id(),
            trigger: "@thanks".to_string(),
            text: "Thanks for the quick reply — I'll take a look this afternoon.".to_string(),
            enabled: true,
            group: None,
            created_at: now.clone(),
            updated_at: now,
        },
    ]
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn iso_now() -> String {
    let secs = now_secs();
    format!("{}Z", secs)
}

pub fn new_id() -> String {
    format!(
        "{}-{}-{}",
        random_hex(8),
        random_hex(4),
        random_hex(12)
    )
}

fn random_seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    let addr = &nanos as *const u64 as usize as u64;
    let mut x = nanos ^ addr.rotate_left(17) ^ 0xBF58476D1CE4E5B9;
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D049BB133111EB);
    x ^ (x >> 31)
}

fn random_hex(len: usize) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(len);
    let mut state = random_seed();
    for i in 0..len {
        if i % 8 == 0 {
            state ^= random_seed().wrapping_add(i as u64);
        }
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let idx = ((state >> 32) as usize) % 16;
        out.push(HEX[idx] as char);
    }
    out
}

fn generate_pair_code() -> (String, u64) {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut code = String::with_capacity(6);
    let mut state = random_seed();
    for i in 0..6 {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407 + i);
        let idx = ((state >> 32) as usize) % CHARS.len();
        code.push(CHARS[idx] as char);
    }
    (code, now_secs() + 300)
}

#[cfg(windows)]
pub fn sync_autostart(enabled: bool) {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_SZ,
    };

    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run\0"
        .encode_utf16()
        .collect();
    let val_name: Vec<u16> = "Mentions\0".encode_utf16().collect();

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut hkey,
        ) == 0
        {
            if enabled {
                if let Ok(exe) = std::env::current_exe() {
                    let quoted = format!("\"{}\"\0", exe.display());
                    let wide: Vec<u16> = quoted.encode_utf16().collect();
                    let _ = RegSetValueExW(
                        hkey,
                        val_name.as_ptr(),
                        0,
                        REG_SZ,
                        wide.as_ptr() as *const u8,
                        (wide.len() * 2) as u32,
                    );
                }
            } else {
                let _ = RegDeleteValueW(hkey, val_name.as_ptr());
            }
            let _ = RegCloseKey(hkey);
        }
    }
}

#[cfg(not(windows))]
pub fn sync_autostart(_enabled: bool) {}