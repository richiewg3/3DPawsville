import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd();
const extractionDir = path.join(root, 'assets', 'source');

const zipFiles = fs
  .readdirSync(root)
  .filter((file) => file.toLowerCase().endsWith('.zip'));

if (zipFiles.length !== 1) {
  throw new Error(
    `Expected exactly one zip file in repo root, found ${zipFiles.length}.`,
  );
}

const zipPath = path.join(root, zipFiles[0]);
fs.mkdirSync(extractionDir, { recursive: true });

const zip = new AdmZip(zipPath);
zip.extractAllTo(extractionDir, true);

console.log(`Extracted ${zipFiles[0]} into ${path.relative(root, extractionDir)}`);
