// localStorage persistence + snapshot history, keyed per model file name.
// Schema (key "fp:v1:<modelName>"):
// { version:1,
//   roomNames: { "Floor_Bedroom_1": "Esad'ın Odası" },
//   scanEdits: { "bed_0": {pos:[x,y,z], rotY} | {deleted:true} },
//   clones:    [ {source:"bed_0", pos:[..], rotY} ],
//   doors:     [ {pos:[..], rotY, auto?, fromScan?, opening?} ],
//   furniture: [ {catalogId:"kenney:bedSingle", pos:[..], rotY} ] }
// History (key "...:history"): [{ts, data}] — every saved state, max 40;
// undo() steps back one snapshot, restore(i) jumps to any of them.
const PREFIX = 'fp:v1:';
let key = null;
let histKey = null;
let store = null;
let timer = null;

export function loadFor(modelName) {
  key = PREFIX + modelName;
  histKey = key + ':history';
  try {
    store = JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    store = {};
  }
  store.version = 1;
  store.roomNames ||= {};
  store.scanEdits ||= {};
  store.clones ||= [];
  store.doors ||= [];
  store.furniture ||= [];
  return store;
}

export function get() {
  return store || loadFor('unknown');
}

export function save() {
  if (!key) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(key, JSON.stringify(store));
      pushHistory();
    } catch {}
  }, 300);
}

// ---------- history / undo ----------
export function history() {
  try { return JSON.parse(localStorage.getItem(histKey)) || []; }
  catch { return []; }
}

function pushHistory() {
  const h = history();
  const snap = JSON.stringify(store);
  if (h.length && h[h.length - 1].data === snap) return;
  h.push({ ts: Date.now(), data: snap });
  while (h.length > 40) h.shift();
  localStorage.setItem(histKey, JSON.stringify(h));
}

// make sure the current state is in history as a baseline
export function ensureBaseline() {
  try { pushHistory(); } catch {}
}

// step back one snapshot; returns true if a reload should follow
export function undo() {
  const h = history();
  if (h.length < 2) return false;
  h.pop();
  localStorage.setItem(key, h[h.length - 1].data);
  localStorage.setItem(histKey, JSON.stringify(h));
  return true;
}

// jump to history index i (as listed by history()); truncates newer entries
export function restore(i) {
  const h = history();
  if (!h[i]) return false;
  localStorage.setItem(key, h[i].data);
  localStorage.setItem(histKey, JSON.stringify(h.slice(0, i + 1)));
  return true;
}

// short human summary of a snapshot for the history list
import { t } from './i18n.js';
export function describe(entry) {
  try {
    const d = JSON.parse(entry.data);
    const parts = [];
    const push = (key, n) => { if (n) parts.push(t(key, { n })); };
    push('history.edits', Object.keys(d.scanEdits || {}).length);
    push('history.doors', (d.doors || []).length);
    push('history.clones', (d.clones || []).length);
    push('history.furn', (d.furniture || []).length);
    push('history.names', Object.keys(d.roomNames || {}).length);
    return parts.join(' · ') || t('history.blank');
  } catch { return ''; }
}
