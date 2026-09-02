import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as persist from './persist.js';
import { t } from './i18n.js';
import { makeTextLabel } from './utils.js';

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

// ---------- soft wall handling for moving/placing objects ----------
// "Sticky, not blocking": the object follows the cursor/crosshair freely, but
// if its footprint would overlap a wall or closed door, it is pushed out just
// enough to sit flush against it. It can never get wedged behind a wall.
const blockRay = new THREE.Raycaster();
const _bSize = new THREE.Vector3();
const _pushDir = new THREE.Vector3();

function blockers(self) {
  const list = [];
  const walls = ctx.getWalls?.();
  if (walls) list.push(walls);
  else if (ctx.model) list.push(ctx.model);
  if (ctx.getDoorBlockers) {
    for (const d of ctx.getDoorBlockers()) {
      if (d !== self && d.parent && !d.userData.open) list.push(d);
    }
  }
  return list;
}

function constrainXZ(obj, tx, tz) {
  new THREE.Box3().setFromObject(obj).getSize(_bSize);
  const midY = obj.position.y + _bSize.y * 0.5;
  const targets = blockers(obj);
  let px = tx, pz = tz;

  // probe the four footprint half-extents from the target center; any wall
  // closer than the half-extent pushes the object back by the overlap
  const probes = [
    [1, 0, _bSize.x / 2], [-1, 0, _bSize.x / 2],
    [0, 1, _bSize.z / 2], [0, -1, _bSize.z / 2],
  ];
  for (const [dx, dz, half] of probes) {
    blockRay.set(new THREE.Vector3(px, midY, pz), _pushDir.set(dx, 0, dz));
    blockRay.near = 0;
    blockRay.far = half;
    for (const h of blockRay.intersectObjects(targets, true)) {
      if (!h.object.visible) continue;
      let o = h.object, own = false;
      while (o) { if (o === obj) { own = true; break; } o = o.parent; }
      if (own) continue;
      const push = half - h.distance;
      px -= dx * push;
      pz -= dz * push;
      break;
    }
  }
  obj.position.x = px;
  obj.position.z = pz;
}

// ---------- surface-aware placement ----------
// Raycast under the cursor/crosshair: an upward face (table top, cabinet,
// floor) seats the object on it; a vertical face mounts wall-mountable
// objects (TVs) onto the wall. Returns false when the old floor-plane path
// should handle the move instead.
const _sn = new THREE.Vector3();
const _sSize = new THREE.Vector3();

function placeAt(obj) {
  const targets = [];
  if (ctx.model) targets.push(ctx.model);
  for (const o of placed) {
    if (o !== obj && o.visible && o.parent) targets.push(o);
  }
  const hits = ctx.raycaster.intersectObjects(targets, true);
  for (const h of hits) {
    if (!h.object.visible || !h.face) continue;
    let p = h.object, own = false;
    while (p) { if (p === obj) { own = true; break; } p = p.parent; }
    if (own) continue;
    _sn.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (_sn.y > 0.5) {
      // seat on top of the surface under the cursor
      obj.position.y = h.point.y;
      constrainXZ(obj, h.point.x, h.point.z);
      return true;
    }
    if (Math.abs(_sn.y) < 0.3 && obj.userData.wallMount) {
      // mount on the wall, centered at the aim point
      if (_sn.dot(ctx.raycaster.ray.direction) > 0) _sn.negate();
      obj.rotation.y = Math.atan2(_sn.x, _sn.z);
      new THREE.Box3().setFromObject(obj).getSize(_sSize);
      const halfD = (Math.abs(_sn.x) * _sSize.x + Math.abs(_sn.z) * _sSize.z) / 2;
      const minY = (ctx.modelBox ? ctx.modelBox.min.y : 0) + 0.05;
      obj.position.set(
        h.point.x + _sn.x * (halfD + 0.005),
        Math.max(minY, h.point.y - _sSize.y / 2),
        h.point.z + _sn.z * (halfD + 0.005),
      );
      return true;
    }
    return false;   // hit something unusable first (e.g. wall for a sofa)
  }
  return false;
}

// ---------- gravity ----------
// Drop the object onto the highest support surface below its footprint
// (floor, table top, another object). Wall-mounted items are exempt.
const _gRay = new THREE.Raycaster();
const _gBox = new THREE.Box3();

