import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';

test('search validates bounds, combines filters and sorts actual capture records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gongan-search-'));
  const app = createApplication({ databasePath: join(directory, 'platform.sqlite') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  async function request(path, method = 'GET', body, status = 200) {
    const response = await fetch(origin + path, { method, headers: {
      'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    csrf = value.csrfToken || csrf;
    return value;
  }
  try {
    await request('/api/setup', 'POST', { username: 'admin', password: 'Search-test-passphrase-2026' }, 201);
    await request('/api/auth/login', 'POST', { username: 'admin', password: 'Search-test-passphrase-2026' });
    for (const [name, longitude, confidence, occurredAt] of [
      ['Inside', 121.5, 96, '2026-10-30T08:00:00Z'], ['Outside', 122.5, 99, '2026-10-31T08:00:00Z'],
    ]) await request('/api/resources/captures', 'POST', {
      name: `Spatial ${name}`, longitude, latitude: 29.9, type: 'vehicle', confidence, occurredAt,
      district: '江北区', cameraCode: 'SEARCH-NB-001', age: '未知', imageUrl: `${origin}/authorized-image.png`,
    }, 201);
    const spatial = await request('/api/search?q=Spatial&west=121&east=122&south=29&north=30&minConfidence=90');
    assert.equal(spatial.total, 1);
    assert.equal(spatial.items[0].name, 'Spatial Inside');
    assert.equal((await request('/api/search?q=SEARCH-NB-001&imageOnly=1&sort=time-desc')).items[0].name, 'Spatial Outside');
    assert.equal((await request('/api/search?q=Spatial&sort=time-asc')).items[0].name, 'Spatial Inside');
    assert.equal((await request('/api/search?q=Spatial&sort=confidence-desc')).items[0].confidence, 99);
    assert.equal((await request('/api/search?q=Spatial&age=青年')).total, 0);
    await request('/api/resources/captures', 'POST', { name: 'Timezone record', occurredAt: '2026-10-30T16:00:00+08:00' }, 201);
    assert.equal((await request('/api/search?q=Timezone&from=2026-10-30T07:59:00Z&to=2026-10-30T08:01:00Z')).total, 1);
    const insideCamera = await request('/api/resources/cameras', 'POST', { name: 'Polygon camera inside', code: 'POLYGON-IN', longitude: 11, latitude: 10.5 }, 201);
    const outsideCamera = await request('/api/resources/cameras', 'POST', { name: 'Polygon camera outside', code: 'POLYGON-OUT', longitude: 20, latitude: 20 }, 201);
    for (const [longitude, latitude] of [[10.4, 10.4], [20, 20]]) await request('/api/resources/cameras', 'POST', { name: 'Duplicate code camera', code: 'POLYGON-DUP', longitude, latitude }, 201);
    for (const [name, linkage] of [
      ['By id', { cameraId: insideCamera.id, longitude: 120, latitude: 30 }],
      ['By code', { cameraCode: 'POLYGON-IN' }],
      ['Unlinked', { longitude: 11, latitude: 10.5 }],
      ['Outside camera', { cameraId: outsideCamera.id, cameraCode: 'POLYGON-IN', longitude: 11, latitude: 10.5 }],
      ['Ambiguous code', { cameraCode: 'POLYGON-DUP', longitude: 11, latitude: 10.5 }],
    ]) await request('/api/resources/captures', 'POST', { name: `CameraScope ${name}`, ...linkage }, 201);
    const polygon = encodeURIComponent(JSON.stringify([[10, 10], [12, 10], [11, 12]]));
    const cameraSearch = await request(`/api/search?q=CameraScope&cameraScope=1&polygon=${polygon}`);
    assert.equal(cameraSearch.cameraSelection.total, 2);
    assert.deepEqual(cameraSearch.items.map(item => item.name).sort(), ['CameraScope By code', 'CameraScope By id']);
    assert.equal((await request('/api/search?q=CameraScope&cameraScope=1&west=10&east=12&south=10&north=12')).total, 2);
    await request('/api/resources/captures', 'POST', { name: 'Invalid camera', cameraId: 'missing-camera' }, 400);
    for (const query of ['cameraScope=1', 'cameraScope=bad', 'cameraScope=1&polygon=bad', `cameraScope=1&polygon=${polygon}&west=10&east=12&south=10&north=12`])
      await request(`/api/search?${query}`, 'GET', undefined, 400);
    for (const query of [
      'west=121', 'west=&east=122&south=29&north=30', 'west=181&east=122&south=29&north=30',
      'west=121&east=122&south=30&north=29', 'from=2026-10-31&to=2026-10-30', 'sort=invalid',
    ]) await request(`/api/search?${query}`, 'GET', undefined, 400);
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('polygon validation supports concave areas, inclusive boundaries and rejects invalid outlines', async () => {
  const { validatePolygon, pointInPolygon } = await import('../shared/spatial.mjs');
  const polygon = validatePolygon([[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]]);
  assert.equal(pointInPolygon(.5, 2, polygon), true);
  assert.equal(pointInPolygon(2, 2, polygon), false);
  assert.equal(pointInPolygon(0, 1, polygon), true);
  assert.equal(pointInPolygon(0, 0, polygon), true);
  assert.equal(pointInPolygon(null, 1, polygon), false);
  const dateline = validatePolygon([[179, 0], [-179, 0], [-179, 2], [179, 2]]);
  assert.equal(pointInPolygon(180, 1, dateline), true);
  assert.equal(pointInPolygon(0, 1, dateline), false);
  for (const value of [[], [[0, 0], [1, 1]], [[0, 0], [1, 1], [2, 2]], [[0, 0], [2, 2], [0, 2], [2, 0]], [[181, 0], [1, 1], [2, 2]]])
    assert.throws(() => validatePolygon(value), /多边形/);
});

test('local visual similarity measures image pixels, not record identity or placeholder graphics', async () => {
  const { imageDescriptor, imageSimilarity } = await import('../shared/image-search.mjs');
  const pixels = value => Uint8ClampedArray.from({ length: 9 * 8 * 4 }, (_, i) => i % 4 === 3 ? 255 : value);
  const black = imageDescriptor(pixels(0)), white = imageDescriptor(pixels(255));
  assert.equal(imageSimilarity(black, black), 100);
  assert.ok(imageSimilarity(black, white) < 80);
  assert.throws(() => imageDescriptor(new Uint8ClampedArray(4)), /像素/);
});
