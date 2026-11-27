import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "../../server/config.ts";
import { Queue } from "../../server/git.ts";
import { createApp } from "../../server/http.ts";
import { NoteStore } from "../../server/notes.ts";
import { SearchIndex } from "../../server/search.ts";
import type { SyncStatusDto } from "../../shared/types.ts";
import { tempDir } from "../helpers.ts";

const status: SyncStatusDto = { state: "synced", lastSyncMs: 0, lastAttemptMs: 0, message: null, conflicts: [], ahead: 0, skipped: [] };

async function start(passwordHash?: string, opts: { allowedHosts?: string[]; noRuntime?: boolean; onShutdown?: () => void } = {}) {
  const dir = await tempDir("notes-http-");
  const store = new NoteStore({ root: dir, worktreeLock: new Queue(), machineName: "t" });
  const saved: string[][] = [];
  const runtime = {
    store,
    search: new SearchIndex(":memory:"),
    status: () => status,
    syncNow: async () => status,
    focus: () => undefined,
    saved: (p: string[]) => void saved.push(p),
  };
  const app = createApp({
    runtime: () => (opts.noRuntime ? null : runtime),
    info: () => ({
      configured: !opts.noRuntime,
      setupError: null,
      machineName: "t",
      repoPath: dir,
      notesDir: ".",
      remote: "origin",
      branch: "main",
      version: "test",
      defaultRepoPath: dir,
      platform: process.platform,
      local: true,
    }),
    host: "127.0.0.1",
    passwordHash: () => passwordHash,
    allowedHosts: () => opts.allowedHosts ?? [],
    webDir: dir,
    controlToken: "secret-token",
    shutdown: opts.onShutdown,
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    dir,
    base,
    saved,
    close: () => new Promise<void>((r) => app.server.close(() => r())),
  };
}

describe("HTTP API", () => {
  let s: Awaited<ReturnType<typeof start>>;
  before(async () => {
    s = await start();
  });
  after(async () => {
    await s.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  const H = { "Content-Type": "application/json", "X-Notes-App": "1" };

  test("create, save, list, read, delete", async () => {
    const created = await (await fetch(`${s.base}/api/notes`, { method: "POST", headers: H, body: JSON.stringify({ title: "Hi" }) })).json();
    assert.match(created.path, /^Home\/\d{8}-\d{6}-hi\.md$/, "new notes go to Home/ unless a mode is given");
    const save = await fetch(`${s.base}/api/note`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ path: created.path, text: "# Hi\n\nthere\n", baseHash: created.hash }),
    });
    assert.equal(save.status, 200);
    const list = await (await fetch(`${s.base}/api/notes`)).json();
    assert.equal(list[0].title, "Hi");
    const read = await (await fetch(`${s.base}/api/note?path=${encodeURIComponent(created.path)}`)).json();
    assert.equal(read.text, "# Hi\n\nthere\n");
    const del = await fetch(`${s.base}/api/note?path=${encodeURIComponent(created.path)}`, { method: "DELETE", headers: H });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${s.base}/api/note?path=${encodeURIComponent(created.path)}`)).status, 404);
  });

  test("DELETE with a stale hash is refused (an edit elsewhere wins)", async () => {
    const n = await (await fetch(`${s.base}/api/notes`, { method: "POST", headers: H, body: JSON.stringify({ title: "Keep" }) })).json();
    await fetch(`${s.base}/api/note`, { method: "PUT", headers: H, body: JSON.stringify({ path: n.path, text: "# Keep\n\nedited\n", baseHash: n.hash }) });
    const r = await fetch(`${s.base}/api/note?path=${encodeURIComponent(n.path)}&hash=${n.hash}`, { method: "DELETE", headers: H });
    assert.equal(r.status, 409);
    assert.equal((await fetch(`${s.base}/api/note?path=${encodeURIComponent(n.path)}`)).status, 200);
  });

  test("modes: POST with a mode, list filtered by mode, bad mode refused", async () => {
    const post = (body: unknown) => fetch(`${s.base}/api/notes`, { method: "POST", headers: H, body: JSON.stringify(body) });
    const w = await (await post({ title: "Standup", mode: "work" })).json();
    assert.match(w.path, /^Work\//);
    const hm = await (await post({ title: "Groceries", mode: "home" })).json();
    assert.match(hm.path, /^Home\//);
    assert.equal((await post({ title: "x", mode: "play" })).status, 400);
    const work = (await (await fetch(`${s.base}/api/notes?mode=work`)).json()) as { path: string }[];
    assert.ok(work.some((n) => n.path === w.path));
    assert.ok(work.every((n) => n.path.startsWith("Work/")));
    const home = (await (await fetch(`${s.base}/api/notes?mode=home`)).json()) as { path: string }[];
    assert.ok(home.some((n) => n.path === hm.path) && !home.some((n) => n.path === w.path));
    assert.equal((await fetch(`${s.base}/api/notes?mode=play`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/search?q=x&mode=play`)).status, 400);
  });

  test("a save to a note's pre-Home/ path lands in Home/ and says so", async () => {
    fs.mkdirSync(`${s.dir}/Home`, { recursive: true });
    fs.writeFileSync(`${s.dir}/Home/old.md`, "# Old\n");
    const read = await (await fetch(`${s.base}/api/note?path=old.md`)).json();
    assert.equal(read.path, "Home/old.md");
    const res = await (await fetch(`${s.base}/api/note`, { method: "PUT", headers: H, body: JSON.stringify({ path: "old.md", text: "# Old\n\nmore\n", baseHash: read.hash }) })).json();
    assert.equal(res.path, "Home/old.md");
    assert.equal(res.conflictCopy, undefined);
    assert.equal(fs.existsSync(`${s.dir}/old.md`), false);
  });

  test("mutations need the X-Notes-App header (CSRF)", async () => {
    const r = await fetch(`${s.base}/api/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
  });

  test("path traversal is rejected", async () => {
    const r = await fetch(`${s.base}/api/note?path=${encodeURIComponent("../../etc/passwd.md")}`);
    assert.equal(r.status, 400);
  });

  test("foreign Host header is rejected on loopback (DNS rebinding)", async () => {
    assert.equal(await getWithHost(s.base, "evil.example:80"), 421);
  });
});

async function getWithHost(base: string, host: string): Promise<number> {
  const http = await import("node:http");
  return new Promise<number>((resolve) => {
    http.get({ host: "127.0.0.1", port: new URL(base).port, path: "/api/info", headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
  });
}

describe("password guessing", () => {
  test("five wrong passwords lock the address out for a while, even with the right one", async () => {
    const s = await start(hashPassword("correct horse"));
    try {
      const get = (pw: string) => fetch(`${s.base}/api/info`, { headers: { Authorization: "Basic " + Buffer.from(`u:${pw}`).toString("base64") } });
      assert.equal((await fetch(`${s.base}/api/info`)).status, 401, "no credentials: not counted");
      for (let i = 0; i < 4; i++) assert.equal((await get("nope")).status, 401);
      assert.equal((await get("correct horse")).status, 200, "a success clears the count");
      for (let i = 0; i < 5; i++) assert.equal((await get("nope")).status, 401);
      const locked = await get("correct horse");
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get("retry-after")) > 0);
    } finally {
      await s.close();
    }
  });
});

describe("HTTP host names and setup mode", () => {
  test("an allowed host (e.g. Tailscale name) is accepted on loopback", async () => {
    const s = await start(hashPassword("long enough pw"), { allowedHosts: ["pi.tail1234.ts.net"] });
    try {
      assert.equal(await getWithHost(s.base, "pi.tail1234.ts.net"), 401); // reachable, but needs the password
      assert.equal(await getWithHost(s.base, "other.tail1234.ts.net"), 421);
    } finally {
      await s.close();
    }
  });

  test("without a notes folder, note endpoints ask for setup", async () => {
    const s = await start(undefined, { noRuntime: true });
    try {
      const info = await (await fetch(`${s.base}/api/info`)).json();
      assert.equal(info.configured, false);
      const r = await fetch(`${s.base}/api/notes`);
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /Set up/);
    } finally {
      await s.close();
    }
  });
});

describe("HTTP password", () => {
  test("requires Basic auth when a password is set", async () => {
    const s = await start(hashPassword("correct horse"));
    try {
      assert.equal((await fetch(`${s.base}/api/notes`)).status, 401);
      const bad = "Basic " + Buffer.from("u:wrong").toString("base64");
      assert.equal((await fetch(`${s.base}/api/notes`, { headers: { Authorization: bad } })).status, 401);
      const good = "Basic " + Buffer.from("anything:correct horse").toString("base64");
      assert.equal((await fetch(`${s.base}/api/notes`, { headers: { Authorization: good } })).status, 200);
    } finally {
      await s.close();
    }
  });
});

describe("local shutdown", () => {
  test("needs the control token, works without the password", async () => {
    let stopped = 0;
    const s = await start(hashPassword("long enough pw"), { onShutdown: () => stopped++ });
    try {
      const post = (token?: string) =>
        fetch(`${s.base}/api/shutdown`, { method: "POST", headers: { "X-Notes-App": "1", ...(token ? { "X-Notes-Control": token } : {}) }, body: "{}" });
      assert.equal((await post()).status, 403);
      assert.equal((await post("wrong-token!")).status, 403);
      assert.equal((await post("secret-token")).status, 200);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(stopped, 1);
    } finally {
      await s.close();
    }
  });
});
