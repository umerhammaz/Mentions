import { tokenGet, tokenClear, state, set } from "./store.js";

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
  return validPort(override) || 31415;
}

export function getBase() {
  return `http://127.0.0.1:${getPort()}`;
}

export async function request(path, { method = "GET", body, timeout = 5000, auth = true } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException("timeout", "AbortError")), timeout);
  const headers = {};
  if (body != null) headers["content-type"] = "application/json";
  if (auth) {
    const tok = tokenGet(location.origin);
    if (tok) headers.authorization = `Bearer ${tok}`;
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
      const code = data?.code || STATUS_MAP[res.status] || `E_HTTP_${res.status}`;
      if (res.status === 401 && auth) {
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
      const data = await request("/api/health", { auth: false, timeout: 1500 });
      onResult({ ...data, state: derive(data) });
    } catch (err) {
      onResult({ state: "offline", code: err.code, lastCheckedAt: Date.now() });
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
  if (data.requiresPairing) return "unpaired";
  if (data.paused) return "paused";
  if (data.versionMismatch) return "version-mismatch";
  return "online";
}