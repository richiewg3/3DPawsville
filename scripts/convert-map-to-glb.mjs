// Convert the extracted .obj map into a browser-ready .glb.
//
// The source map ships with hundreds of missing texture references in the .mtl
// file. Instead of letting those ENOENT errors sink the asset pipeline, we
// ignore all materials and bake a single neutral "grey-box" standard material
// onto every mesh. The goal is to always produce `public/assets/map.glb` so
// the game has something to render, even if the textures are unavailable.

import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// GLTFExporter relies on the browser-only FileReader API when producing a
// binary GLB. Provide a minimal Node-compatible polyfill so the exporter works
// in a headless build environment.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onload = null;
      this.onerror = null;
    }
    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          if (this.onload) this.onload({ target: this });
          if (this.onloadend) this.onloadend({ target: this });
        })
        .catch((err) => {
          if (this.onerror) this.onerror(err);
        });
    }
    readAsDataURL(blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          const b64 = Buffer.from(buf).toString('base64');
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
          if (this.onload) this.onload({ target: this });
          if (this.onloadend) this.onloadend({ target: this });
        })
        .catch((err) => {
          if (this.onerror) this.onerror(err);
        });
    }
  };
}

const root = process.cwd();
const sourceDir = path.join(root, 'assets', 'source');
const outDir = path.join(root, 'public', 'assets');
const outFile = path.join(outDir, 'map.glb');

function walk(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files = files.concat(walk(full));
    else files.push(full);
  }
  return files;
}

if (!fs.existsSync(sourceDir)) {
  throw new Error(
    `Missing extracted assets directory: ${sourceDir}. Run npm run extract:assets first.`,
  );
}

const objFiles = walk(sourceDir).filter((f) => f.toLowerCase().endsWith('.obj'));
if (objFiles.length === 0) {
  throw new Error(`No .obj file was found in ${sourceDir}.`);
}

const objPath = objFiles.sort(
  (a, b) => fs.statSync(b).size - fs.statSync(a).size,
)[0];
fs.mkdirSync(outDir, { recursive: true });

console.log(
  `[convert-map] Reading ${path.relative(root, objPath)} (${(
    fs.statSync(objPath).size /
    1024 /
    1024
  ).toFixed(1)} MB)`,
);

const objText = fs.readFileSync(objPath, 'utf8');
console.log('[convert-map] Parsing OBJ geometry (ignoring .mtl references)…');

const loader = new OBJLoader();
// Do NOT set a MaterialCreator; this forces OBJLoader to leave meshes without
// attempting to resolve the broken texture/material references.
const objGroup = loader.parse(objText);

// Collect all mesh geometries, drop OBJ-derived materials, and replace with a
// shared neutral material. Also strip UVs since there is no texture to sample.
const sharedMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa2ae,
  roughness: 0.92,
  metalness: 0.05,
  flatShading: true,
  side: THREE.DoubleSide,
});
sharedMaterial.name = 'greybox';

const geometries = [];
let sourceMeshCount = 0;

objGroup.traverse((child) => {
  if (!child.isMesh) return;
  sourceMeshCount += 1;
  const geometry = child.geometry;
  if (geometry.attributes.uv) geometry.deleteAttribute('uv');
  if (geometry.attributes.uv2) geometry.deleteAttribute('uv2');
  if (geometry.attributes.color) geometry.deleteAttribute('color');
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  // Normalize attribute signatures so BufferGeometryUtils.mergeGeometries can
  // combine them — it requires every geometry to share the exact same set of
  // attributes.
  geometry.setIndex(null); // drop indices; merged geometry will be non-indexed
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal') {
      geometry.deleteAttribute(name);
    }
  }
  geometries.push(geometry);
});

console.log(
  `[convert-map] Parsed ${sourceMeshCount} OBJ groups. Merging into bucketed meshes to reduce draw calls…`,
);

// Merging everything into a single mesh would break frustum culling because
// the bounding volume would cover the whole map. Instead split the map into a
// grid of spatial buckets so the renderer can cull entire chunks.
function bucketKeyForGeometry(geom) {
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  // Bucket size in *source* units — roughly 400 units wide. After the final
  // uniform scale each bucket ends up ~100 world units across.
  const BUCKET = 400;
  return `${Math.floor(cx / BUCKET)}_${Math.floor(cz / BUCKET)}`;
}

const buckets = new Map();
for (const geom of geometries) {
  const key = bucketKeyForGeometry(geom);
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(geom);
}

const mergedRoot = new THREE.Group();
mergedRoot.name = 'MergedMap';

let mergedMeshCount = 0;
let triCount = 0;
for (const [key, group] of buckets.entries()) {
  const merged = mergeGeometries(group, false);
  if (!merged) {
    console.warn(`[convert-map] Bucket ${key} (${group.length} geoms) failed to merge, skipping.`);
    continue;
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  triCount += merged.attributes.position.count / 3;
  const mesh = new THREE.Mesh(merged, sharedMaterial);
  mesh.name = `MapChunk_${key}`;
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mergedRoot.add(mesh);
  mergedMeshCount += 1;
  // Dispose per-source geometries' refs (they were consumed by merge).
  for (const g of group) g.dispose?.();
}

console.log(
  `[convert-map] Merged into ${mergedMeshCount} chunk meshes, ${Math.round(triCount)} triangles total.`,
);

// Replace the raw OBJ hierarchy with the merged chunks for export.
objGroup.clear();
objGroup.add(mergedRoot);

// Orient the map into a Y-up, sensible scale. The original coordinates span
// thousands of units; normalize so the map fits within a reasonable world box
// without throwing precision errors at the player.
const box = new THREE.Box3().setFromObject(objGroup);
const size = new THREE.Vector3();
box.getSize(size);
const center = new THREE.Vector3();
box.getCenter(center);

console.log(
  `[convert-map] Source bounds size: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)}`,
);

const targetSize = 600; // XZ extent we want the map to roughly occupy.
const maxHoriz = Math.max(size.x, size.z);
const scale = maxHoriz > 0 ? targetSize / maxHoriz : 1;

// Wrap so we can apply a clean transform without mutating geometry.
const rootObj = new THREE.Object3D();
rootObj.name = 'MapRoot';
rootObj.add(objGroup);

// Center horizontally, plant the lowest Y at 0 so the player spawns on ground.
objGroup.position.x = -center.x;
objGroup.position.z = -center.z;
objGroup.position.y = -box.min.y;
rootObj.scale.setScalar(scale);

const scene = new THREE.Scene();
scene.name = 'MapScene';
scene.add(rootObj);

console.log(
  `[convert-map] Applying uniform scale ${scale.toFixed(4)} so the map fits a ~${targetSize}u horizontal box.`,
);
console.log('[convert-map] Exporting GLB…');

const exporter = new GLTFExporter();
const result = await exporter.parseAsync(scene, {
  binary: true,
  onlyVisible: true,
  embedImages: false,
});

if (!(result instanceof ArrayBuffer) && !ArrayBuffer.isView(result)) {
  throw new Error('GLTFExporter did not return a binary GLB buffer.');
}

const buffer = Buffer.from(result instanceof ArrayBuffer ? result : result.buffer);
fs.writeFileSync(outFile, buffer);

console.log(
  `[convert-map] Wrote ${path.relative(root, outFile)} (${(
    buffer.length /
    1024 /
    1024
  ).toFixed(2)} MB)`,
);
