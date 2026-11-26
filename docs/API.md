# HTTP API and sync protocol

The server that runs the web UI also exposes a small JSON API. The web UI uses it, and so can any client that can't run git: a script, a phone app, or **KindleHub**. Such clients normally talk to the Raspberry Pi, and the Pi syncs with GitHub through git.

```
Windows / macOS / Linux desktops ──git──┐
                                        ├── GitHub (notes repo)
Raspberry Pi (web UI + API) ──────git───┘
   ▲            ▲
   │ HTTP       │ HTTP
 phone       KindleHub
 browser     (offline-capable client)
```

## Basics

- Base URL: `http://<pi-address>:4747` (port configurable).
- **Auth:** when a password is set (required when listening on the network), send HTTP Basic auth on every request. The username is ignored.
- **Mutating requests** (`POST`, `PUT`, `DELETE`) must send the header `X-Notes-App: 1`. Bodies are JSON (`Content-Type: application/json`).
- **Paths** are relative to the notes folder, use `/`, end in `.md`, and can't contain `..` or hidden segments. URL-encode them in query strings.
- **Hashes** are lowercase hex SHA-256 of the file's exact bytes. They identify a version of a note.
- Errors: JSON `{ "error": "message" }` with status `400` (bad input), `401` (password), `403` (missing header), `404` (no such note), `409` (changed since you saw it), `5xx`.

## Endpoints

| Method and path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/info` | | `{ machineName, repoPath, notesDir, remote, branch, version }` |
| `GET /api/status` | | sync status (see below) |
| `GET /api/notes` | | `NoteMeta[]`, newest first |
| `GET /api/note?path=P` | | `{ path, text, hash }` |
| `PUT /api/note` | `{ path, text, baseHash }` | `{ hash, conflictCopy? }` |
| `POST /api/notes` | `{ title }` | `{ path, text, hash }` (server picks the filename) |
| `DELETE /api/note?path=P[&hash=H]` | | `{ ok: true }`, or `409` if `hash` given and the note changed |
| `GET /api/search?q=Q` | | `[{ path, title, snippet }]`; matches in `snippet` are wrapped in `\u0001`…`\u0002` |
| `POST /api/sync` | `{}` | runs a git sync now (waits for it), returns sync status |
| `GET /api/events` | | Server-Sent Events stream (see below) |

`NoteMeta`:

```json
{ "path": "20261127-091500-shopping.md", "title": "Shopping", "modifiedMs": 1795700000000,
  "tags": ["home"], "conflict": false, "hash": "3fd3…" }
```

Sync status:

```json
{ "state": "synced", "lastSyncMs": 1795700000000, "lastAttemptMs": 1795700000000,
  "message": null, "conflicts": ["x (conflict 2026-11-27 laptop).md"], "ahead": 0 }
```

`state` is one of `synced`, `syncing`, `offline`, `conflict`, `error`, `local` (no git remote) or `disabled`.

### Saving: `baseHash` is what makes this safe

`PUT /api/note` takes the hash of the version your text was based on:

- `baseHash` matches the file on disk → the file is replaced with your text.
- The file changed since (someone else saved, or a git merge brought in edits) → the server **saves the current disk version as a conflict copy**, writes your text, and returns `conflictCopy` with the copy's path. Nothing is lost; the owner merges by hand later.
- `baseHash: null` means "I think this is a new note". If the file already exists with other content, the same conflict-copy rule applies.
- The file was deleted since → it's recreated with your text (an edit wins over a delete).

Line endings: send `\n`. If the file on disk uses CRLF, the server writes CRLF.

### Events

`GET /api/events` streams `data: <json>` lines:

- `{ "type": "status", "status": {…} }`
- `{ "type": "note-changed", "path": "…", "hash": "…" }`: content on disk changed
- `{ "type": "note-deleted", "path": "…" }`
- `{ "type": "notes-changed" }`: the list changed; re-fetch `/api/notes`

Offline-first clients don't need events. Polling `/api/notes` when you sync is enough.

## Sync recipe for an offline client (KindleHub)

Keep, for each note: `path`, `text`, `baseHash` (hash of the server version the local text came from), and a `dirty` flag. Keep a list of local deletions with their `baseHash`.

Run this when the device gets wifi, and when a note is opened while online:

1. `POST /api/sync`: the Pi pulls the latest from GitHub first (optional but recommended; takes a second or two).
2. **Push local edits.** For each dirty note: `PUT /api/note { path, text, baseHash }`. Set `baseHash` to the returned `hash` and clear `dirty`. If `conflictCopy` came back, the other version now exists on the server and arrives in step 4.
3. **Push local deletions.** `DELETE /api/note?path=P&hash=baseHash`. `404` means it's already gone, which is fine. `409` means it was edited elsewhere: keep the note and fetch it in step 4.
4. **Pull.** `GET /api/notes`. For every server note whose `hash` differs from the local `baseHash` (or that isn't local yet): `GET /api/note?path=…`, store `text`, and set `baseHash = hash`. A note that's local and clean but missing from the server list was deleted elsewhere: remove it locally.
5. Optionally `POST /api/sync` again so the Pi pushes to GitHub right away. Otherwise it does that within about 8 seconds on its own.

**New notes made offline:** pick the filename yourself, `YYYYMMDD-HHMMSS-slug.md` in local time, slug lowercase `a-z0-9-` (max 50 chars, `untitled` if empty). Save with `PUT` and `baseHash: null`. Start the text with `# Title`, which the app uses as the title.

A note that is edited on the Kindle, and also somewhere else before the Kindle syncs, ends up as the Kindle's text in the note plus a conflict copy holding the other text. That matches what git sync does between desktops.
