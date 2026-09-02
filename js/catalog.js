import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { makeTextLabel } from './utils.js';
import * as editor from './editor.js';
import * as persist from './persist.js';
import * as projects from './projects.js';
import { t } from './i18n.js';

// IKEA proxy (server/ikea-proxy.py). Same-origin in production; the deployed
// proxy is used as fallback during local development.
const IKEA_PROXY_BASE = location.hostname === 'plan.yusufanilyazici.com'
  ? ''
  : 'https://plan.yusufanilyazici.com';

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
  // IKEA KIVIK tresund light beige, 3-seat + chaise (art. 594.943.87, real-scale rotera GLB)
  // (metalness: 0 — rotera's packed metal/rough texture renders the fabric black in three.js)
  { id: 'ikea:kivikChaise',        key: 'k.berkSofa',    file: 'kivikTresundChaise.glb', target: 3.18, scaleBy: 'w', metalness: 0 },
  { id: 'kenney:table',            key: 'k.table',       file: 'table.glb',            target: 1.20, scaleBy: 'w' },
  { id: 'kenney:fridge',           key: 'k.fridge',      file: 'kitchenFridge.glb',    target: 1.80, scaleBy: 'h' },
  { id: 'kenney:washer',           key: 'k.washer',      file: 'washer.glb',           target: 0.85, scaleBy: 'h' },
  { id: 'kenney:toilet',           key: 'k.toilet',      file: 'toilet.glb',           target: 0.68, scaleBy: 'd' },
  { id: 'kenney:sink',             key: 'k.sink',        file: 'bathroomSink.glb',     target: 0.55, scaleBy: 'w' },
  { id: 'kenney:tv',               key: 'k.tv',          file: 'cabinetTelevision.glb', target: 1.50, scaleBy: 'w' },
  { id: 'kenney:nightstand',       key: 'k.nightstand',  file: 'cabinetBedDrawer.glb', target: 0.45, scaleBy: 'w' },
  { id: 'kenney:bookcase',         key: 'k.bookcase',    file: 'bookcaseOpen.glb',     target: 1.80, scaleBy: 'h' },
  { id: 'kenney:tv45',             key: 'k.tv45',        file: 'televisionModern.glb', target: 1.00, scaleBy: 'w', wallMount: true },
  { id: 'kenney:tv55',             key: 'k.tv55',        file: 'televisionModern.glb', target: 1.22, scaleBy: 'w', wallMount: true },
  { id: 'kenney:tv65',             key: 'k.tv65',        file: 'televisionModern.glb', target: 1.44, scaleBy: 'w', wallMount: true },
  { id: 'kenney:laptop',           key: 'k.laptop',      file: 'laptop.glb',           target: 0.30, scaleBy: 'w' },
  { id: 'kenney:monitor',          key: 'k.monitor',     file: 'computerScreen.glb',   target: 0.61, scaleBy: 'w' },
];

