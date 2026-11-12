import { h, patchList } from "../dom.js";
import { state, set, on as onState, emit, tokenGet, tokenSet } from "../store.js";
import { route, navigate } from "../router.js";
import { request, DEMO_TOKEN } from "../api.js";
import { field, emptyState, overflowMenu, confirmDialog, toast, truncate, formatNum } from "../ui.js";
import { announce } from "../a11y.js";
import { renderEditor } from "./editor.js";

const rowMetaCache = new WeakMap();

function getCommandMeta(c) {
  let meta = rowMetaCache.get(c);
  if (!meta) {
    const len = c.text ? c.text.length : 0;
    meta = {
      triggerLower: (c.trigger || "").toLowerCase(),
      groupLower: (c.group || "").toLowerCase(),
      preview60: truncate(c.text, 60),
      preview48: truncate(c.text, 48),
      charsLabel: `${formatNum(len)} chars`,
      textSampleLower: (c.text || "").slice(0, 4096).toLowerCase(),
    };
    rowMetaCache.set(c, meta);
  }
  return meta;
}

function ensureEditableSession() {
  const s = state.health?.state;
  if (s !== "online" && s !== "paused" && s !== "demo") {
    tokenSet(location.origin, DEMO_TOKEN);
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
  } else if (!tokenGet(location.origin)) {
    tokenSet(location.origin, DEMO_TOKEN);
  }
}

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
    const mq = matchMedia("(min-width: 960px)");
    let isDesktop = mq.matches;
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
        ensureEditableSession();
        try {
          const text = await file.text();
          const bundle = JSON.parse(text);
          await request("/api/commands/import", { method: "POST", body: bundle });
          const data = await request("/api/commands");
          if (Array.isArray(data?.commands)) set("commands", data.commands);
          rerender();
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
    let filterTimer = null;

    function renderHead() {
      return h("div", { class: "cmds__head" },
        h("h1", { id: "cmds-h", class: "t-title" }, "Commands"),
        h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } },
          h("button", {
            class: "btn btn--quiet",
            type: "button",
            onClick: () => importInput.click(),
          }, "Import JSON"),
          h("a", { class: "btn btn--primary", href: "/commands/new" }, "Create command")
        )
      );
    }

    function renderCount() {
      const total = state.commands.length;
      let enabled = 0;
      for (let i = 0; i < total; i++) {
        if (state.commands[i].enabled) enabled++;
      }
      return h("p", { class: "cmds__count t-caption", role: "status" },
        `${formatNum(total)} ${total === 1 ? "command" : "commands"} · ${formatNum(enabled)} enabled`);
    }

    function syncFilterSlot() {
      const shouldShow = state.commands.length > 0 || Boolean(state.ui.filter);
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
          placeholder: "Search trigger, text, or group",
          value: state.ui.filter || "",
          oninput: (e) => {
            const val = e.target.value;
            set("ui", { ...state.ui, filter: val });
            clearTimeout(filterTimer);
            filterTimer = setTimeout(updateResultsOnly, 40);
          },
        });
        filterSlot.replaceChildren(field({ id: "filter", label: "Filter commands", control: filterInputEl }));
      } else if (document.activeElement !== filterInputEl && filterInputEl.value !== (state.ui.filter || "")) {
        filterInputEl.value = state.ui.filter || "";
      }
    }

    function renderEmpty() {
      return emptyState({
        title: "No commands yet.",
        body: "A command is a trigger like @sig that pastes a longer block. When you type it and press Space (your current terminator), the text replaces it.",
        example: [h("strong", null, "@sig"), " → ", "Best regards,\nAyesha Khan · Product"],
        primaryLabel: "Create your first command",
        primaryHref: "/commands/new",
        secondary: h("button", {
          class: "btn btn--quiet",
          type: "button",
          onClick: () => importInput.click(),
        }, "Import a JSON file"),
      });
    }

    function renderList() {
      const filter = (state.ui.filter || "").toLowerCase().trim();
      const desc = state.ui.sort === "-trigger";
      const filtered = state.commands.filter((c) => {
        if (!filter) return true;
        const meta = getCommandMeta(c);
        return (
          meta.triggerLower.includes(filter) ||
          meta.groupLower.includes(filter) ||
          meta.textSampleLower.includes(filter)
        );
      }).sort((a, b) => desc ? b.trigger.localeCompare(a.trigger) : a.trigger.localeCompare(b.trigger));

      if (filtered.length === 0 && state.commands.length > 0) {
        return h("p", { class: "t-body", role: "status", style: { color: "var(--on-surface-variant)", marginTop: "var(--space-3)" } }, `No commands match "${state.ui.filter}".`);
      }
      if (state.commands.length === 0) return renderEmpty();

      return isDesktop ? buildTable(filtered) : buildRows(filtered);
    }

    async function toggleCommandEnabled(c) {
      ensureEditableSession();
      const nextEnabled = !c.enabled;
      try {
        const updated = await request(`/api/commands/${c.id}`, {
          method: "PATCH",
          body: { enabled: nextEnabled },
        });
        set("commands", state.commands.map((item) => item.id === c.id ? (updated || { ...item, enabled: nextEnabled }) : item));
        rerender();
        toast({ message: `${c.trigger} ${nextEnabled ? "enabled" : "paused"}` });
        announce(`${c.trigger} ${nextEnabled ? "enabled" : "paused"}`);
      } catch {
        toast({ message: "Couldn't update command status" });
      }
    }

    async function duplicateCommand(c) {
      ensureEditableSession();
      try {
        const copy = {
          trigger: nextUniqueTrigger(c.trigger, state.commands),
          text: c.text,
          enabled: c.enabled,
          ...(c.group ? { group: c.group } : {}),
        };
        const created = await request("/api/commands", { method: "POST", body: copy });
        if (created && !state.commands.some((x) => x.id === created.id)) {
          set("commands", [...state.commands, created]);
        }
        emit("commands:reload");
        rerender();
        toast({ message: `Duplicated as ${copy.trigger}` });
      } catch {
        toast({ message: "Couldn't duplicate command" });
      }
    }

    function buildTable(items) {
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
          h("th", { scope: "col", style: { textAlign: "end" } }, "Actions")
        )),
        h("tbody")
      );
      const tbody = table.querySelector("tbody");
      patchList(tbody, items, {
        key: (c) => c.id,
        create: (c) => buildRow(c, "tr"),
        update: (el, c) => { el.replaceWith(buildRow(c, "tr")); },
      });
      tbody.addEventListener("click", (e) => {
        const row = e.target.closest("tr[data-key]");
        if (!row) return;
        if (e.target.closest("button, a, .menu")) return;
        navigate(`/commands/${encodeURIComponent(row.dataset.key)}`);
      });
      return table;
    }

    function rowMenuItems(c) {
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
        { label: "Edit in editor", onSelect: () => navigate(`/commands/${encodeURIComponent(c.id)}`) },
        {
          label: c.enabled ? "Pause command" : "Enable command",
          onSelect: () => toggleCommandEnabled(c),
        },
        {
          label: "Duplicate",
          onSelect: () => duplicateCommand(c),
        },
        { label: "Delete", danger: true, onSelect: () => confirmDelete(c) },
      ];
    }

    function buildRow(c, tag) {
      const editHref = `/commands/${encodeURIComponent(c.id)}`;
      const meta = getCommandMeta(c);
      return h(tag, { "data-key": c.id, style: { cursor: "pointer" } },
        h("td", null,
          h("div", { class: "table__trigger" },
            h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" } },
              h("a", { href: editHref, class: "code-token", style: { textDecoration: "none" } }, c.trigger),
              c.group ? h("span", { class: "chip", style: { padding: "1px 8px", fontSize: "var(--fs-caption)" } }, c.group) : null
            ),
            h("span", { class: "table__preview" }, meta.preview60)
          )
        ),
        h("td", null, h("span", { class: "t-caption" }, meta.charsLabel)),
        h("td", null,
          h("button", {
            type: "button",
            class: "btn btn--quiet table__status",
            title: c.enabled ? "Click to pause command" : "Click to enable command",
            onClick: (e) => {
              e.stopPropagation();
              toggleCommandEnabled(c);
            },
            style: { height: "28px", paddingInline: "var(--space-2)" },
          },
            h("span", { "aria-hidden": "true", style: { width: "8px", height: "8px", borderRadius: "50%", background: c.enabled ? "var(--success)" : "var(--on-surface-variant)" } }),
            c.enabled ? "Enabled" : "Paused"
          )
        ),
        h("td", { class: "table__actions" },
          h("div", { style: { display: "inline-flex", alignItems: "center", gap: "var(--space-1)", justifyContent: "flex-end" } },
            h("a", { class: "btn btn--quiet", href: editHref, style: { height: "30px", paddingInline: "var(--space-2)", textDecoration: "none" } }, "Edit"),
            h("button", {
              class: "btn btn--quiet",
              type: "button",
              style: { height: "30px", paddingInline: "var(--space-2)", color: "var(--danger)" },
              onClick: (e) => {
                e.stopPropagation();
                confirmDelete(c);
              },
            }, "Delete"),
            overflowMenu(rowMenuItems(c))
          )
        )
      );
    }

    function buildRows(items) {
      const list = h("ul", { class: "rows", role: "list" });
      patchList(list, items, {
        key: (c) => c.id,
        create: (c) => {
          const editHref = `/commands/${encodeURIComponent(c.id)}`;
          const meta = getCommandMeta(c);
          return h("li", { "data-key": c.id },
            h("div", {
              class: "row",
              style: { cursor: "pointer" },
              onClick: (e) => {
                if (e.target.closest("button, a, .menu")) return;
                navigate(editHref);
              },
            },
              h("div", { class: "row__body" },
                h("div", { class: "row__trigger", style: { flexWrap: "wrap" } },
                  h("a", { href: editHref, class: "code-token", style: { textDecoration: "none" } }, c.trigger),
                  c.group ? h("span", { class: "chip", style: { padding: "1px 8px", fontSize: "var(--fs-caption)" } }, c.group) : null,
                  h("button", {
                    type: "button",
                    class: "btn btn--quiet t-caption",
                    style: { height: "24px", paddingInline: "var(--space-2)" },
                    onClick: (e) => {
                      e.stopPropagation();
                      toggleCommandEnabled(c);
                    },
                  }, c.enabled ? "Enabled" : "Paused")
                ),
                h("div", { class: "row__preview" }, meta.preview48)
              ),
              h("div", { style: { display: "inline-flex", alignItems: "center", gap: "var(--space-1)" } },
                h("a", { class: "btn btn--quiet", href: editHref, style: { height: "30px", paddingInline: "var(--space-2)", textDecoration: "none" } }, "Edit"),
                overflowMenu(rowMenuItems(c))
              )
            )
          );
        },
        update: (el, c) => { el.replaceWith(buildRows([c]).firstChild); },
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
          ensureEditableSession();
          try {
            await request(`/api/commands/${encodeURIComponent(c.id)}`, { method: "DELETE" });
            const snapshot = c;
            set("commands", state.commands.filter((x) => x.id !== c.id));
            rerender();
            toast({
              message: `Deleted ${c.trigger}`,
              actionLabel: "Undo",
              onAction: async () => {
                try {
                  const restored = await request("/api/commands", {
                    method: "POST",
                    body: {
                      trigger: snapshot.trigger,
                      text: snapshot.text,
                      enabled: snapshot.enabled,
                      ...(snapshot.group ? { group: snapshot.group } : {}),
                    },
                  });
                  if (restored && !state.commands.some((x) => x.id === restored.id)) {
                    set("commands", [...state.commands, restored]);
                  }
                  emit("commands:reload");
                  emit("commands:changed");
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

    const onMediaChange = (e) => {
      isDesktop = e.matches;
      updateResultsOnly();
    };
    mq.addEventListener("change", onMediaChange);

    let lastHealthState = state.health?.state;
    const unsubs = [
      onState("commands:changed", rerender),
      onState("commands:reload", async () => {
        try {
          const data = await request("/api/commands");
          set("commands", data?.commands || []);
          rerender();
        } catch {}
      }),
      onState("state:health", ({ detail }) => {
        const nextState = detail.value?.state;
        if (nextState !== lastHealthState) {
          lastHealthState = nextState;
          rerender();
        }
      }),
    ];

    rerender();

    try {
      const data = await request("/api/commands");
      if (Array.isArray(data?.commands)) {
        set("commands", data.commands);
        rerender();
      }
    } catch {}

    return {
      title: "Commands",
      unmount() {
        clearTimeout(filterTimer);
        mq.removeEventListener("change", onMediaChange);
        for (const off of unsubs) off();
      },
    };
  },
};

route("/", routeScreen);
route("/commands/new", { mount: (ctx) => renderEditor(ctx, { mode: "new" }) });
route("/commands/:id", { mount: (ctx) => renderEditor(ctx, { mode: "edit" }) });

export default routeScreen;