import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeTextLabel } from './utils.js';
import * as editor from './editor.js';
import * as persist from './persist.js';
import { t } from './i18n.js';

// Add panel: searchable catalog of Kenney GLB furniture, the door tool,
// clones of scanned objects and parametric fallback blocks.
// Picking an item starts the click-to-place flow (editor.startPlacing).
const KENNEY = [
  { id: 'kenney:bedSingle',        key: 'k.bedSingle',   file: 'bedSingle.glb',        target: 1.90, scaleBy: 'd' },
  { id: 'kenney:bedDouble',        key: 'k.bedDouble',   file: 'bedDouble.glb',        target: 2.00, scaleBy: 'd' },
  { id: 'kenney:wardrobe',         key: 'k.wardrobe',    file: 'bookcaseClosedDoors.glb', target: 2.10, scaleBy: 'h' },
  { id: 'kenney:desk',             key: 'k.desk',        file: 'desk.glb',             target: 1.20, scaleBy: 'w' },
  { id: 'kenney:chairDesk',        key: 'k.chairDesk',   file: 'chairDesk.glb',        target: 0.50, scaleBy: 'w' },
  { id: 'kenney:chair',            key: 'k.chair',       file: 'chair.glb',            target: 0.45, scaleBy: 'w' },
  { id: 'kenney:loungeChair',      key: 'k.loungeChair', file: 'loungeChair.glb',      target: 0.85, scaleBy: 'w' },
  { id: 'kenney:loungeSofa',       key: 'k.sofa3',       file: 'loungeSofa.glb',       target: 2.00, scaleBy: 'w' },
  { id: 'kenney:loungeSofaCorner', key: 'k.sofaCorner',  file: 'loungeSofaCorner.glb', target: 2.20, scaleBy: 'w' },
  { id: 'kenney:table',            key: 'k.table',       file: 'table.glb',            target: 1.20, scaleBy: 'w' },
  { id: 'kenney:fridge',           key: 'k.fridge',      file: 'kitchenFridge.glb',    target: 1.80, scaleBy: 'h' },
  { id: 'kenney:washer',           key: 'k.washer',      file: 'washer.glb',           target: 0.85, scaleBy: 'h' },
  { id: 'kenney:toilet',           key: 'k.toilet',      file: 'toilet.glb',           target: 0.68, scaleBy: 'd' },
  { id: 'kenney:sink',             key: 'k.sink',        file: 'bathroomSink.glb',     target: 0.55, scaleBy: 'w' },
  { id: 'kenney:tv',               key: 'k.tv',          file: 'cabinetTelevision.glb', target: 1.50, scaleBy: 'w' },
  { id: 'kenney:nightstand',       key: 'k.nightstand',  file: 'cabinetBedDrawer.glb', target: 0.45, scaleBy: 'w' },
  { id: 'kenney:bookcase',         key: 'k.bookcase',    file: 'bookcaseOpen.glb',     target: 1.80, scaleBy: 'h' },
];

const BOXES = [
  { key: 'k.bedSingle',   w: 0.90, d: 1.90, h: 0.50, color: 0x6f9df0 },
  { key: 'k.bedDouble',   w: 1.60, d: 2.00, h: 0.50, color: 0x6f9df0 },
  { key: 'k.wardrobe',    w: 1.20, d: 0.60, h: 2.10, color: 0xb08a5c },
  { key: 'k.desk',        w: 1.20, d: 0.60, h: 0.75, color: 0xc9a06a },
  { key: 'k.chair',       w: 0.45, d: 0.45, h: 0.90, color: 0x8a8f99 },
  { key: 'k.sofa3',       w: 2.00, d: 0.90, h: 0.85, color: 0x7bc7a3 },
  { key: 'k.loungeChair', w: 0.85, d: 0.85, h: 0.85, color: 0x7bc7a3 },
  { key: 'k.table',       w: 1.20, d: 0.80, h: 0.75, color: 0xc9a06a },
  { key: 'k.fridge',      w: 0.70, d: 0.70, h: 1.80, color: 0xd7dce4 },
  { key: 'k.washer',      w: 0.60, d: 0.60, h: 0.85, color: 0xd7dce4 },
  { key: 'k.tv',          w: 1.50, d: 0.40, h: 0.50, color: 0x5c5148 },
  { key: 'k.nightstand',  w: 0.45, d: 0.40, h: 0.55, color: 0xb08a5c },
];

