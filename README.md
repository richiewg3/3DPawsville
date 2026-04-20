# 3DPawsville

Three.js + Vite 3D browser game scaffold. The asset pipeline ingests a large
`.obj` map shipped inside a zip file and bakes it into a browser-ready
grey-box `.glb` for fast loading and low memory usage.

## Quick start

```bash
npm install
npm run dev
```

That single command chain:

1. Extracts `textures.zip` into `assets/source/`.
2. Converts the largest `.obj` inside that folder into `public/assets/map.glb`.
   Missing texture references in the source `.mtl` are ignored: every mesh is
   reassigned to a single neutral grey-box material, and geometry is bucketed
   and merged so the final GLB is a handful of large chunks instead of
   thousands of tiny draw calls.
3. Starts Vite.

Open the printed URL, click the canvas, and play.

## Build

```bash
npm run build
```

Runs the same pipeline and produces a static `dist/` folder.

## Controls

- `W A S D` — move (third-person camera follows the humanoid).
- Mouse — rotate camera (click the canvas once to acquire pointer lock).
- `Space` — jump.
- `R` — respawn at the initial landing point.

## Engine notes

- Aggressive far-plane (~260 units) and matching fog to keep distant geometry
  from reaching the GPU, so the map renders smoothly in a browser.
- Frustum culling is enabled on every map chunk; each merged chunk has its own
  bounding sphere, so large parts of the map can be skipped per frame.
- A generic low-poly humanoid figure (capsule torso, sphere head, cylindrical
  limbs) is assembled procedurally and driven by gravity + ground / wall
  raycasts against the map mesh.
- On load, the humanoid is placed on the tallest rooftop returned by a
  downward raycast grid, then falls onto the surface below.
