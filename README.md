# Mentions

Lightweight Windows text expansion daemon (`mentions-daemon`) paired with a static web controller (`https://mentions-but.pages.dev`).

## Build the Windows Daemon

```sh
cargo build --release
```

The single-file executable is generated at `target/release/mentions-daemon.exe`.

## Usage

1. Run `mentions-daemon.exe`. It sits in the Windows system tray and listens on `http://127.0.0.1:31415`.
2. Right-click the tray icon and select **Pair Browser** (or double-click the tray icon) to open and pair the web controller automatically.
3. Type any trigger such as `@sig` followed by Space in any app to expand your text.