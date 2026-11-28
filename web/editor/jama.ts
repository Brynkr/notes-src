// Jama links: document keys (PROJ-REQ-123) and Global IDs (GID-4567) in the
// text are underlined; Ctrl/Cmd+click (or Alt+Enter) opens Jama's search for
// that ID on the owner's Jama site (Settings → Links). Off until it's set.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/** PROJECT-TYPE-123 (document key) or GID-123 (Global ID). */
export const JAMA_ID = /\b(?:[A-Z][A-Z0-9]{1,15}-[A-Z][A-Z0-9]{0,15}-\d{1,9}|GID-\d{1,12})\b/g;

let base = "";
let version = 0;

/** Set (or clear) the Jama address; open editors pick it up on their next update. */
export function setJamaUrl(url: string): void {
  if (url === base) return;
  base = url.replace(/\/+$/, "");
  version++;
}

export function jamaLink(id: string): string | null {
  return base ? `${base}/perspective.req#/search?term=${encodeURIComponent(id)}` : null;
}

export function openJama(id: string): boolean {
  const url = jamaLink(id);
  if (!url) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/** The Jama ID under the cursor, if any. */
export function jamaAtCursor(view: EditorView): string | null {
  if (!base) return null;
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  JAMA_ID.lastIndex = 0;
  for (let m = JAMA_ID.exec(line.text); m; m = JAMA_ID.exec(line.text)) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return m[0];
  }
  return null;
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  if (!base) return b.finish();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    JAMA_ID.lastIndex = 0;
    for (let m = JAMA_ID.exec(text); m; m = JAMA_ID.exec(text)) {
      b.add(from + m.index, from + m.index + m[0].length, Decoration.mark({ class: "cm-jama", attributes: { title: `Jama ${m[0]}: Ctrl+click to open` } }));
    }
  }
  return b.finish();
}

export const jamaLinks = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      seen = version;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || this.seen !== version) {
          this.seen = version;
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (p) => p.decorations },
  ),
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
      const el = (e.target as HTMLElement).closest(".cm-jama");
      if (!el) return false;
      e.preventDefault();
      return openJama(el.textContent ?? "");
    },
  }),
];
