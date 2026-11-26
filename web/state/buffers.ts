// Shared document buffers: one per open note, however many panes show it.
//
// Safety rules (HANDOVER 10.5):
// - A clean buffer whose file changed on disk is reloaded silently.
// - A dirty buffer is never overwritten. Its next save carries the old
//   baseHash, so the server saves the disk version as a conflict copy and
//   keeps ours.
// - Unsaved text is also stashed in localStorage until the server confirms
//   the save, so a crash or a stopped server can't lose it.

import { Text } from "@codemirror/state";
import { api, ApiError } from "../api.ts";

const STASH_KEY = "notes-app:unsaved:v1";
const SAVE_DELAY_MS = 600;

export interface BufferView {
  /** Replace the whole document with `doc`, keeping the cursor where possible. */
  replaceDoc(doc: Text): void;
  /** Called after any change to the buffer's state (dirty flag, title...). */
  refresh(): void;
}

export class NoteBuffer {
  readonly path: string;
  doc: Text;
  /** The text last confirmed on disk by the server. */
  savedDoc: Text;
  diskHash: string | null;
  readonly views = new Set<BufferView>();
  deleted = false;
  saving: Promise<void> | null = null;
  saveTimer: ReturnType<typeof setTimeout> | null = null;
  retryMs = 0;
  lastError: string | null = null;

  constructor(path: string, text: string, hash: string | null) {
    this.path = path;
    this.doc = Text.of(text.split(/\r\n?|\n/));
    this.savedDoc = this.doc;
    this.diskHash = hash;
  }

  get dirty(): boolean {
    return !this.doc.eq(this.savedDoc);
  }

  /** Number of panes currently showing this buffer. */
  get viewCount(): number {
    return this.views.size;
  }
}

export interface BufferEvents {
  conflictCopy: (path: string, copy: string) => void;
  deleted: (path: string) => void;
  error: (message: string) => void;
  changed: (buffer: NoteBuffer) => void;
}

export class BufferStore {
  private readonly buffers = new Map<string, NoteBuffer>();
  private readonly loading = new Map<string, Promise<NoteBuffer>>();
  private readonly listeners: { [K in keyof BufferEvents]: BufferEvents[K][] } = { conflictCopy: [], deleted: [], error: [], changed: [] };

  on<K extends keyof BufferEvents>(event: K, fn: BufferEvents[K]): void {
    this.listeners[event].push(fn);
  }

  private emit<K extends keyof BufferEvents>(event: K, ...args: Parameters<BufferEvents[K]>): void {
    for (const fn of this.listeners[event]) (fn as (...a: Parameters<BufferEvents[K]>) => void)(...args);
  }

  get(path: string): NoteBuffer | undefined {
    return this.buffers.get(path);
  }

  all(): NoteBuffer[] {
    return [...this.buffers.values()];
  }

  hasUnsaved(): boolean {
    return this.all().some((b) => b.dirty || b.saving);
  }

  /** Get (or load) the buffer for a note. */
  open(path: string): Promise<NoteBuffer> {
    const existing = this.buffers.get(path);
    if (existing) return Promise.resolve(existing);
    const inflight = this.loading.get(path);
    if (inflight) return inflight;
    const p = api
      .read(path)
      .then((note) => {
        const b = new NoteBuffer(path, note.text, note.hash);
        this.buffers.set(path, b);
        return b;
      })
      .finally(() => this.loading.delete(path));
    this.loading.set(path, p);
    return p;
  }

  /** Register a newly created note without another round trip. */
  adopt(path: string, text: string, hash: string): NoteBuffer {
    const b = new NoteBuffer(path, text, hash);
    this.buffers.set(path, b);
    return b;
  }

  attach(b: NoteBuffer, view: BufferView): void {
    b.views.add(view);
  }

  detach(b: NoteBuffer, view: BufferView): void {
    b.views.delete(view);
    this.maybeDrop(b);
  }

  private maybeDrop(b: NoteBuffer): void {
    if (b.views.size === 0 && !b.dirty && !b.saving && !b.saveTimer) this.buffers.delete(b.path);
  }

  /** A pane edited the buffer. Other panes have already been updated by the editor glue. */
  localChange(b: NoteBuffer, doc: Text): void {
    b.doc = doc;
    this.stash();
    this.scheduleSave(b, SAVE_DELAY_MS);
    this.refresh(b);
  }

  private refresh(b: NoteBuffer): void {
    for (const v of b.views) v.refresh();
    this.emit("changed", b);
  }

  scheduleSave(b: NoteBuffer, delay: number): void {
    if (b.saveTimer) clearTimeout(b.saveTimer);
    b.saveTimer = setTimeout(() => {
      b.saveTimer = null;
      void this.save(b);
    }, delay);
  }

  /** Save now (Ctrl+S, or before closing). Resolves when the buffer is clean or saving failed. */
  async flush(b: NoteBuffer): Promise<void> {
    if (b.saveTimer) {
      clearTimeout(b.saveTimer);
      b.saveTimer = null;
    }
    await this.save(b);
  }

