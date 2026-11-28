// Images in notes: paste or drop an image (or use the pane's image button) and
// it's shrunk in the browser, saved next to the notes (synced by git like
// everything else) and embedded as ordinary Markdown: ![](images/….webp).
// Each image line shows the picture below it.

import { Facet, StateField, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { api } from "../api.ts";
import { toast } from "../ui/dom.ts";

/** The note an editor shows (images are stored beside it and resolved relative to it). */
export const notePath = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });

const LONGEST_SIDE = 1600;
const IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;

/** Shrink to at most 1600 px on the longest side and re-encode as WebP (JPEG where WebP can't be made). */
export async function shrinkImage(file: Blob): Promise<Blob> {
  // Small GIFs keep their animation.
  if (file.type === "image/gif" && file.size < 2 * 1024 * 1024) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, LONGEST_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const as = (type: string, q: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
  const webp = await as("image/webp", 0.82);
  if (webp && webp.type === "image/webp") return webp;
  return (await as("image/jpeg", 0.85)) ?? file;
}

/** Shrink, upload and insert images at `pos` (default: the cursor). */
export async function insertImages(view: EditorView, files: File[], pos?: number): Promise<void> {
  const note = view.state.facet(notePath);
  if (!note) return;
  const parts: string[] = [];
  for (const f of files) {
    try {
      const small = await shrinkImage(f);
      const res = await api.uploadImage(note, small);
      parts.push(res.markdown);
    } catch (err) {
      toast(`Couldn't add the image: ${(err as Error).message}`, "error");
    }
  }
  if (!parts.length || !view.dom.isConnected) return;
  const at = pos ?? view.state.selection.main.head;
  const line = view.state.doc.lineAt(at);
  // Each image on a line of its own.
  const before = at === line.from ? "" : "\n";
  const after = at === line.to && line.to === view.state.doc.length ? "\n" : at === line.to ? "" : "\n";
  const insert = before + parts.join("\n") + after;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.paste", scrollIntoView: true });
}

const imageFiles = (list: DataTransfer | null): File[] =>
  list ? [...list.files].filter((f) => /^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type)) : [];

/** Where an image's Markdown points: our /api/file for paths beside the note, or a web address. */
export function imageUrl(src: string, note: string): string | null {
  if (/^https?:\/\//i.test(src)) return src;
  if (/^[a-z]+:/i.test(src) || src.startsWith("/")) return null;
  const parts = note.split("/").slice(0, -1);
  for (const seg of decodeURI(src).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return `/api/file?path=${encodeURIComponent(parts.join("/"))}`;
}

class ImageWidget extends WidgetType {
  readonly url: string;
  readonly alt: string;
  constructor(url: string, alt: string) {
    super();
    this.url = url;
    this.alt = alt;
  }
  eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-image";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.onerror = () => {
      wrap.classList.add("missing");
      wrap.textContent = `Image not found: ${decodeURIComponent(this.url.replace(/^\/api\/file\?path=/, ""))}`;
    };
    wrap.append(img);
    return wrap;
  }
  get estimatedHeight(): number {
    return 220;
  }
}

function imagesIn(state: EditorState, doc: Text, fromLine: number, toLine: number): Range<Decoration>[] {
  const note = state.facet(notePath);
  const out: Range<Decoration>[] = [];
  for (let n = fromLine; n <= toLine; n++) {
    const line = doc.line(n);
    if (!line.text.includes("![")) continue;
    IMAGE_RE.lastIndex = 0;
    for (let m = IMAGE_RE.exec(line.text); m; m = IMAGE_RE.exec(line.text)) {
      const url = imageUrl(m[2], note);
      if (url) out.push(Decoration.widget({ widget: new ImageWidget(url, m[1]), block: true, side: 1 }).range(line.to));
    }
  }
  return out;
}

/** Images shown under their lines. On edits only the changed lines are re-read. */
const imageField = StateField.define<DecorationSet>({
  create: (state) => Decoration.set(imagesIn(state, state.doc, 1, state.doc.lines), true),
  update(deco, tr) {
    if (!tr.docChanged) return deco;
    deco = deco.map(tr.changes);
    const doc = tr.state.doc;
    let lo = Infinity;
    let hi = -1;
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      lo = Math.min(lo, doc.lineAt(fromB).number);
      hi = Math.max(hi, doc.lineAt(Math.min(toB, doc.length)).number);
    });
    if (hi < 0) return deco;
    const from = doc.line(lo).from;
    const to = doc.line(hi).to;
    return deco.update({ filterFrom: from, filterTo: to, filter: () => false, add: imagesIn(tr.state, doc, lo, hi), sort: true });
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** For note editors: show images, and accept pasted or dropped ones. */
export function noteImages(path: string): Extension {
  return [
    notePath.of(path),
    imageField,
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = imageFiles(e.clipboardData);
        if (!files.length) return false;
        e.preventDefault();
        void insertImages(view, files);
        return true;
      },
      drop(e, view) {
        const files = imageFiles(e.dataTransfer);
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
        void insertImages(view, files, pos);
        return true;
      },
    }),
  ];
}