export function settle(obj) {
  if (obj.userData.wallMount) return;
  _gBox.setFromObject(obj);
  const size = _gBox.getSize(new THREE.Vector3());
  const cx = (_gBox.min.x + _gBox.max.x) / 2;
  const cz = (_gBox.min.z + _gBox.max.z) / 2;
  const originY = _gBox.min.y + 0.03;
  const targets = [];
  if (ctx.model) targets.push(ctx.model);
  for (const o of placed) if (o !== obj && o.visible && o.parent) targets.push(o);

  // center + four footprint corners at 40% extents — the highest hit wins,
  // so an object half over a table edge still rests on the table
  const samples = [[0, 0], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4], [-0.4, -0.4]];
  let support = ctx.modelBox ? ctx.modelBox.min.y : 0;
  for (const [fx, fz] of samples) {
    _gRay.set(new THREE.Vector3(cx + fx * size.x, originY, cz + fz * size.z), _gDown);
    _gRay.near = 0;
    _gRay.far = 100;
    for (const h of _gRay.intersectObjects(targets, true)) {
      if (!h.object.visible) continue;
      let p = h.object, own = false;
      while (p) { if (p === obj) { own = true; break; } p = p.parent; }
      if (own) continue;
      if (h.point.y > support) support = h.point.y;
      break;
    }
  }
  obj.position.y += support - _gBox.min.y;
}
const _gDown = new THREE.Vector3(0, -1, 0);

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
  initTransformPanel();

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
    setTimeout(() => ctx.reloadToProject(), 400);
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

  ctx.cleanupHooks.push(cleanup);
}

// model is being replaced — drop every placed object and scan reference
function cleanup() {
  cancelPlacing();
  deselect();
  clearHover();
  hideCtxMenu();
  for (const obj of placed) {
    ctx.scene.remove(obj);
    obj.traverse(o => {
      if (o.geometry && !obj.userData.sharedGeo && !obj.userData.scanName) o.geometry.dispose();
      if (o.isCSS2DObject && o.element.parentNode) o.element.parentNode.removeChild(o.element);
    });
  }
  placed.length = 0;
  scanByName.clear();
  translatedGeos.clear();
  dragging = null;
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
  ctx.closeSheets?.();   // mobile: the catalog sheet covers the canvas
  // picking from the catalog while walking: re-engage the pointer lock so the
  // item can be aimed with the crosshair
  if (ctx.walkActive && ctx.walkResumeLock) ctx.walkResumeLock();
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
  settle(p.obj);
  if (p.onPlace) p.onPlace(p.obj);
  select(p.obj);
  checkCollisions();
}

function movePlacing(ev) {
  ctx.setNDC(ev);
  if (placeAt(placing.obj)) { checkCollisions(); return; }
  floorPlane.constant = -placing.obj.position.y;
  const hit = new THREE.Vector3();
  if (ctx.raycaster.ray.intersectPlane(floorPlane, hit)) {
    constrainXZ(placing.obj, hit.x, hit.z);
    checkCollisions();
  }
}

// walk-mode support: aim the placing object with the crosshair ray
export function isPlacing() { return !!placing; }
export function confirmPlacing() { if (placing) finishPlacing(); }

const _aimRay = new THREE.Ray();
const _aimHit = new THREE.Vector3();
export function placingAim(origin, dir) {
  if (!placing) return;
  const obj = placing.obj;
  ctx.raycaster.set(origin, dir);
  ctx.raycaster.near = 0;
  ctx.raycaster.far = 8;
  if (placeAt(obj)) return;
  floorPlane.constant = -obj.position.y;
  _aimRay.set(origin, dir);
  let target = null;
  if (_aimRay.intersectPlane(floorPlane, _aimHit) && _aimHit.distanceTo(origin) < 6) {
    target = _aimHit;
  } else {
    // looking too far / at the horizon: hold the object ~2.5 m ahead
    const fwd = dir.clone();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) return;
    fwd.normalize().multiplyScalar(2.5);
    target = _aimHit.set(origin.x + fwd.x, obj.position.y, origin.z + fwd.z);
  }
  constrainXZ(obj, target.x, target.z);
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

