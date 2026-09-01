import * as THREE from 'three';
import * as semantic from './semantic.js';
import { t } from './i18n.js';

// Parquet floors: a procedural oak-plank texture applied to the scan's
// Floor_* meshes (their scan texture is kept and restored on toggle).
// UVs are generated from world XZ so plank scale is metric (2 m tile).
let ctx = null;
let on = false;
let btn = null;
let texture = null;
const original = new Map();   // mesh -> its scan material
const PREF = 'ps:parquet';

export function init(c) {
  ctx = c;
  btn = document.getElementById('btn-parquet');
  btn.onclick = toggle;
  ctx.modelHooks.push(() => {
    on = false;
    original.clear();
    btn.classList.remove('active');
    let pref = false;
    try { pref = localStorage.getItem(PREF) === '1'; } catch {}
    if (pref) toggle();
  });
}

function toggle() {
  const sem = semantic.semantic;
  if (!sem?.floors?.length) {
    ctx.statusEl.textContent = t('status.noFloors');
    return;
  }
  on = !on;
  btn.classList.toggle('active', on);
  try { localStorage.setItem(PREF, on ? '1' : '0'); } catch {}
  if (on) {
    if (!texture) texture = makeTexture();
    for (const mesh of sem.floors) {
      if (!original.has(mesh)) original.set(mesh, mesh.material);
      ensureWorldUVs(mesh);
      mesh.material = new THREE.MeshStandardMaterial({
        map: texture, roughness: 0.75, metalness: 0, side: THREE.DoubleSide,
      });
    }
  } else {
    for (const [mesh, mat] of original) {
      mesh.material.dispose();
      mesh.material = mat;
    }
    original.clear();
  }
}

// planar UVs from world position: 1 uv unit = 2 m (the texture tile)
function ensureWorldUVs(mesh) {
  if (mesh.userData.parquetUV) return;
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  mesh.updateWorldMatrix(true, false);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    uv[i * 2] = v.x / 2;
    uv[i * 2 + 1] = v.z / 2;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  mesh.userData.parquetUV = true;
}

// deterministic PRNG so the pattern is stable between sessions
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t2 = Math.imul(a ^ (a >>> 15), 1 | a);
    t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2;
    return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296;
  };
}

// 1024px canvas = 2 m × 2 m: 10 plank rows (20 cm wide), staggered joints,
// warm oak tones with light grain streaks; horizontally tileable
function makeTexture() {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rnd = mulberry32(7);
  const tones = ['#b28457', '#a67a4e', '#bc8d60', '#a1744a', '#b78a5c', '#ab7f52', '#c29366'];
  const rows = 10, rowH = S / rows;

  g.fillStyle = '#8a6240';           // seam color under everything
  g.fillRect(0, 0, S, S);

  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    let x = -rnd() * S * 0.8;        // random row offset = staggered joints
    while (x < S) {
      const len = (0.45 + rnd() * 0.5) * S;
      const tone = tones[(rnd() * tones.length) | 0];
      // draw twice so planks crossing the tile edge wrap seamlessly
      for (const dx of [0, -S]) {
        g.fillStyle = tone;
        g.fillRect(x + dx + 2, y + 2, len - 4, rowH - 4);
        // subtle grain streaks along the plank
        g.globalAlpha = 0.12;
        for (let s = 0; s < 6; s++) {
          g.fillStyle = rnd() > 0.5 ? '#ffffff' : '#3d2a18';
          const sy = y + 4 + rnd() * (rowH - 10);
          g.fillRect(x + dx + 4 + rnd() * len * 0.5, sy, len * (0.2 + rnd() * 0.5), 1 + rnd() * 2);
        }
        g.globalAlpha = 1;
      }
      x += len;
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
  return tex;
}
