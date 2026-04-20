import fs from 'node:fs';
import path from 'node:path';
import obj2gltf from 'obj2gltf';

const root = process.cwd();
const sourceDir = path.join(root, 'assets', 'source');
const outDir = path.join(root, 'public', 'assets');
const outFile = path.join(outDir, 'map.glb');

function walk(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      files = files.concat(walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

if (!fs.existsSync(sourceDir)) {
  throw new Error('Missing extracted assets. Run npm run extract:assets first.');
}

const objFiles = walk(sourceDir).filter((file) => file.toLowerCase().endsWith('.obj'));
if (objFiles.length === 0) {
  throw new Error('No OBJ file found in extracted assets.');
}

const objPath = objFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
fs.mkdirSync(outDir, { recursive: true });

console.log(`Converting ${path.relative(root, objPath)} -> ${path.relative(root, outFile)}`);
await obj2gltf(objPath, {
  binary: true,
  separate: false,
  output: outFile,
});

console.log('GLB conversion complete.');
