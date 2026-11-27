// Entry point: CLI, settings, the HTTP server, and the notes runtime it serves.

import "./quiet.ts";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { AppInfo, SettingsDto, SettingsPatch, SettingsResult } from "../shared/types.ts";
import { VERSION } from "../shared/version.ts";
import {
  configFile,
  dataDir,
  defaults,
  hashPassword,
  HELP,
  isLoopback,
  loadConfigFile,
  parseArgs,
  saveConfigFile,
  type Cli,
  type Config,
} from "./config.ts";
import { createApp, type SettingsHandlers } from "./http.ts";
import { NotesRuntime } from "./runtime.ts";
import { isSea, seaAsset } from "./sea.ts";
import {
  defaultRepoPath,
  getRemoteUrl,
  setRemoteUrl,
  SettingsError,
  setupRepo,
  testRemote,
  validateFolder,
  validateHosts,
  validateMachineName,
  validateName,
  validateNotesDir,
  validateRemoteUrl,
  validateSeconds,
} from "./settings.ts";

const SEA = isSea();

/**
 * The portable exe keeps its settings and search index in a "Notes-data"
 * folder next to itself (if it can write there), so it can live on a USB
 * stick. Otherwise it uses the normal per-user folders.
 */
function usePortableDirs(): void {
  const base = path.join(path.dirname(process.execPath), "Notes-data");
  try {
    fs.mkdirSync(base, { recursive: true });
    const probeFile = path.join(base, ".write-test");
    fs.writeFileSync(probeFile, "");
    fs.rmSync(probeFile);
  } catch {
    return; // read-only location (e.g. Program Files)
  }
  process.env.NOTES_APP_CONFIG_DIR ??= path.join(base, "settings");
  process.env.NOTES_APP_DATA_DIR ??= path.join(base, "data");
}

async function main(): Promise<void> {
  if (SEA) usePortableDirs();
  const cli = parseArgs(process.argv.slice(2));
  // Double-clicking the exe: start in the background if needed, open the window.
  if (SEA && cli.defaulted) cli.command = "launch";
  if (cli.command === "help") return void process.stdout.write(HELP);
  if (cli.command === "version") return void console.log(VERSION);

  const fileCfg = loadConfigFile();
  if (cli.command === "set-password") {
    const [pw, again] = await promptHidden(["New password: ", "Repeat password: "]);
    if (pw === undefined || again === undefined) throw new Error("No password entered.");
    if (pw.length < 8) throw new Error("Use at least 8 characters.");
    if (pw !== again) throw new Error("Passwords did not match.");
    saveConfigFile({ ...fileCfg, passwordHash: hashPassword(pw) });
    return void console.log(`Password saved (as a hash) in ${configFile()}`);
  }
  if (cli.command === "clear-password") {
    delete fileCfg.passwordHash;
    saveConfigFile(fileCfg);
    return void console.log("Password removed.");
  }
  if (cli.command === "launch") return launch(cli, fileCfg);
  if (cli.command === "has-password") process.exit(fileCfg.passwordHash ? 0 : 1);
  if (cli.command === "running") process.exit((await probe(cli.overrides.port ?? fileCfg.port ?? defaults().port)) ? 0 : 1);
  if (cli.command === "configure") {
    saveConfigFile({ ...fileCfg, ...cli.overrides });
    return void console.log(`Saved settings to ${configFile()}`);
  }
  if (cli.command === "stop") {
    const port = cli.overrides.port ?? fileCfg.port ?? defaults().port;
    const ok = await requestShutdown(port);
    return void console.log(ok ? "Stopping the notes server (final sync first)…" : "No notes server is running.");
  }
  return serve(cli, fileCfg);
}

// ---------------------------------------------------------------------------

