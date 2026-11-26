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

const status: SyncStatusDto = { state: "synced", lastSyncMs: 0, lastAttemptMs: 0, message: null, conflicts: [], ahead: 0 };

async function start(passwordHash?: string) {
  const dir = await tempDir("notes-http-");
  const store = new NoteStore({ root: dir, worktreeLock: new Queue(), machineName: "t" });
  const saved: string[][] = [];
  const app = createApp({
    store,
    search: new SearchIndex(":memory:"),
    info: { machineName: "t", repoPath: dir, notesDir: ".", remote: "origin", branch: "main", version: "test" },
    status: () => status,
    syncNow: async () => status,
    onFocus: () => undefined,
    onSaved: (p) => saved.push(p),
    host: "127.0.0.1",
    passwordHash,
    webDir: dir,
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
    assert.match(created.path, /^\d{8}-\d{6}-hi\.md$/);
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

  test("mutations need the X-Notes-App header (CSRF)", async () => {
    const r = await fetch(`${s.base}/api/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403);
  });

  test("path traversal is rejected", async () => {
    const r = await fetch(`${s.base}/api/note?path=${encodeURIComponent("../../etc/passwd.md")}`);
    assert.equal(r.status, 400);
  });

  test("foreign Host header is rejected on loopback (DNS rebinding)", async () => {
    const http = await import("node:http");
    const code = await new Promise<number>((resolve) => {
      const port = new URL(s.base).port;
      http.get({ host: "127.0.0.1", port, path: "/api/notes", headers: { Host: "evil.example:80" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    assert.equal(code, 421);
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
