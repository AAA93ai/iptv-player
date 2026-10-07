#!/bin/bash
# Install IPTV Player on macOS as its own per-user background service (launchd).
# Fully separate from anything else on the Mac: own folder, own port, own service,
# no root, no pm2, no shared data.
#
#   bash install-macos.sh
#
# First install prints a one-time setup link: open it on your phone (over Tailscale) to choose
# the app password and enter the provider login — no secrets on any command line.
# (Non-interactive alternative: set IPTV_PASSWORD and IPTV_PROVIDER_HOST/USER/PASS.)
# Re-running upgrades the code and keeps the existing config.
# Optional: IPTV_PORT (8090), IPTV_HOST (default: this Mac's Tailscale IPv4),
#           IPTV_APP_DIR (~/iptv-player), IPTV_OUT_DIR (~/IPTV-Recordings)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${IPTV_APP_DIR:-$HOME/iptv-player}"
OUT_DIR="${IPTV_OUT_DIR:-$HOME/IPTV-Recordings}"
PORT="${IPTV_PORT:-8090}"
LABEL="local.iptv-player"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "macOS only"
[ "$(id -u)" != 0 ] || die "Do not run as root/sudo — it installs for your user only"

say "Checking Node.js"
NODE="$(command -v node || true)"
for c in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$c" ] && NODE="$c"; done
[ -n "$NODE" ] || die "Node.js not found (brew install node)"
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || die "Node 18+ required"
echo "node: $NODE ($("$NODE" -v))"

say "Checking ffmpeg"
FFMPEG="$(command -v ffmpeg || true)"
for c in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg; do [ -z "$FFMPEG" ] && [ -x "$c" ] && FFMPEG="$c"; done
if [ -z "$FFMPEG" ]; then
  BREW="$(command -v brew || true)"
  for c in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -z "$BREW" ] && [ -x "$c" ] && BREW="$c"; done
  [ -n "$BREW" ] || die "ffmpeg missing and Homebrew not found"
  "$BREW" install ffmpeg
  FFMPEG="$("$BREW" --prefix)/bin/ffmpeg"
fi
"$FFMPEG" -version | head -1

say "Finding the Tailscale address to listen on"
HOST="${IPTV_HOST:-}"
if [ -z "$HOST" ]; then
  TS="$(command -v tailscale || true)"
  [ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [ -n "$TS" ] && HOST="$("$TS" ip -4 2>/dev/null | head -1 || true)"
fi
[ -n "$HOST" ] || die "Could not detect this Mac's Tailscale IP — set IPTV_HOST=100.x.y.z"
case "$HOST" in
  100.*|127.0.0.1) ;;
  *) die "Refusing to listen on $HOST: only a Tailscale (100.x) or loopback address keeps the app off your LAN/internet" ;;
esac
echo "listen: $HOST:$PORT (reachable only over Tailscale)"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl list "$LABEL" >/dev/null 2>&1; then
  die "Port $PORT is already used by another program — set IPTV_PORT to a free port"
fi

say "Installing files to $APP_DIR"
umask 077
mkdir -p "$APP_DIR/public/vendor" "$APP_DIR/logs" "$OUT_DIR"
cp "$SRC/server.mjs" "$SRC/package.json" "$SRC/README.md" "$SRC/uninstall-macos.sh" "$APP_DIR/"
cp "$SRC/public/index.html" "$SRC/public/app.js" "$APP_DIR/public/"
cp "$SRC/public/vendor/hls.min.js" "$SRC/public/vendor/mpegts.js" "$APP_DIR/public/vendor/"
chmod 700 "$APP_DIR" "$OUT_DIR"
( cd "$APP_DIR/public/vendor" && shasum -a 256 -c - <<'SUMS'
e5753b10fc65eae35f21883e684d22c43ce66de968d35166792585b9b8a3f1a2  hls.min.js
b83dccba1525ae65763b373a85a6513f0b533359292a90083b25b29977a75f90  mpegts.js
SUMS
) || die "Bundled player libraries failed their checksum — files corrupted or tampered with"

if [ -n "${IPTV_PASSWORD:-}" ]; then
  say "Writing config (permissions 600, readable only by $(whoami))"
  IPTV_BIND="$HOST" IPTV_PORT_="$PORT" IPTV_OUT="$OUT_DIR" IPTV_FFMPEG="$FFMPEG" "$NODE" -e '
    const e = process.env;
    const o = { password: e.IPTV_PASSWORD, host: e.IPTV_BIND, port: +e.IPTV_PORT_, outDir: e.IPTV_OUT, ffmpeg: e.IPTV_FFMPEG };
    if (e.IPTV_PROVIDER_HOST) o.provider = { host: e.IPTV_PROVIDER_HOST, user: e.IPTV_PROVIDER_USER || "", pass: e.IPTV_PROVIDER_PASS || "" };
    process.stdout.write(JSON.stringify(o));' | "$NODE" "$APP_DIR/server.mjs" --init-config --config "$APP_DIR/config.json"
elif [ ! -f "$APP_DIR/config.json" ]; then
  say "Writing config in setup mode (password + provider are entered in the browser)"
  SETUP_TOKEN="$(IPTV_BIND="$HOST" IPTV_PORT_="$PORT" IPTV_OUT="$OUT_DIR" IPTV_FFMPEG="$FFMPEG" "$NODE" -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({ host: e.IPTV_BIND, port: +e.IPTV_PORT_, outDir: e.IPTV_OUT, ffmpeg: e.IPTV_FFMPEG }));' \
    | "$NODE" "$APP_DIR/server.mjs" --init-config --config "$APP_DIR/config.json" | sed -n 's/^SETUP_TOKEN=//p')"
  [ -n "$SETUP_TOKEN" ] || die "Could not create setup token"
else
  echo "Keeping existing config"
fi
chmod 600 "$APP_DIR/config.json"

say "Registering background service $LABEL"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$APP_DIR/server.mjs</string><string>--config</string><string>$APP_DIR/config.json</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$FFMPEG"):/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>5</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$APP_DIR/logs/out.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/logs/err.log</string>
</dict></plist>
PL
chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
  || launchctl bootstrap "user/$(id -u)" "$PLIST" 2>/dev/null \
  || launchctl load -w "$PLIST"

say "Health check"
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://$HOST:$PORT/login" || true)"
  { [ "$code" = 200 ] || [ "$code" = 503 ]; } && break; sleep 1
done
{ [ "$code" = 200 ] || [ "$code" = 503 ]; } || { tail -20 "$APP_DIR/logs/err.log" 2>/dev/null; die "Service did not come up (see $APP_DIR/logs/err.log)"; }
lan="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -n "$lan" ]; then
  lc="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$lan:$PORT/login" || true)"
  [ "$lc" = 000 ] && echo "LAN check: not reachable on $lan (good)" || echo "WARNING: reachable on LAN address $lan (HTTP $lc)"
fi

say "Done"
if [ -n "${SETUP_TOKEN:-}" ]; then
  echo "FINISH SETUP on your phone (Tailscale on), link works once:"
  echo "    http://$HOST:$PORT/setup?token=$SETUP_TOKEN"
fi
echo "Open on your phone (Tailscale on):  http://$HOST:$PORT"
echo "Recordings are saved in:            $OUT_DIR"
echo "Logs:                               $APP_DIR/logs/"
echo "Uninstall:                          bash $APP_DIR/uninstall-macos.sh"