// duplicating hands the copy to the click-to-place flow (cursor / crosshair)
// instead of dropping it at a fixed offset
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
  cl.rotation.y = obj.rotation.y;
  startPlacing(cl, {
    onPlace: o => {
      const rec = { source: sourceName, pos: o.position.toArray(), rotY: o.rotation.y };
      persist.get().clones.push(rec);
      o.userData.rec = rec;
      o.userData.recList = persist.get().clones;
      persist.save();
      if (onCloneSource) onCloneSource(sourceName);
    },
  });
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
  updateTransformPanel();
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
    if (placeAt(dragging)) {
      refreshHighlight();
      checkCollisions();
      return true;
    }
    floorPlane.constant = -dragging.position.y;
    const hit = new THREE.Vector3();
    if (ctx.raycaster.ray.intersectPlane(floorPlane, hit)) {
      constrainXZ(dragging, hit.x + dragOffset.x, hit.z + dragOffset.z);
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
    settle(dragging);            // gravity: no floating furniture on release
    persistChange(dragging);
    refreshHighlight();
    updateTransformPanel();
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

// floating name tags (CSS2D .furn-label) are hidden by default — visible only
// while their object is hovered or selected
function setFurnLabel(obj, visible) {
  if (!obj) return;
  obj.traverse(o => {
    if (o.isCSS2DObject && o.element.classList.contains('furn-label')) {
      o.element.style.display = visible ? 'block' : 'none';
    }
  });
}

function updateHover(ev) {
  if (ctx.walkActive) { clearHover(); return; }
  const obj = pick(ev);   // pick() applies mode rules (scan objects: edit only)
  if (!obj) { clearHover(); return; }
  if (obj !== hoverObj) {
    clearHover();
    hoverObj = obj;
    setFurnLabel(obj, true);
    if (obj.userData.dimGuides) showDimGuides(obj);
    if (ctx.mode === 'edit') {
      hoverHelper = new THREE.Box3Helper(new THREE.Box3().setFromObject(obj), 0xe8b23e);
      hoverHelper.material.depthTest = false;
      hoverHelper.material.transparent = true;
      hoverHelper.material.opacity = 0.7;
      hoverHelper.renderOrder = 999;
      ctx.scene.add(hoverHelper);
    }
  }
  if (ctx.mode !== 'edit' && !obj.userData.hoverInfo) { hoverDimsEl.style.display = 'none'; return; }
  new THREE.Box3().setFromObject(obj).getSize(hoverSize);
  hoverDimsEl.innerHTML = obj.userData.hoverInfo
    ? `<span class="t">${labelOf(obj)}</span><br>${obj.userData.hoverInfo}`
    : `<span class="t">${labelOf(obj)}</span>` +
      `${Math.round(hoverSize.x * 100)} × ${Math.round(hoverSize.z * 100)} × ${Math.round(hoverSize.y * 100)} cm`;
  hoverDimsEl.style.display = 'block';
  hoverDimsEl.style.left = ev.clientX + 'px';
  hoverDimsEl.style.top = ev.clientY + 'px';
}

// dimension guides: objects may carry userData.dimGuides = [{a, b, text}] in
// local coords — drawn as amber lines with end ticks + a CSS2D label at the midpoint
let dimGuideGroup = null;
function showDimGuides(obj) {
  hideDimGuides();
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xe8b23e, depthTest: false, transparent: true, opacity: 0.95 });
  for (const d of obj.userData.dimGuides) {
    const a = new THREE.Vector3().fromArray(d.a), b = new THREE.Vector3().fromArray(d.b);
    const dir = b.clone().sub(a).normalize();
    const tick = (Math.abs(dir.y) > 0.5 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).multiplyScalar(0.05);
    const pts = [a, b, a.clone().add(tick), a.clone().sub(tick), b.clone().add(tick), b.clone().sub(tick)];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setIndex([0, 1, 2, 3, 4, 5]);
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 998;
    g.add(line);
    g.add(makeTextLabel(d.text, a.clone().add(b).multiplyScalar(0.5), '#e8b23e', 'dim-label'));
  }
  obj.add(g);
  dimGuideGroup = g;
}
function hideDimGuides() {
  if (!dimGuideGroup) return;
  dimGuideGroup.traverse(o => { if (o.isCSS2DObject) o.element.remove(); });
  dimGuideGroup.parent?.remove(dimGuideGroup);
  dimGuideGroup.traverse(o => { o.geometry?.dispose?.(); });
  dimGuideGroup = null;
}

function clearHover() {
  hideDimGuides();
  if (hoverHelper) {
    ctx.scene.remove(hoverHelper);
    hoverHelper.geometry.dispose();
    hoverHelper.material.dispose();
    hoverHelper = null;
  }
  if (hoverObj && hoverObj !== selected) setFurnLabel(hoverObj, false);
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
  item('i-folder', t('ctx.toCatalog'), () => exportToCatalog(obj));
  item('i-trash', t('ctx.delete'), () => remove(obj), 'danger');
  ctxMenuEl.style.display = 'block';
  const r = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  ctxMenuEl.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
}

