#!/usr/bin/env node
// IPTV Player & Downloader — standalone, zero npm dependencies. Node 18+.
// HLS / live recording needs ffmpeg on PATH.
//
//   node server.mjs [--config ./config.json]        run the server
//   node server.mjs --init-config [--config …]      create config (reads JSON from stdin)
//
// Security model (see README "Security"):
//  * Login required (scrypt-hashed password, signed HttpOnly SameSite=Strict cookie).
//  * Every outbound request is made by THIS server and refuses private/internal
//    addresses (checked at DNS-resolve time, on every redirect), so a playlist or
//    stream can never be used to reach your LAN, Tailscale peers or this machine.
//  * The browser only ever talks to this server: no CDN scripts, logos proxied,
//    provider credentials and stream URLs never leave the server.
//  * ffmpeg only ever reads from this server's own proxy (protocol-whitelisted),
//    so it inherits the same private-address block.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined; };
const CONFIG_PATH = path.resolve(arg('config') || process.env.IPTV_CONFIG || path.join(__dirname, 'config.json'));

// ------------------------------------------------------------------ config

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}

if (arg('init-config')) {
  // stdin: {"password"?: "...", "provider"?: {host,user,pass}, "host": "...", "port": n, "outDir": "...", "ffmpeg": "..."}
  // Without a password, the config gets a one-time setup token instead: the owner then sets the
  // password and provider login in the browser at /setup?token=… (secrets never touch a command line).
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.password && input.password.length < 8) { console.error('password must be at least 8 characters'); process.exit(1); }
  const prev = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const cfg = {
    ...prev,
    host: input.host || prev.host || '127.0.0.1',
    port: Number(input.port || prev.port || 8090),
    outDir: input.outDir || prev.outDir || path.join(__dirname, 'downloads'),
    secret: crypto.randomBytes(32).toString('hex'), // rotating it logs every device out
    provider: input.provider || prev.provider || null,
    ffmpeg: input.ffmpeg || prev.ffmpeg || 'ffmpeg',
  };
  if (input.password) { cfg.password = hashPassword(input.password); delete cfg.setupToken; }
  else { cfg.password = null; cfg.setupToken = crypto.randomBytes(18).toString('base64url'); }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
  console.log('Config written to ' + CONFIG_PATH);
  if (cfg.setupToken) console.log('SETUP_TOKEN=' + cfg.setupToken);
  process.exit(0);
}

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`No config at ${CONFIG_PATH}. Create one with:\n  echo '{"password":"choose-a-password"}' | node server.mjs --init-config`);
  process.exit(1);
}
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const HOST = arg('host') || CFG.host || '127.0.0.1';
const PORT = Number(arg('port') || CFG.port || 8090);
const OUT_DIR = path.resolve(arg('out') || CFG.outDir || path.join(__dirname, 'downloads'));
const SECRET = Buffer.from(CFG.secret, 'hex');
const DEFAULT_UA = CFG.userAgent || 'VLC/3.0.20 LibVLC/3.0.20';
const ALLOW_PRIVATE = process.env.IPTV_ALLOW_PRIVATE === '1'; // tests only — never set in production
const FFMPEG = CFG.ffmpeg || 'ffmpeg';
const HAS_FFMPEG = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });

// ------------------------------------------------- outbound: private-IP guard

function v4Private(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return v4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const l = ip.toLowerCase();
  let m = l.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return v4Private(m[1]);
  m = l.match(/^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) { const h = parseInt(m[1], 16), lo = parseInt(m[2], 16); return v4Private(`${h >> 8}.${h & 255}.${lo >> 8}.${lo & 255}`); }
  return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l) || l.startsWith('64:ff9b:') || l.startsWith('2002:');
}

// The check happens inside the socket's DNS lookup, so there is no gap between
// "checked" and "connected" (defeats DNS rebinding).
function guardedLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!ALLOW_PRIVATE && addrs.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error(`Blocked: ${hostname} resolves to a private/internal address`), { code: 'EBLOCKED' }));
    if (opts.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  });
}

