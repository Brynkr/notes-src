# Handover: Git-backed Markdown Notes App

Purpose of this document: give an AI coding assistant (or a human) everything needed to start building this project without re-deriving the design. Last updated 27 November 2026 (M0–M7 built, plus wiki links, settings, installers, Tailscale access, Trash, history and offline; see **Section 17**).

## 1. How to use this document

- Treat **Section 3 (Decisions made)** as fixed requirements.
- Treat **Section 4 (Recommended defaults)** as the working plan. Follow it unless the owner says otherwise, and flag it when you deviate.
- Treat **Section 5 (Open questions)** as things to ask the owner before building the parts that depend on them. Do not guess.
- Build in the order given in **Section 12 (Milestones)**. Each milestone has acceptance criteria. Do not start a milestone until the previous one passes.
- Follow the **working agreements in Section 14** at all times.

## 2. Project summary

A lightweight, GUI note-taking app for one person, used across a few of their own machines. Notes are plain Markdown files in a folder that is a git repository hosted on GitHub. The app edits those files and keeps them synced by running git in the background. There is no custom sync server.

Goals:

- Fast to open, pleasant to type in, works fully offline.
- Notes remain ordinary Markdown files that any editor can read. No lock-in.
- Sync is automatic and boring: it should never lose text and never leave conflict markers in a note.
- Optional split-screen editing (up to four panes) for working with several notes at once.

Non-goals (for v1):

- Multi-user accounts, sharing, or real-time collaboration.
- Mobile apps.
- Rich-text (WYSIWYG) editing, attachments, end-to-end encryption, plugins.
- Hosting any server component.

## 3. Decisions made (fixed)

| Area | Decision |
| --- | --- |
| Users | Single user (the owner), several machines they control |
| Platforms | Windows, Linux, macOS desktops; a web UI hosted on the owner's Raspberry Pi (phones, any browser, at home and via Tailscale away from home); later KindleHub, a KOReader plugin on a 7th-gen Kindle (decided 27 Nov 2026) |
| Storage | Markdown files in a folder that is a git repo, hosted on GitHub |
| Sync | Via git, driven by the app. No custom sync server: every machine running the app is a git client of GitHub. Devices that can't run git (phone browser, KindleHub) talk HTTP to a machine running the app, normally the Pi (decided 27 Nov 2026) |
| Interface | GUI, not terminal-based. Desktop: the app's web UI in an installed app window. Pi: the same web UI over the home network |
| Layout | Left sidebar plus one editor pane by default. Optional split screen up to a 2x2 grid of four panes |
| Scope | Lightweight. Prefer fewer features done well |

## 4. Recommended defaults

These were proposed during design discussion. Follow them unless told otherwise. 4.1 was decided on 27 Nov 2026.

### 4.1 Stack (decided 27 Nov 2026; replaces the original Tauri plan)

- **One TypeScript codebase, two deployments.** A small Node.js server (`server/`) serves the web UI and runs git in the background. On a desktop it listens on `127.0.0.1` and the owner uses it as an installed app window (Chrome/Edge "Install app"). On the Raspberry Pi it listens on the LAN behind a password.
  - Why: the owner wants the same UI on the Pi for phones and other devices, and KindleHub later. A web server backend serves all of them with one codebase and one sync engine. Tauri would have needed a second backend for the Pi.
  - A native wrapper (Tauri or Electron pointing at the local server) can be added later without changing the backend.
- **Node.js 22.13+** (24 LTS recommended). The server has **no runtime npm dependencies**: it uses `node:http`, `node:sqlite` (FTS5 included) and `fs.watch`. `npm run build` bundles it into `dist/server.js`, and `dist/` is all that gets deployed.
- **CodeMirror 6** as the editor, with Markdown language support. Frontend is plain TypeScript (no framework), bundled with esbuild.
- **SQLite with FTS5** for the search index, via Node's built-in `node:sqlite`. The index is disposable and rebuilt from the files.
- **Git:** shell out to the system `git` binary (unchanged).
- **Server → UI events:** Server-Sent Events (`/api/events`). UI → server: plain JSON HTTP.

### 4.2 Authentication

Use whatever the machine already has: SSH keys or a credential helper, configured outside the app. The app only needs the remote to be pushable. Do not build token-entry UI for v1. If push fails with an auth error, show a clear message with the git error text.