function hideCtxMenu() {
  if (ctxMenuEl) ctxMenuEl.style.display = 'none';
}

// ---------- cross-project copy ----------
// Export the object as a standalone GLB into the shared furniture store
// (IndexedDB is per-browser, not per-project) so it can be placed in any
// other project from the "Imported furniture" catalog section.
function exportToCatalog(obj) {
  const clone = obj.clone(true);
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, 0, 0);
  // strip CSS2D labels — the exporter can't serialize them
  const drop = [];
  clone.traverse(o => { if (o.isCSS2DObject) drop.push(o); });
  drop.forEach(o => o.parent.remove(o));
  // materials may carry clipping planes from the house model; export clean copies
  clone.traverse(o => {
    if (o.isMesh && o.material?.clippingPlanes?.length) {
      o.material = o.material.clone();
      o.material.clippingPlanes = null;
    }
  });
  new THREE.Box3().setFromObject(clone).getSize(hoverSize);
  const name = `${labelOf(obj)} ${Math.round(hoverSize.x * 100)}×${Math.round(hoverSize.z * 100)}`;
  new GLTFExporter().parse(clone,
    result => {
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      if (ctx.importUserModel) ctx.importUserModel(name, blob, { spawn: false });
    },
    () => { ctx.statusEl.textContent = t('status.importFail', { name }); },
    { binary: true });
}

// ---------- selection ----------
let helper = null;

export function select(obj) {
  deselect();
  selected = obj;
  setFurnLabel(obj, true);
  helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(obj), 0x4f8ef7);
  helper.material.depthTest = false;
  helper.renderOrder = 1000;
  ctx.scene.add(helper);
  const label = labelOf(obj);
  if (label) ctx.statusEl.textContent = t('status.selected', { label });
  showTransformPanel();
}

export function deselect() {
  if (selected && selected !== hoverObj) setFurnLabel(selected, false);
  if (helper) {
    ctx.scene.remove(helper);
    helper.geometry.dispose();
    helper.material.dispose();
    helper = null;
  }
  selected = null;
  hideTransformPanel();
}

// ---------- transform panel (manual position / rotation) ----------
let tfPanel = null, tfInputs = null, tfName = null;
let tfMuted = false;   // true while we write values into the inputs

function initTransformPanel() {
  tfPanel = document.getElementById('tf-panel');
  tfName = document.getElementById('tf-name');
  tfInputs = {
    x: document.getElementById('tf-x'),
    y: document.getElementById('tf-y'),
    z: document.getElementById('tf-z'),
    rot: document.getElementById('tf-rot'),
  };
  const apply = () => {
    if (!selected || tfMuted) return;
    const p = selected.position;
    const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
    p.x = parseFloat(tfInputs.x.value) || 0;
    p.y = floorY + (parseFloat(tfInputs.y.value) || 0);   // input = height above floor
    p.z = parseFloat(tfInputs.z.value) || 0;
    selected.rotation.y = (parseFloat(tfInputs.rot.value) || 0) * Math.PI / 180;
    refreshHighlight();
    checkCollisions();
    persistChange(selected);
  };
  for (const el of Object.values(tfInputs)) {
    el.addEventListener('input', apply);
    el.addEventListener('keydown', ev => ev.stopPropagation());
  }
  document.getElementById('tf-drop').onclick = () => {
    if (!selected) return;
    settle(selected);
    refreshHighlight();
    checkCollisions();
    persistChange(selected);
    updateTransformPanel();
  };
}

function showTransformPanel() {
  if (!tfPanel) return;
  tfPanel.classList.add('show');
  tfName.textContent = labelOf(selected) || t('tf.object');
  updateTransformPanel();
}

function hideTransformPanel() {
  if (tfPanel) tfPanel.classList.remove('show');
}

export function updateTransformPanel() {
  if (!tfPanel || !selected || !tfPanel.classList.contains('show')) return;
  tfMuted = true;
  const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
  tfInputs.x.value = selected.position.x.toFixed(2);
  tfInputs.y.value = (selected.position.y - floorY).toFixed(2);
  tfInputs.z.value = selected.position.z.toFixed(2);
  let deg = (selected.rotation.y * 180 / Math.PI) % 360;
  if (deg < 0) deg += 360;
  tfInputs.rot.value = Math.round(deg);
  tfMuted = false;
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
      row.onclick = () => { if (persist.restore(i)) ctx.reloadToProject(); };
    }
    list.prepend(row);
  });
}
