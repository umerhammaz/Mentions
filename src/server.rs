use crate::store::{self, AppState, CommandItem};
use serde_json::{json, Value};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use tungstenite::protocol::{Message, Role};
use tungstenite::WebSocket;

type WsClient = WebSocket<Box<dyn tiny_http::ReadWrite + Send>>;

#[derive(Clone)]
pub struct WsHub {
    clients: Arc<Mutex<Vec<WsClient>>>,
}

impl WsHub {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn add(&self, client: WsClient) {
        if let Ok(mut list) = self.clients.lock() {
            list.push(client);
        }
    }

    pub fn broadcast(&self, payload: &Value) {
        let msg_text = payload.to_string();
        if let Ok(mut list) = self.clients.lock() {
            list.retain_mut(|client| client.send(Message::Text(msg_text.clone())).is_ok());
        }
    }
}

pub fn start_http_server(state: Arc<Mutex<AppState>>, ws_hub: WsHub) {
    let port = { state.lock().unwrap().settings.port };
    thread::spawn(move || {
        let bind_addr = format!("127.0.0.1:{}", port);
        let Ok(server) = Server::http(&bind_addr) else {
            return;
        };

        for request in server.incoming_requests() {
            let st = Arc::clone(&state);
            let hub = ws_hub.clone();
            thread::spawn(move || {
                handle_request(request, st, hub);
            });
        }
    });
}

