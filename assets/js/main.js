import "./screens/commands.js";
import "./screens/editor.js";
import "./screens/settings.js";
import "./screens/pair.js";
import "./screens/notfound.js";

import { startRouter } from "./router.js";
import { healthLoop, request, DEMO_TOKEN } from "./api.js";
import { state, set, on, tokenGet, tokenSet } from "./store.js";
import { connectWS, disconnectWS } from "./ws.js";
import { renderChip, renderBanner, clearBanners } from "./ui.js";
import { h } from "./dom.js";
import { announce } from "./a11y.js";

const root = document.getElementById("main");
const hookToggle = document.getElementById("hook-toggle");
const downloadBtn = document.getElementById("download-app");

hookToggle.addEventListener("click", async () => {
  const paused = !!state.health?.paused;
  try {
    await request(paused ? "/api/hook/resume" : "/api/hook/pause", { method: "POST" });
    set("health", { ...state.health, paused: !paused, state: state.health?.state === "demo" ? "demo" : (!paused ? "paused" : "online") });
  } catch {}
});

export function activateDemoMode() {
  tokenSet(location.origin, DEMO_TOKEN);
  if (state.commands.length === 0) {
    const now = new Date().toISOString();
    set("commands", [
      { id: "demo-1", trigger: "@sig", text: "Best regards,\nAyesha Khan · Product", enabled: true, createdAt: now, updatedAt: now },
      { id: "demo-2", trigger: "@thanks", text: "Thanks for the quick reply — I'll take a look this afternoon.", enabled: true, createdAt: now, updatedAt: now },
    ]);
  }
  set("health", {
    apiVersion: "1.0",
    daemonVersion: "demo",
    hookActive: false,
    paused: false,
    requiresPairing: false,
    versionMismatch: false,
    demo: true,
    state: "demo",
    lastCheckedAt: Date.now(),
  });
  announce("Switched to browser mode.");
}

let lastUiSig = "";

on("state:health", ({ detail }) => {
  const hh = detail.value;
  const sig = `${hh?.state || ""}:${Boolean(hh?.paused)}`;
  if (sig === lastUiSig) return;
  lastUiSig = sig;

  renderChip(hh);
  refreshBanner(hh);
  const isConnected = hh?.state === "online" || hh?.state === "paused";
  hookToggle.hidden = !isConnected;
  if (downloadBtn) downloadBtn.hidden = isConnected;
  hookToggle.textContent = hh?.paused ? "Resume" : "Pause";
  hookToggle.setAttribute("aria-pressed", hh?.paused ? "true" : "false");
  if (isConnected) connectWS();
  else if (hh?.state !== "connecting") disconnectWS();
});

function refreshBanner(hh) {
  clearBanners();
  if (!hh) return;
  if (hh.state === "offline") {
    renderBanner({
      tone: "danger",
      title: "Can't reach the daemon on 127.0.0.1",
      body: "Mentions may not be running. Switch to browser mode to create, edit, and test commands locally, or start the Windows daemon.",
      actions: [
        h("button", { class: "btn btn--primary", type: "button", onClick: activateDemoMode }, "Use browser editor"),
        h("button", { class: "btn btn--quiet", type: "button", onClick: () => location.reload() }, "Retry"),
        h("a", {
          class: "btn btn--quiet",
          href: "https://github.com/umerhammaz/Mentions/releases/latest/download/mentions-daemon.exe",
          target: "_blank",
          rel: "noopener",
        }, "Download for Windows"),
        h("a", { class: "btn btn--quiet", href: "/settings#diagnostics" }, "Why?"),
      ],
    });
  } else if (hh.state === "demo") {
    renderBanner({
      tone: "info",
      title: "Browser mode",
      body: "Prompts saved locally. Run and pair daemon to expand across Windows apps.",
      actions: [
        h("a", { class: "btn btn--primary", href: "/pair" }, "Pair app"),
        h("a", {
          class: "btn btn--quiet",
          href: "https://github.com/umerhammaz/Mentions/releases/latest/download/mentions-daemon.exe",
          target: "_blank",
          rel: "noopener",
        }, "Download"),
      ],
    });
  } else if (hh.state === "unpaired") {
    renderBanner({
      tone: "warning",
      title: "This browser isn't paired with the daemon yet.",
      actions: [
        h("a", { class: "btn btn--primary", href: "/pair" }, "Pair now"),
        h("button", { class: "btn btn--quiet", type: "button", onClick: activateDemoMode }, "Use browser editor"),
      ],
    });
  } else if (hh.state === "paused") {
    renderBanner({
      tone: "warning",
      title: "Expansion is paused. @commands will not expand.",
      actions: [h("button", { class: "btn btn--quiet", type: "button", onClick: () => hookToggle.click() }, "Resume")],
    });
  } else if (hh.state === "version-mismatch") {
    renderBanner({
      tone: "danger",
      title: "Update the daemon to edit commands.",
      body: "Daemon and controller versions disagree.",
    });
  }
}

const hasCodeParam = new URLSearchParams(location.search).has("code");
if (hasCodeParam && !location.pathname.startsWith("/pair")) {
  history.replaceState(null, "", "/pair" + location.search);
} else if (!tokenGet(location.origin) && !location.pathname.startsWith("/pair")) {
  tokenSet(location.origin, DEMO_TOKEN);
}

startRouter({ root });
const initialState = tokenGet(location.origin) === DEMO_TOKEN ? "demo" : "connecting";
set("health", { state: initialState });
healthLoop({ onResult: (res) => set("health", { ...res, lastCheckedAt: Date.now() }) });