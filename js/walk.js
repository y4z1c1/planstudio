import * as THREE from 'three';
import * as semantic from './semantic.js';
import * as doorsMod from './doors.js';
import * as editor from './editor.js';
import * as measure from './measure.js';
import { t } from './i18n.js';

// Game-style first-person mode: pointer-lock mouse look (Minecraft POV),
// WASD/arrows + collision against walls, doors AND objects, crosshair,
// E / click to open-close the door you're looking at, subtle head bob.
// Gravity + Space jump: objects are solid but you can hop onto them
// (beds, tables…) and walk off edges to fall back down.
let ctx = null;
export let active = false;

const EYE = 1.6;
const GRAVITY = -14;
const JUMP_V = 4.9;        // ~0.85 m jump — clears beds and tables
let yaw = 0, pitch = 0;
const keys = new Set();
let saved = null;
let locked = false;
let lockSuspended = false; // pointer freed for UI (catalog picking) while walking
let looking = false;       // drag-look fallback when pointer lock unavailable
let lastX = 0, lastY = 0;
let btn = null;
let crosshair = null, prompt = null;
let aimedDoor = null;
let bobT = 0;
let feetY = 0, velY = 0, grounded = true;
let savedCeiling = false;
const rayc = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);

export function init(c) {
  ctx = c;
  btn = document.getElementById('btn-walk');
  btn.onclick = toggle;

  crosshair = document.createElement('div');
  crosshair.id = 'crosshair';
  crosshair.textContent = '+';
  document.body.appendChild(crosshair);
  prompt = document.createElement('div');
  prompt.id = 'interact-prompt';
  document.body.appendChild(prompt);

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === ctx.renderer.domElement;
    // Esc in pointer lock = leave game mode — unless the lock was suspended
    // on purpose (catalog interaction)
    if (active && !locked && !lockSuspended) exit();
  });

  // main.js frees the pointer when the add panel opens during walk;
  // editor.startPlacing re-engages it once an item is picked
  ctx.walkSuspendLock = () => {
    if (!active) return;
    lockSuspended = true;
    if (document.pointerLockElement) document.exitPointerLock?.();
  };
  ctx.walkResumeLock = () => {
    if (!active) return;
    lockSuspended = false;
    requestLock();
  };
  document.addEventListener('mousemove', ev => {
    if (!active || !locked) return;
    yaw -= ev.movementX * 0.0022;
    pitch -= ev.movementY * 0.0022;
    pitch = Math.max(-1.5, Math.min(1.5, pitch));
    applyLook();
  });

  ctx.pointerHooks.down.unshift(ev => {
    if (!active) return false;
    const measuring = ctx.mode === 'area' || ctx.mode === 'dist';
    if (locked) {
      // crosshair click: place > measure > door
      if (editor.isPlacing()) {
        editor.confirmPlacing();
      } else if (measuring) {
        measure.clickAt({ clientX: innerWidth / 2, clientY: innerHeight / 2 });
      } else {
        interact();
      }
      return true;
    }
    // not locked yet: clicking the canvas requests the lock (drag-look fallback)
    lockSuspended = false;
    requestLock();
    if (editor.isPlacing()) { editor.confirmPlacing(); looking = false; return true; }
    if (!measuring && aimedDoor) interact();
    looking = true;
    lastX = ev.clientX; lastY = ev.clientY;
    return true;
  });
  ctx.pointerHooks.move.unshift(ev => {
    if (!active) return false;
    if (!locked && looking) {
      yaw -= (ev.clientX - lastX) * 0.005;
      pitch -= (ev.clientY - lastY) * 0.005;
      pitch = Math.max(-1.5, Math.min(1.5, pitch));
      lastX = ev.clientX; lastY = ev.clientY;
      applyLook();
    }
    return true;
  });
  ctx.pointerHooks.up.unshift(ev => {
    if (!active) return false;
    // unlocked fallback: a clean click while measuring drops a point at the cursor
    if (!locked && ev._isClick && (ctx.mode === 'area' || ctx.mode === 'dist')) {
      measure.clickAt(ev);
    }
    looking = false;
    return true;
  });

  ctx.keyHooks.unshift(ev => {
    if (ev.key === 'g' || ev.key === 'G') { toggle(); return true; }
    if (!active) return false;
    if (ev.key === 'Escape') {
      if (editor.isPlacing()) { editor.cancelPlacing(); return true; }   // cancel placement, stay walking
      exit();
      return true;
    }
    if (ev.key === 'e' || ev.key === 'E') { interact(); return true; }
    if (ev.key === ' ') {
      ev.preventDefault();
      if (grounded) { velY = JUMP_V; grounded = false; }
      return true;
    }
    const k = normKey(ev.key);
    if (k) { ev.preventDefault(); keys.add(k); return true; }
    return false;
  });
  addEventListener('keyup', ev => {
    const k = normKey(ev.key);
    if (k) keys.delete(k);
  });

  ctx.tickHooks.push(tick);
  ctx.cleanupHooks.push(() => { if (active) exit(); });
  ctx.walkDebug = { keys, isActive: () => active, isLocked: () => locked };
}

