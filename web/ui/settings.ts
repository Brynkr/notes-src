// Settings dialog and first-run setup screen.

import type { AppInfo, SettingsDto, SettingsPatch } from "../../shared/types.ts";
import { api } from "../api.ts";
import { h, icons, toast } from "./dom.ts";

type Field = HTMLInputElement | HTMLSelectElement;

function row(label: string, control: Node, hint?: string | Node): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ? h("span", { class: "field-hint" }, hint) : null);
}

function input(attrs: Record<string, unknown>): HTMLInputElement {
  return h("input", { class: "text-input", spellcheck: "false", autocomplete: "off", ...attrs });
}

async function copyText(text: string, fallbackEl?: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.", "info", [], 2500);
  } catch {
    // Not a secure context (e.g. http on the home network): select it instead.
    if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
    toast("Press Ctrl+C to copy the selected text.", "info", [], 4000);
  }
}

function sshKeyBlock(key: string | null): HTMLElement | null {
  if (!key) return null;
  const pre = h("code", { class: "ssh-key" }, key);
  return h(
    "div",
    { class: "ssh-box" },
    h("p", {}, "This machine's SSH key. To let it sync over SSH, add it on GitHub: your notes repo → Settings → Deploy keys → Add deploy key, and tick “Allow write access”."),
    pre,
    h("button", { type: "button", class: "btn btn-small", onclick: () => copyText(key, pre) }, "Copy key"),
  );
}

/** "Test connection" button + result line for a remote URL input. */
function remoteTester(urlInput: HTMLInputElement): { button: HTMLButtonElement; result: HTMLElement } {
  const result = h("span", { class: "test-result", "aria-live": "polite" });
  const button = h(
    "button",
    {
      type: "button",
      class: "btn btn-small",
      onclick: async () => {
        const url = urlInput.value.trim();
        if (!url) {
          result.textContent = "Enter a URL first.";
          result.className = "test-result bad";
          return;
        }
        button.disabled = true;
        result.textContent = "Checking… (a GitHub sign-in window may open)";
        result.className = "test-result";
        try {
          const r = await api.testRemote(url);
          result.textContent = r.message;
          result.className = `test-result ${r.ok ? "good" : "bad"}`;
        } catch (err) {
          result.textContent = (err as Error).message;
          result.className = "test-result bad";
        } finally {
          button.disabled = false;
        }
      },
    },
    "Test connection",
  );
  return { button, result };
}

// --- settings dialog ------------------------------------------------------------

export class SettingsDialog {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private settings: SettingsDto | null = null;
  private fields = new Map<keyof SettingsPatch, Field>();
  private readonly onClosed: () => void;
  private readonly beforeApply: () => Promise<void>;

  constructor(opts: { onClosed: () => void; beforeApply: () => Promise<void> }) {
    this.onClosed = opts.onClosed;
    this.beforeApply = opts.beforeApply;
    this.body = h("div", { class: "dialog-body" });
    this.status = h("span", { class: "dialog-status", "aria-live": "polite" });
    const panel = h(
      "form",
      {
        class: "dialog",
        role: "dialog",
        "aria-label": "Settings",
        onsubmit: (e: Event) => {
          e.preventDefault();
          void this.save();
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === "Escape") this.close();
        },
      },
      h("header", { class: "dialog-head" }, h("h2", {}, "Settings"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", html: icons.close, onclick: () => this.close() })),
      this.body,
      h("footer", { class: "dialog-foot" }, this.status, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: () => this.close() }, "Close"), h("button", { type: "submit", class: "btn btn-primary" }, "Save")),
    );
    this.el = h("div", { class: "dialog-backdrop", hidden: true, onmousedown: (e: MouseEvent) => e.target === this.el && this.close() }, panel);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  async show(): Promise<void> {
    this.el.hidden = false;
    this.status.textContent = "";
    this.body.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    try {
      this.settings = await api.settings();
      this.render();
      this.body.querySelector<HTMLElement>("input")?.focus();
    } catch (err) {
      this.body.replaceChildren(h("p", { class: "bad" }, `Couldn't load settings: ${(err as Error).message}`));
    }
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.onClosed();
  }

  private bind<K extends keyof SettingsPatch>(key: K, el: Field): Field {
    this.fields.set(key, el);
    return el;
  }