fn handle_request(mut req: Request, state: Arc<Mutex<AppState>>, ws_hub: WsHub) {
    if req.url() == "/api/internal/shutdown" && *req.method() == Method::Post {
        if header_value(&req, "origin").is_none() {
            ws_hub.broadcast(&json!({ "type": "daemon.stopping" }));
            let _ = req.respond(Response::empty(StatusCode(200)));
            std::process::exit(0);
        }
    }

    let origin = header_value(&req, "origin").unwrap_or_else(|| "*".to_string());
    if !is_allowed_origin(&origin) {
        let _ = send_json(
            req,
            403,
            &origin,
            Some(json!({ "code": "E_FORBIDDEN", "message": "Origin not allowed" })),
        );
        return;
    }

    if *req.method() == Method::Options {
        let _ = send_json(req, 204, &origin, None);
        return;
    }

    let raw_url = req.url().to_string();
    let (path, query) = match raw_url.split_once('?') {
        Some((p, q)) => (p, q),
        None => (raw_url.as_str(), ""),
    };

    if path == "/ws" {
        handle_ws_upgrade(req, query, state, ws_hub);
        return;
    }

    if *req.method() == Method::Get && !path.starts_with("/api/") {
        serve_embedded_ui(req, path);
        return;
    }

    if path == "/api/health" && *req.method() == Method::Get {
        let auth_header = header_value(&req, "authorization");
        let s = state.lock().unwrap();
        let is_authed = s.is_valid_token(auth_header.as_deref());
        let _ = send_json(
            req,
            200,
            &origin,
            Some(json!({
                "apiVersion": "1.0",
                "daemonVersion": env!("CARGO_PKG_VERSION"),
                "hookActive": !s.settings.paused,
                "paused": s.settings.paused,
                "requiresPairing": s.tokens.is_empty() || !is_authed,
                "versionMismatch": false,
                "elevatedHint": false
            })),
        );
        return;
    }

    if path == "/api/pair" && *req.method() == Method::Post {
        let body = read_json_body(&mut req);
        let code = body
            .as_ref()
            .and_then(|b| b.get("code"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mut s = state.lock().unwrap();
        match s.verify_pair_code(code) {
            Ok(token) => {
                let _ = send_json(req, 200, &origin, Some(json!({ "token": token })));
            }
            Err(Some(retry_after)) => {
                let _ = send_json(
                    req,
                    429,
                    &origin,
                    Some(json!({
                        "code": "E_RATE_LIMITED",
                        "retryAfter": retry_after,
                        "message": "Too many attempts"
                    })),
                );
            }
            Err(None) => {
                let _ = send_json(
                    req,
                    401,
                    &origin,
                    Some(json!({
                        "code": "E_UNAUTHORIZED",
                        "message": "Code mismatch"
                    })),
                );
            }
        }
        return;
    }

    let auth_header = header_value(&req, "authorization");
    {
        let s = state.lock().unwrap();
        if !s.is_valid_token(auth_header.as_deref()) {
            let _ = send_json(
                req,
                401,
                &origin,
                Some(json!({ "code": "E_UNAUTHORIZED" })),
            );
            return;
        }
    }

    if path == "/api/commands" && *req.method() == Method::Get {
        let s = state.lock().unwrap();
        let _ = send_json(req, 200, &origin, Some(json!({ "commands": s.commands })));
        return;
    }

    if path == "/api/commands" && *req.method() == Method::Post {
        let body = read_json_body(&mut req).unwrap_or_else(|| json!({}));
        let trigger = body
            .get("trigger")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let text = body
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        let group = body
            .get("group")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        if !is_valid_trigger(&trigger) {
            let _ = send_json(
                req,
                422,
                &origin,
                Some(json!({
                    "code": "E_VALIDATION",
                    "field": "trigger",
                    "message": "Invalid trigger format"
                })),
            );
            return;
        }
        if text.is_empty() || text.len() > 65536 {
            let _ = send_json(
                req,
                422,
                &origin,
                Some(json!({
                    "code": "E_VALIDATION",
                    "field": "text",
                    "message": "Text is required and must be within limit"
                })),
            );
            return;
        }

        let mut s = state.lock().unwrap();
        if s.commands
            .iter()
            .any(|c| c.trigger.eq_ignore_ascii_case(&trigger))
        {
            let _ = send_json(
                req,
                409,
                &origin,
                Some(json!({
                    "code": "E_CONFLICT",
                    "field": "trigger",
                    "message": "Trigger already used"
                })),
            );
            return;
        }

        let now = store::iso_now();
        let item = CommandItem {
            id: store::new_id(),
            trigger,
            text,
            enabled,
            group,
            created_at: now.clone(),
            updated_at: now,
        };
        s.commands.push(item.clone());
        s.save_commands();
        drop(s);

        ws_hub.broadcast(&json!({ "type": "commands.changed" }));
        let _ = send_json(req, 201, &origin, Some(json!(item)));
        return;
    }

    if path == "/api/commands/export" && *req.method() == Method::Get {
        let s = state.lock().unwrap();
        let _ = send_json(
            req,
            200,
            &origin,
            Some(json!({
                "schemaVersion": 1,
                "exportedAt": store::iso_now(),
                "commands": s.commands,
                "settings": s.settings
            })),
        );
        return;
    }

    if path == "/api/commands/import" && *req.method() == Method::Post {
        let body = read_json_body(&mut req).unwrap_or_else(|| json!({}));
        let Some(arr) = body.get("commands").and_then(|v| v.as_array()) else {
            let _ = send_json(
                req,
                422,
                &origin,
                Some(json!({ "code": "E_VALIDATION", "message": "Missing commands array" })),
            );
            return;
        };

        let now = store::iso_now();
        let mut imported_list = Vec::new();
        for item in arr {
            let trig = item
                .get("trigger")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let txt = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if !is_valid_trigger(trig) || txt.is_empty() || txt.len() > 65536 {
                continue;
            }
            if imported_list
                .iter()
                .any(|c: &CommandItem| c.trigger.eq_ignore_ascii_case(trig))
            {
                continue;
            }
            imported_list.push(CommandItem {
                id: store::new_id(),
                trigger: trig.to_string(),
                text: txt.to_string(),
                enabled: item.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                group: item
                    .get("group")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                created_at: now.clone(),
                updated_at: now.clone(),
            });
        }

        let count = imported_list.len();
        {
            let mut s = state.lock().unwrap();
            s.commands = imported_list;
            s.save_commands();
        }
        ws_hub.broadcast(&json!({ "type": "commands.changed" }));
        let _ = send_json(req, 200, &origin, Some(json!({ "imported": count })));
        return;
    }

    if let Some(id) = path.strip_prefix("/api/commands/") {
        if !id.is_empty() && !id.contains('/') {
            let method = req.method().clone();
            if method == Method::Get {
                let s = state.lock().unwrap();
                if let Some(cmd) = s.commands.iter().find(|c| c.id == id) {
                    let _ = send_json(req, 200, &origin, Some(json!(cmd)));
                } else {
                    let _ = send_json(req, 404, &origin, Some(json!({ "code": "E_NOT_FOUND" })));
                }
                return;
            }
            if method == Method::Patch {
                let body = read_json_body(&mut req).unwrap_or_else(|| json!({}));
                let mut s = state.lock().unwrap();
                let Some(idx) = s.commands.iter().position(|c| c.id == id) else {
                    let _ = send_json(req, 404, &origin, Some(json!({ "code": "E_NOT_FOUND" })));
                    return;
                };
                if let Some(new_trig) = body.get("trigger").and_then(|v| v.as_str()) {
                    let trimmed = new_trig.trim();
                    if !is_valid_trigger(trimmed) {
                        let _ = send_json(
                            req,
                            422,
                            &origin,
                            Some(json!({
                                "code": "E_VALIDATION",
                                "field": "trigger",
                                "message": "Invalid trigger"
                            })),
                        );
                        return;
                    }
                    if s.commands
                        .iter()
                        .enumerate()
                        .any(|(i, c)| i != idx && c.trigger.eq_ignore_ascii_case(trimmed))
                    {
                        let _ = send_json(
                            req,
                            409,
                            &origin,
                            Some(json!({
                                "code": "E_CONFLICT",
                                "field": "trigger",
                                "message": "Trigger already used"
                            })),
                        );
                        return;
                    }
                    s.commands[idx].trigger = trimmed.to_string();
                }
                if let Some(new_txt) = body.get("text").and_then(|v| v.as_str()) {
                    if new_txt.is_empty() || new_txt.len() > 65536 {
                        let _ = send_json(
                            req,
                            422,
                            &origin,
                            Some(json!({
                                "code": "E_VALIDATION",
                                "field": "text",
                                "message": "Invalid text"
                            })),
                        );
                        return;
                    }
                    s.commands[idx].text = new_txt.to_string();
                }
                if let Some(en) = body.get("enabled").and_then(|v| v.as_bool()) {
                    s.commands[idx].enabled = en;
                }
                if let Some(grp) = body.get("group").and_then(|v| v.as_str()) {
                    let trimmed = grp.trim();
                    s.commands[idx].group = if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_string())
                    };
                }
                s.commands[idx].updated_at = store::iso_now();
                let updated = s.commands[idx].clone();
                s.save_commands();
                drop(s);

                ws_hub.broadcast(&json!({ "type": "commands.changed" }));
                let _ = send_json(req, 200, &origin, Some(json!(updated)));
                return;
            }
            if method == Method::Delete {
                let mut s = state.lock().unwrap();
                let Some(idx) = s.commands.iter().position(|c| c.id == id) else {
                    let _ = send_json(req, 404, &origin, Some(json!({ "code": "E_NOT_FOUND" })));
                    return;
                };
                s.commands.remove(idx);
                s.save_commands();
                drop(s);

                ws_hub.broadcast(&json!({ "type": "commands.changed" }));
                let _ = send_json(req, 204, &origin, None);
                return;
            }
        }
    }

    if path == "/api/settings" && *req.method() == Method::Get {
        let s = state.lock().unwrap();
        let _ = send_json(req, 200, &origin, Some(json!(s.settings)));
        return;
    }

    if path == "/api/settings" && *req.method() == Method::Patch {
        let body = read_json_body(&mut req).unwrap_or_else(|| json!({}));
        let mut s = state.lock().unwrap();
        let mut restart_required = false;

        if let Some(p) = body.get("port").and_then(|v| v.as_u64()) {
            let port_u16 = p as u16;
            if (1024..=65535).contains(&port_u16) && port_u16 != s.settings.port {
                s.settings.port = port_u16;
                restart_required = true;
            }
        }
        if let Some(term) = body.get("terminator").and_then(|v| v.as_str()) {
            if matches!(term, "space" | "enter" | "tab") {
                s.settings.terminator = term.to_string();
            }
        }
        if let Some(rc) = body.get("restoreClipboard").and_then(|v| v.as_bool()) {
            s.settings.restore_clipboard = rc;
        }
        if let Some(fb) = body.get("injectionFallback").and_then(|v| v.as_str()) {
            s.settings.injection_fallback = fb.to_string();
        }
        if let Some(auto) = body.get("autostart").and_then(|v| v.as_bool()) {
            s.settings.autostart = auto;
            store::sync_autostart(auto);
        }
        if let Some(st) = body.get("statsEnabled").and_then(|v| v.as_bool()) {
            s.settings.stats_enabled = st;
        }

        s.save_settings();
        let mut resp = serde_json::to_value(&s.settings).unwrap_or_else(|_| json!({}));
        if let Some(obj) = resp.as_object_mut() {
            obj.insert("restartRequired".to_string(), json!(restart_required));
        }
        let _ = send_json(req, 200, &origin, Some(resp));
        if restart_required {
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(400));
                crate::restart_daemon();
            });
        }
        return;
    }

    if path == "/api/hook/pause" && *req.method() == Method::Post {
        {
            let mut s = state.lock().unwrap();
            s.settings.paused = true;
            s.save_settings();
        }
        ws_hub.broadcast(&json!({ "type": "hook.state", "paused": true }));
        let _ = send_json(req, 200, &origin, Some(json!({ "paused": true })));
        return;
    }

    if path == "/api/hook/resume" && *req.method() == Method::Post {
        {
            let mut s = state.lock().unwrap();
            s.settings.paused = false;
            s.save_settings();
        }
        ws_hub.broadcast(&json!({ "type": "hook.state", "paused": false }));
        let _ = send_json(req, 200, &origin, Some(json!({ "paused": false })));
        return;
    }

    if path == "/api/pair/revoke-all" && *req.method() == Method::Post {
        let mut s = state.lock().unwrap();
        s.tokens.clear();
        s.save_tokens();
        let _ = send_json(req, 204, &origin, None);
        return;
    }

    if path == "/api/daemon/restart" && *req.method() == Method::Post {
        let _ = send_json(req, 200, &origin, Some(json!({ "restarting": true })));
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(200));
            crate::restart_daemon();
        });
        return;
    }

    let _ = send_json(req, 404, &origin, Some(json!({ "code": "E_NOT_FOUND" })));
}

