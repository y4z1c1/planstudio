import * as THREE from 'three';

// Outdoor environment: sky dome, grass, trees, flowers, butterflies — plus
// real window models (frame + glass) replacing the scan's empty window quads.
let ctx = null;
let group = null;          // everything toggled together
let enabled = true;
const butterflies = [];
let skyDome = null;
let fog = null;

export function init(c) {
  ctx = c;
  const btn = document.getElementById('btn-env');
  btn.onclick = () => {
    enabled = !enabled;
    apply();
    btn.classList.toggle('active', enabled);
  };
  btn.classList.add('active');
  ctx.modelHooks.push(build);
  ctx.tickHooks.push(tick);
}

function apply() {
  if (group) group.visible = enabled;
  if (skyDome) skyDome.visible = enabled;
  ctx.grid.visible = !enabled;
  ctx.scene.fog = enabled ? fog : null;
  ctx.scene.background = enabled ? new THREE.Color(0xbfdcf0) : new THREE.Color(0x16181d);
}

function build(model) {
  // rebuild per model
  if (group) { ctx.scene.remove(group); }
  if (skyDome) { ctx.scene.remove(skyDome); }
  butterflies.length = 0;
  group = new THREE.Group();
  const box = ctx.modelBox;
  const c = box.getCenter(new THREE.Vector3());
  const floorY = box.min.y;

  replaceWindows(model);

  // ---- sky dome (vertical gradient) ----
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 256;
  const g2d = canvas.getContext('2d');
  const grad = g2d.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#5d9be0');
  grad.addColorStop(0.6, '#a8cdf0');
  grad.addColorStop(1, '#e8f4fd');
  g2d.fillStyle = grad;
  g2d.fillRect(0, 0, 1, 256);
  const skyTex = new THREE.CanvasTexture(canvas);
  skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(90, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
  );
  skyDome.position.copy(c);
  ctx.scene.add(skyDome);
  fog = new THREE.Fog(0xcfe4f5, 45, 88);

  // ---- grass ----
  const grass = new THREE.Mesh(
    new THREE.CircleGeometry(60, 48),
    new THREE.MeshStandardMaterial({ color: 0x74a95e, roughness: 1 })
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(c.x, floorY - 0.03, c.z);
  group.add(grass);

  // ---- trees ----
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7d5a3a, roughness: 1 });
  const leafColors = [0x4e8c46, 0x5fa050, 0x3f7a3a, 0x6db05a];
  for (let i = 0; i < 26; i++) {
    const p = randOutside(box, c, 3, 30);
    if (!p) continue;
    const t = new THREE.Group();
    const h = 1.1 + Math.random() * 1.6;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, h, 6), trunkMat);
    trunk.position.y = h / 2;
    t.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({
      color: leafColors[(Math.random() * leafColors.length) | 0], roughness: 1
    });
    const layers = 2 + ((Math.random() * 2) | 0);
    for (let l = 0; l < layers; l++) {
      const r = 0.9 - l * 0.22;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, 1.1, 7), leafMat);
      cone.position.y = h + l * 0.55;
      t.add(cone);
    }
    t.position.set(p.x, floorY, p.z);
    t.rotation.y = Math.random() * Math.PI;
    group.add(t);
  }

  // ---- flowers ----
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x4d7a3f });
  const petalColors = [0xe86a6a, 0xf0c04a, 0xd777e0, 0xf08a3c, 0xffffff, 0x7a9df0];
  for (let i = 0; i < 70; i++) {
    const p = randOutside(box, c, 0.6, 14);
    if (!p) continue;
    const f = new THREE.Group();
    const h = 0.12 + Math.random() * 0.18;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, h, 4), stemMat);
    stem.position.y = h / 2;
    f.add(stem);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.035 + Math.random() * 0.02, 6, 5),
      new THREE.MeshStandardMaterial({ color: petalColors[(Math.random() * petalColors.length) | 0], roughness: 0.8 })
    );
    head.position.y = h;
    f.add(head);
    f.position.set(p.x, floorY, p.z);
    group.add(f);
  }

  // ---- butterflies ----
  for (let i = 0; i < 7; i++) {
    const b = new THREE.Group();
    const color = petalColors[(Math.random() * petalColors.length) | 0];
    const wingGeo = new THREE.CircleGeometry(0.06, 6);
    const wingMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const w1 = new THREE.Mesh(wingGeo, wingMat);
    const w2 = new THREE.Mesh(wingGeo, wingMat);
    w1.position.x = 0.05; w2.position.x = -0.05;
    b.add(w1, w2);
    const p = randOutside(box, c, 1, 12) || { x: c.x + 5, z: c.z + 5 };
    b.userData = {
      w1, w2,
      cx: p.x, cz: p.z, r: 1 + Math.random() * 2.5,
      h: floorY + 0.6 + Math.random() * 1.6,
      speed: 0.3 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
    };
    group.add(b);
    butterflies.push(b);
  }

  ctx.scene.add(group);
  apply();
}

