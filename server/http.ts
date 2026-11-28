// HTTP API + static web UI + server-sent events.
//
// Security model:
// - Default bind is 127.0.0.1. On loopback, the Host header must be a loopback
//   name or one of the configured allowedHosts (e.g. a Tailscale name), which
//   blocks DNS-rebinding attacks from web pages.
// - Every mutating request needs the X-Notes-App header. Browsers cannot add
//   custom headers cross-origin without a CORS preflight, which is never
//   granted, so other websites cannot make changes (CSRF).
// - With a password set (required whenever other machines can reach the
//   server), every request needs HTTP Basic auth.

import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { keysForNote } from "../shared/links.ts";
import { inMode, isMode, type Mode } from "../shared/modes.ts";
import type {
  ChangeEntry,
  CommitEntry,
  AppInfo,
  Backlink,
  HistoryEntry,
  RemoteTestResult,
  SaveRequest,
  SaveResponse,
  ServerEvent,
  SettingsDto,
  SettingsPatch,
  SettingsResult,
  SetupRequest,
  SyncStatusDto,
} from "../shared/types.ts";
import { isLoopback, verifyPassword } from "./config.ts";
import { BadPath, Changed, Exists, NotFound, TooLarge, type NoteStore } from "./notes.ts";
import { FolderError, parseOutsidePath, type OutsideFolders } from "./folders.ts";
import type { SearchIndex } from "./search.ts";
import { SettingsError } from "./settings.ts";

/** What the API needs from a running notes folder (NotesRuntime, or a fake in tests). */
export interface RuntimeLike {
  store: NoteStore;
  search: SearchIndex;
  status(): SyncStatusDto;
  syncNow(): Promise<SyncStatusDto>;
  focus(): void;
  saved(paths: string[]): void;
  history?(notePath: string): Promise<HistoryEntry[]>;
  version?(commit: string, file: string): Promise<string>;
  changes?(mode: Mode | null): Promise<ChangeEntry[]>;
  commits?(mode: Mode | null, limit?: number): Promise<CommitEntry[]>;
  fileAt?(commit: string, path: string): Promise<string | null>;
}

export interface SettingsHandlers {
  get(): Promise<SettingsDto>;
  update(patch: SettingsPatch): Promise<SettingsResult>;
  testRemote(url: string): Promise<RemoteTestResult>;
  setup(req: SetupRequest): Promise<{ message: string }>;
  setPassword(password: string | null): Promise<{ message: string }>;
}

export interface AppContext {
  /** The open notes folder, or null while setup is needed. */
  runtime(): RuntimeLike | null;
  /** IDE mode's outside folders, or null when other machines can reach this server (then they're refused). */
  outside?(): OutsideFolders | null;
  /** True while the server holds its port but hasn't opened the notes folder yet: API calls get 503. */
  starting?(): boolean;
  info(): AppInfo;
  settings?: SettingsHandlers;
  /** Address the server listens on. */
  host: string;
  passwordHash(): string | undefined;
  allowedHosts(): string[];
  webDir: string;
  /** Graceful stop, requested from this machine (installer, `notes-app stop`). */
  shutdown?: () => void;
  /** Read a web UI file (relative path) from somewhere other than webDir, e.g. inside the executable. */
  readStatic?: (rel: string) => Buffer | null;
  /** Secret in a file only this user can read; lets local tools stop the server without the password. */
  controlToken?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

const MAX_BODY = 8 * 1024 * 1024; // JSON-escaped text of a 2 MB note can be larger than 2 MB

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(ctx: AppContext) {
  const clients = new Set<http.ServerResponse>();
  const verified = new Map<string, string>(); // header digest -> password hash it was checked against
  const gzipCache = new Map<string, { etag: string; gz: Buffer }>();
  const loopback = isLoopback(ctx.host);

  function broadcast(ev: ServerEvent): void {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(data);
  }

  // --- slow down password guessing ------------------------------------------
  // After 5 wrong passwords from one address, refuse that address for 30 s,
  // doubling with each further miss (max 15 min). Success clears it.
  const failures = new Map<string, { count: number; until: number }>();
  const FREE_TRIES = 5;

  function clientKey(req: http.IncomingMessage): string {
    const addr = req.socket.remoteAddress ?? "";
    // Behind `tailscale serve` everything arrives from loopback; use the forwarded address.
    if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) {
      const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
      if (fwd) return fwd;
    }
    return addr;
  }