  private render(): void {
    const s = this.settings!;
    this.fields.clear();
    const cli = new Set(s.fromCommandLine);
    const cliNote = (k: string) => (cli.has(k) ? " Currently set by a command-line option, which wins until the app is started without it." : "");

    const remoteUrl = input({ value: s.remoteUrl ?? "", placeholder: "git@github.com:you/notes.git" }) as HTMLInputElement;
    this.bind("remoteUrl", remoteUrl);
    const tester = remoteTester(remoteUrl);

    const syncOn = h("input", { type: "checkbox", class: "check" }) as HTMLInputElement;
    syncOn.checked = s.sync;
    this.bind("sync", syncOn);

    const hostSel = h(
      "select",
      { class: "text-input" },
      h("option", { value: "127.0.0.1" }, "This computer only"),
      h("option", { value: "0.0.0.0" }, "Home network (other devices, password required)"),
    ) as HTMLSelectElement;
    hostSel.value = s.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
    this.bind("host", hostSel);

    const pwInput = input({ type: "password", placeholder: s.hasPassword ? "New password" : "At least 8 characters", autocomplete: "new-password" });

    this.body.replaceChildren(
      h("section", {}, h("h3", {}, "Notes folder"),
        row("Folder", this.bind("repoPath", input({ value: s.repoPath })), "Changing it switches to that folder right away." + cliNote("repoPath")),
        row("Notes inside it", this.bind("notesDir", input({ value: s.notesDir })), "Use . for the top of the folder, or a subfolder like notes."),
      ),
      h("section", {}, h("h3", {}, "Sync"),
        h("label", { class: "check-row" }, syncOn, " Sync this folder with git"),
        row("Repository URL", h("div", { class: "inline" }, remoteUrl, tester.button), tester.result),
        sshKeyBlock(s.sshPublicKey),
        h("div", { class: "grid-2" },
          row("Sync after typing stops (s)", this.bind("syncIdleSeconds", input({ type: "number", min: "2", max: "3600", value: String(s.syncIdleSeconds) }))),
          row("Also sync every (s, 0 = never)", this.bind("syncIntervalSeconds", input({ type: "number", min: "0", max: "86400", value: String(s.syncIntervalSeconds) }))),
          row("Branch", this.bind("branch", input({ value: s.branch }))),
          row("Remote name", this.bind("remote", input({ value: s.remote }))),
        ),
      ),
      h("section", {}, h("h3", {}, "This machine"),
        row("Name", this.bind("machineName", input({ value: s.machineName })), "Shown in sync history and on conflict copies."),
      ),
      h("section", {}, h("h3", {}, "Links"),
        row("Jama address", this.bind("jamaUrl", input({ value: s.jamaUrl, placeholder: "https://yourcompany.jamacloud.com" })), "Jama IDs in your notes (like PROJ-REQ-123 or GID-4567) become links to Jama's search. Ctrl+click to open. Leave empty to turn off."),
      ),
      h("section", {}, h("h3", {}, "Access"),
        h("div", { class: "grid-2" },
          row("Who can connect", this.bind("host", hostSel), cliNote("host")),
          row("Port", this.bind("port", input({ type: "number", min: "1024", max: "65535", value: String(s.port) }))),
        ),
        row(
          "Tailscale name(s)",
          this.bind("allowedHosts", input({ value: s.allowedHosts.join(", "), placeholder: "pi.your-tailnet.ts.net" })),
          "For access away from home through “tailscale serve”. See the README. Requires a password.",
        ),
        h("div", { class: "field" },
          h("span", { class: "field-label" }, s.hasPassword ? "Password (set)" : "Password (not set)"),
          h("div", { class: "inline" },
            pwInput,
            h("button", { type: "button", class: "btn btn-small", onclick: () => this.setPassword(pwInput.value) }, s.hasPassword ? "Change" : "Set"),
            s.hasPassword ? h("button", { type: "button", class: "btn btn-small", onclick: () => this.setPassword(null) }, "Remove") : null,
          ),
        ),
      ),
      h("section", { class: "about" }, h("h3", {}, "About"),
        h("p", {}, `Notes ${s.version}`),
        h("p", { class: "muted" }, "Settings file: ", h("code", {}, s.configFile)),
        h("p", { class: "muted" }, "Search index and logs: ", h("code", {}, s.dataDir)),
      ),
    );
  }

