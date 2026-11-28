// Builds release archives: release/notes-app-<version>.zip and .tar.gz.
// Each contains the app (no source maps), the installers and the icons.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });

const name = `notes-app-${version}`;
const out = path.join("release", name);
// Replace only this script's own output, so a Notes.exe built by `npm run exe` survives.
for (const p of [out, `${out}.zip`, `${out}.tar.gz`]) fs.rmSync(p, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "installer"), { recursive: true });

fs.cpSync("dist", path.join(out, "app"), { recursive: true, filter: (src) => !src.endsWith(".map") });
for (const f of ["install.sh", "uninstall.sh", "Install Notes (Windows).cmd"]) fs.copyFileSync(path.join("installer", f), path.join(out, f));
for (const f of ["install.ps1", "uninstall.ps1"]) fs.copyFileSync(path.join("installer", f), path.join(out, "installer", f));
fs.cpSync("installer/assets", path.join(out, "installer", "assets"), { recursive: true });
fs.chmodSync(path.join(out, "install.sh"), 0o755);
fs.chmodSync(path.join(out, "uninstall.sh"), 0o755);
fs.writeFileSync(
  path.join(out, "README-INSTALL.txt"),
  `Notes ${version}

Windows:  double-click "Install Notes (Windows).cmd".
          (If Windows warns about an unknown publisher, choose More info > Run anyway.)
macOS:    open Terminal in this folder and run:  ./install.sh
Linux:    ./install.sh
Raspberry Pi / home server:
          ./install.sh --server               (home network)
          ./install.sh --server --tailscale   (also reachable away from home)

Needs git, and Node.js 22.13+ (the installers offer to install Node if it's missing).
The first time Notes opens, it asks where to keep your notes and for your
GitHub repository URL. Full guide: README.md in the source repository.
`,
);

const cwd = "release";
execFileSync("tar", ["-czf", `${name}.tar.gz`, name], { cwd });
// Windows has no `zip`, but its built-in tar (bsdtar) writes zips when asked (-a picks the format from .zip).
if (process.platform === "win32") execFileSync("tar", ["-a", "-cf", `${name}.zip`, name], { cwd });
else execFileSync("zip", ["-qr", `${name}.zip`, name], { cwd });
for (const f of fs.readdirSync(cwd).filter((f) => !fs.statSync(path.join(cwd, f)).isDirectory())) {
  console.log(`release/${f}  ${(fs.statSync(path.join(cwd, f)).size / 1024).toFixed(0)} KB`);
}
