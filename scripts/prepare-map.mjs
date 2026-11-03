import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [resolve(root, 'scripts', 'map-engine.mjs')],
  outfile: resolve(root, 'public', 'vendor', 'map-engine.js'),
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  legalComments: 'linked',
});
console.log('Map engine bundled without the Knockout-based Viewer widgets.');
