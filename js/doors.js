import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as persist from './persist.js';
import * as editor from './editor.js';

// Door tools: place a real door model (Kenney doorway.glb, CC0) onto walls.
// - auto-fix: Bedroom_2 / Bedroom_3 were scanned without doors — place one on
//   their corridor-facing wall via a horizontal raycast (hardcoded fallback)
// - "Kapı Ekle" mode: click any wall to place a door there
let ctx = null;
let sem = null;
let template = null;   // normalized doorway Object3D (bottom-center pivot, faces Z)
let templatePromise = null;

// spawned doorway groups; each has userData.panel (hinged door mesh),
// userData.open and userData.angle for the swing animation
export const doorObjects = [];

export function toggleDoor(door) {
  door.userData.open = !door.userData.open;
}

export function init(c) {
  ctx = c;
  const btn = document.getElementById('btn-door');
  btn.onclick = () => ctx.setMode('door');
  ctx.modeUI.push({
    mode: 'door', button: btn,
    hints: [document.getElementById('hint-door')],
  });
  ctx.pointerHooks.up.push(onPointerUp);
  ctx.tickHooks.push(dt => {
    for (const d of doorObjects) {
      if (!d.parent || !d.userData.panel) continue;
      const target = d.userData.open ? -1.9 : 0;    // ~110° swing
      const a = d.userData.angle ?? 0;
      if (Math.abs(target - a) < 0.001) continue;
      d.userData.angle = a + (target - a) * Math.min(1, dt * 7);
      d.userData.panel.rotation.y = d.userData.angle;
    }
  });
}

function loadTemplate() {
  if (templatePromise) return templatePromise;
  templatePromise = new GLTFLoader().loadAsync('assets/furniture/doorway.glb').then(gltf => {
    const inner = gltf.scene;
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    // orient so width spans X (door plane faces Z), then scale to 2.05 m height
    if (size.x < size.z) inner.rotateY(Math.PI / 2);
    const s = 2.05 / (size.y || 1);
    inner.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(inner);
    const center = box2.getCenter(new THREE.Vector3());
    inner.position.sub(new THREE.Vector3(center.x, box2.min.y, center.z));
    const root = new THREE.Group();
    root.add(inner);
    template = root;
    return root;
  });
  return templatePromise;
}

// called by semantic.js once the model structure is known
export function setup(semantic) {
  sem = semantic;
  const st = persist.get();
  if (st.doorsVersion !== 4) {
    // v3: scan's flat white door quads replaced by the real door model;
    // v4: auto doors regenerated with opening width for the wall-fill panel
    st.doors = st.doors.filter(d => !d.auto);
    st.doorsVersion = 4;
    for (const [name, node] of editor.scanByName) {
      if (!name.startsWith('Door_')) continue;
      if (st.scanEdits[name]?.deleted) continue;
      const size = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3());
      st.scanEdits[name] = { deleted: true };
      node.visible = false;
      st.doors.push({
        pos: node.position.toArray(),
        rotY: size.x < size.z ? Math.PI / 2 : 0,
        fromScan: name,
      });
    }
    persist.save();
  }
  loadTemplate().then(() => {
    for (const rec of st.doors) spawnDoor(rec);
    if (!st.doors.some(d => d.auto)) autoFix();
  }).catch(() => { ctx.statusEl.textContent = 'Kapı modeli yüklenemedi'; });
}

const fillMaterial = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.9 });

function spawnDoor(rec) {
  const m = template.clone(true);
  m.position.fromArray(rec.pos);
  m.rotation.y = rec.rotY || 0;
  m.userData = {
    label: 'Kapı', rec, recList: persist.get().doors, sharedGeo: true,
  };
  // auto doors sit in a full-height scan hole — back the frame with a wall
  // panel that fills the opening above and beside the door
  if (rec.auto && rec.opening) {
    // fill the scan hole around the frame but leave the doorway itself open
    const wallH = (ctx.modelBox.max.y - ctx.modelBox.min.y) - 0.15;
    const fillW = rec.opening + 0.25;
    const frameW = 0.99, frameH = 2.06;
    const lintelH = wallH - frameH;
    if (lintelH > 0.02) {
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(fillW, lintelH, 0.12), fillMaterial);
      lintel.position.set(0, frameH + lintelH / 2, -0.03);
      m.add(lintel);
    }
    const sideW = (fillW - frameW) / 2;
    if (sideW > 0.02) {
      for (const s of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(sideW, frameH, 0.12), fillMaterial);
        strip.position.set(s * (frameW / 2 + sideW / 2), frameH / 2, -0.03);
        m.add(strip);
      }
    }
  }
  // hinged panel for the walk mode ("door" node origin sits on the hinge)
  let panel = null;
  m.traverse(o => { if (!panel && o.name === 'door') panel = o; });
  m.userData.panel = panel;
  m.userData.open = false;
  m.userData.angle = 0;
  doorObjects.push(m);
  ctx.scene.add(m);
  editor.register(m);
  return m;
}