const BOXES = [
  { key: 'k.bedSingle',   w: 0.90, d: 1.90, h: 0.50, color: 0x6f9df0 },
  { key: 'k.bedDouble',   w: 1.60, d: 2.00, h: 0.50, color: 0x6f9df0 },
  { key: 'k.wardrobe',    w: 1.20, d: 0.60, h: 2.10, color: 0xb08a5c },
  { key: 'k.desk',        w: 1.20, d: 0.60, h: 0.75, color: 0xc9a06a },
  { key: 'k.chair',       w: 0.45, d: 0.45, h: 0.90, color: 0x8a8f99 },
  { key: 'k.sofa3',       w: 2.00, d: 0.90, h: 0.85, color: 0x7bc7a3 },
  { key: 'k.berkSofa',    w: 3.18, d: 1.63, h: 0.83, color: 0xd9cfbf },
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
let userSectionEl = null;
const kenneyById = new Map(KENNEY.map(d => [d.id, d]));
const templateCache = new Map();
const userTemplateCache = new Map();   // name -> Promise<{root,w,d,h}>
const gltfLoader = new GLTFLoader();
// IKEA rotera GLBs require KHR_draco_mesh_compression
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
gltfLoader.setDRACOLoader(draco);

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

  // ---- user imports: GLB upload + IKEA fetch ----
  const upItem = document.createElement('div');
  upItem.className = 'furn-item';
  upItem.innerHTML = `<span>${t('catalog.upload')}</span><span class="dims">.glb</span>`;
  const furnFile = document.createElement('input');
  furnFile.type = 'file';
  furnFile.accept = '.glb';
  furnFile.style.display = 'none';
  document.body.appendChild(furnFile);
  upItem.onclick = () => furnFile.click();
  furnFile.addEventListener('change', () => {
    const f = furnFile.files[0];
    if (f) importUserModel(f.name.replace(/\.glb$/i, ''), f);
    furnFile.value = '';
  });
  furnListEl.appendChild(upItem);

  const ikeaRow = document.createElement('div');
  ikeaRow.style.cssText = 'display:flex;gap:4px;margin:2px 0;';
  ikeaRow.innerHTML =
    `<input id="ikea-input" type="text" placeholder="${t('catalog.ikeaPh')}" ` +
    `style="flex:1;min-width:0;background:var(--panel2);border:1px solid var(--border);` +
    `border-radius:var(--radius);color:var(--text);font-family:inherit;font-size:12px;padding:6px 9px;outline:none;">` +
    `<button id="ikea-btn" class="btn" style="width:auto;padding:6px 10px;">${t('catalog.ikeaBtn')}</button>`;
  furnListEl.appendChild(ikeaRow);
  ikeaRow.querySelector('#ikea-btn').onclick = fetchIkea;
  ikeaRow.querySelector('#ikea-input').addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') fetchIkea();
  });

  userSectionEl = document.createElement('div');
  furnListEl.appendChild(userSectionEl);
  renderUserSection();

  section(t('catalog.furniture'));
  KENNEY.forEach(def => {
    const dimTxt = def.scaleBy === 'h'
      ? t('catalog.tall', { n: Math.round(def.target * 100) })
      : `${Math.round(def.target * 100)} cm`;
    item(t(def.key), dimTxt, () => spawnKenney(def).catch(() => spawnBoxFallback(def.key)));
  });

  Object.entries(PROC).forEach(([id, def]) => {
    item(t(def.key), def.dims, () => spawnProc(id));
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
    for (const rec of persist.get().furniture) restoreRec(rec);
  });
  ctx.restoreFurnitureRec = restoreRec;   // late additions (e.g. auto windows)

  // cross-project copy (editor context menu) drops exported objects here
  ctx.importUserModel = importUserModel;
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
    if (def.metalness !== undefined) inner.traverse(n => {
      if (n.isMesh && n.material) { n.material.metalness = def.metalness; n.material.needsUpdate = true; }
    });
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
  m.userData = { catalogId: def.id, label: t(def.key), sharedGeo: true, wallMount: !!def.wallMount };
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
  if (obj.userData.catalogId?.startsWith('user:')) {
    spawnUser(obj.userData.catalogId.slice(5));
    return true;
  }
  if (obj.userData.catalogId?.startsWith('proc:')) {
    spawnProc(obj.userData.catalogId);
    return true;
  }
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

// spawn a persisted furniture record of any kind (restore path)
function restoreRec(rec) {
  if (rec.catalogId?.startsWith('user:')) return spawnUser(rec.catalogId.slice(5), rec);
  if (rec.catalogId?.startsWith('proc:')) return spawnProc(rec.catalogId, rec);
  const def = kenneyById.get(rec.catalogId);
  if (def) spawnKenney(def, rec).catch(() => {});
}

