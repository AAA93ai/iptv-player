#!/usr/bin/env node
// IPTV Player & Downloader — standalone, zero npm dependencies.
// Plays M3U/M3U8/Xtream playlists in the browser and records/downloads streams.
// Requires Node 18+ (global fetch). HLS / live recording requires ffmpeg on PATH.
//
//   node server.mjs [--port 8090] [--host 127.0.0.1] [--out ./downloads]
//
// SECURITY: /proxy fetches any URL it is given. Keep the default 127.0.0.1 bind
// unless you trust everyone on the network you expose it to.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const PORT = Number(args.port || process.env.PORT || 8090);
const HOST = args.host || process.env.HOST || '127.0.0.1';
const OUT_DIR = path.resolve(args.out || process.env.IPTV_OUT || path.join(__dirname, 'downloads'));
const DEFAULT_UA = process.env.IPTV_UA || 'VLC/3.0.20 LibVLC/3.0.20';
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------- M3U parsing

export function parseM3U(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const channels = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      // Title is after the first comma outside quotes (titles may contain commas).
      let inQ = false, idx = -1;
      for (let i = 0; i < line.length && idx < 0; i++) {
        if (line[i] === '"') inQ = !inQ;
        else if (line[i] === ',' && !inQ) idx = i;
      }
      cur = {
        name: (idx >= 0 ? line.slice(idx + 1) : '').trim() || attrs['tvg-name'] || 'Untitled',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'Ungrouped',
        tvgId: attrs['tvg-id'] || '',
        headers: {},
      };
    } else if (line.startsWith('#EXTGRP:') && cur) {
      cur.group = line.slice(8).trim() || cur.group;
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {
      const [k, ...v] = line.slice(11).split('=');
      const val = v.join('=');
      if (/^http-user-agent$/i.test(k)) cur.headers['User-Agent'] = val;
      if (/^http-referr?er$/i.test(k)) cur.headers['Referer'] = val;
    } else if (!line.startsWith('#')) {
      const ch = cur || { name: line.split('/').pop() || line, logo: '', group: 'Ungrouped', tvgId: '', headers: {} };
      // Kodi-style "url|User-Agent=x&Referer=y"
      const [u, extra] = line.split('|');
      if (extra) for (const kv of extra.split('&')) {
        const [k, v] = kv.split('=');
        if (k && v) ch.headers[k] = decodeURIComponent(v);
      }
      ch.url = u;
      ch.type = guessType(u);
      channels.push(ch);
      cur = null;
    }
  }
  return channels;
}

function guessType(u) {
  const p = (() => { try { return new URL(u).pathname.toLowerCase(); } catch { return u.toLowerCase(); } })();
  if (p.endsWith('.m3u8')) return 'hls';
  if (p.endsWith('.ts') || p.endsWith('.flv')) return 'mpegts';
  if (/\.(mp4|mkv|avi|mov|webm|m4v|mp3|aac)$/.test(p)) return 'file';
  return 'unknown';
}

// -------------------------------------------------------------------- helpers

function upstreamHeaders(extra = {}) {
  return { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...extra };
}

function parseHeadersParam(h) {
  if (!h) return {};
  try { const o = JSON.parse(h); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 50 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

function safeName(s) {
  return (s || 'stream').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'stream';
}

function proxify(u, headers) {
  const q = new URLSearchParams({ url: u });
  if (headers && Object.keys(headers).length) q.set('h', JSON.stringify(headers));
  return '/proxy?' + q.toString();
}

// Rewrite every URI in an HLS playlist so segments/keys/sub-playlists also go via the proxy.
function rewriteHls(body, baseUrl, headers) {
  const abs = (u) => new URL(u, baseUrl).toString();
  return body.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxify(abs(u), headers)}"`);
    return proxify(abs(t), headers);
  }).join('\n');
}

// ------------------------------------------------------------------ downloads

const jobs = new Map(); // id -> job

