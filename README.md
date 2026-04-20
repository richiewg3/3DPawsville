# 3DPawsville

Foundational Three.js + Vite 3D game scaffold that auto-processes a large OBJ map into a browser-friendly GLB.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

`npm run dev` automatically:

1. Extracts the single root-level `.zip` (currently `textures.zip`) into `assets/source/`.
2. Converts the extracted largest `.obj` file into `public/assets/map.glb` using `obj2gltf`.
3. Starts Vite.

## Build

```bash
npm run build
```

The same extraction + conversion pipeline runs before build.

## Controls

- Click canvas to lock mouse.
- `W A S D` to move.
- Mouse to look around.
- `Space` to jump.

## Notes

- Scene uses ambient + directional lighting.
- Map is loaded asynchronously with progress text.
- Fog and mesh frustum culling are enabled for large-map performance.
- Includes a placeholder low-poly humanoid with basic gravity and map collision raycasts.
