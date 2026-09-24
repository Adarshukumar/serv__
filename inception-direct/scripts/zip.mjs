// Packs dist/ into inception-direct-<version>.zip (for sharing or the Chrome Web Store).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('No build found — run `npm run build` first.');
  process.exit(1);
}

const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files[relative(dist, path).split(sep).join('/')] = new Uint8Array(readFileSync(path));
  }
})(dist);

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, `inception-direct-${version}.zip`);
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`Wrote ${relative(root, out)} — ${Object.keys(files).length} files.`);
