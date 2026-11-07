import { request } from "./api.js";
import { state, set, emit } from "./store.js";

let ws = null;
let stopped = false;
let attempt = 0;
let timer = null;

export function connectWS() {
  if (ws || stopped) return;
  const h = state.health;
  if (!h || h.state !== "online") return;
  const url = new URL("/ws", getBaseWS());
  try { ws = new WebSocket(url); } catch { return; }
  ws.addEventListener("open", () => { attempt = 0; });
  ws.addEventListener("message", async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "commands.changed") {
      try {
        const list = await request("/api/commands");
        set("commands", list.commands || []);
        emit("commands:changed");
      } catch {}
    } else if (msg.type === "hook.state") {
      set("health", { ...state.health, paused: !!msg.paused });
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
  try { ws?.close(); } catch {}
  ws = null;
}

function getBaseWS() {
  let port = 31415;
  try { port = sessionStorage.getItem("mentions.port") || 31415; } catch {}
  return `http://127.0.0.1:${port}`;
}