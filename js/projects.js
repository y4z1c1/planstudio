// Main menu & project store. Dropped GLB files are saved into IndexedDB so
// projects can be reopened later; per-project state lives in localStorage
// (see persist.js). Display names are user-editable and stored separately.
import { t } from './i18n.js';

const DB_NAME = 'planstudio';
const STORE = 'models';           // house scans (projects)
const FURN_STORE = 'furnitureModels';  // user-imported furniture GLBs (incl. IKEA)
const NAMES_KEY = 'ps:names';
const BUILTIN = [
  { file: '8_31_2026.glb', labelKey: 'menu.sample' },
  { file: 'nisantasi-1p1.glb', label: 'Nişantaşı 1+1' },
];
// design-suggestion variants: same GLB, separate state, seeded from a preset
// design suggestions built from the user's own exported layout: same rooms,
// same furniture — only rearranged
const PRESETS = [
  { file: 'nisantasi-1p1.glb', state: 'nisantasi-user-a', label: 'Nişantaşı · Öneri A — Sinema hattı', preset: 'presets/nisantasi-user-a.json' },
  { file: 'nisantasi-1p1.glb', state: 'nisantasi-user-b', label: 'Nişantaşı · Öneri B — Sohbet düzeni', preset: 'presets/nisantasi-user-b.json' },
  { file: 'nisantasi-1p1.glb', state: 'nisantasi-user-c', label: 'Nişantaşı · Öneri C — Manzara düzeni', preset: 'presets/nisantasi-user-c.json' },
];
const FORKS_KEY = 'ps:forks';
function forks() {
  try { return JSON.parse(localStorage.getItem(FORKS_KEY)) || []; } catch { return []; }
}
function setForks(list) {
  try { localStorage.setItem(FORKS_KEY, JSON.stringify(list)); } catch {}
}

let ctx = null;
let menuEl, gridEl, fileInput;

export function init(c) {
  ctx = c;
  menuEl = document.getElementById('menu');
  gridEl = document.getElementById('project-grid');
  fileInput = document.getElementById('file-input');

  document.getElementById('brand').onclick = showMenu;
  document.getElementById('btn-compare').onclick = openCompare;
  document.getElementById('cmp-close').onclick = () =>
    document.getElementById('cmp-overlay').classList.remove('show');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) importFile(f);
    fileInput.value = '';
  });

  render();

  // an undo / history-restore reload marked the project to return to —
  // reopen it directly instead of landing on the menu
  let reopen = null;
  try {
    reopen = sessionStorage.getItem('ps:reopen');
    sessionStorage.removeItem('ps:reopen');
  } catch {}
  // defer past main.js module evaluation — ctx.loadModel is assigned after
  // the module init calls
  if (reopen) queueMicrotask(() => openByName(reopen));
}

async function idbGetModel(name) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).get(name);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}

// open a GLB (builtin file or IDB blob) under an arbitrary state key
async function openFileAs(file, stateKey = null) {
  hideMenu();
  let rec = null;
  try { rec = await idbGetModel(file); } catch {}
  if (rec?.blob) {
    const url = URL.createObjectURL(rec.blob);
    ctx.loadModel(url, file, true, stateKey);
  } else {
    ctx.loadModel(file, file, false, stateKey);
  }
}

// seed a preset state on first open
async function ensurePreset(state, presetUrl) {
  try {
    if (localStorage.getItem('fp:v1:' + state)) return;
    const data = await (await fetch(presetUrl)).json();
    const st = data.full || {
      version: 1, roomNames: {}, scanEdits: {}, clones: [], doors: [],
      furniture: data.furniture || [],
    };
    localStorage.setItem('fp:v1:' + state, JSON.stringify(st));
  } catch {}
}

async function openByName(name) {
  const p = PRESETS.find(x => x.state === name);
  if (p) { await ensurePreset(p.state, p.preset); return openFileAs(p.file, p.state); }
  const f = forks().find(x => x.key === name);
  if (f) return openFileAs(f.file, f.key);
  if (BUILTIN.some(b => b.file === name)) return openFileAs(name);
  const rec = await idbGetModel(name).catch(() => null);
  if (rec?.blob) { hideMenu(); openBlob(rec.blob, rec.name); }
}

