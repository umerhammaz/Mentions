import { h, frag } from "../dom.js";
import { state, set, emit, on as onState } from "../store.js";
import { request, ApiError } from "../api.js";
import { route, navigate } from "../router.js";
import { field, primaryButton, toast, truncate } from "../ui.js";
import { focusFirstInvalid, announce } from "../a11y.js";

const TRIGGER_RE = /^@[a-z0-9_-]{1,31}$/;
const MAX_TEXT = 65536;

export function renderEditor({ root, params }, { mode }) {
  const isNew = mode === "new";
  const existing = !isNew ? state.commands.find((c) => c.id === params.id) : null;
  const isDesktop = matchMedia("(min-width: 960px)").matches;

  const draft = {
    trigger: existing?.trigger || "@",
    text: existing?.text || "",
    group: existing?.group || "",
    enabled: existing?.enabled ?? true,
  };

  const container = h("section", { class: "editor", "aria-labelledby": "editor-h" });
  root.replaceChildren(container);

  function render() {
    const heading = isNew ? "Create command" : `Edit ${existing?.trigger || ""}`;
    const triggerInput = h("input", {
      id: "trigger", class: "input", type: "text", value: draft.trigger,
      maxlength: "32", spellcheck: "false", autocomplete: "off", autocapitalize: "off",
      oninput: (e) => { draft.trigger = e.target.value; syncState(); },
      onblur: () => validate("trigger"),
    });
    const textArea = h("textarea", {
      id: "text", class: "textarea", rows: "10", spellcheck: "true",
      oninput: (e) => { draft.text = e.target.value; syncState(); },
      onblur: () => validate("text"),
    });
    textArea.value = draft.text;

    const groupInput = h("input", {
      id: "group", class: "input", type: "text", value: draft.group,
      oninput: (e) => { draft.group = e.target.value; },
    });

    const enabledSwitch = h("label", { class: "switch" },
      h("input", { type: "checkbox", checked: draft.enabled, onchange: (e) => { draft.enabled = e.target.checked; } }),
      h("span", { class: "switch__track" }),
      h("span", { class: "t-body" }, "Expands when typed")
    );

    const charCount = h("span", { class: "t-caption t-mono", "aria-live": "polite" },
      `${new Intl.NumberFormat().format(draft.text.length)} / ${new Intl.NumberFormat().format(MAX_TEXT)}`);

    const preview = buildPreview();

    const form = h("form", { class: "editor__form", novalidate: true, onsubmit: onSubmit },
      field({ id: "trigger", label: "Trigger", help: "Starts with @, lowercase letters, numbers, - and _. Must be unique.", required: true, control: h("div", { class: "input-affix" }, h("span", { class: "input-affix__prefix" }, "@"), triggerInput) }),
      field({ id: "text", label: "Pastes", help: "Preserved exactly as typed, including line breaks.", required: true, control: textArea }),
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" } }, charCount, h("span", { class: "t-caption" }, "Whitespace preserved")),
      field({ id: "group", label: "Group", help: "Optional. Groups commands in the list.", optional: true, control: groupInput }),
      h("div", null, enabledSwitch),
      h("div", { class: "editor__actions" },
        h("a", { class: "btn btn--quiet", href: "/" }, "Cancel"),
        primaryButton(isNew ? "Create command" : "Save changes", null, { type: "submit" })
      )
    );
    form.querySelector('button[type="submit"]').type = "submit";

    const head = h("header", { class: "editor__head" },
      h("h1", { id: "editor-h", class: "t-title" }, heading),
      isDesktop ? null : h("a", { class: "btn btn--quiet", href: "/" }, "Back")
    );

    const grid = h("div", { class: "editor__grid" },
      form,
      h("aside", { class: "editor__preview" },
        h("h2", { class: "t-label", style: { marginBottom: "var(--space-2)" } }, "Preview"),
        preview
      )
    );

    container.replaceChildren(head, grid);
  }

  function buildPreview() {
    const text = draft.text || "(nothing yet)";
    const out = h("div", { class: "preview" });
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const ch of line) {
        if (ch === " ") out.append(h("span", { class: "preview__ws", "aria-hidden": "true" }, "·"));
        else out.append(document.createTextNode(ch));
      }
      if (i < lines.length - 1) {
        out.append(h("span", { class: "preview__ws", "aria-hidden": "true" }, "¶"));
        out.append(document.createTextNode("\n"));
      }
    });
    return out;
  }

  function syncState() {
    set("ui", { ...state.ui, dirty: true });
    render();
  }

  function validate(fieldId) {
    const triggerErr = fieldId === "trigger" ? triggerError() : null;
    const textErr = fieldId === "text" ? textError() : null;
    if (triggerErr) announce(triggerErr);
    if (textErr) announce(textErr);
    return !(triggerErr || textErr);
  }

  function triggerError() {
    const v = draft.trigger.trim();
    if (!v) return "Trigger is required.";
    if (!v.startsWith("@")) return "Trigger must start with @.";
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
    if (tErr || xErr) {
      renderErrors({ trigger: tErr, text: xErr });
      focusFirstInvalid(container);
      return;
    }
    const submitBtn = container.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = "Saving...";
    try {
      const body = { trigger: draft.trigger.trim(), text: draft.text, enabled: draft.enabled };
      if (draft.group) body.group = draft.group.trim();
      if (isNew) {
        await request("/api/commands", { method: "POST", body });
      } else {
        await request(`/api/commands/${existing.id}`, { method: "PATCH", body });
      }
      emit("commands:reload");
      set("ui", { ...state.ui, dirty: false });
      announce(isNew ? "Command created." : "Command saved.");
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "E_CONFLICT" && err.field === "trigger") renderErrors({ trigger: err.message || "Trigger is already used." });
        else if (err.code === "E_VALIDATION" && err.field === "trigger") renderErrors({ trigger: err.message || "Invalid trigger." });
        else if (err.code === "E_VALIDATION" && err.field === "text") renderErrors({ text: err.message || "Invalid text." });
        else if (err.code === "E_UNAUTHORIZED") toast({ message: "This browser is no longer paired." });
        else toast({ message: "Couldn't save command." });
      } else {
        toast({ message: "Couldn't save command." });
      }
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  }

  function renderErrors(map) {
    render();
    for (const [id, msg] of Object.entries(map)) {
      if (!msg) continue;
      const input = container.querySelector(`#${id}`);
      if (input) input.setAttribute("aria-invalid", "true");
    }
  }

  render();
  return {
    title: isNew ? "Create command" : "Edit command",
    unmount() {},
  };
}

export default {};