function normKey(key) {
  switch (key) {
    case 'w': case 'W': case 'ArrowUp': return 'f';
    case 's': case 'S': case 'ArrowDown': return 'b';
    case 'a': case 'A': case 'ArrowLeft': return 'l';
    case 'd': case 'D': case 'ArrowRight': return 'r';
    case 'Shift': return 'shift';
    default: return null;
  }
}

function toggle() { active ? exit() : enter(); }

// pointer lock is unavailable in some embedded contexts (e.g. preview panes);
// swallow the rejection — drag-look keeps working without it
function requestLock() {
  try {
    const p = ctx.renderer.domElement.requestPointerLock?.();
    if (p && p.catch) p.catch(() => {});
  } catch {}
}

function enter() {
  if (!ctx.model) return;
  ctx.setMode(null);
  saved = { pos: ctx.camera.position.clone(), target: ctx.controls.target.clone() };
  const dir = new THREE.Vector3();
  ctx.camera.getWorldDirection(dir);
  yaw = Math.atan2(-dir.x, -dir.z);
  pitch = 0;
  // spawn at the center of the room nearest to where the user was looking —
  // starting at an arbitrary point can wedge the player into walls/furniture
  // (careful: don't shadow the imported i18n `t` here)
  const tgt = ctx.controls.target;
  let sx = tgt.x, sz = tgt.z;
  if (semantic.roomCenters.length) {
    let best = null, bd = Infinity;
    for (const r of semantic.roomCenters) {
      const d = (r.centroid.x - tgt.x) ** 2 + (r.centroid.z - tgt.z) ** 2;
      if (d < bd) { bd = d; best = r; }
    }
    sx = best.centroid.x; sz = best.centroid.z;
  }
  feetY = ctx.modelBox.min.y;
  velY = 0;
  grounded = true;
  ctx.camera.position.set(sx, feetY + EYE, sz);
  ctx.controls.enabled = false;
  active = true;
  ctx.walkActive = true;
  savedCeiling = ctx.getCeiling ? ctx.getCeiling() : false;
  if (ctx.setCeiling) ctx.setCeiling(false);     // ceiling back on while inside
  applyLook();
  btn.classList.add('active');
  crosshair.style.display = 'block';
  ctx.statusEl.textContent = t('status.walk');
  requestLock();
}

function exit() {
  active = false;
  ctx.walkActive = false;
  keys.clear();
  looking = false;
  aimedDoor = null;
  crosshair.style.display = 'none';
  prompt.style.display = 'none';
  if (document.pointerLockElement) document.exitPointerLock?.();
  if (saved) {
    ctx.camera.position.copy(saved.pos);
    ctx.controls.target.copy(saved.target);
  }
  if (ctx.setCeiling) ctx.setCeiling(savedCeiling);   // restore the plan view cut
  ctx.controls.enabled = true;
  ctx.controls.update();
  btn.classList.remove('active');
  ctx.statusEl.textContent = t('status.walkExit');
}

function applyLook() {
  const look = new THREE.Vector3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
  ctx.camera.lookAt(ctx.camera.position.clone().add(look));
}

function interact() {
  if (aimedDoor) doorsMod.toggleDoor(aimedDoor);
}

// blocking geometry: walls, doorway groups AND every placed/scanned object —
// furniture is solid; you jump on top of it instead of walking through
function colliders() {
  const list = [];
  const sem = semantic.semantic;
  if (sem?.wallsGroup) list.push(sem.wallsGroup);
  else if (ctx.model) list.push(ctx.model);
  for (const d of doorsMod.doorObjects) if (d.parent) list.push(d);
  for (const o of editor.placed) if (o.visible && o.parent) list.push(o);
  return list;
}

