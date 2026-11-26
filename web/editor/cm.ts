// CodeMirror 6 setup. Several panes can show the same NoteBuffer: each pane
// has its own EditorView (own cursor, scroll, undo history), and every local
// edit is replayed into the other views of the same buffer. One document,
// many views, so two panes can never overwrite each other.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, EditorSelection, EditorState, Transaction, type Text } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, placeholder, dropCursor } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { BufferStore, BufferView, NoteBuffer } from "../state/buffers.ts";

/** Marks transactions that replay another pane's edit, so they aren't echoed back. */
const fromOtherPane = Annotation.define<boolean>();

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.55em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)", textDecoration: "underline" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.9em", backgroundColor: "var(--code-bg)", borderRadius: "3px" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: "var(--faint)" },
  { tag: [t.keyword, t.atom, t.bool], color: "var(--accent)" },
  { tag: [t.string, t.number], color: "var(--string)" },
  { tag: t.comment, color: "var(--faint)", fontStyle: "italic" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--ink)" },
  ".cm-scroller": { fontFamily: "var(--editor-font)", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { maxWidth: "74ch", margin: "0 auto", padding: "28px 28px 40vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-searchMatch": { backgroundColor: "var(--mark)" },
  ".cm-textfield, .cm-button": { fontFamily: "var(--ui-font)" },
});

export interface PaneEditor extends BufferView {
  view: EditorView;
  destroy(): void;
}

export function createEditor(opts: {
  parent: HTMLElement;
  buffer: NoteBuffer;
  store: BufferStore;
  cursor?: { anchor: number; head: number };
  onFocus: () => void;
  onViewState: (cursor: { anchor: number; head: number }, scrollTop: number) => void;
  onRefresh: () => void;
  extraKeys?: { key: string; run: () => boolean }[];
}): PaneEditor {
  const { buffer, store } = opts;
  const len = buffer.doc.length;
  const clamp = (n: number) => Math.max(0, Math.min(len, n));
  const selection = opts.cursor ? EditorSelection.single(clamp(opts.cursor.anchor), clamp(opts.cursor.head)) : undefined;

  let paneEditor!: PaneEditor;
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: buffer.doc,
      selection,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(markdownHighlight),
        placeholder("Start writing…"),
        keymap.of([...(opts.extraKeys ?? []), ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        theme,
        EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
        EditorView.domEventHandlers({
          focus: () => {
            opts.onFocus();
            return false;
          },
          scroll: () => {
            report();
            return false;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) report();
        }),
      ],
    }),
    dispatchTransactions(trs, v) {
      v.update(trs);
      let local = false;
      for (const tr of trs) {
        if (!tr.docChanged || tr.annotation(fromOtherPane)) continue;
        local = true;
        for (const other of buffer.views) {
          if (other === paneEditor) continue;
          (other as PaneEditor).view.dispatch({
            changes: tr.changes,
            annotations: [fromOtherPane.of(true), Transaction.addToHistory.of(false)],
          });
        }
      }
      if (local) store.localChange(buffer, v.state.doc);
    },
  });

  let reportTimer: ReturnType<typeof setTimeout> | null = null;
  function report(): void {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      const sel = view.state.selection.main;
      opts.onViewState({ anchor: sel.anchor, head: sel.head }, view.scrollDOM.scrollTop);
    }, 250);
  }

  paneEditor = {
    view,
    replaceDoc(doc: Text) {
      const change = minimalChange(view.state.doc.toString(), doc.toString());
      if (!change) return;
      view.dispatch({ changes: change, annotations: [fromOtherPane.of(true), Transaction.addToHistory.of(false)] });
    },
    refresh: () => opts.onRefresh(),
    destroy() {
      if (reportTimer) clearTimeout(reportTimer);
      store.detach(buffer, paneEditor);
      view.destroy();
    },
  };
  store.attach(buffer, paneEditor);
  return paneEditor;
}

/** Single replace covering only the region that differs, so cursors elsewhere stay put. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