// ---------- procedural items (no GLB source) ----------
// arch floor mirror, 100×180, thin black metal frame, leaning slightly back
function buildMirror() {
  const W = 1.0, H = 1.8, T = 0.035, D = 0.03;
  const arch = inset => {
    const w2 = W / 2 - inset, top = H - inset, r = w2;
    const sh = new THREE.Shape();
    sh.moveTo(-w2, inset);
    sh.lineTo(-w2, top - r);
    sh.absarc(0, top - r, r, Math.PI, 0, true);
    sh.lineTo(w2, inset);
    sh.closePath();
    return sh;
  };
  const frameShape = arch(0);
  frameShape.holes.push(arch(T));
  const g = new THREE.Group();
  const lean = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.ExtrudeGeometry(frameShape, { depth: D, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({ color: 0x15151a, metalness: 0.7, roughness: 0.35 }));
  lean.add(frame);
  const glass = new THREE.Mesh(
    new THREE.ShapeGeometry(arch(T)),
    new THREE.MeshStandardMaterial({ color: 0xaebfca, metalness: 1.0, roughness: 0.05 }));
  glass.position.z = D / 2;
  lean.add(glass);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x15151a, metalness: 0.7, roughness: 0.35 });
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.5, 8), legMat);
    leg.position.set(sx * (W / 2 - 0.06), 0.22, -0.14);
    leg.rotation.x = 0.55;
    lean.add(leg);
  }
  lean.rotation.x = -0.09;   // leans back like the real thing
  g.add(lean);
  return g;
}

// arched window with black muntin grid (Nişantaşı style), wall-mountable
function buildArchWindow(width) {
  const W = width || 1.4, H = 2.2, T = 0.05, D = 0.06;
  const arch = inset => {
    const w2 = W / 2 - inset, top = H - inset, r = w2;
    const sh = new THREE.Shape();
    sh.moveTo(-w2, inset);
    sh.lineTo(-w2, top - r);
    sh.absarc(0, top - r, r, Math.PI, 0, true);
    sh.lineTo(w2, inset);
    sh.closePath();
    return sh;
  };
  const frameShape = arch(0);
  frameShape.holes.push(arch(T));
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x181a1e, metalness: 0.6, roughness: 0.4 });
  g.add(new THREE.Mesh(
    new THREE.ExtrudeGeometry(frameShape, { depth: D, bevelEnabled: false }), black));
  const glass = new THREE.Mesh(
    new THREE.ShapeGeometry(arch(T)),
    new THREE.MeshStandardMaterial({
      color: 0xcfe4f0, transparent: true, opacity: 0.3,
      roughness: 0.1, metalness: 0.1, side: THREE.DoubleSide,
    }));
  glass.position.z = D / 2;
  g.add(glass);
  const bar = (w, h, x, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.035), black);
    m.position.set(x, y, D / 2);
    g.add(m);
  };
  const springY = H - W / 2;          // where the arch starts
  bar(W - T * 2, 0.045, 0, springY);  // transom at the arch spring line
  bar(W - T * 2, 0.045, 0, 0.95);    // mid rail
  bar(0.04, springY - T, 0, springY / 2 + T / 2);   // center mullion (lower part)
  bar(0.035, W / 2 - T, 0, springY + (W / 2 - T) / 2);  // center mullion in the arch
  for (const sx of [-1, 1]) bar(0.03, springY - T, sx * W / 4, springY / 2 + T / 2);
  return g;
}

// curtain on a ceiling-recess rail: one full-width pleated panel (no sheer/
// drape distinction — that's the tailor's call). w = rail length, h = drop.
function buildCurtain(width, rec) {
  const W = width || 2.6, H = rec?.h || 2.66, gap = 0.012;
  const g = new THREE.Group();
  const geo = new THREE.PlaneGeometry(W, H - gap, Math.max(8, Math.round(W / 0.02)), 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, 0.035 * Math.sin((x / 0.15) * Math.PI * 2));
  }
  geo.computeVertexNormals();
  const fabric = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xd6c9b2, roughness: 0.92, side: THREE.DoubleSide,
  }));
  fabric.position.y = gap + (H - gap) / 2;
  g.add(fabric);
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.04, 0.02, 0.12),
    new THREE.MeshStandardMaterial({ color: 0xe6e6e2, roughness: 0.6 }));
  rail.position.set(0, H + 0.01, 0.035);
  g.add(rail);
  const cm = v => Math.round(v * 100);
  g.userData.dimsLabel = `${cm(W)}×${cm(H)}`;
  // hover guides (local coords) drawn by editor.js while the curtain is hovered
  g.userData.dimGuides = [
    { a: [-W / 2, H + 0.08, 0.1], b: [W / 2, H + 0.08, 0.1], text: `${t('dim.rail')} ${cm(W)} cm` },
    { a: [W / 2 + 0.12, gap, 0.1], b: [W / 2 + 0.12, H, 0.1], text: `${t('dim.drop')} ${cm(H)} cm` },
  ];
  g.userData.hoverInfo = `${t('dim.rail')} ${cm(W)} cm · ${t('dim.drop')} ${cm(H)} cm`;
  return g;
}

