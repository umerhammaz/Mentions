import { request, getPort } from "./api.js";
import { state, set, emit, tokenGet } from "./store.js";

let ws = null;
let stopped = false;
let attempt = 0;
let timer = null;
let reloadTimer = null;
let reloadInFlight = false;

async function syncCommands() {
  if (reloadInFlight) return;
  reloadInFlight = true;
  try {
    const list = await request("/api/commands");
    set("commands", list?.commands || []);
    emit("commands:changed");
  } catch {} finally {
    reloadInFlight = false;
  }
}

export function connectWS() {
  stopped = false;
  clearTimeout(timer);
  timer = null;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const h = state.health;
  if (!h || (h.state !== "online" && h.state !== "paused")) return;
  const tok = tokenGet(location.origin);
  const url = new URL("/ws", getBaseWS());
  if (tok) url.searchParams.set("token", tok);
  try { ws = new WebSocket(url.toString()); } catch { ws = null; return; }
  ws.addEventListener("open", () => { attempt = 0; });
  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "commands.changed") {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(syncCommands, 120);
    } else if (msg.type === "hook.state") {
      const paused = !!msg.paused;
      set("health", {
        ...state.health,
        paused,
        state: paused ? "paused" : "online",
      });
    } else if (msg.type === "daemon.stopping") {
      emit("daemon:stopping");
    }
  });
  ws.addEventListener("close", () => {
    ws = null;
    if (stopped) return;
    attempt++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 500;
    timer = setTimeout(connectWS, delay);
  });
  ws.addEventListener("error", () => { try { ws?.close(); } catch {} });
}

export function disconnectWS() {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(reloadTimer);
  timer = null;
  try { ws?.close(); } catch {}
  ws = null;
}

export function getBaseWS() {
  return `ws://127.0.0.1:${getPort()}`;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !stopped && !ws) {
    attempt = 0;
    connectWS();
  }
});