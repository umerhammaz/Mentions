import { h } from "../dom.js";
import { route } from "../router.js";

const screen = {
  title: "Not found",
  async mount({ root }) {
    root.replaceChildren(
      h("section", { class: "container", style: { paddingBlock: "var(--space-12)" } },
        h("h1", { class: "t-headline" }, "Page not found"),
        h("p", { class: "t-body", style: { marginTop: "var(--space-3)" } }, "This URL isn't a Mentions screen."),
        h("p", { style: { marginTop: "var(--space-4)" } },
          h("a", { class: "btn btn--primary", href: "/" }, "Go to Commands")
        )
      )
    );
    return { title: "Not found", unmount() {} };
  },
};

route("*", screen);

export default screen;