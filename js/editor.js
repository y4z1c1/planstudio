import * as THREE from 'three';
import * as persist from './persist.js';

// Unified selection/drag/rotate/delete/duplicate for placed objects:
// - catalog items (boxes, later Kenney GLBs): userData.def / userData.catalogId
// - scan objects (Polycam Objects group):     userData.scanName
// - scan clones:                              userData.cloneSource (+userData.rec)
// Scan objects are only pickable in 'edit' mode; catalog items are always pickable.
let ctx = null;

export const placed = [];
export let selected = null;
export const scanByName = new Map();

let dragging = null;
const dragOffset = new THREE.Vector3();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const boxA = new THREE.Box3(), boxB = new THREE.Box3();
const translatedGeos = new Set();
let onCloneSource = null;   // catalog callback: first time a source becomes clonable

// Turkish labels for Polycam object types (longest prefix wins)
const TYPE_TR = [
  ['sofa_rect_l_ex', 'L Koltuk'],
  ['sofa_rect', 'Koltuk'],
  ['bed', 'Yatak'],
  ['table_dining', 'Yemek Masası'],
  ['table_other', 'Masa'],
  ['chair_swivel', 'Ofis Sandalyesi'],
  ['chair_dining', 'Sandalye'],
  ['chair_other', 'Sandalye'],
  ['storage_cabinet_tall', 'Boy Dolabı'],
  ['storage_cabinet_mid', 'Dolap'],
  ['storage_cabinet_low', 'Alçak Dolap'],
  ['storage_shelf', 'Raf'],
  ['oven', 'Fırın'],
  ['stove', 'Ocak'],
  ['refrigerator', 'Buzdolabı'],
  ['washer_dryer', 'Çamaşır Makinesi'],
  ['toilet', 'Klozet'],
  ['sink', 'Lavabo'],
  ['Door', 'Kapı (taramadan)'],
  ['Window', 'Pencere'],
];

export function turkishObjectLabel(name) {
  for (const [prefix, tr] of TYPE_TR) {
    if (name.startsWith(prefix)) return tr;
  }
  return name;
}

export function init(c) {
  ctx = c;
  ctx.pointerHooks.down.push(onPointerDown);
  ctx.pointerHooks.move.push(onPointerMove);
  ctx.pointerHooks.up.push(onPointerUp);
  ctx.keyHooks.push(onKey);

  const btnEdit = document.getElementById('btn-edit');
  btnEdit.onclick = () => ctx.setMode('edit');
  ctx.modeUI.push({
    mode: 'edit', button: btnEdit,
    hints: [document.getElementById('hint-edit')],
  });
  const btnHist = document.getElementById('btn-history');
  const histPanel = document.getElementById('history-panel');
  btnHist.onclick = () => {
    const open = !histPanel.classList.contains('show');
    histPanel.classList.toggle('show', open);
    btnHist.classList.toggle('active', open);
    if (open) renderHistory();
  };

  document.getElementById('btn-reset-edits').onclick = () => {
    const st = persist.get();
    st.scanEdits = {};
    st.clones = [];
    st.doors = [];
    st.doorsVersion = 0;
    st.defaultsApplied = false;
    persist.save();
    setTimeout(() => location.reload(), 400);
  };
}

export function setCloneSourceHandler(fn) { onCloneSource = fn; }

function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  const h = persist.history();
  if (!h.length) {
    list.textContent = 'Henüz kayıtlı sürüm yok.';
    return;
  }
  h.slice(-15).forEach((entry, idx) => {
    const i = h.length - Math.min(h.length, 15) + idx;   // absolute index
    const row = document.createElement('div');
    row.className = 'furn-item';
    const t = new Date(entry.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const current = i === h.length - 1 ? ' (şimdiki)' : '';
    row.innerHTML = `<span>${t}${current}</span><span class="dims">${persist.describe(entry)}</span>`;
    if (!current) {
      row.title = 'Bu sürüme geri dön';
      row.onclick = () => { if (persist.restore(i)) location.reload(); };
    }
    list.prepend(row);
  });
}

export function register(obj) {
  placed.push(obj);
}

