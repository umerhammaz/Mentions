import { h } from "../dom.js";
import { state, set, on as onState, emit, commandBodyCache } from "../store.js";
import { route, navigate } from "../router.js";
import { request } from "../api.js";
import { overflowMenu, confirmDialog, toast, truncate, formatNum, formatDate } from "../ui.js";
import { announce } from "../a11y.js";
import { renderEditor } from "./editor.js";

const ROW_H = 60;
const rowMetaCache = new WeakMap();

function getCommandMeta(c) {
  let meta = rowMetaCache.get(c);
  if (!meta) {
    const hasFull = typeof c.text === "string";
    const text = hasFull ? c.text : (c.preview || "");
    const lines = typeof c.lines === "number" ? c.lines : (text ? text.split(/\r\n|\r|\n/).length : 0);
    const words = typeof c.words === "number" ? c.words : (text.trim() ? text.trim().split(/\s+/).length : 0);
    const chars = typeof c.chars === "number" ? c.chars : text.length;
    meta = {
      triggerLower: (c.trigger || "").toLowerCase(),
      groupLower: (c.group || "").toLowerCase(),
      preview: hasFull ? truncate(text, 72) : (c.preview || ""),
      lines,
      words,
      chars,
      charsLabel: `${formatNum(lines)}L · ${formatNum(chars)}c`,
      previewLower: (hasFull ? text.slice(0, 4096) : (c.preview || "")).toLowerCase(),
    };
    rowMetaCache.set(c, meta);
  }
  return meta;
}