let ctx = null;
let furnListEl = null;
let scanSectionEl = null;
const kenneyById = new Map(KENNEY.map(d => [d.id, d]));
const templateCache = new Map();
const gltfLoader = new GLTFLoader();

export function init(c) {
  ctx = c;
  furnListEl = document.getElementById('furn-list');
  ctx.catalogDuplicate = duplicateCatalogItem;

  // door tool lives in the same panel (doors.js binds the mode to #btn-door)
  const doorItem = document.createElement('div');
  doorItem.className = 'furn-item';
  doorItem.id = 'btn-door';
  doorItem.innerHTML = `<span>${t('catalog.door')}</span><span class="dims">86×205</span>`;
  furnListEl.appendChild(doorItem);

  section(t('catalog.furniture'));
  KENNEY.forEach(def => {
    const dimTxt = def.scaleBy === 'h'
      ? t('catalog.tall', { n: Math.round(def.target * 100) })
      : `${Math.round(def.target * 100)} cm`;
    item(t(def.key), dimTxt, () => spawnKenney(def).catch(() => spawnBoxFallback(def.key)));
  });

  scanSectionEl = document.createElement('div');
  furnListEl.appendChild(scanSectionEl);

  section(t('catalog.blocks'));
  BOXES.forEach(f => {
    item(t(f.key), `${(f.w*100)|0}×${(f.d*100)|0} cm`, () => spawnBox(f));
  });

  // search filter
  const search = document.getElementById('furn-search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLocaleLowerCase();
    furnListEl.querySelectorAll('.furn-item').forEach(el => {
      el.style.display = !q || el.textContent.toLocaleLowerCase().includes(q) ? '' : 'none';
    });
    furnListEl.querySelectorAll('.furn-section').forEach(el => {
      el.style.display = q ? 'none' : '';
    });
  });

  ctx.modelHooks.push(() => {
    for (const rec of persist.get().furniture) {
      const def = kenneyById.get(rec.catalogId);
      if (!def) continue;
      spawnKenney(def, rec).catch(() => {});
    }
  });
}

function section(label) {
  const el = document.createElement('div');
  el.className = 'furn-section';
  el.textContent = label;
  furnListEl.appendChild(el);
}

function item(label, dims, onClick, parent = furnListEl) {
  const div = document.createElement('div');
  div.className = 'furn-item';
  div.innerHTML = `<span>${label}</span><span class="dims">${dims}</span>`;
  div.onclick = onClick;
  parent.appendChild(div);
  return div;
}

// ---------- Kenney GLB pipeline ----------
function loadTemplate(def) {
  if (templateCache.has(def.id)) return templateCache.get(def.id);
  const p = gltfLoader.loadAsync('assets/furniture/' + def.file).then(gltf => {
    const inner = gltf.scene;
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const axis = def.scaleBy === 'h' ? size.y : def.scaleBy === 'd' ? size.z : size.x;
    const s = def.target / (axis || 1);
    inner.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(inner);
    const center = box2.getCenter(new THREE.Vector3());
    inner.position.sub(new THREE.Vector3(center.x, box2.min.y, center.z));
    const root = new THREE.Group();
    root.add(inner);
    const size2 = box2.getSize(new THREE.Vector3());
    return { root, w: size2.x, d: size2.z, h: size2.y };
  });
  templateCache.set(def.id, p);
  return p;
}

