// Convert the extracted .obj/.mtl map into a browser-ready .glb WITH textures.
//
// Pipeline stages:
//   1. Parse map.mtl -> { materialName -> textureFilename } map.
//   2. Index every image file in assets/source/ and build a smart,
//      fuzzy-matching resolver so we can satisfy .mtl references even when
//      casing / stray `.N` suffixes / path prefixes don't match.
//   3. Use three.js' OBJLoader to parse the giant .obj. OBJLoader groups
//      vertices by `usemtl` for us, exposed via `geometry.groups`.
//   4. Bake a uniform Y-up / centering / scale transform directly into the
//      vertex positions (no Canvas required on export).
//   5. Emit a hand-assembled GLB: one primitive per texture (materials that
//      share a texture are merged), plus a single "greybox" primitive for
//      everything whose texture we could not find. PNG bytes are embedded
//      directly as buffer-view images; no image re-encoding, so this runs
//      fine in a headless Node build (no HTMLCanvasElement / OffscreenCanvas).
//
// Graceful fallback: if a material's texture cannot be resolved, we warn
// once and route its geometry into the shared greybox primitive. The build
// never hard-fails on a missing texture.

import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const root = process.cwd();
const sourceDir = path.join(root, 'assets', 'source');
const outDir = path.join(root, 'public', 'assets');
const outFile = path.join(outDir, 'map.glb');

if (!fs.existsSync(sourceDir)) {
  throw new Error(
    `Missing extracted assets directory: ${sourceDir}. Run npm run extract:assets first.`,
  );
}

fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Parse the .mtl file.
// ---------------------------------------------------------------------------

const mtlFiles = fs
  .readdirSync(sourceDir)
  .filter((f) => f.toLowerCase().endsWith('.mtl'))
  .map((f) => path.join(sourceDir, f));
if (mtlFiles.length === 0) {
  throw new Error(`No .mtl file was found in ${sourceDir}.`);
}

/** @type {Map<string, { textureRef: string | null }>} */
const mtlMaterials = new Map();
for (const mtlPath of mtlFiles) {
  const raw = fs.readFileSync(mtlPath, 'utf8').replace(/\r\n/g, '\n');
  let currentName = null;
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('newmtl ')) {
      currentName = line.slice(7).trim();
      if (!mtlMaterials.has(currentName)) {
        mtlMaterials.set(currentName, { textureRef: null });
      }
    } else if (currentName && /^map_kd\b/i.test(line)) {
      // `map_Kd [options] filename`. Strip common option flags.
      let rest = line.replace(/^map_kd\s+/i, '');
      // Remove known option tokens that take a value (e.g. -s 1 1 1, -o ..)
      rest = rest.replace(/-(?:s|o|t)\s+\S+\s+\S+\s+\S+\s*/gi, '');
      // Remove single-valued flags (e.g. -clamp on, -blendu on)
      rest = rest.replace(/-[a-z]+\s+\S+\s*/gi, '');
      rest = rest.trim();
      // `rest` may contain spaces (windows paths / "Eat deer.bmp.png" etc.).
      // Strip any directory prefix but keep the final filename verbatim.
      const baseName = rest.replace(/^.*[\\/]/, '');
      if (baseName) mtlMaterials.get(currentName).textureRef = baseName;
    }
  }
}

console.log(
  `[convert-map] Parsed .mtl: ${mtlMaterials.size} materials, ${
    [...mtlMaterials.values()].filter((m) => m.textureRef).length
  } reference a texture.`,
);

// ---------------------------------------------------------------------------
// 2. Index available image files and build a fuzzy resolver.
// ---------------------------------------------------------------------------

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|bmp|gif|tga)$/i;