fn handle_ws_upgrade(req: Request, query: &str, state: Arc<Mutex<AppState>>, ws_hub: WsHub) {
    let token_param = query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == "token" {
            Some(v)
        } else {
            None
        }
    });

    if let Some(tok) = token_param {
        let s = state.lock().unwrap();
        if !s.tokens.is_empty() && !s.is_valid_raw_token(tok) {
            return;
        }
    }

    let Some(ws_key) = header_value(&req, "sec-websocket-key") else {
        return;
    };
    let accept_val = compute_ws_accept(&ws_key);
    let response = Response::empty(StatusCode(101))
        .with_header(Header::from_bytes(&b"Upgrade"[..], &b"websocket"[..]).unwrap())
        .with_header(Header::from_bytes(&b"Connection"[..], &b"Upgrade"[..]).unwrap())
        .with_header(
            Header::from_bytes(&b"Sec-WebSocket-Accept"[..], accept_val.as_bytes()).unwrap(),
        );

    let stream = req.upgrade("websocket", response);
    let ws = WebSocket::from_raw_socket(stream, Role::Server, None);
    ws_hub.add(ws);
}

fn is_valid_trigger(trigger: &str) -> bool {
    let bytes = trigger.as_bytes();
    if bytes.len() < 2 || bytes.len() > 32 || bytes[0] != b'@' {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn is_allowed_origin(origin: &str) -> bool {
    origin == "*"
        || origin == "https://mentions-but.pages.dev"
        || origin == "https://mentions-blond.vercel.app"
        || origin == "https://mentions.pages.dev"
        || origin.ends_with(".pages.dev")
        || origin.ends_with(".vercel.app")
        || origin.starts_with("http://127.0.0.1")
        || origin.starts_with("http://localhost")
}

fn header_value(req: &Request, name: &'static str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

fn read_json_body(req: &mut Request) -> Option<Value> {
    let mut buf = String::new();
    req.as_reader().take(256 * 1024).read_to_string(&mut buf).ok()?;
    if buf.trim().is_empty() {
        return None;
    }
    serde_json::from_str(&buf).ok()
}

fn send_json(
    req: Request,
    status: u16,
    origin: &str,
    body: Option<Value>,
) -> std::io::Result<()> {
    let allow_origin = if origin == "*" {
        "*"
    } else {
        origin
    };

    let req_headers = header_value(&req, "access-control-request-headers")
        .unwrap_or_else(|| "authorization, content-type".to_string());

    let mut headers = vec![
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allow_origin.as_bytes()).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], req_headers.as_bytes()).unwrap(),
        Header::from_bytes(
            &b"Access-Control-Allow-Methods"[..],
            &b"GET, POST, PATCH, DELETE, OPTIONS"[..],
        )
        .unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Private-Network"[..], &b"true"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Max-Age"[..], &b"86400"[..]).unwrap(),
    ];

    if let Some(val) = body {
        let data = val.to_string().into_bytes();
        headers.push(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
        );
        let resp = Response::new(
            StatusCode(status),
            headers,
            std::io::Cursor::new(data.clone()),
            Some(data.len()),
            None,
        );
        req.respond(resp)
    } else {
        let resp = Response::new(
            StatusCode(status),
            headers,
            std::io::Cursor::new(Vec::new()),
            Some(0),
            None,
        );
        req.respond(resp)
    }
}

