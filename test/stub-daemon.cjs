const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 31415);
const ORIGIN = process.env.ORIGIN || "*";
const TOKEN = "stub-token-" + randomUUID().slice(0, 8);
const PAIR_CODE = "ABCDEF";
const startedAt = new Date().toISOString();

let state = {
  port: PORT,
  terminator: "space",
  restoreClipboard: true,
  injectionFallback: "clipboard",
  autostart: false,
  statsEnabled: false,
  paused: false,
};

let commands = [
  { id: randomUUID(), trigger: "@sig", text: "Best regards,\nAyesha Khan · Product", enabled: true, createdAt: startedAt, updatedAt: startedAt },
  { id: randomUUID(), trigger: "@thanks", text: "Thanks for the quick reply — I'll take a look this afternoon.", enabled: true, createdAt: startedAt, updatedAt: startedAt },
];

function send(res, status, body) {
  const isJson = body !== undefined;
  res.writeHead(status, {
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-private-network": "true",
    ...(isJson ? { "content-type": "application/json" } : {}),
  });
  res.end(isJson ? JSON.stringify(body) : "");
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); } });
  });
}

function auth(req) {
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (p === "/api/health") return send(res, 200, {
    apiVersion: "1.0", daemonVersion: "0.1.0", hookActive: !state.paused, paused: state.paused,
    requiresPairing: !auth(req), versionMismatch: false, elevatedHint: false,
  });

  if (p === "/api/pair" && req.method === "POST") {
    const body = await readBody(req);
    if (body?.code?.toUpperCase() !== PAIR_CODE) return send(res, 401, { code: "E_UNAUTHORIZED", message: "Code mismatch" });
    return send(res, 200, { token: TOKEN });
  }

  if (!auth(req)) return send(res, 401, { code: "E_UNAUTHORIZED" });

  if (p === "/api/commands" && req.method === "GET") return send(res, 200, { commands });
  if (p === "/api/commands" && req.method === "POST") {
    const body = await readBody(req);
    if (!body?.trigger || !body?.text) return send(res, 422, { code: "E_VALIDATION", field: !body?.trigger ? "trigger" : "text", message: "Required" });
    if (commands.some((c) => c.trigger.toLowerCase() === body.trigger.toLowerCase())) return send(res, 409, { code: "E_CONFLICT", field: "trigger", message: "Trigger already used" });
    const cmd = { id: randomUUID(), trigger: body.trigger, text: body.text, enabled: body.enabled !== false, group: body.group, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    commands.push(cmd);
    return send(res, 201, cmd);
  }
  const m = p.match(/^\/api\/commands\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const idx = commands.findIndex((c) => c.id === id);
    if (idx === -1) return send(res, 404, { code: "E_NOT_FOUND" });
    if (req.method === "GET") return send(res, 200, commands[idx]);
    if (req.method === "PATCH") {
      const body = await readBody(req) || {};
      if (body.trigger && commands.some((c, i) => i !== idx && c.trigger.toLowerCase() === body.trigger.toLowerCase())) return send(res, 409, { code: "E_CONFLICT", field: "trigger", message: "Trigger already used" });
      commands[idx] = { ...commands[idx], ...body, id, updatedAt: new Date().toISOString() };
      return send(res, 200, commands[idx]);
    }
    if (req.method === "DELETE") { commands.splice(idx, 1); return send(res, 204); }
  }
  if (p === "/api/commands/export") return send(res, 200, { schemaVersion: 1, exportedAt: new Date().toISOString(), commands, settings: state });
  if (p === "/api/commands/import" && req.method === "POST") {
    const body = await readBody(req);
    if (!Array.isArray(body?.commands)) return send(res, 422, { code: "E_VALIDATION", message: "Missing commands array" });
    commands = body.commands.map((c) => ({ id: randomUUID(), ...c, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    return send(res, 200, { imported: commands.length });
  }
  if (p === "/api/settings" && req.method === "GET") return send(res, 200, state);
  if (p === "/api/settings" && req.method === "PATCH") {
    const body = await readBody(req) || {};
    const restartRequired = body.port && body.port !== state.port;
    state = { ...state, ...body };
    return send(res, 200, { ...state, restartRequired });
  }
  if (p === "/api/hook/pause" && req.method === "POST") { state.paused = true; return send(res, 200, { paused: true }); }
  if (p === "/api/hook/resume" && req.method === "POST") { state.paused = false; return send(res, 200, { paused: false }); }
  if (p === "/api/pair/revoke-all" && req.method === "POST") return send(res, 204);

  send(res, 404, { code: "E_NOT_FOUND" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub-daemon on http://127.0.0.1:${PORT}`);
  console.log(`pair code: ${PAIR_CODE}`);
  console.log(`token:     ${TOKEN}`);
});