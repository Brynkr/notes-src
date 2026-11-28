#!/usr/bin/env bash
# Notes installer for macOS, Linux and Raspberry Pi (per user, no root needed
# except where noted).
#
#   ./install.sh               desktop: app launcher + background sync at login
#   ./install.sh --server      Raspberry Pi / home server: runs at boot, serves
#                              the web UI to your network (asks for a password)
#   ./install.sh --server --tailscale
#                              ...and publishes it over HTTPS on your tailnet so
#                              you can reach it away from home
#
# Your notes and settings are never touched by installing or uninstalling.

set -euo pipefail

MODE=desktop
TAILSCALE=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --server) MODE=server ;;
    --tailscale) TAILSCALE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/app"
[ -f "$SRC/server.js" ] || SRC="$(dirname "$HERE")/app"
ASSETS="$HERE/installer/assets"
[ -d "$ASSETS" ] || ASSETS="$HERE/assets"
OS="$(uname -s)"
ARCH="$(uname -m)"
PORT=4747

if [ "$OS" = "Darwin" ]; then
  PREFIX="${NOTES_APP_PREFIX:-$HOME/Library/Application Support/notes-app/program}"
else
  PREFIX="${NOTES_APP_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/notes-app/program}"
fi
BIN_DIR="$HOME/.local/bin"
WRAPPER="$BIN_DIR/notes-app"

say() { printf '  %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
ask() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '  %s [Y/n] ' "$1"
  read -r reply
  case "$reply" in ""|[Yy]*) return 0 ;; *) return 1 ;; esac
}

[ -f "$SRC/server.js" ] || die "Can't find the app files ($SRC). Extract the whole release archive first."

printf '\nInstalling Notes (%s mode)\n' "$MODE"

# --- Node.js 22.13+ -------------------------------------------------------------

node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}

NODE=""
if [ -x "$PREFIX/../node/bin/node" ] && node_ok "$PREFIX/../node/bin/node"; then
  NODE="$(cd "$PREFIX/../node/bin" && pwd)/node"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
fi

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

if [ -z "$NODE" ]; then
  case "$OS-$ARCH" in
    Linux-x86_64) NODE_ARCH=linux-x64 ;;
    Linux-aarch64|Linux-arm64) NODE_ARCH=linux-arm64 ;;
    Linux-armv7l) NODE_ARCH=linux-armv7l ;;   # Raspberry Pi 2/3 on 32-bit OS: Node 24 has no build, 22 does
    Darwin-x86_64) NODE_ARCH=darwin-x64 ;;
    Darwin-arm64) NODE_ARCH=darwin-arm64 ;;
    *) die "Node.js 22.13+ is needed and there's no automatic download for $OS $ARCH. Install it from https://nodejs.org and run this again." ;;
  esac
  ask "Node.js 22.13 or newer isn't installed. Download a private copy for Notes (about 30 MB)?" ||
    die "Install Node.js 22.13+ (https://nodejs.org), then run this again."
  BASE="https://nodejs.org/dist/latest-v22.x"
  LINE="$(download "$BASE/SHASUMS256.txt" | grep " node-v22\.[0-9.]*-$NODE_ARCH\.tar\.gz\$" | head -1)" ||
    die "Couldn't reach nodejs.org to download Node.js."
  SUM="${LINE%% *}"
  FILE="${LINE##* }"
  TMP="$(mktemp -d)"
  say "Downloading $FILE"
  download "$BASE/$FILE" > "$TMP/$FILE"
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)"; else GOT="$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)"; fi
  [ "$GOT" = "$SUM" ] || die "Checksum mismatch for $FILE; not installing it."
  mkdir -p "$PREFIX/../node"
  tar -xzf "$TMP/$FILE" -C "$PREFIX/../node" --strip-components=1
  rm -rf "$TMP"
  NODE="$(cd "$PREFIX/../node/bin" && pwd)/node"
fi
say "Node.js: $NODE ($("$NODE" --version))"

if ! command -v git >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    die "git is needed. Run: xcode-select --install   then run this again."
  fi
  die "git is needed. Install it (e.g. sudo apt install git) and run this again."
fi
say "git:     $(command -v git)"

# --- Copy the app (stopping a running copy first; it syncs before exiting) ---------

if [ -f "$PREFIX/server.js" ]; then
  "$NODE" "$PREFIX/server.js" stop >/dev/null 2>&1 || true
  # Wait until it has really exited (final sync, up to ~10 s); don't install over a copy that won't stop.
  for _ in $(seq 1 40); do
    "$NODE" "$PREFIX/server.js" running >/dev/null 2>&1 || break
    sleep 0.5
  done
  if "$NODE" "$PREFIX/server.js" running >/dev/null 2>&1; then
    die "Notes is still running and did not stop when asked. Quit it (or log out and back in), then run the installer again."
  fi
fi
mkdir -p "$PREFIX"
rm -rf "${PREFIX:?}/web" "$PREFIX/server.js" "$PREFIX/server.js.map"
cp -R "$SRC/." "$PREFIX/"
cp "$ASSETS/icon-512.png" "$PREFIX/icon.png"
cp "$HERE/uninstall.sh" "$PREFIX/uninstall.sh" 2>/dev/null || cp "$HERE/installer/uninstall.sh" "$PREFIX/uninstall.sh" 2>/dev/null || true
say "Installed to $PREFIX"

mkdir -p "$BIN_DIR"
cat > "$WRAPPER" <<EOF
#!/bin/sh
exec "$NODE" "$PREFIX/server.js" "\$@"
EOF
chmod +x "$WRAPPER"
say "Command:  $WRAPPER"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "(Add $BIN_DIR to your PATH to type 'notes-app' in a terminal.)" ;; esac

