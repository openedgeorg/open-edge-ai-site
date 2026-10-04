/** Render history with text nodes. Model HTML is never parsed. */

export function renderHistoryItem(item, container) {
  const row = document.createElement("li");
  const text = document.createElement("p");
  text.textContent = String(item.text ?? "");
  row.appendChild(text);
  for (const citation of item.citations || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = citation.title || citation.source_id;
    button.addEventListener("click", () => openSourcePanel(citation, container));
    row.appendChild(button);
  }
  container.appendChild(row);
  return row;
}

export function openSourcePanel(citation, mount) {
  const previous = document.activeElement;
  const panel = document.createElement("section");
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Source");
  const heading = document.createElement("h3");
  heading.textContent = String(citation.title || "");
  const state = document.createElement("p");
  state.textContent = String(citation.verification_state || "unverified");
  const locator = document.createElement("p");
  locator.textContent = `${citation.source_id || ""} ${citation.version || ""} ${citation.locator || ""}`;
  panel.appendChild(heading);
  panel.appendChild(state);
  panel.appendChild(locator);
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    panel.remove();
    if (previous && typeof previous.focus === "function") previous.focus();
  });
  mount.appendChild(panel);
  panel.focus();
  return panel;
}
