# CLAUDE.md

Git-backed Markdown notes app. TypeScript/Node server (`server/`) serving a CodeMirror web UI (`web/`), syncing a notes folder through the system git binary.

**Read `HANDOVER.md` first.** It is the source of truth: fixed decisions (section 3), defaults (4), open questions to ask the owner about (5), milestone status (12), working agreements (14) and the decision log (17). Update it when a decision is made.

## Commands

```sh
npm install
npm run build        # esbuild -> dist/server.js + dist/web/
npm run typecheck    # tsc --noEmit (TypeScript 7)
npm test             # node:test, runs .ts directly; real git against temp repos
npm run test:ui      # builds, then headless Chrome end-to-end: smoke, features, offline (set CHROME=... if not found)
npm run package      # release/*.zip + *.tar.gz with installers
node dist/server.js --repo /tmp/some-notes --no-sync --open   # try it locally
NOTES_APP_CONFIG_DIR=/tmp/c NOTES_APP_DATA_DIR=/tmp/d node dist/server.js   # fresh, unconfigured (setup screen)
```

## Rules that matter most here

- All git calls go through `server/git.ts` (`Git.run` / `Git.exclusive`). Never spawn git elsewhere.
- All note writes go through `NoteStore.write` in `server/notes.ts`. It holds the worktree lock shared with sync and does the baseHash conflict check.
- Lock order is worktree lock, then git queue. Fetch and push must not hold the worktree lock (typing must never wait on the network).
- Never run `reset --hard`, `clean`, force-push, or anything destructive against a real notes repo. Tests use temp repos only (`tests/helpers.ts` isolates git config).
- Every sync code path needs a test in `tests/sync/` before it's done. Run the UI suite after UI changes and look at the screenshots.
- The server has no runtime npm dependencies. Keep it that way unless there's a strong reason (say why).
- Source files import with `.ts` extensions and use only erasable TypeScript syntax (no enums or parameter properties), so Node can run tests directly.
- The owner's other clients (phone browser via the Pi, KindleHub later) depend on `docs/API.md`. Keep it in sync with `server/http.ts`.
- Anything tied to a notes folder belongs in `NotesRuntime` (server/runtime.ts), so Settings can swap it at runtime.
- Keep Node 22 compatibility: the owner's Raspberry Pi 2 is armv7, which has no Node 24 build.
- Installers are bash/PowerShell; `bash -n installer/install.sh` at least, and rely on CI for Windows/macOS runs.
