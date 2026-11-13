import { h } from "../dom.js";
import { state, set, tokenClear } from "../store.js";
import { request, ApiError, getPort, setPort, probeHealth } from "../api.js";
import { route } from "../router.js";
import { toast, confirmDialog } from "../ui.js";
import { announce, formatDate } from "../a11y.js";

const DOWNLOAD_URL = "https://github.com/umerhammaz/Mentions/releases/latest/download/mentions-daemon.exe";

const screen = {
  title: "Settings",
  async mount({ root }) {
    const container = h("section", { class: "settings", "aria-labelledby": "settings-h" });
    root.replaceChildren(container);

    let settings = null;
    let loadErr = null;
    try {
      settings = await request("/api/settings");
      if (settings) set("settings", settings);
    } catch (err) {
      loadErr = err;
      settings = state.settings || {
        port: getPort(),
        terminator: "space",
        restoreClipboard: true,
        injectionFallback: "clipboard",
        autostart: false,
        statsEnabled: false,
      };
    }

    const cards = [];
    const savedAt = {};

    function card(id, title, bodyFn) {
      const status = h("span", { class: "settings__status", role: "status" }, savedAt[id] ? `Saved ${formatDate(savedAt[id])}` : "");
      const body = bodyFn(status);
      cards.push(
        h("div", { class: "settings__card", id },
          h("header", { class: "settings__section-head" },
            h("h2", { class: "t-title" }, title),
            status
          ),
          ...body
        )
      );
    }

    async function save(patch, sectionId, statusEl) {
      try {
        const result = await request("/api/settings", { method: "PATCH", body: patch });
        if (result) set("settings", result);
        savedAt[sectionId] = new Date().toISOString();
        if (statusEl) statusEl.textContent = "Saved";
        announce("Settings saved.");
        return result;
      } catch (err) {
        const msg = err instanceof ApiError && err.message ? err.message : "Couldn't save settings.";
        toast({ message: msg });
        return null;
      }
    }

    function toggleSwitch(initialChecked, onToggle) {
      const stateLabel = h("span", { class: "t-caption" }, initialChecked ? "On" : "Off");
      return h("label", { class: "switch" },
        h("input", {
          type: "checkbox",
          checked: Boolean(initialChecked),
          onchange: (e) => {
            const checked = e.target.checked;
            stateLabel.textContent = checked ? "On" : "Off";
            onToggle(checked);
          },
        }),
        h("span", { class: "switch__track" }),
        stateLabel
      );
    }

    const currentPort = Number(settings.port ?? getPort());
    const portInput = h("input", {
      class: "input settings__port-input",
      type: "number",
      min: "1024",
      max: "65535",
      value: String(currentPort),
      "aria-label": "Daemon port",
    });
    const applyPortBtn = h("button", {
      class: "btn btn--sm btn--primary",
      type: "button",
      hidden: true,
      onClick: async () => {
        const nextPort = Number(portInput.value);
        if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
          toast({ message: "Port must be between 1024 and 65535." });
          return;
        }
        applyPortBtn.disabled = true;
        applyPortBtn.textContent = "Restarting...";
        const res = await save({ port: nextPort }, "connection");
        if (res?.restartRequired) {
          setPort(nextPort);
          toast({ message: `Switching to port ${nextPort}...` });
          setTimeout(() => probeHealth(), 900);
        }
        applyPortBtn.disabled = false;
        applyPortBtn.textContent = "Apply & restart";
        applyPortBtn.hidden = true;
      },
    }, "Apply & restart");

    portInput.addEventListener("input", () => {
      const n = Number(portInput.value);
      applyPortBtn.hidden = !Number.isInteger(n) || n === currentPort;
    });

    card("connection", "Connection", () => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Daemon port"),
          h("span", { class: "t-caption" }, "Changing this restarts the Windows app on the new port.")
        ),
        h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } },
          portInput,
          applyPortBtn,
          h("button", { class: "btn btn--sm", type: "button", onClick: testConnection }, "Test connection"),
          h("button", { class: "btn btn--sm", type: "button", onClick: restartDaemon }, "Restart app")
        )
      )
    ]);

    card("expansion", "Expansion", (status) => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Terminator key"),
          h("span", { class: "t-caption" }, "Key you press right after typing a trigger.")
        ),
        h("div", { class: "segmented", role: "radiogroup", "aria-label": "Terminator" },
          ...["space", "enter", "tab"].map((v) =>
            h("label", null,
              h("input", {
                type: "radio",
                name: "terminator",
                value: v,
                checked: settings.terminator === v,
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
          h("span", { class: "t-caption" }, "Keeps your copied text, formatting, or images after expanding.")
        ),
        toggleSwitch(settings.restoreClipboard, (checked) => {
          settings.restoreClipboard = checked;
          save({ restoreClipboard: checked }, "expansion", status);
        })
      ),
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Paste method"),
          h("span", { class: "t-caption" }, "Clipboard paste keeps multi-line text and code symbols exact.")
        ),
        h("div", { class: "segmented", role: "radiogroup", "aria-label": "Paste method" },
          ...[
            { id: "clipboard", label: "Clipboard paste" },
            { id: "unicode", label: "Direct typing" },
          ].map((opt) =>
            h("label", null,
              h("input", {
                type: "radio",
                name: "injectionFallback",
                value: opt.id,
                checked: (settings.injectionFallback || "clipboard") === opt.id,
                onchange: () => { settings.injectionFallback = opt.id; save({ injectionFallback: opt.id }, "expansion", status); },
              }),
              h("span", null, opt.label)
            )
          )
        )
      )
    ]);

    card("startup", "Startup & Privacy", (status) => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Launch Mentions when I sign in"),
          h("span", { class: "t-caption" }, "Starts the Windows tray app automatically on sign-in.")
        ),
        toggleSwitch(settings.autostart, (checked) => {
          settings.autostart = checked;
          save({ autostart: checked }, "startup", status);
        })
      ),
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Local command storage"),
          h("span", { class: "t-caption" }, "Saved only on this PC. Nothing is ever uploaded.")
        ),
        h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } },
          h("span", { class: "code-token" }, "%APPDATA%\\Mentions\\commands.json"),
          h("button", {
            class: "btn btn--sm",
            type: "button",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText("%APPDATA%\\Mentions\\commands.json");
                toast({ message: "Path copied." });
              } catch {}
            },
          }, "Copy path")
        )
      )
    ]);

    const importFileInput = h("input", { id: "import-file", type: "file", accept: "application/json", hidden: true, onchange: onImport });

    card("data", "Backup & Data", () => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "Commands backup"),
          h("span", { class: "t-caption" }, `Currently ${state.commands.length} saved commands on this PC.`)
        ),
        h("div", { style: { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" } },
          h("button", { class: "btn btn--sm", type: "button", onClick: exportJSON }, "Export JSON"),
          h("button", { class: "btn btn--sm", type: "button", onClick: () => importFileInput.click() }, "Import JSON"),
          importFileInput
        )
      )
    ]);

    card("pairing", "Paired browsers", () => [
      h("div", { class: "settings__row" },
        h("div", { class: "settings__row-text" },
          h("span", { class: "t-body" }, "This browser is paired"),
          h("span", { class: "t-caption" }, "Revoking locks all connected tabs until paired again from the tray.")
        ),
        h("button", { class: "btn btn--sm btn--danger-outline", type: "button", onClick: revokeAll }, "Revoke all browsers")
      )
    ]);

    const versionStatusSlot = h("span", { class: "t-caption" }, "Checking for updates...");

    card("diagnostics", "Diagnostics", () => [
      h("dl", { style: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--space-2) var(--space-5)", fontSize: "var(--fs-label)", alignItems: "center" } },
        dt("Daemon version"), dd(state.health?.daemonVersion || "—"),
        dt("Update status"), dd(versionStatusSlot),
        dt("API version"), dd(state.health?.apiVersion || "—"),
        dt("Hook active"), dd(state.health?.hookActive ? "Yes" : "No"),
        dt("State"), dd(state.health?.state || "—")
      ),
      h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } },
        h("button", { class: "btn btn--sm", type: "button", onClick: copyDiagnostics }, "Copy diagnostics"),
        h("button", { class: "btn btn--sm", type: "button", onClick: checkUpdateStatus }, "Check for updates")
      )
    ]);

    container.replaceChildren(
      h("h1", { id: "settings-h", class: "t-headline" }, "Settings"),
      ...cards
    );

    if (loadErr) {
      toast({ message: "Showing last known settings." });
    }

    async function testConnection() {
      const started = performance.now();
      try {
        await request("/api/health", { auth: false, timeout: 1500 });
        const ms = Math.max(1, Math.round(performance.now() - started));
        toast({ message: `Connected in ${ms}ms.` });
      } catch {
        toast({ message: "Windows app didn't respond." });
      }
    }

    async function restartDaemon() {
      try {
        await request("/api/daemon/restart", { method: "POST" });
        toast({ message: "Restarting Windows app..." });
        setTimeout(() => probeHealth(), 1000);
      } catch {
        toast({ message: "Couldn't restart the app." });
      }
    }

    async function checkUpdateStatus() {
      versionStatusSlot.textContent = "Checking GitHub...";
      try {
        const res = await fetch("https://api.github.com/repos/umerhammaz/Mentions/releases/latest", {
          headers: { Accept: "application/vnd.github.v3+json" },
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const latestTag = (data.tag_name || "").replace(/^v/, "");
        const current = (state.health?.daemonVersion || "").replace(/^v/, "");
        if (latestTag && current && latestTag !== current) {
          versionStatusSlot.replaceChildren(
            h("span", { style: { color: "var(--warning)", fontWeight: "600" } }, `v${latestTag} available (current: v${current})`),
            h("a", {
              href: DOWNLOAD_URL,
              target: "_blank",
              rel: "noopener",
              class: "btn btn--sm",
              style: { marginLeft: "var(--space-2)" },
            }, `Download v${latestTag}`)
          );
        } else {
          versionStatusSlot.replaceChildren(
            h("span", { style: { color: "var(--success)" } }, `Up to date (v${current || latestTag})`)
          );
        }
      } catch {
        versionStatusSlot.textContent = "Could not reach GitHub.";
      }
    }

    checkUpdateStatus();

    async function exportJSON() {
      try {
        const data = await request("/api/commands/export");
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: `mentions-${Date.now()}.json`, onClick: (e) => e.stopPropagation() });
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
        const updated = await request("/api/commands");
        if (Array.isArray(updated?.commands)) set("commands", updated.commands);
        toast({ message: "Commands imported." });
        announce("Commands imported.");
      } catch { toast({ message: "Import failed — file didn't validate." }); }
    }

    function revokeAll() {
      confirmDialog({
        title: "Revoke all paired browsers?",
        body: "This browser will lock immediately until you pair again using the tray code.",
        confirmLabel: "Revoke all",
        danger: true,
        onConfirm: async () => {
          try { await request("/api/pair/revoke-all", { method: "POST" }); } catch {}
          tokenClear(location.origin);
          set("commands", []);
          set("health", { ...(state.health || {}), state: "unpaired", requiresPairing: true });
        },
      });
    }

    async function copyDiagnostics() {
      const text = JSON.stringify({ health: state.health, settings }, null, 2);
      try { await navigator.clipboard.writeText(text); toast({ message: "Diagnostics copied." }); } catch { toast({ message: "Couldn't copy." }); }
    }

    function dt(t) { return h("dt", { style: { color: "var(--on-surface-variant)" } }, t); }
    function dd(v) { return h("dd", { style: { fontFamily: "var(--font-mono)" } }, v instanceof Node ? v : String(v)); }

    return { title: "Settings", unmount() {} };
  },
};

route("/settings", screen);

export default screen;