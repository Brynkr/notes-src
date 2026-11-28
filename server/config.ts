// Settings: a JSON file in the OS config folder, overridable by CLI flags.
// Nothing here lives in the notes repo. The optional password is stored only
// as a salted scrypt hash.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_NAME = "notes-app";

export interface Config {
  /** Absolute path of the git repo that holds the notes. */
  repoPath: string;
  /** Folder inside the repo that holds the notes ("." for the repo root). */
  notesDir: string;
  remote: string;
  branch: string;
  /** Address to listen on. 127.0.0.1 = this machine only. 0.0.0.0 = your network. */
  host: string;
  port: number;
  /** Used in auto-commit messages and conflict-copy names. */
  machineName: string;
  syncIdleSeconds: number;
  syncIntervalSeconds: number;
  sync: boolean;
  /**
   * Extra host names this server answers to while listening on 127.0.0.1,
   * e.g. the Tailscale name when published with `tailscale serve`.
   */
  allowedHosts: string[];
  /** scrypt hash; when set, every request needs this password. */
  passwordHash?: string;
  /** IDE mode: absolute paths of folders outside the notes repo shown in the file tree (this computer only). */
  outsideFolders: string[];
  /** Jama Connect address (e.g. https://acme.jamacloud.com); Jama IDs in notes link to its search. "" = off. */
  jamaUrl: string;
}

export function configDir(): string {
  if (process.env.NOTES_APP_CONFIG_DIR) return process.env.NOTES_APP_CONFIG_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), APP_NAME);
}

export function dataDir(): string {
  if (process.env.NOTES_APP_DATA_DIR) return process.env.NOTES_APP_DATA_DIR;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), APP_NAME);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), APP_NAME);
}

export function configFile(): string {
  return path.join(configDir(), "config.json");
}

export function defaults(): Config {
  return {
    repoPath: "",
    notesDir: ".",
    remote: "origin",
    branch: "main",
    host: "127.0.0.1",
    port: 4747,
    machineName: defaultMachineName(),
    syncIdleSeconds: 8,
    syncIntervalSeconds: 180,
    sync: true,
    allowedHosts: [],
    outsideFolders: [],
    jamaUrl: "",
  };
}

/** Host name, cut down to what Settings accepts (letters, digits, . _ - space; 40 chars). */
export function defaultMachineName(host = os.hostname()): string {
  const clean = host
    .split(".")[0]
    .replace(/[^A-Za-z0-9 ._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 40)
    .replace(/[-. _]+$/, "");
  return clean || "machine";
}

export function loadConfigFile(): Partial<Config> {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<Config>;
  } catch {
    return {};
  }
}

export function saveConfigFile(cfg: Partial<Config>): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = configFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, configFile());
}

export interface Cli {
  command: "serve" | "set-password" | "clear-password" | "help" | "version" | "launch" | "configure" | "stop" | "has-password" | "running";
  /** True when no command was given (the portable exe then launches). */
  defaulted?: boolean;
  overrides: Partial<Config>;
  open: boolean;
  save: boolean;
  allowNoPassword: boolean;
}

export function parseArgs(argv: string[]): Cli {
  const cli: Cli = { command: "serve", overrides: {}, open: false, save: false, allowNoPassword: false, defaulted: true };
  const o = cli.overrides;
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const num = (v: string, flag: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "serve":
        cli.command = "serve";
        cli.defaulted = false;
        break;
      case "set-password":
      case "clear-password":
      case "help":
      case "version":
      case "launch":
      case "configure":
      case "stop":
      case "has-password":
      case "running":
        cli.command = a;
        cli.defaulted = false;
        break;
      case "-h":
      case "--help":
        cli.command = "help";
        break;
      case "--repo":
        o.repoPath = path.resolve(expandHome(need(i++, a)));
        break;
      case "--notes-dir":
        o.notesDir = need(i++, a);
        break;
      case "--remote":
        o.remote = need(i++, a);
        break;
      case "--branch":
        o.branch = need(i++, a);
        break;
      case "--host":
        o.host = need(i++, a);
        break;
      case "--allow-host":
        o.allowedHosts = [...(o.allowedHosts ?? []), need(i++, a).toLowerCase()];
        break;
      case "--lan":
        o.host = "0.0.0.0";
        break;
      case "--port":
        o.port = num(need(i++, a), a);
        break;
      case "--machine-name":
        o.machineName = need(i++, a);
        break;
      case "--sync-idle":
        o.syncIdleSeconds = num(need(i++, a), a);
        break;
      case "--sync-interval":
        o.syncIntervalSeconds = num(need(i++, a), a);
        break;
      case "--no-window":
        break; // handled by "launch"
      case "--no-sync":
        o.sync = false;
        break;
      case "--open":
        cli.open = true;
        break;
      case "--save":
        cli.save = true;
        break;
      case "--allow-no-password":
        cli.allowNoPassword = true;
        break;
      default:
        throw new Error(`Unknown option: ${a} (try --help)`);
    }
  }
  return cli;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// --- password hashing ------------------------------------------------------

const N = 16384;
const R = 8;
const P = 1;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = scryptSync(pw, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const HELP = `notes-app: git-backed Markdown notes

Usage:
  notes-app [options]            start the server
  notes-app launch [--no-window] start it in the background if needed, open the app window
  notes-app stop                 stop a running server (after a final sync)
  notes-app running              exit code 0 if a server is running, 1 if not
  notes-app configure [options]  save options as defaults without starting
  notes-app set-password         require a password (needed for --lan)
  notes-app clear-password

Options:
  --repo <path>          git repo holding your notes (or set it up in the app)
  --notes-dir <dir>      folder inside the repo for notes (default ".")
  --remote <name>        git remote to sync with (default origin)
  --branch <name>        branch to sync (default main)
  --port <n>             default 4747
  --host <addr>          default 127.0.0.1 (this machine only)
  --lan                  listen on all interfaces (home network)
  --allow-host <name>    also answer to this host name, e.g. pi.tailnet.ts.net
                         when published with "tailscale serve" (repeatable)
  --machine-name <name>  used in commit messages and conflict copies
  --sync-idle <s>        sync this long after the last save (default 8)
  --sync-interval <s>    background sync period (default 180, 0 = off)
  --no-sync              never run git (local editing only)
  --open                 open the app in your browser
  --save                 store these options as the defaults

Settings file: ${configFile()}
`;
