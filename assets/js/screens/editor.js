import { h, useIcon } from "../dom.js";
import { state, set, emit, tokenGet, tokenSet } from "../store.js";
import { request, ApiError, DEMO_TOKEN } from "../api.js";
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

export async function renderEditor({ root, params }, { mode }) {
  ensureEditableSession();

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
      h("h1", { id: "editor-h", class: "t-title" }, "Command not found"),
      h("p", { class: "t-body" }, "This command may have been deleted or hasn't synced yet."),
      h("div", null, h("a", { class: "btn btn--primary", href: "/" }, "Back to Commands"))
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

  const onBeforeUnload = (e) => {
    if (state.ui.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  const heading = isNew ? "Create command" : `Edit ${existing.trigger}`;
  const triggerErrSlot = h("div");
  const textErrSlot = h("div");
  const previewHost = h("div", { class: "preview", hidden: true });
  const previewMoreSlot = h("div", { hidden: true });
  const charCount = h("span", { class: "t-caption t-mono" }, `${formatNum(draft.text.length)} / ${MAX_TEXT_LABEL}`);

  const triggerInput = h("input", {
    id: "trigger",
    class: "input",
    type: "text",
    value: draft.trigger.replace(/^@+/, ""),
    maxlength: "31",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
    oninput: (e) => {
      const stripped = e.target.value.replace(/^@+/, "").toLowerCase();
      if (e.target.value !== stripped) e.target.value = stripped;
      draft.trigger = stripped ? `@${stripped}` : "@";
      markDirty();
      if (triggerInput.getAttribute("aria-invalid") === "true") setFieldError("trigger", triggerError());
    },
    onblur: () => {
      const err = triggerError();
      setFieldError("trigger", err);
      if (err) announce(err);
    },
  });

  const textArea = h("textarea", {
    id: "text",
    class: "textarea",
    rows: "14",
    spellcheck: "false",
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    oninput: () => {
      markDirty();
      scheduleCountUpdate();
      if (textArea.getAttribute("aria-invalid") === "true") {
        const len = getTextLength();
        if (len > 0 && len <= MAX_TEXT) setFieldError("text", null);
      }
    },
    onblur: () => {
      syncTextFromInput();
      const err = textError();
      setFieldError("text", err);
      if (err) announce(err);
    },
  });
  textArea.value = draft.text;

  const groupInput = h("input", {
    id: "group",
    class: "input",
    type: "text",
    value: draft.group,
    oninput: (e) => {
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

  const previewTabBtn = h("button", {
    type: "button",
    class: "editor__tab",
    role: "tab",
    "aria-selected": "false",
    onClick: () => switchTab("preview"),
  }, "Preview");

  const fullScreenBtn = h("button", {
    type: "button",
    class: "btn btn--quiet",
    onClick: () => {
      isFullScreen = !isFullScreen;
      container.classList.toggle("editor--full", isFullScreen);
      fullScreenBtn.textContent = isFullScreen ? "Exit full screen" : "Full screen";
      textArea.focus();
    },
  }, "Full screen");

  const copyPromptBtn = h("button", {
    type: "button",
    class: "btn btn--quiet",
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
    help: "Starts with @, lowercase letters, numbers, - and _. Must be unique.",
    required: true,
    control: h("div", { class: "input-affix" }, h("span", { class: "input-affix__prefix" }, "@"), triggerInput),
  });
  triggerField.append(triggerErrSlot);

  const groupField = field({
    id: "group",
    label: "Group",
    help: "Optional. Groups commands in the list.",
    optional: true,
    control: groupInput,
  });

  const editorToolbar = h("div", { class: "editor__toolbar" },
    h("div", { class: "editor__tabs", role: "tablist", "aria-label": "Editor mode" }, writeTabBtn, previewTabBtn),
    h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } },
      copyPromptBtn,
      fullScreenBtn
    )
  );

  const textField = field({
    id: "text",
    label: "Prompt text",
    help: "Kept exactly as typed, including spaces and line breaks.",
    required: true,
    control: h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
      editorToolbar,
      textArea,
      previewHost,
      previewMoreSlot
    ),
  });
  textField.append(textErrSlot);

  const form = h("form", { class: "editor__form", novalidate: true, onsubmit: onSubmit },
    h("div", { class: "editor__meta-row" }, triggerField, groupField),
    textField,
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" } },
      charCount,
      enabledSwitch
    ),
    h("div", { class: "editor__actions" },
      !isNew ? h("button", {
        class: "btn btn--quiet",
        type: "button",
        style: { color: "var(--danger)", marginInlineEnd: "auto" },
        onClick: onDelete,
      }, "Delete command") : null,
      h("a", { class: "btn btn--quiet", href: "/" }, "Cancel"),
      submitBtn
    )
  );

  const head = h("header", { class: "editor__head" },
    h("h1", { id: "editor-h", class: "t-title" }, heading),
    h("a", { class: "btn btn--quiet", href: "/" }, "Back to Commands")
  );

  container.replaceChildren(head, form);

  function getTextLength() {
    return typeof textArea.textLength === "number" ? textArea.textLength : textArea.value.length;
  }

  function syncTextFromInput() {
    draft.text = textArea.value;
  }

  function markDirty() {
    if (!state.ui.dirty) set("ui", { ...state.ui, dirty: true });
  }

  function scheduleCountUpdate() {
    if (countFrame) return;
    countFrame = requestAnimationFrame(() => {
      countFrame = 0;
      charCount.textContent = `${formatNum(getTextLength())} / ${MAX_TEXT_LABEL}`;
    });
  }

  function switchTab(nextTab) {
    activeTab = nextTab;
    const isWrite = nextTab === "write";
    writeTabBtn.setAttribute("aria-selected", isWrite ? "true" : "false");
    previewTabBtn.setAttribute("aria-selected", isWrite ? "false" : "true");
    textArea.hidden = !isWrite;
    previewHost.hidden = isWrite;
    if (isWrite) {
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
    const formatted = slice.replace(/ /g, "·").replace(/\n/g, "¶\n");
    previewHost.textContent = isCapped
      ? `${formatted}\n\n... (${formatNum(raw.length - FAST_PREVIEW_LIMIT)} more characters)`
      : formatted;

    if (isCapped) {
      previewMoreSlot.hidden = false;
      previewMoreSlot.replaceChildren(
        h("button", {
          type: "button",
          class: "btn btn--quiet",
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
    const len = getTextLength();
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
        ensureEditableSession();
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
      if (xErr && activeTab !== "write") switchTab("write");
      focusFirstInvalid(container);
      return;
    }
    ensureEditableSession();
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
        }
      } else {
        saved = await request(`/api/commands/${encodeURIComponent(existing.id)}`, { method: "PATCH", body });
        if (saved) {
          set("commands", state.commands.map((c) => c.id === existing.id ? saved : c));
        }
      }
      set("ui", { ...state.ui, dirty: false });
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
      window.removeEventListener("beforeunload", onBeforeUnload);
      set("ui", { ...state.ui, dirty: false });
    },
  };
}

export default {};