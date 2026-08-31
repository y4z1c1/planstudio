// Shared mutable context passed to every module's init(ctx).
// main.js fills in the three.js objects and dispatch helpers at bootstrap.
export const ctx = {
  // three.js core (set by main.js)
  scene: null,
  camera: null,
  renderer: null,
  labelRenderer: null,
  controls: null,
  grid: null,
  clipPlane: null,

  // model state
  model: null,
  modelBox: null,
  modelName: null,

  // picking
  raycaster: null,
  mouseNDC: null,

  // UI mode: 'area' | 'dist' | 'furn' | null (more modes added by later milestones)
  mode: null,
  setMode: null,          // assigned by main.js
  modeUI: [],             // {mode, button, hints:[el]} registered by modules

  // event dispatch chains — hooks return true to consume the event
  pointerHooks: { down: [], move: [], up: [] },
  dblHooks: [],
  keyHooks: [],
  tickHooks: [],          // called each animation frame with dt seconds
  modelHooks: [],         // called after a model is set: fn(model, name)

  // helpers (assigned by main.js)
  setNDC: null,
  pickPoint: null,
  worldToScreenDist: null,
  fitCameraToModel: null,

  // dom
  statusEl: null,
};
