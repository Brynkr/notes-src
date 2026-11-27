#!/usr/bin/env bash
# Removes the Notes app for this user. Your notes folder, settings and search
# index are left in place. Tailscale serve (if you set it up) is left alone;
# stop it with: tailscale serve --https=443 off
set -uo pipefail

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  BASE="${NOTES_APP_PREFIX:-$HOME/Library/Application Support/notes-app/program}/.."
else
  BASE="${NOTES_APP_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/notes-app/program}/.."
fi
WRAPPER="$HOME/.local/bin/notes-app"

[ -x "$WRAPPER" ] && "$WRAPPER" stop >/dev/null 2>&1 && sleep 3

if [ "$OS" = "Darwin" ]; then
  AGENT="$HOME/Library/LaunchAgents/nz.notes-app.server.plist"
  launchctl bootout "gui/$(id -u)" "$AGENT" >/dev/null 2>&1 || true
  rm -f "$AGENT"
  rm -rf "$HOME/Applications/Notes.app"
else
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now notes-app.service >/dev/null 2>&1 || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/notes-app.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/notes-app.desktop"
  rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/notes-app.desktop"
fi
rm -f "$WRAPPER"
# Only the program files (and the private Node.js copy, if one was installed).
rm -rf "$BASE/program" "$BASE/node"
echo "Notes has been removed. Your notes and settings were left in place."