export function showMenu() {
  render();
  menuEl.classList.add('show');
}

export function hideMenu() {
  menuEl.classList.remove('show');
}

export async function importFile(file) {
  try {
    await idbPut({ name: file.name, blob: file, addedAt: Date.now() });
  } catch { /* IDB unavailable — still open the file for this session */ }
  openBlob(file, file.name);
}

function openBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  ctx.loadModel(url, name, true);
  hideMenu();
}

// ---------- display names ----------
function names() {
  try { return JSON.parse(localStorage.getItem(NAMES_KEY)) || {}; }
  catch { return {}; }
}

function setName(modelName, label) {
  const n = names();
  if (label) n[modelName] = label;
  else delete n[modelName];
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(n)); } catch {}
}

function displayName(modelName, fallback) {
  return names()[modelName] || fallback;
}

// ---------- comparison ----------
async function allProjects() {
  const list = [];
  for (const b of BUILTIN) list.push({ key: b.file, label: displayName(b.file, b.labelKey ? t(b.labelKey) : b.label) });
  for (const p of PRESETS) list.push({ key: p.state, label: displayName(p.state, p.label) });
  for (const f of forks()) list.push({ key: f.key, label: displayName(f.key, f.label) });
  let models = [];
  try { models = await idbList(); } catch {}
  for (const m of models) list.push({ key: m.name, label: displayName(m.name, m.name.replace(/\.glb$/i, '')) });
  return list;
}

function stateOf(key) {
  try { return JSON.parse(localStorage.getItem('fp:v1:' + key)); } catch { return null; }
}

const cmpSelected = new Set();

async function openCompare() {
  const overlay = document.getElementById('cmp-overlay');
  const pick = document.getElementById('cmp-pick');
  pick.innerHTML = '';
  const projects = await allProjects();
  for (const p of projects) {
    const st = stateOf(p.key);
    const chip = document.createElement('div');
    chip.className = 'cmp-chip' + (st?.meta ? '' : ' disabled') + (cmpSelected.has(p.key) ? ' on' : '');
    chip.textContent = p.label + (st?.meta ? ` · ${st.meta.area.toFixed(1)} m²` : ` · ${t('cmp.notOpened')}`);
    if (st?.meta) {
      chip.onclick = () => {
        cmpSelected.has(p.key) ? cmpSelected.delete(p.key) : cmpSelected.add(p.key);
        chip.classList.toggle('on');
        renderCompareTable(projects);
      };
    }
    pick.appendChild(chip);
  }
  renderCompareTable(projects);
  overlay.classList.add('show');
}

