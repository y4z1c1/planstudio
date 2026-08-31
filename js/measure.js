import * as THREE from 'three';
import { COLORS, colorHex, makeMarker, makeLine, makeTextLabel, polygonAreaXZ, centroid } from './utils.js';
import { rooms, counters, addRecord, clearAuto, updateResults } from './results.js';

let ctx = null;
let currentPoints = [];
let tempGroup = null;
let liveLabel = null;

export function init(c) {
  ctx = c;
  tempGroup = new THREE.Group();
  ctx.scene.add(tempGroup);
  liveLabel = document.getElementById('live-label');

  const btnArea = document.getElementById('btn-area');
  const btnDist = document.getElementById('btn-dist');
  btnArea.onclick = () => ctx.setMode('area');
  btnDist.onclick = () => ctx.setMode('dist');
  ctx.modeUI.push(
    { mode: 'area', button: btnArea, hints: [document.getElementById('hint-area')] },
    { mode: 'dist', button: btnDist, hints: [document.getElementById('hint-dist')] },
  );

  document.getElementById('btn-auto').onclick = autoMeasure;

  ctx.pointerHooks.move.push(onPointerMove);
  ctx.pointerHooks.up.push(onPointerUp);
  ctx.dblHooks.push(() => {
    if (ctx.mode === 'area' && currentPoints.length >= 3) { finishArea(); return true; }
    return false;
  });
  ctx.keyHooks.push(onKey);
}

export function cancelCurrent() {
  currentPoints = [];
  tempGroup.clear();
  liveLabel.style.display = 'none';
}

function redrawTemp() {
  tempGroup.clear();
  const color = ctx.mode === 'area' ? 0xf0b429 : 0x2fc4d9;
  currentPoints.forEach((p, i) => {
    tempGroup.add(makeMarker(p, i === 0 && ctx.mode === 'area' ? 0xe5534b : color));
  });
  if (currentPoints.length > 1) tempGroup.add(makeLine(currentPoints, color));
}

function onPointerMove(ev) {
  if ((ctx.mode !== 'area' && ctx.mode !== 'dist') || currentPoints.length === 0) {
    liveLabel.style.display = 'none';
    return false;
  }
  const hp = ctx.pickPoint(ev);
  if (!hp) { liveLabel.style.display = 'none'; return false; }
  liveLabel.style.display = 'block';
  liveLabel.style.left = ev.clientX + 'px';
  liveLabel.style.top = ev.clientY + 'px';
  if (ctx.mode === 'dist') {
    liveLabel.textContent = currentPoints[0].distanceTo(hp).toFixed(2) + ' m';
  } else {
    const preview = [...currentPoints, hp];
    liveLabel.textContent = preview.length >= 3
      ? polygonAreaXZ(preview).toFixed(2) + ' m²'
      : currentPoints[currentPoints.length - 1].distanceTo(hp).toFixed(2) + ' m';
  }
  return false;
}

function onPointerUp(ev) {
  if (!ev._isClick) return false;
  if (ctx.mode === 'dist') {
    const p = ctx.pickPoint(ev);
    if (!p) return true;
    currentPoints.push(p);
    redrawTemp();
    if (currentPoints.length === 2) finishDistance();
    return true;
  }
  if (ctx.mode === 'area') {
    const p = ctx.pickPoint(ev);
    if (!p) return true;
    if (currentPoints.length >= 3 && ctx.worldToScreenDist(currentPoints[0], p) < 20) {
      finishArea();
      return true;
    }
    currentPoints.push(p);
    redrawTemp();
    return true;
  }
  return false;
}

function onKey(ev) {
  if (ev.key === 'Escape') { cancelCurrent(); return false; } // others may also react to Esc
  if (ev.key === 'Enter' && ctx.mode === 'area' && currentPoints.length >= 3) { finishArea(); return true; }
  if (ev.key === 'Backspace' && (ctx.mode === 'area' || ctx.mode === 'dist') && currentPoints.length) {
    ev.preventDefault();
    currentPoints.pop();
    redrawTemp();
    return true;
  }
  return false;
}

function finishDistance() {
  const [a, b] = currentPoints;
  const d = a.distanceTo(b);
  counters.dist++;
  const color = 0x2fc4d9;
  const group = new THREE.Group();
  group.add(makeMarker(a, color), makeMarker(b, color), makeLine([a, b], color));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  group.add(makeTextLabel(d.toFixed(2) + ' m', mid, '#2fc4d9'));
  ctx.scene.add(group);
  addRecord({ name: `Mesafe ${counters.dist}`, area: null, dist: d, group, color });
  cancelCurrent();
}