  function lockedFor(key: string): number {
    const f = failures.get(key);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  function recordFailure(key: string): void {
    const f = failures.get(key) ?? { count: 0, until: 0 };
    f.count++;
    if (f.count >= FREE_TRIES) f.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (f.count - FREE_TRIES));
    failures.set(key, f);
    if (failures.size > 1000) failures.delete(failures.keys().next().value as string);
  }

  function checkAuth(req: http.IncomingMessage): boolean {
    const hash = ctx.passwordHash();
    if (!hash) return true;
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Basic ")) return false;
    const digest = createHash("sha256").update(h).digest("hex");
    if (verified.get(digest) === hash) return true;
    const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
    const pw = decoded.slice(decoded.indexOf(":") + 1);
    if (verifyPassword(pw, hash)) {
      verified.set(digest, hash);
      return true;
    }
    return false;
  }

  function hostAllowed(req: http.IncomingMessage): boolean {
    if (!loopback) return true;
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || ctx.allowedHosts().includes(host);
  }

  async function readJson<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "Request too large");
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
  }

  function send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  function rt(): RuntimeLike {
    const r = ctx.runtime();
    if (!r) throw new HttpError(409, "Set up your notes folder first.");
    return r;
  }

  function settings(): SettingsHandlers {
    if (!ctx.settings) throw new HttpError(404, "Not found");
    return ctx.settings;
  }

  function outside(): OutsideFolders {
    const o = ctx.outside?.();
    if (!o) throw new HttpError(403, "Outside folders are only available in Notes on your own computer, not over the network.");
    return o;
  }

  /** Where a request path lives: the notes folder, or an outside folder ("@<id>/<path>"). */
  function target(p: string): { store: NoteStore; rel: string; prefix: string } {
    const o = parseOutsidePath(p);
    if (!o) return { store: rt().store, rel: p, prefix: "" };
    return { store: outside().store(o.id), rel: o.rel, prefix: `@${o.id}/` };
  }

  /** Optional ?mode=home|work filter. */
  function modeParam(url: URL): Mode | null {
    const m = url.searchParams.get("mode");
    if (m === null || m === "") return null;
    if (!isMode(m)) throw new HttpError(400, 'mode must be "home" or "work"');
    return m;
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    if (method !== "GET" && req.headers["x-notes-app"] !== "1") throw new HttpError(403, "Missing X-Notes-App header");

    switch (route) {
      case "GET /api/info":
        return send(res, 200, ctx.info());
      case "GET /api/status":
        return send(res, 200, rt().status());
      case "GET /api/notes": {
        const mode = modeParam(url);
        const all = await rt().store.list();
        return send(res, 200, mode ? all.filter((n) => inMode(n.path, mode)) : all);
      }
      case "GET /api/files": {
        // Notes plus text/code files (IDE mode), sorted by path.
        const mode = modeParam(url);
        const all = await rt().store.files();
        return send(res, 200, mode ? all.filter((n) => inMode(n.path, mode)) : all);
      }
      case "GET /api/folders": {
        // Folders, including empty ones (IDE mode's tree shows them).
        const mode = modeParam(url);
        const all = await rt().store.folders();
        return send(res, 200, mode ? all.filter((p) => inMode(`${p}/x`, mode)) : all);
      }
      case "POST /api/folders": {
        const body = await readJson<{ path?: string }>(req);
        const t = target(String(body.path ?? ""));
        if (t.prefix) {
          const made = await t.store.createFolder(t.rel);
          broadcast({ type: "notes-changed" });
          return send(res, 201, { path: t.prefix + made });
        }
        const r = rt();
        const folder = await r.store.createFolder(String(body.path ?? ""));
        r.saved([]);
        broadcast({ type: "notes-changed" });
        return send(res, 201, { path: folder });
      }
      case "GET /api/outside":
        return send(res, 200, outside().list());
      case "POST /api/outside": {
        const body = await readJson<{ path?: string }>(req);
        return send(res, 201, outside().add(String(body.path ?? "")));
      }
      case "DELETE /api/outside": {
        outside().remove(url.searchParams.get("id") ?? "");
        return send(res, 200, { ok: true });
      }
      case "GET /api/outside/files": {
        const id = url.searchParams.get("id") ?? "";
        const files = await outside().store(id).files();
        return send(res, 200, files.map((f) => ({ ...f, path: `@${id}/${f.path}` })));
      }
      case "GET /api/outside/folders": {
        const id = url.searchParams.get("id") ?? "";
        return send(res, 200, (await outside().store(id).folders()).map((p) => `@${id}/${p}`));
      }
      case "POST /api/files": {
        const body = await readJson<{ path?: string }>(req);
        const t = target(String(body.path ?? ""));
        if (t.prefix) {
          const made = await t.store.createFile(t.rel);
          broadcast({ type: "notes-changed" });
          return send(res, 201, { ...made, path: t.prefix + made.path });
        }
        const r = rt();
        const file = await r.store.createFile(String(body.path ?? ""));
        r.saved([file.path]);
        broadcast({ type: "notes-changed" });
        return send(res, 201, file);
      }
      case "GET /api/git/changes": {
        const r = rt();
        if (!r.changes) throw new HttpError(404, "Not found");
        return send(res, 200, await r.changes(modeParam(url)));
      }
      case "GET /api/git/commits": {
        const r = rt();
        if (!r.commits) throw new HttpError(404, "Not found");
        const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
        return send(res, 200, await r.commits(modeParam(url), limit));
      }
      case "GET /api/git/file": {
        const r = rt();
        if (!r.fileAt) throw new HttpError(404, "Not found");
        let text: string | null;
        try {
          text = await r.fileAt(url.searchParams.get("commit") ?? "", url.searchParams.get("path") ?? "");
        } catch (err) {
          if (err instanceof BadPath) throw err;
          throw new HttpError(400, (err as Error).message);
        }
        if (text === null) throw new HttpError(404, "That file isn't in that commit.");
        return send(res, 200, { text });
      }
      case "GET /api/note": {
        const t = target(url.searchParams.get("path") ?? "");
        const note = await t.store.read(t.rel);
        return send(res, 200, { ...note, path: t.prefix + note.path });
      }
      case "PUT /api/note": {
        const body = await readJson<SaveRequest>(req);
        if (typeof body.text !== "string") throw new HttpError(400, "text is required");
        const t = target(String(body.path ?? ""));
        if (t.prefix) {
          // An outside folder: saved with the same conflict check, but never committed or synced.
          const out = await t.store.write(t.rel, body.text, body.baseHash ?? null);
          const result: SaveResponse = { hash: out.hash, ...(out.conflictCopy ? { conflictCopy: t.prefix + out.conflictCopy } : {}) };
          broadcast({ type: "note-changed", path: body.path, hash: out.hash });
          broadcast({ type: "notes-changed" });
          return send(res, 200, result);
        }
        const r = rt();
        const result = await r.store.write(body.path, body.text, body.baseHash ?? null);
        const saved = result.path ?? body.path;
        r.saved(result.conflictCopy ? [saved, result.conflictCopy] : [saved]);
        broadcast({ type: "note-changed", path: saved, hash: result.hash });
        broadcast({ type: "notes-changed" });
        return send(res, 200, result);
      }
      case "POST /api/notes": {
        const r = rt();
        const body = await readJson<{ title?: string; mode?: string }>(req);
        if (body.mode !== undefined && !isMode(body.mode)) throw new HttpError(400, 'mode must be "home" or "work"');
        const note = await r.store.create(typeof body.title === "string" ? body.title : "", body.mode ?? "home");
        r.saved([note.path]);
        broadcast({ type: "notes-changed" });
        return send(res, 201, note);
      }
      case "DELETE /api/note": {
        // Moves the note to the Trash.
        const p = url.searchParams.get("path") ?? "";
        if (parseOutsidePath(p)) throw new HttpError(400, "Notes doesn't delete files in outside folders (there's no Trash there). Use your file manager.");
        const r = rt();
        const trashPath = await r.store.trash(p, url.searchParams.get("hash") ?? undefined);
        r.search.remove(p);
        r.saved([]);
        broadcast({ type: "note-deleted", path: p });
        broadcast({ type: "notes-changed" });
        return send(res, 200, { ok: true, trashPath });
      }
      case "GET /api/trash":
        return send(res, 200, await rt().store.listTrash());
      case "GET /api/trash/note":
        return send(res, 200, await rt().store.readTrash(url.searchParams.get("path") ?? ""));
      case "POST /api/trash/restore": {
        const r = rt();
        const body = await readJson<{ path?: string }>(req);
        const restored = await r.store.restore(String(body.path ?? ""));
        r.saved([restored]);
        broadcast({ type: "notes-changed" });
        return send(res, 200, { path: restored });
      }
      case "DELETE /api/trash": {
        const r = rt();
        await r.store.purge(url.searchParams.get("path") ?? "");
        r.saved([]);
        return send(res, 200, { ok: true });
      }
      case "POST /api/trash/empty": {
        const r = rt();
        const count = await r.store.emptyTrash();
        r.saved([]);
        return send(res, 200, { count });
      }
      case "GET /api/search": {
        const q = url.searchParams.get("q") ?? "";
        const mode = modeParam(url);
        return send(res, 200, rt().search.search(q, mode ? (p) => inMode(p, mode) : undefined));
      }
      case "GET /api/backlinks": {
        const p = url.searchParams.get("path") ?? "";
        if (parseOutsidePath(p)) return send(res, 200, []); // outside folders: no links index
        const r = rt();
        r.store.resolve(p); // validates
        const meta = r.store.known.get(p)?.meta;
        const hits = r.search
          .backlinks(keysForNote(p, meta?.title ?? ""))
          .filter((b) => b.path !== p)
          .map((b) => ({ ...b, title: r.store.known.get(b.path)?.meta.title ?? b.path }));
        return send(res, 200, hits satisfies Backlink[]);
      }
      case "GET /api/history": {
        if (parseOutsidePath(url.searchParams.get("path") ?? "")) return send(res, 200, []); // not in the notes repo
        const r = rt();
        if (!r.history) throw new HttpError(404, "Not found");
        return send(res, 200, await r.history(url.searchParams.get("path") ?? ""));
      }
      case "GET /api/history/version": {
        const r = rt();
        if (!r.version) throw new HttpError(404, "Not found");
        try {
          const text = await r.version(url.searchParams.get("commit") ?? "", url.searchParams.get("file") ?? "");
          return send(res, 200, { text });
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      case "POST /api/sync":
        return send(res, 200, await rt().syncNow());
      case "POST /api/focus":
        ctx.runtime()?.focus();
        return send(res, 200, { ok: true });

      case "GET /api/settings":
        return send(res, 200, await settings().get());
      case "PUT /api/settings":
        return send(res, 200, await settings().update(await readJson<SettingsPatch>(req)));
      case "POST /api/settings/test-remote": {
        const body = await readJson<{ url?: string }>(req);
        return send(res, 200, await settings().testRemote(String(body.url ?? "")));
      }
      case "POST /api/settings/password": {
        const body = await readJson<{ password?: string | null }>(req);
        const pw = body.password === null || body.password === undefined ? null : String(body.password);
        return send(res, 200, await settings().setPassword(pw));
      }
      case "POST /api/setup":
        return send(res, 200, await settings().setup(await readJson<SetupRequest>(req)));

      case "GET /api/events": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`retry: 2000\n\n`);
        const r = ctx.runtime();
        if (r) res.write(`data: ${JSON.stringify({ type: "status", status: r.status() } satisfies ServerEvent)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      default:
        throw new HttpError(404, "Not found");
    }
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || !path.posix.extname(rel)) rel = "/index.html"; // single-page app
    const abs = path.resolve(ctx.webDir, "." + path.posix.normalize(rel));
    if (!abs.startsWith(path.resolve(ctx.webDir) + path.sep)) throw new HttpError(404, "Not found");
    let data: Buffer;
    if (ctx.readStatic) {
      const hit = ctx.readStatic(path.relative(ctx.webDir, abs).split(path.sep).join("/"));
      if (!hit) throw new HttpError(404, "Not found");
      data = hit;
    } else {
      try {
        data = fs.readFileSync(abs);
      } catch {
        throw new HttpError(404, "Not found");
      }
    }
    const etag = `"${createHash("sha1").update(data).digest("base64url")}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    let body = data;
    const compressible = /\.(js|css|html|svg|json|map|webmanifest)$/.test(abs) && data.length > 1024;
    if (compressible && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      let hit = gzipCache.get(abs);
      if (!hit || hit.etag !== etag) {
        hit = { etag, gz: zlib.gzipSync(data, { level: 9 }) };
        gzipCache.set(abs, hit);
      }
      body = hit.gz;
    }
    res.writeHead(200, {
      ...(body !== data ? { "Content-Encoding": "gzip" } : {}),
      Vary: "Accept-Encoding",
      "Content-Type": MIME[path.extname(abs)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      ...(abs.endsWith(".html")
        ? {
            "Content-Security-Policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
          }
        : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!hostAllowed(req)) throw new HttpError(421, "Unexpected Host header");
      if (url.pathname === "/api/shutdown" && req.method === "POST") {
        const addr = req.socket.remoteAddress ?? "";
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr);
        const token = String(req.headers["x-notes-control"] ?? "");
        if (!ctx.shutdown || !local || !ctx.controlToken || !safeEqual(token, ctx.controlToken)) throw new HttpError(403, "Not allowed");
        send(res, 200, { ok: true });
        setTimeout(() => ctx.shutdown?.(), 50);
        return;
      }
      if (ctx.passwordHash()) {
        const key = clientKey(req);
        const wait = lockedFor(key);
        if (wait) {
          res.writeHead(429, { "Retry-After": String(wait), "Content-Type": "text/plain" });
          res.end(`Too many wrong passwords. Try again in ${wait} seconds.`);
          return;
        }
        if (!checkAuth(req)) {
          if (req.headers.authorization) recordFailure(key);
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Notes", charset="UTF-8"', "Content-Type": "text/plain" });
          res.end("Password required");
          return;
        }
        failures.delete(key);
      }
      if (url.pathname.startsWith("/api/") && ctx.starting?.()) {
        // The port is ours but the notes folder isn't open yet (first sync can take a few seconds).
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "1", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Notes is starting…" }));
        return;
      }
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof BadPath || err instanceof SettingsError || err instanceof FolderError) return send(res, 400, { error: err.message });
      if (err instanceof NotFound) return send(res, 404, { error: err.message });
      if (err instanceof Changed || err instanceof Exists) return send(res, 409, { error: err.message });
      if (err instanceof TooLarge) return send(res, 413, { error: err.message });
      console.error(err);
      send(res, 500, { error: (err as Error).message });
    }
  });

  return {
    server,
    broadcast,
    closeClients() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
