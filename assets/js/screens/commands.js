import { h } from "../dom.js";
import { state, set, on as onState, emit } from "../store.js";
import { route, navigate } from "../router.js";
import { request } from "../api.js";
import { overflowMenu, confirmDialog, toast, truncate, formatNum, formatDate } from "../ui.js";
import { announce } from "../a11y.js";
import { renderEditor } from "./editor.js";

const rowMetaCache = new WeakMap();

function getCommandMeta(c) {
  let meta = rowMetaCache.get(c);
  if (!meta) {
    const text = c.text || "";
    const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    meta = {
      triggerLower: (c.trigger || "").toLowerCase(),
      groupLower: (c.group || "").toLowerCase(),
      preview: truncate(text, 72),
      lines,
      words,
      chars: text.length,
      charsLabel: `${formatNum(lines)} ${lines === 1 ? "line" : "lines"} · ${formatNum(text.length)} chars`,
      textSampleLower: text.slice(0, 4096).toLowerCase(),
    };
    rowMetaCache.set(c, meta);
  }
  return meta;
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

function terminatorLabel(term) {
  if (term === "enter") return "Enter";
  if (term === "tab") return "Tab";
  return "Space";
}

const routeScreen = {
  title: "Commands",
  async mount({ root }) {
    const mqDesktop = matchMedia("(min-width: 1040px)");
    let isDesktop = mqDesktop.matches;
    let activePill = "all";
    let showSandbox = false;
    let showWhitespace = false;
    let filterTimer = null;

    const container = h("section", { class: "cmds", "aria-labelledby": "cmds-h" });
    const headSlot = h("div");
    const sandboxSlot = h("div");
    const controlsSlot = h("div", { class: "cmds__controls" });
    const bodySlot = h("div");

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

    container.append(headSlot, sandboxSlot, controlsSlot, bodySlot, importInput);
    root.replaceChildren(container);

    let searchInputEl = null;
    let clearBtnEl = null;
    let kbdHintEl = null;
    let pillsHostEl = null;
    let sandboxArea = null;

    function getFilteredCommands() {
      const filter = (state.ui.filter || "").toLowerCase().trim();
      const desc = state.ui.sort === "-trigger";
      return state.commands.filter((c) => {
        if (activePill === "__enabled" && !c.enabled) return false;
        if (activePill === "__paused" && c.enabled) return false;
        if (activePill !== "all" && activePill !== "__enabled" && activePill !== "__paused") {
          if ((c.group || "").toLowerCase() !== activePill.toLowerCase()) return false;
        }
        if (!filter) return true;
        const meta = getCommandMeta(c);
        return (
          meta.triggerLower.includes(filter) ||
          meta.groupLower.includes(filter) ||
          meta.textSampleLower.includes(filter)
        );
      }).sort((a, b) => desc ? b.trigger.localeCompare(a.trigger) : a.trigger.localeCompare(b.trigger));
    }

    function renderHead() {
      const total = state.commands.length;
      let enabled = 0;
      for (const c of state.commands) if (c.enabled) enabled++;
      return h("div", { class: "cmds__head" },
        h("div", { class: "cmds__title-group" },
          h("h1", { id: "cmds-h", class: "t-headline" }, "Commands"),
          h("span", { class: "cmds__count-pill", role: "status" },
            `${formatNum(total)} ${total === 1 ? "command" : "commands"} · ${formatNum(enabled)} active`
          )
        ),
        h("div", { class: "cmds__head-actions" },
          h("button", {
            class: "btn",
            type: "button",
            "aria-pressed": showSandbox ? "true" : "false",
            onClick: () => {
              showSandbox = !showSandbox;
              renderSandbox();
              renderHeadSlot();
              if (showSandbox) sandboxArea?.focus();
            },
          }, showSandbox ? "Hide test box" : "Test commands"),
          h("button", {
            class: "btn",
            type: "button",
            onClick: () => importInput.click(),
          }, "Import JSON"),
          h("a", { class: "btn btn--primary", href: "/commands/new" }, "New command")
        )
      );
    }

    function renderHeadSlot() {
      headSlot.replaceChildren(renderHead());
    }

    function renderSandbox() {
      if (!showSandbox) {
        sandboxSlot.replaceChildren();
        sandboxArea = null;
        return;
      }
      const term = state.settings?.terminator || "space";
      const termKey = terminatorLabel(term);
      sandboxArea = h("textarea", {
        class: "textarea cmds__sandbox-input",
        placeholder: `Type any @trigger followed by ${termKey} here to preview how it expands...`,
        onKeydown: (e) => {
          const isMatchKey =
            (term === "enter" && e.key === "Enter" && !e.shiftKey) ||
            (term === "tab" && e.key === "Tab") ||
            (term === "space" && e.key === " ");
          if (!isMatchKey) return;
          const pos = sandboxArea.selectionStart ?? sandboxArea.value.length;
          const before = sandboxArea.value.slice(0, pos);
          const m = before.match(/(@[a-z0-9_-]{1,31})$/i);
          if (!m) return;
          const hit = state.commands.find((c) => c.enabled && c.trigger.toLowerCase() === m[1].toLowerCase());
          if (!hit) return;
          e.preventDefault();
          const start = pos - m[1].length;
          const after = sandboxArea.value.slice(sandboxArea.selectionEnd ?? pos);
          sandboxArea.value = sandboxArea.value.slice(0, start) + hit.text + after;
          const nextPos = start + hit.text.length;
          sandboxArea.setSelectionRange(nextPos, nextPos);
          announce(`Expanded ${hit.trigger}`);
        },
      });
      sandboxSlot.replaceChildren(
        h("div", { class: "cmds__sandbox" },
          h("div", { class: "cmds__sandbox-head" },
            h("span", { class: "t-label", style: { fontWeight: "600" } }, `Live test box · press ${termKey} after a trigger`),
            h("button", {
              class: "btn btn--sm",
              type: "button",
              onClick: () => {
                if (sandboxArea) { sandboxArea.value = ""; sandboxArea.focus(); }
              },
            }, "Clear")
          ),
          sandboxArea
        )
      );
    }

    function syncControls() {
      if (state.commands.length === 0 && !state.ui.filter) {
        controlsSlot.replaceChildren();
        searchInputEl = null;
        pillsHostEl = null;
        return;
      }
      if (!searchInputEl) {
        searchInputEl = h("input", {
          id: "filter",
          class: "input",
          type: "text",
          placeholder: "Search @triggers, text, or groups...",
          value: state.ui.filter || "",
          "aria-label": "Filter commands",
          onInput: (e) => {
            set("ui", { ...state.ui, filter: e.target.value });
            updateSearchDecor();
            clearTimeout(filterTimer);
            filterTimer = setTimeout(renderBodyOnly, 30);
          },
        });
        clearBtnEl = h("button", {
          type: "button",
          class: "cmds__clear-btn",
          title: "Clear search",
          "aria-label": "Clear search",
          hidden: !(state.ui.filter || ""),
          onClick: () => {
            searchInputEl.value = "";
            set("ui", { ...state.ui, filter: "" });
            updateSearchDecor();
            renderBodyOnly();
            searchInputEl.focus();
          },
        }, "×");
        kbdHintEl = h("span", { class: "cmds__kbd", hidden: Boolean(state.ui.filter) }, "/");
        const desc = state.ui.sort === "-trigger";
        const sortBtn = h("button", {
          class: "btn",
          type: "button",
          onClick: () => {
            const nextDesc = state.ui.sort !== "-trigger";
            set("ui", { ...state.ui, sort: nextDesc ? "-trigger" : "trigger" });
            sortBtn.textContent = nextDesc ? "Sort: Z → A" : "Sort: A → Z";
            renderBodyOnly();
          },
        }, desc ? "Sort: Z → A" : "Sort: A → Z");
        pillsHostEl = h("div", { class: "cmds__pills" });
        controlsSlot.replaceChildren(
          h("div", { class: "cmds__search-bar" },
            h("div", { class: "cmds__search-wrap" }, searchInputEl, kbdHintEl, clearBtnEl),
            sortBtn
          ),
          pillsHostEl
        );
      } else if (document.activeElement !== searchInputEl && searchInputEl.value !== (state.ui.filter || "")) {
        searchInputEl.value = state.ui.filter || "";
        updateSearchDecor();
      }
      renderPills();
    }

    function updateSearchDecor() {
      const hasText = Boolean(state.ui.filter);
      if (clearBtnEl) clearBtnEl.hidden = !hasText;
      if (kbdHintEl) kbdHintEl.hidden = hasText;
    }

    function renderPills() {
      if (!pillsHostEl) return;
      const groups = new Map();
      let pausedCount = 0;
      let enabledCount = 0;
      for (const c of state.commands) {
        if (c.enabled) enabledCount++;
        else pausedCount++;
        const g = (c.group || "").trim();
        if (g && !groups.has(g.toLowerCase())) groups.set(g.toLowerCase(), g);
      }
      if (activePill !== "all" && activePill !== "__enabled" && activePill !== "__paused" && !groups.has(activePill.toLowerCase())) {
        activePill = "all";
      }
      const pills = [
        { id: "all", label: `All (${state.commands.length})` },
        { id: "__enabled", label: `Active (${enabledCount})` },
        ...(pausedCount > 0 ? [{ id: "__paused", label: `Paused (${pausedCount})` }] : []),
        ...Array.from(groups.values()).sort((a, b) => a.localeCompare(b)).map((g) => ({ id: g, label: g })),
      ];
      pillsHostEl.replaceChildren(
        ...pills.map((p) =>
          h("button", {
            type: "button",
            class: "pill",
            "aria-pressed": activePill.toLowerCase() === p.id.toLowerCase() ? "true" : "false",
            onClick: () => {
              activePill = p.id;
              renderPills();
              renderBodyOnly();
            },
          }, p.label)
        )
      );
    }

    async function toggleCommandEnabled(c) {
      const nextEnabled = !c.enabled;
      try {
        const updated = await request(`/api/commands/${encodeURIComponent(c.id)}`, {
          method: "PATCH",
          body: { enabled: nextEnabled },
        });
        set("commands", state.commands.map((item) => item.id === c.id ? (updated || { ...item, enabled: nextEnabled }) : item));
        rerender();
        toast({ message: `${c.trigger} ${nextEnabled ? "enabled" : "paused"}` });
        announce(`${c.trigger} ${nextEnabled ? "enabled" : "paused"}`);
      } catch {
        toast({ message: "Couldn't update command status." });
      }
    }

    async function duplicateCommand(c) {
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
          set("ui", { ...state.ui, selectedId: created.id });
        }
        emit("commands:reload");
        rerender();
        toast({ message: `Duplicated as ${copy.trigger}` });
      } catch {
        toast({ message: "Couldn't duplicate command." });
      }
    }

    function confirmDelete(c) {
      confirmDialog({
        title: `Delete ${c.trigger}?`,
        body: "It will stop expanding immediately. You can undo this for a few seconds afterwards.",
        confirmLabel: "Delete command",
        danger: true,
        onConfirm: async () => {
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
            toast({ message: "Couldn't delete command." });
          }
        },
      });
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
              toast({ message: "Couldn't copy text." });
            }
          },
        },
        { label: "Edit command", onSelect: () => navigate(`/commands/${encodeURIComponent(c.id)}`) },
        { label: c.enabled ? "Pause command" : "Enable command", onSelect: () => toggleCommandEnabled(c) },
        { label: "Duplicate", onSelect: () => duplicateCommand(c) },
        { label: "Delete", danger: true, onSelect: () => confirmDelete(c) },
      ];
    }

    function buildCard(c, selectedId) {
      const meta = getCommandMeta(c);
      const isSelected = isDesktop && c.id === selectedId;
      const editHref = `/commands/${encodeURIComponent(c.id)}`;
      return h("div", {
        class: "cmd-card",
        "data-key": c.id,
        "aria-selected": isSelected ? "true" : "false",
        tabindex: "0",
        onClick: (e) => {
          if (e.target.closest("button, a, label, input, .menu")) return;
          if (isDesktop) {
            set("ui", { ...state.ui, selectedId: c.id });
            renderBodyOnly();
          } else {
            navigate(editHref);
          }
        },
        onDblclick: (e) => {
          if (e.target.closest("button, a, label, input, .menu")) return;
          navigate(editHref);
        },
      },
        h("div", { class: "cmd-card__body" },
          h("div", { class: "cmd-card__top" },
            h("span", { class: "code-token" }, c.trigger),
            c.group ? h("span", { class: "chip", style: { background: "var(--surface-container-high)", borderRadius: "var(--radius-pill)", padding: "2px 8px" } }, c.group) : null,
            !c.enabled ? h("span", { class: "chip chip--warning" }, h("span", { class: "chip__dot" }), "Paused") : null
          ),
          h("div", { class: "cmd-card__preview" }, meta.preview),
          h("div", { class: "cmd-card__meta" }, meta.charsLabel)
        ),
        h("div", { class: "cmd-card__side" },
          h("label", {
            class: "switch",
            title: c.enabled ? "Pause command" : "Enable command",
            onClick: (e) => e.stopPropagation(),
          },
            h("input", {
              type: "checkbox",
              checked: c.enabled,
              "aria-label": `${c.trigger} enabled`,
              onchange: () => toggleCommandEnabled(c),
            }),
            h("span", { class: "switch__track" })
          ),
          overflowMenu(rowMenuItems(c))
        )
      );
    }

    function buildInspector(c) {
      if (!c) return null;
      const meta = getCommandMeta(c);
      const termKey = terminatorLabel(state.settings?.terminator || "space");
      const rawText = c.text || "";
      const displayText = showWhitespace
        ? rawText.replace(/ /g, "·").replace(/\t/g, "→   ").replace(/\n/g, "¶\n")
        : rawText;

      return h("aside", { class: "cmds__inspector", "aria-label": "Selected command" },
        h("div", { class: "inspector__head" },
          h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
            h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" } },
              h("span", { class: "code-token" }, c.trigger),
              c.group ? h("span", { class: "chip", style: { background: "var(--surface-container-high)", borderRadius: "var(--radius-pill)", padding: "2px 8px" } }, c.group) : null,
              h("span", { class: `chip ${c.enabled ? "chip--success" : "chip--warning"}` },
                h("span", { class: "chip__dot" }),
                c.enabled ? "Active" : "Paused"
              )
            ),
            h("span", { class: "t-caption" }, `Type ${c.trigger} + ${termKey} anywhere to paste`)
          )
        ),
        h("div", { class: "inspector__actions" },
          h("a", { class: "btn btn--primary btn--sm", href: `/commands/${encodeURIComponent(c.id)}` }, "Edit command"),
          h("button", {
            class: "btn btn--sm",
            type: "button",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(c.text);
                toast({ message: `Copied ${c.trigger}` });
              } catch {
                toast({ message: "Couldn't copy text." });
              }
            },
          }, "Copy text"),
          h("button", { class: "btn btn--sm", type: "button", onClick: () => duplicateCommand(c) }, "Duplicate"),
          h("button", {
            class: "btn btn--sm btn--danger-outline",
            type: "button",
            style: { marginLeft: "auto" },
            onClick: () => confirmDelete(c),
          }, "Delete")
        ),
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
          h("span", { class: "t-caption" }, "Preset text"),
          h("button", {
            class: "btn btn--quiet btn--sm",
            type: "button",
            onClick: () => {
              showWhitespace = !showWhitespace;
              renderBodyOnly();
            },
          }, showWhitespace ? "Hide marks" : "Show spaces & breaks")
        ),
        h("pre", { class: "inspector__preview" }, displayText || "(empty)"),
        h("div", { class: "meta", style: { justifyContent: "space-between", flexWrap: "wrap" } },
          h("span", null, `${formatNum(meta.lines)} lines · ${formatNum(meta.words)} words · ${formatNum(meta.chars)} chars`),
          c.updatedAt ? h("span", null, `Updated ${formatDate(c.updatedAt)}`) : null
        )
      );
    }

    function renderBodyOnly() {
      if (state.commands.length === 0) {
        const termKey = terminatorLabel(state.settings?.terminator || "space");
        bodySlot.replaceChildren(
          h("div", { class: "empty" },
            h("h2", { class: "t-title" }, "No commands yet"),
            h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
              `Create a trigger like @sig. Whenever you type it and press ${termKey}, your saved text replaces it in any app.`
            ),
            h("div", { class: "empty__example" }, h("strong", null, "@sig"), " → Best regards,\nAyesha Khan · Product"),
            h("div", { class: "empty__actions" },
              h("a", { class: "btn btn--primary", href: "/commands/new" }, "Create your first command"),
              h("button", { class: "btn", type: "button", onClick: () => importInput.click() }, "Import JSON")
            )
          )
        );
        return;
      }

      const filtered = getFilteredCommands();
      if (filtered.length === 0) {
        bodySlot.replaceChildren(
          h("div", { class: "settings__card", style: { maxWidth: "520px" } },
            h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
              "No commands match your filter."
            ),
            h("div", null,
              h("button", {
                class: "btn btn--sm",
                type: "button",
                onClick: () => {
                  activePill = "all";
                  set("ui", { ...state.ui, filter: "" });
                  if (searchInputEl) searchInputEl.value = "";
                  updateSearchDecor();
                  renderPills();
                  renderBodyOnly();
                },
              }, "Reset filters")
            )
          )
        );
        return;
      }

      let selected = filtered.find((c) => c.id === state.ui.selectedId);
      if (!selected) {
        selected = filtered[0];
        set("ui", { ...state.ui, selectedId: selected.id });
      }

      const listEl = h("div", { class: "cmds__list", role: "list" },
        ...filtered.map((c) => buildCard(c, selected.id))
      );

      if (isDesktop) {
        bodySlot.replaceChildren(
          h("div", { class: "cmds__split" }, listEl, buildInspector(selected))
        );
      } else {
        bodySlot.replaceChildren(listEl);
      }
    }

    function rerender() {
      renderHeadSlot();
      syncControls();
      renderBodyOnly();
    }

    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputEl?.focus();
        searchInputEl?.select();
        return;
      }
      if (inField) return;
      if (e.key === "/") {
        e.preventDefault();
        searchInputEl?.focus();
      } else if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        navigate("/commands/new");
      } else if (isDesktop && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const list = getFilteredCommands();
        if (!list.length) return;
        e.preventDefault();
        const idx = list.findIndex((c) => c.id === state.ui.selectedId);
        const nextIdx = e.key === "ArrowDown"
          ? Math.min((idx === -1 ? 0 : idx + 1), list.length - 1)
          : Math.max((idx === -1 ? 0 : idx - 1), 0);
        set("ui", { ...state.ui, selectedId: list[nextIdx].id });
        renderBodyOnly();
      } else if (e.key === "Enter" && state.ui.selectedId && !document.activeElement?.closest("button, a")) {
        navigate(`/commands/${encodeURIComponent(state.ui.selectedId)}`);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    const onMediaChange = (e) => {
      isDesktop = e.matches;
      renderBodyOnly();
    };
    mqDesktop.addEventListener("change", onMediaChange);

    const unsubs = [
      onState("commands:changed", rerender),
      onState("commands:reload", async () => {
        try {
          const data = await request("/api/commands");
          set("commands", data?.commands || []);
          rerender();
        } catch {}
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
        document.removeEventListener("keydown", onKeyDown);
        mqDesktop.removeEventListener("change", onMediaChange);
        for (const off of unsubs) off();
      },
    };
  },
};

route("/", routeScreen);
route("/commands/new", { mount: (ctx) => renderEditor(ctx, { mode: "new" }) });
route("/commands/:id", { mount: (ctx) => renderEditor(ctx, { mode: "edit" }) });

export default routeScreen;