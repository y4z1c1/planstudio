import * as THREE from 'three';
import * as semantic from './semantic.js';
import * as doorsMod from './doors.js';

// Game-style first-person mode: pointer-lock mouse look (Minecraft POV),
// WASD/arrows + collision against walls and closed doors, crosshair,
// E / click to open-close the door you're looking at, subtle head bob.
let ctx = null;
export let active = false;

const EYE = 1.6;
let yaw = 0, pitch = 0;
const keys = new Set();
let saved = null;
let locked = false;
let looking = false;       // drag-look fallback when pointer lock unavailable
let lastX = 0, lastY = 0;
let btn = null;
let crosshair = null, prompt = null;
let aimedDoor = null;
let bobT = 0;
const rayc = new THREE.Raycaster();

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
    if (active && !locked) exit();          // Esc in pointer lock = leave game mode
  });
  document.addEventListener('mousemove', ev => {
    if (!active || !locked) return;
    yaw -= ev.movementX * 0.0022;
    pitch -= ev.movementY * 0.0022;
    pitch = Math.max(-1.5, Math.min(1.5, pitch));
    applyLook();
  });

  ctx.pointerHooks.down.unshift(ev => {
    if (!active) return false;
    if (locked) { interact(); return true; }        // click = use door
    // not locked yet: clicking the canvas requests the lock (drag-look fallback)
    requestLock();
    if (aimedDoor) interact();                      // clicking a door works unlocked too
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
  ctx.pointerHooks.up.unshift(() => {
    if (!active) return false;
    looking = false;
    return true;
  });

  ctx.keyHooks.unshift(ev => {
    if (ev.key === 'g' || ev.key === 'G') { toggle(); return true; }
    if (!active) return false;
    if (ev.key === 'Escape') { exit(); return true; }
    if (ev.key === 'e' || ev.key === 'E') { interact(); return true; }
    const k = normKey(ev.key);
    if (k) { ev.preventDefault(); keys.add(k); return true; }
    return false;
  });
  addEventListener('keyup', ev => {
    const k = normKey(ev.key);
    if (k) keys.delete(k);
  });

  ctx.tickHooks.push(tick);
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
  const t = ctx.controls.target;
  let sx = t.x, sz = t.z;
  if (semantic.roomCenters.length) {
    let best = null, bd = Infinity;
    for (const r of semantic.roomCenters) {
      const d = (r.centroid.x - t.x) ** 2 + (r.centroid.z - t.z) ** 2;
      if (d < bd) { bd = d; best = r; }
    }
    sx = best.centroid.x; sz = best.centroid.z;
  }
  ctx.camera.position.set(sx, ctx.modelBox.min.y + EYE, sz);
  ctx.controls.enabled = false;
  active = true;
  applyLook();
  btn.classList.add('active');
  crosshair.style.display = 'block';
  ctx.statusEl.textContent = 'WASD/ok = yürü · fare = bak · E / tık = kapı · Shift = koş · Esc = çık';
  requestLock();
}

function exit() {
  active = false;
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
  ctx.controls.enabled = true;
  ctx.controls.update();
  btn.classList.remove('active');
  ctx.statusEl.textContent = 'Dolaşma modundan çıkıldı';
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

// blocking geometry: walls + doorway groups (open panels swing clear of the ray)
function colliders() {
  const list = [];
  const sem = semantic.semantic;
  if (sem?.wallsGroup) list.push(sem.wallsGroup);
  else if (ctx.model) list.push(ctx.model);
  for (const d of doorsMod.doorObjects) if (d.parent) list.push(d);
  return list;
}

function blocked(from, dir, dist) {
  rayc.set(from, dir);
  rayc.near = 0;
  rayc.far = dist;
  return rayc.intersectObjects(colliders(), true).some(h => h.object.visible);
}

function tick(dt) {
  if (!active) return;

  // movement with wall collision (slide along blocked axes)
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
      const feet = ctx.camera.position.clone();
      feet.y = ctx.modelBox.min.y + 1.0;
      const tryMove = v => {
        if (v.lengthSq() < 1e-10) return false;
        const d = v.clone().normalize();
        if (blocked(feet, d, 0.35)) return false;
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
      bobT += dt * (keys.has('shift') ? 11 : 8);
    }
  }
  ctx.camera.position.y = ctx.modelBox.min.y + EYE + Math.sin(bobT) * 0.028;
  applyLook();

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
  if (aimedDoor) {
    prompt.textContent = aimedDoor.userData.open ? 'E — kapıyı kapat' : 'E — kapıyı aç';
    prompt.style.display = 'block';
  } else {
    prompt.style.display = 'none';
  }
}
