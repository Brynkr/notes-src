// CodeMirror 6 setup. Several panes can show the same NoteBuffer: each pane
// has its own EditorView (own cursor, scroll, undo history), and every local
// edit is replayed into the other views of the same buffer. One document,
// many views, so two panes can never overwrite each other.

import { addCursorAbove, addCursorBelow, defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, Facet, Prec, Transaction, type Extension, type Text } from "@codemirror/state";
import { crosshairCursor, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder, dropCursor, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { BufferStore, BufferView, NoteBuffer } from "../state/buffers.ts";
import { isNotePath } from "../../shared/files.ts";
import { codeHighlight } from "./highlight.ts";
import { fenceLanguage, loadLanguageForPath } from "./lazylang.ts";
import { jamaAtCursor, jamaLinks, openJama } from "./jama.ts";
import { noteImages } from "./images.ts";
import { taskCheckboxes } from "./tasks.ts";
import { linkAtCursor, wikiLinks, type LinkHost } from "./wikilinks.ts";

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
  ".cm-scroller": { fontFamily: "var(--editor-font)", lineHeight: "var(--editor-lh)", overflow: "auto" },
  ".cm-content": { maxWidth: "var(--editor-width)", margin: "0 auto", padding: "var(--editor-pad) var(--editor-pad) 40vh", caretColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--faint)", fontFamily: "var(--ui-font)", fontSize: "0.72em" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", minWidth: "3ch" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-searchMatch": { backgroundColor: "var(--mark)" },
  ".cm-textfield, .cm-button": { fontFamily: "var(--ui-font)" },
  ".cm-task": { display: "inline-block", verticalAlign: "-2px", marginRight: "1px" },
  ".cm-task-box": { width: "15px", height: "15px", margin: "0", accentColor: "var(--accent)", cursor: "pointer" },
  ".cm-wikilink": { color: "var(--accent)", textDecoration: "underline", textDecorationColor: "var(--accent-soft)", textUnderlineOffset: "3px" },
  ".cm-wikilink-missing": { color: "var(--muted)", textDecorationStyle: "dashed", textDecorationColor: "var(--faint)" },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--line)",
    background: "var(--bg)",
    borderRadius: "8px",
    boxShadow: "var(--shadow)",
    fontFamily: "var(--ui-font)",
    fontSize: "14px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul > li": { padding: "5px 12px !important", lineHeight: "1.4" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent-soft)", color: "var(--ink)" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)", fontWeight: "700" },
  ".cm-completionDetail": { color: "var(--faint)", marginLeft: "8px", fontStyle: "normal" },
});

/** Code files (IDE mode): monospace, full width, no wrapping, always line numbers. */
const codeTheme = EditorView.theme({
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "0.88em", lineHeight: "1.55" },
  ".cm-content": { maxWidth: "none", margin: "0", padding: "12px 16px 40vh 8px" },
});

/** True in editors showing a code or text file rather than a note. */
const isCodeEditor = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

/** Editor options from the Appearance panel, switchable on live editors. */
export interface EditorPrefs {
  lineNumbers: boolean;
  activeLine: boolean;
  spellcheck: boolean;
  /** Show the minimap (IDE mode, when turned on). */
  minimap: boolean;
}

const prefsSlot = new Compartment();
/** A code file's language: empty at first, filled in once its parser has loaded. */
const langSlot = new Compartment();
/** The IDE minimap: empty unless shown (its code loads the first time). */
const mapSlot = new Compartment();
let minimapCode: Promise<Extension> | null = null;
const loadMinimap = () => (minimapCode ??= import("./minimap.ts").then((m) => m.minimap));

function setMinimap(view: EditorView, on: boolean): void {
  if (!on) {
    view.dispatch({ effects: mapSlot.reconfigure([]) });
    return;
  }
  void loadMinimap().then(
    (ext) => {
      if (view.dom.isConnected) view.dispatch({ effects: mapSlot.reconfigure(ext) });
    },
    () => undefined, // offline before it was ever loaded: no minimap
  );
}

function prefsExtension(p: EditorPrefs, code: boolean): Extension {
  const spell = p.spellcheck && !code;
  return [
    p.lineNumbers || code ? [lineNumbers(), highlightActiveLineGutter()] : [],
    p.activeLine ? highlightActiveLine() : [],
    EditorView.contentAttributes.of({ spellcheck: String(spell), autocorrect: spell ? "on" : "off", autocapitalize: code ? "off" : "sentences" }),
  ];
}

/** Apply new editor options to an open editor (and re-measure after font changes). */
export function applyEditorPrefs(view: EditorView, p: EditorPrefs): void {
  view.dispatch({ effects: prefsSlot.reconfigure(prefsExtension(p, view.state.facet(isCodeEditor))) });
  setMinimap(view, p.minimap);
}

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
  links: LinkHost;
  prefs: EditorPrefs;
}): PaneEditor {
  const { buffer, store } = opts;
  const len = buffer.doc.length;
  const clamp = (n: number) => Math.max(0, Math.min(len, n));
  const selection = opts.cursor ? EditorSelection.single(clamp(opts.cursor.anchor), clamp(opts.cursor.head)) : undefined;
  const code = !isNotePath(buffer.path);
  // Notes: Markdown (with highlighted code fences), wiki links, checkboxes. Code: its language.
  const kind: Extension = code
    ? [isCodeEditor.of(true), langSlot.of([]), syntaxHighlighting(codeHighlight), Prec.high(codeTheme)]
    : [
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
        syntaxHighlighting(markdownHighlight),
        syntaxHighlighting(codeHighlight),
        placeholder("Start writing…"),
        wikiLinks(opts.links),
        taskCheckboxes(),
        noteImages(buffer.path),
      ];

  let paneEditor!: PaneEditor;
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: buffer.doc,
      selection,
      extensions: [
        history(),
        drawSelection(),
        // Several cursors, Sublime-style: Ctrl/Cmd+Alt+Up/Down adds one above/below,
        // Alt+drag selects a column; Esc goes back to one cursor.
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        dropCursor(),
        prefsSlot.of(prefsExtension(opts.prefs, code)),
        mapSlot.of([]),
        jamaLinks,
        indentOnInput(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        kind,
        keymap.of([
          ...(opts.extraKeys ?? []),
          { key: "Mod-Alt-ArrowUp", run: addCursorAbove, preventDefault: true },
          { key: "Mod-Alt-ArrowDown", run: addCursorBelow, preventDefault: true },
          {
            key: "Alt-Enter",
            run: (v) => {
              const jama = jamaAtCursor(v);
              if (jama) return openJama(jama);
              const target = linkAtCursor(v);
              if (!target) return false;
              opts.links.follow(target, false);
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        theme,
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
  let destroyed = false;
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
      destroyed = true;
      if (reportTimer) clearTimeout(reportTimer);
      store.detach(buffer, paneEditor);
      view.destroy();
    },
  };
  store.attach(buffer, paneEditor);
  if (opts.prefs.minimap) setMinimap(view, true);
  if (code) {
    // The editor is usable at once; highlighting appears when the parser arrives.
    void loadLanguageForPath(buffer.path).then(
      (lang) => {
        if (!destroyed) view.dispatch({ effects: langSlot.reconfigure(lang) });
      },
      () => undefined, // offline and never loaded: plain text is fine
    );
  }
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
