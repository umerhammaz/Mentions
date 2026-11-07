import { h, useIcon } from "./dom.js";
import { state, on } from "./store.js";
import { formatDate, formatNum, truncate } from "./a11y.js";

export function renderChip(health) {
  const host = document.getElementById("status");
  if (!host) return;
  host.replaceChildren(chipFor(health));
}

function chipFor(h) {
  const s = h?.state || "unknown";
  const labelMap = {
    unknown: "Checking...",
    connecting: "Checking...",
    online: "Daemon online",
    paused: "Expansion paused",
    offline: "Daemon offline",
    unpaired: "Not paired",
    "version-mismatch": "Update required",
  };
  const toneMap = {
    online: "success",
    paused: "warning",
    offline: "danger",
    unpaired: "warning",
    "version-mismatch": "danger",
    unknown: "neutral",
    connecting: "neutral",
  };
  const tone = toneMap[s] || "neutral";
  return h("span", { class: `chip chip--${tone}`, role: "status" },
    h("span", { class: "chip__dot" }),
    h("span", null, labelMap[s] || s)
  );
}

export function renderBanner({ tone = "info", title, body, actions = [] }) {
  const banners = document.getElementById("banners");
  if (!banners) return null;
  const el = h("div", { class: `banner banner--${tone}`, role: tone === "danger" ? "alert" : "status" },
    useIcon(tone === "danger" ? "alert" : tone === "warning" ? "alert" : "info"),
    h("div", { class: "banner__body" },
      title ? h("div", { class: "banner__title" }, title) : null,
      body ? h("div", null, body) : null,
      actions.length ? h("div", { class: "banner__actions" }, ...actions) : null
    )
  );
  banners.append(el);
  return el;
}

export function clearBanners() {
  const banners = document.getElementById("banners");
  if (banners) banners.replaceChildren();
}

export function field({ id, label, help, control, error, required = false, optional = false }) {
  const describedby = [help && `${id}-help`, error && `${id}-err`].filter(Boolean).join(" ") || null;
  if (control && describedby) control.setAttribute("aria-describedby", describedby);
  if (control && required) control.setAttribute("required", "");
  if (control && error) control.setAttribute("aria-invalid", "true");
  return h("div", { class: "field" },
    h("label", { class: "field__label", for: id },
      label,
      required ? h("span", { class: "t-caption", style: { fontWeight: "400" } }, " · required") :
      optional ? h("span", { class: "t-caption", style: { fontWeight: "400" } }, " · optional") : null
    ),
    control,
    help ? h("p", { class: "field__help", id: `${id}-help` }, help) : null,
    error ? h("p", { class: "field__error", id: `${id}-err`, role: "alert" }, useIcon("alert"), h("span", null, error)) : null
  );
}

export function primaryButton(label, onClick, opts = {}) {
  return h("button", { class: `btn ${opts.variant ? `btn--${opts.variant}` : "btn--primary"}`, type: opts.type || "button", onClick }, label);
}

export function iconButton(iconId, label, onClick) {
  return h("button", { class: "icon-btn", type: "button", "aria-label": label, title: label, onClick }, useIcon(iconId));
}

export function overflowMenu(items) {
  return h("div", { style: { position: "relative", display: "inline-block" } }, (() => {
    const trigger = h("button", {
      class: "icon-btn",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": "More actions",
    }, useIcon("more"));
    let menu = null;
    function close() {
      if (menu) { menu.remove(); menu = null; trigger.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", onDoc); }
    }
    function onDoc(e) { if (!menu?.contains(e.target) && e.target !== trigger) close(); }
    trigger.addEventListener("click", () => {
      if (menu) return close();
      menu = h("div", { class: "menu", role: "menu" },
        ...items.map((it) => h("button", {
          type: "button",
          role: "menuitem",
          "data-danger": it.danger ? "true" : null,
          onClick: () => { close(); it.onSelect(); },
        }, it.label))
      );
      trigger.parentElement.append(menu);
      trigger.setAttribute("aria-expanded", "true");
      const first = menu.querySelector("button");
      first?.focus();
      setTimeout(() => document.addEventListener("pointerdown", onDoc), 0);
      menu.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); }
      });
    });
    return trigger;
  })());
}

export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false, onConfirm }) {
  const dlg = document.getElementById("confirm");
  if (!dlg) return;
  dlg.replaceChildren(
    h("h2", { class: "dialog__title t-headline" }, title),
    h("p", { class: "dialog__body t-body" }, body),
    h("div", { class: "dialog__actions" },
      h("button", { class: "btn btn--quiet", type: "button", onClick: () => dlg.close("cancel") }, "Cancel"),
      h("button", { class: `btn ${danger ? "btn--danger" : "btn--primary"}`, type: "button", onClick: () => dlg.close("confirm") }, confirmLabel)
    )
  );
  dlg.returnValue = "";
  dlg.showModal();
  dlg.addEventListener("close", function onClose() {
    dlg.removeEventListener("close", onClose);
    if (dlg.returnValue === "confirm") onConfirm?.();
  }, { once: true });
}

export function toast({ message, actionLabel, onAction, duration = 6000 }) {
  const host = document.getElementById("toast-host");
  if (!host) return;
  const el = h("div", { class: "toast", role: "status" },
    h("span", { style: { flex: "1" } }, message),
    actionLabel ? h("button", { type: "button", onClick: () => { el.remove(); onAction?.(); } }, actionLabel) : null,
    h("button", { type: "button", "aria-label": "Dismiss", onClick: () => el.remove() }, useIcon("x"))
  );
  host.append(el);
  if (duration) setTimeout(() => el.remove(), duration);
}

export function emptyState({ title, body, example, primaryLabel, primaryHref, secondary }) {
  return h("div", { class: "empty" },
    h("h2", { class: "t-title" }, title),
    h("p", { class: "t-body" }, body),
    example ? h("div", { class: "empty__example" }, ...example) : null,
    h("div", { class: "empty__actions" },
      primaryHref ? h("a", { class: "btn btn--primary", href: primaryHref }, primaryLabel) : null,
      secondary || null
    )
  );
}

export { formatDate, formatNum, truncate };