function buildKenney(tpl, def) {
  const m = tpl.root.clone(true);
  m.userData = { catalogId: def.id, label: t(def.key), sharedGeo: true };
  m.add(makeTextLabel(
    `${t(def.key)} ${Math.round(tpl.w * 100)}×${Math.round(tpl.d * 100)}`,
    new THREE.Vector3(0, tpl.h + 0.15, 0), '#cdd2da', 'furn-label'));
  ctx.scene.add(m);
  editor.register(m);
  return m;
}

async function spawnKenney(def, rec = null) {
  const tpl = await loadTemplate(def);
  const m = buildKenney(tpl, def);
  const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
  if (rec) {   // restore path — no placement flow
    m.position.fromArray(rec.pos);
    m.rotation.y = rec.rotY || 0;
    m.userData.rec = rec;
    m.userData.recList = persist.get().furniture;
    return m;
  }
  m.position.set(ctx.controls.target.x, floorY, ctx.controls.target.z);
  editor.startPlacing(m, {
    onPlace: obj => {
      const r = { catalogId: def.id, pos: obj.position.toArray(), rotY: obj.rotation.y };
      persist.get().furniture.push(r);
      obj.userData.rec = r;
      obj.userData.recList = persist.get().furniture;
      persist.save();
    },
  });
  return m;
}

// context-menu / D-key duplicate for placed catalog furniture — the copy goes
// through the click-to-place flow like everything else
function duplicateCatalogItem(obj) {
  const def = kenneyById.get(obj.userData.catalogId);
  if (!def) return null;
  loadTemplate(def).then(tpl => {
    const m = buildKenney(tpl, def);
    m.position.copy(obj.position);
    m.rotation.y = obj.rotation.y;
    editor.startPlacing(m, {
      onPlace: o => {
        const r = { catalogId: def.id, pos: o.position.toArray(), rotY: o.rotation.y };
        persist.get().furniture.push(r);
        o.userData.rec = r;
        o.userData.recList = persist.get().furniture;
        persist.save();
      },
    });
  });
  return true;
}

function spawnBoxFallback(key) {
  const f = BOXES.find(b => b.key === key) || BOXES[0];
  spawnBox(f);
}

// ---------- scan clones ----------
export function buildScanSection() {
  scanSectionEl.innerHTML = '';
  if (!editor.scanByName.size) return;
  const header = document.createElement('div');
  header.className = 'furn-section';
  header.textContent = t('catalog.scan');
  scanSectionEl.appendChild(header);

  const seen = new Map();
  const size = new THREE.Vector3();
  for (const [name, node] of editor.scanByName) {
    new THREE.Box3().setFromObject(node).getSize(size);
    const label = editor.objectLabel(name);
    const key = label + '|' + Math.round(size.x * 20) + '|' + Math.round(size.z * 20);
    if (!seen.has(key)) seen.set(key, { name, label, w: size.x, d: size.z });
  }
  const entries = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const e of entries) {
    item(e.label, `${Math.round(e.w*100)}×${Math.round(e.d*100)} cm`,
      () => editor.spawnCloneOf(e.name), scanSectionEl);
  }
}

// ---------- parametric boxes ----------
function spawnBox(def) {
  const geo = new THREE.BoxGeometry(def.w, def.h, def.d);
  const mat = new THREE.MeshStandardMaterial({
    color: def.color, transparent: true, opacity: 0.85, roughness: 0.8
  });
  const m = new THREE.Mesh(geo, mat);
  m.userData.def = def;
  m.userData.label = t(def.key);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x16181d })
  );
  m.add(edges);
  m.add(makeTextLabel(`${t(def.key)} ${(def.w*100)|0}×${(def.d*100)|0}`,
    new THREE.Vector3(0, def.h / 2 + 0.15, 0), '#cdd2da', 'furn-label'));
  const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
  m.position.set(ctx.controls.target.x, floorY + def.h / 2, ctx.controls.target.z);
  ctx.scene.add(m);
  editor.register(m);
  editor.startPlacing(m, { onPlace: () => {} });   // boxes are session-only
}
