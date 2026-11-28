import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "../../server/config.ts";
import { Queue } from "../../server/git.ts";
import { createApp } from "../../server/http.ts";
import { NoteStore } from "../../server/notes.ts";
import { OutsideFolders } from "../../server/folders.ts";
import os from "node:os";
import path from "node:path";
import { SearchIndex } from "../../server/search.ts";
import type { SyncStatusDto } from "../../shared/types.ts";
import { tempDir } from "../helpers.ts";

const status: SyncStatusDto = { state: "synced", lastSyncMs: 0, lastAttemptMs: 0, message: null, conflicts: [], ahead: 0, skipped: [] };

async function start(passwordHash?: string, opts: { allowedHosts?: string[]; noRuntime?: boolean; onShutdown?: () => void; outside?: OutsideFolders | null } = {}) {
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
      jamaUrl: "",
    }),
    host: "127.0.0.1",
    passwordHash: () => passwordHash,
    allowedHosts: () => opts.allowedHosts ?? [],
    webDir: dir,
    controlToken: "secret-token",
    shutdown: opts.onShutdown,
    outside: () => opts.outside ?? null,
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

  test("IDE mode: list files by mode, create a file, save code, refuse binaries", async () => {
    const mk = (p: string) => fetch(`${s.base}/api/files`, { method: "POST", headers: H, body: JSON.stringify({ path: p }) });
    const r = await mk("Work/tools/run.py");
    assert.equal(r.status, 201);
    const f = await r.json();
    assert.equal((await mk("Work/tools/run.py")).status, 409, "exists");
    assert.equal((await mk("Work/tools/pic.png")).status, 400, "not a text file");
    const save = await fetch(`${s.base}/api/note`, { method: "PUT", headers: H, body: JSON.stringify({ path: f.path, text: "print('hi')\n", baseHash: f.hash }) });
    assert.equal(save.status, 200);
    const files = (await (await fetch(`${s.base}/api/files?mode=work`)).json()) as { path: string; title: string; size: number }[];
    const run = files.find((x) => x.path === "Work/tools/run.py");
    assert.equal(run?.title, "run.py");
    assert.equal(run?.size, 12);
    assert.ok(files.every((x) => x.path.startsWith("Work/")));
    const notes = (await (await fetch(`${s.base}/api/notes`)).json()) as { path: string }[];
    assert.ok(!notes.some((n) => n.path.endsWith(".py")), "code files aren't notes");
    // The fake runtime has no git: these answer 404 rather than failing.
    assert.equal((await fetch(`${s.base}/api/git/changes`)).status, 404);
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

describe("HTTP API: IDE folders and outside folders", () => {
  test("folders: create (with .gitkeep), list by mode", async () => {
    const s = await start();
    try {
      const H = { "Content-Type": "application/json", "X-Notes-App": "1" };
      const r = await fetch(`${s.base}/api/folders`, { method: "POST", headers: H, body: JSON.stringify({ path: "Work/sensor" }) });
      assert.equal(r.status, 201);
      assert.equal(fs.existsSync(path.join(s.dir, "Work", "sensor", ".gitkeep")), true);
      assert.deepEqual(await (await fetch(`${s.base}/api/folders?mode=work`)).json(), ["Work", "Work/sensor"]);
      assert.deepEqual(await (await fetch(`${s.base}/api/folders?mode=home`)).json(), []);
      const again = await fetch(`${s.base}/api/folders`, { method: "POST", headers: H, body: JSON.stringify({ path: "Work/sensor" }) });
      assert.equal(again.status, 409);
    } finally {
      await s.close();
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("outside folders: @id paths read, save and create; no delete; refused when not local", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "notes-proj-"));
    fs.writeFileSync(path.join(proj, "main.py"), "print(1)\n");
    const outside = new OutsideFolders({ machineName: "t", notesRoot: () => null, onEvent: () => undefined, onChange: () => undefined });
    const s = await start(undefined, { outside });
    const H = { "Content-Type": "application/json", "X-Notes-App": "1" };
    try {
      const add = await fetch(`${s.base}/api/outside`, { method: "POST", headers: H, body: JSON.stringify({ path: proj }) });
      assert.equal(add.status, 201);
      const { id } = await add.json();
      assert.equal((await fetch(`${s.base}/api/outside`, { method: "POST", headers: H, body: JSON.stringify({ path: "not/absolute" }) })).status, 400);
      const files = await (await fetch(`${s.base}/api/outside/files?id=${id}`)).json();
      assert.deepEqual(files.map((f: { path: string }) => f.path), [`@${id}/main.py`]);
      const p = encodeURIComponent(`@${id}/main.py`);
      const read = await (await fetch(`${s.base}/api/note?path=${p}`)).json();
      assert.equal(read.path, `@${id}/main.py`);
      assert.equal(read.text, "print(1)\n");
      const save = await fetch(`${s.base}/api/note`, { method: "PUT", headers: H, body: JSON.stringify({ path: `@${id}/main.py`, text: "print(2)\n", baseHash: read.hash }) });
      assert.equal(save.status, 200);
      assert.equal(fs.readFileSync(path.join(proj, "main.py"), "utf8"), "print(2)\n");
      assert.deepEqual(s.saved.flat().filter((x) => x.includes("main.py")), [], "outside saves don't trigger a notes sync");
      const made = await fetch(`${s.base}/api/files`, { method: "POST", headers: H, body: JSON.stringify({ path: `@${id}/lib/util.py` }) });
      assert.equal(made.status, 201);
      assert.equal(fs.existsSync(path.join(proj, "lib", "util.py")), true);
      assert.equal((await fetch(`${s.base}/api/note?path=${p}`, { method: "DELETE", headers: H })).status, 400, "no deleting outside");
      assert.deepEqual(await (await fetch(`${s.base}/api/backlinks?path=${p}`)).json(), []);
      assert.equal((await fetch(`${s.base}/api/note?path=${encodeURIComponent(`@${id}/../escape.py`)}`)).status, 400);
      assert.equal((await fetch(`${s.base}/api/note?path=${encodeURIComponent("@00000000/x.py")}`)).status, 400, "unknown folder");
    } finally {
      outside.stopAll();
      await s.close();
      fs.rmSync(s.dir, { recursive: true, force: true });
    }

    // Reachable from other machines (Pi, Tailscale): outside folders don't exist.
    const exposed = await start(undefined, { outside: null });
    try {
      assert.equal((await fetch(`${exposed.base}/api/outside`)).status, 403);
      assert.equal((await fetch(`${exposed.base}/api/note?path=${encodeURIComponent("@ab12cd34/x.py")}`)).status, 403);
    } finally {
      await exposed.close();
      fs.rmSync(exposed.dir, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("HTTP API: images in notes", () => {
  test("upload (raw bytes, needs the CSRF header), then fetch with its type and a long cache", async () => {
    const s = await start();
    try {
      const img = Buffer.from("RIFF0000WEBPVP8 ", "latin1");
      const up = (headers: Record<string, string>, body: Buffer = img) =>
        fetch(`${s.base}/api/images?note=${encodeURIComponent("Work/20261128-090000-plan.md")}`, { method: "POST", headers, body: new Uint8Array(body) });
      assert.equal((await up({ "Content-Type": "image/webp" })).status, 403, "CSRF header required");
      const r = await up({ "Content-Type": "image/webp", "X-Notes-App": "1" });
      assert.equal(r.status, 201);
      const { path: p, markdown } = await r.json();
      assert.match(p, /^Work\/images\/\d{8}-\d{6}-[0-9a-f]{6}\.webp$/);
      assert.equal(markdown, `![](${p.slice("Work/".length)})`);
      const got = await fetch(`${s.base}/api/file?path=${encodeURIComponent(p)}`);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get("content-type"), "image/webp");
      assert.match(got.headers.get("cache-control") ?? "", /immutable/);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), img);
      assert.equal((await up({ "Content-Type": "text/html", "X-Notes-App": "1" })).status, 400, "not an image type");
      assert.equal((await up({ "Content-Type": "image/png", "X-Notes-App": "1" }, Buffer.alloc(7 * 1024 * 1024))).status, 413);
      assert.equal((await fetch(`${s.base}/api/file?path=${encodeURIComponent("../../etc/passwd.png")}`)).status, 400);
      assert.equal((await fetch(`${s.base}/api/file?path=${encodeURIComponent("Work/x.md")}`)).status, 400, "only images");
    } finally {
      await s.close();
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });
});
