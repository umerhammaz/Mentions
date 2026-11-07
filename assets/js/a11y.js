let liveTimer = null;

export function announce(msg) {
  const live = document.getElementById("live");
  if (!live) return;
  live.textContent = "";
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { live.textContent = msg; }, 50);
}

export function alertScreen(msg) {
  const el = document.getElementById("alert");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => { el.textContent = msg; }, 50);
}

export function moveFocus(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
}

export function focusFirstInvalid(form) {
  const el = form.querySelector('[aria-invalid="true"]');
  if (el) moveFocus(el);
  return el;
}

export function roving(container, itemSelector) {
  const items = () => Array.from(container.querySelectorAll(itemSelector));
  function onKey(e) {
    const list = items();
    const idx = list.indexOf(document.activeElement);
    if (idx === -1) return;
    let next = idx;
    if (e.key === "ArrowDown") next = Math.min(idx + 1, list.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(idx - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    list.forEach((el, i) => { if (i === next) el.tabIndex = 0; else el.tabIndex = -1; });
    moveFocus(list[next]);
  }
  container.addEventListener("keydown", onKey);
  return () => container.removeEventListener("keydown", onKey);
}

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diff = (d.getTime() - Date.now()) / 1000;
  if (Math.abs(diff) < 60) return rtf.format(Math.round(diff), "second");
  if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), "minute");
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function formatNum(n) {
  return new Intl.NumberFormat().format(n);
}

export function truncate(s, n = 60) {
  if (!s) return "";
  const first = s.split("\n")[0];
  return first.length > n ? first.slice(0, n - 1) + "..." : first;
}