# --- Server mode: password, network access, optional Tailscale ------------------------

if [ "$MODE" = server ]; then
  if ! "$WRAPPER" has-password; then
    say "Other devices will connect to this machine, so set a password for the web UI:"
    "$WRAPPER" set-password || die "The password wasn't set. Run the installer again."
    "$WRAPPER" has-password || die "The password wasn't saved. Run the installer again."
  fi
  "$WRAPPER" configure --lan >/dev/null
  say "Listening on your home network, port $PORT."

  if command -v ssh-keygen >/dev/null 2>&1; then
    if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
      mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
      ssh-keygen -q -t ed25519 -N "" -C "notes-app@$(hostname)" -f "$HOME/.ssh/id_ed25519"
      say "Created an SSH key for GitHub (shown on the setup page)."
    fi
    # GitHub's host key, so the first sync doesn't stop at "unknown host".
    if ! grep -qs "github.com" "$HOME/.ssh/known_hosts" && command -v ssh-keyscan >/dev/null 2>&1; then
      ssh-keyscan -t ed25519 github.com 2>/dev/null >> "$HOME/.ssh/known_hosts" || true
    fi
  else
    say "ssh-keygen not found (install openssh-client to sync over SSH, or use an HTTPS URL with a token)."
  fi

  if [ "$TAILSCALE" = 1 ]; then
    command -v tailscale >/dev/null 2>&1 || die "Tailscale isn't installed. See https://tailscale.com/download, run 'sudo tailscale up', then run this again."
    TS_NAME="$(tailscale status --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})')"
    [ -n "$TS_NAME" ] || die "Tailscale isn't connected. Run 'sudo tailscale up' first."
    "$WRAPPER" configure --allow-host "$TS_NAME" >/dev/null
    if ! tailscale serve --bg "$PORT" >/dev/null 2>&1; then
      say "Tailscale needs permission to publish the app; asking with sudo:"
      sudo tailscale serve --bg "$PORT"
    fi
    say "Away from home: https://$TS_NAME/ (on any device signed in to your tailnet)"
  fi
fi

# --- Start automatically ---------------------------------------------------------------

if [ "$OS" = "Darwin" ]; then
  AGENT="$HOME/Library/LaunchAgents/nz.notes-app.server.plist"
  LOG_DIR="$HOME/Library/Logs"
  mkdir -p "$(dirname "$AGENT")" "$LOG_DIR"
  cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>nz.notes-app.server</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$PREFIX/server.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>$LOG_DIR/notes-app.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/notes-app.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$AGENT" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null; then
    say "Notes runs in the background from login (LaunchAgent)."
  else
    say "Couldn't register the login item now (no desktop session?); it will load at next login."
    "$WRAPPER" launch --no-window || true
  fi

  if [ "$MODE" = desktop ]; then
    APP="$HOME/Applications/Notes.app"
    rm -rf "$APP"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    cat > "$APP/Contents/MacOS/Notes" <<EOF
#!/bin/sh
exec "$NODE" "$PREFIX/server.js" launch
EOF
    chmod +x "$APP/Contents/MacOS/Notes"
    if command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
      SET="$(mktemp -d)/Notes.iconset"
      mkdir -p "$SET"
      for s in 16 32 128 256 512; do
        sips -z $s $s "$ASSETS/icon-512.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
        d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$ASSETS/icon-512.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
      done
      iconutil -c icns "$SET" -o "$APP/Contents/Resources/Notes.icns" || true
    fi
    cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Notes</string>
  <key>CFBundleDisplayName</key><string>Notes</string>
  <key>CFBundleIdentifier</key><string>nz.notes-app.launcher</string>
  <key>CFBundleExecutable</key><string>Notes</string>
  <key>CFBundleIconFile</key><string>Notes</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
    say "Added Notes to ~/Applications (drag it to the Dock)."
  fi
else
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/notes-app.service" <<EOF
[Unit]
Description=Notes (git-backed Markdown notes)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE $PREFIX/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now notes-app.service >/dev/null 2>&1 || systemctl --user restart notes-app.service
    systemctl --user restart notes-app.service
    say "Notes runs as a systemd user service (journalctl --user -u notes-app)."
    if [ "$MODE" = server ] && ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes; then
      say "Keeping it running after you log out, and starting at boot (needs sudo once):"
      sudo loginctl enable-linger "$USER" || say "Couldn't enable linger; run 'sudo loginctl enable-linger $USER' later."
    fi
  else
    AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
    mkdir -p "$AUTOSTART"
    cat > "$AUTOSTART/notes-app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Notes (background sync)
Exec=$WRAPPER launch --no-window
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
    "$WRAPPER" launch --no-window
    say "No systemd user session here; Notes will start at login via autostart."
  fi

  if [ "$MODE" = desktop ]; then
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$APPS"
    cat > "$APPS/notes-app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Notes
Comment=Git-backed Markdown notes
Exec=$WRAPPER launch
Icon=$PREFIX/icon.png
Terminal=false
Categories=Office;TextEditor;
EOF
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true
    say "Added Notes to your applications menu."
  fi
fi

printf '\nDone. Notes %s is installed.\n' "$("$WRAPPER" version)"
if [ "$MODE" = server ]; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  say "Open http://${IP:-$(hostname).local}:$PORT/ from a phone or computer on your network."
  say "The first visit asks where to keep the notes and for your GitHub repository URL."
elif [ "$OS" = "Darwin" ]; then
  open "$HOME/Applications/Notes.app" || true
else
  "$WRAPPER" launch >/dev/null 2>&1 || true
fi