function publicJob(j) {
  const { proc, abort, ...rest } = j;
  return rest;
}

async function startDownload({ url, name, headers = {}, duration, mode }) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');
  const id = randomUUID().slice(0, 8);
  const job = { id, url, name: safeName(name), status: 'starting', bytes: 0, total: 0, startedAt: Date.now(), file: '', error: '', mode: '' };
  jobs.set(id, job);

  // Decide: plain file download (finite, has Content-Length, not a playlist) vs ffmpeg recording.
  let chosen = mode;
  if (!chosen || chosen === 'auto') {
    chosen = 'ffmpeg';
    if (guessType(url) !== 'hls') {
      try {
        const ac = new AbortController();
        const r = await fetch(url, { headers: upstreamHeaders(headers), signal: ac.signal });
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const len = Number(r.headers.get('content-length') || 0);
        ac.abort();
        if (r.ok && len > 0 && !/mpegurl|x-mpegurl/.test(ct)) { chosen = 'direct'; job.total = len; }
      } catch { /* fall through to ffmpeg */ }
    }
  }
  job.mode = chosen;

  if (chosen === 'direct') runDirect(job, headers);
  else if (!HAS_FFMPEG) { job.status = 'error'; job.error = 'ffmpeg not found on PATH — needed for HLS/live recording'; }
  else runFfmpeg(job, headers, Number(duration) || 0);
  return job;
}

