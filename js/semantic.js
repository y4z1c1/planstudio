import * as THREE from 'three';
import { COLORS, colorHex, makeTextLabel } from './utils.js';
import { addRecord, clearAuto, setRenameHandler } from './results.js';
import { autoMeasure as gridAutoMeasure } from './measure.js';
import * as persist from './persist.js';
import * as editor from './editor.js';
import * as catalog from './catalog.js';
import * as doors from './doors.js';
import { t } from './i18n.js';

// Polycam semantic-structure support: named Floor_* meshes give exact room
// areas; Walls / Doors / Objects groups are exposed for the editor & door tools.
let ctx = null;

// { floors:[mesh], wallsGroup, doorsGroup, objectsRoot } or null
export let semantic = null;

// filled by measureSemantic: [{name, area, centroid}] — walk mode spawns here
export const roomCenters = [];

function roomName(meshName) {
  let m;
  if (meshName === 'Floor_Kitchen') return t('room.Kitchen');
  if (meshName === 'Floor_Bathroom') return t('room.Bathroom');
  if (meshName === 'Floor_Hallway') return t('room.Hallway');
  if ((m = meshName.match(/^Floor_Bedroom_(\d+)$/))) return t('room.Bedroom', { n: m[1] });
  if ((m = meshName.match(/^Floor_Other_(\d+)$/))) return t('room.Other', { n: m[1] });
  if ((m = meshName.match(/^Floor_(.+)$/))) return m[1];
  return meshName;
}

export function init(c) {
  ctx = c;
  ctx.modelHooks.push(onModel);
  ctx.getWalls = () => semantic?.wallsGroup || null;   // editor wall physics

  // semantic models get exact per-room measurement; others fall back to the grid
  document.getElementById('btn-auto').onclick = () => {
    if (semantic) measureSemantic();
    else gridAutoMeasure();
  };

  // persist room renames per floor mesh
  setRenameHandler(r => {
    if (r.meshName) {
      persist.get().roomNames[r.meshName] = r.name;
      persist.save();
    }
  });
}

// mis-scanned "doors" confirmed by the user (e.g. a shoe-cabinet cover)
const DEFAULT_HIDDEN = {
  '8_31_2026.glb': ['Door_2'],
};

function onModel(model) {
  semantic = detect(model);
  if (!semantic) {
    roomCenters.length = 0;
    gridAutoMeasure();   // non-semantic GLBs still get automatic room areas
    return;
  }
  {
    const st = persist.get();
    if (!st.defaultsApplied) {
      for (const name of DEFAULT_HIDDEN[ctx.modelFile] || []) {
        st.scanEdits[name] ||= { deleted: true };
      }
      st.defaultsApplied = true;
      persist.save();
    }
    editor.registerScanObjects(semantic);
    catalog.buildScanSection();
    doors.setup(semantic);
    measureSemantic();
  }
}

function detect(model) {
  const floors = [];
  let wallsGroup = null, doorsGroup = null, objectsRoot = null, ceilingsGroup = null;
  model.traverse(o => {
    if (o.isMesh && /^Floor_/.test(o.name)) floors.push(o);
    else if (o.name === 'Walls') wallsGroup = o;
    else if (o.name === 'Doors') doorsGroup = o;
    else if (o.name === 'Objects') objectsRoot = o;
    else if (o.name === 'Ceilings') ceilingsGroup = o;
  });
  if (!floors.length) return null;
  return { floors, wallsGroup, doorsGroup, objectsRoot, ceilingsGroup };
}

