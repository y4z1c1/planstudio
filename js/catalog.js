import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeTextLabel } from './utils.js';
import * as editor from './editor.js';
import * as persist from './persist.js';

// Catalog kinds:
//  - kenney:    real GLB models (Kenney Furniture Kit, CC0), metric-normalized
//  - scanClone: copies of objects present in the Polycam scan (built at load)
//  - box:       parametric fallback blocks
const KENNEY = [
  { id: 'kenney:bedSingle',        label: 'Tek kişilik yatak',  file: 'bedSingle.glb',        target: 1.90, scaleBy: 'd' },
  { id: 'kenney:bedDouble',        label: 'Çift kişilik yatak', file: 'bedDouble.glb',        target: 2.00, scaleBy: 'd' },
  { id: 'kenney:wardrobe',         label: 'Gardırop',           file: 'bookcaseClosedDoors.glb', target: 2.10, scaleBy: 'h' },
  { id: 'kenney:desk',             label: 'Çalışma masası',     file: 'desk.glb',             target: 1.20, scaleBy: 'w' },
  { id: 'kenney:chairDesk',        label: 'Çalışma sandalyesi', file: 'chairDesk.glb',        target: 0.50, scaleBy: 'w' },
  { id: 'kenney:chair',            label: 'Sandalye',           file: 'chair.glb',            target: 0.45, scaleBy: 'w' },
  { id: 'kenney:loungeChair',      label: 'Tekli koltuk',       file: 'loungeChair.glb',      target: 0.85, scaleBy: 'w' },
  { id: 'kenney:loungeSofa',       label: "3'lü koltuk",        file: 'loungeSofa.glb',       target: 2.00, scaleBy: 'w' },
  { id: 'kenney:loungeSofaCorner', label: 'L köşe koltuk',      file: 'loungeSofaCorner.glb', target: 2.20, scaleBy: 'w' },
  { id: 'kenney:table',            label: 'Yemek masası',       file: 'table.glb',            target: 1.20, scaleBy: 'w' },
  { id: 'kenney:fridge',           label: 'Buzdolabı',          file: 'kitchenFridge.glb',    target: 1.80, scaleBy: 'h' },
  { id: 'kenney:washer',           label: 'Çamaşır makinesi',   file: 'washer.glb',           target: 0.85, scaleBy: 'h' },
  { id: 'kenney:toilet',           label: 'Klozet',             file: 'toilet.glb',           target: 0.68, scaleBy: 'd' },
  { id: 'kenney:sink',             label: 'Lavabo',             file: 'bathroomSink.glb',     target: 0.55, scaleBy: 'w' },
  { id: 'kenney:tv',               label: 'TV ünitesi',         file: 'cabinetTelevision.glb', target: 1.50, scaleBy: 'w' },
  { id: 'kenney:nightstand',       label: 'Komodin',            file: 'cabinetBedDrawer.glb', target: 0.45, scaleBy: 'w' },
  { id: 'kenney:bookcase',         label: 'Kitaplık',           file: 'bookcaseOpen.glb',     target: 1.80, scaleBy: 'h' },
];

const BOXES = [
  { name: 'Tek kişilik yatak',  w: 0.90, d: 1.90, h: 0.50, color: 0x6f9df0 },
  { name: 'Çift kişilik yatak', w: 1.60, d: 2.00, h: 0.50, color: 0x6f9df0 },
  { name: 'Gardırop',           w: 1.20, d: 0.60, h: 2.10, color: 0xb08a5c },
  { name: 'Çalışma masası',     w: 1.20, d: 0.60, h: 0.75, color: 0xc9a06a },
  { name: 'Sandalye',           w: 0.45, d: 0.45, h: 0.90, color: 0x8a8f99 },
  { name: '3’lü koltuk',        w: 2.00, d: 0.90, h: 0.85, color: 0x7bc7a3 },
  { name: 'Tekli koltuk',       w: 0.85, d: 0.85, h: 0.85, color: 0x7bc7a3 },
  { name: 'Yemek masası',       w: 1.20, d: 0.80, h: 0.75, color: 0xc9a06a },
  { name: 'Buzdolabı',          w: 0.70, d: 0.70, h: 1.80, color: 0xd7dce4 },
  { name: 'Çamaşır makinesi',   w: 0.60, d: 0.60, h: 0.85, color: 0xd7dce4 },
  { name: 'TV ünitesi',         w: 1.50, d: 0.40, h: 0.50, color: 0x5c5148 },
  { name: 'Komodin',            w: 0.45, d: 0.40, h: 0.55, color: 0xb08a5c },
];

let ctx = null;
let furnListEl = null;
let scanSectionEl = null;
const kenneyById = new Map(KENNEY.map(d => [d.id, d]));
const templateCache = new Map();   // id -> Promise<{root, w, d, h}>
const gltfLoader = new GLTFLoader();

