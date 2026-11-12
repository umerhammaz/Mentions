fn main() {
    #[cfg(target_os = "windows")]
    {
        use std::fs;
        use std::path::Path;

        let out_dir = std::env::var("OUT_DIR").unwrap();
        let out_path = Path::new(&out_dir);

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

            let png_path = dir.join("assets").join("mentions_icon.png");
            if png_path.exists() {
                println!("cargo:rerun-if-changed=assets/mentions_icon.png");
                if let Ok(img) = image::open(&png_path) {
                    let ico_path = out_path.join("app.ico");
                    if let Ok(mut ico_file) = fs::File::create(&ico_path) {
                        let _ = img.write_to(
                            &mut ico_file,
                            image::ImageFormat::Ico,
                        );
                    }

                    let rc_path = out_path.join("app.rc");
                    let rc_content = format!(
                        "1 ICON \"{}\"\n",
                        ico_path.display().to_string().replace('\\', "/")
                    );
                    let _ = fs::write(&rc_path, rc_content);

                    let res_path = out_path.join("app.res");
                    let status = std::process::Command::new("rc.exe")
                        .arg(format!("/fo{}", res_path.display()))
                        .arg(&rc_path)
                        .status();

                    if status.map(|s| s.success()).unwrap_or(false) {
                        println!("cargo:rustc-link-arg={}", res_path.display());
                    }
                }
            }
        }
    }
}