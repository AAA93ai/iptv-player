#!/bin/bash
# Stop and remove the IPTV Player service. Keeps recordings unless you pass --purge.
set -uo pipefail
LABEL="local.iptv-player"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_DIR="${IPTV_APP_DIR:-$HOME/iptv-player}"
OUT_DIR="${IPTV_OUT_DIR:-$HOME/IPTV-Recordings}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$APP_DIR"
if [ "${1:-}" = "--purge" ]; then rm -rf "$OUT_DIR"; echo "Removed recordings too."; else echo "Recordings kept in $OUT_DIR"; fi
echo "IPTV Player removed."