export function init(c) {
  ctx = c;
  furnListEl = document.getElementById('furn-list');

  const btnFurn = document.getElementById('btn-furn');
  btnFurn.onclick = () => ctx.setMode('furn');
  ctx.modeUI.push({
    mode: 'furn', button: btnFurn,
    hints: [document.getElementById('hint-furn'), furnListEl],
  });

  const kenneyHeader = document.createElement('div');
  kenneyHeader.className = 'furn-section';
  kenneyHeader.textContent = 'Mobilyalar';
  furnListEl.appendChild(kenneyHeader);
  KENNEY.forEach(def => {
    const div = document.createElement('div');
    div.className = 'furn-item';
    const dimTxt = def.scaleBy === 'h'
      ? `${Math.round(def.target * 100)} cm boy`
      : `${Math.round(def.target * 100)} cm`;
    div.innerHTML = `<span>${def.label}</span><span class="dims">${dimTxt}</span>`;
    div.onclick = () => spawnKenney(def).catch(() => spawnBoxFallback(def.label));
    furnListEl.appendChild(div);
  });

  scanSectionEl = document.createElement('div');
  furnListEl.appendChild(scanSectionEl);

  const boxHeader = document.createElement('div');
  boxHeader.className = 'furn-section';
  boxHeader.textContent = 'Basit bloklar';
  furnListEl.appendChild(boxHeader);
  BOXES.forEach(f => {
    const div = document.createElement('div');
    div.className = 'furn-item';
    div.innerHTML = `<span>${f.name}</span><span class="dims">${(f.w*100)|0}×${(f.d*100)|0} cm</span>`;
    div.onclick = () => spawnBox(f);
    furnListEl.appendChild(div);
  });

  // restore persisted Kenney furniture with the model (so floor height is known)
  ctx.modelHooks.push(() => {
    for (const rec of persist.get().furniture) {
      const def = kenneyById.get(rec.catalogId);
      if (!def) continue;
      spawnKenney(def, rec).catch(() => {});
    }
  });
}

// ---------- Kenney GLB pipeline ----------
// normalize once per id: uniform scale so the scaleBy axis hits target size,
// then recenter so XZ center = 0 and min.y = 0
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

async function spawnKenney(def, rec = null) {
  const tpl = await loadTemplate(def);
  const m = tpl.root.clone(true);
  m.userData = {
    catalogId: def.id, label: def.label, sharedGeo: true,
  };
  m.add(makeTextLabel(
    `${def.label} ${Math.round(tpl.w * 100)}×${Math.round(tpl.d * 100)}`,
    new THREE.Vector3(0, tpl.h + 0.15, 0), '#cdd2da', 'furn-label'));
  const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
  if (rec) {
    m.position.fromArray(rec.pos);
    m.rotation.y = rec.rotY || 0;
  } else {
    m.position.set(ctx.controls.target.x, floorY, ctx.controls.target.z);
    rec = { catalogId: def.id, pos: m.position.toArray(), rotY: 0 };
    persist.get().furniture.push(rec);
    persist.save();
  }
  m.userData.rec = rec;
  m.userData.recList = persist.get().furniture;
  ctx.scene.add(m);
  editor.register(m);
  if (ctx.mode === 'furn' || ctx.mode === 'edit') editor.select(m);
  return m;
}

function spawnBoxFallback(label) {
  const f = BOXES.find(b => b.name.toLowerCase() === label.toLowerCase()) || BOXES[0];
  spawnBox(f);
}

// ---------- scan clones ----------
export function buildScanSection() {
  scanSectionEl.innerHTML = '';
  if (!editor.scanByName.size) return;
  const header = document.createElement('div');
  header.className = 'furn-section';
  header.textContent = 'Evdeki eşyalar (taramadan)';
  scanSectionEl.appendChild(header);

  const seen = new Map();
  const size = new THREE.Vector3();
  for (const [name, node] of editor.scanByName) {
    new THREE.Box3().setFromObject(node).getSize(size);
    const label = editor.turkishObjectLabel(name);
    const key = label + '|' + Math.round(size.x * 20) + '|' + Math.round(size.z * 20);
    if (!seen.has(key)) {
      seen.set(key, { name, label, w: size.x, d: size.z });
    }
  }
  const entries = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  for (const e of entries) {
    const div = document.createElement('div');
    div.className = 'furn-item';
    div.innerHTML = `<span>${e.label}</span><span class="dims">${Math.round(e.w*100)}×${Math.round(e.d*100)} cm</span>`;
    div.onclick = () => editor.spawnCloneOf(e.name);
    scanSectionEl.appendChild(div);
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
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x16181d })
  );
  m.add(edges);
  m.add(makeTextLabel(`${def.name} ${(def.w*100)|0}×${(def.d*100)|0}`,
    new THREE.Vector3(0, def.h / 2 + 0.15, 0), '#cdd2da', 'furn-label'));
  const floorY = ctx.modelBox ? ctx.modelBox.min.y : 0;
  m.position.set(ctx.controls.target.x, floorY + def.h / 2, ctx.controls.target.z);
  ctx.scene.add(m);
  editor.register(m);
  editor.select(m);
  editor.checkCollisions();
}
