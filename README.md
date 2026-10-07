# IPTV Player & Downloader

Standalone app. Zero npm dependencies.

- Load a playlist: M3U/M3U8 URL, a local `.m3u` file, or Xtream Codes login (host + user + pass).
- Browse by group, search, click to play (HLS via hls.js, raw MPEG-TS via mpegts.js, MP4 natively).
- Paste any single stream URL to play it directly.
- **Download / Record**: VOD files with a known size download directly with progress;
  HLS and live streams are recorded with ffmpeg (`-c copy`, no re-encode) to `.mp4`,
  for a fixed length or until you press **Stop**. Stopping finalises a playable file.

## Run

Requirements: Node 18+, and **ffmpeg on PATH** for HLS/live recording
(Windows: `winget install Gyan.FFmpeg`; macOS: `brew install ffmpeg`).

```
npm start                             # or: node server.mjs → http://127.0.0.1:8090, saves to ./downloads
node server.mjs --port 9000 --out D:\Recordings
```
Windows: double-click `start.bat`.

## Notes / limits
- All playback goes through the local `/proxy` endpoint (avoids CORS, rewrites HLS
  playlists, forwards `#EXTVLCOPT` User-Agent/Referer and Kodi `url|User-Agent=` headers).
  That proxy fetches arbitrary URLs, so the server binds to `127.0.0.1` by default —
  only use `--host 0.0.0.0` on a network you trust.
- DRM-protected streams (Widevine/PlayReady) cannot be played or recorded.
- Browsers can't play MKV/AVI or some audio codecs (AC-3/E-AC-3); those still download fine.
- Download list is in memory; files persist in the output folder across restarts.
- Only use playlists/content you are entitled to access.