// random point outside the (slightly expanded) house bbox, within maxDist of it
function randOutside(box, c, minGap, maxDist) {
  for (let tries = 0; tries < 12; tries++) {
    const x = c.x + (Math.random() * 2 - 1) * ((box.max.x - box.min.x) / 2 + maxDist);
    const z = c.z + (Math.random() * 2 - 1) * ((box.max.z - box.min.z) / 2 + maxDist);
    const inX = x > box.min.x - minGap && x < box.max.x + minGap;
    const inZ = z > box.min.z - minGap && z < box.max.z + minGap;
    if (!(inX && inZ)) return { x, z };
  }
  return null;
}

// ---- window replacement: frame + translucent glass sized per scan quad ----
const frameMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.6 });
const glassMat = new THREE.MeshStandardMaterial({
  color: 0xaed3ea, transparent: true, opacity: 0.32,
  side: THREE.DoubleSide, roughness: 0.15, metalness: 0.1,
});

function replaceWindows(model) {
  let windowsGroup = null;
  model.traverse(o => { if (o.name === 'Windows') windowsGroup = o; });
  if (!windowsGroup) return;
  for (const node of [...windowsGroup.children]) {
    const bb = new THREE.Box3().setFromObject(node);
    const size = bb.getSize(new THREE.Vector3());
    const center = bb.getCenter(new THREE.Vector3());
    const w = Math.max(size.x, size.z);
    const h = size.y;
    if (w < 0.2 || h < 0.2) continue;
    node.visible = false;
    const win = buildWindow(w, h);
    win.position.copy(center);
    if (size.x < size.z) win.rotation.y = Math.PI / 2;
    group.add(win);
  }
}

function buildWindow(w, h) {
  const g = new THREE.Group();
  const T = 0.06, D = 0.09;
  const bar = (bw, bh, x, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, D), frameMat);
    m.position.set(x, y, 0);
    g.add(m);
  };
  bar(w, T, 0, h / 2 - T / 2);        // top
  bar(w, T, 0, -h / 2 + T / 2);       // bottom
  bar(T, h, -w / 2 + T / 2, 0);       // left
  bar(T, h, w / 2 - T / 2, 0);        // right
  bar(T * 0.8, h, 0, 0);              // center mullion
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - T * 1.6, h - T * 1.6), glassMat);
  g.add(glass);
  return g;
}

function tick(dt) {
  if (!enabled || !butterflies.length) return;
  const t = performance.now() / 1000;
  for (const b of butterflies) {
    const u = b.userData;
    const a = t * u.speed + u.phase;
    b.position.set(
      u.cx + Math.cos(a) * u.r,
      u.h + Math.sin(t * 1.7 + u.phase) * 0.25,
      u.cz + Math.sin(a) * u.r,
    );
    b.rotation.y = -a;
    const flap = Math.sin(t * 14 + u.phase) * 0.9;
    u.w1.rotation.y = flap;
    u.w2.rotation.y = -flap;
  }
}
