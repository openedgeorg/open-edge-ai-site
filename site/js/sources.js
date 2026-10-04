/** Source panel helpers. URLs in a citation are text, not navigation targets. */

import { openSourcePanel } from "./render.js";

export function citationLabel(citation) {
  const state = citation.verification_state || "unverified";
  return `${citation.title || citation.source_id} (${state})`;
}

export function showSource(citation, mount) {
  return openSourcePanel(citation, mount);
}
