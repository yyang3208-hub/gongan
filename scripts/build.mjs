import { cp, mkdir, readdir, access, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await import('./prepare-map.mjs');
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`Syntax check failed: ${path}`);
    }
  }
}
for (const directory of ['server', 'public', 'shared', 'tests']) await check(resolve(root, directory));
await access(resolve(root, 'node_modules', 'cesium', 'Build', 'Cesium', 'Cesium.js'));
const output = resolve(root, 'dist');
await mkdir(output, { recursive: true });
for (const directory of ['server', 'shared', 'public']) await cp(resolve(root, directory), resolve(output, directory), { recursive: true });
await cp(resolve(root, 'server.mjs'), resolve(output, 'server.mjs'));
await cp(resolve(root, 'node_modules', 'cesium', 'Build', 'Cesium'), resolve(output, 'public', 'vendor', 'cesium'), { recursive: true });
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: 'gongan-runtime', type: 'module', private: true, scripts: { start: 'node server.mjs' }, engines: { node: '>=24.13.1' } }, null, 2));
await writeFile(resolve(output, 'BUILD.json'), JSON.stringify({ builtAt: new Date().toISOString(), version: JSON.parse(await readFile(resolve(root, 'package.json'))).version, dataIncluded: false }, null, 2));
console.log('Build passed. Runtime bundle: dist (no credentials or database included). Start: node dist\\server.mjs');