function blocked(from, dir, dist) {
  rayc.set(from, dir);
  rayc.near = 0;
  rayc.far = dist;
  return rayc.intersectObjects(colliders(), true).some(h => h.object.visible);
}

// highest walkable surface under the player (floors, furniture tops, stairs of
// stuff) — sampled by a downward ray from just above the head
function groundHeight() {
  const origin = new THREE.Vector3(ctx.camera.position.x, feetY + EYE + 0.3, ctx.camera.position.z);
  rayc.set(origin, DOWN);
  rayc.near = 0;
  rayc.far = EYE + 4;
  const targets = [];
  if (ctx.model) targets.push(ctx.model);
  for (const o of editor.placed) if (o.visible && o.parent) targets.push(o);
  const hits = rayc.intersectObjects(targets, true);
  for (const h of hits) {
    if (!h.object.visible) continue;
    // only surfaces near or below the feet count — ceilings and lintels above
    // the player must not become "ground" mid-jump; 15 cm doubles as step-up
    if (h.point.y <= feetY + 0.15) return h.point.y;
  }
  return ctx.modelBox.min.y;
}

function tick(dt) {
  if (!active) return;

  // horizontal movement — two rays (shin + torso) relative to current feet
  // height, so a jump that lifts you above an object lets you glide onto it
  if (keys.size) {
    const speed = (keys.has('shift') ? 3.6 : 1.9) * dt;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3();
    if (keys.has('f')) move.add(fwd);
    if (keys.has('b')) move.sub(fwd);
    if (keys.has('l')) move.sub(right);
    if (keys.has('r')) move.add(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      const shin = new THREE.Vector3(ctx.camera.position.x, feetY + 0.35, ctx.camera.position.z);
      const torso = new THREE.Vector3(ctx.camera.position.x, feetY + 1.25, ctx.camera.position.z);
      const tryMove = v => {
        if (v.lengthSq() < 1e-10) return false;
        const d = v.clone().normalize();
        if (blocked(shin, d, 0.35) || blocked(torso, d, 0.35)) return false;
        ctx.camera.position.x += v.x;
        ctx.camera.position.z += v.z;
        return true;
      };
      if (!tryMove(move)) {
        tryMove(new THREE.Vector3(move.x, 0, 0)) || tryMove(new THREE.Vector3(0, 0, move.z));
      }
      const b = ctx.modelBox;
      ctx.camera.position.x = Math.max(b.min.x + 0.25, Math.min(b.max.x - 0.25, ctx.camera.position.x));
      ctx.camera.position.z = Math.max(b.min.z + 0.25, Math.min(b.max.z - 0.25, ctx.camera.position.z));
      if (grounded) bobT += dt * (keys.has('shift') ? 11 : 8);
    }
  }

  // vertical physics: gravity, jumping, landing on whatever is underfoot
  const ground = groundHeight();
  if (grounded && feetY > ground + 0.02) grounded = false;   // walked off an edge
  if (!grounded) {
    velY += GRAVITY * dt;
    feetY += velY * dt;
    if (velY <= 0 && feetY <= ground) {
      feetY = ground;
      velY = 0;
      grounded = true;
    }
  } else {
    feetY = ground;
  }
  ctx.camera.position.y = feetY + EYE + (grounded ? Math.sin(bobT) * 0.028 : 0);
  applyLook();

  // an item being placed follows the crosshair (wall physics applied inside)
  if (editor.isPlacing()) {
    const dir = new THREE.Vector3();
    ctx.camera.getWorldDirection(dir);
    editor.placingAim(ctx.camera.position, dir);
  }

  // door aim detection from screen center
  rayc.near = 0;
  rayc.far = 2.4;
  ctx.camera.getWorldDirection(rayc.ray.direction);
  rayc.ray.origin.copy(ctx.camera.position);
  aimedDoor = null;
  const doorTargets = doorsMod.doorObjects.filter(d => d.parent);
  if (doorTargets.length) {
    const hits = rayc.intersectObjects(doorTargets, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !doorTargets.includes(o)) o = o.parent;
      aimedDoor = o;
    }
  }
  if (aimedDoor && ctx.mode !== 'area' && ctx.mode !== 'dist' && !editor.isPlacing()) {
    prompt.textContent = t(aimedDoor.userData.open ? 'walk.doorClose' : 'walk.doorOpen');
    prompt.style.display = 'block';
  } else {
    prompt.style.display = 'none';
  }
}