async function serve(cli: Cli, initialFileCfg: Partial<Config>): Promise<void> {
  let fileCfg = initialFileCfg;
  if (cli.save) {
    fileCfg = { ...fileCfg, ...cli.overrides };
    saveConfigFile(fileCfg);
    console.log(`Saved settings to ${configFile()}`);
  }
  let cfg: Config = { ...defaults(), ...fileCfg, ...cli.overrides };
  const exposed = () => !isLoopback(cfg.host) || cfg.allowedHosts.length > 0;
  if (exposed() && !cfg.passwordHash && !cli.allowNoPassword) {
    throw new Error(
      `Other machines can reach this server (${!isLoopback(cfg.host) ? `listening on ${cfg.host}` : `allowed hosts: ${cfg.allowedHosts.join(", ")}`}).\n` +
        `Set a password first:  notes-app set-password\n(or pass --allow-no-password if you really mean it)`,
    );
  }

  let stopping = false;
  let runtime: NotesRuntime | null = null;
  let setupError: string | null = null;
  let switching: Promise<void> = Promise.resolve();

  async function startRuntime(): Promise<void> {
    setupError = null;
    if (!cfg.repoPath) return;
    try {
      runtime = await NotesRuntime.start(cfg);
      runtime.on("event", (ev) => app.broadcast(ev));
      console.log(`  notes:  ${runtime.notesRoot}`);
      console.log(`  sync:   ${cfg.sync ? `${cfg.remote}/${cfg.branch} as "${cfg.machineName}"` : "off"}`);
    } catch (err) {
      runtime = null;
      setupError = `Couldn't open ${cfg.repoPath}: ${(err as Error).message}`;
      console.error(setupError);
    }
  }

  /** Stop the current notes runtime and start one with the new config. */
  function reconfigure(next: Config): Promise<void> {
    switching = switching.then(async () => {
      const old = runtime;
      runtime = null;
      if (old) await old.stop(8_000);
      cfg = next;
      await startRuntime();
      app.broadcast({ type: "reconfigured" });
    });
    return switching;
  }

  function info(): AppInfo {
    return {
      configured: runtime !== null,
      setupError,
      machineName: cfg.machineName,
      repoPath: runtime?.repoRoot ?? cfg.repoPath,
      notesDir: cfg.notesDir,
      remote: cfg.remote,
      branch: cfg.branch,
      version: VERSION,
      defaultRepoPath: defaultRepoPath(),
      platform: process.platform,
      local: !exposed(),
    };
  }

  async function getSettings(): Promise<SettingsDto> {
    return {
      repoPath: runtime?.repoRoot ?? cfg.repoPath,
      notesDir: cfg.notesDir,
      remote: cfg.remote,
      branch: cfg.branch,
      machineName: cfg.machineName,
      sync: cfg.sync,
      syncIdleSeconds: cfg.syncIdleSeconds,
      syncIntervalSeconds: cfg.syncIntervalSeconds,
      remoteUrl: runtime ? await getRemoteUrl(runtime.repoRoot, cfg.remote) : null,
      host: cfg.host,
      port: cfg.port,
      allowedHosts: cfg.allowedHosts,
      hasPassword: Boolean(cfg.passwordHash),
      configFile: configFile(),
      dataDir: dataDir(),
      version: VERSION,
      fromCommandLine: Object.keys(cli.overrides),
      sshPublicKey: readSshPublicKey(),
    };
  }

  const settings: SettingsHandlers = {
    get: getSettings,

    async update(patch: SettingsPatch): Promise<SettingsResult> {
      const next: Config = { ...cfg };
      const saved: Partial<Config> = {};
      const set = <K extends keyof Config>(k: K, v: Config[K]) => {
        next[k] = v;
        saved[k] = v;
      };
      if (patch.repoPath !== undefined) set("repoPath", validateFolder(patch.repoPath));
      if (patch.notesDir !== undefined) set("notesDir", validateNotesDir(patch.notesDir));
      if (patch.remote !== undefined) set("remote", validateName(patch.remote, "Remote name"));
      if (patch.branch !== undefined) set("branch", validateName(patch.branch, "Branch"));
      if (patch.machineName !== undefined) set("machineName", validateMachineName(patch.machineName));
      if (patch.sync !== undefined) set("sync", Boolean(patch.sync));
      if (patch.syncIdleSeconds !== undefined) set("syncIdleSeconds", validateSeconds(patch.syncIdleSeconds, "Sync delay", 2, 3600));
      if (patch.syncIntervalSeconds !== undefined) set("syncIntervalSeconds", validateSeconds(patch.syncIntervalSeconds, "Sync interval", 0, 86_400));
      if (patch.host !== undefined) set("host", String(patch.host).trim() || "127.0.0.1");
      if (patch.port !== undefined) set("port", validateSeconds(patch.port, "Port", 1024, 65_535));
      if (patch.allowedHosts !== undefined) set("allowedHosts", validateHosts(patch.allowedHosts));
      if (patch.remoteUrl !== undefined && patch.remoteUrl !== null && patch.remoteUrl !== "") validateRemoteUrl(patch.remoteUrl);

      const nowExposed = !isLoopback(next.host) || next.allowedHosts.length > 0;
      if (nowExposed && !cfg.passwordHash) throw new SettingsError("Set a password before letting other machines reach this server.");

      // Remote URL lives in the repo's git config, not our settings file.
      let remoteChanged = false;
      if (patch.remoteUrl !== undefined && runtime && next.repoPath === cfg.repoPath) {
        const before = await getRemoteUrl(runtime.repoRoot, next.remote);
        await setRemoteUrl(runtime.repoRoot, next.remote, patch.remoteUrl);
        remoteChanged = before !== (patch.remoteUrl || null);
      }

      fileCfg = { ...loadConfigFile(), ...saved };
      saveConfigFile(fileCfg);

      const restartRequired = next.host !== cfg.host || next.port !== cfg.port;
      const runtimeKeys: (keyof Config)[] = ["repoPath", "notesDir", "remote", "branch", "machineName", "sync", "syncIdleSeconds", "syncIntervalSeconds"];
      const needsReload = runtimeKeys.some((k) => next[k] !== cfg[k]);
      const hostsChanged = next.allowedHosts.join() !== cfg.allowedHosts.join();
      if (needsReload) {
        // Listening address/port keep their running values until restart.
        await reconfigure({ ...next, host: cfg.host, port: cfg.port });
        if (patch.remoteUrl !== undefined && runtime) await setRemoteUrl(runtime.repoRoot, next.remote, patch.remoteUrl);
      } else {
        cfg = { ...cfg, allowedHosts: next.allowedHosts };
        if (remoteChanged && runtime) void runtime.syncNow();
      }
      const message = setupError
        ? setupError
        : restartRequired
          ? "Saved. Restart the app to use the new address or port."
          : needsReload || remoteChanged || hostsChanged
            ? "Saved and applied."
            : "Saved.";
      return { settings: await getSettings(), restartRequired, message };
    },

    testRemote: (url) => testRemote(url, isLoopback(cfg.host)),

    async setup(req) {
      if (runtime) throw new SettingsError("Already set up. Use Settings to change the folder.");
      const repoPath = validateFolder(req.repoPath);
      const machineName = req.machineName ? validateMachineName(req.machineName) : cfg.machineName;
      const remoteUrl = req.remoteUrl ? validateRemoteUrl(req.remoteUrl) : null;
      const message = await setupRepo({ repoPath, remoteUrl, remote: cfg.remote, branch: cfg.branch, interactive: isLoopback(cfg.host) });
      fileCfg = { ...loadConfigFile(), repoPath, machineName, notesDir: "." };
      saveConfigFile(fileCfg);
      await reconfigure({ ...cfg, repoPath, machineName, notesDir: "." });
      if (setupError) throw new SettingsError(setupError);
      return { message };
    },

    async setPassword(password) {
      if (password === null) {
        if (exposed()) throw new SettingsError("Other machines can reach this server, so it needs a password.");
        fileCfg = { ...loadConfigFile() };
        delete fileCfg.passwordHash;
        saveConfigFile(fileCfg);
        cfg = { ...cfg, passwordHash: undefined };
        return { message: "Password removed." };
      }
      if (password.length < 8) throw new SettingsError("Use at least 8 characters.");
      const hash = hashPassword(password);
      fileCfg = { ...loadConfigFile(), passwordHash: hash };
      saveConfigFile(fileCfg);
      cfg = { ...cfg, passwordHash: hash };
      return { message: "Password saved. Your browser will ask for it next." };
    },
  };

  // Lets `notes-app stop` (installers, uninstallers) stop us even with a password set.
  const controlToken = randomBytes(24).toString("hex");
  const tokenFile = controlTokenFile(cfg.port);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, controlToken, { mode: 0o600 });

  const app = createApp({
    controlToken,
    runtime: () => runtime,
    info,
    settings,
    host: cfg.host,
    passwordHash: () => cfg.passwordHash,
    allowedHosts: () => cfg.allowedHosts,
    webDir: SEA ? path.join(path.dirname(process.execPath), "web") : path.join(path.dirname(fileURLToPath(import.meta.url)), "web"),
    // Inside the exe, the web UI's files are embedded assets.
    readStatic: SEA ? (rel) => seaAsset(`web/${rel}`) : undefined,
    shutdown: () => void stop(),
  });

  console.log(`notes-app ${VERSION}`);
  await startRuntime();
  if (!runtime && !setupError) console.log("  No notes folder yet: open the app to set one up.");
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(cfg.port, cfg.host, resolve);
  });
  const shownHost = isLoopback(cfg.host) ? "localhost" : cfg.host === "0.0.0.0" ? "<this-machine's-address>" : cfg.host;
  const url = `http://${shownHost}:${cfg.port}/`;
  console.log(`  open:   ${url}${cfg.passwordHash ? "  (password required)" : ""}`);
  for (const h of cfg.allowedHosts) console.log(`  also:   https://${h}/  (via tailscale serve)`);
  if (cli.open && isLoopback(cfg.host)) openAppWindow(url);

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  async function stop(): Promise<void> {
    if (stopping) process.exit(1); // second Ctrl+C: leave now
    stopping = true;
    console.log(cfg.sync && runtime ? "Shutting down: final sync (up to 10 s)…" : "Shutting down.");
    app.server.close();
    app.closeClients();
    await switching;
    await runtime?.stop(10_000);
    fs.rmSync(tokenFile, { force: true });
    process.exit(0);
  }
}