### 4.3 Note files

- One note per `.md` file, stored inside the repo (a `notes/` subfolder or the repo root, configurable).
- **Stable filenames:** `YYYYMMDD-HHMMSS-slug.md`, generated at creation. The filename never changes when the title changes, which keeps history and merges clean.
- **Title** is derived from the first Markdown H1, falling back to the first non-empty line, falling back to the filename.
- **Optional YAML front matter** for metadata that should travel with the note: `tags`, `created`. Do not require it. Preserve any front matter byte-for-byte when saving.
- Deleting a note moves it to `.trash/` in the notes folder; the auto-commit syncs that move, so the Trash is the same on every device. "Delete forever" removes it from `.trash/` (it stays in git history). (Changed 27 Nov 2026; was `git rm`.)

### 4.4 What lives where

- **In the repo:** the notes, a `.gitignore`.
- **Not in the repo:** the search index and app settings (OS app-data and config directories), and window/layout state (the browser's `localStorage`, so each device keeps its own layout).

## 5. Open questions (ask the owner)

Answered on 27 Nov 2026:

1. ~~Final stack~~: TypeScript/Node server + web UI (see 4.1).
2. ~~Operating systems~~: Windows, Linux, macOS, plus the Pi web UI and KindleHub later.
3. ~~Phone access~~: yes, through the web UI hosted on the Pi.
4. ~~Notes location / existing repo~~: starting fresh with a new empty GitHub repo. Notes live at the repo root by default (`notesDir` setting).
6. ~~Wiki links~~: built (title-based `[[links]]`, backlinks).
8. ~~KindleHub~~: KindleHub is the owner's KOReader plugin (repo `Brynkr/KindleHub`) on a Kindle the owner believes is 7th gen. Plan: a Lua client using the HTTP sync recipe in `docs/API.md`, talking to the Pi on the home LAN. Owner to share more device detail later; the repo couldn't be read from the 27 Nov session.
9. ~~Pi access from outside the home~~: wanted. Done via Tailscale (`tailscale serve`, HTTPS on the tailnet); see README.

Still open (current behaviour in brackets):

5. **Subfolders:** partly answered 28 Nov: top-level `Home/` and `Work/` folders are the two modes (Section 17). [folders inside a mode are listed with a folder prefix; new notes go to the mode's folder; no folder UI]
7. **Default branch and remote name** [`main` and `origin`, configurable in Settings]
10. **Which Pi?** The owner has a Raspberry Pi 2 (armv7, 1 GB) that already runs other services. If that's the notes host, Node must stay on 22 (Node 24 has no armv7 build); the installer handles this. [supported]
11. **Link renames:** should changing a note's title rewrite `[[links]]` to it in other notes? [no; old links show as missing]

## 6. Architecture overview

```
+---------------------------------------------------------------+
|  Frontend (web UI)                                            |
|  Sidebar | PaneGrid (1-4 panes of CodeMirror) | StatusBar     |
|  workspace state + buffer store                               |
+-------------------------^-------------------------------------+
                          | commands / events
+-------------------------v-------------------------------------+
|  Backend                                                      |
|  fs (read/write notes)   watcher (file events)                |
|  index (SQLite FTS5)     sync (git queue + policy)            |
|  config (settings)                                            |
+-------------------------^-------------------------------------+
                          |
                  Local clone (folder of .md files)  <->  GitHub remote
```

Principles:

1. **Files are the source of truth.** Everything else (index, UI state) can be deleted and rebuilt.
2. **The editor never waits on git.** Sync runs on a background thread. Typing and saving must stay responsive.
3. **One writer per file.** All writes to note files go through a single function in the backend.
4. **One git operation at a time.** All git commands go through a single queue with a mutex to avoid `index.lock` errors.
5. **Never lose text.** When in doubt, keep both versions.

## 7. Project structure (as built)

```
notes-app/
  server/
    main.ts          entry point: wires everything, CLI, shutdown
    config.ts        settings file + CLI flags, password hashing, OS dirs
    git.ts           the ONLY place git is spawned; serialised queue; error classification
    sync.ts          SyncEngine (10.2/10.3) and SyncScheduler (10.1)
    notes.ts         NoteStore: list/read/create/delete and the single write path
    watcher.ts       debounced fs.watch + periodic rescan
    search.ts        SQLite FTS5 index
    http.ts          JSON API, SSE, static files, auth/CSRF/Host checks, local shutdown
    runtime.ts       NotesRuntime: everything tied to one notes folder; restartable for settings changes
    settings.ts      validation, remote test, first-run clone/adopt, remote URL changes
    quiet.ts         hides node:sqlite's experimental warning
  shared/
    types.ts         API types used by server and UI
    markdown.ts      title/front-matter helpers used by both
    links.ts         [[wiki link]] parsing and resolution
    fuzzy.ts         quick-switcher matching
    modes.ts         Home/Work modes: which folder a path belongs to
  web/
    main.ts          UI wiring, shortcuts, server events
    api.ts           fetch wrappers + EventSource
    state/
      workspace.ts   layout preset, panes, active pane (localStorage)
      buffers.ts     shared buffers, autosave, crash stash
    editor/cm.ts     CodeMirror setup; replays edits between panes sharing a buffer
    editor/wikilinks.ts  link styling, Ctrl/Cmd+click, [[ completion
    ui/              sidebar, panes (+ backlinks), status bar, conflict banner, quick switcher, settings + setup
    static/          index.html, style.css, manifest, icons
  tests/
    sync/            Section 13 scenarios against temp git repos
    server/          note store, watcher, search, HTTP, settings/setup
    shared/          fuzzy matching, wiki links
    ui/smoke.mjs     end-to-end in headless Chrome with a second "machine"
    ui/features.mjs  first-run setup, switcher, links/backlinks, settings
  installer/         install/uninstall for Windows (.ps1 + .cmd) and macOS/Linux/Pi (.sh), icons
  docs/API.md        HTTP API and sync protocol for non-git clients (KindleHub)
  scripts/           build (esbuild), package (release zips), build-exe + test-exe (portable executable), icons, screenshot
```

## 8. Data model

Backend note record (derived, not stored in the repo):

```ts
interface NoteMeta {
  path: string;        // relative to notes root, e.g. "20261125-221000-git-notes.md"
  title: string;       // derived (see 4.3)
  modifiedMs: number;  // file mtime
  tags: string[];      // from front matter, if present
}
```

(As built, `NoteMeta` also has `conflict: boolean` and `hash: string`; see `shared/types.ts`.)

Frontend workspace state (persisted locally, restored on launch):

```ts
type LayoutPreset = "1" | "2v" | "2h" | "3" | "2x2";

interface PaneState {
  id: string;
  notePath: string | null;
  cursor: { anchor: number; head: number };
  scrollTop: number;
}

interface WorkspaceState {
  layout: LayoutPreset;       // "1" is the default
  panes: PaneState[];         // length matches the preset (1, 2, 3 or 4)
  activePaneId: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}
```

Shared buffer store (one entry per open file, regardless of how many panes show it):

```ts
interface Buffer {
  path: string;
  text: string;
  dirty: boolean;
  diskHash: string;   // hash of content last read from or written to disk
  views: number;      // number of panes currently showing this buffer
}
```

## 9. Layout and panes

The owner sketched a layout: a narrow left column (the note list) and a main area that is one pane normally, or split into up to four panes in a 2x2 grid.

- Render the main area with CSS Grid and switch `grid-template-areas` per preset:
  - `1`: one pane
  - `2v`: two panes side by side
  - `2h`: two panes stacked
  - `3`: one large pane on the left, two stacked on the right
  - `2x2`: four equal panes
- **Shared buffers are required.** If the same note is open in two panes, both panes must edit the same buffer. In CodeMirror 6, share one document state across editor instances (or synchronise edits between them). Two independent buffers that both autosave will overwrite each other.
- **Active pane:** exactly one pane is active. Clicking a note in the sidebar opens it in the active pane. A modifier-click (or menu item "Open to the side") opens it in a new split.
- **Closing a pane** collapses the layout to the next smaller preset. No empty slots.
- **Narrow windows:** below a width threshold, show one pane and a collapsible sidebar.
- **Nice to have (later):** draggable dividers that adjust grid track sizes, shortcuts such as split and focus-pane-N, a pane header showing title and dirty marker.
- **Write the code for N panes from the start.** Even in milestone 2 the state is an array of length one. Do not assume a single global editor anywhere.

## 10. Sync design

### 10.1 When sync runs

- After a save, once the editor has been idle for a few seconds (debounce, default 5 to 10 seconds).
- On app start, on window focus, on a timer (default every few minutes), and on a final attempt at quit (with a short timeout).
- Manual "Sync now" action.

### 10.2 Algorithm (merge-based, no history rewriting)

Use merge rather than rebase. It does not rewrite history and keeps "ours" (local) and "theirs" (remote) unambiguous.

```
sync():
  take git mutex
  flush all dirty buffers to disk
  if working tree has changes:
      git add -A
      git commit -m "auto: <ISO timestamp> <hostname>"
  git fetch <remote>
  if remote branch has commits we lack:
      git merge --no-edit <remote>/<branch>
      if merge reports conflicts:
          resolve_conflicts()        # see 10.3
          git commit (merge commit)
  git push <remote> <branch>
  if push is rejected (remote moved): repeat from fetch, max 3 attempts
  update status; release mutex
```

### 10.3 Conflict policy (must never leave conflict markers in a note)

For each unmerged path:

- **Both modified:** save the remote version as `<name> (conflict <YYYY-MM-DD> <host>).md` using `git show <remote>/<branch>:<path>`. Restore the local version with `git checkout --ours <path>`. Stage both files.
- **Deleted on one side, modified on the other:** keep the modified file.
- **Both added with the same name:** keep local as is, save remote as a conflict copy.

Then complete the merge commit. Show a banner in the UI listing the conflict copies, each clickable. The owner resolves them by hand and deletes the copy.

Safety rule: if anything in this process fails halfway, run `git merge --abort` and report the error. Never leave the repo in a mid-merge state and never discard local changes.

### 10.4 Status states

`synced`, `syncing`, `offline` (fetch or push failed with a network error), `conflict` (conflict copies exist), `error` (auth, missing git, other). Show state and last successful sync time in the status bar.

### 10.5 Handling files that change under the editor

A merge can rewrite files that are open. The file watcher must tell the buffer store:

- If the buffer is clean: reload from disk silently, preserving cursor position where possible.
- If the buffer is dirty: do not overwrite. Treat it as a conflict: keep the in-memory text, save the disk version as a conflict copy, and notify the user.
- Compare against `diskHash` so the app ignores watcher events caused by its own writes.

## 11. Search

- FTS5 table over `(path, title, body)`.
- Build at startup by comparing file mtimes to the index, updating only what changed. Update incrementally on watcher events.
- The index lives in the app-data directory and is never committed. If it is missing or corrupt, rebuild it.
- Query from the sidebar search box. Show results as a ranked list with a short snippet. Debounce input.

## 12. Milestones and acceptance criteria

**M0. Repo and sync prototype (do before any UI).** A script or small CLI that runs the algorithm in 10.2 and 10.3 against a folder. Acceptance: passes the test scenarios in Section 13 using temporary repos.

**M1. App skeleton.** Window, choose or configure the notes folder, list notes in the sidebar, open one note in a single CodeMirror pane, edit it, autosave to disk. Acceptance: edits persist to the file; app restarts into the same note; new note and delete note work.

**M2. Buffer layer and pane model.** Shared buffer store and the pane-array workspace state, still showing one pane. Watcher integrated. Acceptance: editing a file externally updates a clean buffer; a dirty buffer is never overwritten.

**M3. Search.** FTS5 index with incremental updates and the sidebar search box. Acceptance: new, edited, renamed-externally and deleted notes are reflected in results within a couple of seconds; deleting the index file and relaunching rebuilds it.

**M4. In-app sync.** Background sync using the M0 logic, status bar, git queue, graceful handling of missing git, no network, and auth failure. Acceptance: typing is never blocked during sync; two machines converge after edits on each.

**M5. Conflict handling UI.** Conflict copies, banner, click-through. Acceptance: forced conflict produces both files and no markers in either.

**M6. Split screen.** `2v` first (it exercises every hard case: same note in two panes, focus, close), then `2h`, `3`, `2x2`. Acceptance: same note in two panes stays in sync; closing panes collapses the layout; layout restores on relaunch.

**M7. Polish.** Settings screen (repo path, remote, branch, intervals), quick-switch fuzzy finder, keyboard shortcuts, sensible errors, packaging for the owner's operating systems.

**Later (not planned):** wiki links and backlinks, tags UI, Markdown preview, per-note history from `git log`, draggable dividers.

### Status (27 Nov 2026)

| Milestone | Status |
| --- | --- |
| M0 sync prototype | Done. All 10 Section 13 scenarios plus extras pass (`tests/sync`) |
| M1 skeleton | Done. First-run setup screen picks the folder and remote |
| M2 buffers + panes + watcher | Done |
| M3 search | Done |
| M4 in-app sync | Done. "Two machines converge" is tested with real git; not yet tried on two physical machines |
| M5 conflict UI | Done (banner, chips open the copy beside the original, toast on save conflicts) |
| M6 split screen | Done, all five presets, restore on reload. Draggable dividers not built |
| M7 polish | Done: settings screen, fuzzy quick switcher (Ctrl/Cmd+P), shortcuts, phone layout, dark mode, installers for Windows/macOS/Linux/Pi |
| Later: wiki links + backlinks | Done (27 Nov) |
| Later: per-note history | Done (27 Nov): history dialog with diff and restore |
| Appearance (themes, fonts, zoom) | Done (28 Nov) |
| Portable Windows exe | Done (28 Nov); `npm run test:exe` passed on Windows (in CI, before CI was removed) and Linux |
| Later: tags UI, Markdown preview, draggable dividers | Not built |

## 13. Testing

Sync is the riskiest part. Test it with real git against temporary directories, never against the owner's actual notes repo.

Test harness: create a bare repo as the "remote" and two clones ("machine A" and "machine B"), all in a temp folder.

Scenarios that must pass:

1. A edits and syncs, then B syncs and sees the change.
2. A and B edit different notes offline, then both sync. Both changes survive.
3. A and B edit different parts of the same note. Git merges cleanly.
4. A and B edit the same lines of the same note. Both versions are kept, with a conflict copy and no markers.
5. A deletes a note while B edits it. The edited note is kept.
6. A creates a note while B creates a different one at the same moment. Both survive.
7. Push rejected because the remote moved between fetch and push. Retry succeeds.
8. No network or unreachable remote. State becomes `offline`, local commits are kept, a later sync pushes them.
9. A sync is requested while another is running. Operations are serialised.
10. Mid-merge failure triggers abort and leaves the working tree and local commits intact.

Other tests: filename generation, title extraction, front matter round-trip (byte-for-byte), buffer reload and conflict logic, workspace state restore.

## 14. Working agreements for the AI assistant

- Ask before making changes that touch Section 3. Flag deviations from Section 4.
- Prefer small, reviewable steps and commits. One milestone at a time.
- Do not add dependencies without saying why. Prefer the standard library and the crates and packages named here.
- Never run destructive git commands (`reset --hard`, `clean`, force push) in code paths that touch the real notes repo. Tests use temporary repos only.
- Every sync code path needs a test from Section 13 before it is considered done.
- Keep git operations behind the single `git.rs` wrapper (or equivalent). No ad hoc `git` calls elsewhere.
- Keep all file writes behind one function. No direct writes from UI code.
- Do not store secrets (tokens, keys) in the repo or in plain-text app settings.
- When something in this document is ambiguous or conflicts with the code, say so and ask rather than assume.
- Update this document when a decision is made, so it stays the source of truth.

## 15. Risks and gotchas

- **Shared buffers across panes** are the most common source of data-loss bugs. Build and test them before adding more layouts.
- **Watcher feedback loops:** the app's own writes trigger watcher events. Use content hashes to ignore them.
- **Git index locks:** concurrent git commands fail. Use one queue.
- **Auth failures** look like network failures. Distinguish them in the UI.
- **Large files** (pasted images, binaries) bloat the repo. Warn on large files. Do not support attachments in v1.
- **Line endings and encoding:** keep UTF-8 and preserve the file’s existing line endings. Set `.gitattributes` text handling deliberately if machines mix Windows and Unix.
- **Clock skew** does not matter for git merges, but conflict copy names use local time. That is fine.
- **Quit handling:** a final commit and push on exit must have a timeout so the app never hangs on close.

## 16. Glossary

- **Pane:** one editor view in the main area.
- **Layout preset:** one of the five fixed arrangements of panes.
- **Buffer:** the in-memory text of an open note, shared by every pane showing it.
- **Conflict copy:** a saved duplicate of the other side’s version of a note, created when automatic merging cannot reconcile edits.
- **Notes root:** the folder inside the repo that holds the Markdown files.

## 17. Decision log and notes for the next session

**27 Nov 2026: stack and topology (owner delegated the call).**

- The owner wants a web UI on their Raspberry Pi and, eventually, KindleHub (their own Kindle software) reading and writing notes, syncing automatically on wifi.
- Chosen topology: **every machine that runs the app is a git client of GitHub**, and the Pi is one of them. Devices that can't run git talk HTTP to the Pi using the protocol in `docs/API.md`. Conflicts are resolved the same way on both paths (keep both, conflict copy).
- Rejected: desktops syncing through a custom Pi protocol. It would need a second sync design and conflict layer, and desktops would stop syncing whenever the Pi is off. If the owner later wants the Pi as the hub for desktops too, point their `origin` at a bare repo on the Pi and have the Pi mirror it to GitHub. That's configuration, not code.
- Stack moved from Tauri to TypeScript/Node so the desktop and the Pi share one backend (4.1).

**Behaviour worth knowing**

- Autosave runs about 0.6 s after typing stops. Sync runs 8 s after the last save (`--sync-idle`), every 3 min, on window focus (at most every 30 s), on demand, and once at shutdown (max 10 s).
- Every save carries the hash the editor's text was based on. If the file changed on disk in the meantime (a merge, another editor, another browser), the server saves the disk version as a conflict copy and keeps the editor's text. This is how 10.5 is enforced, and it protects HTTP clients like KindleHub the same way.
- Unsaved editor text is also kept in `localStorage` until the server confirms the save, and replayed on the next launch.
- Deleting a note removes the file; the next auto-commit records the deletion (equivalent to `git rm` + commit).
- Sync refuses to touch a repo that is mid-merge/rebase or on another branch, and says so in the status bar.
- Push rejections caused by the remote moving (including two pushes landing at the same moment) are retried up to 3 times with fetch + merge.
- Line endings: the editor works in LF. When saving, if the file on disk contains any CRLF, the whole file is written with CRLF; otherwise LF. New notes use LF.
- Conflict copies are named `<stem> (conflict YYYY-MM-DD <host>).md`, where `<host>` is the other machine (from its auto-commit message) for git merges, or this machine for save-time conflicts.

**27 Nov 2026 (second session): settings, switcher, wiki links, installers, remote access.**

- The server can start with no notes folder and shows a setup screen. Setup clones an empty or missing folder from the remote, or adopts a folder of notes. It **refuses folders holding anything other than .md/.txt files**, so e.g. Documents can never be pushed to GitHub.
- Everything tied to a notes folder lives in `NotesRuntime`; Settings changes stop it (after a final sync) and start a new one, then tell clients to reload (`reconfigured` event). Listening address/port need a restart.
- Remote URLs are validated (https, ssh, scp-style, absolute paths only) and every git call runs with `protocol.ext.allow=never`. "Repository not found" is an error, not "offline".
- "Test connection" and first-time clone may show Git Credential Manager's sign-in on a desktop (`interactiveAuth`); background syncs never prompt.
- Wiki links are title-based (`[[Title]]`, `[[Title|alias]]`, `[[Title#heading]]`), resolved title first, then filename/slug. The search index (schema v2) stores links for backlinks. Missing targets are dashed; following one creates the note.
- `notes-app launch` = background server + chromeless app window (Edge/Chrome/Chromium `--app`). Installers are per-user scripts rather than signed native installers. Signed MSI/DMG would need certificates and build machines for little gain at this stage.
- Pi: `install.sh --server` sets a password, listens on the LAN, makes an SSH key for a GitHub deploy key, enables linger; `--tailscale` runs `tailscale serve --bg 4747` and adds the ts.net name to `allowedHosts` (password still required).
- Local tools stop the server with a per-start token in `<dataDir>/control-<port>.token` (mode 600), accepted only from loopback.

**27 Nov 2026 (third batch): Trash, history, offline, guards, small wins.**

- **Trash** (`NoteStore.trash/restore/purge/emptyTrash`, `.trash/` inside the notes root, hidden from the list and watcher). The pane's bin button moves notes to the Trash in one click with Undo; the Trash dialog previews/restores/deletes forever.
- **Merge safety net:** git 2.43's default (ort) merge follows renames even with `-X no-renames`, so an edit made on B while A trashed the note would land in `.trash/`. After every merge, `SyncEngine.keepEditedNotes` restores any path modified on either side since the merge base but missing from the result, and commits that. Tests 5b/5c.
- **History:** `NotesRuntime.history/version` (`git log --follow`, `cat-file`), history dialog with a line diff (`shared/diff.ts`) and restore as an undoable editor change. Empty when sync is off (no commits).
- **Offline:** `web/static/sw.js` (network-first, 4 s timeout, caches the shell and GET info/notes/note/status/backlinks). The app warms the cache with every note's latest version. Unsaved text is stashed in localStorage, preferred when a note is opened, and saved when the server is reachable. On unload the stash is written synchronously and the "leave page?" prompt only appears if that fails. Service workers need https or localhost.
- **Guards:** notes over 2 MB are refused (413); files over 5 MB are unstaged before every commit and reported in `status.skipped`; 5 wrong passwords per address then 30 s lockout doubling to 15 min (429, `X-Forwarded-For` behind `tailscale serve`).
- **Small:** `.gitattributes` (`eol=lf`) for repos the app creates; Markdown stripped from search snippets; Alt+D today's note (`YYYY-MM-DD` title); GFM task checkboxes toggle on click (`web/editor/tasks.ts`); conflict copies get a strip with "Open original" and "Done, move copy to Trash"; banner chips say "Title (from machine)"; Escape closes any dialog.

**28 Nov 2026: appearance.** A top bar holds "Go to note…", a text-zoom control and an Appearance pop-out (themes first, then fonts, text, layout, editor). 16 themes (8 light, 8 dark incl. high contrast) live as data in `web/appearance/themes.ts`, applied as CSS variables, with tints derived via `color-mix`; a unit test enforces WCAG contrast (body text ≥ 12:1, secondary text and accents ≥ 4.5:1). Other options: note font (5 system font stacks; no web fonts, so it works offline), interface font, line spacing, line width, borders (none/subtle/strong/cards via `--divider` and `[data-borders]`), corners (`--r-*`), spacing (`[data-density]`), line numbers / current line / spell check (a CodeMirror compartment, switched live), animations. Text zoom scales note text only (Ctrl/Cmd +/−/0). All per device in localStorage (`notes-app:appearance:v1`).

**28 Nov 2026: portable Windows exe.** `npm run exe` (`scripts/build-exe.mjs`) makes a Node SEA: the server bundled to CommonJS (SEA entry points must be CJS on Node 22; `import.meta.url` is defined from `__filename`), `dist/web/**` embedded as `web/<path>` assets and served through `AppContext.readStatic`, injected into a copy of `node.exe` with `postject`, icon/version via `rcedit`, PE subsystem patched to GUI (2) so no console window opens. `server/sea.ts` wraps `node:sea`. In the exe: no command means `launch` (double-click), `launch` respawns the exe itself with the explicit `serve` command, settings/data go to `<exe dir>/Notes-data/{settings,data}` when writable (env vars still win), and fatal errors show a message box via hidden PowerShell since there's no console. Size is about 80–120 MB (it's the whole Node runtime). Git is still a system dependency. Not code-signed, so SmartScreen warns once. CLI output from the windowed exe isn't visible in a terminal; use the installer's `notes` or `node dist/server.js` for CLI work. `scripts/test-exe.mjs` (`npm run test:exe`) checks the subsystem byte, launches it, does setup against a local bare repo, creates a note, syncs and checks the push landed, then stops it.

**28 Nov 2026: no CI.** The owner doesn't want GitHub Actions used, for builds or tests, in any project. `.github/workflows/` (ci.yml, release.yml) was removed; testing is manual (`typecheck`, `test`, `test:ui`, `test:exe`), and release files are built locally (`npm run package`; `npm run exe` on Windows). What CI used to cover that now needs the owner's machines: tests on Windows/macOS, real installer runs there, and the Windows exe build.

**Feedback (28 Nov 2026)**

Baseline before changes: typecheck, build and all 74 unit tests pass on the owner's Windows PC (Node 26).

- *Standing preference:* keep the current minimalist interface; change its look only when the owner explicitly asks.
- *Toggle for underlining/spell check*: already built. The spell check toggle and the 16 themes are in the Appearance pop-out (top right); the owner had missed it and wants no change. No link-underline toggle (no preference given).
- *16 themes choosable in settings*: already built (Appearance pop-out), as above.
- *Programming-language highlighting and an "IDE mode"* (change; relaxes the .md/.txt-only folder guard): **decided: light IDE.** Notes mode stays the default; a toggle at the top right switches to IDE mode, which adds syntax highlighting per language (Python, C, C++, JS…), a file-tree sidebar and a git changes/diff panel. No real linters: stays dependency-free and works on the Pi. Code files are allowed in the folder. Not built yet.
- *Home and Work modes* (change; answers open question 5): **decided:** `Home/` and `Work/` subfolders of the notes root, switched from the sidebar under the "Notes" heading. Existing root notes move into `Home/` in one commit (git keeps their history). Search, daily note, Trash and the quick switcher are scoped to the current mode. **Built (28 Nov)**, see below.
- *UI tests on Windows* (bug found while testing): `test:ui` only looked for Chrome in Linux/macOS locations, so it never ran on Windows without `CHROME=...`. `tests/ui/chrome.mjs` now also finds Chrome and Edge under Program Files / LocalAppData. Running it on Windows showed two things that were already there before the modes change (checked against the old code): the features test saw brief 409s on `GET /api/notes` and `/api/note` while Settings restarts the runtime (the UI retries; the test now allows them), and the smoke test read files mid-merge (it now waits for the merge to finish).

**28 Nov 2026: Home and Work modes (built).**

- `shared/modes.ts`: a note's mode is its first path segment (`Home/`, `Work/`, matched case-insensitively); anything else counts as Home. Mode choice is per device (`notes-app:mode:v1`), like the layout. Switch: the Home | Work control under "Notes" in the sidebar, or Alt+M.
- Scoped to the mode: sidebar list, search (`?mode=`), quick switcher, daily note (each mode has its own), new notes (`POST /api/notes {mode}`, default Home), Trash dialog (Empty Trash only empties this mode's). Not scoped: open panes stay open when switching; wiki links resolve in the current mode first, then the other; the conflict banner lists both modes.
- **Moving existing notes:** at startup `NotesRuntime` moves notes outside both folders into `Home/` (`NoteStore.moveIntoModes`, under the worktree lock), and the next sync commits it (git sees renames; `--follow` history works). Only when there's something to move, it syncs first (max 15 s) so other machines' edits at the old paths are moved too.
- Merges run with `-X no-renames`, so a machine that moved before pulling another machine's edit to `a.md` gets `a.md` back at the root beside a stale `Home/a.md`. On the next move: same bytes → the root file is removed; `Home/` copy is an earlier version of the root file in git history (`isEarlierVersion`) → the newer text replaces it; otherwise both were edited → the root file becomes a conflict copy in `Home/` (shows in the banner). Until the next start such a note shows in Home at its root path. Tests: `tests/sync/modes.test.ts`.
- Reads and saves at a note's old root path go to `Home/<path>` when the root file is gone (`NoteStore.followMove`; the response's `path` says so), so a tab left open across the update, the unsaved-text stash and offline clients never recreate a moved note at the root. The UI also repoints restored panes on boot.

**Repos:** the owner's notes live in `Brynkr/notes` (private, empty at the start; never put source code there). This source lives in `Brynkr/notes-src`.

**Verified in CI (27–28 Nov 2026, before CI was removed):** unit tests on Linux/Windows/macOS × Node 22/24, browser tests, and install → launch → uninstall on Windows (PowerShell installer, shortcuts, Apps & features entry), macOS (LaunchAgent, app bundle) and Linux. The first run found a Windows-only bug (corrupt index file locked while deleting) and an over-long default machine name; both are fixed.

**Still not verified:** the private Node download (nodejs.org unreachable from the dev sandbox), `tailscale serve`, Git Credential Manager sign-in, and a real Raspberry Pi 2.

**Next steps (suggested order)**

1. Build locally (`npm run package`; on the Windows PC `npm run exe && npm run test:exe`); install on the Windows PC and the Pi.
2. KindleHub client (Lua, `docs/API.md`), once the KindleHub repo and device details are available.
3. Tags UI, Markdown preview, draggable dividers. Optional: auto-empty Trash after N days.
4. Optional: rewrite `[[links]]` when a title changes (open question 11).