// ---------- scan object registration (called by semantic.js after detection) ----------
export function registerScanObjects(sem) {
  scanByName.clear();
  if (!sem.objectsRoot) return;
  for (const category of sem.objectsRoot.children) {
    for (const node of [...category.children]) {
      recenter(node);
      node.userData.scanName = node.name;
      scanByName.set(node.name, node);
      register(node);
    }
  }
  // scan door/window quads are editable too (some are mis-scanned cabinet covers)
  for (const grp of [sem.doorsGroup]) {
    if (!grp) continue;
    for (const node of [...grp.children]) {
      recenter(node);
      node.userData.scanName = node.name;
      scanByName.set(node.name, node);
      register(node);
    }
  }
  // restore persisted edits
  const st = persist.get();
  for (const [name, e] of Object.entries(st.scanEdits)) {
    const node = scanByName.get(name);
    if (!node) continue;
    if (e.deleted) { node.visible = false; continue; }
    if (e.pos) node.position.fromArray(e.pos);
    if (e.rotY != null) node.rotation.y = e.rotY;
  }
  for (const rec of st.clones) {
    const src = scanByName.get(rec.source);
    if (!src) continue;
    const cl = buildClone(src, rec.source);
    cl.position.fromArray(rec.pos);
    cl.rotation.y = rec.rotY || 0;
    cl.userData.rec = rec;
    cl.userData.recList = st.clones;
  }
}

// world-baked geometry → move pivot to XZ center at floor level so the node
// can be positioned/rotated like a normal object
function recenter(node) {
  if (node.userData.recentered) return;
  const box = new THREE.Box3().setFromObject(node);
  const pivot = box.getCenter(new THREE.Vector3());
  pivot.y = box.min.y;
  node.traverse(o => {
    if (!o.isMesh) return;
    let g = o.geometry;
    if (translatedGeos.has(g)) {   // shared geometry — clone before translating
      g = g.clone();
      o.geometry = g;
    }
    g.translate(-pivot.x, -pivot.y, -pivot.z);
    translatedGeos.add(g);
  });
  node.position.copy(pivot);
  node.userData.recentered = true;
}

// ---------- duplication ----------
function buildClone(src, sourceName) {
  const cl = src.clone(true);
  cl.visible = true;
  cl.userData = { cloneSource: sourceName, sharedGeo: true };
  ctx.scene.add(cl);
  register(cl);
  return cl;
}

export function duplicate(obj) {
  const sourceName = obj.userData.scanName || obj.userData.cloneSource;
  if (!sourceName) return null;   // catalog items are spawned from the catalog instead
  const src = scanByName.get(sourceName);
  if (!src) return null;
  const cl = buildClone(src, sourceName);
  cl.position.copy(obj.position);
  cl.position.x += 0.5;
  cl.position.z += 0.3;
  cl.rotation.y = obj.rotation.y;
  const rec = { source: sourceName, pos: cl.position.toArray(), rotY: cl.rotation.y };
  persist.get().clones.push(rec);
  cl.userData.rec = rec;
  cl.userData.recList = persist.get().clones;
  persist.save();
  if (onCloneSource) onCloneSource(sourceName);
  select(cl);
  return cl;
}

// spawn a clone at the camera target (catalog "Evdeki eşyalar" entries)
export function spawnCloneOf(sourceName) {
  const src = scanByName.get(sourceName);
  if (!src) return null;
  const cl = buildClone(src, sourceName);
  cl.position.set(ctx.controls.target.x, src.position.y, ctx.controls.target.z);
  const rec = { source: sourceName, pos: cl.position.toArray(), rotY: 0 };
  persist.get().clones.push(rec);
  cl.userData.rec = rec;
  cl.userData.recList = persist.get().clones;
  persist.save();
  select(cl);
  return cl;
}

// ---------- persistence of moves/rotations/deletes ----------
function persistChange(obj) {
  const st = persist.get();
  if (obj.userData.scanName) {
    st.scanEdits[obj.userData.scanName] = {
      pos: obj.position.toArray(), rotY: obj.rotation.y,
    };
  } else if (obj.userData.rec) {
    obj.userData.rec.pos = obj.position.toArray();
    obj.userData.rec.rotY = obj.rotation.y;
  } else {
    return; // catalog furniture persistence arrives with the Kenney milestone
  }
  persist.save();
}

// ---------- picking ----------
function isPickable(obj) {
  if (obj.userData.def || obj.userData.catalogId) return true;       // catalog: always
  return ctx.mode === 'edit';                                        // scan objects: edit mode only
}

function pick(ev) {
  if (!placed.length) return null;
  ctx.setNDC(ev);
  const candidates = placed.filter(o => o.visible && isPickable(o));
  if (!candidates.length) return null;
  const hits = ctx.raycaster.intersectObjects(candidates, true);
  for (const h of hits) {
    if (!h.object.visible) continue;
    let o = h.object;
    while (o && !candidates.includes(o)) o = o.parent;
    if (o) return o;
  }
  return null;
}