function controlTokenFile(port: number): string {
  return path.join(dataDir(), `control-${port}.token`);
}

function readSshPublicKey(): string | null {
  for (const name of ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]) {
    try {
      return fs.readFileSync(path.join(os.homedir(), ".ssh", name), "utf8").trim();
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// --- launch: background server + app window -------------------------------------

function requestShutdown(port: number): Promise<boolean> {
  let token = "";
  try {
    token = fs.readFileSync(controlTokenFile(port), "utf8").trim();
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/shutdown",
        method: "POST",
        headers: { Host: "localhost", "X-Notes-App": "1", "X-Notes-Control": token, "Content-Type": "application/json" },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end("{}");
  });
}

/** Is a notes server answering on this port? (401 counts: it's ours, with a password.) */
function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/info", headers: { Host: "localhost" }, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 || res.statusCode === 401);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function launch(cli: Cli, fileCfg: Partial<Config>): Promise<void> {
  const cfg: Config = { ...defaults(), ...fileCfg, ...cli.overrides };
  const noWindow = process.argv.includes("--no-window");
  if (!(await probe(cfg.port))) {
    fs.mkdirSync(dataDir(), { recursive: true });
    const logFile = path.join(dataDir(), "notes-app.log");
    // Keep the log from growing forever.
    try {
      if (fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, logFile + ".old");
    } catch {
      /* no log yet */
    }
    const log = fs.openSync(logFile, "a");
    const args = process.argv.slice(2).filter((a) => a !== "launch" && a !== "--no-window");
    // The exe runs itself with "serve"; a plain install runs node with this script.
    const childArgs = SEA ? ["serve", ...args] : [fileURLToPath(import.meta.url), ...args];
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ["ignore", log, log], windowsHide: true });
    child.unref();
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await new Promise((r) => setTimeout(r, 200));
      up = await probe(cfg.port);
    }
    if (!up) throw new Error(`The notes server didn't start. See ${logFile}`);
  }
  if (!noWindow) openAppWindow(`http://localhost:${cfg.port}/`);
}

