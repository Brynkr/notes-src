// HTTP API + static web UI + server-sent events.
//
// Security model:
// - Default bind is 127.0.0.1. On loopback, the Host header must be a loopback
//   name (blocks DNS-rebinding attacks from web pages).
// - Every mutating request needs the X-Notes-App header. Browsers cannot add
//   custom headers cross-origin without a CORS preflight, which is never
//   granted, so other websites cannot make changes (CSRF).
// - With a password set (required for --lan), every request needs HTTP Basic
//   auth. Use it on a trusted network or over a VPN such as Tailscale.

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import type { AppInfo, SaveRequest, ServerEvent, SyncStatusDto } from "../shared/types.ts";
import { verifyPassword } from "./config.ts";
import { BadPath, NotFound, type NoteStore } from "./notes.ts";
import type { SearchIndex } from "./search.ts";

export interface AppContext {
  store: NoteStore;
  search: SearchIndex;
  info: AppInfo;
  status: () => SyncStatusDto;
  syncNow: () => Promise<SyncStatusDto>;
  onFocus: () => void;
  /** Called after any write, with the note paths whose content changed. */
  onSaved: (paths: string[]) => void;
  host: string;
  passwordHash?: string;
  webDir: string;
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
  const verified = new Set<string>();
  const gzipCache = new Map<string, { etag: string; gz: Buffer }>();
  const loopback = ctx.host === "127.0.0.1" || ctx.host === "localhost" || ctx.host === "::1";

  function broadcast(ev: ServerEvent): void {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(data);
  }

  function checkAuth(req: http.IncomingMessage): boolean {
    if (!ctx.passwordHash) return true;
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Basic ")) return false;
    const digest = createHash("sha256").update(h).digest("hex");
    if (verified.has(digest)) return true;
    const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
    const pw = decoded.slice(decoded.indexOf(":") + 1);
    if (verifyPassword(pw, ctx.passwordHash)) {
      verified.add(digest);
      return true;
    }
    return false;
  }

  function hostAllowed(req: http.IncomingMessage): boolean {
    if (!loopback) return true;
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
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
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
  }

  function send(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(json);
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    if (method !== "GET" && req.headers["x-notes-app"] !== "1") throw new HttpError(403, "Missing X-Notes-App header");

    switch (route) {
      case "GET /api/info":
        return send(res, 200, ctx.info);
      case "GET /api/status":
        return send(res, 200, ctx.status());
      case "GET /api/notes":
        return send(res, 200, await ctx.store.list());
      case "GET /api/note": {
        const p = url.searchParams.get("path") ?? "";
        return send(res, 200, await ctx.store.read(p));
      }
      case "PUT /api/note": {
        const body = await readJson<SaveRequest>(req);
        if (typeof body.text !== "string") throw new HttpError(400, "text is required");
        const result = await ctx.store.write(body.path, body.text, body.baseHash ?? null);
        ctx.onSaved(result.conflictCopy ? [body.path, result.conflictCopy] : [body.path]);
        broadcast({ type: "note-changed", path: body.path, hash: result.hash });
        broadcast({ type: "notes-changed" });
        return send(res, 200, result);
      }
      case "POST /api/notes": {
        const body = await readJson<{ title?: string }>(req);
        const note = await ctx.store.create(typeof body.title === "string" ? body.title : "");
        ctx.onSaved([note.path]);
        broadcast({ type: "notes-changed" });
        return send(res, 201, note);
      }
      case "DELETE /api/note": {
        const p = url.searchParams.get("path") ?? "";
        await ctx.store.delete(p);
        ctx.search.remove(p);
        ctx.onSaved([]);
        broadcast({ type: "note-deleted", path: p });
        broadcast({ type: "notes-changed" });
        return send(res, 200, { ok: true });
      }
      case "GET /api/search": {
        const q = url.searchParams.get("q") ?? "";
        return send(res, 200, ctx.search.search(q));
      }
      case "POST /api/sync":
        return send(res, 200, await ctx.syncNow());
      case "POST /api/focus":
        ctx.onFocus();
        return send(res, 200, { ok: true });
      case "GET /api/events": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`retry: 2000\n\n`);
        res.write(`data: ${JSON.stringify({ type: "status", status: ctx.status() } satisfies ServerEvent)}\n\n`);
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
    const wantsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    if (compressible && wantsGzip) {
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
      if (err instanceof BadPath) return send(res, 400, { error: err.message });
      if (err instanceof NotFound) return send(res, 404, { error: err.message });
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