function onPointerDown(ev) {
  const f = pick(ev);
  if (!f) return false;
  select(f);
  dragging = f;
  ctx.controls.enabled = false;
  floorPlane.constant = -f.position.y;
  ctx.setNDC(ev);
  const hit = new THREE.Vector3();
  ctx.raycaster.ray.intersectPlane(floorPlane, hit);
  if (hit) dragOffset.copy(f.position).sub(hit);
  return true;
}

function onPointerMove(ev) {
  if (!dragging) return false;
  ctx.setNDC(ev);
  const hit = new THREE.Vector3();
  if (ctx.raycaster.ray.intersectPlane(floorPlane, hit)) {
    dragging.position.x = hit.x + dragOffset.x;
    dragging.position.z = hit.z + dragOffset.z;
    refreshHighlight();
    checkCollisions();
  }
  return true;
}

function onPointerUp(ev) {
  if (dragging) {
    persistChange(dragging);
    dragging = null;
    ctx.controls.enabled = true;
    return true;
  }
  if (ev._isClick && (!ctx.mode || ctx.mode === 'edit') && !pick(ev)) deselect();
  return false;
}

function onKey(ev) {
  if (ev.key === 'Escape') { deselect(); return false; }
  if (!selected) return false;
  if (ev.key === 'r' || ev.key === 'R') {
    selected.rotation.y += Math.PI / 8;
    refreshHighlight();
    checkCollisions();
    persistChange(selected);
    return true;
  }
  if (ev.key === 'd' || ev.key === 'D') {
    duplicate(selected);
    return true;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace' && ctx.mode === 'edit' || ev.key === 'x') {
    remove(selected);
    return true;
  }
  return false;
}

// ---------- selection highlight ----------
// Box3Helper instead of emissive tint: scan materials are shared across many
// meshes, tinting one would light them all up
let helper = null;

export function select(obj) {
  deselect();
  selected = obj;
  helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(obj), 0x4f8ef7);
  helper.material.depthTest = false;
  helper.renderOrder = 1000;
  ctx.scene.add(helper);
  const name = obj.userData.scanName || obj.userData.cloneSource;
  const label = obj.userData.label || (name && turkishObjectLabel(name));
  if (label) {
    ctx.statusEl.textContent =
      `Seçili: ${label}${name ? ` (${name})` : ''} — sürükle=taşı · R=döndür · D=kopyala · Delete=sil`;
  }
}

export function deselect() {
  if (helper) {
    ctx.scene.remove(helper);
    helper.geometry.dispose();
    helper.material.dispose();
    helper = null;
  }
  selected = null;
}

export function refreshHighlight() {
  if (helper && selected) helper.box.setFromObject(selected);
}

export function remove(obj) {
  if (obj.userData.scanName) {
    // scan originals are hidden, never disposed — reset button restores them
    obj.visible = false;
    persist.get().scanEdits[obj.userData.scanName] = { deleted: true };
    persist.save();
    if (selected === obj) deselect();
    return;
  }
  ctx.scene.remove(obj);
  const i = placed.indexOf(obj);
  if (i !== -1) placed.splice(i, 1);
  if (selected === obj) deselect();
  if (obj.userData.rec && obj.userData.recList) {
    const ri = obj.userData.recList.indexOf(obj.userData.rec);
    if (ri !== -1) obj.userData.recList.splice(ri, 1);
    persist.save();
  }
  obj.traverse(o => {
    if (o.geometry && !obj.userData.sharedGeo) o.geometry.dispose();
    if (o.isCSS2DObject && o.element.parentNode) o.element.parentNode.removeChild(o.element);
  });
  checkCollisions();
}

// overlap tint (AABB approximation) — only catalog boxes with own material opt in
export function checkCollisions() {
  const tintable = placed.filter(m => m.userData.def && m.material);
  tintable.forEach(m => { m.userData.hit = false; });
  for (let i = 0; i < tintable.length; i++) {
    boxA.setFromObject(tintable[i]);
    for (let j = i + 1; j < tintable.length; j++) {
      boxB.setFromObject(tintable[j]);
      if (boxA.intersectsBox(boxB)) {
        tintable[i].userData.hit = true;
        tintable[j].userData.hit = true;
      }
    }
  }
  tintable.forEach(m => {
    m.material.color.set(m.userData.hit ? 0xe5534b : m.userData.def.color);
  });
}
