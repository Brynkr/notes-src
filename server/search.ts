// Full-text search over notes using SQLite FTS5 (built into Node 22.13+).
// The index is disposable: it lives in the app-data folder, is never
// committed, and is rebuilt if missing or corrupt.

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { MARK_END, MARK_START, type SearchHit } from "../shared/types.ts";
import { linkKey, parseWikiLinks } from "../shared/links.ts";
import { extractTitle, splitFrontMatter } from "./notes.ts";

const SCHEMA_VERSION = 2;

type DatabaseSync = DatabaseSyncType;
// Loaded lazily (not a static import) so server/quiet.ts can filter its warning first.
let DatabaseSyncCtor: typeof DatabaseSyncType | null = null;
function sqlite(): typeof DatabaseSyncType {
  DatabaseSyncCtor ??= (process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
  return DatabaseSyncCtor;
}

export class SearchIndex {
  private db: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.db = this.open();
  }

  private open(): DatabaseSync {
    if (this.file !== ":memory:") fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      return this.init(new (sqlite())(this.file));
    } catch {
      // Corrupt or from an incompatible version: throw it away and start again.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(this.file + suffix, { force: true });
      return this.init(new (sqlite())(this.file));
    }
  }

  private init(db: DatabaseSync): DatabaseSync {
    db.exec("PRAGMA journal_mode = WAL");
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v !== SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS links;");
      db.exec(`
        CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, hash TEXT NOT NULL);
        CREATE VIRTUAL TABLE fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
        CREATE TABLE links (src_id INTEGER NOT NULL, target TEXT NOT NULL, context TEXT NOT NULL);
        CREATE INDEX links_target ON links (target);
        CREATE INDEX links_src ON links (src_id);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    }
    // Fail now (and trigger a rebuild) if the file is unreadable.
    db.prepare("SELECT count(*) FROM files").get();
    db.prepare("SELECT count(*) FROM fts").get();
    return db;
  }

  /** Paths and hashes currently indexed. */
  indexed(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, hash FROM files").all() as { path: string; hash: string }[];
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  upsert(notePath: string, hash: string, text: string): void {
    const title = extractTitle(text, notePath);
    const body = splitFrontMatter(text).body;
    const row = this.db.prepare("SELECT id, hash FROM files WHERE path = ?").get(notePath) as { id: number; hash: string } | undefined;
    if (row && row.hash === hash) return;
    this.db.exec("BEGIN");
    try {
      let id: number;
      if (row) {
        id = row.id;
        this.db.prepare("UPDATE files SET hash = ? WHERE id = ?").run(hash, id);
        this.db.prepare("DELETE FROM fts WHERE rowid = ?").run(id);
        this.db.prepare("DELETE FROM links WHERE src_id = ?").run(id);
      } else {
        id = Number(this.db.prepare("INSERT INTO files (path, hash) VALUES (?, ?)").run(notePath, hash).lastInsertRowid);
      }
      this.db.prepare("INSERT INTO fts (rowid, title, body) VALUES (?, ?, ?)").run(id, title, body);
      const insertLink = this.db.prepare("INSERT INTO links (src_id, target, context) VALUES (?, ?, ?)");
      for (const link of parseWikiLinks(text)) {
        insertLink.run(id, linkKey(link.target), lineAround(text, link.from));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  remove(notePath: string): void {
    const row = this.db.prepare("SELECT id FROM files WHERE path = ?").get(notePath) as { id: number } | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM fts WHERE rowid = ?").run(row.id);
    this.db.prepare("DELETE FROM links WHERE src_id = ?").run(row.id);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
  }

  search(query: string, limit = 50): SearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT files.path AS path, fts.title AS title,
                snippet(fts, 1, ?, ?, '…', 12) AS snippet
         FROM fts JOIN files ON files.id = fts.rowid
         WHERE fts MATCH ?
         ORDER BY bm25(fts, 8.0, 1.0)
         LIMIT ?`,
      )
      .all(MARK_START, MARK_END, match, limit) as unknown as SearchHit[];
    return rows.map((r) => ({ ...r, snippet: cleanSnippet(r.snippet) }));
  }

  /** Notes containing a wiki link to any of `keys` (see keysForNote), with the linking line. */
  backlinks(keys: string[]): { path: string; context: string }[] {
    if (!keys.length) return [];
    const rows = this.db
      .prepare(
        `SELECT files.path AS path, links.context AS context
         FROM links JOIN files ON files.id = links.src_id
         WHERE links.target IN (${keys.map(() => "?").join(",")})
         ORDER BY files.path`,
      )
      .all(...keys) as { path: string; context: string }[];
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.path) && (seen.add(r.path), true)).map((r) => ({ ...r }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Turn free text into a safe FTS5 query: every word must match, the last one
 * as a prefix (search-as-you-type). User input never reaches FTS syntax.
 */
export function toFtsQuery(input: string): string {
  const words = input
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length) return "";
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

/**
 * Strip Markdown syntax from a search snippet so it reads as plain text,
 * keeping the match markers.
 */
export function cleanSnippet(s: string): string {
  return s
    .replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, "$1")
    .replace(/(^|\n)[ \t]*>[ \t]?/g, "$1")
    .replace(/(^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/g, "$1")
    .replace(/\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_m, target: string, alias?: string) => alias || target)
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\*\*|__|~~|`+/g, "")
    .replace(/(^|[\s(\u0001])\*(?=\S)|(?<=\S)\*(?=[\s).,;:!?\u0002]|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The line containing `offset`, trimmed to a readable length around it. */
function lineAround(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  let end = text.indexOf("\n", offset);
  if (end < 0) end = text.length;
  let line = text.slice(start, end).trim();
  if (line.length > 160) {
    const rel = Math.max(0, offset - start - 60);
    line = (rel > 0 ? "…" : "") + line.slice(rel, rel + 158).trim() + "…";
  }
  return line;
}
