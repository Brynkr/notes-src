// Note files: list, read, create, delete, and the single write path.
//
// Every write to a note goes through NoteStore.write (one writer per file).
// Writes hold the worktree lock shared with sync, so git never commits or
// merges while a file is half-written.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { NoteContent, NoteMeta, SaveResponse } from "../shared/types.ts";
import type { Queue } from "./git.ts";
import { extractTitle, parseTags, splitFrontMatter } from "../shared/markdown.ts";
import { conflictCopyName, isConflictCopy } from "./sync.ts";

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

  /** All note paths under the root (recursive, skipping hidden folders). */
  async walk(): Promise<string[]> {
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
    await visit(this.root, "");
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
    const abs = this.resolve(rel);
    return this.lock.run(async () => {
      const current = await fs.readFile(abs).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      const currentHash = current ? sha256(current) : null;

      // Preserve the file's existing line endings (the editor works in \n).
      let out = text;
      if (current && current.includes("\r\n")) out = out.replace(/\r?\n/g, "\r\n");
      const bytes = Buffer.from(out, "utf8");
      const newHash = sha256(bytes);
      if (newHash === currentHash) {
        await this.remember(rel, abs, bytes);
        return { hash: newHash };
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
      return conflictCopy ? { hash: newHash, conflictCopy } : { hash: newHash };
    });
  }

  async create(title: string): Promise<NoteContent> {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 200) || "Untitled";
    let name = noteFilename(clean, this.now());
    for (let i = 2; this.known.has(name) || (await exists(this.resolve(name))); i++) {
      name = name.replace(/(-\d+)?\.md$/, `-${i}.md`);
    }
    const text = `# ${clean}\n\n`;
    const { hash } = await this.write(name, text, null);
    return { path: name, text, hash };
  }

  async delete(rel: string): Promise<void> {
    const abs = this.resolve(rel);
    await this.lock.run(async () => {
      try {
        await fs.rm(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NotFound(`No such note: ${rel}`);
        throw err;
      }
      this.known.delete(rel);
    });
  }

  private async remember(rel: string, abs: string, buf: Buffer): Promise<void> {
    const st = await fs.stat(abs).catch(() => null);
    if (!st) return;
    const hash = sha256(buf);
    this.known.set(rel, { hash, mtimeMs: st.mtimeMs, size: st.size, meta: metaFor(rel, buf.toString("utf8"), st.mtimeMs, hash) });
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
