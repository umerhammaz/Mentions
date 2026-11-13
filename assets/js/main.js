import "./screens/commands.js";
import "./screens/editor.js";
import "./screens/settings.js";
import "./screens/pair.js";
import "./screens/notfound.js";

import { startRouter, navigate } from "./router.js";
import { healthLoop, request } from "./api.js";
import { state, set, on } from "./store.js";
import { connectWS, disconnectWS } from "./ws.js";
import { renderChip, renderBanner, clearBanners, toast } from "./ui.js";
import { h } from "./dom.js";
import gateScreen from "./screens/pair.js";

const root = document.getElementById("main");
const hookToggle = document.getElementById("hook-toggle");
const railVersion = document.getElementById("rail-version");

const params = new URLSearchParams(location.search);
const codeParam = params.get("code");
if (codeParam) {
  const cleaned = String(codeParam).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  if (cleaned) {
    try { sessionStorage.setItem("mentions.pendingCode", cleaned); } catch {}
  }
  history.replaceState(null, "", "/pair");
}

let intendedPath = null;
if (location.pathname !== "/pair") {
  intendedPath = location.pathname + location.search + location.hash;
}

function isUnlocked(hh = state.health) {
  const s = hh?.state;
  return s === "online" || s === "paused" || s === "updating";
}

hookToggle.addEventListener("click", async () => {
  const paused = !!state.health?.paused;
  try {
    await request(paused ? "/api/hook/resume" : "/api/hook/pause", { method: "POST" });
    set("health", { ...state.health, paused: !paused, state: !paused ? "paused" : "online" });
  } catch {}
});

const renderRoute = startRouter({
  root,
  guard: (path) => {
    if (!isUnlocked()) {
      if (path !== "/pair") intendedPath = location.pathname + location.search + location.hash;
      return gateScreen;
    }
    return null;
  },
});

let lastUnlocked = false;
let lastUiSig = "";
let lastShownUpdateVer = "";

on("state:health", async ({ detail }) => {
  const hh = detail.value;
  const unlocked = isUnlocked(hh);
  const sig = `${hh?.state || ""}:${Boolean(hh?.paused)}:${hh?.daemonVersion || ""}:${hh?.update?.availableVersion || ""}`;

  document.body.classList.toggle("is-locked", !unlocked);

  if (!unlocked && lastUnlocked && state.ui?.dirty) {
    const editorArea = document.getElementById("text");
    if (editorArea?.value) {
      set("ui", { ...state.ui, unsavedRescue: editorArea.value });
    }
  }

  if (sig !== lastUiSig) {
    lastUiSig = sig;
    renderChip(hh);
    refreshBanner(hh);
    hookToggle.hidden = !unlocked;
    hookToggle.textContent = hh?.paused ? "Resume" : "Pause";
    hookToggle.setAttribute("aria-pressed", hh?.paused ? "true" : "false");
    if (railVersion) {
      railVersion.textContent = unlocked && hh?.daemonVersion ? `Daemon v${hh.daemonVersion}` : "";
    }
    if (hh?.state === "online" || hh?.state === "paused") {
      connectWS();
    } else if (hh?.state !== "connecting" && hh?.state !== "updating") {
      disconnectWS();
    }
    const updFrom = hh?.update?.justUpdatedFrom;
    if ((hh?.state === "online" || hh?.state === "paused") && updFrom && hh?.daemonVersion && lastShownUpdateVer !== hh.daemonVersion) {
      lastShownUpdateVer = hh.daemonVersion;
      toast({ message: `Updated Mentions to v${hh.daemonVersion}.` });
    }
  }

  if (unlocked && !lastUnlocked) {
    lastUnlocked = true;
    try {
      const s = await request("/api/settings");
      if (s) set("settings", s);
    } catch {}
    if (location.pathname === "/pair") {
      const nextPath = intendedPath && intendedPath !== "/pair" ? intendedPath : "/";
      intendedPath = null;
      navigate(nextPath);
    } else {
      renderRoute();
    }
  } else if (!unlocked && lastUnlocked) {
    lastUnlocked = false;
    renderRoute();
  } else if (!unlocked) {
    gateScreen.update?.(hh);
  }
});

function refreshBanner(hh) {
  clearBanners();
  if (!hh) return;
  if (hh.state === "updating") {
    renderBanner({
      tone: "info",
      title: hh.updatingTo ? `Updating Mentions to v${hh.updatingTo}...` : "Updating Mentions...",
      body: "Reconnecting automatically in a moment.",
    });
  } else if (hh.state === "paused") {
    renderBanner({
      tone: "warning",
      title: "Expansion is paused",
      body: "Your @commands will not expand until you resume.",
      actions: [h("button", { class: "btn btn--sm btn--primary", type: "button", onClick: () => hookToggle.click() }, "Resume")],
    });
  }
}

set("health", { state: "connecting" });
healthLoop({ onResult: (res) => set("health", { ...res, lastCheckedAt: Date.now() }) });