const PROC = {
  'proc:mirror': { key: 'k.mirror', build: buildMirror, dims: '100×180' },
  'proc:archwindow': { key: 'k.archwin', build: buildArchWindow, dims: '140×220', wallMount: true },
  'proc:curtain': { key: 'k.curtain', build: buildCurtain, dims: '260×266', wallMount: true },
};

function spawnProc(id, rec = null) {
  const def = PROC[id];
  if (!def) return null;
  const m = def.build(rec?.w, rec);
  const { dimsLabel, dimGuides, hoverInfo } = m.userData;
  const label = dimsLabel ? `${t(def.key)} ${dimsLabel}` : t(def.key);
  m.userData = { catalogId: id, label, wallMount: !!def.wallMount, dimGuides, hoverInfo };
  m.add(makeTextLabel(label, new THREE.Vector3(0, 1.95, 0), '#cdd2da', 'furn-label'));
  const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
  ctx.scene.add(m);
  editor.register(m);
  if (rec) {
    m.position.fromArray(rec.pos);
    m.rotation.y = rec.rotY || 0;
    m.userData.rec = rec;
    m.userData.recList = persist.get().furniture;
    return m;
  }
  m.position.set(ctx.controls.target.x, floorY, ctx.controls.target.z);
  editor.startPlacing(m, {
    onPlace: obj => {
      const r = { catalogId: id, pos: obj.position.toArray(), rotY: obj.rotation.y };
      persist.get().furniture.push(r);
      obj.userData.rec = r;
      obj.userData.recList = persist.get().furniture;
      persist.save();
    },
  });
  return m;
}

// ---------- user-imported furniture (GLB upload + IKEA) ----------
async function importUserModel(name, blob, { spawn = true } = {}) {
  try {
    await projects.putFurnitureModel({ name, blob, addedAt: Date.now() });
  } catch {}
  userTemplateCache.delete(name);
  renderUserSection();
  ctx.statusEl.textContent = t('status.modelImported', { name });
  if (spawn) spawnUser(name);
}

function loadUserTemplate(name) {
  if (userTemplateCache.has(name)) return userTemplateCache.get(name);
  const p = projects.getFurnitureModel(name).then(rec => {
    if (!rec) throw new Error('missing');
    const url = URL.createObjectURL(rec.blob);
    return gltfLoader.loadAsync(url).finally(() => URL.revokeObjectURL(url));
  }).then(gltf => {
    const inner = gltf.scene;
    // IKEA rotera exports (Simplygon-optimised) carry a packed metal/rough
    // texture that three.js reads as fully metallic — the fabric renders
    // black/invisible without an env map. Force dielectric.
    const extras = gltf.parser?.json?.asset?.extras || {};
    if (extras['simplygon-version'] || extras['optimiser-version'] || /^IKEA |^\d{8}(-mini)?$/i.test(name)) {
      inner.traverse(n => {
        if (n.isMesh && n.material) { n.material.metalness = 0; n.material.needsUpdate = true; }
      });
    }
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    // most furniture GLBs (IKEA included) are metric; centimeter-scaled
    // exports show up as buildings — rescale those
    if (maxDim > 10) inner.scale.setScalar(0.01);
    const box2 = new THREE.Box3().setFromObject(inner);
    const center = box2.getCenter(new THREE.Vector3());
    inner.position.sub(new THREE.Vector3(center.x, box2.min.y, center.z));
    const root = new THREE.Group();
    root.add(inner);
    const size2 = box2.getSize(new THREE.Vector3());
    return { root, w: size2.x, d: size2.z, h: size2.y };
  });
  userTemplateCache.set(name, p);
  return p;
}