const SAFE_HEADERS = ['user-agent', 'referer', 'origin'];
function cleanHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (SAFE_HEADERS.includes(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) out[k.toLowerCase()] = v.slice(0, 500);
  }
  return out;
}

// GET a URL from the outside world. Resolves to the IncomingMessage (with .finalUrl).
function upstream(urlStr, headers = {}, { range, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('Bad URL')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Only http(s) URLs are allowed'));
    if (u.username || u.password) return reject(new Error('URLs with embedded credentials are not allowed'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host) && !ALLOW_PRIVATE) return reject(new Error('Blocked: private/internal address'));
    const hdrs = { 'user-agent': DEFAULT_UA, accept: '*/*', ...cleanHeaders(headers) };
    if (range && /^bytes=[\d,\- ]+$/.test(range)) hdrs.range = range;
    const req = (u.protocol === 'https:' ? https : http).request(u, { headers: hdrs, lookup: guardedLookup, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(upstream(new URL(res.headers.location, u).toString(), headers, { range, redirects: redirects - 1 }));
      }
      res.finalUrl = u.toString();
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function readBuf(res, limit) {
  const chunks = []; let size = 0;
  for await (const c of res) { size += c.length; if (size > limit) { res.destroy(); throw new Error('Response too large'); } chunks.push(c); }
  return Buffer.concat(chunks);
}
const readText = async (res, limit) => (await readBuf(res, limit)).toString('utf8');

// ---------------------------------------------------------------- M3U parse

export function parseM3U(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out = []; let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      let inQ = false, idx = -1; // title = after first comma outside quotes
      for (let i = 0; i < line.length && idx < 0; i++) { if (line[i] === '"') inQ = !inQ; else if (line[i] === ',' && !inQ) idx = i; }
      cur = { name: (idx >= 0 ? line.slice(idx + 1) : '').trim() || attrs['tvg-name'] || 'Untitled', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || 'Ungrouped', headers: {} };
    } else if (line.startsWith('#EXTGRP:') && cur) {
      cur.group = line.slice(8).trim() || cur.group;
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {
      const [k, ...v] = line.slice(11).split('=');
      if (/^http-user-agent$/i.test(k)) cur.headers['user-agent'] = v.join('=');
      if (/^http-referr?er$/i.test(k)) cur.headers.referer = v.join('=');
    } else if (!line.startsWith('#')) {
      const ch = cur || { name: line.split('/').pop() || line, logo: '', group: 'Ungrouped', headers: {} };
      const [u, extra] = line.split('|');
      if (extra) for (const kv of extra.split('&')) { const [k, v] = kv.split('='); if (k && v) { try { ch.headers[k.toLowerCase()] = decodeURIComponent(v); } catch {} } }
      ch.url = u; ch.type = guessType(u); ch.headers = cleanHeaders(ch.headers);
      if (/^https?:\/\//i.test(u)) out.push(ch);
      cur = null;
    }
  }
  return out;
}

function guessType(u) {
  let p; try { p = new URL(u).pathname.toLowerCase(); } catch { p = String(u).toLowerCase(); }
  if (p.endsWith('.m3u8')) return 'hls';
  if (p.endsWith('.ts') || p.endsWith('.flv')) return 'mpegts';
  if (/\.(mp4|mkv|avi|mov|webm|m4v|mp3|aac)$/.test(p)) return 'file';
  return 'unknown';
}

// --------------------------------------------- channel store (server-side)
// Stream URLs (which contain provider credentials for Xtream) stay here; the
// browser only receives ids.

let channels = [];

function publicChannel(c) {
  return { id: c.id, name: c.name, group: c.group, type: c.type, logo: c.logo ? `/logo/${c.id}` : '' };
}
function addChannel(c) { c.id = channels.length; channels.push(c); return c; }

// ------------------------------------------------- sealed proxy URLs
// /u/<token>/s.<ext> where token = AES-256-GCM(chId|target). The browser can't read
// the real URL (Xtream URLs embed your login) and can't forge one, so the proxy only
// fetches URLs that came from a playlist/stream this server itself loaded.

const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 32);
const SEAL_KEY = crypto.createHash('sha256').update(Buffer.concat([SECRET, Buffer.from('seal')])).digest();
const SEG_EXT = /^(m3u8|ts|m4s|mp4|m4a|m4v|aac|ac3|ec3|mp3|vtt|webvtt|key|cmfv|cmfa|aes)$/;

function seal(chId, target) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', SEAL_KEY, iv);
  const enc = Buffer.concat([c.update(`${chId}|${target}`, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
function unseal(token) {
  try {
    const b = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', SEAL_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const s = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    const i = s.indexOf('|');
    return { chId: Number(s.slice(0, i)), target: s.slice(i + 1) };
  } catch { return null; }
}

function signedPath(chId, target, kind) {
  let ext = path.extname(new URL(target).pathname).slice(1).toLowerCase();
  if (!SEG_EXT.test(ext)) ext = kind === 'playlist' ? 'm3u8' : kind === 'key' ? 'key' : kind === 'init' ? 'mp4' : 'ts';
  return `/u/${seal(chId, target)}/s.${ext}`;
}

function rewriteHls(body, baseUrl, chId) {
  const abs = (u) => new URL(u, baseUrl).toString();
  let nextIsPlaylist = false;
  return body.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      if (t.startsWith('#EXT-X-STREAM-INF')) nextIsPlaylist = true;
      const kind = t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-SESSION-KEY') ? 'key' : t.startsWith('#EXT-X-MAP') ? 'init' : 'playlist';
      return line.replace(/URI="([^"]+)"/g, (_, u) => /^(data|skd):/i.test(u) ? `URI="${u}"` : `URI="${signedPath(chId, abs(u), kind)}"`);
    }
    const p = signedPath(chId, abs(t), nextIsPlaylist ? 'playlist' : 'segment');
    nextIsPlaylist = false;
    return p;
  }).join('\n');
}

// ------------------------------------------------------------------- auth

const COOKIE = 'iptv_sid';
const SESSION_DAYS = 30;
function makeSession() { const exp = Date.now() + SESSION_DAYS * 864e5; return `${exp}.${sign('session|' + exp)}`; }
function validSession(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign('session|' + exp)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
}
function tokenMatches(t) {
  if (!CFG.setupToken || typeof t !== 'string') return false;
  const a = Buffer.from(t), b = Buffer.from(CFG.setupToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPassword(pw) {
  if (!CFG.password) return false;
  const { salt, hash } = CFG.password;
  const got = crypto.scryptSync(String(pw), salt, 64), want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const failures = new Map(); // ip -> { n, until }
function locked(ip) { const f = failures.get(ip); return f && f.until > Date.now(); }
function recordFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  failures.set(ip, f);
}
// ffmpeg runs on this machine and connects to us; it is let through on signed URLs only.
const isLocal = (req) => req.socket.remoteAddress === req.socket.localAddress;

// --------------------------------------------------------------- downloads

const jobs = new Map();
const publicJob = ({ proc, abort, url, ...rest }) => rest;
const safeName = (s) => (s || 'stream').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'stream';
function uniqueFile(base) {
  let f = base, n = 1; const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  while (fs.existsSync(path.join(OUT_DIR, f))) f = `${stem} (${n++})${ext}`;
  return f;
}

async function startDownload(ch, duration) {
  const id = crypto.randomBytes(4).toString('hex');
  const job = { id, chId: ch.id, url: ch.url, name: safeName(ch.name), status: 'starting', bytes: 0, total: 0, startedAt: Date.now(), file: '', error: '', mode: '' };
  jobs.set(id, job);
  let mode = 'ffmpeg';
  if (ch.type !== 'hls') {
    try {
      const r = await upstream(ch.url, ch.headers);
      const ct = String(r.headers['content-type'] || '').toLowerCase(), len = Number(r.headers['content-length'] || 0);
      r.destroy();
      if (r.statusCode === 200 && len > 0 && !/mpegurl/.test(ct)) { mode = 'direct'; job.total = len; }
    } catch (e) { if (e.code === 'EBLOCKED') { job.status = 'error'; job.error = e.message; return job; } }
  }
  job.mode = mode;
  if (mode === 'direct') runDirect(job, ch);
  else if (!HAS_FFMPEG) { job.status = 'error'; job.error = 'ffmpeg not installed — needed for HLS/live recording'; }
  else runFfmpeg(job, ch, Number(duration) || 0);
  return job;
}

async function runDirect(job, ch) {
  let ext = path.extname(new URL(ch.url).pathname).toLowerCase();
  if (!/^\.(mp4|mkv|avi|mov|webm|m4v|mp3|aac|ts|flv)$/.test(ext)) ext = '.bin';
  job.file = uniqueFile(job.name + ext);
  job.status = 'downloading';
  let res;
  job.abort = () => { job.cancelled = true; res?.destroy(); };
  try {
    res = await upstream(ch.url, ch.headers);
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
    job.total = Number(res.headers['content-length'] || job.total || 0);
    res.on('data', (c) => { job.bytes += c.length; });
    await pipeline(res, fs.createWriteStream(path.join(OUT_DIR, job.file), { mode: 0o600 }));
    job.status = 'done';
  } catch (e) {
    job.status = job.cancelled ? 'cancelled' : 'error';
    if (!job.cancelled) job.error = String(e.message || e);
  }
  job.finishedAt = Date.now();
}

function runFfmpeg(job, ch, duration) {
  job.file = uniqueFile(job.name + '.mp4');
  const out = path.join(OUT_DIR, job.file);
  const self = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
  const input = self + signedPath(ch.id, ch.url, ch.type === 'hls' || ch.type === 'unknown' ? 'playlist' : 'segment');
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
    // ffmpeg may only speak plain HTTP to this server (+ AES for encrypted HLS) — no file://, no direct internet.
    '-protocol_whitelist', 'http,tcp,crypto',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', input, ...(duration > 0 ? ['-t', String(duration)] : []),
    '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+frag_keyframe+empty_moov', '-y', out];
  const proc = spawn(FFMPEG, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = proc; job.status = 'recording'; job.duration = duration;
  let errTail = '';
  proc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      const [k, v] = line.split('=');
      if (k === 'total_size' && Number(v) > 0) job.bytes = Number(v);
      if (k === 'out_time_us' && Number(v) > 0) job.seconds = Math.round(Number(v) / 1e6);
    }
  });
  proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  proc.on('error', (e) => { job.status = 'error'; job.error = e.message; });
  proc.on('close', (code) => {
    try { fs.chmodSync(out, 0o600); job.bytes = fs.statSync(out).size; } catch {}
    if (job.status === 'stopping') job.status = job.bytes > 0 ? 'done' : 'cancelled';
    else if (code === 0) job.status = 'done';
    else { job.status = 'error'; job.error = errTail.trim().split('\n').slice(-3).join(' ').replace(/\/u\/\S+/g, '…') || `ffmpeg exited ${code}`; }
    job.finishedAt = Date.now(); delete job.proc;
  });
}

