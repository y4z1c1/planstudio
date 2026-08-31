import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { ctx } from './ctx.js';
import * as results from './results.js';
import * as measure from './measure.js';
import * as editor from './editor.js';
import * as catalog from './catalog.js';
import * as semantic from './semantic.js';
import * as persist from './persist.js';
import * as doors from './doors.js';
import * as walk from './walk.js';
import * as env from './env.js';
import * as projects from './projects.js';
import { t, lang, setLang, applyStatic } from './i18n.js';

// ---------- scene bootstrap ----------
const wrap = document.getElementById('canvas-wrap');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16181d);

const camera = new THREE.PerspectiveCamera(60, (innerWidth / innerHeight) || 16 / 9, 0.01, 500);
camera.position.set(4, 5, 4);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
wrap.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
wrap.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const dir = new THREE.DirectionalLight(0xffffff, 1.5);
dir.position.set(5, 10, 5);
scene.add(dir);
const dir2 = new THREE.DirectionalLight(0xffffff, 0.6);
dir2.position.set(-5, 8, -5);
scene.add(dir2);

const grid = new THREE.GridHelper(20, 40, 0x333845, 0x24272e);
scene.add(grid);

const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);

// ---------- ctx wiring ----------
Object.assign(ctx, {
  scene, camera, renderer, labelRenderer, controls, grid, clipPlane,
  modelBox: new THREE.Box3(),
  raycaster: new THREE.Raycaster(),
  mouseNDC: new THREE.Vector2(),
  statusEl: document.getElementById('status'),
});

ctx.setNDC = ev => {
  const r = renderer.domElement.getBoundingClientRect();
  ctx.mouseNDC.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ctx.mouseNDC.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ctx.raycaster.setFromCamera(ctx.mouseNDC, camera);
};

ctx.pickPoint = ev => {
  if (!ctx.model) return null;
  ctx.setNDC(ev);
  const hits = ctx.raycaster.intersectObject(ctx.model, true);
  for (const h of hits) {
    if (!h.object.visible) continue;
    if (h.point.y <= clipPlane.constant) return h.point.clone();
  }
  return null;
};

ctx.worldToScreenDist = (a, b) => {
  const pa = a.clone().project(camera), pb = b.clone().project(camera);
  return Math.hypot((pa.x - pb.x) * innerWidth / 2, (pa.y - pb.y) * innerHeight / 2);
};

ctx.fitCameraToModel = obj => {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  controls.target.copy(center);
  camera.position.set(center.x + maxDim * 0.8, center.y + maxDim * 0.9, center.z + maxDim * 0.8);
  camera.near = maxDim / 100;
  camera.far = maxDim * 20;
  camera.updateProjectionMatrix();
  grid.position.y = box.min.y - 0.01;
  controls.update();
};

// ---------- mode system ----------
ctx.setMode = m => {
  measure.cancelCurrent();
  editor.deselect();
  ctx.mode = (ctx.mode === m) ? null : m;
  for (const ui of ctx.modeUI) {
    const on = ctx.mode === ui.mode;
    ui.button.classList.toggle('active', on);
    ui.hints.forEach(el => el.classList.toggle('show', on));
  }
  renderer.domElement.style.cursor =
    (ctx.mode === 'area' || ctx.mode === 'dist' || ctx.mode === 'door') ? 'crosshair' : 'default';
};

// buttons steal focus → Enter/R keys would re-trigger them; always blur after click
document.querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => b.blur())
);

// ---------- i18n boot ----------
applyStatic();
document.documentElement.lang = lang;
document.getElementById('status').textContent = t('status.ready');
const langSw = document.getElementById('lang-sw');
langSw.querySelector('#lang-' + lang)?.classList.add('on');
document.getElementById('lang-tr').onclick = () => lang !== 'tr' && setLang('tr');
document.getElementById('lang-en').onclick = () => lang !== 'en' && setLang('en');
document.getElementById('lang-sw-menu').appendChild(langSw.cloneNode(true));
document.querySelector('#lang-sw-menu #lang-tr').onclick = () => lang !== 'tr' && setLang('tr');
document.querySelector('#lang-sw-menu #lang-en').onclick = () => lang !== 'en' && setLang('en');

// ---------- save / discard (session baseline) ----------
const btnSave = document.getElementById('btn-save');
const btnDiscard = document.getElementById('btn-discard');
persist.onDirtyChange(dirty => {
  const disp = dirty ? 'flex' : 'none';
  btnSave.style.display = disp;
  btnDiscard.style.display = disp;
});
btnSave.onclick = () => {
  persist.commitBaseline();
  ctx.statusEl.textContent = t('status.saved');
};
btnDiscard.onclick = () => {
  if (!confirm(t('confirm.discard'))) return;
  if (persist.discardToBaseline()) ctx.reloadToProject();
};

