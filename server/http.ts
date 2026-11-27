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
import type {
  AppInfo,
  Backlink,
  RemoteTestResult,
  SaveRequest,
  ServerEvent,
  SettingsDto,
  SettingsPatch,
  SettingsResult,
  SetupRequest,
  SyncStatusDto,
} from "../shared/types.ts";
import { isLoopback, verifyPassword } from "./config.ts";
import { BadPath, Changed, NotFound, type NoteStore } from "./notes.ts";
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
  info(): AppInfo;
  settings?: SettingsHandlers;
  /** Address the server listens on. */
  host: string;
  passwordHash(): string | undefined;
  allowedHosts(): string[];
  webDir: string;
  /** Graceful stop, requested from this machine (installer, `notes-app stop`). */
  shutdown?: () => void;
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

const MAX_BODY = 5 * 1024 * 1024;

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

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    if (method !== "GET" && req.headers["x-notes-app"] !== "1") throw new HttpError(403, "Missing X-Notes-App header");

    switch (route) {
      case "GET /api/info":
        return send(res, 200, ctx.info());
      case "GET /api/status":
        return send(res, 200, rt().status());
      case "GET /api/notes":
        return send(res, 200, await rt().store.list());
      case "GET /api/note": {
        const p = url.searchParams.get("path") ?? "";
        return send(res, 200, await rt().store.read(p));
      }
      case "PUT /api/note": {
        const r = rt();
        const body = await readJson<SaveRequest>(req);
        if (typeof body.text !== "string") throw new HttpError(400, "text is required");
        const result = await r.store.write(body.path, body.text, body.baseHash ?? null);
        r.saved(result.conflictCopy ? [body.path, result.conflictCopy] : [body.path]);
        broadcast({ type: "note-changed", path: body.path, hash: result.hash });
        broadcast({ type: "notes-changed" });
        return send(res, 200, result);
      }
      case "POST /api/notes": {
        const r = rt();
        const body = await readJson<{ title?: string }>(req);
        const note = await r.store.create(typeof body.title === "string" ? body.title : "");
        r.saved([note.path]);
        broadcast({ type: "notes-changed" });
        return send(res, 201, note);
      }
      case "DELETE /api/note": {
        const r = rt();
        const p = url.searchParams.get("path") ?? "";
        await r.store.delete(p, url.searchParams.get("hash") ?? undefined);
        r.search.remove(p);
        r.saved([]);
        broadcast({ type: "note-deleted", path: p });
        broadcast({ type: "notes-changed" });
        return send(res, 200, { ok: true });
      }
      case "GET /api/search": {
        const q = url.searchParams.get("q") ?? "";
        return send(res, 200, rt().search.search(q));
      }
      case "GET /api/backlinks": {
        const r = rt();
        const p = url.searchParams.get("path") ?? "";
        r.store.resolve(p); // validates
        const meta = r.store.known.get(p)?.meta;
        const hits = r.search
          .backlinks(keysForNote(p, meta?.title ?? ""))
          .filter((b) => b.path !== p)
          .map((b) => ({ ...b, title: r.store.known.get(b.path)?.meta.title ?? b.path }));
        return send(res, 200, hits satisfies Backlink[]);
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
    try {
      data = fs.readFileSync(abs);
    } catch {
      throw new HttpError(404, "Not found");
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
      if (!checkAuth(req)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Notes", charset="UTF-8"', "Content-Type": "text/plain" });
        res.end("Password required");
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
      if (err instanceof BadPath || err instanceof SettingsError) return send(res, 400, { error: err.message });
      if (err instanceof NotFound) return send(res, 404, { error: err.message });
      if (err instanceof Changed) return send(res, 409, { error: err.message });
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