function stopJob(job) {
  if (job.proc) { job.status = 'stopping'; job.proc.kill('SIGINT'); }
  else if (job.abort) job.abort();
}

// ----------------------------------------------------------------- server

const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; " +
  "connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' };
// Anything relayed from the provider is inert: sandboxed, never sniffed as HTML/script.
const RELAY_HEADERS = { ...BASE_HEADERS, 'Content-Security-Policy': "sandbox; default-src 'none'" };

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Body too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/vendor/hls.min.js': ['vendor/hls.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/mpegts.js': ['vendor/mpegts.js', 'text/javascript; charset=utf-8'],
};

const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IPTV Player</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:16px system-ui,sans-serif}form{display:grid;gap:12px;width:min(320px,90vw)}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #262a33;background:#171a21;color:inherit}button{background:#4f8cff;border-color:#4f8cff;color:#fff}p{color:#ff5a5f;margin:0;min-height:1.2em}</style></head>
<body><form method="post" action="/login"><h2 style="margin:0">IPTV Player</h2><input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"><button>Sign in</button><p>${msg}</p></form></body></html>`;

const SETUP_HTML = (token, msg = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IPTV Player setup</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font:16px system-ui,sans-serif}form{display:grid;gap:10px;width:min(360px,92vw);padding:16px 0}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #262a33;background:#171a21;color:inherit}button{background:#4f8cff;border-color:#4f8cff;color:#fff}h3{margin:12px 0 0;font-size:14px;color:#8b91a0;font-weight:500}p{color:#ff5a5f;margin:0;min-height:1.2em}</style></head>
<body><form method="post" action="/setup"><h2 style="margin:0">IPTV Player setup</h2>
<input type="hidden" name="token" value="${token}">
<h3>Choose the password for this app (8+ characters)</h3>
<input type="password" name="password" placeholder="New app password" autocomplete="new-password" required minlength="8">
<input type="password" name="password2" placeholder="Repeat password" autocomplete="new-password" required minlength="8">
<h3>Your IPTV provider (Xtream Codes login)</h3>
<input name="phost" placeholder="Server, e.g. http://provider.com:8080" autocomplete="off" autocapitalize="off">
<input name="puser" placeholder="Username" autocomplete="off" autocapitalize="off">
<input type="password" name="ppass" placeholder="Password" autocomplete="off">
<button>Save</button><p>${msg}</p></form></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress;
  try {
    // Cross-site requests are refused outright (CSRF / DNS-rebinding defence).
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) return send(res, 403, 'Cross-origin request refused');

    // First-run setup: only while no password exists, and only with the one-time token.
    if (u.pathname === '/setup') {
      const page = (code, t, msg) => send(res, code, SETUP_HTML(String(t).replace(/[^\w-]/g, ''), msg), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_CSP });
      if (CFG.password || !CFG.setupToken) { res.writeHead(303, { ...BASE_HEADERS, Location: '/login' }); return res.end(); }
      if (locked(ip)) return send(res, 429, 'Too many attempts — try again in 15 minutes.');
      if (req.method === 'GET') {
        const t = u.searchParams.get('token') || '';
        if (!tokenMatches(t)) { recordFailure(ip); return send(res, 403, 'Invalid setup link.'); }
        return page(200, t, '');
      }
      const f = new URLSearchParams(await readBody(req, 8192));
      const t = f.get('token') || '';
      if (!tokenMatches(t)) { recordFailure(ip); return send(res, 403, 'Invalid setup link.'); }
      const pw = f.get('password') || '';
      if (pw.length < 8) return page(400, t, 'Password must be at least 8 characters.');
      if (pw !== f.get('password2')) return page(400, t, 'Passwords do not match.');
      const phost = (f.get('phost') || '').trim().replace(/\/+$/, '');
      if (phost && !/^https?:\/\/[^\s/]+$/i.test(phost)) return page(400, t, 'Provider server must look like http://host or http://host:port');
      CFG.password = hashPassword(pw);
      if (phost) CFG.provider = { host: phost, user: (f.get('puser') || '').trim(), pass: f.get('ppass') || '' };
      delete CFG.setupToken;
      saveConfig();
      res.writeHead(303, { ...BASE_HEADERS, Location: '/', 'Set-Cookie': `${COOKIE}=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
      return res.end();
    }
    if (!CFG.password) return send(res, 503, 'Not set up yet — open the setup link printed by the installer.');

    if (u.pathname === '/login') {
      if (req.method === 'GET') return send(res, 200, LOGIN_HTML(), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_CSP });
      if (locked(ip)) return send(res, 429, LOGIN_HTML('Too many attempts — try again in 15 minutes.'), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_CSP });
      const pw = new URLSearchParams(await readBody(req, 4096)).get('password') || '';
      if (!checkPassword(pw)) { recordFailure(ip); return send(res, 401, LOGIN_HTML('Wrong password.'), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_CSP }); }
      failures.delete(ip);
      res.writeHead(303, { ...BASE_HEADERS, Location: '/', 'Set-Cookie': `${COOKIE}=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
      return res.end();
    }

    // Signed relay URLs: allowed for a logged-in browser, or for our own ffmpeg.
    const sm = u.pathname.match(/^\/u\/([\w-]+)\/s\.\w+$/);
    if (sm && req.method === 'GET') {
      if (!validSession(req) && !isLocal(req)) return send(res, 401, 'Unauthorized');
      const t = unseal(sm[1]);
      if (!t) return send(res, 403, 'Invalid link');
      const ch = channels[t.chId];
      if (!ch) return send(res, 410, 'Playlist was reloaded — pick the channel again');
      return relay(req, res, ch, t.target);
    }

    if (!validSession(req)) {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) { res.writeHead(303, { ...BASE_HEADERS, Location: '/login' }); return res.end(); }
      return send(res, 401, 'Unauthorized');
    }

    if (u.pathname === '/logout' && req.method === 'POST') {
      res.writeHead(303, { ...BASE_HEADERS, Location: '/login', 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      return res.end();
    }

    if (req.method === 'GET' && STATIC[u.pathname]) {
      const [file, type] = STATIC[u.pathname];
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Security-Policy': PAGE_CSP });
      return fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
    }

    if (u.pathname === '/api/info') return json(res, 200, { ffmpeg: HAS_FFMPEG, outDir: OUT_DIR, provider: !!CFG.provider, channels: channels.length });

    // Load a playlist. JSON {source:"provider"} | {source:"url", url} ; or text/plain body = M3U file contents.
    if (u.pathname === '/api/playlist' && req.method === 'GET') return json(res, 200, { channels: channels.map(publicChannel) });
    if (u.pathname === '/api/playlist' && req.method === 'POST') {
      const ctype = String(req.headers['content-type'] || '');
      let text, src;
      if (ctype.startsWith('application/json')) {
        const body = JSON.parse(await readBody(req, 1e5) || '{}');
        if (body.source === 'provider') {
          if (!CFG.provider) return json(res, 400, { error: 'No provider configured' });
          const p = CFG.provider;
          src = `${p.host.replace(/\/+$/, '')}/get.php?` + new URLSearchParams({ username: p.user, password: p.pass, type: 'm3u_plus', output: 'm3u8' });
        } else src = String(body.url || '');
        let r;
        try { r = await upstream(src); } catch (e) { return json(res, 502, { error: e.message }); }
        if (r.statusCode !== 200) { r.resume(); return json(res, 502, { error: `Playlist request failed: HTTP ${r.statusCode}` + (r.statusCode === 401 || r.statusCode === 403 || r.statusCode === 884 ? ' (login rejected or account blocked)' : '') }); }
        text = await readText(r, 200 * 1024 * 1024);
        if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)) {
          channels = [];
          const c = addChannel({ name: new URL(src).pathname.split('/').pop() || 'stream', url: src, logo: '', group: 'Direct', headers: {}, type: 'hls' });
          return json(res, 200, { channels: [publicChannel(c)] });
        }
      } else text = await readBody(req, 200 * 1024 * 1024);
      if (!/#EXTM3U|#EXTINF/.test(text)) return json(res, 422, { error: 'That is not an M3U playlist (wrong login, expired account, or wrong URL?)' });
      channels = [];
      for (const c of parseM3U(text)) addChannel(c);
      return json(res, 200, { channels: channels.map(publicChannel) });
    }

    if (u.pathname === '/api/direct' && req.method === 'POST') {
      const { url } = JSON.parse(await readBody(req, 1e5) || '{}');
      if (!/^https?:\/\//i.test(url || '')) return json(res, 400, { error: 'Enter an http(s) stream URL' });
      const c = addChannel({ name: new URL(url).pathname.split('/').pop() || 'stream', url, logo: '', group: 'Direct', headers: {}, type: guessType(url) });
      return json(res, 200, publicChannel(c));
    }

    const cm = u.pathname.match(/^\/api\/channel\/(\d+)$/);
    if (cm) {
      const ch = channels[Number(cm[1])];
      if (!ch) return json(res, 404, { error: 'Unknown channel — reload the playlist' });
      return json(res, 200, { ...publicChannel(ch), src: signedPath(ch.id, ch.url, ch.type === 'hls' || ch.type === 'unknown' ? 'playlist' : 'segment') });
    }

    const lm = u.pathname.match(/^\/logo\/(\d+)$/);
    if (lm) {
      const ch = channels[Number(lm[1])];
      if (!ch?.logo) return send(res, 404, '');
      try {
        const r = await upstream(ch.logo);
        const ct = String(r.headers['content-type'] || '');
        if (r.statusCode !== 200 || !/^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)/i.test(ct)) { r.resume(); return send(res, 404, ''); }
        const buf = await readBuf(r, 2 * 1024 * 1024).catch(() => null);
        if (!buf) return send(res, 404, '');
        return send(res, 200, buf, ct, { ...RELAY_HEADERS, 'Cache-Control': 'private, max-age=86400' });
      } catch { return send(res, 404, ''); }
    }

    if (u.pathname === '/api/downloads' && req.method === 'GET') return json(res, 200, { jobs: [...jobs.values()].map(publicJob).reverse() });
    if (u.pathname === '/api/downloads' && req.method === 'POST') {
      const { id, duration } = JSON.parse(await readBody(req, 1e5) || '{}');
      const ch = channels[Number(id)];
      if (!ch) return json(res, 404, { error: 'Unknown channel — reload the playlist' });
      return json(res, 200, publicJob(await startDownload(ch, duration)));
    }
    const dm = u.pathname.match(/^\/api\/downloads\/([\w-]+)$/);
    if (dm && req.method === 'DELETE') {
      const job = jobs.get(dm[1]);
      if (!job) return json(res, 404, { error: 'No such job' });
      if (['done', 'error', 'cancelled'].includes(job.status)) jobs.delete(job.id); else stopJob(job);
      return json(res, 200, { ok: true });
    }

    if (u.pathname.startsWith('/files/') && req.method === 'GET') {
      const fp = path.join(OUT_DIR, path.basename(decodeURIComponent(u.pathname.slice(7))));
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, 'Not found');
      res.writeHead(200, { ...RELAY_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(fp).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(fp))}` });
      return fs.createReadStream(fp).pipe(res);
    }

    send(res, 404, 'Not found');
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.destroy();
  }
});

async function relay(req, res, ch, target) {
  let r;
  try { r = await upstream(target, ch.headers, { range: req.headers.range }); }
  catch (e) { return send(res, e.code === 'EBLOCKED' ? 403 : 502, e.message); }
  req.on('close', () => r.destroy());
  const ct = String(r.headers['content-type'] || '').toLowerCase();
  const looksHls = /mpegurl/.test(ct) || new URL(r.finalUrl).pathname.toLowerCase().endsWith('.m3u8');
  if (r.statusCode === 200 && (looksHls || (!ct.startsWith('video/') && Number(r.headers['content-length'] || 0) < 2e6 && !/octet|mp2t|audio/.test(ct)))) {
    // Possibly a playlist: buffer (small) and check the content.
    const buf = await readBuf(r, 5 * 1024 * 1024).catch(() => null);
    if (buf === null) return send(res, 502, 'Upstream playlist too large');
    const text = buf.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (text.startsWith('#EXTM3U')) return send(res, 200, rewriteHls(buf.toString('utf8'), r.finalUrl, ch.id), 'application/vnd.apple.mpegurl', RELAY_HEADERS);
    return send(res, 200, buf, safeType(ct), RELAY_HEADERS);
  }
  const headers = { ...RELAY_HEADERS, 'Content-Type': safeType(ct) };
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (r.headers[h]) headers[h] = r.headers[h];
  res.writeHead(r.statusCode, headers);
  pipeline(r, res).catch(() => {});
}

function safeType(ct) {
  return /^(video|audio)\/|mp2t|octet-stream|mpegurl/.test(ct) ? ct : 'application/octet-stream';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  server.listen(PORT, HOST, () => {
    console.log(`IPTV Player listening on http://${HOST}:${PORT}  (downloads → ${OUT_DIR})`);
    if (!HAS_FFMPEG) console.warn('ffmpeg not found: HLS/live recording disabled.');
    if (ALLOW_PRIVATE) console.warn('WARNING: IPTV_ALLOW_PRIVATE=1 — private-address protection is OFF (testing only).');
  });
  const shutdown = () => { for (const j of jobs.values()) if (j.proc) j.proc.kill('SIGINT'); setTimeout(() => process.exit(0), 1500); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

export { server, upstream, rewriteHls };
