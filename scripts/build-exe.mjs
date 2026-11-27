// Builds a portable single-file app with Node's single executable
// application (SEA) feature: release/Notes.exe on Windows (release/notes on
// macOS/Linux, mainly for testing). The server and the web UI's files are
// embedded; git still has to be installed on the machine.
//
//   node scripts/build-exe.mjs [--console]
//
// --console keeps a console window on Windows (for debugging); by default the
// exe is a windowed app, so double-clicking it doesn't open a terminal.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { inject } from "postject";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const keepConsole = process.argv.includes("--console");
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const work = "dist-sea";
const out = path.join("release", WIN ? "Notes.exe" : "notes");

execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync("release", { recursive: true });

// 1. The server as one CommonJS file (SEA entry points must be CommonJS on Node 22).
await esbuild.build({
  entryPoints: ["server/main.ts"],
  outfile: path.join(work, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  define: { "import.meta.url": "__notes_import_meta_url" },
  banner: { js: 'const __notes_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});

// 2. The web UI as embedded assets ("web/<path>").
const assets = {};
const walk = (dir, rel = "") => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (!e.name.endsWith(".map")) assets[`web/${r}`] = path.join(dir, e.name);
  }
};
walk(path.join("dist", "web"));
const blob = path.join(work, "sea-prep.blob");
fs.writeFileSync(
  path.join(work, "sea-config.json"),
  JSON.stringify({ main: path.join(work, "server.cjs"), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2),
);
execFileSync(process.execPath, ["--experimental-sea-config", path.join(work, "sea-config.json")], { stdio: "inherit" });

// 3. A copy of this Node binary, with the blob injected.
fs.rmSync(out, { force: true });
fs.copyFileSync(process.execPath, out);
fs.chmodSync(out, 0o755);
if (MAC) execFileSync("codesign", ["--remove-signature", out]);
if (WIN) {
  // Icon and version info, before injection (rcedit rewrites resources).
  const { rcedit } = await import("rcedit");
  await rcedit(out, {
    icon: path.join("installer", "assets", "icon.ico"),
    "file-version": version,
    "product-version": version,
    "version-string": {
      ProductName: "Notes",
      FileDescription: "Notes",
      CompanyName: "notes-app",
      OriginalFilename: "Notes.exe",
      InternalName: "Notes",
      LegalCopyright: "",
    },
  });
}
await inject(out, "NODE_SEA_BLOB", fs.readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(MAC ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (MAC) execFileSync("codesign", ["--sign", "-", out]);
if (WIN && !keepConsole) setWindowsSubsystemGui(out);

console.log(`${out}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB  (Notes ${version}, Node ${process.versions.node})`);

/**
 * Mark a PE file as a windowed (GUI) app instead of a console app, so
 * Windows doesn't open a terminal when it starts. Equivalent to
 * `editbin /subsystem:windows`.
 */
function setWindowsSubsystemGui(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("Not a PE file");
  const optionalHeader = pe + 24;
  const magic = buf.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error("Unknown PE optional header");
  const subsystem = optionalHeader + 68; // same offset for PE32 and PE32+
  const was = buf.readUInt16LE(subsystem);
  if (was !== 3 && was !== 2) throw new Error(`Unexpected subsystem ${was}`);
  buf.writeUInt16LE(2, subsystem); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeFileSync(file, buf);
}
