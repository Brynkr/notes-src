// Bundles the server into dist/server.js and the web UI into dist/web/.
// The server has no runtime npm dependencies: dist/ is all you deploy.
import * as esbuild from "esbuild";
import fs from "node:fs";

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
const web = {
  entryPoints: ["web/main.ts"],
  outfile: "dist/web/app.js",
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
  await esbuild.build(web);
}