function placeDoor(point, normal, auto = false, opening = null) {
  const rec = {
    pos: [point.x + normal.x * 0.015, ctx.modelBox.min.y, point.z + normal.z * 0.015],
    rotY: Math.atan2(normal.x, normal.z),
    auto,
  };
  if (auto) rec.opening = opening || 1.0;
  persist.get().doors.push(rec);
  persist.save();
  return spawnDoor(rec);
}

// horizontal ray against the Walls meshes; returns {point, normal(toward origin)}
function castToWall(origin, dir, far = 10) {
  if (!sem?.wallsGroup) return null;
  const ray = new THREE.Raycaster(origin, dir.clone().normalize(), 0.05, far);
  const hits = ray.intersectObject(sem.wallsGroup, true);
  for (const h of hits) {
    if (!h.face) continue;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    if (Math.abs(n.y) > 0.3) continue;             // not a vertical face
    if (n.dot(dir) > 0) n.negate();                // face the ray origin (room side)
    return { point: h.point, normal: n };
  }
  return null;
}

// The scanned doorway is a hole in the wall: sweep rays along the wall line,
// find the widest run of misses (the opening) and center the door in it.
// sweep: which coordinate the ray origins iterate over ('x' or 'z');
// fixed: the other origin coordinate; dir: ray direction toward the wall.
function findOpening({ sweep, fixed, from, to, dir, maxDist }) {
  const y = ctx.modelBox.min.y + 1.0;
  const d = dir.clone().normalize();
  const hitCoords = [];
  const misses = [];
  for (let t = from; t <= to + 1e-6; t += 0.1) {
    const origin = sweep === 'z'
      ? new THREE.Vector3(fixed, y, t)
      : new THREE.Vector3(t, y, fixed);
    const hit = castToWall(origin, d, maxDist);
    if (hit) hitCoords.push(sweep === 'z' ? hit.point.x : hit.point.z);
    else misses.push(t);
  }
  if (!misses.length || !hitCoords.length) return null;
  let best = null, start = misses[0], prev = misses[0];
  for (let i = 1; i <= misses.length; i++) {
    const t = misses[i];
    if (t !== undefined && t - prev < 0.15) { prev = t; continue; }
    const band = { mid: (start + prev) / 2, width: prev - start };
    if (!best || band.width > best.width) best = band;
    if (t !== undefined) { start = t; prev = t; }
  }
  const wallCoord = hitCoords.reduce((s, v) => s + v, 0) / hitCoords.length;
  const floorY = ctx.modelBox.min.y;
  const point = sweep === 'z'
    ? new THREE.Vector3(wallCoord, floorY, best.mid)
    : new THREE.Vector3(best.mid, floorY, wallCoord);
  return { point, normal: d.clone().negate(), width: best.width + 0.1 };
}

// User-confirmed layout: Bedroom_2 + Other_2 form ONE room whose door sits on
// the wall to the Other_1 corridor (z≈−0.11, x 2.11–3.26). Bedroom_3's door is
// on its west wall to the same corridor (x≈3.53, z −1.54–−0.41).
function autoFix() {
  const floorY = ctx.modelBox.min.y;
  const targets = [
    { sweep: 'x', fixed: 0.6, from: 2.15, to: 3.2, dir: new THREE.Vector3(0, 0, -1), maxDist: 1.2,
      fallback: { point: new THREE.Vector3(2.7, floorY, -0.11), normal: new THREE.Vector3(0, 0, 1) } },
    { sweep: 'z', fixed: 4.6, from: -3.4, to: -0.55, dir: new THREE.Vector3(-1, 0, 0), maxDist: 1.4,
      fallback: { point: new THREE.Vector3(3.53, floorY, -0.98), normal: new THREE.Vector3(1, 0, 0) } },
  ];
  for (const t of targets) {
    const hit = findOpening(t) || t.fallback;
    placeDoor(hit.point, hit.normal, true, hit.width);
  }
  ctx.statusEl.textContent = 'Eksik kapılar eklendi: Yatak Odası 2 ve 3 (Düzenle modunda taşınabilir)';
}

function onPointerUp(ev) {
  if (ctx.mode !== 'door' || !ev._isClick || !template) return false;
  if (!ctx.model) return false;
  ctx.setNDC(ev);
  const hits = ctx.raycaster.intersectObject(ctx.model, true);
  for (const h of hits) {
    if (!h.face || !h.object.visible) continue;
    if (h.point.y > ctx.clipPlane.constant) continue;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    if (Math.abs(n.y) > 0.3) continue;             // walls only
    if (n.dot(ctx.raycaster.ray.direction) > 0) n.negate();  // face the camera
    const door = placeDoor(h.point, n);
    editor.select(door);
    return true;
  }
  return true;   // consume the click even on a miss while in door mode
}
