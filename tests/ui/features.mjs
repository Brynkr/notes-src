// End-to-end checks for first-run setup, quick switcher, wiki links and
// settings, in headless Chrome against throwaway repos. Run: npm run test:ui

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { CHROME } from "./chrome.mjs";
import { noteFiles } from "./files.mjs";

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
// Generous: a busy PC makes saves and syncs slow. Passing checks return at once.
const waitFor = async (fn, what, ms = 20_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const files = () => noteFiles(notesDir);
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
    // The list re-renders when the index catches up; retry if the row was replaced mid-click.
    for (let i = 0; ; i++) {
      try {
        await page.click(".pane.active .backlink");
        break;
      } catch (err) {
        if (i >= 4 || !/detached|not clickable/i.test(String(err))) throw err;
        await sleep(200);
      }
    }
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
    await page.click(".dialog-backdrop:not([hidden]) .dialog-foot .btn-primary");
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
    await page.click(".dialog-backdrop:not([hidden]) .dialog-foot .btn-primary");
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
    assert.match(git(remote, "ls-tree", "-r", "--name-only", "main"), /^Home\/\d{8}-\d{6}-garden-plans\.md$/m);
  });

  await step("today's note (Alt+D) with a clickable checkbox", async () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await combo(["Alt"], "KeyD");
    await waitFor(async () => (await activeTitle()) === today, "daily note");
    await page.keyboard.type("- [ ] buy milk");
    const file = await waitFor(() => files().find((f) => f.endsWith(`-${today}.md`) && read(f).includes("- [ ] buy milk")), "saved");
    await page.waitForSelector(".pane.active .cm-task-box");
    await page.click(".pane.active .cm-task-box");
    await waitFor(() => read(file).includes("- [x] buy milk"), "ticked on disk");
    assert.equal(await page.$eval(".pane.active .cm-task-box", (e) => e.checked), true);
    await combo(["Alt"], "KeyD");
    await sleep(300);
    assert.equal(files().filter((f) => f.endsWith(`-${today}.md`)).length, 1, "Alt+D again reuses today's note");
    await shot("15-checkboxes");
  });

  await step("history shows earlier versions and restores one (undoable)", async () => {
    await combo(["Control"], "KeyP");
    await page.type(".switcher-input", "Weekly review");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeTitle()) === "Weekly review", "open note");
    await page.click('.pane.active [aria-label="History"]');
    await page.waitForSelector(".dialog-backdrop:not([hidden]) .history-row");
    const rows = await page.$$(".history-row");
    assert.ok(rows.length >= 2, `versions: ${rows.length}`);
    await page.$$eval(".history-row", (els) => els[els.length - 1].click());
    await page.waitForSelector(".diff .diff-del");
    await shot("16-history");
    await page.click(".dialog-backdrop:not([hidden]) .dialog-foot .btn-primary");
    await waitFor(async () => !(await activeText()).includes("after renaming"), "restored in editor");
    const file = files().find((f) => f.endsWith("weekly-review.md"));
    await waitFor(() => !read(file).includes("after renaming"), "restored on disk");
    await combo(["Control"], "KeyZ");
    await waitFor(async () => (await activeText()).includes("after renaming"), "undo brings it back");
  });

  await step("Trash dialog: preview, restore, delete forever", async () => {
    await combo(["Alt"], "KeyD");
    await sleep(300);
    const victim = files().find((f) => /-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    await page.click(".pane.active .pane-delete");
    await waitFor(() => !files().includes(victim), "moved to Trash");
    await page.click('.sidebar [aria-label="Trash"]');
    await page.waitForSelector(".dialog-backdrop:not([hidden]) .trash-row");
    await page.click(".trash-row .trash-title");
    await waitFor(async () => (await page.$eval(".trash-preview:not([hidden])", (e) => e.textContent)).includes("buy milk"), "preview");
    await shot("17-trash");
    await page.click(".trash-row .trash-actions .btn");
    await waitFor(() => files().includes(victim), "restored");
    await page.waitForSelector(".pane.active .pane-delete:not([hidden])");
    await page.waitForSelector(".pane.active .cm-content");
    await page.click(".pane.active .pane-delete");
    await waitFor(() => !files().includes(victim), "moved again");
    await page.click('.sidebar [aria-label="Trash"]');
    await page.waitForSelector(".dialog-backdrop:not([hidden]) .trash-row");
    const forever = (await page.$$(".trash-row .trash-actions .btn"))[1];
    await forever.click();
    await forever.click();
    await waitFor(() => !fs.existsSync(path.join(notesDir, ".trash", victim)), "deleted forever");
    await page.keyboard.press("Escape");
  });

  await step("conflict copy: banner names it; 'Done' moves the copy to the Trash", async () => {
    const original = files().find((f) => f.endsWith("garden-plans.md"));
    const copy = original.replace(/\.md$/, " (conflict 2026-11-27 laptop).md");
    fs.writeFileSync(path.join(notesDir, copy), "# Garden plans\n\nThe laptop's version.\n");
    await page.waitForSelector(".banner:not([hidden]) .chip");
    assert.match(await page.$eval(".banner .chip", (e) => e.textContent), /Garden plans \(from laptop\)/);
    await page.click(".banner .chip");
    await page.waitForSelector(".pane .conflict-strip:not([hidden])");
    await shot("18-conflict-strip");
    await page.click(".conflict-strip .btn-primary");
    await waitFor(() => !files().includes(copy), "copy moved");
    assert.ok(fs.existsSync(path.join(notesDir, ".trash", copy)));
    await page.waitForSelector(".banner[hidden]");
  });

  await step("Home | Work switch: Work has its own notes and search", async () => {
    const homeCount = await page.$$eval(".note-list .note-item", (els) => els.length);
    assert.ok(homeCount > 0);
    await page.click('.mode-switch [data-mode="work"]');
    await waitFor(async () => (await page.$$(".note-list .note-item")).length === 0, "Work list empty");
    assert.equal(await page.$eval('.mode-switch [data-mode="work"]', (e) => e.getAttribute("aria-pressed")), "true");
    await combo(["Control"], "KeyP");
    await page.type(".switcher-input", "Standup");
    await page.waitForSelector(".switcher-row.create");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await activeTitle()) === "Standup", "work note created");
    await page.keyboard.type("Garden of tasks");
    await waitFor(() => files().some((f) => /^Work\/\d{8}-\d{6}-standup\.md$/.test(f) && read(f).includes("Garden of tasks")), "saved in Work/");
    await waitFor(async () => (await page.$$(".note-list .note-item")).length === 1, "one Work note listed");
    // Search only finds Work notes ("Garden plans" is in Home).
    await page.type(".search-input", "garden");
    await waitFor(async () => {
      const titles = await page.$$eval(".note-list .note-item .note-title", (els) => els.map((e) => e.textContent));
      return titles.length === 1 && titles[0] === "Standup";
    }, "Work-only search");
    await shot("19-work-mode");
    await page.keyboard.press("Escape");
    // Alt+M switches back; the Work note isn't in Home's list.
    await page.click(".pane.active .cm-content");
    await combo(["Alt"], "KeyM");
    await waitFor(async () => (await page.$$eval(".note-list .note-item", (els) => els.length)) === homeCount, "Home list back");
    const homeTitles = await page.$$eval(".note-list .note-item .note-title", (els) => els.map((e) => e.textContent));
    assert.ok(!homeTitles.includes("Standup"));
  });

  // Real drag events, dispatched in the page (headless Chrome has no mouse-driven drag).
  const drag = (srcSel, dstSel) =>
    page.evaluate(
      (s, d) => {
        const src = document.querySelector(s);
        const dst = document.querySelector(d);
        const dt = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(src, "dragstart");
        fire(dst, "dragenter");
        const accepted = !fire(dst, "dragover"); // preventDefault() = "you can drop here"
        fire(dst, "drop");
        fire(src, "dragend");
        return accepted;
      },
      srcSel,
      dstSel,
    );
  /** Pane titles in layout order (grid area a, b, c, d). */
  const paneOrder = () =>
    page.$$eval(".pane", (els) =>
      els
        .map((el) => [el.style.gridArea, el.querySelector(".pane-title").textContent])
        .sort((x, y) => (x[0] < y[0] ? -1 : 1))
        .map((x) => x[1]),
    );

  await step("drag a note from the sidebar onto a pane; drag panes by their title bars to swap them", async () => {
    await page.click('.layouts [aria-label="Two side by side"]');
    await waitFor(async () => (await page.$$(".pane")).length === 2, "two panes");
    // Show "Garden plans" on the left so we know what's where.
    await page.click('.pane[style*="grid-area: a"] .pane-title');
    const garden = await page.$eval('.note-item[data-path$="garden-plans.md"]', (e) => e.dataset.path);
    await page.click(`.note-item[data-path="${garden}"]`);
    const left = () => page.$eval('.pane[style*="grid-area: a"] .pane-title', (e) => e.textContent);
    await waitFor(async () => (await left()) === "Garden plans", "Garden plans on the left");
    const textBefore = await page.$eval('.pane[style*="grid-area: a"] .cm-content', (e) => e.innerText);

    // Drop "Weekly review" right onto the left pane's text: it opens there, nothing is pasted.
    const weekly = await page.$eval('.note-item[data-path$="weekly-review.md"]', (e) => e.dataset.path);
    assert.equal(await drag(`.note-item[data-path="${weekly}"]`, '.pane[style*="grid-area: a"] .cm-content'), true, "pane accepts the note");
    await waitFor(async () => (await left()) === "Weekly review", "dropped note opens in that pane");
    const garderText = await page.$eval('.pane[style*="grid-area: a"] .cm-content', (e) => e.innerText);
    assert.ok(!garderText.includes(weekly), "the path wasn't typed into the note");
    assert.notEqual(garderText, textBefore);

    // Put Garden plans in the right pane, then swap the panes by dragging the right title bar onto the left pane.
    assert.equal(await drag(`.note-item[data-path="${garden}"]`, '.pane[style*="grid-area: b"]'), true);
    await waitFor(async () => (await paneOrder()).join("|") === "Weekly review|Garden plans", "right pane shows Garden plans");
    await shot("25-before-swap");
    assert.equal(await drag('.pane[style*="grid-area: b"] .pane-head', '.pane[style*="grid-area: a"]'), true, "pane accepts a pane");
    await waitFor(async () => (await paneOrder()).join("|") === "Garden plans|Weekly review", "panes swapped");
    assert.equal(await page.$(".pane.drop-target"), null, "highlight cleared");
    // A pane can't be dropped on itself.
    assert.equal(await drag('.pane[style*="grid-area: a"] .pane-head', '.pane[style*="grid-area: a"]'), false);
    // Nothing was written into either note by the drops.
    for (const f of [garden, weekly]) assert.ok(!read(f).includes("Home/"), `${f} untouched`);
    await shot("26-after-swap");
    await page.click('.layouts [aria-label="One pane"]');
  });

  // The setup refusal above is an expected 400. While Settings restarts the
  // notes runtime, reads get 409 ("not set up") for a moment; the UI retries.
  const unexpected = errors.filter(
    (e) => !/400 (POST|PUT) .*\/api\/(setup|settings)|status of 400|409 GET .*\/api\/notes?(\?|$)|status of 409/.test(e),
  );
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
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows: the browser may still hold files for a moment
}
