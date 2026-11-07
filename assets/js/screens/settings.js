import { h } from "../dom.js";
import { state, set, on as onState, tokenClear } from "../store.js";
import { request, ApiError } from "../api.js";
import { route } from "../router.js";
import { field, primaryButton, toast, confirmDialog } from "../ui.js";
import { announce, formatDate } from "../a11y.js";

const screen = {
  title: "Settings",
  async mount({ root }) {
    const container = h("section", { "aria-labelledby": "settings-h" });
    root.replaceChildren(container);

    let settings = null;
    let loadErr = null;
    try {
      settings = await request("/api/settings");
    } catch (err) {
      loadErr = err;
      settings = { port: 31415, terminator: "space", restoreClipboard: true, injectionFallback: "clipboard", autostart: false, statsEnabled: false };
    }

    const sections = [];
    let savedAt = {};

    function section(id, title, bodyFn) {
      const status = h("span", { class: "settings__status", role: "status" }, savedAt[id] ? `Saved ${formatDate(savedAt[id])}` : "");
      const body = bodyFn(status);
      sections.push(h("div", { class: "settings__section", id },
        h("header", { class: "settings__section-head" }, h("h2", { class: "t-headline" }, title), status),
        ...body
      ));
    }

    async function save(patch, sectionId, statusEl) {
      try {
        const result = await request("/api/settings", { method: "PATCH", body: patch });
        savedAt[sectionId] = new Date().toISOString();
        if (statusEl) statusEl.textContent = `Saved ${formatDate(savedAt[sectionId])}`;
        announce("Settings saved.");
        if (result?.restartRequired) toast({ message: "Restart the daemon for the port change to take effect." });
      } catch (err) {
        const msg = err instanceof ApiError && err.message ? err.message : "Couldn't save settings.";
        toast({ message: msg });
      }
    }

    section("connection", "Connection", (status) => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Daemon port"),
          h("span", { class: "t-caption" }, "Changing this requires restarting the daemon.")
        ),
        h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center" } },
          h("span", { class: "code-token" }, String(settings.port ?? 31415)),
          h("button", { class: "btn btn--quiet", type: "button", onClick: () => testConnection() }, "Test connection")
        )
      )
    ]);

    section("expansion", "Expansion", (status) => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Terminator"),
          h("span", { class: "t-caption" }, "Which key completes a trigger after typing it.")
        ),
        h("div", { class: "segmented", role: "radiogroup", "aria-label": "Terminator" },
          ...["space", "enter", "tab"].map((v) =>
            h("label", null,
              h("input", {
                type: "radio", name: "terminator", value: v, checked: settings.terminator === v,
                onchange: () => { settings.terminator = v; save({ terminator: v }, "expansion", status); },
              }),
              h("span", null, v[0].toUpperCase() + v.slice(1))
            )
          )
        )
      ),
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Restore clipboard after paste"),
          h("span", { class: "t-caption" }, "Puts your previous clipboard content back after expanding.")
        ),
        h("label", { class: "switch" },
          h("input", { type: "checkbox", checked: settings.restoreClipboard, onchange: (e) => { settings.restoreClipboard = e.target.checked; save({ restoreClipboard: e.target.checked }, "expansion", status); } }),
          h("span", { class: "switch__track" }),
          h("span", { class: "t-caption" }, settings.restoreClipboard ? "On" : "Off")
        )
      )
    ]);

    section("startup", "Startup", (status) => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Launch Mentions when I sign in"),
          h("span", { class: "t-caption" }, "Starts the daemon at login so expansions always work.")
        ),
        h("label", { class: "switch" },
          h("input", { type: "checkbox", checked: settings.autostart, onchange: (e) => { settings.autostart = e.target.checked; save({ autostart: e.target.checked }, "startup", status); } }),
          h("span", { class: "switch__track" }),
          h("span", { class: "t-caption" }, settings.autostart ? "On" : "Off")
        )
      )
    ]);

    section("privacy", "Privacy", (status) => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Show match counts"),
          h("span", { class: "t-caption" }, "Off by default. Counts are local and never uploaded.")
        ),
        h("label", { class: "switch" },
          h("input", { type: "checkbox", checked: settings.statsEnabled, onchange: (e) => { settings.statsEnabled = e.target.checked; save({ statsEnabled: e.target.checked }, "privacy", status); } }),
          h("span", { class: "switch__track" }),
          h("span", { class: "t-caption" }, settings.statsEnabled ? "On" : "Off")
        )
      ),
      h("p", { class: "t-caption" },
        "Commands are stored on this machine at ",
        h("span", { class: "code-token" }, "%APPDATA%\\Mentions\\commands.json"),
        ". Nothing is uploaded."
      )
    ]);

    section("data", "Data", () => [
      h("div", { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
        h("button", { class: "btn", type: "button", onClick: exportJSON }, "Export commands"),
        h("button", { class: "btn", type: "button", onClick: () => document.getElementById("import-file")?.click() }, "Import commands"),
        h("input", { id: "import-file", type: "file", accept: "application/json", hidden: true, onchange: onImport })
      )
    ]);

    section("pairing", "Paired browsers", () => [
      h("p", { class: "t-body" }, "This browser is paired. To un-pair, use the Mentions tray menu or revoke all below."),
      h("button", { class: "btn btn--quiet", type: "button", onClick: revokeAll }, "Revoke all browsers")
    ]);

    section("diagnostics", "Diagnostics", () => [
      h("dl", { style: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--space-2) var(--space-4)", fontSize: "var(--fs-label)" } },
        dt("Daemon version"), dd(state.health?.daemonVersion || "—"),
        dt("API version"), dd(state.health?.apiVersion || "—"),
        dt("Hook active"), dd(state.health?.hookActive ? "Yes" : "No"),
        dt("State"), dd(state.health?.state || "—"),
      ),
      h("button", { class: "btn btn--quiet", type: "button", onClick: copyDiagnostics }, "Copy diagnostics")
    ]);

    container.replaceChildren(
      h("h1", { id: "settings-h", class: "t-title", style: { marginBottom: "var(--space-4)" } }, "Settings"),
      ...sections
    );

    if (loadErr) {
      toast({ message: "Showing default settings — daemon is unreachable." });
    }

    async function testConnection() {
      try {
        await request("/api/health", { auth: false, timeout: 1500 });
        toast({ message: "Daemon responded." });
      } catch { toast({ message: "Daemon didn't respond." }); }
    }

    async function exportJSON() {
      try {
        const data = await request("/api/commands/export");
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: `mentions-${Date.now()}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch { toast({ message: "Couldn't export commands." }); }
    }

    async function onImport(e) {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const bundle = JSON.parse(text);
        await request("/api/commands/import", { method: "POST", body: bundle });
        toast({ message: "Commands imported." });
        announce("Commands imported.");
      } catch { toast({ message: "Import failed — file didn't validate." }); }
    }

    function revokeAll() {
      confirmDialog({
        title: "Revoke all paired browsers?",
        body: "You'll need to pair again from this browser using the tray code.",
        confirmLabel: "Revoke all",
        danger: true,
        onConfirm: async () => {
          try { await request("/api/pair/revoke-all", { method: "POST" }); } catch {}
          tokenClear(location.origin);
          location.href = "/pair";
        },
      });
    }

    async function copyDiagnostics() {
      const text = JSON.stringify({ health: state.health, settings }, null, 2);
      try { await navigator.clipboard.writeText(text); toast({ message: "Diagnostics copied." }); } catch { toast({ message: "Couldn't copy." }); }
    }

    function dt(t) { return h("dt", { style: { color: "var(--on-surface-variant)" } }, t); }
    function dd(v) { return h("dd", { style: { fontFamily: "var(--font-mono)" } }, String(v)); }

    return { title: "Settings", unmount() {} };
  },
};

route("/settings", screen);

export default screen;