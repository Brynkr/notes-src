// Where to find Chrome/Chromium/Edge for the browser tests. CHROME=... wins.
import fs from "node:fs";
import path from "node:path";

const win = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
  .filter(Boolean)
  .flatMap((d) => [path.join(d, "Google/Chrome/Application/chrome.exe"), path.join(d, "Microsoft/Edge/Application/msedge.exe")]);

export const CHROME =
  process.env.CHROME ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ...win,
  ].find((p) => fs.existsSync(p));