function renderCompareTable(projects) {
  const el = document.getElementById('cmp-table');
  const sel = projects.filter(p => cmpSelected.has(p.key) && stateOf(p.key)?.meta);
  if (sel.length < 2) { el.innerHTML = ''; return; }
  const states = sel.map(p => ({ p, st: stateOf(p.key) }));
  // union of room names, ordered by biggest area anywhere
  const roomNames = [];
  for (const { st } of states) {
    for (const r of st.meta.roomList || []) {
      if (!roomNames.includes(r.name)) roomNames.push(r.name);
    }
  }
  const areaOf = (st, name) => (st.meta.roomList || []).find(r => r.name === name)?.area;
  roomNames.sort((a, b) =>
    Math.max(...states.map(({ st }) => areaOf(st, b) || 0)) -
    Math.max(...states.map(({ st }) => areaOf(st, a) || 0)));

  const cell = (vals, i, fmt) => {
    const v = vals[i];
    if (v == null) return '<td>—</td>';
    const best = v === Math.max(...vals.filter(x => x != null));
    return `<td class="${best && vals.filter(x => x != null).length > 1 ? 'best' : ''}">${fmt(v)}</td>`;
  };
  const m2 = v => v.toFixed(1) + ' m²';
  let html = '<table><tr><th></th>' + states.map(({ p }) => `<th>${p.label}</th>`).join('') + '</tr>';
  for (const name of roomNames) {
    const vals = states.map(({ st }) => areaOf(st, name) ?? null);
    html += `<tr><td>${name}</td>` + states.map((_, i) => cell(vals, i, m2)).join('') + '</tr>';
  }
  {
    const vals = states.map(({ st }) => st.meta.rooms);
    html += `<tr><td>${t('cmp.roomCount')}</td>` + states.map((_, i) => cell(vals, i, v => v)).join('') + '</tr>';
  }
  {
    const vals = states.map(({ st }) => (st.furniture?.length || 0) + (st.clones?.length || 0));
    html += `<tr><td>${t('cmp.furniture')}</td>` + states.map((_, i) => cell(vals, i, v => v)).join('') + '</tr>';
  }
  {
    const vals = states.map(({ st }) => st.meta.area);
    html += `<tr class="total"><td>${t('cmp.total')}</td>` + states.map((_, i) => cell(vals, i, m2)).join('') + '</tr>';
  }
  el.innerHTML = html + '</table>';
}

// ---------- fork ----------
function forkProject(stateKey, file, label) {
  const key = 'fork-' + Date.now().toString(36);
  try {
    const src = localStorage.getItem('fp:v1:' + stateKey);
    if (src) localStorage.setItem('fp:v1:' + key, src);
  } catch {}
  setForks([...forks(), { key, file, label: label + ' (fork)' }]);
  render();
}

function stateDelete(stateKey) {
  localStorage.removeItem('fp:v1:' + stateKey);
  localStorage.removeItem('fp:v1:' + stateKey + ':history');
  setName(stateKey, null);
}

// ---------- rendering ----------
async function render() {
  gridEl.innerHTML = '';
  for (const b of BUILTIN) {
    const label = displayName(b.file, b.labelKey ? t(b.labelKey) : b.label);
    gridEl.appendChild(card({
      modelName: b.file,
      label,
      onOpen: () => openFileAs(b.file),
      onFork: () => forkProject(b.file, b.file, label),
    }));
  }
  for (const p of PRESETS) {
    const label = displayName(p.state, p.label);
    gridEl.appendChild(card({
      modelName: p.state,
      label,
      onOpen: async () => { await ensurePreset(p.state, p.preset); openFileAs(p.file, p.state); },
      onFork: () => forkProject(p.state, p.file, label),
      onDelete: async () => {
        if (!confirm(t('menu.deleteConfirm', { name: label }))) return;
        stateDelete(p.state);   // resets the suggestion to its preset
        render();
      },
    }));
  }
  for (const f of forks()) {
    const label = displayName(f.key, f.label);
    gridEl.appendChild(card({
      modelName: f.key,
      label,
      onOpen: () => openFileAs(f.file, f.key),
      onFork: () => forkProject(f.key, f.file, label),
      onDelete: async () => {
        if (!confirm(t('menu.deleteConfirm', { name: label }))) return;
        stateDelete(f.key);
        setForks(forks().filter(x => x.key !== f.key));
        render();
      },
    }));
  }
  let models = [];
  try { models = await idbList(); } catch {}
  models.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  for (const m of models) {
    const label = displayName(m.name, m.name.replace(/\.glb$/i, ''));
    gridEl.appendChild(card({
      modelName: m.name,
      label,
      onOpen: () => openBlob(m.blob, m.name),
      onFork: () => forkProject(m.name, m.name, label),
      onDelete: async () => {
        if (!confirm(t('menu.deleteConfirm', { name: label }))) return;
        try { await idbDelete(m.name); } catch {}
        stateDelete(m.name);
        render();
      },
    }));
  }
  const add = document.createElement('div');
  add.className = 'proj-card new';
  add.innerHTML = `<svg class="ico"><use href="#i-plus"/></svg><span>${t('menu.new')}</span>`;
  add.onclick = () => fileInput.click();
  gridEl.appendChild(add);
}

