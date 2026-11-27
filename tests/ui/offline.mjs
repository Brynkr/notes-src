// Offline: with the server stopped, the app still opens (service worker),
// shows cached notes, keeps typing safe across reloads, and saves once the
// server is back. Run: npm run test:ui

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) =>
    fs.existsSync(p),
  );
const SHOTS = process.env.SHOTS ?? path.resolve("tests/ui/screenshots");
const PORT = 4796;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-offline-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  NOTES_APP_CONFIG_DIR: path.join(root, "cfg"),
  NOTES_APP_DATA_DIR: path.join(root, "data"),
};
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");
const repo = path.join(root, "notes");
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
fs.writeFileSync(path.join(repo, "20261127-100000-first.md"), "# First\n\nOpened online.\n");
fs.writeFileSync(path.join(repo, "20261127-090000-second.md"), "# Second\n\nNever opened before going offline.\n");
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
async function startServer() {
  server = spawn(process.execPath, ["dist/server.js", "--repo", repo, "--port", String(PORT), "--no-sync"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  for (let i = 0; i < 50 && !log.includes("open:"); i++) await sleep(100);
}
async function stopServer() {
  const s = server;
  server = null;
  s.kill("SIGTERM");
  await new Promise((r) => s.once("exit", r));
}

await startServer();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 760 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const waitFor = async (fn, what, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  await fn();
  console.log("ok");
};
const activeText = () => page.$eval(".pane.active .cm-content", (e) => e.innerText);
const second = path.join(repo, "20261127-090000-second.md");

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

  await step("service worker installs and caches every note", async () => {
    await page.waitForSelector(".pane .cm-content");
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, { timeout: 10000 }).catch(async () => {
      await page.reload({ waitUntil: "domcontentloaded" }); // first load may finish before the worker takes control
      await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 10000 });
    });
    await waitFor(
      () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("notes-app:offline-warm:v1") ?? "{}")).length === 2),
      "cache warmed",
    );
  });

  await step("with the server stopped, the app opens and shows a never-opened note", async () => {
    await stopServer();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".note-item");
    await page.waitForSelector(".sync-dot.error");
    const items = await page.$$eval(".note-item .note-title", (els) => els.map((e) => e.textContent));
    assert.deepEqual(items.sort(), ["First", "Second"]);
    await page.click('.note-item[data-path="20261127-090000-second.md"]');
    await waitFor(async () => (await activeText()).includes("Never opened before going offline"), "cached note");
    await page.screenshot({ path: path.join(SHOTS, "19-offline.png") });
  });

  await step("typing offline survives a reload", async () => {
    await page.click(".pane.active .cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    await page.keyboard.type("Written offline.");
    await sleep(1200); // save attempt fails; text is stashed
    assert.equal(fs.readFileSync(second, "utf8").includes("Written offline"), false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click('.note-item[data-path="20261127-090000-second.md"]').catch(() => undefined);
    await waitFor(async () => (await activeText().catch(() => "")).includes("Written offline."), "stashed text shown after reload");
  });

  await step("when the server is back, the offline text is saved", async () => {
    await startServer();
    await waitFor(() => fs.readFileSync(second, "utf8").includes("Written offline."), "saved to disk", 30000);
    assert.equal(fs.readFileSync(second, "utf8"), "# Second\n\nNever opened before going offline.\nWritten offline.");
    await waitFor(() => page.evaluate(() => !localStorage.getItem("notes-app:unsaved:v1")), "stash cleared");
  });

  assert.deepEqual(errors, [], "page errors");
  console.log("\nAll offline checks passed.");
} catch (err) {
  console.log("FAILED");
  console.error(err);
  await page.screenshot({ path: path.join(SHOTS, "failure-offline.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (server) await stopServer();
  fs.rmSync(root, { recursive: true, force: true });
}