async function loadCommandBody(c) {
  if (!c) return "";
  if (typeof c.text === "string") return c.text;
  if (commandBodyCache.has(c.id)) return commandBodyCache.get(c.id);
  const full = await request(`/api/commands/${encodeURIComponent(c.id)}`);
  const text = full?.text || "";
  commandBodyCache.set(c.id, text);
  return text;
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

function toSummary(c) {
  if (typeof c.text !== "string") return c;
  const lines = c.text ? c.text.split("\n").length : 0;
  const words = c.text.trim() ? c.text.trim().split(/\s+/).length : 0;
  return {
    id: c.id,
    trigger: c.trigger,
    enabled: c.enabled,
    ...(c.group ? { group: c.group } : {}),
    preview: truncate(c.text, 72),
    lines,
    words,
    chars: c.text.length,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

const routeScreen = {
  title: "Commands",
  async mount({ root }) {
    const mqDesktop = matchMedia("(min-width: 1040px)");
    let isDesktop = mqDesktop.matches;
    let activeTab = "all";
    let showSandbox = false;
    let showWhitespace = false;
    let filterTimer = null;
    let deepSearchTimer = null;
    let deepMatchQuery = "";
    let deepMatchIds = new Set();

    let currentFiltered = [];
    let renderVersion = 0;
    let lastSliceKey = "";
    let listScrollEl = null;
    let spacerEl = null;
    let viewportEl = null;
    let inspectorEl = null;
    let inspectorSeq = 0;

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
          const data = await request("/api/commands?view=summary");
          commandBodyCache.clear();
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
    let tabsHostEl = null;
    let sandboxArea = null;

    function computeFiltered() {
      const filter = (state.ui.filter || "").toLowerCase().trim();
      const desc = state.ui.sort === "-trigger";
      const useDeep = filter.length >= 2 && deepMatchQuery === filter;
      return state.commands.filter((c) => {
        if (activeTab === "__enabled" && !c.enabled) return false;
        if (activeTab === "__paused" && c.enabled) return false;
        if (activeTab !== "all" && activeTab !== "__enabled" && activeTab !== "__paused") {
          if ((c.group || "").toLowerCase() !== activeTab.toLowerCase()) return false;
        }
        if (!filter) return true;
        if (useDeep && deepMatchIds.has(c.id)) return true;
        const meta = getCommandMeta(c);
        return (
          meta.triggerLower.includes(filter) ||
          meta.groupLower.includes(filter) ||
          meta.previewLower.includes(filter)
        );
      }).sort((a, b) => desc ? b.trigger.localeCompare(a.trigger) : a.trigger.localeCompare(b.trigger));
    }

    function scheduleDeepSearch(rawFilter) {
      clearTimeout(deepSearchTimer);
      const q = rawFilter.toLowerCase().trim();
      if (q.length < 2) {
        deepMatchQuery = "";
        deepMatchIds.clear();
        return;
      }
      deepSearchTimer = setTimeout(async () => {
        try {
          const res = await request(`/api/commands/search?q=${encodeURIComponent(q)}`);
          if ((state.ui.filter || "").toLowerCase().trim() !== q) return;
          deepMatchQuery = q;
          deepMatchIds = new Set(Array.isArray(res?.ids) ? res.ids : []);
          renderBodyOnly(true);
        } catch {}
      }, 150);
    }

    function renderHead() {
      const total = state.commands.length;
      let enabled = 0;
      for (const c of state.commands) if (c.enabled) enabled++;
      return h("div", { class: "cmds__head" },
        h("div", { class: "cmds__title-group" },
          h("h1", { id: "cmds-h", class: "t-headline" }, "Commands"),
          h("span", { class: "t-caption cmds__count", role: "status" },
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
        id: "sandbox-input",
        class: "textarea cmds__sandbox-input",
        placeholder: `Type any @trigger followed by ${termKey} here...`,
        onKeydown: async (e) => {
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
          const endPos = sandboxArea.selectionEnd ?? pos;
          let expanded = "";
          try { expanded = await loadCommandBody(hit); } catch { return; }
          const curVal = sandboxArea.value;
          sandboxArea.value = curVal.slice(0, start) + expanded + curVal.slice(endPos);
          const nextPos = start + expanded.length;
          sandboxArea.setSelectionRange(nextPos, nextPos);
          announce(`Expanded ${hit.trigger}`);
        },
      });
      sandboxSlot.replaceChildren(
        h("div", { class: "cmds__sandbox" },
          h("div", { class: "cmds__sandbox-head" },
            h("label", { class: "t-label", for: "sandbox-input", style: { fontWeight: "600" } }, `Live test box · press ${termKey} after a trigger`),
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
        tabsHostEl = null;
        return;
      }
      if (!searchInputEl) {
        searchInputEl = h("input", {
          id: "filter",
          class: "input",
          type: "text",
          placeholder: "Filter by @trigger, text, or group",
          value: state.ui.filter || "",
          "aria-label": "Filter commands",
          onInput: (e) => {
            const val = e.target.value;
            set("ui", { ...state.ui, filter: val });
            updateSearchDecor();
            clearTimeout(filterTimer);
            filterTimer = setTimeout(() => renderBodyOnly(true), 30);
            scheduleDeepSearch(val);
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
            deepMatchQuery = "";
            deepMatchIds.clear();
            updateSearchDecor();
            renderBodyOnly(true);
            searchInputEl.focus();
          },
        }, "×");
        const desc = state.ui.sort === "-trigger";
        const sortBtn = h("button", {
          class: "btn",
          type: "button",
          onClick: () => {
            const nextDesc = state.ui.sort !== "-trigger";
            set("ui", { ...state.ui, sort: nextDesc ? "-trigger" : "trigger" });
            sortBtn.textContent = nextDesc ? "Trigger ↓" : "Trigger ↑";
            renderBodyOnly(true);
          },
        }, desc ? "Trigger ↓" : "Trigger ↑");
        tabsHostEl = h("div", { class: "cmds__tabs" });
        controlsSlot.replaceChildren(
          h("div", { class: "cmds__search-bar" },
            h("div", { class: "cmds__search-wrap" }, searchInputEl, clearBtnEl),
            sortBtn
          ),
          tabsHostEl
        );
      } else if (document.activeElement !== searchInputEl && searchInputEl.value !== (state.ui.filter || "")) {
        searchInputEl.value = state.ui.filter || "";
        updateSearchDecor();
      }
      renderTabs();
    }

    function updateSearchDecor() {
      if (clearBtnEl) clearBtnEl.hidden = !state.ui.filter;
    }

    function renderTabs() {
      if (!tabsHostEl) return;
      const groups = new Map();
      let pausedCount = 0;
      let enabledCount = 0;
      for (const c of state.commands) {
        if (c.enabled) enabledCount++;
        else pausedCount++;
        const g = (c.group || "").trim();
        if (g && !groups.has(g.toLowerCase())) groups.set(g.toLowerCase(), g);
      }
      const sortedGroups = Array.from(groups.values()).sort((a, b) => a.localeCompare(b));
      if (activeTab !== "all" && activeTab !== "__enabled" && activeTab !== "__paused" && !groups.has(activeTab.toLowerCase())) {
        activeTab = "all";
      }
      const inlineGroups = sortedGroups.slice(0, 6);
      const overflowGroups = sortedGroups.slice(6);

      const tabs = [
        { id: "all", label: `All (${formatNum(state.commands.length)})` },
        { id: "__enabled", label: `Active (${formatNum(enabledCount)})` },
        ...(pausedCount > 0 ? [{ id: "__paused", label: `Paused (${formatNum(pausedCount)})` }] : []),
        ...inlineGroups.map((g) => ({ id: g, label: g })),
      ];

      const nodes = tabs.map((t) =>
        h("button", {
          type: "button",
          class: "tab-btn",
          "aria-pressed": activeTab.toLowerCase() === t.id.toLowerCase() ? "true" : "false",
          onClick: () => {
            activeTab = t.id;
            renderTabs();
            renderBodyOnly(true);
          },
        }, t.label)
      );

      if (overflowGroups.length > 0) {
        const overflowSelected = overflowGroups.some((g) => g.toLowerCase() === activeTab.toLowerCase());
        const select = h("select", {
          class: "tab-select",
          "aria-label": "More groups",
          onchange: (e) => {
            activeTab = e.target.value || "all";
            renderTabs();
            renderBodyOnly(true);
          },
        },
          h("option", { value: "", selected: !overflowSelected }, `More groups (${overflowGroups.length})`),
          ...overflowGroups.map((g) =>
            h("option", { value: g, selected: g.toLowerCase() === activeTab.toLowerCase() }, g)
          )
        );
        nodes.push(select);
      }

      tabsHostEl.replaceChildren(...nodes);
    }

    async function toggleCommandEnabled(c) {
      const nextEnabled = !c.enabled;
      try {
        const updated = await request(`/api/commands/${encodeURIComponent(c.id)}`, {
          method: "PATCH",
          body: { enabled: nextEnabled },
        });
        const nextSummary = updated ? toSummary(updated) : { ...c, enabled: nextEnabled };
        set("commands", state.commands.map((item) => item.id === c.id ? nextSummary : item));
        rerender();
        toast({ message: `${c.trigger} ${nextEnabled ? "enabled" : "paused"}` });
        announce(`${c.trigger} ${nextEnabled ? "enabled" : "paused"}`);
      } catch {
        toast({ message: "Couldn't update command status." });
      }
    }

    async function duplicateCommand(c) {
      try {
        const fullText = await loadCommandBody(c);
        const copy = {
          trigger: nextUniqueTrigger(c.trigger, state.commands),
          text: fullText,
          enabled: c.enabled,
          ...(c.group ? { group: c.group } : {}),
        };
        const created = await request("/api/commands", { method: "POST", body: copy });
        if (created && !state.commands.some((x) => x.id === created.id)) {
          commandBodyCache.set(created.id, created.text || fullText);
          set("commands", [...state.commands, toSummary(created)]);
          set("ui", { ...state.ui, selectedId: created.id });
        }
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
            const fullText = await loadCommandBody(c);
            await request(`/api/commands/${encodeURIComponent(c.id)}`, { method: "DELETE" });
            commandBodyCache.delete(c.id);
            const snapshot = { ...c, text: fullText };
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
                    commandBodyCache.set(restored.id, snapshot.text);
                    set("commands", [...state.commands, toSummary(restored)]);
                  }
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
              const txt = await loadCommandBody(c);
              await navigator.clipboard.writeText(txt);
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

    function selectInPlace(nextCmd) {
      const prevId = state.ui.selectedId;
      set("ui", { ...state.ui, selectedId: nextCmd.id });
      if (viewportEl) {
        for (const el of viewportEl.children) {
          if (el.dataset.key === prevId) el.setAttribute("aria-selected", "false");
          if (el.dataset.key === nextCmd.id) el.setAttribute("aria-selected", "true");
        }
      }
      updateInspector(nextCmd);
    }

    function buildRow(c, selectedId) {
      const meta = getCommandMeta(c);
      const isSelected = isDesktop && c.id === selectedId;
      const editHref = `/commands/${encodeURIComponent(c.id)}`;
      return h("div", {
        class: "cmd-row",
        "data-key": c.id,
        "aria-selected": isSelected ? "true" : "false",
        tabindex: "0",
        onClick: (e) => {
          if (e.target.closest("button, a, label, input, .menu")) return;
          if (isDesktop) {
            selectInPlace(c);
          } else {
            navigate(editHref);
          }
        },
        onDblclick: (e) => {
          if (e.target.closest("button, a, label, input, .menu")) return;
          navigate(editHref);
        },
      },
        h("div", { class: "cmd-row__body" },
          h("div", { class: "cmd-row__top" },
            h("span", { class: "code-token" }, c.trigger),
            c.group ? h("span", { class: "cmd-row__group" }, c.group) : null,
            !c.enabled ? h("span", { class: "chip chip--warning" }, h("span", { class: "chip__dot" }), "Paused") : null
          ),
          h("div", { class: "cmd-row__preview" }, meta.preview)
        ),
        h("div", { class: "cmd-row__side" },
          h("span", { class: "cmd-row__meta" }, meta.charsLabel),
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

    function formatPreviewText(rawText) {
      return showWhitespace
        ? rawText.replace(/ /g, "·").replace(/\t/g, "→   ").replace(/\n/g, "¶\n")
        : rawText;
    }

    function updateInspector(c) {
      if (!inspectorEl || !c) return;
      const seq = ++inspectorSeq;
      const meta = getCommandMeta(c);
      const termKey = terminatorLabel(state.settings?.terminator || "space");
      const updatedLabel = formatDate(c.updatedAt);
      const cachedText = typeof c.text === "string"
        ? c.text
        : (commandBodyCache.has(c.id) ? commandBodyCache.get(c.id) : null);

      const preEl = h("pre", { class: "inspector__preview" },
        cachedText !== null ? (formatPreviewText(cachedText) || "(empty)") : "Loading..."
      );

      inspectorEl.replaceChildren(
        h("div", { class: "inspector__head" },
          h("div", { class: "inspector__title-row" },
            h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" } },
              h("span", { class: "code-token" }, c.trigger),
              c.group ? h("span", { class: "cmd-row__group" }, c.group) : null
            ),
            h("span", { class: `chip ${c.enabled ? "chip--success" : "chip--warning"}` },
              h("span", { class: "chip__dot" }),
              c.enabled ? "Active" : "Paused"
            )
          ),
          h("span", { class: "t-caption" }, `Type ${c.trigger} + ${termKey} to expand`)
        ),
        h("div", { class: "inspector__actions" },
          h("a", { class: "btn btn--primary btn--sm", href: `/commands/${encodeURIComponent(c.id)}` }, "Edit"),
          h("button", {
            class: "btn btn--sm",
            type: "button",
            onClick: async () => {
              try {
                const txt = await loadCommandBody(c);
                await navigator.clipboard.writeText(txt);
                toast({ message: `Copied ${c.trigger}` });
              } catch {
                toast({ message: "Couldn't copy text." });
              }
            },
          }, "Copy"),
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
              updateInspector(c);
            },
          }, showWhitespace ? "Hide marks" : "Show marks")
        ),
        preEl,
        h("div", { class: "meta", style: { justifyContent: "space-between", flexWrap: "wrap" } },
          h("span", null, `${formatNum(meta.lines)} lines · ${formatNum(meta.words)} words · ${formatNum(meta.chars)} chars`),
          updatedLabel ? h("span", null, `Updated ${updatedLabel}`) : null
        )
      );

      if (cachedText === null) {
        loadCommandBody(c).then((fullText) => {
          if (seq !== inspectorSeq || !preEl.isConnected) return;
          preEl.textContent = formatPreviewText(fullText) || "(empty)";
        }).catch(() => {
          if (seq === inspectorSeq && preEl.isConnected) {
            preEl.textContent = c.preview || "";
          }
        });
      }
    }

    let scrollFrame = 0;

    function renderWindow(force = false) {
      if (!listScrollEl || !viewportEl || !spacerEl) return;
      const total = currentFiltered.length;
      spacerEl.style.height = `${total * ROW_H}px`;
      const viewH = listScrollEl.clientHeight || 540;
      const scrollTop = listScrollEl.scrollTop || 0;
      const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
      const count = Math.ceil(viewH / ROW_H) + 8;
      const end = Math.min(total, start + count);
      const sig = `${start}:${end}:${renderVersion}:${isDesktop}`;
      if (!force && sig === lastSliceKey) return;
      lastSliceKey = sig;
      viewportEl.style.transform = `translateY(${start * ROW_H}px)`;
      const nodes = [];
      for (let i = start; i < end; i++) {
        nodes.push(buildRow(currentFiltered[i], state.ui.selectedId));
      }
      viewportEl.replaceChildren(...nodes);
    }

    function ensureListShell() {
      if (listScrollEl && bodySlot.contains(listScrollEl)) return;
      spacerEl = h("div", { class: "cmds__spacer" });
      viewportEl = h("div", { class: "cmds__viewport", role: "list" });
      spacerEl.append(viewportEl);
      listScrollEl = h("div", {
        class: "cmds__list-scroll",
        onScroll: () => {
          if (scrollFrame) return;
          scrollFrame = requestAnimationFrame(() => {
            scrollFrame = 0;
            renderWindow(false);
          });
        },
      }, spacerEl);
      const listBox = h("div", { class: "cmds__list-box" }, listScrollEl);
      if (isDesktop) {
        inspectorEl = h("aside", { class: "cmds__inspector", "aria-label": "Selected command" });
        bodySlot.replaceChildren(h("div", { class: "cmds__split" }, listBox, inspectorEl));
      } else {
        inspectorEl = null;
        bodySlot.replaceChildren(listBox);
      }
    }

    function renderBodyOnly(resetScroll = false) {
      if (state.commands.length === 0) {
        listScrollEl = null;
        inspectorEl = null;
        const termKey = terminatorLabel(state.settings?.terminator || "space");
        bodySlot.replaceChildren(
          h("div", { class: "empty" },
            h("h2", { class: "t-title" }, "No commands yet"),
            h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
              `Create a trigger like @sig. Type it and press ${termKey} in any Windows app to replace it.`
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

      currentFiltered = computeFiltered();
      renderVersion++;
      if (currentFiltered.length === 0) {
        listScrollEl = null;
        inspectorEl = null;
        bodySlot.replaceChildren(
          h("div", { class: "settings__card", style: { maxWidth: "480px" } },
            h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } },
              "No commands match your filter."
            ),
            h("div", null,
              h("button", {
                class: "btn btn--sm",
                type: "button",
                onClick: () => {
                  activeTab = "all";
                  set("ui", { ...state.ui, filter: "" });
                  deepMatchQuery = "";
                  deepMatchIds.clear();
                  if (searchInputEl) searchInputEl.value = "";
                  updateSearchDecor();
                  renderTabs();
                  renderBodyOnly(true);
                },
              }, "Reset filters")
            )
          )
        );
        return;
      }

      let selected = currentFiltered.find((c) => c.id === state.ui.selectedId);
      if (!selected) {
        selected = currentFiltered[0];
        set("ui", { ...state.ui, selectedId: selected.id });
      }

      ensureListShell();
      if (resetScroll && listScrollEl) listScrollEl.scrollTop = 0;
      renderWindow(true);
      if (isDesktop) updateInspector(selected);
    }

    function rerender() {
      renderHeadSlot();
      syncControls();
      renderBodyOnly(false);
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
        if (!currentFiltered.length) return;
        e.preventDefault();
        const idx = currentFiltered.findIndex((c) => c.id === state.ui.selectedId);
        const nextIdx = e.key === "ArrowDown"
          ? Math.min((idx === -1 ? 0 : idx + 1), currentFiltered.length - 1)
          : Math.max((idx === -1 ? 0 : idx - 1), 0);
        const nextCmd = currentFiltered[nextIdx];
        if (listScrollEl) {
          const top = nextIdx * ROW_H;
          const bottom = top + ROW_H;
          if (top < listScrollEl.scrollTop) {
            listScrollEl.scrollTop = top;
            renderWindow(true);
          } else if (bottom > listScrollEl.scrollTop + listScrollEl.clientHeight) {
            listScrollEl.scrollTop = bottom - listScrollEl.clientHeight;
            renderWindow(true);
          }
        }
        selectInPlace(nextCmd);
      } else if (e.key === "Enter" && state.ui.selectedId && !document.activeElement?.closest("button, a")) {
        navigate(`/commands/${encodeURIComponent(state.ui.selectedId)}`);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    const onMediaChange = (e) => {
      isDesktop = e.matches;
      listScrollEl = null;
      renderBodyOnly(false);
    };
    mqDesktop.addEventListener("change", onMediaChange);

    const unsubs = [
      onState("commands:changed", rerender),
      onState("commands:reload", async () => {
        try {
          const data = await request("/api/commands?view=summary");
          commandBodyCache.clear();
          set("commands", data?.commands || []);
          rerender();
        } catch {}
      }),
    ];

    rerender();

    try {
      const data = await request("/api/commands?view=summary");
      if (Array.isArray(data?.commands)) {
        set("commands", data.commands);
        rerender();
      }
    } catch {}

    return {
      title: "Commands",
      unmount() {
        clearTimeout(filterTimer);
        clearTimeout(deepSearchTimer);
        if (scrollFrame) cancelAnimationFrame(scrollFrame);
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