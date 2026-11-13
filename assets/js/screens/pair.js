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
    const cardHost = h("div");
    wrap.append(cardHost);
    root.replaceChildren(wrap);

    let lastRenderedKind = "";
    let autoSubmitting = false;

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
      cardHost.replaceChildren(
        rescue || "",
        h("div", { class: "gate__card" },
          h("span", { class: "gate__badge" }, `Checking port ${getPort()}...`),
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
        style: { width: "100%", height: "42px" },
      }, "Download Mentions for Windows (.exe)");

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
        class: "input settings__port-input",
        type: "number",
        min: "1024",
        max: "65535",
        value: String(getPort()),
        "aria-label": "Custom daemon port",
      });
      const portRow = h("div", { class: "gate__port-row", hidden: true },
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
        }, "Use port")
      );

      const portToggle = h("button", {
        class: "btn btn--quiet btn--sm",
        type: "button",
        onClick: () => {
          portOpen = !portOpen;
          portRow.hidden = !portOpen;
        },
      }, "Custom port");

      cardHost.replaceChildren(
        rescue || "",
        h("div", { class: "gate__card" },
          h("span", { class: "gate__badge gate__badge--warn" }, `Windows app not detected on port ${getPort()}`),
          h("h1", { id: "gate-h", class: "t-headline" }, "Install & start Mentions"),
          h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
            "Mentions requires the Windows tray app running on this PC so your @commands stay private and work in every app."
          ),
          pendingCode
            ? h("p", { class: "t-caption", style: { color: "var(--accent)" } },
                `Code ${pendingCode} is ready — it will pair automatically as soon as the app starts.`
              )
            : null,
          downloadBtn,
          h("div", { class: "gate__steps" },
            step(1, "Download and run mentions-daemon.exe", "Single file, no setup wizard — it sits quietly near your Windows clock."),
            step(2, "Open the tray menu and click Pair Browser", "Right-click or double-click the Mentions tray icon."),
            step(3, "This screen connects automatically", "We keep checking every 2 seconds and jump straight to pairing when the app starts.")
          ),
          h("div", { class: "gate__footer" },
            h("span", { class: "t-caption" }, `Waiting for 127.0.0.1:${getPort()}...`),
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
      cardHost.replaceChildren(
        h("div", { class: "gate__card" },
          h("span", { class: "gate__badge gate__badge--danger" }, `Update needed · ${currentVer}`),
          h("h1", { id: "gate-h", class: "t-headline" }, "Update your Windows app"),
          h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
            "Your running daemon version doesn't match this web controller. Download the latest executable and run it."
          ),
          h("a", {
            class: "btn btn--primary",
            href: DOWNLOAD_URL,
            target: "_blank",
            rel: "noopener",
            style: { width: "100%", height: "42px" },
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
        placeholder: "••••••",
        inputmode: "text",
        autocomplete: "one-time-code",
        spellcheck: "false",
        "aria-describedby": "code-help",
        oninput: (e) => {
          const cleaned = sanitize(e.target.value);
          if (e.target.value !== cleaned) e.target.value = cleaned;
          input.removeAttribute("aria-invalid");
          errHost.replaceChildren();
          if (cleaned.length === 6) submitPair();
        },
      });

      const form = h("form", { novalidate: true, onsubmit: submitPair, style: { display: "flex", flexDirection: "column", gap: "var(--space-3)" } },
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

      cardHost.replaceChildren(
        rescue || "",
        h("div", { class: "gate__card" },
          h("span", { class: "gate__badge gate__badge--ok" }, `Windows app connected on port ${getPort()}`),
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

    function step(num, title, desc) {
      return h("div", { class: "gate__step" },
        h("span", { class: "gate__step-num", "aria-hidden": "true" }, String(num)),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
          h("span", { class: "t-label", style: { fontWeight: "600", color: "var(--on-surface)" } }, title),
          h("span", { class: "t-caption" }, desc)
        )
      );
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