# Handover: Git-backed Markdown Notes App

Purpose of this document: give an AI coding assistant (or a human) everything needed to start building this project without re-deriving the design. Last updated 25 November 2026.

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
| Storage | Markdown files in a folder that is a git repo, hosted on GitHub |
| Sync | Via git, driven by the app. No custom server |
| Interface | Desktop GUI application (not terminal-based) |
| Layout | Left sidebar plus one editor pane by default. Optional split screen up to a 2x2 grid of four panes |
| Scope | Lightweight. Prefer fewer features done well |

## 4. Recommended defaults (not yet confirmed by the owner)

These were proposed during design discussion. Follow them unless told otherwise.

### 4.1 Stack

- **Tauri** (Rust backend, web frontend) for a small, fast cross-platform desktop app.
- **CodeMirror 6** as the editor, with Markdown language support.
- **SQLite with FTS5** for the search index (via `rusqlite`). The index is disposable and rebuilt from the files.
- **Frontend framework:** Svelte or plain TypeScript. Keep it small. Avoid heavy state libraries.
- **Git:** shell out to the system `git` binary. Do not embed libgit2 for v1.
- **File watching:** the Rust `notify` crate.

Alternatives if the owner prefers (see open questions): Python with PySide6 (Qt), or Electron.

### 4.2 Authentication

Use whatever the machine already has: SSH keys or a credential helper, configured outside the app. The app only needs the remote to be pushable. Do not build token-entry UI for v1. If push fails with an auth error, show a clear message with the git error text.

### 4.3 Note files

- One note per `.md` file, stored inside the repo (a `notes/` subfolder or the repo root, configurable).
- **Stable filenames:** `YYYYMMDD-HHMMSS-slug.md`, generated at creation. The filename never changes when the title changes, which keeps history and merges clean.
- **Title** is derived from the first Markdown H1, falling back to the first non-empty line, falling back to the filename.
- **Optional YAML front matter** for metadata that should travel with the note: `tags`, `created`. Do not require it. Preserve any front matter byte-for-byte when saving.
- Deleting a note is `git rm` plus a commit (so deletions sync).

### 4.4 What lives where

- **In the repo:** the notes, a `.gitignore`.
- **Not in the repo:** the search index, window and layout state, and app settings. These live in the OS app-data and config directories.

## 5. Open questions (ask the owner)

1. **Final stack:** Tauri (Rust plus TypeScript) versus PySide6 (Python) versus Electron. This decides the project structure and module language.
2. **Operating systems** to support first (Linux, macOS, Windows, any combination).
3. **Phone access:** wanted at all? If yes, the plan is a separate path (GitHub API or an existing git client app), not git inside this app.
4. **Notes location:** repo root or a subfolder? Is there an existing repo of notes to adopt, or start fresh?
5. **Subfolders and tags:** flat folder only for v1, or support nested folders in the sidebar?
6. **Wiki links** (`[[note title]]`) and backlinks: wanted, and in which milestone?
7. **Default branch name** and remote name (assume `main` and `origin` until told).

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

## 7. Suggested project structure (Tauri variant)

```
notes-app/
  src-tauri/
    src/
      main.rs          app setup, window, command registration
      commands.rs      tauri commands exposed to the frontend
      fs.rs            list/read/write/delete/create notes, filename generation
      watcher.rs       debounced file-change events -> frontend + index
      index.rs         SQLite FTS5: build, update, query
      git.rs           thin wrapper over the git binary (status, add, commit, fetch, merge, push, show)
      sync.rs          sync loop, policy, conflict-copy logic, state machine
      config.rs        settings load/save (repo path, remote, branch, intervals)
    Cargo.toml
  src/
    main.ts
    state/
      workspace.ts     layout preset, panes, active pane, persisted
      buffers.ts       shared document buffers keyed by note path
    ui/
      Sidebar          note list, search box, new note
      PaneGrid         CSS grid for the layout presets
      Pane             header (title, dirty dot, close) + editor
      StatusBar        sync state, last sync time, errors
    editor/
      cm.ts            CodeMirror setup, extensions, shared-state wiring
  tests/
    sync/              integration tests using temp git repos
  README.md
  HANDOVER.md          this document
```

If the owner picks PySide6 or Electron, keep the same module boundaries (fs, watcher, index, git, sync, config on one side, workspace and buffers on the other).

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
