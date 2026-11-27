// Thin client for the server's HTTP API.

import type {
  AppInfo,
  Backlink,
  NoteContent,
  NoteMeta,
  RemoteTestResult,
  SaveRequest,
  SaveResponse,
  SearchHit,
  ServerEvent,
  HistoryEntry,
  SettingsDto,
  SettingsPatch,
  SettingsResult,
  SetupRequest,
  SyncStatusDto,
  TrashItem,
} from "../shared/types.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MUTATE = { "Content-Type": "application/json", "X-Notes-App": "1" };

async function call<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: method === "GET" ? {} : MUTATE,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError(0, "Can't reach the notes server");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

const q = encodeURIComponent;

export const api = {
  info: () => call<AppInfo>("GET", "/api/info"),
  status: () => call<SyncStatusDto>("GET", "/api/status"),
  list: () => call<NoteMeta[]>("GET", "/api/notes"),
  read: (path: string) => call<NoteContent>("GET", `/api/note?path=${q(path)}`),
  save: (req: SaveRequest, keepalive = false) => call<SaveResponse>("PUT", "/api/note", req, { keepalive }),
  create: (title: string) => call<NoteContent>("POST", "/api/notes", { title }),
  /** Moves the note to the Trash. */
  remove: (path: string) => call<{ ok: true; trashPath: string }>("DELETE", `/api/note?path=${q(path)}`),
  history: (path: string) => call<HistoryEntry[]>("GET", `/api/history?path=${q(path)}`),
  historyVersion: (commit: string, file: string) => call<{ text: string }>("GET", `/api/history/version?commit=${q(commit)}&file=${q(file)}`),
  trash: () => call<TrashItem[]>("GET", "/api/trash"),
  readTrash: (path: string) => call<{ path: string; text: string }>("GET", `/api/trash/note?path=${q(path)}`),
  restoreTrash: (path: string) => call<{ path: string }>("POST", "/api/trash/restore", { path }),
  purgeTrash: (path: string) => call<{ ok: true }>("DELETE", `/api/trash?path=${q(path)}`),
  emptyTrash: () => call<{ count: number }>("POST", "/api/trash/empty", {}),
  backlinks: (path: string) => call<Backlink[]>("GET", `/api/backlinks?path=${q(path)}`),
  search: (query: string) => call<SearchHit[]>("GET", `/api/search?q=${q(query)}`),
  sync: () => call<SyncStatusDto>("POST", "/api/sync", {}),
  focus: () => call<{ ok: true }>("POST", "/api/focus", {}),
  settings: () => call<SettingsDto>("GET", "/api/settings"),
  updateSettings: (patch: SettingsPatch) => call<SettingsResult>("PUT", "/api/settings", patch),
  testRemote: (url: string) => call<RemoteTestResult>("POST", "/api/settings/test-remote", { url }),
  setPassword: (password: string | null) => call<{ message: string }>("POST", "/api/settings/password", { password }),
  setup: (req: SetupRequest) => call<{ message: string }>("POST", "/api/setup", req),
};

/** Subscribe to server events. EventSource reconnects by itself. */
export function subscribe(onEvent: (ev: ServerEvent) => void, onConnection: (connected: boolean) => void): () => void {
  const es = new EventSource("/api/events");
  es.onopen = () => onConnection(true);
  es.onerror = () => onConnection(false);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data as string) as ServerEvent);
    } catch {
      /* ignore malformed */
    }
  };
  return () => es.close();
}
