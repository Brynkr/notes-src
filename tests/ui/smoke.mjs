// End-to-end check in a real (headless) Chrome against a throwaway repo.
// A second clone plays "another machine". Run with: npm run test:ui
// Needs Chrome/Chromium; set CHROME=/path/to/chrome if it isn't found.

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
const PORT = 4799;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-ui-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  NOTES_APP_CONFIG_DIR: path.join(root, "cfg"),
  NOTES_APP_DATA_DIR: path.join(root, "data"),
};
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const remote = path.join(root, "remote.git");
const desk = path.join(root, "desk");
const other = path.join(root, "other");
git(root, "init", "-q", "--bare", "-b", "main", remote);
git(root, "clone", "-q", remote, desk);
fs.writeFileSync(path.join(desk, "20261120-090000-welcome.md"), "# Welcome\n\nThis note came from the repo.\n");
git(desk, "add", "-A");
git(desk, "commit", "-qm", "seed");
git(desk, "push", "-q", "origin", "main");
git(root, "clone", "-q", remote, other);

fs.mkdirSync(SHOTS, { recursive: true });
const server = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "dist/server.js", "--repo", desk, "--port", String(PORT), "--machine-name", "desk", "--sync-idle", "60", "--sync-interval", "0"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 50 && !serverLog.includes("open:"); i++) await sleep(100);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"] });
const errors = [];
let page;
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  await fn();
  console.log("ok");
};
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const editorText = (i = 0) => page.$$eval(".pane .cm-content", (els, i) => els[i]?.innerText ?? null, i);
const waitFor = async (fn, what, ms = 6000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
/** Click, retrying if the element was re-rendered between lookup and click. */
const clickSafe = async (selector) => {
  for (let i = 0; ; i++) {
    try {
      await page.waitForSelector(selector);
      return await page.click(selector);
    } catch (err) {
      if (i >= 4 || !/detached|not clickable/i.test(String(err))) throw err;
      await sleep(200);
    }
  }
};
const files = () => fs.readdirSync(desk).filter((f) => f.endsWith(".md")).sort();

try {
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Script errors only: a 404 for a note deleted mid-request is expected and handled.
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

  await step("opens the most recent note and shows sync state", async () => {
    await page.waitForSelector(".cm-content");
    assert.match(await editorText(), /This note came from the repo/);
    await waitFor(async () => (await page.$eval(".sync-label", (e) => e.textContent)).startsWith("Synced"), "synced label");
  });

  let notePath;
  await step("Alt+N creates a note; typing autosaves to disk", async () => {
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyN");
    await page.keyboard.up("Alt");
    await page.waitForSelector(".new-input", { visible: true });
    await page.type(".new-input", "Shopping list");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await page.$eval(".pane-title", (e) => e.textContent)) === "Shopping list", "new pane title");
    await sleep(200);
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    await page.keyboard.type("- eggs\ncoffee"); // Enter continues the list by itself
    notePath = await waitFor(() => files().find((f) => f.endsWith("-shopping-list.md")), "file on disk");
    assert.match(notePath, /^\d{8}-\d{6}-shopping-list\.md$/);
    await waitFor(() => fs.readFileSync(path.join(desk, notePath), "utf8").includes("- coffee"), "autosave");
    assert.equal(fs.readFileSync(path.join(desk, notePath), "utf8"), "# Shopping list\n\n- eggs\n- coffee");
    await shot("1-editor");
  });

  await step("Sync now pushes to the remote", async () => {
    await page.click(".sync .icon-btn");
    await waitFor(() => git(remote, "ls-tree", "--name-only", "main").includes(notePath), "push");
  });

  await step("a change from another machine reloads the clean buffer", async () => {
    git(other, "pull", "-q");
    fs.writeFileSync(path.join(other, notePath), "# Shopping list\n\n- eggs\n- coffee\n- bread (from other)\n\n");
    git(other, "commit", "-qam", "auto: x other");
    git(other, "push", "-q");
    await page.click(".sync .icon-btn");
    await waitFor(async () => (await editorText()).includes("bread (from other)"), "reload");
  });

  await step("split: same note in two panes stays in sync", async () => {
    await page.keyboard.down("Control");
    await page.keyboard.press("Backslash");
    await page.keyboard.up("Control");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2);
    await sleep(300);
    await clickSafe(".pane:nth-child(2) .cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    await page.keyboard.type("typed in pane two");
    await waitFor(async () => (await editorText(0)).includes("typed in pane two"), "mirror into pane 1");
    await waitFor(() => fs.readFileSync(path.join(desk, notePath), "utf8").includes("typed in pane two"), "save");
    const onDisk = fs.readFileSync(path.join(desk, notePath), "utf8");
    assert.equal((onDisk.match(/typed in pane two/g) ?? []).length, 1, "edit saved exactly once");
    await shot("2-split");
  });

  await step("editing while the file changes on disk keeps both (conflict copy)", async () => {
    await page.keyboard.type("- my unsaved line");
    fs.writeFileSync(path.join(desk, notePath), "# Shopping list\n\nreplaced by another editor\n");
    await waitFor(() => files().some((f) => f.includes("(conflict ")), "conflict copy file");
    const copy = files().find((f) => f.includes("(conflict "));
    assert.equal(fs.readFileSync(path.join(desk, copy), "utf8"), "# Shopping list\n\nreplaced by another editor\n");
    await waitFor(() => fs.readFileSync(path.join(desk, notePath), "utf8").includes("my unsaved line"), "our text kept");
    await page.waitForSelector(".toast-warn");
    await page.waitForSelector(".banner:not([hidden]) .chip");
    await shot("3-conflict");
    // Resolve: delete the copy from disk (as the user would after merging by hand).
    fs.rmSync(path.join(desk, copy));
    await page.waitForSelector(".banner[hidden]", { timeout: 5000 });
  });

  await step("git merge conflict from another machine: no markers, copy created", async () => {
    git(other, "pull", "-q");
    // Commit our side first so both machines changed the same lines.
    await page.click(".sync .icon-btn");
    await waitFor(async () => (await page.$eval(".sync-label", (e) => e.textContent)).startsWith("Synced"), "synced");
    git(other, "pull", "-q");
    fs.writeFileSync(path.join(other, notePath), "# Shopping list\n\nOTHER MACHINE VERSION\n");
    git(other, "commit", "-qam", "auto: 2026 laptop");
    git(other, "push", "-q");
    await clickSafe(".pane:nth-child(1) .cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.type("# Shopping list\n\nDESK VERSION\n");
    await waitFor(() => fs.readFileSync(path.join(desk, notePath), "utf8").includes("DESK VERSION"), "save");
    await page.click(".sync .icon-btn");
    await waitFor(() => files().some((f) => f.includes("(conflict ") && f.includes("laptop")), "merge conflict copy");
    for (const f of files()) assert.doesNotMatch(fs.readFileSync(path.join(desk, f), "utf8"), /^<<<<<<< /m, f);
    assert.match(await editorText(), /DESK VERSION/);
    await waitFor(async () => (await page.$eval(".sync-label", (e) => e.textContent)).includes("conflict"), "conflict label");
    await page.click(".banner .chip");
    const allText = () => page.$$eval(".pane .cm-content", (els) => els.map((e) => e.innerText).join("\n---\n"));
    await waitFor(async () => (await allText()).includes("OTHER MACHINE VERSION"), "copy opened beside the original");
    await shot("4-merge-conflict");
  });

  await step("search finds notes with highlighted snippets", async () => {
    await page.click(".search-input");
    await page.type(".search-input", "came from");
    await page.waitForSelector(".note-sub mark");
    assert.match(await page.$eval(".note-item", (e) => e.textContent), /Welcome/);
    await shot("5-search");
    await page.keyboard.press("Escape");
  });

  await step("layout presets and restore after reload", async () => {
    await page.click('.layout-btn[aria-label="Four panes"]');
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 4);
    await shot("6-four-panes");
    await page.click('.layout-btn[aria-label="Three panes"]');
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 3);
    await sleep(700);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 3);
    assert.equal(await page.$eval(".pane-grid", (e) => e.dataset.layout), "3");
    // Close panes: 3 -> 2 -> 1.
    await page.click(".pane:nth-child(3) .pane-head .icon-btn:last-child");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2);
    await page.click(".pane:nth-child(2) .pane-head .icon-btn:last-child");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 1 && document.querySelector(".pane-grid").dataset.layout === "1");
  });

  await step("delete moves the note to the Trash; Undo brings it back", async () => {
    await page.$$eval(".toast", (els) => els.forEach((e) => e.remove()));
    const before = files();
    const victim = await page.$eval(".pane.active .pane-title", (e) => e.title);
    await page.click(".pane.active .pane-delete");
    await waitFor(() => files().length === before.length - 1, "file moved");
    assert.ok(fs.existsSync(path.join(desk, ".trash", victim)), "in .trash");
    await sleep(400);
    const toasts = await page.$$eval(".toast-msg", (els) => els.map((e) => e.textContent));
    assert.ok(toasts.some((t) => t.includes("to the Trash")), "toast: " + toasts);
    assert.ok(!toasts.some((t) => t.includes("another device")), "own delete not reported as remote: " + toasts);
    await page.click(".toast-action");
    await waitFor(() => files().includes(victim), "restored by Undo");
    assert.equal(fs.existsSync(path.join(desk, ".trash", victim)), false);
    await waitFor(async () => (await page.$eval(".pane.active .pane-title", (e) => e.title)) === victim, "reopened");
    // Delete it again and leave it in the Trash for the next steps.
    await page.click(".pane.active .pane-delete");
    await waitFor(() => !files().includes(victim), "moved again");
  });

  await step("narrow (phone) layout", async () => {
    await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2 });
    await sleep(400);
    // Nothing is open, so the phone layout starts on the list.
    assert.equal(await page.$eval(".app", (e) => e.classList.contains("sidebar-collapsed")), false);
    await shot("7-phone-list");
    await page.click(".note-item");
    await page.waitForSelector(".app.sidebar-collapsed");
    await page.waitForSelector(".pane.active .cm-content");
    await sleep(300);
    await shot("8-phone-editor");
  });

  await step("dark mode renders", async () => {
    await page.setViewport({ width: 1280, height: 800 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await sleep(400);
    await shot("9-dark");
  });

  assert.deepEqual(errors, [], "browser console errors");
  console.log(`\nAll UI checks passed. Screenshots in ${SHOTS}`);
} catch (err) {
  console.log("FAILED");
  console.error(err);
  console.error("browser errors:", errors);
  console.error("server log:\n" + serverLog);
  if (page) await shot("failure").catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
}