async function runDirect(job, headers) {
  const ext = path.extname(new URL(job.url).pathname) || '.bin';
  job.file = uniqueFile(job.name + ext);
  const ac = new AbortController();
  job.abort = () => ac.abort();
  job.status = 'downloading';
  try {
    const r = await fetch(job.url, { headers: upstreamHeaders(headers), signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    job.total = Number(r.headers.get('content-length') || job.total || 0);
    const body = Readable.fromWeb(r.body);
    body.on('data', (c) => { job.bytes += c.length; });
    await pipeline(body, fs.createWriteStream(path.join(OUT_DIR, job.file)));
    job.status = 'done';
  } catch (e) {
    job.status = ac.signal.aborted ? 'cancelled' : 'error';
    if (!ac.signal.aborted) job.error = String(e.message || e);
  }
  job.finishedAt = Date.now();
}

function runFfmpeg(job, headers, duration) {
  job.file = uniqueFile(job.name + '.mp4');
  const out = path.join(OUT_DIR, job.file);
  const hdrs = upstreamHeaders(headers);
  const ua = hdrs['User-Agent']; delete hdrs['User-Agent'];
  const headerStr = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
    '-user_agent', ua, ...(headerStr ? ['-headers', headerStr] : []),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', job.url, ...(duration > 0 ? ['-t', String(duration)] : []),
    '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+frag_keyframe+empty_moov', '-y', out];
  // -nostdin means we stop it with SIGINT, which ffmpeg treats as a clean finish.
  const proc = spawn('ffmpeg', a, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = proc;
  job.status = 'recording';
  job.duration = duration;
  let errTail = '';
  proc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      const [k, v] = line.split('=');
      if (k === 'total_size' && Number(v) > 0) job.bytes = Number(v);
      if (k === 'out_time_us' && Number(v) > 0) job.seconds = Math.round(Number(v) / 1e6);
    }
  });
  proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  proc.on('close', (code) => {
    try { job.bytes = fs.statSync(out).size; } catch {}
    if (job.status === 'stopping') job.status = job.bytes > 0 ? 'done' : 'cancelled';
    else if (code === 0) job.status = 'done';
    else { job.status = 'error'; job.error = errTail.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited ${code}`; }
    job.finishedAt = Date.now();
    delete job.proc;
  });
}

function uniqueFile(base) {
  let f = base, n = 1;
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  while (fs.existsSync(path.join(OUT_DIR, f))) f = `${stem} (${n++})${ext}`;
  return f;
}

function stopJob(job) {
  if (job.proc) { job.status = 'stopping'; job.proc.kill('SIGINT'); }
  else if (job.abort) job.abort();
}

// --------------------------------------------------------------------- server

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.mkv': 'video/x-matroska' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
    }

    if (u.pathname === '/api/info') return json(res, 200, { ffmpeg: HAS_FFMPEG, outDir: OUT_DIR });

    // Load playlist: GET ?url=…  or POST raw M3U text (file upload).
    if (u.pathname === '/api/playlist') {
      let text;
      if (req.method === 'POST') text = await readBody(req);
      else {
        const src = u.searchParams.get('url');
        if (!src || !/^https?:\/\//i.test(src)) return json(res, 400, { error: 'Provide an http(s) playlist URL' });
        const r = await fetch(src, { headers: upstreamHeaders() });
        if (!r.ok) return json(res, 502, { error: `Playlist fetch failed: HTTP ${r.status}` });
        text = await r.text();
        // A bare .m3u8 stream URL (not a channel list) — treat it as one channel.
        if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)) {
          return json(res, 200, { channels: [{ name: src.split('/').pop(), url: src, logo: '', group: 'Direct', tvgId: '', headers: {}, type: 'hls' }] });
        }
      }
      if (!/#EXTM3U|#EXTINF|^https?:\/\//m.test(text)) return json(res, 422, { error: 'That does not look like an M3U playlist' });
      return json(res, 200, { channels: parseM3U(text) });
    }

    // CORS-free passthrough for playback; rewrites HLS playlists.
    if (u.pathname === '/proxy') {
      const target = u.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('bad url'); }
      const headers = parseHeadersParam(u.searchParams.get('h'));
      const fwd = upstreamHeaders(headers);
      if (req.headers.range) fwd.Range = req.headers.range;
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      const r = await fetch(target, { headers: fwd, signal: ac.signal });
      const ct = r.headers.get('content-type') || '';
      const isHls = /mpegurl/i.test(ct) || new URL(r.url).pathname.toLowerCase().endsWith('.m3u8');
      if (isHls && r.ok) {
        const body = rewriteHls(await r.text(), r.url, headers);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        return res.end(body);
      }
      const out = { 'Access-Control-Allow-Origin': '*', 'Content-Type': ct || 'application/octet-stream' };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) out[h] = r.headers.get(h);
      res.writeHead(r.status, out);
      if (!r.body) return res.end();
      return pipeline(Readable.fromWeb(r.body), res).catch(() => {});
    }

    if (u.pathname === '/api/downloads' && req.method === 'GET') {
      return json(res, 200, { jobs: [...jobs.values()].map(publicJob).reverse() });
    }
    if (u.pathname === '/api/downloads' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 1e6) || '{}');
      const job = await startDownload(body);
      return json(res, 200, publicJob(job));
    }
    const m = u.pathname.match(/^\/api\/downloads\/([\w-]+)$/);
    if (m && req.method === 'DELETE') {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { error: 'no such job' });
      if (['done', 'error', 'cancelled'].includes(job.status)) jobs.delete(job.id); // clear from list
      else stopJob(job);
      return json(res, 200, { ok: true });
    }

    if (u.pathname.startsWith('/files/') && req.method === 'GET') {
      const name = decodeURIComponent(u.pathname.slice(7));
      const fp = path.join(OUT_DIR, path.basename(name));
      if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
        'Content-Length': fs.statSync(fp).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(fp))}`,
      });
      return fs.createReadStream(fp).pipe(res);
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.destroy();
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  server.listen(PORT, HOST, () => {
    console.log(`IPTV Player → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Downloads   → ${OUT_DIR}`);
    if (!HAS_FFMPEG) console.warn('⚠ ffmpeg not found: HLS/live recording disabled (direct file downloads still work).');
  });
  const shutdown = () => { for (const j of jobs.values()) if (j.proc) j.proc.kill('SIGINT'); setTimeout(() => process.exit(0), 1500); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

export { server };