function walkFiles(dir) {
  const out = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

const allSourceFiles = walkFiles(sourceDir);
const imageFiles = allSourceFiles.filter((f) => IMAGE_EXT_RE.test(f));

/**
 * Build several lookup indexes to make matching a `.mtl` texture reference to
 * a real file forgiving. All keys are lowercase.
 */
const byExact = new Map(); // "ad_sign.bmp.png" -> abs path (first wins, shortest preferred)
const byStem = new Map(); // "ad_sign" -> [abs paths...]
const byNormalized = new Map(); // "adsign" -> abs path

function normalizeStem(name) {
  // Strip extension(s), lowercase, strip separators and non-alphanums.
  let s = name.toLowerCase();
  s = s.replace(/\.(png|jpg|jpeg|bmp|gif|tga)$/i, '');
  // Strip trailing ".N" frame suffix (e.g. "anim_lights.1" -> "anim_lights")
  s = s.replace(/\.\d+$/, '');
  // Strip legacy ".bmp" infix we know is always present
  s = s.replace(/\.bmp$/i, '');
  s = s.replace(/[\s._\-']/g, '');
  return s;
}

for (const abs of imageFiles) {
  const base = path.basename(abs);
  const lower = base.toLowerCase();
  if (!byExact.has(lower) || abs.length < byExact.get(lower).length) {
    byExact.set(lower, abs);
  }

  const stem = lower.replace(/\.(png|jpg|jpeg|bmp|gif|tga)$/i, '');
  if (!byStem.has(stem)) byStem.set(stem, []);
  byStem.get(stem).push(abs);

  const norm = normalizeStem(base);
  if (norm) {
    if (!byNormalized.has(norm) || abs.length < byNormalized.get(norm).length) {
      byNormalized.set(norm, abs);
    }
  }
}

console.log(
  `[convert-map] Indexed ${imageFiles.length} image files (exact=${byExact.size}, stems=${byStem.size}, normalized=${byNormalized.size}).`,
);

function resolveTexturePath(mtlRef) {
  if (!mtlRef) return null;
  const rawBase = path.basename(mtlRef.replace(/\\/g, '/'));
  const lower = rawBase.toLowerCase();

  // 1. Exact basename (case-insensitive).
  if (byExact.has(lower)) return byExact.get(lower);

  // 2. Most game .obj references use `<name>.<ext>` but files ship as
  //    `<name>.<ext>.png` (the extraction tool appended .png to the original
  //    texture). Try suffixing `.png`.
  if (byExact.has(`${lower}.png`)) return byExact.get(`${lower}.png`);

  // 3. Case-insensitive stem match ("foo.bmp.1.png" -> "foo.bmp.1").
  const stem = lower.replace(/\.(png|jpg|jpeg|bmp|gif|tga)$/i, '');
  if (byStem.has(stem)) return byStem.get(stem)[0];

  // 4. Try dropping a trailing ".N" frame index and matching any frame.
  const frameless = stem.replace(/\.\d+$/, '');
  if (byStem.has(frameless)) return byStem.get(frameless)[0];
  // Also try `<frameless>.bmp` (very common shape: "foo.bmp.1.png").
  if (byStem.has(`${frameless}`)) return byStem.get(frameless)[0];

  // 5. Fully-normalized match (spaces, punctuation, casing, frame, .bmp all
  //    stripped).
  const norm = normalizeStem(rawBase);
  if (norm && byNormalized.has(norm)) return byNormalized.get(norm);

  return null;
}

// Resolve once per material and keep stats.
/** @type {Map<string, string | null>} */
const resolvedByMaterial = new Map();
const missingRefs = new Set();
for (const [name, info] of mtlMaterials) {
  if (!info.textureRef) {
    resolvedByMaterial.set(name, null);
    continue;
  }
  const abs = resolveTexturePath(info.textureRef);
  resolvedByMaterial.set(name, abs);
  if (!abs) missingRefs.add(info.textureRef);
}

const resolvedCount = [...resolvedByMaterial.values()].filter(Boolean).length;
console.log(
  `[convert-map] Texture resolver: ${resolvedCount}/${mtlMaterials.size} materials matched, ${missingRefs.size} unique refs missing.`,
);
if (missingRefs.size > 0) {
  const preview = [...missingRefs].slice(0, 8).join(', ');
  console.warn(
    `[convert-map] Missing textures (fallback = greybox): ${preview}${
      missingRefs.size > 8 ? ` … (+${missingRefs.size - 8} more)` : ''
    }`,
  );
}

// ---------------------------------------------------------------------------
// 3. Parse the OBJ with three.js' OBJLoader (gives us per-material groups).
// ---------------------------------------------------------------------------

const objFiles = allSourceFiles.filter((f) => f.toLowerCase().endsWith('.obj'));
if (objFiles.length === 0) {
  throw new Error(`No .obj file was found in ${sourceDir}.`);
}
const objPath = objFiles.sort(
  (a, b) => fs.statSync(b).size - fs.statSync(a).size,
)[0];

console.log(
  `[convert-map] Reading ${path.relative(root, objPath)} (${(
    fs.statSync(objPath).size /
    1024 /
    1024
  ).toFixed(1)} MB)`,
);
const objText = fs.readFileSync(objPath, 'utf8');

console.log('[convert-map] Parsing OBJ geometry…');
const objGroup = new OBJLoader().parse(objText); // materials left null -> defaults

// Collect every (vertex sub-range, material name) tuple across all meshes.
const sourceMeshes = [];
objGroup.traverse((child) => {
  if (!child.isMesh) return;
  sourceMeshes.push(child);
});
if (sourceMeshes.length === 0) throw new Error('OBJ produced no meshes.');

// ---------------------------------------------------------------------------
// 4. Bake transforms into positions.
// ---------------------------------------------------------------------------
//
// The original OBJ authors Y pointing downward. First pass: flip around X
// (y -> -y, z -> -z) to get Y-up. Also accumulate global bounds so we can
// center horizontally, rest the ground on y=0, and apply a uniform scale.

let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

for (const mesh of sourceMeshes) {
  const pos = mesh.geometry.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = -pos[i + 1]; // flip
    const z = -pos[i + 2]; // flip
    pos[i + 1] = y;
    pos[i + 2] = z;
    if (x < minX) minX = x; else if (x > maxX) maxX = x;
    if (y < minY) minY = y; else if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
  }
}

const sizeX = maxX - minX;
const sizeY = maxY - minY;
const sizeZ = maxZ - minZ;
const centerX = (maxX + minX) / 2;
const centerZ = (maxZ + minZ) / 2;
console.log(
  `[convert-map] Source bounds size (Y-up): ${sizeX.toFixed(1)} x ${sizeY.toFixed(
    1,
  )} x ${sizeZ.toFixed(1)}`,
);

const TARGET = 600;
const maxHoriz = Math.max(sizeX, sizeZ);
const scale = maxHoriz > 0 ? TARGET / maxHoriz : 1;
console.log(
  `[convert-map] Applying uniform scale ${scale.toFixed(4)} (target ~${TARGET}u horizontal).`,
);

// Second pass: center horizontally, drop ground to y=0, apply scale.
let outMinX = Infinity, outMinY = Infinity, outMinZ = Infinity;
let outMaxX = -Infinity, outMaxY = -Infinity, outMaxZ = -Infinity;
for (const mesh of sourceMeshes) {
  const pos = mesh.geometry.attributes.position.array;
  for (let i = 0; i < pos.length; i += 3) {
    const x = (pos[i] - centerX) * scale;
    const y = (pos[i + 1] - minY) * scale;
    const z = (pos[i + 2] - centerZ) * scale;
    pos[i] = x;
    pos[i + 1] = y;
    pos[i + 2] = z;
    if (x < outMinX) outMinX = x; if (x > outMaxX) outMaxX = x;
    if (y < outMinY) outMinY = y; if (y > outMaxY) outMaxY = y;
    if (z < outMinZ) outMinZ = z; if (z > outMaxZ) outMaxZ = z;
  }
}

// ---------------------------------------------------------------------------
// 5. Collect per-texture primitives.
// ---------------------------------------------------------------------------
//
// Strategy: group faces by *resolved texture path* (not by material name)
// so that when many materials share a texture (or when many materials have
// no texture at all) we can merge them into a single draw call.

/**
 * @typedef Primitive
 * @property {number[]} positions
 * @property {number[]} uvs
 * @property {{ minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number }} bounds
 */

/** @type {Map<string | null, Primitive>} */
const primitivesByTexture = new Map();

function primBucket(key) {
  let p = primitivesByTexture.get(key);
  if (!p) {
    p = {
      positions: [],
      uvs: [],
      bounds: {
        minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      },
    };
    primitivesByTexture.set(key, p);
  }
  return p;
}

let totalTriangles = 0;
let trianglesWithoutUVs = 0;
for (const mesh of sourceMeshes) {
  const geom = mesh.geometry;
  const pos = geom.attributes.position.array;
  const uv = geom.attributes.uv ? geom.attributes.uv.array : null;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = geom.groups && geom.groups.length > 0
    ? geom.groups
    : [{ start: 0, count: pos.length / 3, materialIndex: 0 }];

  for (const group of groups) {
    const mat = materials[group.materialIndex] || materials[0];
    const matName = mat ? mat.name : '';
    const texPath = resolvedByMaterial.get(matName) || null;
    const bucket = primBucket(texPath);

    const startVert = group.start; // vertex index (non-indexed stream)
    const endVert = startVert + group.count;
    for (let v = startVert; v < endVert; v += 1) {
      const px = pos[v * 3 + 0];
      const py = pos[v * 3 + 1];
      const pz = pos[v * 3 + 2];
      bucket.positions.push(px, py, pz);
      if (uv && texPath) {
        const u = uv[v * 2 + 0];
        // glTF images have the v-axis inverted relative to OBJ.
        const vv = 1 - uv[v * 2 + 1];
        bucket.uvs.push(u, vv);
      } else {
        // Greybox / missing UV: push zeros. The material will not reference
        // a texture so these coordinates are unused, but they must still be
        // present to keep the attribute array length in sync with positions.
        bucket.uvs.push(0, 0);
        if (!uv) trianglesWithoutUVs += 1;
      }
      const b = bucket.bounds;
      if (px < b.minX) b.minX = px; if (px > b.maxX) b.maxX = px;
      if (py < b.minY) b.minY = py; if (py > b.maxY) b.maxY = py;
      if (pz < b.minZ) b.minZ = pz; if (pz > b.maxZ) b.maxZ = pz;
    }
    totalTriangles += group.count / 3;
  }
}

// Free three.js buffers early.
objGroup.traverse?.((c) => c.geometry?.dispose?.());

console.log(
  `[convert-map] Bucketed into ${primitivesByTexture.size} texture primitives, ${Math.round(
    totalTriangles,
  )} triangles.`,
);
if (trianglesWithoutUVs > 0) {
  console.warn(
    `[convert-map] ${trianglesWithoutUVs} vertices were missing UVs; those faces fall back to greybox.`,
  );
}

// ---------------------------------------------------------------------------
// 6. Assemble the GLB.
// ---------------------------------------------------------------------------

const gltf = {
  asset: { version: '2.0', generator: '3dpawsville convert-map-to-glb' },
  scene: 0,
  scenes: [{ name: 'MapScene', nodes: [0] }],
  nodes: [{ name: 'MapRoot', mesh: 0 }],
  meshes: [{ name: 'MergedMap', primitives: [] }],
  buffers: [{ byteLength: 0 }],
  bufferViews: [],
  accessors: [],
  materials: [],
  textures: [],
  images: [],
  samplers: [
    // Default linear/mipmap trilinear + wrap repeat.
    { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 },
  ],
};

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const bufferChunks = []; // array of Buffer pieces; we pad-align each to 4 bytes
let bufferOffset = 0;

function padTo4() {
  const pad = (4 - (bufferOffset % 4)) % 4;
  if (pad > 0) {
    const padBuf = Buffer.alloc(pad);
    bufferChunks.push(padBuf);
    bufferOffset += pad;
  }
}

function addBufferView(bytes, target) {
  padTo4();
  const byteOffset = bufferOffset;
  const byteLength = bytes.length;
  bufferChunks.push(bytes);
  bufferOffset += byteLength;
  const view = { buffer: 0, byteOffset, byteLength };
  if (target !== undefined) view.target = target;
  gltf.bufferViews.push(view);
  return gltf.bufferViews.length - 1;
}

function addAccessor({
  bufferView,
  componentType,
  count,
  type,
  min,
  max,
}) {
  const acc = { bufferView, componentType, count, type };
  if (min) acc.min = min;
  if (max) acc.max = max;
  gltf.accessors.push(acc);
  return gltf.accessors.length - 1;
}

// Texture/image dedup: one image+texture per resolved texture path.
/** @type {Map<string, number>} */
const textureIndexByPath = new Map();

function addTexture(absPath) {
  if (textureIndexByPath.has(absPath)) return textureIndexByPath.get(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const mimeType =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const bytes = fs.readFileSync(absPath);
  const viewIndex = addBufferView(bytes); // images must not declare target
  const imageIndex = gltf.images.push({
    bufferView: viewIndex,
    mimeType,
    name: path.basename(absPath),
  }) - 1;
  const texIndex = gltf.textures.push({
    sampler: 0,
    source: imageIndex,
  }) - 1;
  textureIndexByPath.set(absPath, texIndex);
  return texIndex;
}

// The shared "greybox" material for unresolved textures.
const GREYBOX_MATERIAL = {
  name: 'greybox',
  pbrMetallicRoughness: {
    baseColorFactor: [0.6, 0.63, 0.68, 1.0],
    metallicFactor: 0.05,
    roughnessFactor: 0.92,
  },
  doubleSided: true,
};

function addMaterial(texPath) {
  if (!texPath) {
    gltf.materials.push(GREYBOX_MATERIAL);
    return gltf.materials.length - 1;
  }
  const texIndex = addTexture(texPath);
  gltf.materials.push({
    name: path.basename(texPath),
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index: texIndex },
      metallicFactor: 0.0,
      roughnessFactor: 0.95,
    },
    doubleSided: true,
  });
  return gltf.materials.length - 1;
}

// Emit one primitive per texture-bucket. Put the greybox bucket first so it
// loads before any network-heavy textured chunks.
const textureBuckets = [...primitivesByTexture.entries()].sort((a, b) => {
  if (a[0] === null) return -1;
  if (b[0] === null) return 1;
  return a[0].localeCompare(b[0]);
});

for (const [texPath, prim] of textureBuckets) {
  if (prim.positions.length === 0) continue;

  const posArr = new Float32Array(prim.positions);
  const uvArr = new Float32Array(prim.uvs);

  const posView = addBufferView(Buffer.from(posArr.buffer, posArr.byteOffset, posArr.byteLength), ARRAY_BUFFER);
  const uvView = addBufferView(Buffer.from(uvArr.buffer, uvArr.byteOffset, uvArr.byteLength), ARRAY_BUFFER);

  const vertexCount = posArr.length / 3;

  const posAccessor = addAccessor({
    bufferView: posView,
    componentType: 5126, // FLOAT
    count: vertexCount,
    type: 'VEC3',
    min: [prim.bounds.minX, prim.bounds.minY, prim.bounds.minZ],
    max: [prim.bounds.maxX, prim.bounds.maxY, prim.bounds.maxZ],
  });
  const uvAccessor = addAccessor({
    bufferView: uvView,
    componentType: 5126,
    count: vertexCount,
    type: 'VEC2',
  });

  const materialIndex = addMaterial(texPath);

  gltf.meshes[0].primitives.push({
    attributes: { POSITION: posAccessor, TEXCOORD_0: uvAccessor },
    material: materialIndex,
    mode: 4, // TRIANGLES
  });
}

// Finalize BIN buffer.
padTo4();
const bin = Buffer.concat(bufferChunks);
gltf.buffers[0].byteLength = bin.length;

// Build the GLB container.
const jsonStr = JSON.stringify(gltf);
let jsonBytes = Buffer.from(jsonStr, 'utf8');
// JSON chunk must be padded to a 4-byte boundary with ASCII spaces (0x20).
{
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad > 0) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]);
}
// BIN chunk must be padded to a 4-byte boundary with zeroes.
let binBytes = bin;
{
  const pad = (4 - (binBytes.length % 4)) % 4;
  if (pad > 0) binBytes = Buffer.concat([binBytes, Buffer.alloc(pad, 0)]);
}

