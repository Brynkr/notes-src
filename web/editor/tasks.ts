// Task lists: show "- [ ]" / "- [x]" as real checkboxes that toggle on click
// or tap. Uses the Markdown parser (GFM task markers), so brackets inside
// code blocks are left alone.

import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

class CheckboxWidget extends WidgetType {
  readonly checked: boolean;
  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-task";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task-box";
    box.setAttribute("aria-label", this.checked ? "Done; click to mark not done" : "Not done; click to mark done");
    wrap.append(box);
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "TaskMarker") return;
        const text = view.state.sliceDoc(node.from, node.to); // "[ ]" or "[x]"
        builder.add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(/x/i.test(text)) }));
      },
    });
  }
  return builder.finish();
}

function toggleAt(view: EditorView, pos: number): boolean {
  const text = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(text)) return false;
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " }, userEvent: "input.toggle" });
  return true;
}

export function taskCheckboxes(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
        }
      },
      {
        decorations: (v) => v.decorations,
        eventHandlers: {
          mousedown(e, view) {
            const t = e.target as HTMLElement;
            if (!t.classList.contains("cm-task-box")) return false;
            e.preventDefault(); // keep the editor's cursor where it was
            return toggleAt(view, view.posAtDOM(t.parentElement ?? t));
          },
        },
      },
    ),
  ];
}
