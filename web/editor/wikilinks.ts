// [[Wiki link]] support for the editor: highlighting (missing targets look
// different), Ctrl/Cmd+click or Alt+Enter to follow, and completion of note
// titles after typing "[[".

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { parseWikiLinks } from "../../shared/links.ts";
import type { NoteMeta } from "../../shared/types.ts";
import { isMac } from "../ui/dom.ts";

export interface LinkHost {
  notes(): NoteMeta[];
  exists(target: string): boolean;
  follow(target: string, toSide: boolean): void;
}

/** Dispatch to redraw link styling after the set of notes changes. */
export const refreshLinks = StateEffect.define<null>();

const MAX_SCAN = 400_000; // characters; very large notes skip link styling

export function wikiLinks(host: LinkHost): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, host);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLinks)))) {
          this.decorations = build(u.view, host);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.button !== 0) return false;
      const el = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink");
      if (!el?.dataset.target) return false;
      e.preventDefault();
      host.follow(el.dataset.target, e.shiftKey || e.altKey);
      view.focus();
      return true;
    },
  });

  return [plugin, clicks, autocompletion({ override: [completeTitles(host)], activateOnTyping: true, icons: false })];
}

function build(view: EditorView, host: LinkHost): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  if (doc.length > MAX_SCAN) return builder.finish();
  for (const link of parseWikiLinks(doc.toString())) {
    const ok = host.exists(link.target);
    builder.add(
      link.from,
      link.to,
      Decoration.mark({
        class: ok ? "cm-wikilink" : "cm-wikilink cm-wikilink-missing",
        attributes: { "data-target": link.target, title: ok ? `${isMac ? "⌘" : "Ctrl"}+click to open` : `${isMac ? "⌘" : "Ctrl"}+click to create “${link.target}”` },
      }),
    );
  }
  return builder.finish();
}

/** The wiki link under the cursor, if any. */
export function linkAtCursor(view: EditorView): string | null {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  for (const link of parseWikiLinks(line.text)) {
    if (pos >= line.from + link.from && pos <= line.from + link.to) return link.target;
  }
  return null;
}

function completeTitles(host: LinkHost) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\[\[[^\[\]\n|#]*$/);
    if (!before) return null;
    const from = before.from + 2;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const seen = new Set<string>();
    const options = host
      .notes()
      .filter((n) => !n.conflict && !seen.has(n.title.toLowerCase()) && (seen.add(n.title.toLowerCase()), true))
      .map((n) => ({
        label: n.title,
        detail: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : undefined,
        apply: (view: EditorView, _c: unknown, f: number, t: number) => {
          const insert = after === "]]" ? n.title : `${n.title}]]`;
          view.dispatch({
            changes: { from: f, to: t, insert },
            selection: { anchor: f + n.title.length + 2 },
          });
        },
      }));
    return { from, options, validFor: /^[^\[\]\n|#]*$/ };
  };
}