fn serve_embedded_ui(req: Request, path: &str) {
    let (content_type, bytes): (&[u8], &[u8]) = match path {
        "/favicon.ico" => (&b"image/png"[..], include_bytes!("../assets/mentions_icon.png")),
        "/assets/mentions_icon.png" => (&b"image/png"[..], include_bytes!("../assets/mentions_icon.png")),
        "/assets/mentions_logo.png" => (&b"image/png"[..], include_bytes!("../assets/mentions_logo.png")),
        "/404.html" => (&b"text/html; charset=utf-8"[..], include_bytes!("../404.html")),
        "/assets/icons.svg" => (&b"image/svg+xml"[..], include_bytes!("../assets/icons.svg")),
        "/assets/css/tokens.css" => (&b"text/css; charset=utf-8"[..], include_bytes!("../assets/css/tokens.css")),
        "/assets/css/reset.css" => (&b"text/css; charset=utf-8"[..], include_bytes!("../assets/css/reset.css")),
        "/assets/css/base.css" => (&b"text/css; charset=utf-8"[..], include_bytes!("../assets/css/base.css")),
        "/assets/css/layout.css" => (&b"text/css; charset=utf-8"[..], include_bytes!("../assets/css/layout.css")),
        "/assets/css/components.css" => (&b"text/css; charset=utf-8"[..], include_bytes!("../assets/css/components.css")),
        "/assets/css/screens.css" => (&b"text/css; charset=utf-8"[..], include_bytes!("../assets/css/screens.css")),
        "/assets/js/main.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/main.js")),
        "/assets/js/router.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/router.js")),
        "/assets/js/a11y.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/a11y.js")),
        "/assets/js/dom.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/dom.js")),
        "/assets/js/ui.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/ui.js")),
        "/assets/js/api.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/api.js")),
        "/assets/js/ws.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/ws.js")),
        "/assets/js/store.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/store.js")),
        "/assets/js/screens/commands.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/screens/commands.js")),
        "/assets/js/screens/editor.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/screens/editor.js")),
        "/assets/js/screens/notfound.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/screens/notfound.js")),
        "/assets/js/screens/pair.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/screens/pair.js")),
        "/assets/js/screens/settings.js" => (&b"application/javascript; charset=utf-8"[..], include_bytes!("../assets/js/screens/settings.js")),
        _ if path.starts_with("/assets/") => {
            let resp = Response::new(
                StatusCode(404),
                vec![],
                std::io::Cursor::new(Vec::new()),
                Some(0),
                None,
            );
            let _ = req.respond(resp);
            return;
        }
        _ => (&b"text/html; charset=utf-8"[..], include_bytes!("../index.html")),
    };

    let headers = vec![
        Header::from_bytes(&b"Content-Type"[..], content_type).unwrap(),
        Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]).unwrap(),
        Header::from_bytes(&b"X-Frame-Options"[..], &b"DENY"[..]).unwrap(),
    ];
    let data = bytes.to_vec();
    let resp = Response::new(
        StatusCode(200),
        headers,
        std::io::Cursor::new(data.clone()),
        Some(data.len()),
        None,
    );
    let _ = req.respond(resp);
}

fn compute_ws_accept(key: &str) -> String {
    let mut input = key.trim().as_bytes().to_vec();
    input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let digest = sha1_digest(&input);
    base64_encode(&digest)
}

fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}