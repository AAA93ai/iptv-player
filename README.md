# IPTV Player & Downloader

Standalone app. Zero npm dependencies (player libraries are bundled).

- **Load my channels**: uses the Xtream API (`player_api.php`) — live channels plus movies (VOD) — and falls
  back to `get.php` only if the API fails. The provider login lives in the server config; the phone never sees it.
  Change it any time under **Settings**. (Series are not listed yet.)
- Browse by group, search, tap to play (HLS via hls.js / native on iPhone, MPEG-TS via mpegts.js, MP4).
- **Download / Record**: VOD files download directly; HLS and live channels are recorded with
  ffmpeg (`-c copy`, no re-encode) for a set time or until **Stop**. Files are saved on the server;
  **Save** downloads one to the phone.

## Install on a Mac (background service, starts at boot)

```
bash install-macos.sh
```
It prints a one-time setup link (`http://<mac-tailscale-ip>:8090/setup?token=…`). Open it on a phone
that is on Tailscale, choose the app password and enter the provider login there — secrets never go
through a command line. Afterwards use `http://<mac-tailscale-ip>:8090`.
Re-run without `IPTV_PASSWORD` to upgrade code and keep the config. Remove with `uninstall-macos.sh`.

## Security
| Risk | Protection |
|---|---|
| Provider (or a malicious playlist/stream) reaching your Mac, LAN, Tailscale peers, router, cloud metadata | Every outbound request is made by the server and refused if the host resolves to a private/loopback/link-local/CGNAT (Tailscale) address — checked at connect time and on every redirect (DNS-rebinding safe). Only `http(s)` URLs; `file://` etc. rejected. |
| ffmpeg being tricked into reading local files or internal hosts | ffmpeg only ever reads from this server's own relay with `-protocol_whitelist http,tcp,crypto`, so it inherits the same block. |
| Provider learning your phone's IP / tracking it | The phone talks only to the server: no CDN scripts, logos proxied, strict CSP (`connect-src 'self'`). The provider sees only the Mac's public IP (unavoidable without a VPN). |
| Provider login leaking to the phone / browser history | Credentials stay in `config.json` (mode 600). Stream URLs sent to the browser are AES-256-GCM sealed tokens. |
| Malicious content from the provider (XSS) | All names escaped; relayed responses are served with `CSP: sandbox`, `nosniff`, and HTML/JS types forced to `octet-stream`. |
| Anyone else on the network using it | Listens on the Tailscale IP only (not LAN, not internet); scrypt-hashed password, signed HttpOnly SameSite=Strict cookie, 5-attempt/15-min lockout, cross-origin POSTs refused. |
| Runs with too much privilege | Per-user launchd agent, never root; app and recordings folders mode 700. |

Residual risks: ffmpeg/hls.js parsing hostile media (keep `brew upgrade ffmpeg` current);
the provider sees the Mac's public IP and your account's viewing activity.

## Dev
`echo '{"password":"devpass123"}' | node server.mjs --init-config && node server.mjs` → http://127.0.0.1:8090
