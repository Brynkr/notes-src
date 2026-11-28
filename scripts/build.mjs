// Bundles the server into dist/server.js and the web UI into dist/web/.
// The server has no runtime npm dependencies: dist/ is all you deploy.
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist/web", { recursive: true });
fs.cpSync("web/static", "dist/web", { recursive: true });

const server = {
  entryPoints: ["server/main.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
};
// The web UI is split: app.js holds notes mode; IDE mode and the code
// languages load on demand from dist/web/chunks/ (smaller, faster start).
const web = {
  entryPoints: { app: "web/main.ts" },
  outdir: "dist/web",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  metafile: true,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["chrome110", "firefox115", "safari16"],
  minify: !watch,
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  await (await esbuild.context(server)).watch();
  await (await esbuild.context(web)).watch();
} else {
  await esbuild.build(server);
  const result = await esbuild.build(web);
  writeServiceWorker(result.metafile);
}

/** Put the build's file list and a per-build cache name into the service worker. */
function writeServiceWorker(metafile) {
  const files = Object.keys(metafile.outputs)
    .filter((f) => f.endsWith(".js") && f.includes("/chunks/"))
    .map((f) => "/" + path.relative("dist/web", f).split(path.sep).join("/"));
  const hash = createHash("sha256").update(fs.readFileSync("dist/web/app.js")).update(files.join()).update(fs.readFileSync("dist/web/style.css")).digest("hex").slice(0, 10);
  const sw = path.join("dist/web", "sw.js");
  const text = fs.readFileSync(sw, "utf8").replace("__BUILD__", hash).replace("/* __CHUNKS__ */", files.map((f) => `, "${f}"`).join(""));
  fs.writeFileSync(sw, text);
  const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0);
  console.log(`  app.js ${kb("dist/web/app.js")} KB at start; ${files.length} on-demand chunks (${files.map((f) => kb("dist/web" + f)).reduce((a, b) => a + Number(b), 0)} KB)`);
}
