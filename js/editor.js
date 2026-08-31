import * as THREE from 'three';
import * as persist from './persist.js';
import { t } from './i18n.js';

// Unified selection/drag/rotate/delete/duplicate for placed objects:
// - catalog items (boxes, Kenney GLBs): userData.def / userData.catalogId
// - scan objects (Polycam Objects group):  userData.scanName
// - scan clones:                           userData.cloneSource (+userData.rec)
// Plus: hover dimension readout + right-click context menu (edit mode),
// and the click-to-place flow used by the catalog.
let ctx = null;

export const placed = [];
export let selected = null;
export const scanByName = new Map();

let dragging = null;
const dragOffset = new THREE.Vector3();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const boxA = new THREE.Box3(), boxB = new THREE.Box3();
const translatedGeos = new Set();
let onCloneSource = null;

// click-to-place state
let placing = null;          // { obj, onPlace, onCancel }

// hover state
let hoverObj = null;
let hoverHelper = null;
let hoverDimsEl = null;
let ctxMenuEl = null;

const TYPE_KEYS = [
  ['sofa_rect_l_ex', 'obj.sofaL'],
  ['sofa_rect', 'obj.sofa'],
  ['bed', 'obj.bed'],
  ['table_dining', 'obj.tableDining'],
  ['table_other', 'obj.table'],
  ['chair_swivel', 'obj.chairOffice'],
  ['chair_dining', 'obj.chair'],
  ['chair_other', 'obj.chair'],
  ['storage_cabinet_tall', 'obj.cabinetTall'],
  ['storage_cabinet_mid', 'obj.cabinet'],
  ['storage_cabinet_low', 'obj.cabinetLow'],
  ['storage_shelf', 'obj.shelf'],
  ['oven', 'obj.oven'],
  ['stove', 'obj.stove'],
  ['refrigerator', 'obj.fridge'],
  ['washer_dryer', 'obj.washer'],
  ['toilet', 'obj.toilet'],
  ['sink', 'obj.sink'],
  ['Door', 'obj.scanDoor'],
  ['Window', 'obj.window'],
];

export function objectLabel(name) {
  for (const [prefix, key] of TYPE_KEYS) {
    if (name.startsWith(prefix)) return t(key);
  }
  return name;
}

function labelOf(obj) {
  const name = obj.userData.scanName || obj.userData.cloneSource;
  return obj.userData.label || (name && objectLabel(name)) || '';
}

export function init(c) {
  ctx = c;
  hoverDimsEl = document.getElementById('hover-dims');
  ctxMenuEl = document.getElementById('ctx-menu');

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

  // right-click context menu on editable objects
  ctx.renderer.domElement.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    if (ctx.walkActive) return;
    const obj = pick(ev, true);
    hideCtxMenu();
    if (!obj) return;
    select(obj);
    showCtxMenu(ev.clientX, ev.clientY, obj);
  });
  addEventListener('pointerdown', ev => {
    if (!ctxMenuEl.contains(ev.target)) hideCtxMenu();
  }, true);
}

export function setCloneSourceHandler(fn) { onCloneSource = fn; }

export function register(obj) {
  placed.push(obj);
}

// ---------- click-to-place flow ----------
export function startPlacing(obj, { onPlace, onCancel } = {}) {
  cancelPlacing();
  placing = { obj, onPlace, onCancel };
  ctx.statusEl.textContent = t('status.placing');
  ctx.renderer.domElement.style.cursor = 'copy';
}

export function cancelPlacing() {
  if (!placing) return;
  const p = placing;
  placing = null;
  ctx.scene.remove(p.obj);
  const i = placed.indexOf(p.obj);
  if (i !== -1) placed.splice(i, 1);
  if (p.onCancel) p.onCancel(p.obj);
  ctx.renderer.domElement.style.cursor = 'default';
}

function finishPlacing() {
  const p = placing;
  placing = null;
  ctx.renderer.domElement.style.cursor = 'default';
  if (p.onPlace) p.onPlace(p.obj);
  select(p.obj);
  checkCollisions();
}

function movePlacing(ev) {
  ctx.setNDC(ev);
  floorPlane.constant = -placing.obj.position.y;
  const hit = new THREE.Vector3();
  if (ctx.raycaster.ray.intersectPlane(floorPlane, hit)) {
    placing.obj.position.x = hit.x;
    placing.obj.position.z = hit.z;
    checkCollisions();
  }
}

// ---------- scan object registration (called by semantic.js) ----------
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
  for (const grp of [sem.doorsGroup]) {
    if (!grp) continue;
    for (const node of [...grp.children]) {
      recenter(node);
      node.userData.scanName = node.name;
      scanByName.set(node.name, node);
      register(node);
    }
  }
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

