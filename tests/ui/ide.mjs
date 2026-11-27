// IDE mode in headless Chrome: the toggle, file tree, code highlighting, new
// files, the Changes view with diffs, and highlighted code fences in notes.
// Run: npm run test:ui

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { CHROME } from "./chrome.mjs";

const SHOTS = process.env.SHOTS ?? path.resolve("tests/ui/screenshots");
const PORT = 4794;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-ide-"));
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
const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
fs.mkdirSync(repo);
git("init", "-q", "-b", "main");
put("Home/20261128-090000-snippets.md", "# Snippets\n\nA loop:\n\n```python\ndef greet(name):\n    return f\"hi {name}\"\n```\n");
put("Work/20261128-091000-standup.md", "# Standup\n\nShip the sensor script.\n");
put("Work/sensor/read.py", 'import time\n\n\ndef read_sensor(pin: int) -> float:\n    """Read one value."""\n    return 0.0  # TODO\n');
put("Work/sensor/driver.c", "#include <stdio.h>\n\nint main(void) {\n    printf(\"ok\\n\");\n    return 0;\n}\n");
put("Work/sensor/config.json", '{ "pin": 4, "interval": 2.5 }\n');
put("Work/photo.png", "not really a png");
git("add", "-A");
git("commit", "-q", "-m", "auto: 2026-11-28T09:00:00Z laptop");
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["dist/server.js", "--repo", repo, "--port", String(PORT), "--no-sync"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 50 && !log.includes("open:"); i++) await sleep(100);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
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
const activeTitle = () => page.$eval(".pane.active .pane-title", (e) => e.textContent);
const treeNames = () => page.$$eval(".tree .tree-row .tree-name", (els) => els.map((e) => e.textContent));
/** Colour of the first editor token with this exact text, and of plain editor text. */
const tokenColor = (text) =>
  page.evaluate((t) => {
    const content = document.querySelector(".pane.active .cm-content");
    const span = [...content.querySelectorAll("span")].find((s) => s.textContent === t);
    return span ? { token: getComputedStyle(span).color, plain: getComputedStyle(content).color } : null;
  }, text);

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app .sidebar");

  await step("notes mode is unchanged: code files aren't in the note list", async () => {
    assert.equal(await page.$eval(".ide-btn", (e) => e.getAttribute("aria-pressed")), "false");
    await page.click('.mode-switch [data-mode="work"]');
    await waitFor(async () => (await page.$$eval(".note-list .note-title", (els) => els.map((e) => e.textContent))).join() === "Standup", "Work notes only");
    assert.equal(await page.$(".explorer:not([hidden])"), null);
  });

  await step("IDE toggle shows the file tree of the current mode", async () => {
    await page.click(".ide-btn");
    await page.waitForSelector(".explorer:not([hidden]) .tree-row");
    assert.equal(await page.$eval(".ide-btn", (e) => e.getAttribute("aria-pressed")), "true");
    assert.deepEqual(await treeNames(), ["sensor", "20261128-091000-standup.md"]);
    await page.click(".tree-dir");
    await waitFor(async () => (await treeNames()).length === 5, "folder opened");
    assert.deepEqual(await treeNames(), ["sensor", "config.json", "driver.c", "read.py", "20261128-091000-standup.md"], "photo.png isn't listed");
  });

  await step("a Python file opens with highlighting, line numbers and its language", async () => {
    await page.click('.tree-file[data-path="Work/sensor/read.py"]');
    await waitFor(async () => (await activeTitle()) === "read.py", "read.py open");
    assert.equal(await page.$eval(".pane.active .pane-lang", (e) => e.textContent), "Python");
    assert.ok(await page.$(".pane.active .cm-lineNumbers"), "line numbers");
    const c = await waitFor(() => tokenColor("def"), "def token");
    assert.notEqual(c.token, c.plain, "keyword coloured");
    assert.equal(await page.$eval(".pane.active .cm-content", (e) => e.getAttribute("spellcheck")), "false");
    assert.equal(await page.$eval(".tree-file.active", (e) => e.dataset.path), "Work/sensor/read.py");
    await shot("20-ide-python");
  });

  await step("editing saves to disk; Changes lists it and shows a diff", async () => {
    await page.click(".pane.active .cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("End");
    await page.keyboard.up("Control");
    await page.keyboard.type("\n\nprint(read_sensor(4))");
    await waitFor(() => fs.readFileSync(path.join(repo, "Work/sensor/read.py"), "utf8").includes("print(read_sensor(4))"), "saved");
    await page.click('.explorer-tabs [data-tab="changes"]');
    await page.waitForSelector('.change-row[data-path="Work/sensor/read.py"]');
    assert.equal(await page.$eval('.change-row[data-path="Work/sensor/read.py"] .change-status', (e) => e.textContent), "M");
    await page.click('.change-row[data-path="Work/sensor/read.py"]');
    await page.waitForSelector(".dialog-backdrop:not([hidden]) .diff-line.diff-add");
    const added = await page.$$eval(".dialog-backdrop:not([hidden]) .diff-line.diff-add", (els) => els.map((e) => e.textContent));
    assert.ok(added.some((l) => l.includes("print(read_sensor(4))")), added.join("|"));
    await shot("21-ide-diff");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".dialog-backdrop:not([hidden])", { hidden: true });
  });

  await step("recent commits list their files; a file opens as a diff", async () => {
    await page.click(".commit-row");
    await page.waitForSelector('.change-row[data-path="Work/sensor/driver.c"]');
    assert.match(await page.$eval(".commit-row .commit-label", (e) => e.textContent), /laptop/);
    await page.click('.change-row[data-path="Work/sensor/driver.c"]');
    await page.waitForSelector(".dialog-backdrop:not([hidden]) .diff-line.diff-add");
    assert.match(await page.$eval(".dialog-backdrop:not([hidden]) .diff-sub", (e) => e.textContent), /^Added/);
    await shot("22-ide-changes");
    await page.click(".dialog-backdrop:not([hidden]) .dialog-foot .btn-primary");
  });

  await step("+ makes a new file in the mode's folder; refused types are explained", async () => {
    await page.click('.explorer-tabs [data-tab="files"]');
    await page.click('.sidebar [aria-label="New note"]');
    await page.waitForSelector(".new-input", { visible: true });
    assert.match(await page.$eval(".new-input", (e) => e.placeholder), /New file/);
    await page.type(".new-input", "sensor/plot.ts");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeTitle()) === "plot.ts", "new file open");
    assert.equal(fs.existsSync(path.join(repo, "Work/sensor/plot.ts")), true);
    assert.equal(await page.$eval(".pane.active .pane-lang", (e) => e.textContent), "TypeScript");
    await page.keyboard.type("const n: number = 1;");
    await waitFor(() => fs.readFileSync(path.join(repo, "Work/sensor/plot.ts"), "utf8") === "const n: number = 1;", "saved");
    await page.click('.sidebar [aria-label="New note"]');
    await page.type(".new-input", "chart.png");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".toast");
    assert.match(await page.$eval(".toast", (e) => e.textContent), /Couldn't create the file: Only notes and text or code files/);
    assert.equal(fs.existsSync(path.join(repo, "Work/chart.png")), false);
  });

  await step("Ctrl+P finds code files in IDE mode", async () => {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyP");
    await page.keyboard.up("Control");
    await page.waitForSelector(".switcher-backdrop:not([hidden]) .switcher-input");
    await page.type(".switcher-input", "driver");
    await page.waitForSelector(".switcher-row.cursor");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeTitle()) === "driver.c", "driver.c via switcher");
    assert.equal(await page.$eval(".pane.active .pane-lang", (e) => e.textContent), "C");
  });

  await step("turning IDE mode off brings the note list back; code fences in notes are highlighted", async () => {
    await page.click(".ide-btn");
    await page.waitForSelector(".explorer[hidden]");
    await page.click('.mode-switch [data-mode="home"]');
    await page.waitForSelector('.note-item[data-path="Home/20261128-090000-snippets.md"]');
    await page.click('.note-item[data-path="Home/20261128-090000-snippets.md"]');
    await waitFor(async () => (await activeTitle()) === "Snippets", "note open");
    assert.equal(await page.$eval(".pane.active .pane-lang", (e) => e.hidden), true);
    const c = await waitFor(() => tokenColor("def"), "def in the code fence");
    assert.notEqual(c.token, c.plain, "fenced Python is coloured");
    await shot("23-note-code-fence");
  });

  assert.deepEqual(errors, [], "page errors");
  console.log("\nAll IDE checks passed.");
} catch (err) {
  console.log("FAILED");
  console.error(err);
  console.error(log);
  await page.screenshot({ path: path.join(SHOTS, "failure-ide.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows: the browser may still hold files for a moment
}
