// Regenerates docs/screenshot.png from a few sample notes (dev tool).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-shot-"));
const repo = path.join(root, "notes");
fs.mkdirSync(repo);
const write = (name, text, minutesAgo) => {
  const p = path.join(repo, name);
  fs.writeFileSync(p, text);
  const t = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(p, t, t);
};
write("20261127-091500-weekend-plan.md", "# Weekend plan\n\n## Saturday\n\n- [x] Farmers market, early\n- [ ] Fix the **bike chain**\n- [ ] Call Mum\n\n## Sunday\n\nWalk the *Tāwharanui* loop if the weather holds. Pack:\n\n- water, snacks\n- rain jacket\n\n> Low tide is around 2 pm.\n", 3);
write("20261126-203000-pi-setup.md", "# Raspberry Pi setup\n\nNotes server runs as a user service:\n\n```sh\nsystemctl --user status notes-app\n```\n\nOpen `http://raspberrypi.local:4747` on the phone.\n\n## To do\n\n1. Tailscale for access away from home\n2. Back up the SD card\n", 60 * 5);
write("20261125-221000-reading-list.md", "---\ntags: [books]\n---\n# Reading list\n\n- *The Overstory*, Richard Powers\n- *A Philosophy of Software Design*\n- *Piranesi*\n", 60 * 26);
write("20261120-080000-kindlehub-ideas.md", "# KindleHub ideas\n\nSync notes over wifi when a note is opened.\nUse the API in docs/API.md.\n", 60 * 24 * 7);
write("20261118-120000-recipes.md", "# Recipes to try\n\nKūmara and miso soup. Lemon and ginger slice.\n", 60 * 24 * 9);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });

const env = { ...process.env, NOTES_APP_CONFIG_DIR: path.join(root, "c"), NOTES_APP_DATA_DIR: path.join(root, "d") };
const server = spawn(process.execPath, ["dist/server.js", "--repo", repo, "--port", "4798", "--machine-name", "desktop", "--no-sync"], { env, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 820, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem("notes-app:workspace:v1", JSON.stringify({
        layout: "2v",
        panes: [
          { id: "a", notePath: "20261127-091500-weekend-plan.md", cursor: { anchor: 0, head: 0 }, scrollTop: 0 },
          { id: "b", notePath: "20261126-203000-pi-setup.md", cursor: { anchor: 0, head: 0 }, scrollTop: 0 },
        ],
        activePaneId: "a", sidebarWidth: 270, sidebarCollapsed: false,
      }));
    });
    await page.goto("http://localhost:4798/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane .cm-content");
    await new Promise((r) => setTimeout(r, 800));
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: scheme === "light" ? "docs/screenshot.png" : "docs/screenshot-dark.png" });
  }
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
