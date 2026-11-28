// The IDE minimap (a zoomed-out view of the text down the right-hand side,
// Sublime-style). Loaded on demand: only in IDE mode, only when it's on.
import { showMinimap } from "@replit/codemirror-minimap";
import type { Extension } from "@codemirror/state";

export const minimap: Extension = showMinimap.of({
  create: () => ({ dom: document.createElement("div") }),
  displayText: "characters",
  showOverlay: "always",
});
