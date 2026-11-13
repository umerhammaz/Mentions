export const bus = new EventTarget();

export const state = {
  health: null,
  commands: [],
  settings: null,
  session: null,
  ui: { filter: "", sort: "trigger", selectedId: null, dirty: false },
  cacheLoaded: false,
};

let saveTimer = null;

export function set(key, value) {
  const prev = state[key];
  state[key] = value;
  if (key === "commands" && Array.isArray(value)) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => cacheSave(value), 60);
  }
  bus.dispatchEvent(new CustomEvent(`state:${key}`, { detail: { value, prev } }));
}

export function patch(key, partial) {
  const next = { ...(state[key] || {}), ...partial };
  set(key, next);
}

export function get(key) {
  return state[key];
}

export function on(event, fn) {
  bus.addEventListener(event, fn);
  return () => bus.removeEventListener(event, fn);
}

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

const KEY = "mentions.cache.v1";

export function cacheLoad() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

export function cacheSave(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
}

export function tokenGet(origin) {
  try { return localStorage.getItem(`mentions.token.${origin}`); } catch { return null; }
}

export function tokenSet(origin, token) {
  try { localStorage.setItem(`mentions.token.${origin}`, token); } catch {}
}

export function tokenClear(origin) {
  try { localStorage.removeItem(`mentions.token.${origin}`); } catch {}
}

const initialCache = cacheLoad();
if (Array.isArray(initialCache) && initialCache.length > 0) {
  state.commands = initialCache;
  state.cacheLoaded = true;
}