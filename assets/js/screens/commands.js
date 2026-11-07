import { h, patchList, on } from "../dom.js";
import { state, set, on as onState, emit } from "../store.js";
import { route, navigate } from "../router.js";
import { request } from "../api.js";
import { field, emptyState, overflowMenu, confirmDialog, toast, truncate, formatNum } from "../ui.js";
import { announce, formatDate } from "../a11y.js";
import { renderEditor } from "./editor.js";

const routeScreen = {
  title: "Commands",
  async mount({ root, params }) {
    const isDesktop = matchMedia("(min-width: 960px)").matches;
    const container = h("section", { class: "cmds", "aria-labelledby": "cmds-h" });
    root.replaceChildren(container);

    function renderHead() {
      return h("div", { class: "cmds__head" },
        h("h1", { id: "cmds-h", class: "t-title" }, "Commands"),
        h("a", { class: "btn btn--primary", href: "/commands/new" }, "Create command")
      );
    }

    function renderCount() {
      const total = state.commands.length;
      const enabled = state.commands.filter((c) => c.enabled).length;
      return h("p", { class: "cmds__count t-caption", role: "status" },
        `${formatNum(total)} ${total === 1 ? "command" : "commands"} · ${formatNum(enabled)} enabled`);
    }

    function renderFilter() {
      if (state.commands.length <= 8) return null;
      const input = h("input", {
        id: "filter", class: "input", type: "search", placeholder: "Search trigger or text",
        value: state.ui.filter, oninput: (e) => { set("ui", { ...state.ui, filter: e.target.value }); renderList(); },
      });
      return field({ id: "filter", label: "Filter commands", control: input });
    }

    function renderEmpty() {
      return emptyState({
        title: "No commands yet.",
        body: "A command is a trigger like @sig that pastes a longer block. When you type it and press Space (your current terminator), the text replaces it.",
        example: [h("strong", null, "@sig"), " → ", "Best regards,\nAyesha Khan · Product"],
        primaryLabel: "Create your first command",
        primaryHref: "/commands/new",
        secondary: h("button", { class: "btn btn--quiet", type: "button", onClick: () => document.getElementById("import-file")?.click() }, "Import a JSON file"),
      });
    }

    function renderList() {
      const filter = state.ui.filter.toLowerCase().trim();
      const filtered = state.commands.filter((c) => {
        if (!filter) return true;
        return c.trigger.toLowerCase().includes(filter) || c.text.toLowerCase().includes(filter);
      }).sort((a, b) => a.trigger.localeCompare(b.trigger));

      if (filtered.length === 0 && state.commands.length > 0) {
        return h("p", { class: "t-body", role: "status", style: { color: "var(--on-surface-variant)" } }, `No commands match "${state.ui.filter}".`);
      }
      if (state.commands.length === 0) return renderEmpty();

      const offline = state.health?.state !== "online" && state.health?.state !== "paused";
      const list = isDesktop ? buildTable(filtered, offline) : buildRows(filtered, offline);
      return list;
    }

    function buildTable(items, offline) {
      const table = h("table", { class: "table" },
        h("caption", { class: "sr-only" }, "Commands, sortable by trigger"),
        h("thead", null, h("tr", null,
          h("th", { scope: "col", "aria-sort": "ascending" }, h("button", { type: "button" }, "Trigger")),
          h("th", { scope: "col" }, "Pastes"),
          h("th", { scope: "col" }, "Status"),
          h("th", { scope: "col" }, h("span", { class: "sr-only" }, "Actions"))
        )),
        h("tbody")
      );
      const tbody = table.querySelector("tbody");
      patchList(tbody, items, {
        key: (c) => c.id,
        create: (c) => buildRow(c, offline, "tr"),
        update: (el, c) => { el.replaceWith(buildRow(c, offline, "tr")); },
      });
      tbody.addEventListener("click", (e) => {
        const row = e.target.closest("tr[data-key]");
        if (!row) return;
        if (e.target.closest("button, a")) return;
        navigate(`/commands/${row.dataset.key}`);
      });
      return table;
    }

    function buildRow(c, offline, tag) {
      const row = h(tag, { "data-key": c.id, tabindex: "-1" },
        h("td", null,
          h("div", { class: "table__trigger" },
            h("span", { class: "code-token" }, c.trigger),
            h("span", { class: "table__preview" }, truncate(c.text, 60))
          )
        ),
        h("td", null, h("span", { class: "t-caption" }, `${formatNum(c.text.length)} chars`)),
        h("td", null, h("span", { class: "table__status" },
          h("span", { "aria-hidden": "true", style: { width: "8px", height: "8px", borderRadius: "50%", background: c.enabled ? "var(--success)" : "var(--on-surface-variant)" } }),
          c.enabled ? "Enabled" : "Paused"
        )),
        h("td", { class: "table__actions" }, overflowMenu([
          { label: "Edit", onSelect: () => navigate(`/commands/${c.id}`) },
          { label: "Duplicate", onSelect: async () => {
            try {
              const copy = { ...c, trigger: `${c.trigger}-copy`, id: undefined };
              await request("/api/commands", { method: "POST", body: copy });
              emit("commands:reload");
              toast({ message: "Command duplicated" });
            } catch (err) { toast({ message: "Couldn't duplicate command" }); }
          }},
          { label: "Delete", danger: true, onSelect: () => confirmDelete(c) },
        ]))
      );
      return row;
    }

    function buildRows(items, offline) {
      const list = h("ul", { class: "rows", role: "list" });
      patchList(list, items, {
        key: (c) => c.id,
        create: (c) => h("li", { "data-key": c.id },
          h("div", { class: "row" },
            h("div", { class: "row__body" },
              h("div", { class: "row__trigger" },
                h("span", { class: "code-token" }, c.trigger),
                h("span", { class: "t-caption" }, c.enabled ? "Enabled" : "Paused")
              ),
              h("div", { class: "row__preview" }, truncate(c.text, 48))
            ),
            overflowMenu([
              { label: "Edit", onSelect: () => navigate(`/commands/${c.id}`) },
              { label: "Delete", danger: true, onSelect: () => confirmDelete(c) },
            ])
          )
        ),
        update: (el, c) => { el.replaceWith(buildRows([c], offline).firstChild); },
      });
      return list;
    }

    function confirmDelete(c) {
      confirmDialog({
        title: `Delete ${c.trigger}?`,
        body: "It will stop expanding immediately. You can undo this for a few seconds afterwards.",
        confirmLabel: "Delete command",
        danger: true,
        onConfirm: async () => {
          try {
            await request(`/api/commands/${c.id}`, { method: "DELETE" });
            const snapshot = c;
            set("commands", state.commands.filter((x) => x.id !== c.id));
            emit("commands:changed");
            toast({
              message: `Deleted ${c.trigger}`,
              actionLabel: "Undo",
              onAction: async () => {
                try {
                  await request("/api/commands", { method: "POST", body: { trigger: snapshot.trigger, text: snapshot.text, enabled: snapshot.enabled, group: snapshot.group } });
                  emit("commands:reload");
                } catch {}
              },
            });
            announce(`Deleted ${c.trigger}`);
          } catch {
            toast({ message: "Couldn't delete command" });
          }
        },
      });
    }

    function rerender() {
      const head = renderHead();
      const filter = renderFilter();
      const count = renderCount();
      const list = renderList();
      container.replaceChildren(head, filter, count, list);
    }

    onState("commands:changed", rerender);
    onState("commands:reload", async () => {
      try {
        const data = await request("/api/commands");
        set("commands", data.commands || []);
        rerender();
      } catch {}
    });
    onState("state:health", () => { if (state.commands.length) rerender(); });

    rerender();

    if (state.commands.length === 0) {
      try {
        const data = await request("/api/commands");
        set("commands", data.commands || []);
        rerender();
      } catch {}
    }

    return { title: "Commands", unmount() {} };
  },
};

route("/", routeScreen);
route("/commands/new", { mount: (ctx) => renderEditor(ctx, { mode: "new" }) });
route("/commands/:id", { mount: (ctx) => renderEditor(ctx, { mode: "edit" }) });

export default routeScreen;