function recenter(node) {
  if (node.userData.recentered) return;
  const box = new THREE.Box3().setFromObject(node);
  const pivot = box.getCenter(new THREE.Vector3());
  pivot.y = box.min.y;
  node.traverse(o => {
    if (!o.isMesh) return;
    let g = o.geometry;
    if (translatedGeos.has(g)) {
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
  if (obj.userData.catalogId && ctx.catalogDuplicate) {
    return ctx.catalogDuplicate(obj);
  }
  const sourceName = obj.userData.scanName || obj.userData.cloneSource;
  if (!sourceName) return null;
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

// spawn a scan clone into the click-to-place flow (catalog entries)
export function spawnCloneOf(sourceName) {
  const src = scanByName.get(sourceName);
  if (!src) return null;
  const cl = buildClone(src, sourceName);
  cl.position.set(ctx.controls.target.x, src.position.y, ctx.controls.target.z);
  startPlacing(cl, {
    onPlace: obj => {
      const rec = { source: sourceName, pos: obj.position.toArray(), rotY: obj.rotation.y };
      persist.get().clones.push(rec);
      obj.userData.rec = rec;
      obj.userData.recList = persist.get().clones;
      persist.save();
    },
  });
  return cl;
}

export function rotateSelected(step = Math.PI / 8) {
  if (!selected) return;
  selected.rotation.y += step;
  refreshHighlight();
  checkCollisions();
  persistChange(selected);
}

// ---------- persistence ----------
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
    return;
  }
  persist.save();
}

// ---------- picking ----------
function isPickable(obj, forceEditable) {
  if (obj.userData.def || obj.userData.catalogId) return true;
  return forceEditable || ctx.mode === 'edit';
}

function pick(ev, forceEditable = false) {
  if (!placed.length) return null;
  ctx.setNDC(ev);
  const candidates = placed.filter(o => o.visible && isPickable(o, forceEditable));
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
  if (placing) return true;      // click handled on pointerup
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
  if (placing) { movePlacing(ev); return true; }
  if (dragging) {
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
  updateHover(ev);
  return false;
}

function onPointerUp(ev) {
  if (placing) {
    if (ev._isClick) finishPlacing();
    return true;
  }
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
  if (ev.key === 'Escape') {
    if (placing) { cancelPlacing(); return true; }
    deselect();
    hideCtxMenu();
    return false;
  }
  if (!selected) return false;
  if (ev.key === 'r' || ev.key === 'R') { rotateSelected(); return true; }
  if (ev.key === 'd' || ev.key === 'D') { duplicate(selected); return true; }
  if (ev.key === 'Delete' || (ev.key === 'Backspace' && ctx.mode === 'edit') || ev.key === 'x') {
    remove(selected);
    return true;
  }
  return false;
}

// ---------- hover dimensions (edit mode) ----------
const hoverSize = new THREE.Vector3();

function updateHover(ev) {
  if (ctx.mode !== 'edit' || ctx.walkActive) { clearHover(); return; }
  const obj = pick(ev);
  if (!obj) { clearHover(); return; }
  if (obj !== hoverObj) {
    clearHover();
    hoverObj = obj;
    hoverHelper = new THREE.Box3Helper(new THREE.Box3().setFromObject(obj), 0xe8b23e);
    hoverHelper.material.depthTest = false;
    hoverHelper.material.transparent = true;
    hoverHelper.material.opacity = 0.7;
    hoverHelper.renderOrder = 999;
    ctx.scene.add(hoverHelper);
  }
  new THREE.Box3().setFromObject(obj).getSize(hoverSize);
  hoverDimsEl.innerHTML =
    `<span class="t">${labelOf(obj)}</span>` +
    `${Math.round(hoverSize.x * 100)} × ${Math.round(hoverSize.z * 100)} × ${Math.round(hoverSize.y * 100)} cm`;
  hoverDimsEl.style.display = 'block';
  hoverDimsEl.style.left = ev.clientX + 'px';
  hoverDimsEl.style.top = ev.clientY + 'px';
}

function clearHover() {
  if (hoverHelper) {
    ctx.scene.remove(hoverHelper);
    hoverHelper.geometry.dispose();
    hoverHelper.material.dispose();
    hoverHelper = null;
  }
  hoverObj = null;
  if (hoverDimsEl) hoverDimsEl.style.display = 'none';
}

// ---------- context menu ----------
function showCtxMenu(x, y, obj) {
  new THREE.Box3().setFromObject(obj).getSize(hoverSize);
  const dims = `${Math.round(hoverSize.x * 100)} × ${Math.round(hoverSize.z * 100)} × ${Math.round(hoverSize.y * 100)} cm`;
  ctxMenuEl.innerHTML = `<div class="cm-title">${labelOf(obj)} · ${dims}</div>`;
  const item = (icon, label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = 'cm-item ' + cls;
    b.innerHTML = `<svg class="ico"><use href="#${icon}"/></svg>${label}`;
    b.onclick = () => { hideCtxMenu(); fn(); };
    ctxMenuEl.appendChild(b);
  };
  item('i-rotate', t('ctx.rotate'), () => rotateSelected());
  item('i-copy', t('ctx.duplicate'), () => duplicate(obj));
  item('i-trash', t('ctx.delete'), () => remove(obj), 'danger');
  ctxMenuEl.style.display = 'block';
  const r = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  ctxMenuEl.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}

function hideCtxMenu() {
  if (ctxMenuEl) ctxMenuEl.style.display = 'none';
}

// ---------- selection ----------
let helper = null;

export function select(obj) {
  deselect();
  selected = obj;
  helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(obj), 0x4f8ef7);
  helper.material.depthTest = false;
  helper.renderOrder = 1000;
  ctx.scene.add(helper);
  const label = labelOf(obj);
  if (label) ctx.statusEl.textContent = t('status.selected', { label });
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
  clearHover();
  if (obj.userData.scanName) {
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
    m.material.color.set(m.userData.hit ? 0xe05252 : m.userData.def.color);
  });
}

// ---------- history panel ----------
function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  const h = persist.history();
  if (!h.length) {
    list.textContent = t('history.empty');
    return;
  }
  h.slice(-15).forEach((entry, idx) => {
    const i = h.length - Math.min(h.length, 15) + idx;
    const row = document.createElement('div');
    row.className = 'furn-item';
    const time = new Date(entry.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const current = i === h.length - 1 ? t('history.now') : '';
    row.innerHTML = `<span>${time}${current}</span><span class="dims">${persist.describe(entry)}</span>`;
    if (!current) {
      row.onclick = () => { if (persist.restore(i)) location.reload(); };
    }
    list.prepend(row);
  });
}
