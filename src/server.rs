    if path == "/api/health" && *req.method() == Method::Get {
        let s = state.lock().unwrap();
        let _ = send_json(
            req,
            200,
            &origin,
            Some(json!({
                "apiVersion": "1.0",
                "daemonVersion": "0.1.0",
                "hookActive": !s.settings.paused,
                "paused": s.settings.paused,
                "requiresPairing": s.tokens.is_empty(),
                "versionMismatch": false,
                "elevatedHint": false
            })),
        );
        return;
    }