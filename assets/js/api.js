import { tokenGet, tokenClear, state, set, emit } from "./store.js";

export const DEMO_TOKEN = "demo-offline-token";
const SETTINGS_KEY = "mentions.settings.v1";
const TRIGGER_RE = /^@[a-z0-9_-]{1,31}$/;

export class ApiError extends Error {
  constructor(code, status, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const STATUS_MAP = {
  401: "E_UNAUTHORIZED",
  409: "E_CONFLICT",
  422: "E_VALIDATION",
  429: "E_RATE_LIMITED",
  500: "E_INTERNAL",
};

function validPort(val) {
  const n = Number(val);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

const urlPort = validPort(new URLSearchParams(location.search).get("port"));
if (urlPort) setPort(urlPort);

export function setPort(port) {
  const p = validPort(port);
  if (!p) return;
  try { sessionStorage.setItem("mentions.port", String(p)); } catch {}
}

export function getPort() {
  let override = null;
  try { override = sessionStorage.getItem("mentions.port"); } catch {}
  if (validPort(override)) return validPort(override);
  if (location.hostname === "127.0.0.1" && validPort(location.port)) return validPort(location.port);
  return 31415;
}

export function getBase() {
  return `http://127.0.0.1:${getPort()}`;
}

export function isDemoMode() {
  return tokenGet(location.origin) === DEMO_TOKEN;
}

function loadLocalSettings() {
  const fallback = {
    port: getPort(),
    terminator: "space",
    restoreClipboard: true,
    injectionFallback: "clipboard",
    autostart: false,
    statsEnabled: false,
    paused: false,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function saveLocalSettings(next) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  set("settings", next);
}

function handleLocalDemoRequest(path, { method = "GET", body } = {}) {
  const now = new Date().toISOString();
  if (path === "/api/health" && method === "GET") {
    const s = state.settings || loadLocalSettings();
    return {
      apiVersion: "1.0",
      daemonVersion: "demo",
      hookActive: false,
      paused: !!s.paused,
      requiresPairing: false,
      versionMismatch: false,
      elevatedHint: false,
      demo: true,
    };
  }
  if (path === "/api/commands" && method === "GET") {
    return { commands: state.commands || [] };
  }
  if (path === "/api/commands" && method === "POST") {
    const trigger = String(body?.trigger || "").trim();
    const text = String(body?.text || "");
    const enabled = body?.enabled !== false;
    const group = body?.group ? String(body.group).trim() : undefined;
    if (!TRIGGER_RE.test(trigger)) {
      throw new ApiError("E_VALIDATION", 422, { field: "trigger", message: "Invalid trigger format" });
    }
    if (!text || text.length > 65536) {
      throw new ApiError("E_VALIDATION", 422, { field: "text", message: "Text is required and must be within limit" });
    }
    if (state.commands.some((c) => c.trigger.toLowerCase() === trigger.toLowerCase())) {
      throw new ApiError("E_CONFLICT", 409, { field: "trigger", message: "Trigger already used" });
    }
    const item = {
      id: `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      trigger,
      text,
      enabled,
      ...(group ? { group } : {}),
      createdAt: now,
      updatedAt: now,
    };
    set("commands", [...state.commands, item]);
    emit("commands:changed");
    return item;
  }
  if (path === "/api/commands/export" && method === "GET") {
    return {
      schemaVersion: 1,
      exportedAt: now,
      commands: state.commands || [],
      settings: state.settings || loadLocalSettings(),
    };
  }
  if (path === "/api/commands/import" && method === "POST") {
    if (!Array.isArray(body?.commands)) {
      throw new ApiError("E_VALIDATION", 422, { message: "Missing commands array" });
    }
    const imported = [];
    for (const item of body.commands) {
      const trig = String(item?.trigger || "").trim();
      const txt = String(item?.text || "");
      if (!TRIGGER_RE.test(trig) || !txt || txt.length > 65536) continue;
      if (imported.some((c) => c.trigger.toLowerCase() === trig.toLowerCase())) continue;
      const grp = item?.group ? String(item.group).trim() : "";
      imported.push({
        id: `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        trigger: trig,
        text: txt,
        enabled: item?.enabled !== false,
        ...(grp ? { group: grp } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    set("commands", imported);
    emit("commands:changed");
    return { imported: imported.length };
  }
  const cmdMatch = path.match(/^\/api\/commands\/([^/]+)$/);
  if (cmdMatch) {
    const id = decodeURIComponent(cmdMatch[1]);
    const idx = state.commands.findIndex((c) => c.id === id);
    if (idx === -1) throw new ApiError("E_NOT_FOUND", 404);
    if (method === "GET") return state.commands[idx];
    if (method === "PATCH") {
      const current = { ...state.commands[idx] };
      if (body?.trigger !== undefined) {
        const trimmed = String(body.trigger).trim();
        if (!TRIGGER_RE.test(trimmed)) {
          throw new ApiError("E_VALIDATION", 422, { field: "trigger", message: "Invalid trigger" });
        }
        if (state.commands.some((c, i) => i !== idx && c.trigger.toLowerCase() === trimmed.toLowerCase())) {
          throw new ApiError("E_CONFLICT", 409, { field: "trigger", message: "Trigger already used" });
        }
        current.trigger = trimmed;
      }
      if (body?.text !== undefined) {
        const txt = String(body.text);
        if (!txt || txt.length > 65536) {
          throw new ApiError("E_VALIDATION", 422, { field: "text", message: "Invalid text" });
        }
        current.text = txt;
      }
      if (typeof body?.enabled === "boolean") current.enabled = body.enabled;
      if (body?.group !== undefined) {
        const grp = String(body.group || "").trim();
        if (grp) current.group = grp;
        else delete current.group;
      }
      current.updatedAt = now;
      const next = state.commands.slice();
      next[idx] = current;
      set("commands", next);
      emit("commands:changed");
      return current;
    }
    if (method === "DELETE") {
      set("commands", state.commands.filter((c) => c.id !== id));
      emit("commands:changed");
      return null;
    }
  }
  if (path === "/api/settings" && method === "GET") {
    const s = state.settings || loadLocalSettings();
    set("settings", s);
    return s;
  }
  if (path === "/api/settings" && method === "PATCH") {
    const current = state.settings || loadLocalSettings();
    const restartRequired = Boolean(body?.port && body.port !== current.port);
    const next = { ...current, ...body };
    saveLocalSettings(next);
    return { ...next, restartRequired };
  }
  if (path === "/api/hook/pause" && method === "POST") {
    const next = { ...(state.settings || loadLocalSettings()), paused: true };
    saveLocalSettings(next);
    return { paused: true };
  }
  if (path === "/api/hook/resume" && method === "POST") {
    const next = { ...(state.settings || loadLocalSettings()), paused: false };
    saveLocalSettings(next);
    return { paused: false };
  }
  if (path === "/api/pair/revoke-all" && method === "POST") {
    return null;
  }
  throw new ApiError("E_OFFLINE", 0);
}

export async function request(path, { method = "GET", body, timeout = 5000, auth = true, allowDemo = true } = {}) {
  const tok = tokenGet(location.origin);
  const demo = tok === DEMO_TOKEN;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException("timeout", "AbortError")), timeout);
  const headers = {};
  if (body != null) headers["content-type"] = "application/json";
  if (auth && tok && !demo) {
    headers.authorization = `Bearer ${tok}`;
  }
  try {
    const res = await fetch(getBase() + path, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: "omit",
    });
    clearTimeout(t);
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? safeJSON(text) : null;
    if (!res.ok) {
      if (demo && allowDemo && res.status === 401 && path !== "/api/pair") {
        return handleLocalDemoRequest(path, { method, body });
      }
      const code = data?.code || STATUS_MAP[res.status] || `E_HTTP_${res.status}`;
      if (res.status === 401 && auth && !demo) {
        tokenClear(location.origin);
        set("health", { ...(state.health || {}), state: "unpaired", requiresPairing: true });
      }
      throw new ApiError(code, res.status, {
        field: data?.field,
        message: data?.message,
        retryAfter: data?.retryAfter,
        detail: data,
      });
    }
    return data;
  } catch (err) {
    clearTimeout(t);
    if (err instanceof ApiError) throw err;
    if (demo && allowDemo && path !== "/api/pair") {
      return handleLocalDemoRequest(path, { method, body });
    }
    if (err?.name === "AbortError") throw new ApiError("E_OFFLINE", 0, { cause: "timeout" });
    throw new ApiError("E_OFFLINE", 0, { cause: err });
  }
}

function safeJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function healthLoop({ intervalMs = 5000, onResult }) {
  let stopped = false;
  let timer = null;
  async function tick() {
    if (stopped) return;
    try {
      const data = await request("/api/health", { auth: true, timeout: 1500, allowDemo: false });
      onResult({ ...data, state: derive(data) });
    } catch (err) {
      if (isDemoMode()) {
        const demoHealth = handleLocalDemoRequest("/api/health", { method: "GET" });
        onResult({ ...demoHealth, state: "demo", lastCheckedAt: Date.now() });
      } else {
        onResult({ state: "offline", code: err.code, lastCheckedAt: Date.now() });
      }
    } finally {
      if (!stopped && !document.hidden) timer = setTimeout(tick, intervalMs);
    }
  }
  const onVis = () => {
    if (!document.hidden && !stopped) { clearTimeout(timer); tick(); }
  };
  document.addEventListener("visibilitychange", onVis);
  tick();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
}

function derive(data) {
  if (!data) return "unknown";
  if (isDemoMode()) return "demo";
  const tok = tokenGet(location.origin);
  if (data.requiresPairing || !tok) return "unpaired";
  if (data.paused) return "paused";
  if (data.versionMismatch) return "version-mismatch";
  return "online";
}