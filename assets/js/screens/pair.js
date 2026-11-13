import { h } from "../dom.js";
import { state, tokenSet, set } from "../store.js";
import { request, ApiError, getPort, setPort, probeHealth } from "../api.js";
import { route } from "../router.js";
import { field, toast } from "../ui.js";
import { announce, focusFirstInvalid } from "../a11y.js";

const DOWNLOAD_URL = "https://github.com/umerhammaz/Mentions/releases/latest/download/mentions-daemon.exe";
const LATEST_RELEASE_API = "https://api.github.com/repos/umerhammaz/Mentions/releases/latest";

let latestReleaseCache = null;

async function fetchLatestReleaseInfo() {
  if (latestReleaseCache) return latestReleaseCache;
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const asset = Array.isArray(data.assets)
      ? data.assets.find((a) => String(a.name || "").endsWith(".exe"))
      : null;
    latestReleaseCache = {
      tag: data.tag_name || "",
      sizeMb: asset?.size ? `${(asset.size / (1024 * 1024)).toFixed(1)} MB` : "",
      url: asset?.browser_download_url || DOWNLOAD_URL,
    };
    return latestReleaseCache;
  } catch {
    return null;
  }
}

let activeView = null;

const screen = {
  title: "Connect Mentions",
  update(hh) {
    if (activeView) activeView.onHealth(hh);
  },
  async mount({ root }) {
    const sanitize = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    let pendingCode = "";
    try { pendingCode = sanitize(sessionStorage.getItem("mentions.pendingCode")); } catch {}

    const wrap = h("section", { class: "gate", "aria-labelledby": "gate-h" },
      h("div", { class: "gate__brand" },
        h("img", { class: "gate__logo", src: "/assets/mentions_logo.png", alt: "Mentions", width: "300", height: "60" })
      )
    );
    const panelHost = h("div");
    wrap.append(panelHost);
    root.replaceChildren(wrap);

    let lastRenderedKind = "";
    let autoSubmitting = false;

    function statusRow(tone, label) {
      return h("div", { class: "gate__status" },
        h("span", { class: `gate__dot gate__dot--${tone}`, "aria-hidden": "true" }),
        h("span", null, label)
      );
    }

    function buildRescueBanner() {
      const saved = state.ui?.unsavedRescue;
      if (!saved) return null;
      return h("div", { class: "banner banner--warning", role: "status" },
        h("div", { class: "banner__body" },
          h("div", { class: "banner__title" }, "Unsaved prompt saved"),
          h("div", null, "Copy your draft before reconnecting.")
        ),
        h("div", { class: "banner__actions" },
          h("button", {
            class: "btn btn--sm",
            type: "button",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(saved);
                toast({ message: "Unsaved draft copied." });
              } catch {
                toast({ message: "Couldn't copy draft." });
              }
            },
          }, "Copy draft")
        )
      );
    }

    function renderConnecting() {
      const rescue = buildRescueBanner();
      panelHost.replaceChildren(
        rescue || "",
        h("div", { class: "gate__panel" },
          statusRow("warn", `Checking 127.0.0.1:${getPort()}`),
          h("h1", { id: "gate-h", class: "t-headline" }, "Connecting to Mentions"),
          h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
            "Looking for the Windows background app on this PC."
          )
        )
      );
    }

    function renderOffline() {
      const rescue = buildRescueBanner();
      const downloadBtn = h("a", {
        class: "btn btn--primary",
        href: DOWNLOAD_URL,
        target: "_blank",
        rel: "noopener",
        style: { width: "100%", height: "40px" },
      }, "Download for Windows (.exe)");

      const checkBtn = h("button", {
        class: "btn btn--sm",
        type: "button",
        onClick: async () => {
          checkBtn.disabled = true;
          checkBtn.textContent = "Checking...";
          await probeHealth();
          checkBtn.disabled = false;
          checkBtn.textContent = "Check again";
        },
      }, "Check again");

      let portOpen = false;
      const portInput = h("input", {
        id: "gate-port",
        class: "input settings__port-input",
        type: "number",
        min: "1024",
        max: "65535",
        value: String(getPort()),
      });
      const portRow = h("div", { class: "gate__port-row", hidden: true },
        h("label", { class: "t-caption", for: "gate-port" }, "Port"),
        portInput,
        h("button", {
          class: "btn btn--sm",
          type: "button",
          onClick: async () => {
            const nextPort = setPort(portInput.value);
            if (!nextPort) {
              toast({ message: "Enter a port between 1024 and 65535." });
              return;
            }
            await probeHealth();
          },
        }, "Apply")
      );

      const portToggle = h("button", {
        class: "btn btn--quiet btn--sm",
        type: "button",
        onClick: () => {
          portOpen = !portOpen;
          portRow.hidden = !portOpen;
          if (portOpen) portInput.focus();
        },
      }, "Custom port");

      panelHost.replaceChildren(
        rescue || "",
        h("div", { class: "gate__panel" },
          statusRow("warn", `Not running on 127.0.0.1:${getPort()}`),
          h("h1", { id: "gate-h", class: "t-headline" }, "Install and start Mentions"),
          h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
            "Mentions requires the Windows tray app on this PC so @commands expand in every app and stay local."
          ),
          pendingCode
            ? h("p", { class: "t-caption", style: { color: "var(--on-surface)" } },
                `Pairing code ${pendingCode} is saved and will connect automatically when the app starts.`
              )
            : null,
          downloadBtn,
          h("ol", { class: "gate__list" },
            h("li", { class: "gate__list-item" },
              h("span", { class: "gate__num" }, "01"),
              h("span", null, "Download and run mentions-daemon.exe (sits in the Windows tray).")
            ),
            h("li", { class: "gate__list-item" },
              h("span", { class: "gate__num" }, "02"),
              h("span", null, "Right-click the tray icon and select Pair Browser.")
            ),
            h("li", { class: "gate__list-item" },
              h("span", { class: "gate__num" }, "03"),
              h("span", null, "This page detects the app automatically once it starts.")
            )
          ),
          h("div", { class: "gate__footer" },
            h("span", { class: "t-caption" }, `Checking 127.0.0.1:${getPort()}...`),
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center" } },
              portToggle,
              checkBtn
            )
          ),
          portRow
        )
      );

      fetchLatestReleaseInfo().then((info) => {
        if (!info || !downloadBtn.isConnected) return;
        downloadBtn.href = info.url;
        downloadBtn.textContent = info.sizeMb
          ? `Download Mentions ${info.tag} (.exe · ${info.sizeMb})`
          : `Download Mentions ${info.tag} (.exe)`;
      });
    }

    function renderVersionMismatch(hh) {
      const currentVer = hh?.daemonVersion ? `v${hh.daemonVersion}` : "old version";
      panelHost.replaceChildren(
        h("div", { class: "gate__panel" },
          statusRow("danger", `Update required · running ${currentVer}`),
          h("h1", { id: "gate-h", class: "t-headline" }, "Update your Windows app"),
          h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
            "Your running daemon version doesn't match this controller. Download the latest executable and run it."
          ),
          h("a", {
            class: "btn btn--primary",
            href: DOWNLOAD_URL,
            target: "_blank",
            rel: "noopener",
            style: { width: "100%", height: "40px" },
          }, "Download latest for Windows (.exe)"),
          h("div", { class: "gate__footer" },
            h("span", { class: "t-caption" }, "Replace the running exe and check again."),
            h("button", { class: "btn btn--sm", type: "button", onClick: () => probeHealth() }, "Check again")
          )
        )
      );
    }

    function renderUnpaired() {
      const rescue = buildRescueBanner();
      const errHost = h("div", { id: "code-err" });
      const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Pair this browser");

      const input = h("input", {
        id: "code",
        class: "input pair__code",
        type: "text",
        maxlength: "6",
        value: pendingCode,
        placeholder: "------",
        inputmode: "text",
        autocomplete: "one-time-code",
        spellcheck: "false",
        "aria-describedby": "code-help",
        onInput: (e) => {
          const cleaned = sanitize(e.target.value);
          if (e.target.value !== cleaned) e.target.value = cleaned;
          input.removeAttribute("aria-invalid");
          errHost.replaceChildren();
          if (cleaned.length === 6) submitPair();
        },
      });

      const form = h("form", { novalidate: true, onSubmit: submitPair, style: { display: "flex", flexDirection: "column", gap: "var(--space-3)" } },
        field({
          id: "code",
          label: "6-character pairing code",
          help: "Right-click the Mentions icon in your Windows tray to see or copy this code.",
          control: input,
        }),
        errHost,
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)" } },
          h("button", {
            class: "btn",
            type: "button",
            onClick: async () => {
              try {
                const text = await navigator.clipboard.readText();
                const cleaned = sanitize(text);
                if (cleaned) {
                  input.value = cleaned;
                  if (cleaned.length === 6) submitPair();
                }
              } catch {}
            },
          }, "Paste code"),
          submitBtn
        )
      );

      function showError(msg) {
        errHost.replaceChildren(h("p", { class: "field__error", id: "code-err-msg", role: "alert" }, msg));
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", "code-help code-err-msg");
        focusFirstInvalid(form);
      }

      async function submitPair(e) {
        if (e) e.preventDefault();
        if (autoSubmitting) return;
        const code = sanitize(input.value);
        input.value = code;
        if (code.length !== 6) return showError("Enter the 6-character code from your Windows tray.");
        autoSubmitting = true;
        submitBtn.disabled = true;
        submitBtn.textContent = "Pairing...";
        try {
          const res = await request("/api/pair", { method: "POST", body: { code }, auth: false });
          try { sessionStorage.removeItem("mentions.pendingCode"); } catch {}
          pendingCode = "";
          tokenSet(location.origin, res.token);
          set("session", { token: res.token, pairedAt: new Date().toISOString() });
          if (state.ui?.unsavedRescue) {
            set("ui", { ...state.ui, unsavedRescue: null });
          }
          announce("Paired with Mentions.");
          await probeHealth();
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.code === "E_RATE_LIMITED") showError(`Too many attempts. Try again in ${err.retryAfter || 30} seconds.`);
            else if (err.code === "E_UNAUTHORIZED") showError("That code didn't match. Check the tray menu and try again.");
            else if (err.code === "E_OFFLINE") showError("Lost connection to the Windows app.");
            else showError(err.message || "Pairing failed.");
          } else {
            showError("Pairing failed.");
          }
          submitBtn.disabled = false;
          submitBtn.textContent = "Pair this browser";
        } finally {
          autoSubmitting = false;
        }
      }

      panelHost.replaceChildren(
        rescue || "",
        h("div", { class: "gate__panel" },
          statusRow("ok", `Connected · 127.0.0.1:${getPort()}`),
          h("h1", { id: "gate-h", class: "t-headline" }, "Pair this browser"),
          h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
            "Enter the 6-character code from your Mentions tray menu to unlock commands and settings."
          ),
          form,
          h("div", { class: "gate__footer" },
            h("span", { class: "t-caption" }, "Need to reinstall or update the app?"),
            h("a", {
              class: "btn btn--sm",
              href: DOWNLOAD_URL,
              target: "_blank",
              rel: "noopener",
            }, "Download .exe")
          )
        )
      );

      setTimeout(() => {
        if (!input.isConnected) return;
        input.focus();
        if (pendingCode.length === 6) submitPair();
      }, 0);
    }

    function applyHealth(hh) {
      const s = hh?.state || "connecting";
      if (s === lastRenderedKind && s !== "connecting") return;
      lastRenderedKind = s;
      if (s === "offline") renderOffline();
      else if (s === "unpaired") renderUnpaired();
      else if (s === "version-mismatch") renderVersionMismatch(hh);
      else renderConnecting();
    }

    activeView = { onHealth: applyHealth };
    applyHealth(state.health);

    return {
      title: "Connect Mentions",
      unmount() {
        activeView = null;
      },
    };
  },
};

route("/pair", screen);

export default screen;