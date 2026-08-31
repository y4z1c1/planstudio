// Main menu & project store. Dropped GLB files are saved into IndexedDB so
// projects can be reopened later; per-project state lives in localStorage
// (see persist.js). The bundled sample scan is served from the app itself.
const DB_NAME = 'planstudio';
const STORE = 'models';
const BUILTIN = [
  { file: '8_31_2026.glb', label: 'Öğrenci Evi (örnek)' },
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

// called from main.js when a GLB is dropped onto the window
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

async function render() {
  gridEl.innerHTML = '';
  for (const b of BUILTIN) {
    gridEl.appendChild(card(b.label, b.file, () => {
      ctx.loadModel(b.file, b.file, false);
      hideMenu();
    }, null));
  }
  let models = [];
  try { models = await idbList(); } catch {}
  models.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  for (const m of models) {
    gridEl.appendChild(card(m.name.replace(/\.glb$/i, ''), m.name, () => {
      openBlob(m.blob, m.name);
    }, async () => {
      if (!confirm(`"${m.name}" projesi ve tüm düzenlemeleri silinsin mi?`)) return;
      try { await idbDelete(m.name); } catch {}
      localStorage.removeItem('fp:v1:' + m.name);
      localStorage.removeItem('fp:v1:' + m.name + ':history');
      render();
    }));
  }
  // new project card
  const add = document.createElement('div');
  add.className = 'proj-card new';
  add.innerHTML = '<svg class="ico"><use href="#i-plus"/></svg><span>Yeni Proje — GLB yükle</span>';
  add.onclick = () => fileInput.click();
  gridEl.appendChild(add);
}

function card(label, modelName, onOpen, onDelete) {
  const div = document.createElement('div');
  div.className = 'proj-card';
  const meta = readMeta(modelName);
  const metaTxt = meta
    ? `<span class="m2">${meta.area.toFixed(1)} m²</span> · ${meta.rooms} oda` +
      (meta.ts ? `<br>${new Date(meta.ts).toLocaleDateString('tr-TR')} ${new Date(meta.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : '')
    : 'Henüz açılmadı';
  div.innerHTML = `<div class="p-name">${label}</div><div class="p-meta">${metaTxt}</div>`;
  div.onclick = onOpen;
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'p-del';
    del.title = 'Projeyi sil';
    del.innerHTML = '<svg class="ico" style="width:13px;height:13px"><use href="#i-x"/></svg>';
    del.onclick = ev => { ev.stopPropagation(); onDelete(); };
    div.appendChild(del);
  }
  return div;
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
