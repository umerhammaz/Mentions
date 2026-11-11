import { h, patchList } from "../dom.js";
import { state, set, on as onState, emit } from "../store.js";
import { route, navigate } from "../router.js";
import { request } from "../api.js";
import { field, emptyState, overflowMenu, confirmDialog, toast, truncate, formatNum } from "../ui.js";
import { announce } from "../a11y.js";
import { renderEditor } from "./editor.js";

function nextUniqueTrigger(baseTrigger, commands) {
  const existing = new Set(commands.map((c) => c.trigger.toLowerCase()));
  const stem = baseTrigger.replace(/-copy(?:-\d+)?$/, "");
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? "-copy" : `-copy-${i}`;
    const maxStem = 32 - suffix.length;
    const candidate = `${stem.slice(0, maxStem)}${suffix}`.toLowerCase();
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem.slice(0, 24)}-${Date.now().toString(36).slice(-6)}`;
}

const routeScreen = {
  title: "Commands",
  async mount({ root }) {
    const isDesktop = matchMedia("(min-width: 960px)").matches;
    const container = h("section", { class: "cmds", "aria-labelledby": "cmds-h" });
    const headSlot = h("div");
    const filterSlot = h("div", { class: "cmds__filter" });
    const countSlot = h("div");
    const listSlot = h("div");

    const importInput = h("input", {
      type: "file",
      accept: "application/json",
      hidden: true,
      onchange: async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        try {
          const text = await file.text();
          const bundle = JSON.parse(text);
          await request("/api/commands/import", { method: "POST", body: bundle });
          emit("commands:reload");
          toast({ message: "Commands imported." });
          announce("Commands imported.");
        } catch {
          toast({ message: "Import failed — file didn't validate." });
        }
      },
    });

    container.append(headSlot, filterSlot, countSlot, listSlot, importInput);
    root.replaceChildren(container);

    let filterInputEl = null;

    function isOffline() {
      return state.health?.state !== "online" && state.health?.state !== "paused";
    }

    function renderHead() {
      const offline = isOffline();
      return h("div", { class: "cmds__head" },
        h("h1", { id: "cmds-h", class: "t-title" }, "Commands"),
        offline
          ? h("button", { class: "btn btn--primary", type: "button", disabled: true, "aria-disabled": "true", title: "Daemon is offline" }, "Create command")
          : h("a", { class: "btn btn--primary", href: "/commands/new" }, "Create command")
      );
    }

    function renderCount() {
      const total = state.commands.length;
      const enabled = state.commands.filter((c) => c.enabled).length;
      return h("p", { class: "cmds__count t-caption", role: "status" },
        `${formatNum(total)} ${total === 1 ? "command" : "commands"} · ${formatNum(enabled)} enabled`);
    }

    function syncFilterSlot() {
      const shouldShow = state.commands.length > 8 || Boolean(state.ui.filter);
      if (!shouldShow) {
        filterSlot.replaceChildren();
        filterInputEl = null;
        return;
      }
      if (!filterInputEl) {
        filterInputEl = h("input", {
          id: "filter",
          class: "input",
          type: "search",
          placeholder: "Search trigger or text",
          value: state.ui.filter || "",
          oninput: (e) => {
            set("ui", { ...state.ui, filter: e.target.value });
            updateResultsOnly();
          },
        });
        filterSlot.replaceChildren(field({ id: "filter", label: "Filter commands", control: filterInputEl }));
      } else if (document.activeElement !== filterInputEl && filterInputEl.value !== (state.ui.filter || "")) {
        filterInputEl.value = state.ui.filter || "";
      }
    }

    function renderEmpty() {
      const offline = isOffline();
      return emptyState({
        title: "No commands yet.",
        body: "A command is a trigger like @sig that pastes a longer block. When you type it and press Space (your current terminator), the text replaces it.",
        example: [h("strong", null, "@sig"), " → ", "Best regards,\nAyesha Khan · Product"],
        primaryLabel: "Create your first command",
        primaryHref: offline ? null : "/commands/new",
        secondary: h("button", {
          class: "btn btn--quiet",
          type: "button",
          disabled: offline ? true : null,
          onClick: () => importInput.click(),
        }, "Import a JSON file"),
      });
    }

    function renderList() {
      const filter = (state.ui.filter || "").toLowerCase().trim();
      const desc = state.ui.sort === "-trigger";
      const filtered = state.commands.filter((c) => {
        if (!filter) return true;
        return c.trigger.toLowerCase().includes(filter) || c.text.toLowerCase().includes(filter);
      }).sort((a, b) => desc ? b.trigger.localeCompare(a.trigger) : a.trigger.localeCompare(b.trigger));

      if (filtered.length === 0 && state.commands.length > 0) {
        return h("p", { class: "t-body", role: "status", style: { color: "var(--on-surface-variant)", marginTop: "var(--space-3)" } }, `No commands match "${state.ui.filter}".`);
      }
      if (state.commands.length === 0) return renderEmpty();

      const offline = isOffline();
      return isDesktop ? buildTable(filtered, offline) : buildRows(filtered, offline);
    }

    function buildTable(items, offline) {
      const desc = state.ui.sort === "-trigger";
      const table = h("table", { class: "table" },
        h("caption", { class: "sr-only" }, "Commands, sortable by trigger"),
        h("thead", null, h("tr", null,
          h("th", { scope: "col", "aria-sort": desc ? "descending" : "ascending" },
            h("button", {
              type: "button",
              onClick: () => {
                set("ui", { ...state.ui, sort: desc ? "trigger" : "-trigger" });
                updateResultsOnly();
              },
            }, "Trigger ", desc ? "↓" : "↑")
          ),
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

    function rowMenuItems(c, offline) {
      return [
        {
          label: "Copy text",
          onSelect: async () => {
            try {
              await navigator.clipboard.writeText(c.text);
              toast({ message: `Copied ${c.trigger}` });
            } catch {
              toast({ message: "Couldn't copy text" });
            }
          },
        },
        { label: "Edit", disabled: offline, onSelect: () => navigate(`/commands/${c.id}`) },
        {
          label: "Duplicate",
          disabled: offline,
          onSelect: async () => {
            try {
              const copy = {
                trigger: nextUniqueTrigger(c.trigger, state.commands),
                text: c.text,
                enabled: c.enabled,
                group: c.group,
              };
              await request("/api/commands", { method: "POST", body: copy });
              emit("commands:reload");
              toast({ message: `Duplicated as ${copy.trigger}` });
            } catch {
              toast({ message: "Couldn't duplicate command" });
            }
          },
        },
        { label: "Delete", danger: true, disabled: offline, onSelect: () => confirmDelete(c) },
      ];
    }

    function buildRow(c, offline, tag) {
      return h(tag, { "data-key": c.id, tabindex: "-1" },
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
        h("td", { class: "table__actions" }, overflowMenu(rowMenuItems(c, offline)))
      );
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
            overflowMenu(rowMenuItems(c, offline))
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

    function updateResultsOnly() {
      countSlot.replaceChildren(renderCount());
      listSlot.replaceChildren(renderList());
    }

    function rerender() {
      headSlot.replaceChildren(renderHead());
      syncFilterSlot();
      updateResultsOnly();
    }

    const unsubs = [
      onState("commands:changed", rerender),
      onState("commands:reload", async () => {
        try {
          const data = await request("/api/commands");
          set("commands", data?.commands || []);
          rerender();
        } catch {}
      }),
      onState("state:health", () => rerender()),
    ];

    rerender();

    try {
      const data = await request("/api/commands");
      set("commands", data?.commands || []);
      rerender();
    } catch {}

    return {
      title: "Commands",
      unmount() {
        for (const off of unsubs) off();
      },
    };
  },
};

route("/", routeScreen);
route("/commands/new", { mount: (ctx) => renderEditor(ctx, { mode: "new" }) });
route("/commands/:id", { mount: (ctx) => renderEditor(ctx, { mode: "edit" }) });

export default routeScreen;