async function spawnUser(name, rec = null) {
  let tpl;
  try {
    tpl = await loadUserTemplate(name);
  } catch {
    ctx.statusEl.textContent = t('status.importFail', { name });
    return null;
  }
  const m = tpl.root.clone(true);
  m.userData = { catalogId: 'user:' + name, label: name, sharedGeo: true };
  const hasDims = /\d+×\d+/.test(name);
  m.add(makeTextLabel(
    hasDims ? name : `${name} ${Math.round(tpl.w * 100)}×${Math.round(tpl.d * 100)}`,
    new THREE.Vector3(0, tpl.h + 0.15, 0), '#cdd2da', 'furn-label'));
  const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
  if (rec) {
    m.position.fromArray(rec.pos);
    m.rotation.y = rec.rotY || 0;
    m.userData.rec = rec;
    m.userData.recList = persist.get().furniture;
    ctx.scene.add(m);
    editor.register(m);
    return m;
  }
  m.position.set(ctx.controls.target.x, floorY, ctx.controls.target.z);
  ctx.scene.add(m);
  editor.register(m);
  editor.startPlacing(m, {
    onPlace: obj => {
      const r = { catalogId: 'user:' + name, pos: obj.position.toArray(), rotY: obj.rotation.y };
      persist.get().furniture.push(r);
      obj.userData.rec = r;
      obj.userData.recList = persist.get().furniture;
      persist.save();
    },
  });
  return m;
}

async function renderUserSection() {
  userSectionEl.innerHTML = '';
  let models = [];
  try { models = await projects.listFurnitureModels(); } catch {}
  if (!models.length) return;
  const header = document.createElement('div');
  header.className = 'furn-section';
  header.textContent = t('catalog.user');
  userSectionEl.appendChild(header);
  models.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  for (const m of models) {
    const div = document.createElement('div');
    div.className = 'furn-item';
    div.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.name}</span>` +
      `<button class="del" style="background:none;border:none;color:var(--muted);cursor:pointer;font-family:inherit">✕</button>`;
    div.onclick = () => spawnUser(m.name);
    div.querySelector('.del').onclick = async ev => {
      ev.stopPropagation();
      if (!confirm(t('catalog.deleteModel', { name: m.name }))) return;
      try { await projects.deleteFurnitureModel(m.name); } catch {}
      userTemplateCache.delete(m.name);
      renderUserSection();
    };
    userSectionEl.appendChild(div);
  }
}

// parse an IKEA product URL / "804.889.64" / bare 8-digit article number
function parseIkea(input) {
  const s = input.trim();
  const dotted = s.match(/(\d{3})\.(\d{3})\.(\d{2})/);
  if (dotted) return { item: dotted[1] + dotted[2] + dotted[3] };
  const url = s.match(/ikea\.[a-z.]+\/([a-z]{2})\/([a-z]{2})\/.*?(\d{8})/i);
  if (url) return { item: url[3], cc: url[1], lc: url[2] };
  const bare = s.match(/(\d{8})(?!\d)/);
  if (bare) return { item: bare[1] };
  return null;
}

async function fetchIkea() {
  const input = document.getElementById('ikea-input');
  const parsed = parseIkea(input.value);
  if (!parsed) {
    ctx.statusEl.textContent = t('status.ikeaFail');
    return;
  }
  ctx.statusEl.textContent = t('status.ikeaFetching');
  try {
    const q = new URLSearchParams({ item: parsed.item });
    if (parsed.cc) { q.set('cc', parsed.cc); q.set('lc', parsed.lc); }
    const res = await fetch(`${IKEA_PROXY_BASE}/api/ikea/model?${q}`);
    if (!res.ok) throw new Error('http ' + res.status);
    const blob = await res.blob();
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (String.fromCharCode(...head) !== 'glTF') throw new Error('not glb');
    input.value = '';
    await importUserModel('IKEA ' + parsed.item, blob);
  } catch {
    // the rotera CDN blocks datacenter IPs, so the proxy can fail; a plain
    // navigation from the user's own IP carries no Origin header and works —
    // download in a new tab, then import the file manually
    const cc = parsed.cc || 'tr', lc = parsed.lc || 'tr';
    window.open(`https://web-api.ikea.com/${cc}/${lc}/rotera/static/models/${parsed.item}-mini.glb`, '_blank');
    ctx.statusEl.textContent = t('status.ikeaManual');
  }
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
