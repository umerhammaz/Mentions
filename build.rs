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
        }
    }
}