  async flushAll(): Promise<void> {
    await Promise.all(this.all().map((b) => this.flush(b)));
  }

  private async save(b: NoteBuffer): Promise<void> {
    if (b.saving) {
      await b.saving;
      if (b.dirty) return this.save(b);
      return;
    }
    if (!b.dirty) return;
    const sending = b.doc;
    b.saving = (async () => {
      try {
        const res = await api.save({ path: b.path, text: sending.toString(), baseHash: b.diskHash });
        b.diskHash = res.hash;
        b.savedDoc = sending;
        b.deleted = false;
        b.retryMs = 0;
        b.lastError = null;
        if (res.conflictCopy) this.emit("conflictCopy", b.path, res.conflictCopy);
      } catch (err) {
        b.lastError = (err as Error).message;
        // Keep the text and retry with backoff. Never drop an edit.
        b.retryMs = Math.min(30_000, b.retryMs ? b.retryMs * 2 : 1_000);
        if (!(err instanceof ApiError && err.status === 400)) this.scheduleSave(b, b.retryMs);
        this.emit("error", `Couldn't save "${b.path}": ${b.lastError}`);
      }
    })();
    try {
      await b.saving;
    } finally {
      b.saving = null;
    }
    this.stash();
    if (b.dirty && !b.saveTimer && !b.lastError) this.scheduleSave(b, SAVE_DELAY_MS);
    this.refresh(b);
    this.maybeDrop(b);
  }

  /** The server says the file changed (hash) on disk. */
  async remoteChanged(path: string, hash: string): Promise<void> {
    const b = this.buffers.get(path);
    if (!b || b.diskHash === hash) return;
    // Dirty or mid-save: leave it. The pending save resolves it safely.
    if (b.dirty || b.saving || b.saveTimer) return;
    let note;
    try {
      note = await api.read(path);
    } catch {
      return;
    }
    // Re-check: the user may have typed while we were fetching.
    if (b.dirty || b.saving || b.saveTimer) return;
    const doc = Text.of(note.text.split(/\r\n?|\n/));
    b.diskHash = note.hash;
    b.savedDoc = doc;
    if (!b.doc.eq(doc)) {
      b.doc = doc;
      for (const v of b.views) v.replaceDoc(doc);
    }
    this.refresh(b);
  }

  remoteDeleted(path: string): void {
    const b = this.buffers.get(path);
    if (!b) return;
    if (b.dirty || b.saving || b.saveTimer) {
      // Keep it: the next save recreates the file with the user's text.
      b.diskHash = null;
      return;
    }
    b.deleted = true;
    this.buffers.delete(path);
    this.emit("deleted", path);
  }

  /** After reconnecting, catch up on any events we missed. */
  async revalidate(): Promise<void> {
    for (const b of this.all()) {
      try {
        const note = await api.read(b.path);
        await this.remoteChanged(b.path, note.hash);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) this.remoteDeleted(b.path);
      }
    }
  }

  forget(path: string): void {
    const b = this.buffers.get(path);
    if (!b) return;
    if (b.saveTimer) clearTimeout(b.saveTimer);
    b.saveTimer = null;
    b.savedDoc = b.doc;
    this.buffers.delete(path);
    this.stash();
  }

  // --- crash safety ---------------------------------------------------------

  private stashTimer: ReturnType<typeof setTimeout> | null = null;

  private stash(): void {
    if (this.stashTimer) return;
    this.stashTimer = setTimeout(() => {
      this.stashTimer = null;
      const unsaved = this.all()
        .filter((b) => b.dirty)
        .map((b) => ({ path: b.path, text: b.doc.toString(), baseHash: b.diskHash }));
      try {
        if (unsaved.length) localStorage.setItem(STASH_KEY, JSON.stringify(unsaved));
        else localStorage.removeItem(STASH_KEY);
      } catch {
        /* storage full or unavailable */
      }
    }, 300);
  }

  /** On startup: push any text that never reached the server. Returns how many were recovered. */
  async recoverStash(): Promise<number> {
    let entries: { path: string; text: string; baseHash: string | null }[] = [];
    try {
      entries = JSON.parse(localStorage.getItem(STASH_KEY) ?? "[]");
    } catch {
      return 0;
    }
    let n = 0;
    for (const e of entries) {
      try {
        const current = await api.read(e.path).catch(() => null);
        if (current && current.text.replace(/\r\n/g, "\n") === e.text) continue;
        const res = await api.save({ path: e.path, text: e.text, baseHash: e.baseHash });
        n++;
        if (res.conflictCopy) this.emit("conflictCopy", e.path, res.conflictCopy);
      } catch {
        return n; // server unreachable: keep the stash for next time
      }
    }
    try {
      localStorage.removeItem(STASH_KEY);
    } catch {
      /* ignore */
    }
    return n;
  }

  /** Best-effort save while the page is closing. */
  saveOnUnload(): void {
    for (const b of this.all()) {
      if (!b.dirty) continue;
      void api.save({ path: b.path, text: b.doc.toString(), baseHash: b.diskHash }, true).catch(() => undefined);
    }
  }
}
