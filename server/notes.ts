// Note files: list, read, create, delete, and the single write path.
//
// Every write to a note goes through NoteStore.write (one writer per file).
// Writes hold the worktree lock shared with sync, so git never commits or
// merges while a file is half-written.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { NoteContent, NoteMeta, SaveResponse, TrashItem } from "../shared/types.ts";
import type { Queue } from "./git.ts";
import { extractTitle, parseTags, splitFrontMatter } from "../shared/markdown.ts";
import { conflictCopyName, isConflictCopy } from "./sync.ts";
import { MODE_FOLDER, modeFolderOf, type Mode } from "../shared/modes.ts";

export { extractTitle, parseTags, splitFrontMatter };

export { NOTE_EXT } from "../shared/markdown.ts";
import { NOTE_EXT } from "../shared/markdown.ts";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s || "untitled";
}

/** Stable filename: YYYYMMDD-HHMMSS-slug.md (local time). Never changes after creation. */
export function noteFilename(title: string, d: Date = new Date()): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${slugify(title)}.md`;
}

export function metaFor(relPath: string, text: string, modifiedMs: number, hash: string): NoteMeta {
  return {
    path: relPath,
    hash,
    title: extractTitle(text, relPath),
    modifiedMs,
    tags: parseTags(splitFrontMatter(text).yaml),
    conflict: isConflictCopy(relPath),
  };
}

/**
 * Validate a client-supplied note path and resolve it under `root`.
 * Rejects absolute paths, `..`, hidden segments and non-Markdown files.
 */
export function resolveNotePath(root: string, rel: string): string {
  if (typeof rel !== "string" || !rel || rel.length > 512) throw new BadPath("Invalid note path");
  if (rel.includes("\0") || rel.includes("\\")) throw new BadPath("Invalid note path");
  const norm = path.posix.normalize(rel);
  if (norm !== rel || path.posix.isAbsolute(norm) || /^[A-Za-z]:/.test(norm)) throw new BadPath("Invalid note path");
  const segs = norm.split("/");
  if (segs.some((s) => s === ".." || s === "." || s.startsWith("."))) throw new BadPath("Invalid note path");
  if (!NOTE_EXT.test(norm)) throw new BadPath("Notes must be .md files");
  const abs = path.resolve(root, ...segs);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new BadPath("Invalid note path");
  return abs;
}

export class BadPath extends Error {}
export class TooLarge extends Error {}

/** Notes are text; anything bigger than this is almost certainly a mistake. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
export class Changed extends Error {}
export class NotFound extends Error {}

// ---------------------------------------------------------------------------

export interface NoteStoreOptions {
  /** Absolute path of the notes root (repo root or a subfolder of it). */
  root: string;
  worktreeLock: Queue;
  machineName: string;
  now?: () => Date;
}

interface Known {
  hash: string;
  mtimeMs: number;
  size: number;
  meta: NoteMeta;
}

export interface NoteStoreEvents {
  /** Notes whose content on disk differs from what the app last saw (external edits, merges). */
  changed: [paths: string[]];
  deleted: [paths: string[]];
}

/**
 * Emits `changed`/`deleted` whenever any scan notices a difference, whoever
 * triggered the scan (watcher, list request, startup), so no change is
 * silently absorbed.
 */
export class NoteStore extends EventEmitter<NoteStoreEvents> {
  readonly root: string;
  private readonly lock: Queue;
  private readonly machineName: string;
  private readonly now: () => Date;
  /** Last content we saw or wrote for each note. Used to ignore our own watcher events. */
  readonly known = new Map<string, Known>();

  constructor(opts: NoteStoreOptions) {
    super();
    this.root = path.resolve(opts.root);
    this.lock = opts.worktreeLock;
    this.machineName = opts.machineName;
    this.now = opts.now ?? (() => new Date());
  }

  resolve(rel: string): string {
    return resolveNotePath(this.root, rel);
  }

  /** Deleted notes live here (synced like any other file, hidden from the note list). */
  get trashRoot(): string {
    return path.join(this.root, TRASH_DIR);
  }

  resolveTrash(rel: string): string {
    return resolveNotePath(this.trashRoot, rel);
  }

  /** All note paths under the root (recursive, skipping hidden folders such as .trash). */
  async walk(root: string = this.root): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dirAbs: string, dirRel: string) => {
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (e.isDirectory()) await visit(path.join(dirAbs, e.name), rel);
        else if (e.isFile() && NOTE_EXT.test(e.name)) out.push(rel);
      }
    };
    await visit(root, "");
    return out.sort();
  }

  /**
   * Bring `known` up to date with the disk. Returns which paths changed or
   * disappeared since the last scan (including changes we did not make).
   */
  async scan(only?: string[]): Promise<{ changed: string[]; deleted: string[] }> {
    const changed: string[] = [];
    const deleted: string[] = [];
    const paths = only ?? (await this.walk());
    const seen = new Set<string>();
    for (const rel of paths) {
      let abs: string;
      try {
        abs = this.resolve(rel);
      } catch {
        continue;
      }
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        if (this.known.delete(rel)) deleted.push(rel);
        continue;
      }
      if (!st.isFile()) continue;
      seen.add(rel);
      const prev = this.known.get(rel);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      const buf = await fs.readFile(abs).catch(() => null);
      if (!buf) continue;
      const hash = sha256(buf);
      const meta = metaFor(rel, buf.toString("utf8"), st.mtimeMs, hash);
      this.known.set(rel, { hash, mtimeMs: st.mtimeMs, size: st.size, meta });
      if (!prev || prev.hash !== hash) changed.push(rel);
    }
    if (!only) {
      for (const rel of [...this.known.keys()]) {
        if (!seen.has(rel)) {
          this.known.delete(rel);
          deleted.push(rel);
        }
      }
    }
    if (changed.length) this.emit("changed", changed);
    if (deleted.length) this.emit("deleted", deleted);
    return { changed, deleted };
  }

  async list(): Promise<NoteMeta[]> {
    await this.scan();
    return [...this.known.values()].map((k) => k.meta).sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  async read(rel: string): Promise<NoteContent> {
    rel = await this.followMove(rel);
    const abs = this.resolve(rel);
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NotFound(`No such note: ${rel}`);
      throw err;
    }
    await this.remember(rel, abs, buf);
    return { path: rel, text: buf.toString("utf8"), hash: sha256(buf) };
  }

  /**
   * The single write path. If the file on disk no longer matches `baseHash`
   * (changed by a merge or another editor since the client loaded it), the
   * disk version is saved as a conflict copy first and the client's text wins.
   * Nothing is ever silently overwritten.
   */
  async write(rel: string, text: string, baseHash: string | null): Promise<SaveResponse> {
    this.resolve(rel); // validate before anything else
    return this.lock.run(async () => {
      const asked = rel;
      rel = await this.followMove(rel);
      const abs = this.resolve(rel);
      const current = await fs.readFile(abs).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      const currentHash = current ? sha256(current) : null;

      // Preserve the file's existing line endings (the editor works in \n).
      let out = text;
      if (current && current.includes("\r\n")) out = out.replace(/\r?\n/g, "\r\n");
      const bytes = Buffer.from(out, "utf8");
      if (bytes.length > MAX_NOTE_BYTES) {
        throw new TooLarge(`This note is ${(bytes.length / 1048576).toFixed(1)} MB; notes are limited to 2 MB. Split it up or remove pasted data.`);
      }
      const newHash = sha256(bytes);
      const moved = rel !== asked ? { path: rel } : {};
      if (newHash === currentHash) {
        await this.remember(rel, abs, bytes);
        return { hash: newHash, ...moved };
      }

      let conflictCopy: string | undefined;
      if (current && currentHash !== baseHash) {
        const date = this.now();
        const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        conflictCopy = await conflictCopyName(this.root, rel, ymd, this.machineName, new Set(this.known.keys()));
        await atomicWrite(this.resolve(conflictCopy), current);
        await this.remember(conflictCopy, this.resolve(conflictCopy), current);
      }

      await fs.mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, bytes);
      await this.remember(rel, abs, bytes);
      return conflictCopy ? { hash: newHash, conflictCopy, ...moved } : { hash: newHash, ...moved };
    });
  }

  /** New note with a server-chosen filename, in a mode's folder (or the root when `mode` is null). */
  async create(title: string, mode: Mode | null = null): Promise<NoteContent> {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 200) || "Untitled";
    const folder = mode ? MODE_FOLDER[mode] + "/" : "";
    let name = folder + noteFilename(clean, this.now());
    for (let i = 2; this.known.has(name) || (await exists(this.resolve(name))); i++) {
      name = name.replace(/(-\d+)?\.md$/, `-${i}.md`);
    }
    const text = `# ${clean}\n\n`;
    const { hash } = await this.write(name, text, null);
    return { path: name, text, hash };
  }

  /**
   * "Delete" a note: move it into the Trash, keeping its path, and return its
   * path inside the Trash. With `expectHash`, refuse (Changed) if the file no
   * longer has that content: an edit made elsewhere wins over a stale delete.
   */
  async trash(rel: string, expectHash?: string): Promise<string> {
    const abs = this.resolve(rel);
    return this.lock.run(async () => {
      const current = await fs.readFile(abs).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") throw new NotFound(`No such note: ${rel}`);
        throw err;
      });
      if (expectHash && sha256(current) !== expectHash) throw new Changed("The note changed since you last saw it; it was not deleted.");
      const dest = await uniquePath(this.trashRoot, rel, (i) => `-${i}`);
      const destAbs = this.resolveTrash(dest);
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await moveFile(abs, destAbs);
      const now = this.now();
      await fs.utimes(destAbs, now, now); // so the Trash sorts by when it was deleted
      this.known.delete(rel);
      return dest;
    });
  }

  /** Notes in the Trash, most recently deleted first. */
  async listTrash(): Promise<TrashItem[]> {
    const items: TrashItem[] = [];
    for (const rel of await this.walk(this.trashRoot)) {
      const abs = this.resolveTrash(rel);
      const [st, text] = await Promise.all([fs.stat(abs).catch(() => null), fs.readFile(abs, "utf8").catch(() => null)]);
      if (!st || text === null) continue;
      items.push({ path: rel, title: extractTitle(text, rel), deletedMs: st.mtimeMs, size: st.size });
    }
    return items.sort((a, b) => b.deletedMs - a.deletedMs);
  }

  async readTrash(rel: string): Promise<{ path: string; text: string }> {
    const text = await fs.readFile(this.resolveTrash(rel), "utf8").catch(() => {
      throw new NotFound(`Not in the Trash: ${rel}`);
    });
    return { path: rel, text };
  }

  /** Move a note back out of the Trash. If its old path is taken, it gets a "(restored)" name. Returns the new path. */
  async restore(trashRel: string): Promise<string> {
    const src = this.resolveTrash(trashRel);
    return this.lock.run(async () => {
      if (!(await exists(src))) throw new NotFound(`Not in the Trash: ${trashRel}`);
      const target = await uniquePath(this.root, trashRel, (i) => (i === 2 ? " (restored)" : ` (restored ${i - 1})`));
      const abs = this.resolve(target);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await moveFile(src, abs);
      const now = this.now();
      await fs.utimes(abs, now, now);
      await this.remember(target, abs, await fs.readFile(abs));
      await removeEmptyDirs(path.dirname(src), this.trashRoot);
      return target;
    });
  }

  /** Delete a note from the Trash for good (it remains in git history). */
  async purge(trashRel: string): Promise<void> {
    const abs = this.resolveTrash(trashRel);
    await this.lock.run(async () => {
      await fs.rm(abs).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") throw new NotFound(`Not in the Trash: ${trashRel}`);
        throw err;
      });
      await removeEmptyDirs(path.dirname(abs), this.trashRoot);
    });
  }

  async emptyTrash(): Promise<number> {
    const n = (await this.walk(this.trashRoot)).length;
    await this.lock.run(() => fs.rm(this.trashRoot, { recursive: true, force: true }));
    return n;
  }

  /**
   * Notes outside Home/ and Work/ are moved into Home/ (keeping any subfolders),
   * so the two modes are just two folders. Runs at startup; the next sync
   * commits the moves (git records them as renames, so history follows).
   *
   * If Home/ already has that path with other content (another machine moved
   * the note before this one's edits reached it):
   * - same bytes: the root file is a leftover and is removed;
   * - the Home/ copy is an earlier version of the root file (`isEarlier`,
   *   checked against git history): the root file's newer text replaces it;
   * - otherwise both were edited: the root file is kept as a conflict copy
   *   next to the Home/ note, so it shows in the conflict banner.
   * Nothing is ever lost. Returns [from, to] pairs.
   */
  async moveIntoModes(isEarlier?: (rel: string, homeAbs: string) => Promise<boolean>): Promise<[string, string][]> {
    return this.lock.run(async () => {
      const moved: [string, string][] = [];
      // An existing "home"/"work" folder in another case is used as is.
      const folders = new Map<Mode, string>();
      for (const e of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
        const m = e.isDirectory() ? modeFolderOf(e.name + "/x") : null;
        if (m) folders.set(m, e.name);
      }
      const home = folders.get("home") ?? MODE_FOLDER.home;
      const all = await this.walk();
      const taken = new Set(all);
      for (const rel of all) {
        if (modeFolderOf(rel)) continue;
        const src = this.resolve(rel);
        const buf = await fs.readFile(src).catch(() => null);
        if (!buf) continue;
        let dest = `${home}/${rel}`;
        const destAbs = this.resolve(dest);
        const existing = await fs.readFile(destAbs).catch(() => null);
        this.known.delete(rel);
        if (existing && existing.equals(buf)) {
          await fs.rm(src);
        } else if (existing && isEarlier && (await isEarlier(rel, destAbs))) {
          await atomicWrite(destAbs, buf);
          await fs.rm(src);
          await this.remember(dest, destAbs, buf);
        } else {
          if (existing) {
            const date = this.now();
            const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
            dest = await conflictCopyName(this.root, dest, ymd, this.machineName, taken);
          }
          taken.add(dest);
          const abs = this.resolve(dest);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await moveFile(src, abs);
          await this.remember(dest, abs, buf);
        }
        moved.push([rel, dest]);
        if (path.dirname(src) !== this.root) await removeEmptyDirs(path.dirname(src), path.join(this.root, rel.split("/")[0]));
      }
      return moved;
    });
  }

  /**
   * A client that still has a note's pre-Home/ path (an open tab from before
   * the move, an offline client) is sent to where the note is now, rather
   * than recreating it at the root.
   */
  private async followMove(rel: string): Promise<string> {
    if (modeFolderOf(rel)) return rel;
    if (await exists(this.resolve(rel))) return rel;
    // Root notes only ever move into Home/ (or a "home" folder made by hand).
    for (const folder of [MODE_FOLDER.home, MODE_FOLDER.home.toLowerCase()]) {
      const candidate = `${folder}/${rel}`;
      if (await exists(this.resolve(candidate))) return candidate;
    }
    return rel;
  }

  private async remember(rel: string, abs: string, buf: Buffer): Promise<void> {
    const st = await fs.stat(abs).catch(() => null);
    if (!st) return;
    const hash = sha256(buf);
    this.known.set(rel, { hash, mtimeMs: st.mtimeMs, size: st.size, meta: metaFor(rel, buf.toString("utf8"), st.mtimeMs, hash) });
  }
}

export const TRASH_DIR = ".trash";

/** `rel` if free under root, else rel with suffix(2), suffix(3)… before the extension. */
async function uniquePath(root: string, rel: string, suffix: (i: number) => string): Promise<string> {
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? rel : `${stem}${suffix(i)}${ext}`;
    if (!(await exists(path.join(root, ...candidate.split("/"))))) return candidate;
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.copyFile(from, to);
    await fs.rm(from);
  }
}

/** Remove now-empty folders from `dir` up to (and including) `stop`. */
async function removeEmptyDirs(dir: string, stop: string): Promise<void> {
  for (let d = dir; d.startsWith(stop); d = path.dirname(d)) {
    try {
      await fs.rmdir(d);
    } catch {
      return;
    }
    if (d === stop) return;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/** Write to a hidden temp file in the same folder, then rename over the target. */
async function atomicWrite(abs: string, data: Buffer): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, abs);
      return;
    } catch (err) {
      // Windows: another program may briefly hold the file open.
      if (attempt < 5 && ["EPERM", "EACCES", "EBUSY"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}
