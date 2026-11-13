import { h, useIcon } from "../dom.js";
import { state, set, emit } from "../store.js";
import { request, ApiError } from "../api.js";
import { navigate } from "../router.js";
import { field, primaryButton, confirmDialog, toast, truncate, formatNum } from "../ui.js";
import { focusFirstInvalid, announce } from "../a11y.js";

const TRIGGER_RE = /^@[a-z0-9_-]{1,31}$/;
const MAX_TEXT = 65536;
const FAST_PREVIEW_LIMIT = 4000;
const MAX_TEXT_LABEL = formatNum(MAX_TEXT);

function normalizeTrigger(raw) {
  const cleaned = String(raw || "").trim().replace(/^@+/, "").toLowerCase();
  return cleaned ? `@${cleaned}` : "@";
}

function terminatorName() {
  const t = state.settings?.terminator;
  if (t === "enter") return "Enter";
  if (t === "tab") return "Tab";
  return "Space";
}

export async function renderEditor({ root, params }, { mode }) {
  const isNew = mode === "new";
  const container = h("section", { class: "editor", "aria-labelledby": "editor-h" });
  root.replaceChildren(container);

  if (!isNew && state.commands.length === 0) {
    try {
      const data = await request("/api/commands");
      if (Array.isArray(data?.commands)) set("commands", data.commands);
    } catch {}
  }

  let existing = !isNew ? state.commands.find((c) => c.id === params.id) : null;
  if (!isNew && !existing) {
    try {
      const fetched = await request(`/api/commands/${encodeURIComponent(params.id)}`);
      if (fetched?.id) {
        existing = fetched;
        set("commands", [...state.commands.filter((c) => c.id !== fetched.id), fetched]);
      }
    } catch {}
  }

  if (!isNew && !existing) {
    container.replaceChildren(
      h("div", { class: "settings__card", style: { maxWidth: "480px" } },
        h("h1", { id: "editor-h", class: "t-title" }, "Command not found"),
        h("p", { class: "t-body", style: { color: "var(--on-surface-variant)" } }, "This command may have been deleted."),
        h("div", null, h("a", { class: "btn btn--primary", href: "/" }, "Back to Commands"))
      )
    );
    return { title: "Command not found", unmount() {} };
  }

  const draft = {
    trigger: existing?.trigger || "@",
    text: existing?.text || "",
    group: existing?.group || "",
    enabled: existing?.enabled ?? true,
  };

  set("ui", { ...state.ui, dirty: false });

  let isFullScreen = false;
  let activeTab = "write";
  let showFullPreview = false;
  let countFrame = 0;

  const existingGroups = Array.from(
    new Set(state.commands.map((c) => (c.group || "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const onBeforeUnload = (e) => {
    if (state.ui.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  const heading = isNew ? "Create command" : `Edit ${existing.trigger}`;
  const dirtyBadge = h("span", { class: "editor__dirty-pill", hidden: true }, "Unsaved changes");
  const triggerErrSlot = h("div");
  const textErrSlot = h("div");
  const hintPill = h("div", { class: "editor__hint-pill" });
  const previewHost = h("div", { class: "preview", hidden: true });
  const previewMoreSlot = h("div", { hidden: true });
  const panesHost = h("div", { class: "editor__panes" });
  const statsLabel = h("span", { class: "t-caption t-mono" });

  const triggerInput = h("input", {
    id: "trigger",
    class: "input",
    type: "text",
    value: draft.trigger.replace(/^@+/, ""),
    maxlength: "31",
    placeholder: "sig",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    onInput: (e) => {
      const stripped = e.target.value.replace(/^@+/, "").toLowerCase();
      if (e.target.value !== stripped) e.target.value = stripped;
      draft.trigger = stripped ? `@${stripped}` : "@";
      markDirty();
      updateLiveMeta();
      const err = triggerError();
      if (triggerInput.getAttribute("aria-invalid") === "true" || !err) setFieldError("trigger", err);
    },
    onBlur: () => {
      const err = triggerError();
      setFieldError("trigger", err);
      if (err) announce(err);
    },
  });

  const textArea = h("textarea", {
    id: "text",
    class: "textarea",
    rows: "14",
    placeholder: "Write the exact text to paste...",
    spellcheck: "false",
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    onInput: () => {
      markDirty();
      scheduleMetaUpdate();
      if (textArea.getAttribute("aria-invalid") === "true") {
        const len = textArea.value.length;
        if (len > 0 && len <= MAX_TEXT) setFieldError("text", null);
      }
    },
    onBlur: () => {
      syncTextFromInput();
      const err = textError();
      setFieldError("text", err);
      if (err) announce(err);
    },
  });
  textArea.value = draft.text;

  const groupDatalist = h("datalist", { id: "existing-groups" },
    ...existingGroups.map((g) => h("option", { value: g }))
  );

  const groupInput = h("input", {
    id: "group",
    class: "input",
    type: "text",
    list: "existing-groups",
    placeholder: "e.g. Email, Work, Prompts",
    value: draft.group,
    onInput: (e) => {
      draft.group = e.target.value;
      markDirty();
    },
  });

  const enabledSwitch = h("label", { class: "switch" },
    h("input", {
      type: "checkbox",
      checked: draft.enabled,
      onchange: (e) => {
        draft.enabled = e.target.checked;
        markDirty();
      },
    }),
    h("span", { class: "switch__track" }),
    h("span", { class: "t-body" }, "Expands when typed")
  );

  const writeTabBtn = h("button", {
    type: "button",
    class: "editor__tab",
    role: "tab",
    "aria-selected": "true",
    onClick: () => switchTab("write"),
  }, "Write");

  const splitTabBtn = h("button", {
    type: "button",
    class: "editor__tab",
    role: "tab",
    "aria-selected": "false",
    onClick: () => switchTab("split"),
  }, "Split");

  const previewTabBtn = h("button", {
    type: "button",
    class: "editor__tab",
    role: "tab",
    "aria-selected": "false",
    onClick: () => switchTab("preview"),
  }, "Preview");

  const fullScreenBtn = h("button", {
    type: "button",
    class: "btn btn--sm",
    onClick: () => {
      isFullScreen = !isFullScreen;
      container.classList.toggle("editor--full", isFullScreen);
      fullScreenBtn.textContent = isFullScreen ? "Exit full screen" : "Full screen";
      textArea.focus();
    },
  }, "Full screen");

  const copyPromptBtn = h("button", {
    type: "button",
    class: "btn btn--sm",
    onClick: async () => {
      syncTextFromInput();
      try {
        await navigator.clipboard.writeText(draft.text);
        toast({ message: "Prompt copied." });
      } catch {
        toast({ message: "Couldn't copy prompt." });
      }
    },
  }, "Copy prompt");

  const submitBtn = primaryButton(isNew ? "Create command" : "Save changes", null, { type: "submit" });

  const triggerField = field({
    id: "trigger",
    label: "Trigger",
    help: "Lowercase letters, numbers, - and _, up to 31 characters after @.",
    required: true,
    control: h("div", { class: "input-affix" }, h("span", { class: "input-affix__prefix" }, "@"), triggerInput),
  });
  triggerField.append(triggerErrSlot);

  const groupChips = existingGroups.length > 0
    ? h("div", { class: "editor__group-chips" },
        ...existingGroups.slice(0, 6).map((g) =>
          h("button", {
            type: "button",
            class: "pill",
            onClick: () => {
              groupInput.value = g;
              draft.group = g;
              markDirty();
            },
          }, g)
        )
      )
    : null;

  const groupField = field({
    id: "group",
    label: "Group",
    help: "Optional label to group commands.",
    optional: true,
    control: h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      groupInput,
      groupDatalist,
      groupChips
    ),
  });

  const editorToolbar = h("div", { class: "editor__toolbar" },
    h("div", { class: "editor__tabs", role: "tablist", "aria-label": "Editor mode" }, writeTabBtn, splitTabBtn, previewTabBtn),
    h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } },
      copyPromptBtn,
      fullScreenBtn
    )
  );

  panesHost.append(textArea, previewHost);

  const textField = field({
    id: "text",
    label: "Preset text",
    help: "Saved exactly as typed, including spaces and line breaks.",
    required: true,
    control: h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      editorToolbar,
      panesHost,
      previewMoreSlot
    ),
  });
  textField.append(textErrSlot);

  const form = h("form", { class: "editor__form", novalidate: true, onSubmit },
    h("div", { class: "editor__meta-row" }, triggerField, groupField),
    hintPill,
    textField,
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" } },
      statsLabel,
      enabledSwitch
    ),
    h("div", { class: "editor__actions" },
      !isNew ? h("button", {
        class: "btn btn--danger-outline",
        type: "button",
        style: { marginInlineEnd: "auto" },
        onClick: onDelete,
      }, "Delete command") : null,
      h("a", { class: "btn", href: "/" }, "Cancel"),
      submitBtn
    )
  );

  const head = h("header", { class: "editor__head" },
    h("div", { class: "editor__title-row" },
      h("h1", { id: "editor-h", class: "t-headline" }, heading),
      dirtyBadge
    ),
    h("a", { class: "btn", href: "/" }, "Back to Commands")
  );

  container.replaceChildren(head, form);
  updateLiveMeta();

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === "Escape" && isFullScreen) {
      isFullScreen = false;
      container.classList.remove("editor--full");
      fullScreenBtn.textContent = "Full screen";
    }
  };
  document.addEventListener("keydown", onKeyDown);

  function syncTextFromInput() {
    draft.text = textArea.value;
  }

  function markDirty() {
    dirtyBadge.hidden = false;
    if (!state.ui.dirty) set("ui", { ...state.ui, dirty: true });
  }

  function updateLiveMeta() {
    const val = textArea.value;
    const len = val.length;
    const lines = val ? val.split(/\r\n|\r|\n/).length : 0;
    const words = val.trim() ? val.trim().split(/\s+/).length : 0;
    statsLabel.textContent = `Lines: ${formatNum(lines)} · Words: ${formatNum(words)} · Chars: ${formatNum(len)} / ${MAX_TEXT_LABEL}`;
    statsLabel.style.color = len > MAX_TEXT ? "var(--danger)" : len > 55000 ? "var(--warning)" : "var(--on-surface-variant)";

    const trig = normalizeTrigger(draft.trigger);
    const term = terminatorName();
    hintPill.replaceChildren(
      "Type ",
      h("span", { class: "code-token" }, trig === "@" ? "@trigger" : trig),
      ` + ${term} → pastes ${formatNum(lines)} ${lines === 1 ? "line" : "lines"} (${formatNum(len)} chars)`
    );
    if (activeTab === "split") {
      draft.text = val;
      renderPreviewNow();
    }
  }

  function scheduleMetaUpdate() {
    if (countFrame) return;
    countFrame = requestAnimationFrame(() => {
      countFrame = 0;
      updateLiveMeta();
    });
  }

  function switchTab(nextTab) {
    activeTab = nextTab;
    writeTabBtn.setAttribute("aria-selected", nextTab === "write" ? "true" : "false");
    splitTabBtn.setAttribute("aria-selected", nextTab === "split" ? "true" : "false");
    previewTabBtn.setAttribute("aria-selected", nextTab === "preview" ? "true" : "false");
    panesHost.classList.toggle("editor__panes--split", nextTab === "split");
    textArea.hidden = nextTab === "preview";
    previewHost.hidden = nextTab === "write";
    if (nextTab === "write") {
      previewMoreSlot.hidden = true;
      textArea.focus();
    } else {
      syncTextFromInput();
      showFullPreview = false;
      renderPreviewNow();
    }
  }

  function renderPreviewNow() {
    const raw = draft.text;
    if (!raw) {
      previewHost.textContent = "(nothing yet)";
      previewMoreSlot.hidden = true;
      previewMoreSlot.replaceChildren();
      return;
    }
    const isCapped = !showFullPreview && raw.length > FAST_PREVIEW_LIMIT;
    const slice = isCapped ? raw.slice(0, FAST_PREVIEW_LIMIT) : raw;
    const formatted = slice.replace(/ /g, "·").replace(/\t/g, "→   ").replace(/\n/g, "¶\n");
    previewHost.textContent = isCapped
      ? `${formatted}\n\n... (${formatNum(raw.length - FAST_PREVIEW_LIMIT)} more characters)`
      : formatted;

    if (isCapped) {
      previewMoreSlot.hidden = false;
      previewMoreSlot.replaceChildren(
        h("button", {
          type: "button",
          class: "btn btn--sm",
          onClick: () => {
            showFullPreview = true;
            renderPreviewNow();
          },
        }, `Show all ${formatNum(raw.length)} characters`)
      );
    } else {
      previewMoreSlot.hidden = true;
      previewMoreSlot.replaceChildren();
    }
  }

  function setFieldError(id, msg) {
    const input = id === "trigger" ? triggerInput : textArea;
    const slot = id === "trigger" ? triggerErrSlot : textErrSlot;
    if (msg) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", `${id}-help ${id}-err`);
      slot.replaceChildren(h("p", { class: "field__error", id: `${id}-err`, role: "alert" }, useIcon("alert"), h("span", null, msg)));
    } else {
      input.removeAttribute("aria-invalid");
      input.setAttribute("aria-describedby", `${id}-help`);
      slot.replaceChildren();
    }
  }

  function triggerError() {
    const v = normalizeTrigger(draft.trigger);
    if (v === "@") return "Trigger is required.";
    if (!TRIGGER_RE.test(v)) return "Use lowercase letters, numbers, - and _, up to 31 characters after @.";
    const dupe = state.commands.find((c) => c.trigger.toLowerCase() === v.toLowerCase() && c.id !== existing?.id);
    if (dupe) return `${v} is already used by "${truncate(dupe.text, 40)}". Pick a different trigger.`;
    return null;
  }

  function textError() {
    const len = textArea.value.length;
    if (!len) return "Text is required.";
    if (len > MAX_TEXT) return `Text is over the ${MAX_TEXT} character limit.`;
    return null;
  }

  function onDelete() {
    if (!existing) return;
    confirmDialog({
      title: `Delete ${existing.trigger}?`,
      body: "It will stop expanding immediately. You can undo this for a few seconds afterwards.",
      confirmLabel: "Delete command",
      danger: true,
      onConfirm: async () => {
        try {
          await request(`/api/commands/${encodeURIComponent(existing.id)}`, { method: "DELETE" });
          const snapshot = existing;
          set("ui", { ...state.ui, dirty: false });
          set("commands", state.commands.filter((c) => c.id !== existing.id));
          emit("commands:changed");
          toast({
            message: `Deleted ${snapshot.trigger}`,
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
          announce(`Deleted ${snapshot.trigger}`);
          navigate("/");
        } catch {
          toast({ message: "Couldn't delete command." });
        }
      },
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    syncTextFromInput();
    const tErr = triggerError();
    const xErr = textError();
    setFieldError("trigger", tErr);
    setFieldError("text", xErr);
    if (tErr || xErr) {
      if (xErr && activeTab === "preview") switchTab("write");
      focusFirstInvalid(container);
      return;
    }
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = "Saving...";
    try {
      const trimmedGroup = draft.group.trim();
      const body = {
        trigger: normalizeTrigger(draft.trigger),
        text: draft.text,
        enabled: draft.enabled,
        ...(isNew ? (trimmedGroup ? { group: trimmedGroup } : {}) : { group: trimmedGroup }),
      };
      let saved = null;
      if (isNew) {
        saved = await request("/api/commands", { method: "POST", body });
        if (saved && !state.commands.some((c) => c.id === saved.id)) {
          set("commands", [...state.commands, saved]);
          set("ui", { ...state.ui, selectedId: saved.id, dirty: false });
        }
      } else {
        saved = await request(`/api/commands/${encodeURIComponent(existing.id)}`, { method: "PATCH", body });
        if (saved) {
          set("commands", state.commands.map((c) => c.id === existing.id ? saved : c));
          set("ui", { ...state.ui, selectedId: saved.id, dirty: false });
        }
      }
      emit("commands:changed");
      toast({ message: isNew ? `Created ${body.trigger}` : `Saved ${body.trigger}` });
      announce(isNew ? "Command created." : "Command saved.");
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "E_CONFLICT" && err.field === "trigger") setFieldError("trigger", err.message || "Trigger is already used.");
        else if (err.code === "E_VALIDATION" && err.field === "trigger") setFieldError("trigger", err.message || "Invalid trigger.");
        else if (err.code === "E_VALIDATION" && err.field === "text") setFieldError("text", err.message || "Invalid text.");
        else if (err.code === "E_UNAUTHORIZED") toast({ message: "This browser is no longer paired." });
        else toast({ message: "Couldn't save command." });
        focusFirstInvalid(container);
      } else {
        toast({ message: "Couldn't save command." });
      }
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  }

  return {
    title: isNew ? "Create command" : "Edit command",
    unmount() {
      if (countFrame) cancelAnimationFrame(countFrame);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
      set("ui", { ...state.ui, dirty: false });
    },
  };
}

export default {};