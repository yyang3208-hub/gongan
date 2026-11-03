import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createApplication } from '../server/app.mjs';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = {
  gdalInfo: process.env.IMAGERY_GDAL_INFO,
  gdalTranslate: process.env.IMAGERY_GDAL_TRANSLATE,
  gdal2tiles: process.env.IMAGERY_GDAL2TILES,
  python: process.env.IMAGERY_PYTHON,
};
const available = [config.gdalInfo, config.gdalTranslate, config.gdal2tiles].every(path => path && existsSync(path));
const nodeodmUrl = process.env.IMAGERY_NODEODM_URL;

test('installed NodeODM exposes its actual ODM engine, supported processing options and task catalog', { skip: nodeodmUrl ? false : 'Local NodeODM is not configured', timeout: 30000 }, async () => {
  async function get(path) {
    const response = await fetch(new URL(path, nodeodmUrl), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); return response.json();
  }
  const info = await get('info');
  assert.equal(info.engine, 'odm'); assert.ok(info.engineVersion); assert.ok(info.version);
  const options = await get('options');
  for (const name of ['fast-orthophoto', 'skip-report', 'orthophoto-resolution', 'feature-quality'])
    assert.ok(options.some(option => option.name === name), `NodeODM does not advertise ${name}`);
  assert.ok(Array.isArray(await get('task/list')));
});

test('installed GDAL performs actual authenticated GeoTIFF upload, normalization, georeferencing, tiling and private publication', { skip: available ? false : 'Local GDAL executables are not configured', timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gongan-real-gdal-'));
  let app;
  try {
    const source = join(directory, 'source.ppm'), tif = join(directory, 'source.tif');
    await writeFile(source, Buffer.concat([Buffer.from('P6\n32 32\n255\n'), Buffer.alloc(32 * 32 * 3, 170)]));
    await promisify(execFile)(config.gdalTranslate, ['-of', 'GTiff', '-a_srs', 'EPSG:4326', '-a_ullr', '121.5', '29.95005', '121.50005', '29.95', source, tif], { timeout: 30000 });
    app = createApplication({ databasePath: join(directory, 'platform.sqlite'), imagery: config });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    let cookie = '', csrf = '';
    async function request(path, method = 'GET', body, expected = 200) {
      const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value));
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie; csrf = value.csrfToken || csrf; return value;
    }
    await request('/api/imagery', 'GET', undefined, 401);
    await request('/api/setup', 'POST', { username: 'admin', password: 'Local-GDAL-Test-Passphrase' }, 201);
    await request('/api/auth/login', 'POST', { username: 'admin', password: 'Local-GDAL-Test-Passphrase' });
    const capturedAt = '2026-10-30T01:00:00Z';
    const mission = await request('/api/imagery/imports', 'POST', { name: 'Installed GDAL fixture, not flight photography', capturedAt }, 201);
    const upload = await fetch(`${origin}/api/imagery/missions/${mission.id}/orthophoto?filename=source.tif&capturedAt=${capturedAt}`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: await readFile(tif),
    });
    assert.equal(upload.status, 202);
    let snapshot;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      snapshot = await request('/api/imagery');
      if (['completed', 'failed'].includes(snapshot.jobs[0]?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(snapshot.jobs[0].status, 'completed', snapshot.jobs[0].error);
    assert.equal(snapshot.assets.length, 1);
    const asset = snapshot.assets[0];
    assert.equal(asset.processingMode, 'geotiff');
    assert.ok(Math.abs(asset.bounds.west - 121.5) < 1e-8);
    assert.ok(Math.abs(asset.bounds.north - 29.95005) < 1e-8);
    const n = 2 ** 21, longitude = 121.500025, latitude = 29.950025;
    const x = Math.floor((longitude + 180) / 360 * n), y = Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * n);
    const tile = asset.url.replace('{z}', '21').replace('{x}', String(x)).replace('{y}', String(y));
    const response = await fetch(origin + tile, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 256); assert.equal(png.readUInt32BE(20), 256);
    assert.equal((await fetch(origin + tile)).status, 401);
    await new Promise(resolve => app.server.close(resolve)); app.close(); app = undefined;
    app = createApplication({ databasePath: join(directory, 'platform.sqlite'), imagery: config });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const persisted = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/imagery`, { headers: { Cookie: cookie } })).json();
    assert.equal(persisted.assets[0].id, asset.id); assert.equal(persisted.jobs[0].status, 'completed');
  } finally {
    if (app) { await new Promise(resolve => app.server.close(resolve)); app.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});