  private patch(): SettingsPatch {
    const s = this.settings!;
    const p: SettingsPatch = {};
    const val = (k: keyof SettingsPatch) => this.fields.get(k);
    const str = (k: keyof SettingsPatch) => (val(k) as HTMLInputElement).value.trim();
    if (str("repoPath") !== s.repoPath) p.repoPath = str("repoPath");
    if (str("notesDir") !== s.notesDir) p.notesDir = str("notesDir");
    if (str("remoteUrl") !== (s.remoteUrl ?? "")) p.remoteUrl = str("remoteUrl") || null;
    if ((val("sync") as HTMLInputElement).checked !== s.sync) p.sync = (val("sync") as HTMLInputElement).checked;
    if (Number(str("syncIdleSeconds")) !== s.syncIdleSeconds) p.syncIdleSeconds = Number(str("syncIdleSeconds"));
    if (Number(str("syncIntervalSeconds")) !== s.syncIntervalSeconds) p.syncIntervalSeconds = Number(str("syncIntervalSeconds"));
    if (str("branch") !== s.branch) p.branch = str("branch");
    if (str("remote") !== s.remote) p.remote = str("remote");
    if (str("machineName") !== s.machineName) p.machineName = str("machineName");
    if (str("jamaUrl") !== s.jamaUrl) p.jamaUrl = str("jamaUrl");
    const host = (val("host") as HTMLSelectElement).value;
    if (host !== (s.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1")) p.host = host;
    if (Number(str("port")) !== s.port) p.port = Number(str("port"));
    const hosts = str("allowedHosts").split(/[\s,]+/).filter(Boolean).join(", ");
    if (hosts !== s.allowedHosts.join(", ")) p.allowedHosts = hosts ? hosts.split(", ") : [];
    return p;
  }

  private async save(): Promise<void> {
    const p = this.patch();
    if (!Object.keys(p).length) {
      this.status.textContent = "Nothing changed.";
      return;
    }
    this.status.textContent = "Saving…";
    this.status.className = "dialog-status";
    try {
      await this.beforeApply();
      const r = await api.updateSettings(p);
      this.settings = r.settings;
      this.render();
      this.status.textContent = r.message;
      this.status.className = `dialog-status ${r.restartRequired ? "warn" : "good"}`;
    } catch (err) {
      this.status.textContent = (err as Error).message;
      this.status.className = "dialog-status bad";
    }
  }

  private async setPassword(pw: string | null): Promise<void> {
    try {
      const r = await api.setPassword(pw);
      this.status.textContent = r.message;
      this.status.className = "dialog-status good";
      this.settings = await api.settings();
      this.render();
    } catch (err) {
      this.status.textContent = (err as Error).message;
      this.status.className = "dialog-status bad";
    }
  }
}

// --- first-run setup ----------------------------------------------------------------

export function renderSetup(root: HTMLElement, info: AppInfo, sshKey: string | null): void {
  const folder = input({ value: info.repoPath || info.defaultRepoPath, "aria-label": "Notes folder" });
  const url = input({ placeholder: "git@github.com:you/notes.git  (optional)", "aria-label": "Repository URL" });
  const machine = input({ value: info.machineName, "aria-label": "Machine name" });
  const tester = remoteTester(url);
  const result = h("p", { class: "setup-result", "aria-live": "polite" }, info.setupError ?? "");
  if (info.setupError) result.classList.add("bad");
  const go = h("button", { type: "submit", class: "btn btn-primary btn-big" }, "Start writing");

  root.replaceChildren(
    h(
      "div",
      { class: "setup" },
      h(
        "form",
        {
          class: "setup-card",
          onsubmit: async (e: Event) => {
            e.preventDefault();
            go.disabled = true;
            result.className = "setup-result";
            result.textContent = url.value.trim() ? "Setting up… (cloning can take a moment; a GitHub sign-in window may open)" : "Setting up…";
            try {
              await api.setup({ repoPath: folder.value.trim(), remoteUrl: url.value.trim() || null, machineName: machine.value.trim() });
              location.reload();
            } catch (err) {
              result.textContent = (err as Error).message;
              result.className = "setup-result bad";
              go.disabled = false;
            }
          },
        },
        h("img", { src: "/icon.svg", alt: "", class: "setup-icon", width: "56", height: "56" }),
        h("h1", {}, "Set up your notes"),
        h("p", { class: "muted" }, "Notes are plain Markdown files in a folder. Sync keeps that folder the same on all your devices through a private GitHub repository."),
        h(
          "ol",
          { class: "setup-steps" },
          h("li", {}, "Create an empty private repository on GitHub (github.com/new), for example “notes”. Don't add a README."),
          h("li", {}, "Make sure this computer can push to GitHub (an SSH key, or Git Credential Manager on Windows)."),
          h("li", {}, "Paste the repository's URL below. You can also leave it empty and add it later in Settings."),
        ),
        row("Notes folder on this computer", folder, "An empty or new folder. Created if it doesn't exist."),
        row("GitHub repository URL", h("div", { class: "inline" }, url, tester.button), tester.result),
        sshKeyBlock(info.local ? null : sshKey),
        row("Name for this computer", machine, "Shown in sync history and on conflict copies, e.g. desktop, laptop, pi."),
        go,
        result,
      ),
    ),
  );
  folder.focus();
}