// ---------- accordion groups ----------
document.querySelectorAll('.grp-head').forEach(head => {
  head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
});

// ---------- central event dispatch ----------
let downPos = null;
renderer.domElement.addEventListener('pointerdown', ev => {
  downPos = [ev.clientX, ev.clientY];
  for (const h of ctx.pointerHooks.down) if (h(ev)) return;
});
renderer.domElement.addEventListener('pointermove', ev => {
  for (const h of ctx.pointerHooks.move) if (h(ev)) return;
});
renderer.domElement.addEventListener('pointerup', ev => {
  ev._isClick = downPos && Math.hypot(ev.clientX - downPos[0], ev.clientY - downPos[1]) <= 5;
  downPos = null;
  for (const h of ctx.pointerHooks.up) if (h(ev)) return;
});
renderer.domElement.addEventListener('dblclick', ev => {
  for (const h of ctx.dblHooks) if (h(ev)) return;
});
// undo/restore work by reloading with reverted storage; remember the open
// project so the reload returns to it instead of the main menu
ctx.reloadToProject = () => {
  try { sessionStorage.setItem('ps:reopen', ctx.modelName || ''); } catch {}
  location.reload();
};

addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT') return;
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    if (ctx.modelName && persist.undo()) ctx.reloadToProject();
    return;
  }
  for (const h of ctx.keyHooks) if (h(ev)) return;
});

// ---------- module init (hook order = dispatch priority: editor before measure) ----------
results.init(ctx);
editor.init(ctx);
measure.init(ctx);
catalog.init(ctx);
doors.init(ctx);
semantic.init(ctx);
walk.init(ctx);
env.init(ctx);
projects.init(ctx);

// global shortcuts — registered last so walk/editor/measure get first pick;
// digits work inside walk mode too (measuring through the crosshair)
ctx.keyHooks.push(ev => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  switch (ev.key) {
    case '1': document.getElementById('btn-auto').click(); return true;
    case '2': ctx.setMode('area'); return true;
    case '3': ctx.setMode('dist'); return true;
    case '4': document.getElementById('btn-top').click(); return true;
    case '5': document.getElementById('btn-persp').click(); return true;
    case '6': document.getElementById('btn-ceiling').click(); return true;
    case '7': document.getElementById('btn-env').click(); return true;
    case 'e': case 'E': ctx.setMode('edit'); return true;
    case 'f': case 'F': {
      const grp = document.getElementById('grp-add');
      grp.classList.toggle('open');
      if (grp.classList.contains('open')) {
        // in walk mode free the pointer so the catalog is usable;
        // picking an item re-locks it (editor.startPlacing)
        if (ctx.walkActive) ctx.walkSuspendLock?.();
        document.getElementById('furn-search').focus();
      }
      return true;
    }
  }
  return false;
});

// ---------- model loading ----------
const loader = new GLTFLoader();
const modelNameEl = document.getElementById('model-name');

ctx.loadModel = (url, name, revoke = false) => {
  loader.load(url,
    g => { setModel(g.scene, name); if (revoke) URL.revokeObjectURL(url); },
    undefined,
    () => { ctx.statusEl.textContent = t('status.loadFail', { name }); });
};

function setModel(gltfScene, name) {
  // clear everything the previous model spawned at scene level (doors,
  // furniture, clones, measurement overlays) — otherwise reopening a
  // project duplicates them
  for (const h of ctx.cleanupHooks) h();
  if (ctx.model) scene.remove(ctx.model);
  ctx.model = gltfScene;
  ctx.modelName = name;
  persist.loadFor(name);
  persist.ensureBaseline();
  ctx.model.traverse(o => {
    if (o.isMesh) {
      o.material.side = THREE.DoubleSide;
      o.material.clippingPlanes = [clipPlane];
      o.material.clipShadows = true;
    }
  });
  scene.add(ctx.model);
  ctx.modelBox.setFromObject(ctx.model);
  ctx.fitCameraToModel(ctx.model);
  const s = ctx.modelBox.getSize(new THREE.Vector3());
  modelNameEl.textContent = `${name} — ${s.x.toFixed(1)} × ${s.z.toFixed(1)} × ${s.y.toFixed(1)} m`;
  for (const h of ctx.modelHooks) h(ctx.model, name);
  ceilingHidden = true;      // open with the plan view: ceiling hidden by default
  applyCeiling();
  // open-time migrations/auto-measure are not user edits — reset the baseline
  // once they settle so Save/Discard only reacts to real changes
  setTimeout(() => persist.commitBaseline(), 1200);
}