function finishArea() {
  const pts = currentPoints.slice();
  const area = polygonAreaXZ(pts);
  counters.room++;
  const color = COLORS[(counters.room - 1) % COLORS.length];
  const avgY = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  const group = new THREE.Group();
  pts.forEach(p => group.add(makeMarker(p, color, 0.03)));
  group.add(makeLine(pts, color, true));
  const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.z)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthTest: false
  }));
  mesh.position.y = avgY + 0.01;
  mesh.renderOrder = 997;
  group.add(mesh);
  const c = centroid(pts);
  c.y = avgY + 0.05;
  group.add(makeTextLabel(area.toFixed(2) + ' m²', c, colorHex(color)));
  ctx.scene.add(group);
  addRecord({ name: `Oda ${counters.room}`, area, group, color });
  cancelCurrent();
}

// ---------- grid-based automatic measurement (fallback for non-semantic GLBs) ----------
// 1. rasterize upward-facing floor triangles into a 5 cm XZ grid
// 2. rasterize vertical (wall) triangles into the same grid
// 3. dilate walls ~45 cm to seal door openings, flood-fill room seeds
// 4. grow seeds back over the full floor (not crossing real walls)
export function autoMeasure() {
  const model = ctx.model;
  if (!model) return;
  clearAuto();

  const CELL = 0.05;
  const box = ctx.modelBox;
  const nx = Math.ceil((box.max.x - box.min.x) / CELL) + 2;
  const nz = Math.ceil((box.max.z - box.min.z) / CELL) + 2;
  const gx = x => Math.floor((x - box.min.x) / CELL) + 1;
  const gz = z => Math.floor((z - box.min.z) / CELL) + 1;
  const wx = i => box.min.x + (i - 1 + 0.5) * CELL;
  const wz = j => box.min.z + (j - 1 + 0.5) * CELL;
  const idxOf = (i, j) => j * nx + i;

  const floorMask = new Uint8Array(nx * nz);
  const wallMask = new Uint8Array(nx * nz);
  const floorY = new Float32Array(nx * nz);

  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  let minY = Infinity;
  const floorTris = [], wallTris = [];
  model.updateWorldMatrix(true, true);
  model.traverse(o => {
    if (!o.isMesh || o.visible === false) return;
    const pos = o.geometry.attributes.position;
    const idx = o.geometry.index;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k;
        v[k].fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
      }
      e1.subVectors(v[1], v[0]);
      e2.subVectors(v[2], v[0]);
      n.crossVectors(e1, e2);
      const len = n.length();
      if (len < 1e-10) continue;
      n.divideScalar(len);
      const t = { a: v[0].clone(), b: v[1].clone(), c: v[2].clone() };
      if (n.y > 0.7) {
        floorTris.push(t);
        minY = Math.min(minY, t.a.y, t.b.y, t.c.y);
      } else if (Math.abs(n.y) < 0.5) {
        wallTris.push(t);
      }
    }
  });
  if (!floorTris.length) { ctx.statusEl.textContent = 'Otomatik ölçüm: zemin bulunamadı'; return; }

  function rasterize(t, mask, yStore) {
    const xs = [t.a.x, t.b.x, t.c.x], zs = [t.a.z, t.b.z, t.c.z];
    const i0 = Math.max(1, gx(Math.min(...xs))), i1 = Math.min(nx - 2, gx(Math.max(...xs)));
    const j0 = Math.max(1, gz(Math.min(...zs))), j1 = Math.min(nz - 2, gz(Math.max(...zs)));
    const [ax, az] = [t.a.x, t.a.z], [bx, bz] = [t.b.x, t.b.z], [cx, cz] = [t.c.x, t.c.z];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    const degenerate = Math.abs(d) < 1e-9;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!degenerate) {
          const px = wx(i), pz = wz(j);
          const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d;
          const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d;
          const l3 = 1 - l1 - l2;
          if (l1 < -0.15 || l2 < -0.15 || l3 < -0.15) continue;
        }
        mask[idxOf(i, j)] = 1;
        if (yStore) yStore[idxOf(i, j)] = (t.a.y + t.b.y + t.c.y) / 3;
      }
    }
  }

  floorTris.forEach(t => {
    if ((t.a.y + t.b.y + t.c.y) / 3 < minY + 0.25) rasterize(t, floorMask, floorY);
  });
  wallTris.forEach(t => {
    const top = Math.max(t.a.y, t.b.y, t.c.y);
    const bot = Math.min(t.a.y, t.b.y, t.c.y);
    if (top > minY + 1.2 && bot < minY + 1.0) rasterize(t, wallMask, null);
  });

  const DILATE = 9;
  const dist = new Int16Array(nx * nz).fill(-1);
  const q = [];
  for (let c = 0; c < nx * nz; c++) if (wallMask[c]) { dist[c] = 0; q.push(c); }
  let qh = 0;
  while (qh < q.length) {
    const c = q[qh++];
    if (dist[c] >= DILATE) continue;
    const ci = c % nx, cj = (c / nx) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i2 = ci + di, j2 = cj + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= nz) continue;
      const c2 = idxOf(i2, j2);
      if (dist[c2] === -1) { dist[c2] = dist[c] + 1; q.push(c2); }
    }
  }
  const dilated = c => dist[c] !== -1;

  const label = new Int32Array(nx * nz).fill(0);
  let nLabels = 0;
  for (let c = 0; c < nx * nz; c++) {
    if (!floorMask[c] || dilated(c) || label[c]) continue;
    nLabels++;
    const stack = [c];
    label[c] = nLabels;
    while (stack.length) {
      const cc = stack.pop();
      const ci = cc % nx, cj = (cc / nx) | 0;
      for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const i2 = ci + di, j2 = cj + dj;
        if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= nz) continue;
        const c2 = idxOf(i2, j2);
        if (floorMask[c2] && !dilated(c2) && !label[c2]) { label[c2] = nLabels; stack.push(c2); }
      }
    }
  }

  const q2 = [];
  for (let c = 0; c < nx * nz; c++) if (label[c]) q2.push(c);
  qh = 0;
  while (qh < q2.length) {
    const c = q2[qh++];
    const ci = c % nx, cj = (c / nx) | 0;
    for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const i2 = ci + di, j2 = cj + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= nz) continue;
      const c2 = idxOf(i2, j2);
      if (floorMask[c2] && !wallMask[c2] && !label[c2]) { label[c2] = label[c]; q2.push(c2); }
    }
  }

  const cellArea = CELL * CELL;
  const stats = new Map();
  for (let c = 0; c < nx * nz; c++) {
    const L = label[c];
    if (!L) continue;
    if (!stats.has(L)) stats.set(L, { count: 0, sx: 0, sz: 0, sy: 0, cells: [] });
    const s = stats.get(L);
    s.count++;
    s.sx += wx(c % nx); s.sz += wz((c / nx) | 0); s.sy += floorY[c];
    s.cells.push(c);
  }

  const regions = [...stats.entries()]
    .map(([L, s]) => ({ L, area: s.count * cellArea, s }))
    .filter(r => r.area > 1.0)
    .sort((a, b) => b.area - a.area);

  let ci2 = 0;
  regions.forEach(r => {
    ci2++;
    const color = COLORS[(ci2 - 1) % COLORS.length];
    const group = new THREE.Group();
    const cells = r.s.cells;
    const verts = new Float32Array(cells.length * 18);
    let o = 0;
    for (const c of cells) {
      const x0 = wx(c % nx) - CELL / 2, z0 = wz((c / nx) | 0) - CELL / 2;
      const x1 = x0 + CELL, z1 = z0 + CELL;
      const y = (floorY[c] || minY) + 0.02;
      verts.set([x0,y,z0, x1,y,z0, x1,y,z1,  x0,y,z0, x1,y,z1, x0,y,z1], o);
      o += 18;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false
    }));
    mesh.renderOrder = 996;
    group.add(mesh);
    const cx = r.s.sx / r.s.count, cz = r.s.sz / r.s.count, cy = r.s.sy / r.s.count;
    group.add(makeTextLabel(r.area.toFixed(2) + ' m²',
      new THREE.Vector3(cx, cy + 0.05, cz), colorHex(color)));
    ctx.scene.add(group);
    rooms.push({ name: `Oda ${ci2}`, area: r.area, group, color, auto: true });
  });

  updateResults();
  const total = regions.reduce((s, r) => s + r.area, 0);
  ctx.statusEl.textContent = `Otomatik: ${regions.length} oda, net ${total.toFixed(1)} m² zemin`;
}