function card({ modelName, label, onOpen, onDelete, onFork }) {
  const div = document.createElement('div');
  div.className = 'proj-card';
  const meta = readMeta(modelName);
  const metaTxt = meta
    ? `<span class="m2">${meta.area.toFixed(1)} m²</span> · ${t('menu.rooms', { n: meta.rooms })}` +
      (meta.ts ? `<br>${new Date(meta.ts).toLocaleDateString()} ${new Date(meta.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '')
    : t('menu.neverOpened');
  const nameEl = document.createElement('div');
  nameEl.className = 'p-name';
  nameEl.textContent = label;
  const metaEl = document.createElement('div');
  metaEl.className = 'p-meta';
  metaEl.innerHTML = metaTxt;
  div.append(nameEl, metaEl);
  div.onclick = onOpen;

  const actions = document.createElement('div');
  actions.className = 'p-actions';
  const renameBtn = document.createElement('button');
  renameBtn.title = t('menu.rename');
  renameBtn.innerHTML = '<svg class="ico" style="width:13px;height:13px"><use href="#i-pencil"/></svg>';
  renameBtn.onclick = ev => {
    ev.stopPropagation();
    startRename(nameEl, modelName, label);
  };
  actions.appendChild(renameBtn);
  {
    const expBtn = document.createElement('button');
    expBtn.title = t('menu.export');
    expBtn.innerHTML = '<svg class="ico" style="width:13px;height:13px"><use href="#i-download"/></svg>';
    expBtn.onclick = ev => {
      ev.stopPropagation();
      const st = stateOf(modelName);
      if (!st) { alert(t('cmp.notOpened')); return; }
      const blob = new Blob([JSON.stringify({ planstudio: 1, state: modelName, label, data: st }, null, 1)],
        { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = label.replace(/[^\w\dğüşöçıİĞÜŞÖÇ -]+/g, '') + '.planstudio.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    actions.appendChild(expBtn);
  }
  if (onFork) {
    const forkBtn = document.createElement('button');
    forkBtn.title = t('menu.fork');
    forkBtn.innerHTML = '<svg class="ico" style="width:13px;height:13px"><use href="#i-copy"/></svg>';
    forkBtn.onclick = ev => { ev.stopPropagation(); onFork(); };
    actions.appendChild(forkBtn);
  }
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'p-del';
    del.title = t('menu.delete');
    del.innerHTML = '<svg class="ico" style="width:13px;height:13px"><use href="#i-x"/></svg>';
    del.onclick = ev => { ev.stopPropagation(); onDelete(); };
    actions.appendChild(del);
  }
  div.appendChild(actions);
  return div;
}

function startRename(nameEl, modelName, current) {
  const input = document.createElement('input');
  input.value = current;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  input.onclick = ev => ev.stopPropagation();
  const commit = () => {
    setName(modelName, input.value.trim());
    render();
  };
  input.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit();
    if (ev.key === 'Escape') render();
  };
  input.onblur = commit;
}

function readMeta(modelName) {
  try {
    const st = JSON.parse(localStorage.getItem('fp:v1:' + modelName));
    return st?.meta || null;
  } catch { return null; }
}

// ---------- IndexedDB ----------
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(FURN_STORE)) db.createObjectStore(FURN_STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

// ---------- user furniture model store (used by catalog.js) ----------
export async function putFurnitureModel(rec) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(FURN_STORE, 'readwrite');
    tx.objectStore(FURN_STORE).put(rec);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
export async function listFurnitureModels() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(FURN_STORE).objectStore(FURN_STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
export async function getFurnitureModel(name) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(FURN_STORE).objectStore(FURN_STORE).get(name);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => rej(req.error);
  });
}
export async function deleteFurnitureModel(name) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(FURN_STORE, 'readwrite');
    tx.objectStore(FURN_STORE).delete(name);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbPut(rec) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbList() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
async function idbDelete(name) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(name);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
