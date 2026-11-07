import "./screens/commands.js";
import "./screens/editor.js";
import "./screens/settings.js";
import "./screens/pair.js";
import "./screens/notfound.js";

import { startRouter } from "./router.js";
import { healthLoop } from "./api.js";
import { state, set, on, tokenGet } from "./store.js";
import { connectWS, disconnectWS } from "./ws.js";
import { renderChip, renderBanner, clearBanners } from "./ui.js";
import { h } from "./dom.js";

const root = document.getElementById("main");
const hookToggle = document.getElementById("hook-toggle");

hookToggle.addEventListener("click", async () => {
  const paused = !!state.health?.paused;
  try {
    const mod = await import("./api.js");
    await mod.request(paused ? "/api/hook/resume" : "/api/hook/pause", { method: "POST" });
    set("health", { ...state.health, paused: !paused });
  } catch {}
});

on("state:health", ({ detail }) => {
  const hh = detail.value;
  renderChip(hh);
  refreshBanner(hh);
  hookToggle.hidden = !(hh?.state === "online" || hh?.state === "paused");
  hookToggle.textContent = hh?.paused ? "Resume" : "Pause";
  hookToggle.setAttribute("aria-pressed", hh?.paused ? "true" : "false");
  if (hh?.state === "online") connectWS();
  else disconnectWS();
});

function refreshBanner(hh) {
  clearBanners();
  if (!hh) return;
  if (hh.state === "offline") {
    renderBanner({
      tone: "danger",
      title: "Can't reach the daemon on 127.0.0.1",
      body: "Mentions may not be running. Commands are shown read-only until the daemon responds.",
      actions: [
        h("button", { class: "btn btn--quiet", type: "button", onClick: () => location.reload() }, "Retry"),
        h("a", { class: "btn btn--quiet", href: "/settings#diagnostics" }, "Why?"),
      ],
    });
  } else if (hh.state === "unpaired") {
    renderBanner({
      tone: "warning",
      title: "This browser isn't paired with the daemon yet.",
      actions: [h("a", { class: "btn btn--quiet", href: "/pair" }, "Pair now")],
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

if (!tokenGet(location.origin) && !location.pathname.startsWith("/pair")) {
  history.replaceState(null, "", "/pair" + location.search);
}

startRouter({ root });
set("health", { state: "connecting" });
renderChip({ state: "connecting" });
healthLoop({ onResult: (h) => set("health", { ...h, lastCheckedAt: Date.now() }) });