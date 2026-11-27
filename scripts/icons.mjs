// Renders installer icons from web/static/icon.svg (dev tool; needs Chrome + Python Pillow for the .ico).
import puppeteer from "puppeteer-core";
import { CHROME } from "../tests/ui/chrome.mjs";
import fs from "node:fs";
const svg = fs.readFileSync("web/static/icon.svg", "utf8");
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const p = await b.newPage();
for (const size of [512, 256]) {
  await p.setViewport({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg style="display:block" width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: `installer/assets/icon-${size}.png`, omitBackground: true });
}
await b.close();
import { execFileSync } from "node:child_process";
execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open('installer/assets/icon-512.png').convert('RGBA')
im.save('installer/assets/icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
`], { stdio: "inherit" });
