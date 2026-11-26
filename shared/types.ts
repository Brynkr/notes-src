// Types shared by the server and the web UI.

export interface NoteMeta {
  /** Relative to the notes root, POSIX separators, e.g. "20261125-221000-git-notes.md". */
  path: string;
  title: string;
  modifiedMs: number;
  tags: string[];
  /** True for "... (conflict YYYY-MM-DD host).md" copies. */
  conflict: boolean;
}

export interface NoteContent {
  path: string;
  text: string;
  /** sha256 of the bytes on disk. Send it back as baseHash when saving. */
  hash: string;
}

export interface SaveRequest {
  path: string;
  text: string;
  /** Hash the client's text was based on; null if the client believes the file is new. */
  baseHash: string | null;
}

export interface SaveResponse {
  hash: string;
  /** Set when the file had changed on disk: the disk version was saved here. */
  conflictCopy?: string;
}

export type SyncState = "synced" | "syncing" | "offline" | "conflict" | "error" | "local" | "disabled";

export interface SyncStatusDto {
  state: SyncState;
  lastSyncMs: number | null;
  lastAttemptMs: number | null;
  message: string | null;
  /** Notes-root-relative paths of conflict copies. */
  conflicts: string[];
  ahead: number;
}

export interface SearchHit {
  path: string;
  title: string;
  /** Snippet text with \u0001 ... \u0002 around matches. Escape it, then replace the markers. */
  snippet: string;
}

export interface AppInfo {
  machineName: string;
  repoPath: string;
  notesDir: string;
  remote: string;
  branch: string;
  version: string;
}

export type ServerEvent =
  | { type: "status"; status: SyncStatusDto }
  | { type: "note-changed"; path: string; hash: string }
  | { type: "note-deleted"; path: string }
  | { type: "notes-changed" };

export const MARK_START = "\u0001";
export const MARK_END = "\u0002";
