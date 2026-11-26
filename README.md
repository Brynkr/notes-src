# Notes

Plain Markdown notes in a git repo, synced through GitHub. One small server gives you an editor in a window on your desktop, and the same editor in a browser from your Raspberry Pi (phone, tablet, any computer at home).

- Notes are ordinary `.md` files. Any editor can read them, and there's no lock-in.
- Sync is automatic: commit, fetch, merge, push in the background. It never rebases, never leaves conflict markers in a note, and never throws away text. If the same lines changed in two places, you get both versions side by side.
- Search across all notes, and split the screen into up to four panes. Works offline.

![Editor](docs/screenshot.png)

## How it fits together

```
Windows / macOS / Linux ──git──┐
                               ├── GitHub (your private notes repo)
Raspberry Pi ───────────git────┘
  serves the web UI to phones and browsers on your network,
  and later KindleHub (see docs/API.md)
```

Every machine that runs the app is an ordinary git client of your notes repo. The Pi is one of them that also serves the UI to devices that can't run git.

## Requirements

- **Node.js 22.13 or newer** (24 LTS recommended): <https://nodejs.org>
- **git** on the PATH (on Windows: Git for Windows)
- A **private GitHub repo** for your notes (it can be empty), and `git push` already working from a terminal on each machine. The app uses whatever SSH key or credential helper is set up, and never asks for passwords itself.

## Build

```sh
npm install
npm run build        # produces dist/ (server.js + web/). That folder is all you need to run it.
```

## Desktop (Windows, macOS, Linux)

1. Clone your notes repo somewhere, e.g. `git clone git@github.com:YOU/notes.git ~/notes`, and check that `git push` works there.
2. Start the app once with your settings, saving them as the defaults:
   ```sh
   node dist/server.js --repo ~/notes --machine-name desktop --save --open
   ```
   On Windows use a path like `C:\Users\you\notes`.
3. It opens at <http://localhost:4747>. In Chrome or Edge use **Install app** (address bar icon, or menu → Cast, save and share → Install page as app) to get its own window and taskbar icon.
4. From then on, `node dist/server.js` is enough (or `npm start`).

Start at login (optional):

- **Windows:** press Win+R, type `shell:startup`, and add a shortcut with Target `"C:\Program Files\nodejs\node.exe" "C:\path\to\notes-app\dist\server.js"` and Run: Minimized.
- **macOS / Linux:** a login item or a user systemd unit (see the Pi section; the same file works on Linux desktops).

The server only listens on `127.0.0.1`, so nothing else on the network can reach it.

## Raspberry Pi (web UI for your home network)

Raspberry Pi OS 64-bit, Pi 3 or newer.

```sh
# 1. Node and git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

# 2. A key that can push to just your notes repo
ssh-keygen -t ed25519 -C "pi notes" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub   # GitHub → your notes repo → Settings → Deploy keys → Add, tick "Allow write access"
git clone git@github.com:YOU/notes.git ~/notes

# 3. The app: build on your desktop, then copy dist/ across (no npm needed on the Pi)
#    (on the desktop)  scp -r dist pi@raspberrypi.local:~/notes-app
node ~/notes-app/server.js set-password
node ~/notes-app/server.js --repo ~/notes --lan --machine-name pi --save

# 4. Run it as a service that starts on boot
mkdir -p ~/.config/systemd/user
cp notes-app.service ~/.config/systemd/user/     # from deploy/ in this repo
systemctl --user enable --now notes-app
sudo loginctl enable-linger "$USER"              # keep running when you're logged out
journalctl --user -u notes-app -f                # logs
```

Then open `http://raspberrypi.local:4747` (or the Pi's IP address) on your phone, sign in with the password, and use "Add to Home Screen".

Keep it on your home network. Don't forward the port to the internet; for access away from home, use a VPN such as Tailscale. The password protects against other devices on your wifi, but plain HTTP is not encrypted.

## Using it

| | |
| --- | --- |
| New note | **+** in the sidebar, or **Alt+N** |
| Search | **Ctrl/⌘+K**, arrow keys, Enter (Ctrl/⌘+Enter opens to the side) |
| Open to the side | **Ctrl/⌘+click** a note, or **Ctrl/⌘+\\** |
| Layouts | buttons at the bottom right: 1, 2 side by side, 2 stacked, 3, 4 |
| Focus pane / close pane | **Alt+1…4** / **Alt+W** |
| Save now / sync now | **Ctrl/⌘+S** / the ↻ button (both also happen automatically) |

Notes save as you type and sync about 8 seconds after you stop, every 3 minutes, when the window gets focus, and on exit.

**Conflicts:** if a note was changed in two places, the version you were editing stays in the note and the other one is saved next to it as `name (conflict 2026-11-27 laptop).md`. A banner lists these. Click one to open it beside the original, copy across what you want, then delete the copy.

## Settings

Everything can be passed as flags (`node dist/server.js --help`) and saved with `--save` to:

- Windows: `%APPDATA%\notes-app\config.json`
- macOS: `~/Library/Application Support/notes-app/config.json`
- Linux / Pi: `~/.config/notes-app/config.json`

The search index lives in the app-data folder. It's disposable and rebuilds itself if deleted. Window layout is remembered per browser.

## Development

```sh
npm run typecheck
npm test              # sync scenarios, note store, search, HTTP (real git, temp repos)
npm run test:ui       # end-to-end in headless Chrome; screenshots in tests/ui/screenshots
node scripts/build.mjs --watch
```

The design, decisions and remaining work are in [HANDOVER.md](HANDOVER.md). The HTTP API and the sync protocol for non-git clients are in [docs/API.md](docs/API.md).
