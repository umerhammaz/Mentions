const XLINK = "http://www.w3.org/1999/xlink";

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") { for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = dv; }
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "text") el.textContent = v;
      else if (k === "html") { /* banned */ }
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  for (const c of children.flat()) if (c != null && c !== false) f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return f;
}

export function on(root, type, selector, fn) {
  const handler = (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(type, handler);
  return () => root.removeEventListener(type, handler);
}

export function patchList(parent, items, { key, create, update }) {
  const existing = new Map();
  for (const child of Array.from(parent.children)) {
    const k = child.dataset.key;
    if (k) existing.set(k, child);
    else child.remove();
  }
  const seen = new Set();
  for (const item of items) {
    const k = String(key(item));
    seen.add(k);
    const el = existing.get(k);
    if (el) update(el, item);
    else parent.append(create(item));
  }
  for (const [k, el] of existing) if (!seen.has(k)) el.remove();
}

export function useIcon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/assets/icons.svg#${id}`);
  svg.append(use);
  return svg;
}