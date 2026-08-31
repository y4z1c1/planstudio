// Main menu & project store. Dropped GLB files are saved into IndexedDB so
// projects can be reopened later; per-project state lives in localStorage
// (see persist.js). Display names are user-editable and stored separately.
import { t } from './i18n.js';

const DB_NAME = 'planstudio';
const STORE = 'models';
const NAMES_KEY = 'ps:names';
const BUILTIN = [
  { file: '8_31_2026.glb', labelKey: 'menu.sample' },
];

let ctx = null;
let menuEl, gridEl, fileInput;

export function init(c) {
  ctx = c;
  menuEl = document.getElementById('menu');
  gridEl = document.getElementById('project-grid');
  fileInput = document.getElementById('file-input');

  document.getElementById('brand').onclick = showMenu;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) importFile(f);
    fileInput.value = '';
  });

  render();
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

// ---------- rendering ----------
async function render() {
  gridEl.innerHTML = '';
  for (const b of BUILTIN) {
    gridEl.appendChild(card({
      modelName: b.file,
      label: displayName(b.file, t(b.labelKey)),
      onOpen: () => { ctx.loadModel(b.file, b.file, false); hideMenu(); },
    }));
  }
  let models = [];
  try { models = await idbList(); } catch {}
  models.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  for (const m of models) {
    gridEl.appendChild(card({
      modelName: m.name,
      label: displayName(m.name, m.name.replace(/\.glb$/i, '')),
      onOpen: () => openBlob(m.blob, m.name),
      onDelete: async () => {
        if (!confirm(t('menu.deleteConfirm', { name: displayName(m.name, m.name) }))) return;
        try { await idbDelete(m.name); } catch {}
        localStorage.removeItem('fp:v1:' + m.name);
        localStorage.removeItem('fp:v1:' + m.name + ':history');
        setName(m.name, null);
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

function card({ modelName, label, onOpen, onDelete }) {
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
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
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
