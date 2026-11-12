import { h } from "../dom.js";
import { state, tokenSet, set } from "../store.js";
import { request, ApiError } from "../api.js";
import { route, navigate } from "../router.js";
import { field } from "../ui.js";
import { announce, focusFirstInvalid } from "../a11y.js";

const DOWNLOAD_URL = "https://github.com/umerhammaz/Mentions/releases/latest/download/mentions-daemon.exe";

const screen = {
  title: "Pair",
  async mount({ root }) {
    const params = new URLSearchParams(location.search);
    const sanitize = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const initial = sanitize(params.get("code"));

    const input = h("input", {
      id: "code", class: "input pair__code", type: "text", maxlength: "6", value: initial,
      placeholder: "••••••",
      inputmode: "text", autocomplete: "one-time-code", spellcheck: "false",
      "aria-describedby": "code-help",
      oninput: (e) => {
        const cleaned = sanitize(e.target.value);
        if (e.target.value !== cleaned) e.target.value = cleaned;
        input.removeAttribute("aria-invalid");
        errHost.replaceChildren();
        if (cleaned.length === 6) {
          onSubmit();
        }
      },
    });
    const errHost = h("div", { id: "code-err" });
    const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, "Pair this browser");

    const form = h("form", { novalidate: true, onsubmit: onSubmit },
      field({
        id: "code",
        label: "Pairing code",
        help: "Open the Mentions tray menu on this PC and copy the 6-character code.",
        control: input,
      }),
      errHost,
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-2)" } },
        h("button", {
          class: "btn btn--quiet",
          type: "button",
          onClick: async () => {
            try {
              const text = await navigator.clipboard.readText();
              const cleaned = sanitize(text);
              if (cleaned) {
                input.value = cleaned;
                if (cleaned.length === 6) onSubmit();
              }
            } catch {}
          },
        }, "Paste code"),
        submitBtn
      )
    );

    const setupCard = h("div", { class: "pair__card" },
      h("div", { class: "pair__card-title" }, "Don't have the Windows app running yet?"),
      h("p", { class: "pair__card-body" },
        "Download and run mentions-daemon.exe on Windows to get your 6-character tray pairing code, or preview without the app in browser mode."
      ),
      h("div", { class: "pair__card-actions" },
        h("a", {
          class: "btn btn--primary",
          href: DOWNLOAD_URL,
          target: "_blank",
          rel: "noopener",
        }, "Download for Windows (.exe)"),
        h("button", {
          class: "btn btn--quiet",
          type: "button",
          onClick: enterDemoMode,
        }, "Preview without app")
      )
    );

    root.replaceChildren(
      h("section", { class: "pair", "aria-labelledby": "pair-h" },
        h("h1", { id: "pair-h", class: "t-display" }, "Pair this browser"),
        h("p", { class: "t-body" }, "The controller needs your permission before it can edit commands. Codes are shown in the Mentions tray menu."),
        form,
        setupCard
      )
    );

    function enterDemoMode() {
      tokenSet(location.origin, "demo-offline-token");
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
      announce("Entered offline preview mode.");
      navigate("/");
    }

    async function onSubmit(e) {
      if (e) e.preventDefault();
      const code = sanitize(input.value);
      input.value = code;
      if (code.length !== 6) return showError("Enter the 6-character code from the tray.");
      submitBtn.disabled = true;
      submitBtn.textContent = "Pairing...";
      try {
        const res = await request("/api/pair", { method: "POST", body: { code }, auth: false, allowDemo: false });
        tokenSet(location.origin, res.token);
        set("session", { token: res.token, pairedAt: new Date().toISOString() });
        try {
          const hh = await request("/api/health", { auth: true, timeout: 1500, allowDemo: false });
          set("health", { ...hh, state: hh?.paused ? "paused" : "online", lastCheckedAt: Date.now() });
        } catch {}
        announce("Paired. Loading commands.");
        history.replaceState(null, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === "E_RATE_LIMITED") showError(`Too many attempts. Try again in ${err.retryAfter || 30} seconds.`);
          else if (err.code === "E_UNAUTHORIZED") showError("That code didn't match. Check the tray and try again.");
          else if (err.code === "E_OFFLINE") showError("Can't reach the daemon. Is Mentions running?");
          else showError(err.message || "Pairing failed.");
        } else {
          showError("Pairing failed.");
        }
        submitBtn.disabled = false;
        submitBtn.textContent = "Pair this browser";
      }
    }

    function showError(msg) {
      errHost.replaceChildren(h("p", { class: "field__error", id: "code-err-msg", role: "alert" }, msg));
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "code-help code-err-msg");
      focusFirstInvalid(form);
    }

    setTimeout(() => {
      input.focus();
      if (initial.length === 6) onSubmit();
    }, 0);
    return { title: "Pair", unmount() {} };
  },
};

route("/pair", screen);

export default screen;