// drag & drop (house model) — saved into the project store, then opened
const dropOverlay = document.getElementById('drop-overlay');
addEventListener('dragover', e => { e.preventDefault(); dropOverlay.classList.add('show'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) dropOverlay.classList.remove('show'); });
addEventListener('drop', e => {
  e.preventDefault();
  dropOverlay.classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (!f || !f.name.toLowerCase().endsWith('.glb')) return;
  projects.importFile(f);
});

// ---------- ceiling toggle ----------
// semantic models: hide the Ceilings group outright; other GLBs: clip the top
let ceilingHidden = false;
const btnCeiling = document.getElementById('btn-ceiling');
function applyCeiling() {
  btnCeiling.classList.toggle('active', ceilingHidden);
  btnCeiling.querySelector('.lbl').textContent =
    ceilingHidden ? t('btn.ceilingShow') : t('btn.ceilingHide');
  const ceilings = semantic.semantic?.ceilingsGroup;
  if (ceilings) {
    ceilings.visible = !ceilingHidden;
    clipPlane.constant = 1e6;
    return;
  }
  const box = ctx.modelBox;
  clipPlane.constant = ceilingHidden
    ? box.min.y + (box.max.y - box.min.y) * 0.55
    : 1e6;
}
btnCeiling.onclick = () => { ceilingHidden = !ceilingHidden; applyCeiling(); };
// walk mode restores the ceiling while inside, then puts the cut back
ctx.setCeiling = hidden => { ceilingHidden = hidden; applyCeiling(); };
ctx.getCeiling = () => ceilingHidden;

// ---------- camera views ----------
document.getElementById('btn-top').onclick = () => {
  if (!ctx.model) return;
  const c = ctx.modelBox.getCenter(new THREE.Vector3());
  const size = ctx.modelBox.getSize(new THREE.Vector3());
  const h = Math.max(size.x, size.z) * 1.3;
  camera.position.set(c.x, ctx.modelBox.max.y + h, c.z + 0.001);
  controls.target.copy(c);
  controls.update();
};
document.getElementById('btn-persp').onclick = () => {
  if (ctx.model) ctx.fitCameraToModel(ctx.model);
};

// ---------- loop ----------
addEventListener('resize', () => {
  if (!innerWidth || !innerHeight) return;   // hidden/zero-sized viewport
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});

window.__ctx = ctx;   // console debugging convenience

// ---------- arrow-key / WASD panning in orbit view ----------
// (walk mode consumes its own movement keys; this covers the free/top views)
const panKeys = new Set();
const PAN_MAP = {
  ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'l', ArrowRight: 'r',
  w: 'f', W: 'f', s: 'b', S: 'b', a: 'l', A: 'l', d: 'r', D: 'r',
};
addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT' || ctx.walkActive) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  // with an object selected, letters belong to the editor (D = duplicate,
  // R = rotate) — only the arrow keys keep panning then
  if (editor.selected && !ev.key.startsWith('Arrow')) return;
  const k = PAN_MAP[ev.key];
  if (k) { ev.preventDefault(); panKeys.add(k); }
});
addEventListener('keyup', ev => {
  const k = PAN_MAP[ev.key];
  if (k) panKeys.delete(k);
});
const panFwd = new THREE.Vector3(), panRight = new THREE.Vector3(), panMove = new THREE.Vector3();
ctx.tickHooks.push(dt => {
  if (ctx.walkActive || !panKeys.size || !ctx.model) return;
  // forward = view direction on XZ; in near-top-down views fall back to the
  // screen-up direction so the arrows still track the screen
  panFwd.setFromMatrixColumn(camera.matrix, 2).negate();
  panFwd.y = 0;
  if (panFwd.lengthSq() < 0.05) {
    panFwd.setFromMatrixColumn(camera.matrix, 1);
    panFwd.y = 0;
  }
  if (panFwd.lengthSq() < 1e-6) return;
  panFwd.normalize();
  panRight.set(-panFwd.z, 0, panFwd.x);
  panMove.set(0, 0, 0);
  if (panKeys.has('f')) panMove.add(panFwd);
  if (panKeys.has('b')) panMove.sub(panFwd);
  if (panKeys.has('l')) panMove.sub(panRight);
  if (panKeys.has('r')) panMove.add(panRight);
  if (panMove.lengthSq() === 0) return;
  const dist = camera.position.distanceTo(controls.target);
  panMove.normalize().multiplyScalar(Math.max(2, dist * 0.5) * dt);
  camera.position.add(panMove);
  controls.target.add(panMove);
});

let lastT = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  for (const h of ctx.tickHooks) h(dt);
  if (!walk.active) controls.update();   // OrbitControls would override the walk camera
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();
