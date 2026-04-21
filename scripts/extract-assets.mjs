import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd();
const sourceTexturesDir = path.join(root, 'assets', 'source');
const dragonOutDir = path.join(root, 'public', 'assets', 'dragon');

// The repo root holds two kinds of zips:
//   * `textures.zip` — the city map's source .obj + textures, extracted into
//     `assets/source/` for the map converter to pick up.
//   * `Meshy_AI_Emerald_Dragonling_biped*.zip` — the rigged player character +
//     baked animation library. Each contains two GLB files we want exposed
//     directly under `public/assets/dragon/` for the runtime to fetch.
const zipFiles = fs
  .readdirSync(root)
  .filter((file) => file.toLowerCase().endsWith('.zip'));

if (zipFiles.length === 0) {
  throw new Error('No zip files found in repo root.');
}

fs.mkdirSync(sourceTexturesDir, { recursive: true });
fs.mkdirSync(dragonOutDir, { recursive: true });

for (const file of zipFiles) {
  const zipPath = path.join(root, file);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const lower = file.toLowerCase();

  if (lower.includes('dragon') || lower.includes('meshy')) {
    let characterCopied = false;
    let animationsCopied = false;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!entry.entryName.toLowerCase().endsWith('.glb')) continue;
      const buf = entry.getData();
      const name = entry.entryName.toLowerCase();
      if (name.includes('character') && !characterCopied) {
        fs.writeFileSync(path.join(dragonOutDir, 'character.glb'), buf);
        characterCopied = true;
      } else if (
        (name.includes('animation') || name.includes('merged_animations')) &&
        !animationsCopied
      ) {
        fs.writeFileSync(path.join(dragonOutDir, 'animations.glb'), buf);
        animationsCopied = true;
      }
    }
    if (!characterCopied || !animationsCopied) {
      console.warn(
        `[extract-assets] ${file}: copied character=${characterCopied} animations=${animationsCopied}`,
      );
    } else {
      console.log(
        `[extract-assets] Copied dragon GLBs from ${file} into ${path.relative(root, dragonOutDir)}/`,
      );
    }
  } else {
    zip.extractAllTo(sourceTexturesDir, true);
    console.log(
      `[extract-assets] Extracted ${file} into ${path.relative(root, sourceTexturesDir)}`,
    );
  }
}