const HEADER_SIZE = 12;
const CHUNK_HEADER_SIZE = 8;
const totalLength =
  HEADER_SIZE +
  CHUNK_HEADER_SIZE + jsonBytes.length +
  CHUNK_HEADER_SIZE + binBytes.length;

const glb = Buffer.alloc(totalLength);
let p = 0;
glb.write('glTF', p, 4, 'ascii'); p += 4;
glb.writeUInt32LE(2, p); p += 4; // version
glb.writeUInt32LE(totalLength, p); p += 4;

glb.writeUInt32LE(jsonBytes.length, p); p += 4;
glb.write('JSON', p, 4, 'ascii'); p += 4;
jsonBytes.copy(glb, p); p += jsonBytes.length;

glb.writeUInt32LE(binBytes.length, p); p += 4;
glb.writeUInt32LE(0x004E4942, p); p += 4; // "BIN\0"
binBytes.copy(glb, p); p += binBytes.length;

fs.writeFileSync(outFile, glb);

console.log(
  `[convert-map] Wrote ${path.relative(root, outFile)} (${(
    glb.length /
    1024 /
    1024
  ).toFixed(2)} MB). ${gltf.textures.length} textures embedded, ${
    gltf.meshes[0].primitives.length
  } primitives.`,
);
console.log(
  `[convert-map] Final bounds: x[${outMinX.toFixed(1)}, ${outMaxX.toFixed(
    1,
  )}] y[${outMinY.toFixed(1)}, ${outMaxY.toFixed(1)}] z[${outMinZ.toFixed(
    1,
  )}, ${outMaxZ.toFixed(1)}]`,
);