// exact projected XZ area + area-weighted centroid of a mesh's triangles
function meshAreaXZ(mesh) {
  mesh.updateWorldMatrix(true, false);
  const mw = mesh.matrixWorld;
  const pos = mesh.geometry.attributes.position;
  const idx = mesh.geometry.index;
  const count = idx ? idx.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  // floor slabs are baked with both up- and down-facing triangles; summing all
  // would double the area — accumulate per facing and keep the larger side
  const acc = {
    up:   { area: 0, cx: 0, cz: 0, cy: 0 },
    down: { area: 0, cx: 0, cz: 0, cy: 0 },
  };
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mw);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(mw);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(mw);
    // signed XZ cross product distinguishes up- vs down-facing winding
    const s = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
    const t = Math.abs(s) / 2;
    const side = s <= 0 ? acc.up : acc.down;
    side.area += t;
    side.cx += t * (a.x + b.x + c.x) / 3;
    side.cz += t * (a.z + b.z + c.z) / 3;
    side.cy += t * (a.y + b.y + c.y) / 3;
  }
  const best = acc.up.area >= acc.down.area ? acc.up : acc.down;
  const area = best.area;
  let cx = 0, cz = 0, cy = 0;
  if (area > 0) { cx = best.cx / area; cz = best.cz / area; cy = best.cy / area; }
  return { area, centroid: new THREE.Vector3(cx, cy, cz) };
}

// Polycam sometimes splits one real room into several floor pieces; merge map
// folds a piece into its real room (user-confirmed for this scan)
const DEFAULT_MERGES = {
  '8_31_2026.glb': {
    Floor_Other_2: 'Floor_Bedroom_2',   // aynı yatak odasının parçası
    Floor_Other_3: 'Floor_Bathroom',    // banyonun parçası
  },
};

export function measureSemantic() {
  if (!semantic) return;
  clearAuto();

  const merges = DEFAULT_MERGES[ctx.modelFile] || {};
  const groups = new Map();   // primary mesh name -> {meshes:[], area, cx, cz, cy}
  for (const mesh of semantic.floors) {
    const primary = merges[mesh.name] || mesh.name;
    if (!groups.has(primary)) groups.set(primary, { meshes: [], area: 0, cx: 0, cz: 0, cy: 0 });
    const g = groups.get(primary);
    const m = meshAreaXZ(mesh);
    g.meshes.push(mesh);
    g.area += m.area;
    g.cx += m.centroid.x * m.area;
    g.cz += m.centroid.z * m.area;
    g.cy += m.centroid.y * m.area;
  }

  const measured = [...groups.entries()]
    .map(([primary, g]) => ({
      primary, meshes: g.meshes, area: g.area,
      centroid: new THREE.Vector3(g.cx / g.area, g.cy / g.area, g.cz / g.area),
    }))
    .sort((x, y) => y.area - x.area);

  roomCenters.length = 0;
  for (const m of measured) {
    roomCenters.push({ name: m.primary, area: m.area, centroid: m.centroid.clone() });
  }

  const roomNames = persist.get().roomNames;
  let i = 0, total = 0;
  for (const m of measured) {
    const color = COLORS[i % COLORS.length];
    i++;
    total += m.area;

    const group = new THREE.Group();
    // overlay reuses the actual floor geometry (world transforms are identity
    // in Polycam exports; copy the matrix in case they aren't)
    for (const mesh of m.meshes) {
      const overlay = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false
      }));
      overlay.applyMatrix4(mesh.matrixWorld);
      overlay.position.y += 0.015;
      overlay.renderOrder = 996;
      group.add(overlay);
    }

    const labelPos = m.centroid.clone();
    labelPos.y += 0.05;
    group.add(makeTextLabel(m.area.toFixed(2) + ' m²', labelPos, colorHex(color)));
    ctx.scene.add(group);

    addRecord({
      name: roomNames[m.primary] || roomName(m.primary),
      area: m.area, group, color, auto: true, meshName: m.primary,
    });
  }
  ctx.statusEl.textContent = t('status.plan', { n: measured.length, m2: total.toFixed(1) });

  // project-card metadata for the main menu
  persist.get().meta = { area: total, rooms: measured.length, ts: Date.now() };
  persist.save();
}