/** Prefer a chromeless app window (Edge/Chrome/Chromium --app); fall back to the default browser. */
function openAppWindow(url: string): void {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const pf = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const base of pf) {
      candidates.push(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
    }
  } else if (process.platform === "darwin") {
    for (const app of ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"]) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`, path.join(os.homedir(), `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
        candidates.push(path.join(dir, bin));
      }
    }
  }
  const browser = candidates.find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const run = (cmd: string, args: string[]) => {
    try {
      spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }).on("error", () => undefined).unref();
    } catch {
      /* the URL is printed */
    }
  };
  if (browser) return run(browser, [`--app=${url}`, "--window-size=1280,860"]);
  if (process.platform === "win32") run("cmd", ["/c", "start", "", url]);
  else run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

/**
 * Ask several questions without echoing the answers. One readline interface
 * for all of them, so piped input (two lines) works as well as a terminal.
 * Resolves with undefined for answers that never came (input closed).
 */
function promptHidden(questions: string[]): Promise<(string | undefined)[]> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    const answers: (string | undefined)[] = [];
    let prompt = "";
    // Echo the prompt text but not the typed characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s === prompt) process.stdout.write(s);
    };
    const lines: string[] = [];
    let waiting: ((line: string | undefined) => void) | null = null;
    rl.on("line", (line) => (waiting ? (waiting(line), (waiting = null)) : lines.push(line)));
    rl.on("close", () => waiting?.(undefined));
    const next = () =>
      new Promise<string | undefined>((res) => {
        if (lines.length) res(lines.shift());
        else waiting = res;
      });
    (async () => {
      for (const q of questions) {
        prompt = q;
        rl.setPrompt(q);
        rl.prompt();
        const a = await next();
        process.stdout.write("\n");
        answers.push(a);
        if (a === undefined) break;
      }
      rl.close();
      resolve(answers);
    })();
  });
}

main().catch((err: Error) => {
  console.error(`notes-app: ${err.message}`);
  // The Windows exe has no console window, so show the problem in a message box.
  if (SEA && process.platform === "win32") showErrorBox(err.message);
  process.exit(1);
});

function showErrorBox(message: string): void {
  const quoted = `'${message.replace(/'/g, "''")}'`;
  try {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${quoted}, 'Notes', 'OK', 'Error') | Out-Null`,
      ],
      { windowsHide: true, timeout: 10 * 60_000 },
    );
  } catch {
    /* nothing else we can do */
  }
}
