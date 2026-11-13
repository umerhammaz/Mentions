fn main() {
    #[cfg(target_os = "windows")]
    {
        if let Ok(dir) = std::env::current_dir() {
            let manifest = dir.join("assets").join("app.manifest");
            if manifest.exists() {
                println!("cargo:rerun-if-changed=assets/app.manifest");
                println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
                println!(
                    "cargo:rustc-link-arg-bins=/MANIFESTINPUT:{}",
                    manifest.display()
                );
            }

            let png_icon = dir.join("assets").join("mentions_icon.png");
            if png_icon.exists() {
                println!("cargo:rerun-if-changed=assets/mentions_icon.png");
                if let Ok(out_dir) = std::env::var("OUT_DIR") {
                    let ico_path = std::path::PathBuf::from(out_dir).join("mentions_icon.ico");
                    if write_ico_from_png(&png_icon, &ico_path).is_ok() {
                        let mut res = winresource::WindowsResource::new();
                        res.set_icon(&ico_path.to_string_lossy());
                        res.set("ProductName", "Mentions");
                        res.set("FileDescription", "Mentions Local Text Expansion Daemon");
                        res.set("CompanyName", "Mentions");
                        res.set("OriginalFilename", "mentions-daemon.exe");
                        res.set("InternalName", "mentions-daemon");
                        res.set("LegalCopyright", "MIT License");
                        if let Err(e) = res.compile() {
                            println!("cargo:warning=winresource: {}", e);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn write_ico_from_png(
    png_path: &std::path::Path,
    ico_path: &std::path::Path,
) -> std::io::Result<()> {
    let png = std::fs::read(png_path)?;
    if png.len() < 24 || &png[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid png",
        ));
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    let w_byte = if w >= 256 { 0 } else { w as u8 };
    let h_byte = if h >= 256 { 0 } else { h as u8 };
    let size = (png.len() as u32).to_le_bytes();
    let offset = 22u32.to_le_bytes();

    let mut ico = Vec::with_capacity(22 + png.len());
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    ico.extend_from_slice(&[w_byte, h_byte, 0, 0, 1, 0, 32, 0]);
    ico.extend_from_slice(&size);
    ico.extend_from_slice(&offset);
    ico.extend_from_slice(&png);
    std::fs::write(ico_path, ico)
}