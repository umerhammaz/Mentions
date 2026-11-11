  if (p === "/api/health") return send(res, 200, {
    apiVersion: "1.0", daemonVersion: "0.1.0", hookActive: !state.paused, paused: state.paused,
    requiresPairing: false, versionMismatch: false, elevatedHint: false,
  });