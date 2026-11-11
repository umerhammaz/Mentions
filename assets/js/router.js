import { announce, moveFocus } from "./a11y.js";

const routes = [];

export function route(pattern, screen) {
  const keys = [];
  if (pattern === "*") {
    routes.push({ re: /^.*$/, keys, screen });
    return;
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withParams = escaped.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; });
  routes.push({ re: new RegExp("^" + withParams + "$"), keys, screen });
}

export function startRouter({ root, defaultTitle = "Mentions" }) {
  let current = null;

  async function render() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    let match = null, params = {};
    for (const r of routes) {
      const m = path.match(r.re);
      if (m) {
        match = r;
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        break;
      }
    }
    if (!match) { location.href = "/404.html"; return; }

    if (current?.unmount) try { current.unmount(); } catch {}
    current = null;

    const screen = match.screen;
    try {
      const mounted = await screen.mount({ root, params });
      current = mounted || screen;
      document.title = (mounted?.title || screen.title || defaultTitle) + " · " + defaultTitle;
    } catch (err) {
      console.error(err);
      announce("Failed to load screen.");
    }

    for (const link of document.querySelectorAll(".rail__link")) {
      const href = link.getAttribute("href");
      if (href === path || (href !== "/" && path.startsWith(href))) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }

    const main = document.getElementById("main");
    if (location.hash) {
      const target = main.querySelector(location.hash);
      if (target) {
        target.scrollIntoView({ block: "start" });
        announce(`Page: ${document.title.split(" · ")[0]}`);
        return;
      }
    }
    const heading = main.querySelector("h1, h2");
    if (heading) { heading.setAttribute("tabindex", "-1"); moveFocus(heading); }
    else moveFocus(main);
    announce(`Page: ${document.title.split(" · ")[0]}`);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("//") || href.startsWith("#")) return;
    if (a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const currentFull = location.pathname + location.search + location.hash;
    if (currentFull === href) return;
    history.pushState({ scrollY: 0 }, "", href);
    render().then(() => {
      if (!location.hash) window.scrollTo(0, 0);
    });
  });

  window.addEventListener("popstate", () => {
    render();
    const y = history.state?.scrollY || 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
  });

  render();
  return render;
}

export function navigate(path) {
  if (location.pathname + location.search + location.hash === path) return;
  history.pushState({ scrollY: 0 }, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}