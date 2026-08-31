# PlanStudio

**3D floor-plan viewer, room-area measurement and furniture-fitting tool for Polycam home scans.**

Scan your home with [Polycam](https://poly.cam), export it as GLB, drop it into PlanStudio — get exact per-room m² instantly, furnish it with real-scale furniture, and walk through it in a first-person game mode. Built for comparing apartments while house-hunting: every scan becomes a project with its own persistent measurements, edits and furniture layout.

*Türkçe özet için [aşağıya](#türkçe) bakın.*

![status](https://img.shields.io/badge/stack-three.js%20%2B%20vanilla%20ES%20modules-3d7eff) ![license](https://img.shields.io/badge/license-MIT-green)

## Features

- **Exact room areas** — Polycam's structured GLB exports name every node (`Floor_Bedroom_1`, `Wall_0`, `Door_2`, `bed_0`, …). PlanStudio detects this and computes each room's area as the exact XZ-projected triangle area of its floor mesh. Rooms are renameable; totals update live.
- **Grid fallback** — non-semantic GLBs still get automatic room measurement via a 5 cm occupancy grid: floor triangles are rasterized, walls dilated to seal door openings, rooms flood-filled.
- **Manual tools** — polygon area (m²) and point-to-point distance (m) measurement with live preview.
- **Scan-object editing** — every scanned object (beds, fridge, cabinets, doors…) is selectable: drag to move, `R` rotate, `D` duplicate, `Delete` hide. World-baked geometry is re-pivoted on load so objects rotate around their own base.
- **Furniture catalog** — 17 metric-normalized [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) models (CC0), clones of the scan's own objects, and parametric fallback blocks. Overlapping blocks tint red.
- **Door repair** — rooms scanned without doors get one automatically: rays swept along the wall line find the opening, a real doorway model (with wall in-fill above/beside it) is placed in the gap. A "Kapı Ekle" mode adds doors to any wall by clicking.
- **Walk mode (game-style)** — pointer-lock mouse look with crosshair, WASD/arrow movement with wall collision and slide, doors open/close with `E` (hinged swing animation), spawn at the nearest room center, head bob, sprint with Shift. Furniture is solid: gravity + `Space` jump let you hop onto beds and tables and walk off edges.
- **Outdoor environment** — sky dome, grass, procedural trees and flowers, animated butterflies; scan window quads are replaced with framed glass windows.
- **Versioned persistence** — all edits (room names, moved/hidden objects, clones, doors, furniture) are stored per project in `localStorage` with a snapshot history: `Ctrl/⌘+Z` undoes, a history panel restores any of the last 40 states.
- **Project manager** — a home screen lists your projects (renameable, deletable); dropped GLB files are stored in IndexedDB so they reopen without re-importing. Every project auto-measures on open and starts in plan view (ceiling hidden); walk mode restores the ceiling while you're inside.
- **Pro UI** — accordion tool groups with keyboard shortcuts (`1` auto-measure, `2` area, `3` distance — these work inside walk mode through the crosshair too, `4/5` views, `6` ceiling, `7` environment, `E` edit, `F` add panel), hover an object in edit mode to see its dimensions, right-click for a context menu (rotate/duplicate/delete), searchable add panel where new furniture follows the cursor until you click to place it.
- **Bilingual** — full Turkish and English UI (TR/EN switch in the top bar).

## Running

No build step. Any static file server works:

```bash
python3 -m http.server 8741
# then open http://localhost:8741
```

> Pointer lock (walk mode's mouse capture) needs a regular browser tab; inside embedded previews the mode falls back to drag-to-look.

## Architecture

Vanilla ES modules, three.js 0.160 from CDN via import map. Modules communicate through a shared `ctx` object and register pointer/keyboard/tick behavior in hook chains owned by `main.js` (first hook returning `true` consumes the event; priority = registration order, walk mode uses `unshift`).

```
index.html          markup, CSS (Blueprint Dark theme), SVG icon sprite, import map
js/
├── main.js         scene bootstrap, mode system, event dispatch, model loading, ceiling toggle
├── ctx.js          shared context object passed to every module's init(ctx)
├── semantic.js     Polycam structure detection, exact per-room areas, room merges, Turkish names
├── measure.js      manual area/distance tools + grid-based auto-measure fallback
├── editor.js       unified select/drag/rotate/duplicate/delete for scan objects & furniture,
│                   geometry re-pivoting, Box3Helper selection, history UI
├── catalog.js      furniture catalog (Kenney GLB / scan clones / boxes), metric normalization
├── doors.js        doorway template, auto door repair, "add door" mode, hinge animation
├── walk.js         first-person controller: pointer lock, collision, door interaction
├── env.js          sky/grass/trees/flowers/butterflies + window replacement
├── projects.js     home screen, IndexedDB model store
├── results.js      room list panel, totals
├── persist.js      localStorage schema + snapshot history / undo
└── utils.js        shared three.js helpers (markers, labels, shoelace area)
```

### Data model

- `localStorage["fp:v1:<model>"]` — `{roomNames, scanEdits, clones, doors, furniture, meta}`
- `localStorage["fp:v1:<model>:history"]` — `[{ts, data}]`, last 40 snapshots
- IndexedDB `planstudio/models` — imported GLB blobs, keyed by file name

Scan objects are never disposed on delete — they're hidden and marked in `scanEdits`, so "reset edits" restores the original scan.

### Why areas need one-sided triangle counting

Polycam bakes floor slabs with both up- and down-facing triangles; summing all projected triangles doubles every area. Both the semantic and grid paths therefore count a single facing (winding sign / `n.y > 0.7`).

## Deploying

Fully static — GitHub Pages, Netlify or any static host works as-is (the Google Fonts stylesheet is the only external request besides the three.js CDN).

## Credits & license

- Code: [MIT](LICENSE)
- Furniture & doorway models: [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) — CC0
- [three.js](https://threejs.org) — MIT
- Sample scan (`8_31_2026.glb`): a Polycam export of a student flat, included as demo data

---

## Türkçe

PlanStudio, Polycam ile taranmış evleri görüntüleyen, oda oda **kesin m² ölçen** ve gerçek ölçülerde mobilya yerleştirmeye yarayan bir web uygulaması. Ev ararken adayları kıyaslamak için yapıldı: her GLB bir proje olur; ölçümler, düzenlemeler ve mobilya yerleşimi tarayıcıda kalıcı saklanır, `Ctrl+Z` ile geri alınır.

**Kullanım:** `python3 -m http.server 8741` → `http://localhost:8741`. GLB dosyanı pencereye sürükle. Kısayollar: `G` dolaşma modu (WASD + fare, `Space` zıpla, `E` kapı aç/kapa), `R` döndür, `D` kopyala, `Delete` sil, `Ctrl/⌘+Z` geri al.
