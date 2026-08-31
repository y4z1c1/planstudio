import { colorHex, disposeGroup } from './utils.js';
import { t } from './i18n.js';

// rooms: { name, area|null, dist?, group, color, auto?, meshName? }
export const rooms = [];
export const counters = { dist: 0, room: 0 };

let ctx = null;
let roomList, totalRow, totalVal;
let onRename = null;   // set by later milestones (persist)

export function setRenameHandler(fn) { onRename = fn; }

export function init(c) {
  ctx = c;
  roomList = document.getElementById('room-list');
  totalRow = document.getElementById('total-row');
  totalVal = document.getElementById('total-val');

  const clearAll = () => {
    rooms.forEach(r => { ctx.scene.remove(r.group); disposeGroup(r.group); });
    rooms.length = 0;
    counters.dist = 0;
    counters.room = 0;
    updateResults();
  };
  document.getElementById('btn-clear').onclick = clearAll;
  ctx.cleanupHooks.push(clearAll);
}

export function addRecord(rec) {
  rooms.push(rec);
  updateResults();
}

export function clearAuto() {
  for (let i = rooms.length - 1; i >= 0; i--) {
    if (rooms[i].auto) {
      ctx.scene.remove(rooms[i].group);
      disposeGroup(rooms[i].group);
      rooms.splice(i, 1);
    }
  }
}

const totalChip = document.getElementById('total-chip');
const totalChipVal = document.getElementById('total-chip-val');

export function updateResults() {
  roomList.innerHTML = '';
  if (!rooms.length) {
    roomList.innerHTML = `<div class="empty">${t('results.empty')}</div>`;
    totalRow.style.display = 'none';
    if (totalChip) totalChip.style.display = 'none';
    return;
  }
  let total = 0;
  rooms.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'room-item';
    const val = r.area != null ? r.area.toFixed(2) + ' m²' : r.dist.toFixed(2) + ' m';
    if (r.area != null) total += r.area;
    div.innerHTML = `<span class="swatch" style="background:${colorHex(r.color)}"></span>
      <input class="name" value="${r.name.replace(/"/g, '&quot;')}">
      <span class="val">${val}</span>
      <button class="del" title="Sil">✕</button>`;
    div.querySelector('.name').addEventListener('input', e => {
      r.name = e.target.value;
      if (onRename) onRename(r);
    });
    div.querySelector('.del').onclick = () => {
      ctx.scene.remove(r.group);
      disposeGroup(r.group);
      rooms.splice(i, 1);
      updateResults();
    };
    roomList.appendChild(div);
  });
  totalRow.style.display = 'flex';
  totalVal.textContent = total.toFixed(2) + ' m²';
  if (totalChip) {
    totalChip.style.display = 'flex';
    totalChipVal.textContent = total.toFixed(1) + ' m²';
  }
}
