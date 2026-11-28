// Drag and drop between the sidebar and the panes. Our own MIME types only
// (never text/plain), so dropping onto an editor never inserts a path as text.

/** A note or file from the sidebar or the file tree: data is its path. */
export const NOTE_DRAG = "application/x-notes-path";
/** A pane being moved by its title bar: data is its id. */
export const PANE_DRAG = "application/x-notes-pane";

/** Make a list row draggable onto a pane. */
export function makeNoteDraggable(el: HTMLElement, path: string): void {
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(NOTE_DRAG, path);
    e.dataTransfer.effectAllowed = "copy";
  });
}

export function dragKind(e: DragEvent): "note" | "pane" | null {
  const types = e.dataTransfer?.types;
  if (!types) return null;
  if (types.includes(NOTE_DRAG)) return "note";
  if (types.includes(PANE_DRAG)) return "pane";
  return null;
}
