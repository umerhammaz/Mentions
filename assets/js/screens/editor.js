import { h } from "../dom.js";
import { state, set, emit } from "../store.js";
import { request, ApiError } from "../api.js";
import { navigate } from "../router.js";
import { field, primaryButton, toast, truncate } from "../ui.js";
import { focusFirstInvalid, announce } from "../a11y.js";
import { useIcon } from "../dom.js";

const TRIGGER_RE = /^@[a-z0-9_-]{1,31}$/;
const MAX_TEXT = 65536;

function normalizeTrigger(raw) {
  const cleaned = String(raw || "").trim().replace(/^@+/, "");
  return cleaned ? `@${cleaned}` : "@";
}

export async function renderEditor({ root, params }, { mode }) {
  const isNew = mode === "new";
  const isDesktop = matchMedia("(min-width: 960px)").matches;
  const container = h("section", { class: "editor", "aria-labelledby": "editor-h" });
  root.replaceChildren(container);

  if (!isNew && state.commands.length === 0) {
    try {
      const data = await request("/api/commands");
      if (Array.isArray(data?.commands)) set("commands", data.commands);
    } catch {}
  }

  const existing = !isNew ? state.commands.find((c) => c.id === params.id) : null;
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
  const previewHost = h("div", { class: "preview" });
  const charCount = h("span", { class: "t-caption t-mono", "aria-live": "polite" });

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
    rows: "10",
    spellcheck: "true",
    oninput: (e) => {
      draft.text = e.target.value;
      markDirty();
      updatePreviewAndCount();
      if (textArea.getAttribute("aria-invalid") === "true") setFieldError("text", textError());
    },
    onblur: () => {
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

  const submitBtn = primaryButton(isNew ? "Create command" : "Save changes", null, { type: "submit" });

  const triggerField = field({
    id: "trigger",
    label: "Trigger",
    help: "Starts with @, lowercase letters, numbers, - and _. Must be unique.",
    required: true,
    control: h("div", { class: "input-affix" }, h("span", { class: "input-affix__prefix" }, "@"), triggerInput),
  });
  triggerField.append(triggerErrSlot);

  const textField = field({
    id: "text",
    label: "Pastes",
    help: "Preserved exactly as typed, including line breaks.",
    required: true,
    control: textArea,
  });
  textField.append(textErrSlot);

  const form = h("form", { class: "editor__form", novalidate: true, onsubmit: onSubmit },
    triggerField,
    textField,
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" } },
      charCount,
      h("span", { class: "t-caption" }, "Whitespace preserved")
    ),
    field({ id: "group", label: "Group", help: "Optional. Groups commands in the list.", optional: true, control: groupInput }),
    h("div", null, enabledSwitch),
    h("div", { class: "editor__actions" },
      h("a", { class: "btn btn--quiet", href: "/" }, "Cancel"),
      submitBtn
    )
  );

  const head = h("header", { class: "editor__head" },
    h("h1", { id: "editor-h", class: "t-title" }, heading),
    isDesktop ? null : h("a", { class: "btn btn--quiet", href: "/" }, "Back")
  );

  const grid = h("div", { class: "editor__grid" },
    form,
    h("aside", { class: "editor__preview" },
      h("h2", { class: "t-label", style: { marginBottom: "var(--space-2)" } }, "Preview"),
      previewHost
    )
  );

  container.replaceChildren(head, grid);
  updatePreviewAndCount();

  function markDirty() {
    if (!state.ui.dirty) set("ui", { ...state.ui, dirty: true });
  }

  function updatePreviewAndCount() {
    charCount.textContent = `${new Intl.NumberFormat().format(draft.text.length)} / ${new Intl.NumberFormat().format(MAX_TEXT)}`;
    const text = draft.text || "(nothing yet)";
    previewHost.replaceChildren();
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const ch of line) {
        if (ch === " ") previewHost.append(h("span", { class: "preview__ws", "aria-hidden": "true" }, "·"));
        else previewHost.append(document.createTextNode(ch));
      }
      if (i < lines.length - 1) {
        previewHost.append(h("span", { class: "preview__ws", "aria-hidden": "true" }, "¶"));
        previewHost.append(document.createTextNode("\n"));
      }
    });
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
    if (!draft.text) return "Text is required.";
    if (draft.text.length > MAX_TEXT) return `Text is over the ${MAX_TEXT} character limit.`;
    return null;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const tErr = triggerError();
    const xErr = textError();
    setFieldError("trigger", tErr);
    setFieldError("text", xErr);
    if (tErr || xErr) {
      focusFirstInvalid(container);
      return;
    }
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = "Saving...";
    try {
      const body = { trigger: normalizeTrigger(draft.trigger), text: draft.text, enabled: draft.enabled };
      if (draft.group.trim()) body.group = draft.group.trim();
      if (isNew) {
        await request("/api/commands", { method: "POST", body });
      } else {
        await request(`/api/commands/${existing.id}`, { method: "PATCH", body });
      }
      set("ui", { ...state.ui, dirty: false });
      emit("commands:reload");
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
      window.removeEventListener("beforeunload", onBeforeUnload);
      set("ui", { ...state.ui, dirty: false });
    },
  };
}

export default {};