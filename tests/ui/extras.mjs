// 28 Nov additions, in headless Chrome: IDE code loading on demand, the IDE
// minimap, Ctrl+N, the top-left sidebar toggle, multiple cursors, the "AI
// look" appearance switches, Jama links, and images in notes.
// Run: npm run test:ui

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { CHROME } from "./chrome.mjs";

const SHOTS = process.env.SHOTS ?? path.resolve("tests/ui/screenshots");
const PORT = 4793;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-extras-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  NOTES_APP_CONFIG_DIR: path.join(root, "c"),
  NOTES_APP_DATA_DIR: path.join(root, "d"),
};
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n");
const repo = path.join(root, "notes");
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
put("Home/20261128-100000-tasks.md", "# Tasks\n\nalpha\nbeta\ngamma\n\nTrace PROJ-REQ-123 and GID-4567 here.\n");
put("Work/tool.py", "def main():\n    return 1\n");
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["dist/server.js", "--repo", repo, "--port", String(PORT), "--no-sync"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 100 && !log.includes("open:"); i++) await sleep(100);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
const requests = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
page.on("request", (r) => requests.push(new URL(r.url()).pathname));
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  await fn();
  console.log("ok");
};
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const waitFor = async (fn, what, ms = 20_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const combo = async (mods, key) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
};
const rootVar = (v) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), v);
const read = (rel) => fs.readFileSync(path.join(repo, ...rel.split("/")), "utf8");
const TASKS = "Home/20261128-100000-tasks.md";
const openTasks = async () => {
  await page.waitForSelector(`.note-item[data-path="${TASKS}"]`);
  await page.click(`.note-item[data-path="${TASKS}"]`);
  await waitFor(async () => (await page.$eval(".pane.active .pane-title", (e) => e.textContent)) === "Tasks", "Tasks open");
};

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app .sidebar");

  await step("notes mode doesn't download IDE mode or the code languages", async () => {
    await openTasks();
    await sleep(500);
    assert.ok(requests.includes("/app.js"));
    assert.equal(requests.filter((p) => /\/chunks\/(ide|languages|minimap)-/.test(p)).length, 0, requests.join(" "));
    assert.equal(await page.$(".minimap-btn:not([hidden])") && (await page.$eval(".minimap-btn", (e) => getComputedStyle(e).display)), "none", "minimap button hidden outside IDE mode");
  });

  await step("IDE mode loads its code on demand; the minimap shows and can be turned off", async () => {
    await page.click(".ide-btn");
    await page.waitForSelector(".explorer .tree-row");
    assert.ok(requests.some((p) => /\/chunks\/ide-/.test(p)), "IDE chunk loaded");
    await page.click('.mode-switch [data-mode="work"]');
    await page.waitForSelector('.tree-file[data-path="Work/tool.py"]');
    await page.click('.tree-file[data-path="Work/tool.py"]');
    await waitFor(() => requests.some((p) => /\/chunks\/languages-/.test(p)), "languages chunk loaded for a code file");
    await page.waitForSelector(".pane.active .cm-minimap-gutter");
    await shot("32-ide-minimap");
    await page.click(".minimap-btn");
    await waitFor(async () => !(await page.$(".pane.active .cm-minimap-gutter")), "minimap off");
    await page.click(".minimap-btn");
    await page.waitForSelector(".pane.active .cm-minimap-gutter");
    await page.click(".ide-btn"); // back to notes mode: no minimap there
    await waitFor(async () => !(await page.$(".cm-minimap-gutter")), "no minimap in notes mode");
    await page.click('.mode-switch [data-mode="home"]');
  });

  await step("the note list's show/hide button is at the top left", async () => {
    const box = await page.$eval(".sidebar-hide", (e) => e.getBoundingClientRect().toJSON());
    assert.ok(box.left < 40 && box.top < 40, `hide button at ${box.left},${box.top}`);
    await page.click(".sidebar-hide");
    await page.waitForSelector(".app.sidebar-collapsed");
    const show = await page.waitForSelector(".topbar .sidebar-toggle", { visible: true });
    const b2 = await show.evaluate((e) => e.getBoundingClientRect().toJSON());
    assert.ok(b2.left < 40 && b2.top < 40, `show button at ${b2.left},${b2.top}`);
    await show.click();
    await waitFor(async () => !(await page.$(".app.sidebar-collapsed")), "list shown again");
    assert.equal(await page.$eval(".topbar .sidebar-toggle", (e) => getComputedStyle(e).display), "none");
  });

  await step("Ctrl+N starts a new note", async () => {
    await page.click(".pane.active .cm-content");
    await combo(["Control"], "KeyN");
    await page.waitForSelector(".new-input", { visible: true });
    await page.keyboard.press("Escape");
  });

  await step("Ctrl+Alt+Down adds cursors on the lines below; typing edits all of them", async () => {
    await openTasks();
    // Put the cursor at the start of the "alpha" line.
    const alpha = await page.evaluateHandle(() => [...document.querySelectorAll(".pane.active .cm-line")].find((l) => l.textContent === "alpha"));
    const ab = await alpha.boundingBox();
    await page.mouse.click(ab.x + 1, ab.y + ab.height / 2);
    await page.keyboard.press("Home");
    await combo(["Control", "Alt"], "ArrowDown");
    await combo(["Control", "Alt"], "ArrowDown");
    // Cursors are drawn on the next frame.
    await waitFor(async () => (await page.$$eval(".pane.active .cm-cursor", (els) => els.length)) === 3, "three cursors", 5000);
    await page.keyboard.type("- ");
    await waitFor(() => read(TASKS).includes("- alpha\n- beta\n- gamma\n"), "all three lines edited and saved");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.$$eval(".pane.active .cm-cursor", (els) => els.length)) === 1, "Esc: one cursor again", 5000);
  });

  await step("appearance: sharp corners, no shadows, plain labels, no tints", async () => {
    await page.click(".appearance-btn");
    await page.waitForSelector(".appearance-panel:not([hidden])");
    const toggle = (label) => page.$$eval(".ap-toggle", (els, l) => els.find((e) => e.textContent.includes(l)).click(), label);
    assert.notEqual(await page.$eval(".appearance-panel", (e) => getComputedStyle(e).boxShadow), "none", "shadow by default");
    await page.$$eval(".segmented button", (els) => els.find((e) => e.textContent === "Sharp").click());
    assert.equal(await rootVar("--r-md"), "0px");
    await toggle("Shadows");
    assert.equal(await page.$eval(".appearance-panel", (e) => getComputedStyle(e).boxShadow), "none");
    await toggle("Capital-letter section labels");
    assert.equal(await page.$eval(".ap-section h3", (e) => getComputedStyle(e).textTransform), "none");
    await toggle("Tinted highlights");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.tints), "off");
    await shot("33-plain-look");
    await page.click(".appearance-panel .ap-foot .btn"); // Reset to defaults
    assert.equal(await page.evaluate(() => document.documentElement.dataset.shadows), "on");
    await page.keyboard.press("Escape");
  });

  await step("Jama: IDs become links once the address is set; Ctrl+click opens Jama's search", async () => {
    await openTasks();
    assert.equal(await page.$(".pane.active .cm-jama"), null, "off until configured");
    const r = await fetch(`http://localhost:${PORT}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Notes-App": "1" },
      body: JSON.stringify({ jamaUrl: "acme.jamacloud.com/" }),
    });
    assert.equal(r.status, 200);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTasks();
    await page.waitForSelector(".pane.active .cm-jama");
    assert.deepEqual(await page.$$eval(".pane.active .cm-jama", (els) => els.map((e) => e.textContent)), ["PROJ-REQ-123", "GID-4567"]);
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (u) => (window.__opened.push(u), null);
    });
    await page.keyboard.down("Control");
    await page.click(".pane.active .cm-jama");
    await page.keyboard.up("Control");
    assert.deepEqual(await page.evaluate(() => window.__opened), ["https://acme.jamacloud.com/perspective.req#/search?term=PROJ-REQ-123"]);
    await shot("34-jama-links");
  });

  await step("images: a pasted screenshot is shrunk, saved beside the notes, embedded and shown", async () => {
    await openTasks();
    await page.click(".pane.active .cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 2400;
      c.height = 1200;
      const g = c.getContext("2d");
      g.fillStyle = "#3a7a6a";
      g.fillRect(0, 0, 2400, 1200);
      g.fillStyle = "#f2d16b";
      g.fillRect(200, 200, 800, 400);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
      document.querySelector(".pane.active .cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const image = await waitFor(() => fs.existsSync(path.join(repo, "Home", "images")) && fs.readdirSync(path.join(repo, "Home", "images")).find((f) => f.endsWith(".webp")), "image saved as WebP");
    await waitFor(() => read(TASKS).includes(`![](images/${image})`), "Markdown inserted and saved");
    const img = await page.waitForSelector(".pane.active .cm-image img");
    await waitFor(() => img.evaluate((e) => e.complete && e.naturalWidth > 0), "image shown");
    assert.equal(await img.evaluate((e) => e.naturalWidth), 1600, "longest side shrunk to 1600 px");
    const kb = fs.statSync(path.join(repo, "Home", "images", image)).size / 1024;
    assert.ok(kb < 300, `small file (${kb.toFixed(0)} KB)`);
    await shot("35-image-in-note");
  });

  assert.deepEqual(errors, [], "page errors");
  console.log("\nAll extra checks passed.");
} catch (err) {
  console.log("FAILED");
  console.error(err);
  console.error(log);
  await page.screenshot({ path: path.join(SHOTS, "failure-extras.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows: the browser may still hold files for a moment
}
