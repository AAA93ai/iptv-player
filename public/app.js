const $ = (id) => document.getElementById(id);
let channels = [], current = null, hls = null, ts = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtBytes = (b) => !b ? '—' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const fmtTime = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function loadPlaylist(req) {
  $('err').textContent = ''; $('count').textContent = 'Loading… (large playlists can take a minute)';
  try {
    const d = await req();
    channels = d.channels;
    const groups = [...new Set(channels.map((c) => c.group))].sort();
    $('grp').innerHTML = '<option value="">All groups (' + groups.length + ')</option>' + groups.map((g) => `<option>${esc(g)}</option>`).join('');
    render();
  } catch (e) { $('err').textContent = e.message; $('count').textContent = 'No playlist loaded'; }
}

function render() {
  const q = $('q').value.toLowerCase(), g = $('grp').value;
  const hits = channels.filter((c) => (!g || c.group === g) && (!q || c.name.toLowerCase().includes(q)));
  const shown = hits.slice(0, 400);
  $('count').textContent = `${hits.length} of ${channels.length} channels` + (hits.length > shown.length ? ` (showing ${shown.length} — search or pick a group)` : '');
  $('list').innerHTML = shown.map((c) => {
    const img = c.logo ? `<img loading="lazy" alt="" src="${esc(c.logo)}">` : '<div class="ph">TV</div>';
    return `<div class="ch${current && current.id === c.id ? ' active' : ''}" data-id="${c.id}">${img}<div style="min-width:0"><div class="n">${esc(c.name)}</div><div class="g">${esc(c.group)}</div></div></div>`;
  }).join('');
}
// Broken logos → placeholder (CSP forbids inline handlers, so listen in capture phase).
$('list').addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.replaceWith(Object.assign(document.createElement('div'), { className: 'ph', textContent: 'TV' }));
}, true);

function stopPlayer() {
  if (hls) { hls.destroy(); hls = null; }
  if (ts) { ts.destroy(); ts = null; }
  const v = $('v'); v.onerror = null; v.removeAttribute('src'); v.load();
}

async function play(id) {
  stopPlayer(); $('err').textContent = '';
  let ch;
  try { ch = await api('/api/channel/' + id); } catch (e) { $('err').textContent = e.message; return; }
  current = ch; render();
  $('now').textContent = ch.name; $('dlBtn').disabled = false;
  const v = $('v'), src = ch.src;
  const fail = (msg) => { $('err').textContent = 'Playback failed: ' + msg + ' — you can still try Download / Record.'; };
  const type = ch.type === 'unknown' ? 'hls' : ch.type; // most extension-less IPTV URLs are HLS
  if (type === 'hls' && window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30 });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (ch.type === 'unknown' && window.mpegts && mpegts.isSupported()) { hls.destroy(); hls = null; playTs(src.replace(/s\.\w+$/, 's.ts'), fail); }
      else fail(d.details);
    });
    hls.loadSource(src); hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
  } else if (type === 'hls' && v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = src; v.play().catch(() => {}); // iPhone Safari: native HLS
  } else if (type === 'mpegts') {
    playTs(src, fail);
  } else {
    v.src = src; v.onerror = () => fail('format not supported by this browser (MKV/AVI usually are not)'); v.play().catch(() => {});
  }
}

function playTs(src, fail) {
  if (!(window.mpegts && mpegts.isSupported())) return fail('this browser cannot play raw MPEG-TS (try Download / Record)');
  ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: location.origin + src });
  ts.on(mpegts.Events.ERROR, (t, d) => fail(t + ' ' + d));
  ts.attachMediaElement($('v')); ts.load(); ts.play();
}

async function download() {
  if (!current) return;
  try { await postJson('/api/downloads', { id: current.id, duration: Number($('dur').value) }); pollJobs(); }
  catch (e) { $('err').textContent = e.message; }
}

async function pollJobs() {
  let jobs = [];
  try { ({ jobs } = await api('/api/downloads')); } catch { return; }
  $('jobs').innerHTML = jobs.length ? jobs.map((j) => {
    const active = ['starting', 'downloading', 'recording', 'stopping'].includes(j.status);
    const pct = j.total ? Math.min(100, (j.bytes / j.total) * 100) : j.duration ? Math.min(100, (j.seconds || 0) / j.duration * 100) : null;
    const detail = j.mode === 'ffmpeg' ? fmtTime(j.seconds || 0) + (j.duration ? ' / ' + fmtTime(j.duration) : ' (live)') : (pct != null ? pct.toFixed(0) + '%' : '');
    return `<tr><td>${esc(j.name)}<div class="muted">${esc(j.error || detail)}</div>${pct != null && active ? `<div class="prog"><div style="width:${pct}%"></div></div>` : ''}</td>
      <td><span class="pill ${esc(j.status)}">${esc(j.status)}</span></td><td>${fmtBytes(j.bytes)}</td>
      <td style="text-align:right">${j.status === 'done' ? `<a href="/files/${encodeURIComponent(j.file)}"><button class="ghost">Save</button></a> ` : ''}
      <button class="ghost" data-job="${esc(j.id)}">${active ? 'Stop' : 'Clear'}</button></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">No downloads yet.</td></tr>';
  clearTimeout(pollJobs.t);
  if (jobs.some((j) => !['done', 'error', 'cancelled'].includes(j.status))) pollJobs.t = setTimeout(pollJobs, 1000);
}

$('provBtn').onclick = () => loadPlaylist(() => postJson('/api/playlist', { source: 'provider' }));
$('loadBtn').onclick = () => { const url = $('plUrl').value.trim(); if (url) loadPlaylist(() => postJson('/api/playlist', { source: 'url', url })); };
$('plUrl').onkeydown = (e) => { if (e.key === 'Enter') $('loadBtn').click(); };
$('plFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) { const text = await f.text(); loadPlaylist(() => api('/api/playlist', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })); }
};
$('q').oninput = render; $('grp').onchange = render;
$('list').onclick = (e) => { const el = e.target.closest('.ch'); if (el) play(Number(el.dataset.id)); };
$('playDirect').onclick = async () => {
  const url = $('directUrl').value.trim(); if (!url) return;
  try { const c = await postJson('/api/direct', { url }); play(c.id); } catch (e) { $('err').textContent = e.message; }
};
$('dlBtn').onclick = download;
$('jobs').onclick = async (e) => {
  const id = e.target.dataset.job;
  if (id) { await api('/api/downloads/' + id, { method: 'DELETE' }).catch(() => {}); pollJobs(); }
};

api('/api/info').then((i) => {
  $('outDir').textContent = 'Saved on the server in ' + i.outDir + (i.ffmpeg ? '' : ' — ffmpeg missing: only direct file downloads work');
  if (!i.provider) $('provBtn').style.display = 'none';
  if (i.channels) loadPlaylist(() => api('/api/playlist'));
  else if (i.provider) $('provBtn').click();
}).catch(() => {});
pollJobs();
