function element(name) {
  const node = {
    nodeName: name,
    children: [],
    attrs: {},
    textContent: "",
    tabIndex: 0,
    focused: false,
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      return child;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    },
    focus() {
      this.focused = true;
      document.activeElement = this;
    },
  };
  Object.defineProperty(node, "innerHTML", {
    set() {
      throw new Error("innerHTML refused");
    },
  });
  return node;
}

const document = {
  activeElement: null,
  createElement: element,
};
globalThis.document = document;

const { renderHistoryItem } = await import("../../site/js/render.js");
const container = element("ol");
const previous = element("textarea");
previous.focus();
renderHistoryItem(
  {
    text: "<script>alert(1)</script>",
    citations: [
      {
        title: "Note",
        source_id: "src-1",
        version: "v1",
        locator: "javascript:alert(1)",
        verification_state: "unverified",
      },
    ],
  },
  container,
);
const row = container.children[0];
const button = row.children.find((child) => child.nodeName === "button");
button.listeners.click();
const panel = container.children.find((child) => child.nodeName === "section");
panel.listeners.keydown({ key: "Escape" });
const text = row.children[0].textContent;
process.stdout.write(
  `${JSON.stringify({
    text,
    usedMarkup: text.includes("<script>"),
    panelGone: !container.children.includes(panel),
    focusRestored: document.activeElement === previous,
    locatorText: panel.children.map((child) => child.textContent).join(" "),
  })}\n`,
);
