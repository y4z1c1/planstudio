import * as projects from './projects.js';
import { t } from './i18n.js';

// Cloud sync: the passphrase never leaves the device — its SHA-256 is the
// storage key on the server (a capability token: same passphrase on any
// device = same cloud data). Push uploads project state (localStorage) and
// the GLB libraries (IndexedDB); pull overwrites local with the cloud copy.
let ctx = null;
let overlay, passInput, statusEl2, pushBtn, pullBtn;

const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:8788/api' : '/api';
const KEY_STORE = 'ps:syncKey';
const LS_EXACT = ['ps:names', 'ps:forks', 'ps:autoMeasure', 'ps:lang', 'ps:parquet'];

export function init(c) {
  ctx = c;
  overlay = document.getElementById('sync-overlay');
  passInput = document.getElementById('sync-pass');
  statusEl2 = document.getElementById('sync-status');
  pushBtn = document.getElementById('sync-push');
  pullBtn = document.getElementById('sync-pull');

  const open = () => {
    overlay.classList.add('show');
    statusEl2.textContent = '';
    if (savedKey()) passInput.placeholder = t('sync.saved');
    passInput.focus();
  };
  document.getElementById('btn-cloud').onclick = open;
  document.getElementById('btn-cloud-menu').onclick = open;
  document.getElementById('sync-close').onclick = () => overlay.classList.remove('show');
  overlay.addEventListener('click', ev => { if (ev.target === overlay) overlay.classList.remove('show'); });
  passInput.addEventListener('keydown', ev => ev.stopPropagation());

  pushBtn.onclick = () => run(push);
  pullBtn.onclick = () => run(pull);
}

function savedKey() {
  try { return localStorage.getItem(KEY_STORE); } catch { return null; }
}

async function deriveKey() {
  const pass = passInput.value.trim();
  if (!pass) {
    const k = savedKey();
    if (k) return k;
    throw new Error(t('sync.needPass'));
  }
  if (pass.length < 6) throw new Error(t('sync.shortPass'));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('planstudio:' + pass));
  const key = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(KEY_STORE, key); } catch {}
  return key;
}

async function run(fn) {
  pushBtn.disabled = pullBtn.disabled = true;
  try {
    await fn(await deriveKey());
  } catch (e) {
    statusEl2.textContent = t('sync.err', { msg: e.message || e });
  }
  pushBtn.disabled = pullBtn.disabled = false;
}

function stateSnapshot() {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if ((k.startsWith('fp:v1:') && !k.endsWith(':history')) || LS_EXACT.includes(k)) {
      ls[k] = localStorage.getItem(k);
    }
  }
  return { v: 1, ts: Date.now(), ls };
}

async function sha256hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function localBlobs() {
  const out = [];
  for (const rec of await projects.listModels().catch(() => []))
    if (rec.blob) out.push({ id: 'models:' + rec.name, blob: rec.blob });
  for (const rec of await projects.listFurnitureModels().catch(() => []))
    if (rec.blob) out.push({ id: 'furn:' + rec.name, blob: rec.blob });
  return out;
}

async function push(key) {
  statusEl2.textContent = t('sync.pushing');
  let r = await fetch(`${API}/sync/${key}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stateSnapshot()),
  });
  if (!r.ok) throw new Error(await r.text());

  const manifest = await fetch(`${API}/sync/${key}/manifest`).then(x => x.json());
  const blobs = await localBlobs();
  let sent = 0;
  for (const { id, blob } of blobs) {
    const buf = await blob.arrayBuffer();
    if (buf.byteLength > 100 * 1024 * 1024) continue;
    const sha = await sha256hex(buf);
    if (manifest.blobs?.[id]?.sha === sha) continue;   // unchanged
    statusEl2.textContent = t('sync.pushingBlob', { name: id.split(':')[1] });
    r = await fetch(`${API}/sync/${key}/blob/${encodeURIComponent(id)}`, {
      method: 'PUT', body: buf,
    });
    if (!r.ok) throw new Error(await r.text());
    sent++;
  }
  statusEl2.textContent = t('sync.pushed', { n: blobs.length, sent });
}

async function pull(key) {
  statusEl2.textContent = t('sync.pulling');
  const r = await fetch(`${API}/sync/${key}/state`);
  if (r.status === 404) throw new Error(t('sync.none'));
  if (!r.ok) throw new Error(await r.text());
  const snap = await r.json();

  const manifest = await fetch(`${API}/sync/${key}/manifest`).then(x => x.json());
  const local = new Map();
  for (const { id, blob } of await localBlobs()) local.set(id, blob);
  for (const [id, meta] of Object.entries(manifest.blobs || {})) {
    const mine = local.get(id);
    if (mine && await sha256hex(await mine.arrayBuffer()) === meta.sha) continue;
    statusEl2.textContent = t('sync.pullingBlob', { name: id.split(':')[1] });
    const br = await fetch(`${API}/sync/${key}/blob/${encodeURIComponent(id)}`);
    if (!br.ok) continue;
    const blob = new Blob([await br.arrayBuffer()]);
    const name = id.slice(id.indexOf(':') + 1);
    const rec = { name, blob, addedAt: Date.now() };
    if (id.startsWith('models:')) await projects.putModel(rec);
    else await projects.putFurnitureModel(rec);
  }

  for (const [k, v] of Object.entries(snap.ls || {})) {
    if (!(k.startsWith('fp:v1:') || LS_EXACT.includes(k))) continue;   // never accept foreign keys
    try { localStorage.setItem(k, v); } catch {}
  }
  statusEl2.textContent = t('sync.pulled');
  setTimeout(() => location.reload(), 900);
}
