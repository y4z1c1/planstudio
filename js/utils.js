import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const COLORS = [0x4f8ef7, 0x34c98e, 0xf0b429, 0xe5534b, 0xb07ff5, 0x2fc4d9, 0xf78e4f, 0x8ef74f];

export const colorHex = c => '#' + c.toString(16).padStart(6, '0');

export function makeMarker(pos, color = 0xf0b429, size = 0.035) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(size, 16, 16),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  m.renderOrder = 999;
  m.position.copy(pos);
  return m;
}

export function makeLine(points, color = 0xf0b429, closed = false) {
  const pts = closed ? [...points, points[0]] : points;
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
  l.renderOrder = 998;
  return l;
}

export function makeTextLabel(text, pos, cssColor = '#fff', cls = 'marker-label') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  div.style.color = cssColor;
  const lbl = new CSS2DObject(div);
  lbl.position.copy(pos);
  return lbl;
}

export function polygonAreaXZ(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}

export function centroid(pts) {
  const c = new THREE.Vector3();
  pts.forEach(p => c.add(p));
  return c.divideScalar(pts.length);
}

export function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
    if (o.isCSS2DObject && o.element.parentNode) o.element.parentNode.removeChild(o.element);
  });
}
