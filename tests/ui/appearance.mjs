// Appearance panel, themes, fonts, layout options and text zoom, in headless
// Chrome. Also writes one screenshot per theme (tests/ui/screenshots/themes/).
// Run: npm run test:ui

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { CHROME } from "./chrome.mjs";

const SHOTS = process.env.SHOTS ?? path.resolve("tests/ui/screenshots");
const PORT = 4795;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-look-"));
const env = { ...process.env, NOTES_APP_CONFIG_DIR: path.join(root, "c"), NOTES_APP_DATA_DIR: path.join(root, "d") };
const repo = path.join(root, "notes");
fs.mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
fs.writeFileSync(
  path.join(repo, "20261127-091500-weekend-plan.md"),
  "# Weekend plan\n\n## Saturday\n\n- [x] Farmers market, early\n- [ ] Fix the **bike chain**\n- [ ] Call Mum\n\nWalk the *Tāwharanui* loop, then the [[Pi setup]] to-dos.\n\n> Low tide is around 2 pm.\n\n`tide --today`\n",
);
fs.writeFileSync(path.join(repo, "20261126-203000-pi-setup.md"), "# Pi setup\n\nNotes server runs as a user service.\n");
fs.mkdirSync(path.join(SHOTS, "themes"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["dist/server.js", "--repo", repo, "--port", String(PORT), "--no-sync"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
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
const css = (sel, prop) => page.$eval(sel, (e, p) => getComputedStyle(e).getPropertyValue(p), prop);
const rootVar = (v) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), v);
const openPanel = async () => {
  if (!(await page.$(".appearance-panel:not([hidden])"))) await page.click(".appearance-btn");
  await page.waitForSelector(".appearance-panel:not([hidden])");
};

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".pane .cm-content");

  await step("top bar has go-to, zoom and the Appearance button", async () => {
    assert.ok(await page.$(".topbar .goto"));
    assert.equal(await page.$eval(".zoom-value", (e) => e.textContent), "100%");
    await openPanel();
    const sections = await page.$$eval(".ap-section h3", (els) => els.map((e) => e.textContent));
    assert.deepEqual(sections, ["Theme", "Font", "Text", "Layout", "Editor"], "themes first, fonts next");
    assert.equal((await page.$$(".ap-theme")).length, 32);
    await page.screenshot({ path: path.join(SHOTS, "20-appearance-panel.png") });
  });

  await step("every theme applies its colours (one screenshot each)", async () => {
    const ids = await page.$$eval(".ap-theme", (els) => els.map((e) => e.dataset.themeId));
    for (const id of ids) {
      await openPanel();
      await page.click(`.ap-theme[data-theme-id="${id}"]`);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), id);
      await page.click(".appearance-btn"); // close
      await page.waitForSelector(".appearance-panel[hidden]");
      await sleep(80);
      await page.screenshot({ path: path.join(SHOTS, "themes", `${id}.png`) });
    }
  });

  await step("the choice is remembered after a reload", async () => {
    await openPanel();
    await page.click('.ap-theme[data-theme-id="midnight"]');
    const bg = await rootVar("--bg");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane .cm-content");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "midnight");
    assert.equal(await rootVar("--bg"), bg);
  });

  await step("text zoom: buttons, shortcuts, reset", async () => {
    const before = parseFloat(await css(".pane-body", "font-size"));
    await page.click('.zoom [aria-label="Larger text"]');
    await page.click('.zoom [aria-label="Larger text"]');
    assert.equal(await page.$eval(".zoom-value", (e) => e.textContent), "120%");
    assert.ok(Math.abs(parseFloat(await css(".pane-body", "font-size")) - before * 1.2) < 0.2);
    await page.click(".pane .cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("Minus");
    await page.keyboard.up("Control");
    assert.equal(await page.$eval(".zoom-value", (e) => e.textContent), "110%");
    await page.click(".zoom-value");
    assert.equal(await page.$eval(".zoom-value", (e) => e.textContent), "100%");
  });

  await step("fonts, spacing, width", async () => {
    await openPanel();
    await page.$$eval(".ap-font", (els) => els.find((e) => e.textContent.includes("Typewriter")).click());
    assert.match(await css(".cm-scroller", "font-family"), /monospace/);
    await page.$$eval(".segmented button", (els) => els.find((e) => e.textContent === "Airy").click());
    assert.equal(await rootVar("--editor-lh"), "1.9");
    await page.$$eval(".segmented button", (els) => els.find((e) => e.textContent === "Wide").click());
    assert.equal(await rootVar("--editor-width"), "96ch");
  });

  await step("borders, corners, spacing and editor options", async () => {
    for (const label of ["Cards", "Round", "Spacious"]) {
      await page.$$eval(".segmented button", (els, l) => els.find((e) => e.textContent === l).click(), label);
    }
    const attrs = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    assert.equal(attrs.borders, "cards");
    assert.equal(attrs.density, "spacious");
    assert.equal(await rootVar("--r-lg"), "22px");
    assert.equal(await page.$(".cm-lineNumbers"), null);
    await page.$$eval(".ap-toggle", (els) => els.find((e) => e.textContent.includes("Line numbers")).click());
    await page.waitForSelector(".cm-lineNumbers");
    await page.$$eval(".ap-toggle", (els) => els.find((e) => e.textContent.includes("Spell check")).click());
    assert.equal(await page.$eval(".cm-content", (e) => e.getAttribute("spellcheck")), "false");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".appearance-panel[hidden]");
    await page.screenshot({ path: path.join(SHOTS, "21-cards-round-mono.png") });
  });

  await step("colour-blind colours: blue / vermillion / purple instead of green / red / amber", async () => {
    await openPanel();
    await page.click('.ap-theme[data-theme-id="paper"]');
    const hue = (name) =>
      page.evaluate((v) => {
        const hex = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        const n = parseInt(hex.slice(1), 16);
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        if (!d) return 0;
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return Math.round((h * 60 + 360) % 360);
      }, name);
    const okBefore = await hue("--ok");
    assert.ok(okBefore > 90 && okBefore < 170, `ok starts green (${okBefore})`);
    await page.$$eval(".ap-toggle", (els) => els.find((e) => e.textContent.includes("Colour-blind")).click());
    assert.equal(await page.evaluate(() => document.documentElement.dataset.colorblind), "on");
    const [ok, bad, warn] = [await hue("--ok"), await hue("--bad"), await hue("--warn")];
    assert.ok(ok > 190 && ok < 220, `ok is blue (${ok})`);
    assert.ok(bad > 10 && bad < 35, `bad is vermillion (${bad})`);
    assert.ok(warn > 300 && warn < 340, `warn is purple (${warn})`);
    // Survives a theme change and a reload.
    await page.click('.ap-theme[data-theme-id="aurora"]');
    assert.ok((await hue("--ok")) > 190, "still blue on a dark theme");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane .cm-content");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.colorblind), "on");
    await openPanel();
    await page.screenshot({ path: path.join(SHOTS, "31-colorblind-panel.png") });
    await page.$$eval(".ap-toggle", (els) => els.find((e) => e.textContent.includes("Colour-blind")).click());
    assert.equal(await page.evaluate(() => document.documentElement.dataset.colorblind), "off");
    await page.click('.ap-theme[data-theme-id="paper"]');
    await page.keyboard.press("Escape");
  });

  await step("cursor: blinking can be turned off, and the shape changed", async () => {
    await page.click(".pane .cm-content");
    await page.waitForSelector(".cm-cursor");
    const layerAnim = () => css(".cm-cursorLayer", "animation-name");
    const cursorBox = () => page.$eval(".cm-cursor", (e) => ({ w: e.getBoundingClientRect().width, left: getComputedStyle(e).borderLeftWidth, bottom: getComputedStyle(e).borderBottomWidth }));
    assert.notEqual(await layerAnim(), "none", "blinks by default");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cursor), "line");
    await openPanel();
    await page.$$eval(".ap-toggle", (els) => els.find((e) => e.textContent.includes("Blinking cursor")).click());
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cursorBlink), "off");
    assert.equal(await layerAnim(), "none", "no blinking");
    for (const [label, ok] of [
      ["Block", (b) => b.w > 5 && b.left === "0px"],
      ["Underline", (b) => b.w > 5 && b.bottom === "2px"],
      ["Bold line", (b) => b.left === "3px"],
      ["Line", (b) => b.left === "2px"],
    ]) {
      await page.$$eval(".segmented button", (els, l) => els.find((e) => e.textContent === l).click(), label);
      await page.click(".pane .cm-content"); // closes the panel; the cursor is redrawn
      await page.waitForSelector(".cm-cursor");
      const box = await cursorBox();
      assert.ok(ok(box), `${label}: ${JSON.stringify(box)}`);
      if (label === "Block") await page.screenshot({ path: path.join(SHOTS, "27-block-cursor.png") });
      await openPanel();
    }
    // Remembered across a reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane .cm-content");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cursorBlink), "off");
    await openPanel();
    await page.$$eval(".ap-toggle", (els) => els.find((e) => e.textContent.includes("Blinking cursor")).click());
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cursorBlink), "on");
    await page.keyboard.press("Escape");
  });

  await step("clicking outside closes the panel; Reset restores defaults", async () => {
    await openPanel();
    await page.mouse.click(400, 400);
    await page.waitForSelector(".appearance-panel[hidden]");
    await openPanel();
    await page.$$eval(".ap-foot .btn", (els) => els[0].click());
    const attrs = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    assert.equal(attrs.borders, "subtle");
    assert.equal(await page.$(".cm-lineNumbers"), null);
  });

  await step("phone layout: panel fits the screen", async () => {
    await page.setViewport({ width: 390, height: 780, deviceScaleFactor: 2 });
    await sleep(200);
    await openPanel();
    const box = await page.$eval(".appearance-panel", (e) => e.getBoundingClientRect().toJSON());
    assert.ok(box.left >= 0 && box.right <= 390, JSON.stringify(box));
    await page.screenshot({ path: path.join(SHOTS, "22-appearance-phone.png") });
  });

  assert.deepEqual(errors, [], "page errors");
  console.log("\nAll appearance checks passed.");
} catch (err) {
  console.log("FAILED");
  console.error(err);
  await page.screenshot({ path: path.join(SHOTS, "failure-appearance.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows: the browser may still hold files for a moment
}
