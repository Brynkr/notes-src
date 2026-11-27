// End-to-end checks for first-run setup, quick switcher, wiki links and
// settings, in headless Chrome against throwaway repos. Run: npm run test:ui

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
const PORT = 4797;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-ui2-"));
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
git(root, "init", "-q", "--bare", "-b", "main", remote);
const notesDir = path.join(root, "MyNotes");
fs.mkdirSync(SHOTS, { recursive: true });

// No --repo: the server starts unconfigured, as after a fresh install.
const server = spawn(process.execPath, ["dist/server.js", "--port", String(PORT), "--sync-idle", "60", "--sync-interval", "0"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
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
const waitFor = async (fn, what, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const files = () => (fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter((f) => f.endsWith(".md")).sort() : []);
const read = (f) => fs.readFileSync(path.join(notesDir, f), "utf8");
const combo = async (mods, key) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
};
const activeText = () => page.$eval(".pane.active .cm-content", (e) => e.innerText);
const activeTitle = () => page.$eval(".pane.active .pane-title", (e) => e.textContent);

try {
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820 });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url()}`));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

  await step("first run shows the setup screen", async () => {
    await page.waitForSelector(".setup-card");
    await shot("10-setup");
  });

  await step("setup refuses a folder full of other files", async () => {
    const docs = path.join(root, "Documents");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, "budget.xlsx"), "x");
    await page.$eval('input[aria-label="Notes folder"]', (e) => (e.value = ""));
    await page.type('input[aria-label="Notes folder"]', docs);
    await page.click(".setup-card .btn-primary");
    await waitFor(async () => (await page.$eval(".setup-result", (e) => e.textContent)).includes("other files"), "refusal");
    assert.equal(fs.existsSync(path.join(docs, ".git")), false);
  });

  await step("Test connection checks the repository", async () => {
    await page.type('input[aria-label="Repository URL"]', remote);
    await page.click(".setup-card .inline .btn");
    await waitFor(async () => (await page.$eval(".setup-card .test-result", (e) => e.textContent)).includes("empty"), "test result");
  });

  await step("setup with an empty GitHub-style repo opens the app", async () => {
    await page.$eval('input[aria-label="Notes folder"]', (e) => (e.value = ""));
    await page.type('input[aria-label="Notes folder"]', notesDir);
    await page.$eval('input[aria-label="Machine name"]', (e) => (e.value = ""));
    await page.type('input[aria-label="Machine name"]', "desk");
    await page.click(".setup-card .btn-primary");
    await page.waitForSelector(".app .sidebar", { timeout: 15000 });
    assert.equal(git(notesDir, "config", "--get", "remote.origin.url").trim(), remote);
    const cfg = JSON.parse(fs.readFileSync(path.join(env.NOTES_APP_CONFIG_DIR, "config.json"), "utf8"));
    assert.equal(cfg.repoPath, notesDir);
    assert.equal(cfg.machineName, "desk");
  });

  await step("quick switcher creates and finds notes", async () => {
    await combo(["Control"], "KeyP");
    await page.waitForSelector(".switcher-backdrop:not([hidden]) .switcher-input");
    await page.type(".switcher-input", "Garden plans");
    await page.waitForSelector(".switcher-row.create");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeTitle()) === "Garden plans", "created note");
    await page.keyboard.type("Tomatoes and basil. See also [[Shop");
    // Completion offers nothing yet (no "Shopping" note); create it via the switcher.
    await page.keyboard.press("Escape");
    await page.keyboard.type("ping list]].");
    await sleep(900);
    await combo(["Control"], "KeyP");
    await page.type(".switcher-input", "Weekly review");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeTitle()) === "Weekly review", "second note");
    await combo(["Control"], "KeyP");
    await page.type(".switcher-input", "gdpl");
    await page.waitForSelector(".switcher-row.cursor b");
    assert.match(await page.$eval(".switcher-row.cursor .switcher-title", (e) => e.textContent), /Garden plans/);
    await shot("11-switcher");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeTitle()) === "Garden plans", "switch back");
  });

  await step("a missing wiki link is dashed; Ctrl+click creates and opens it", async () => {
    await page.waitForSelector(".cm-wikilink-missing");
    await page.keyboard.down("Control");
    await page.click(".cm-wikilink-missing");
    await page.keyboard.up("Control");
    await waitFor(async () => (await activeTitle()) === "Shopping list", "followed link");
    await waitFor(() => files().some((f) => f.endsWith("-shopping-list.md")), "file created");
  });

  await step("backlinks list the linking note and open it", async () => {
    await page.waitForSelector(".pane.active .backlinks:not([hidden]) .backlink");
    assert.match(await page.$eval(".pane.active .backlink-context", (e) => e.textContent), /See also \[\[Shopping list\]\]/);
    await shot("12-backlinks");
    await page.click(".pane.active .backlink");
    await waitFor(async () => (await activeTitle()) === "Garden plans", "back to source");
    await page.waitForSelector(".cm-wikilink:not(.cm-wikilink-missing)");
  });

  await step("[[ completion inserts a link to an existing note", async () => {
    await page.click(".pane.active .cm-content");
    await combo(["Control"], "End");
    await page.keyboard.type("\nAlso [[week");
    await page.waitForSelector(".cm-tooltip-autocomplete li");
    await shot("13-autocomplete");
    await sleep(300); // CodeMirror ignores Enter for a moment after the list changes
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeText()).includes("[[Weekly review]]"), "completion applied");
    await page.keyboard.type(" done");
    await waitFor(() => files().some((f) => f.endsWith("garden-plans.md") && read(f).includes("[[Weekly review]] done")), "saved");
  });

  await step("Alt+Enter follows the link under the cursor", async () => {
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await combo(["Alt"], "Enter");
    await waitFor(async () => (await activeTitle()) === "Weekly review", "followed with keyboard");
  });

  await step("settings: change machine name and sync interval, applied live", async () => {
    await combo(["Control"], "Comma");
    await page.waitForSelector(".dialog-backdrop:not([hidden]) .dialog-body input");
    await shot("14-settings");
    const machine = await page.$$eval(".dialog-body .field", (els) => els.findIndex((e) => e.textContent.startsWith("Name")));
    assert.ok(machine >= 0);
    const inputs = await page.$$(".dialog-body .field");
    const nameInput = await inputs[machine].$("input");
    await nameInput.evaluate((e) => (e.value = ""));
    await nameInput.type("study-pc");
    await page.click(".dialog-foot .btn-primary");
    // Settings that change the runtime reload the page.
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => undefined);
    await page.waitForSelector(".machine");
    await waitFor(async () => (await page.$eval(".machine", (e) => e.textContent)) === "study-pc", "new machine name");
    const cfg = JSON.parse(fs.readFileSync(path.join(env.NOTES_APP_CONFIG_DIR, "config.json"), "utf8"));
    assert.equal(cfg.machineName, "study-pc");
  });

  await step("settings: invalid input is explained, not saved", async () => {
    await combo(["Control"], "Comma");
    await page.waitForSelector(".dialog-backdrop:not([hidden]) .dialog-body input");
    const idx = await page.$$eval(".dialog-body .field", (els) => els.findIndex((e) => e.textContent.startsWith("Repository URL")));
    const field = (await page.$$(".dialog-body .field"))[idx];
    const urlInput = await field.$("input");
    await urlInput.evaluate((e) => (e.value = ""));
    await urlInput.type("ext::sh -c reboot");
    await page.click(".dialog-foot .btn-primary");
    await waitFor(async () => (await page.$eval(".dialog-status", (e) => e.className)).includes("bad"), "error shown");
    assert.equal(git(notesDir, "config", "--get", "remote.origin.url").trim(), remote);
    await page.keyboard.press("Escape");
  });

  await step("sync pushes everything to the remote, under the new machine name", async () => {
    // Switching settings synced pending edits under the old name; make a new one.
    await page.click(".pane.active .cm-content");
    await combo(["Control"], "End");
    await page.keyboard.type("\nEdited after renaming the machine.");
    await waitFor(() => files().some((f) => read(f).includes("after renaming")), "saved");
    await page.click(".sync .icon-btn");
    await waitFor(() => /study-pc/.test(git(remote, "log", "-1", "--format=%s", "main")), "pushed under new name");
    assert.match(git(remote, "ls-tree", "--name-only", "main"), /garden-plans/);
  });

  // The setup refusal above is an expected 400.
  const unexpected = errors.filter((e) => !/400 (POST|PUT) .*\/api\/(setup|settings)|status of 400/.test(e));
  assert.deepEqual(unexpected, [], "browser console errors");
  console.log(`\nAll feature checks passed. Screenshots in ${SHOTS}`);
} catch (err) {
  console.log("FAILED");
  console.error(err);
  console.error("browser errors:", errors);
  console.error("server log:\n" + serverLog);
  if (page) await shot("failure-features").catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
}
