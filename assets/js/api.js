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
  if (!p) return null;
  try { sessionStorage.setItem("mentions.port", String(p)); } catch {}
  return p;
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

export async function request(path, { method = "GET", body, timeout = 5000, auth = true } = {}) {
  const tok = tokenGet(location.origin);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException("timeout", "AbortError")), timeout);
  const headers = {};
  if (body != null) headers["content-type"] = "application/json";
  if (auth && tok) headers.authorization = `Bearer ${tok}`;
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

export async function probeHealth() {
  try {
    const data = await request("/api/health", { auth: true, timeout: 1500 });
    const nextState = derive(data);
    if (nextState === "unpaired" && data.requiresPairing) {
      tokenClear(location.origin);
    }
    const result = { ...data, state: nextState, lastCheckedAt: Date.now() };
    set("health", result);
    return result;
  } catch (err) {
    if (state.health?.state === "updating" && Date.now() < (state.health.updatingUntil || 0)) {
      return state.health;
    }
    const result = { state: "offline", code: err.code, lastCheckedAt: Date.now() };
    set("health", result);
    return result;
  }
}

export function healthLoop({ intervalMs = 5000, fastIntervalMs = 2000, onResult }) {
  let stopped = false;
  let timer = null;
  async function tick() {
    if (stopped) return;
    let nextDelay = intervalMs;
    try {
      const data = await request("/api/health", { auth: true, timeout: 1500 });
      const derived = derive(data);
      if (derived === "unpaired" && data.requiresPairing) {
        tokenClear(location.origin);
      }
      if (derived !== "online" && derived !== "paused") nextDelay = fastIntervalMs;
      onResult({ ...data, state: derived });
    } catch (err) {
      if (state.health?.state === "updating" && Date.now() < (state.health.updatingUntil || 0)) {
        nextDelay = 400;
      } else {
        nextDelay = fastIntervalMs;
        onResult({ state: "offline", code: err.code, lastCheckedAt: Date.now() });
      }
    } finally {
      if (!stopped && !document.hidden) timer = setTimeout(tick, nextDelay);
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
  const tok = tokenGet(location.origin);
  if (data.requiresPairing || !tok) return "unpaired";
  if (data.versionMismatch) return "version-mismatch";
  if (data.paused) return "paused";
  return "online";
}