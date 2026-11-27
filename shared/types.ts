// Types shared by the server and the web UI.

export interface NoteMeta {
  /** Relative to the notes root, POSIX separators, e.g. "20261125-221000-git-notes.md". */
  path: string;
  title: string;
  modifiedMs: number;
  tags: string[];
  /** True for "... (conflict YYYY-MM-DD host).md" copies. */
  conflict: boolean;
  /** sha256 of the file's bytes. Lets HTTP clients (KindleHub, scripts) sync only what changed. */
  hash: string;
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

export interface Backlink {
  path: string;
  title: string;
  /** The line of the linking note that contains the link. */
  context: string;
}

export interface AppInfo {
  /** False until a notes folder is set up: the UI shows the setup screen. */
  configured: boolean;
  /** Why the notes folder couldn't be opened, if it couldn't. */
  setupError: string | null;
  machineName: string;
  repoPath: string;
  notesDir: string;
  remote: string;
  branch: string;
  version: string;
  defaultRepoPath: string;
  platform: string;
  /** True when this server only listens on this computer (desktop use). */
  local: boolean;
}

export interface SettingsDto {
  repoPath: string;
  notesDir: string;
  remote: string;
  branch: string;
  machineName: string;
  sync: boolean;
  syncIdleSeconds: number;
  syncIntervalSeconds: number;
  /** URL of the sync remote from git config; null if none. */
  remoteUrl: string | null;
  host: string;
  port: number;
  allowedHosts: string[];
  hasPassword: boolean;
  configFile: string;
  dataDir: string;
  version: string;
  /** Settings currently forced by command-line flags (saved changes apply once started without them). */
  fromCommandLine: string[];
  /** This machine's SSH public key, to add to GitHub as a deploy key. */
  sshPublicKey: string | null;
}

export type SettingsPatch = Partial<
  Pick<SettingsDto, "repoPath" | "notesDir" | "remote" | "branch" | "machineName" | "sync" | "syncIdleSeconds" | "syncIntervalSeconds" | "remoteUrl" | "host" | "port" | "allowedHosts">
>;

export interface SettingsResult {
  settings: SettingsDto;
  /** Listening address/port changes only apply after a restart. */
  restartRequired: boolean;
  message: string;
}

export interface RemoteTestResult {
  ok: boolean;
  message: string;
  empty?: boolean;
  branches?: string[];
}

export interface SetupRequest {
  repoPath: string;
  remoteUrl: string | null;
  machineName: string;
}

export type ServerEvent =
  | { type: "status"; status: SyncStatusDto }
  | { type: "note-changed"; path: string; hash: string }
  | { type: "note-deleted"; path: string }
  | { type: "notes-changed" }
  /** Settings changed the notes folder or sync setup: reload the page. */
  | { type: "reconfigured" };

export const MARK_START = "\u0001";
export const MARK_END = "\u0002";
