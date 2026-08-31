import * as THREE from 'three';
import * as persist from './persist.js';
import * as editor from './editor.js';
import { t } from './i18n.js';

// Sunlight simulator: real solar position (NOAA algorithm) for the flat's
// actual coordinates, cast through the window openings with shadows.
// The scan isn't north-aligned, so a "north" dial (persisted per project)
// lets the user orient the building; date + time-of-day sliders drive the sun.
let ctx = null;
let active = false;
let sunLight = null;
let sunTarget = null;
let savedLights = null;
let savedCeiling = false;
let btn = null, panel = null;
let dateInput, timeInput, northInput, infoEl, timeLabel;

const TZ = 3;   // Türkiye (UTC+3, no DST)
const LOCATIONS = {
  'nisantasi-1p1.glb': { lat: 41.0557574, lon: 28.9916382 },   // maps.app.goo.gl/DPXrF936TUXh2RhS6
};
const DEFAULT_LOC = { lat: 41.05, lon: 28.99 };                // İstanbul

export function init(c) {
  ctx = c;
  btn = document.getElementById('btn-sun');
  panel = document.getElementById('sun-panel');
  dateInput = document.getElementById('sun-date');
  timeInput = document.getElementById('sun-time');
  northInput = document.getElementById('sun-north');
  infoEl = document.getElementById('sun-info');
  timeLabel = document.getElementById('sun-time-label');

  dateInput.value = new Date().toISOString().slice(0, 10);
  timeInput.value = '13';

  btn.onclick = () => (active ? disable() : enable());
  dateInput.addEventListener('input', update);
  timeInput.addEventListener('input', update);
  northInput.addEventListener('input', () => {
    persist.get().sun = { north: +northInput.value };
    persist.save();
    update();
  });
  [dateInput, timeInput, northInput].forEach(el =>
    el.addEventListener('keydown', ev => ev.stopPropagation()));

  ctx.cleanupHooks.push(() => { if (active) disable(); });
}

function location() {
  return LOCATIONS[ctx.modelFile] || DEFAULT_LOC;
}

function enable() {
  if (!ctx.model) return;
  active = true;
  btn.classList.add('active');
  panel.classList.add('show');
  northInput.value = persist.get().sun?.north ?? 0;

  // sunlight only through the windows: ceiling back on, base lights dimmed
  savedCeiling = ctx.getCeiling ? ctx.getCeiling() : false;
  if (ctx.setCeiling) ctx.setCeiling(false);
  savedLights = {
    ambient: ctx.lights.ambient.intensity,
    dir: ctx.lights.dir.intensity,
    dir2: ctx.lights.dir2.intensity,
  };
  ctx.lights.ambient.intensity = 0.45;
  ctx.lights.dir.intensity = 0.15;
  ctx.lights.dir2.intensity = 0.1;

  if (!sunLight) {
    sunLight = new THREE.DirectionalLight(0xfff2dd, 3.2);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.bias = -0.0004;
    sunTarget = new THREE.Object3D();
    ctx.scene.add(sunTarget);
    sunLight.target = sunTarget;
    ctx.scene.add(sunLight);
  }
  const box = ctx.modelBox;
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.z) * 0.75;
  const cam = sunLight.shadow.camera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
  cam.near = 1; cam.far = 120;
  cam.updateProjectionMatrix();
  sunLight.visible = true;

  markShadows();
  update();
}

function disable() {
  active = false;
  btn.classList.remove('active');
  panel.classList.remove('show');
  if (sunLight) sunLight.visible = false;
  if (savedLights) {
    ctx.lights.ambient.intensity = savedLights.ambient;
    ctx.lights.dir.intensity = savedLights.dir;
    ctx.lights.dir2.intensity = savedLights.dir2;
  }
  if (ctx.setCeiling) ctx.setCeiling(savedCeiling);
}

// every opaque mesh casts + receives; glass (transparent) only receives
function markShadows() {
  const mark = root => root.traverse(o => {
    if (!o.isMesh) return;
    const transparent = o.material?.transparent && (o.material.opacity ?? 1) < 0.6;
    o.castShadow = !transparent;
    o.receiveShadow = true;
  });
  if (ctx.model) mark(ctx.model);
  for (const p of editor.placed) if (p.parent) mark(p);
}

// ---------- solar position (NOAA simplified, good to ~0.1°) ----------
function solar(lat, lon, date, hourLocal) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const day = (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000;
  const g = (2 * Math.PI / 365) * (day - 1 + (hourLocal - 12) / 24);
  // equation of time (minutes) & declination (rad)
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const timeOffset = eot + 4 * lon - 60 * TZ;                 // minutes
  const tst = hourLocal * 60 + timeOffset;                    // true solar time
  const ha = (tst / 4 - 180) * rad;                           // hour angle
  const phi = lat * rad;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(sinEl);
  let az = Math.acos(
    (Math.sin(decl) - sinEl * Math.sin(phi)) / (Math.cos(el) * Math.cos(phi) || 1e-9));
  if (ha > 0) az = 2 * Math.PI - az;                          // afternoon → west of north
  // sunrise/sunset (local hours)
  const cosH0 = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(decl)) /
    (Math.cos(phi) * Math.cos(decl));
  let rise = null, set = null;
  if (Math.abs(cosH0) <= 1) {
    const h0 = Math.acos(cosH0) / rad;                        // degrees
    const noon = (720 - 4 * lon + 60 * TZ - eot) / 60;
    rise = noon - h0 / 15;
    set = noon + h0 / 15;
  }
  return { el, az, rise, set, noonEl: Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl)) };
}

const fmtH = h => {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

function update() {
  if (!active) return;
  const { lat, lon } = location();
  const hour = +timeInput.value;
  timeLabel.textContent = fmtH(hour);
  const date = new Date(dateInput.value + 'T12:00:00');
  const s = solar(lat, lon, date, hour);
  const north = (+northInput.value || 0) * Math.PI / 180;

  const box = ctx.modelBox;
  const c = box.getCenter(new THREE.Vector3());
  sunTarget.position.copy(c);

  const elDeg = s.el * 180 / Math.PI;
  if (elDeg <= 0) {
    sunLight.intensity = 0;
    ctx.lights.ambient.intensity = 0.18;   // night
  } else {
    sunLight.intensity = 3.2 * Math.min(1, 0.15 + elDeg / 30);
    ctx.lights.ambient.intensity = 0.45;
    const worldAz = s.az + north;
    const R = Math.max(box.getSize(new THREE.Vector3()).x, 20) * 1.6;
    sunLight.position.set(
      c.x + Math.sin(worldAz) * Math.cos(s.el) * R,
      c.y + Math.sin(s.el) * R,
      c.z + Math.cos(worldAz) * Math.cos(s.el) * R,
    );
    // warmer light near the horizon
    sunLight.color.setHSL(0.09, elDeg < 12 ? 0.85 : 0.25, elDeg < 12 ? 0.62 : 0.98);
  }

  const azDeg = Math.round(s.az * 180 / Math.PI);
  infoEl.innerHTML =
    (s.rise != null
      ? `☀ ${fmtH(s.rise)} → ${fmtH(s.set)} · ` : '') +
    `${t('sun.elev')}: ${Math.max(0, Math.round(elDeg))}° · ${t('sun.az')}: ${azDeg}°` +
    (elDeg <= 0 ? ` · ${t('sun.night')}` : '');
}
