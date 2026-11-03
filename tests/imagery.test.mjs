import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMission } from '../shared/imagery-plan.mjs';
import { missionKmz } from '../server/imagery-kmz.mjs';
import { createApplication } from '../server/app.mjs';
import { photoAttitude, photoSelection, JpegIntegrity } from '../server/imagery-photo.mjs';

const plainJpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 20, 0, 40, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
function attitudeJpeg(pitch) {
  const xmp = Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"><rdf:Description drone-dji:GimbalPitchDegree="${pitch}"/></x:xmpmeta>`);
  const header = Buffer.alloc(4); header[0] = 255; header[1] = 0xe1; header.writeUInt16BE(xmp.length + 2, 2);
  return Buffer.concat([plainJpeg.subarray(0, 2), header, xmp, plainJpeg.subarray(2)]);
}

test('streaming JPEG validation accepts camera trailers but rejects truncated images and EOI inside metadata', () => {
  for (const chunkSize of [1, 2, 7, 65536]) {
    const trailer = Buffer.alloc(4095, 0xa3), jpeg = Buffer.concat([attitudeJpeg(-90), trailer]), integrity = new JpegIntegrity();
    for (let offset = 0; offset < jpeg.length; offset += chunkSize) integrity.write(jpeg.subarray(offset, offset + chunkSize));
    assert.deepEqual(integrity.finish(), { jpegTrailingBytes: 4095 });
  }
  const normal = new JpegIntegrity(); normal.write(plainJpeg);
  assert.deepEqual(normal.finish(), { jpegTrailingBytes: 0 });
  const scan = Buffer.concat([plainJpeg.subarray(0, -2), Buffer.from([255, 218, 0, 2, 40, 255, 0, 217, 80, 255, 208, 90, 255, 217, 7])]);
  const scanned = new JpegIntegrity();
  for (const byte of scan) scanned.write(Buffer.from([byte]));
  assert.deepEqual(scanned.finish(), { jpegTrailingBytes: 1 });
  const metadata = Buffer.from([255, 216, 255, 225, 0, 6, 255, 217, 0, 0]);
  const missing = new JpegIntegrity(); missing.write(metadata);
  assert.throws(() => missing.finish(), /结束标记/);
  const truncated = new JpegIntegrity(); truncated.write(plainJpeg.subarray(0, -1));
  assert.throws(() => truncated.finish(), /结束标记/);
  const large = new JpegIntegrity(); large.write(Buffer.concat([plainJpeg, Buffer.alloc(65537)]));
  assert.equal(large.finish().jpegTrailingBytes, 65537);
  assert.match(large.finish().jpegWarning, /尾部数据/);
  assert.throws(() => new JpegIntegrity().write(Buffer.from([255, 216, 255, 225, 0, 1])), /段长度/);
});

test('DJI XMP nadir selection excludes oblique, missing, conflicting and malformed attitude', () => {
  for (const pitch of [-92, -90, -88, '-90.00']) {
    const meta = photoAttitude(attitudeJpeg(pitch));
    assert.equal(meta.viewClass, 'nadir'); assert.equal(meta.gimbalPitch, Number(pitch));
  }
  for (const pitch of [-92.01, -87.99, -45, 0, 90]) assert.equal(photoAttitude(attitudeJpeg(pitch)).viewClass, 'oblique');
  for (const pitch of ['', 'NaN', 'Infinity', '-999', '0x5a']) assert.equal(photoAttitude(attitudeJpeg(pitch)).viewClass, 'unknown');
  assert.equal(photoAttitude(plainJpeg).viewClass, 'unknown');
  const conflict = Buffer.concat([attitudeJpeg(-90).subarray(0, -2), attitudeJpeg(-45).subarray(2)]);
  assert.equal(photoAttitude(conflict).viewClass, 'unknown');
  const photos = [-90, -89, -45].map((pitch, id) => ({ id, type: 'photos', ...photoAttitude(attitudeJpeg(pitch)) }));
  photos.push({ id: 3, type: 'photos', ...photoAttitude(plainJpeg) }, { id: 4, type: 'panorama', ...photoAttitude(attitudeJpeg(-90)) });
  assert.deepEqual(photoSelection(photos).photoIds, [0, 1]);
  assert.deepEqual(photoSelection(photos).summary, { total: 4, selected: 2, oblique: 1, unknown: 1, rule: 'DJI GimbalPitchDegree = −90°±2°' });
});

const parameters = { name: 'M3E local survey', kind: 'ortho', capturedAt: '2026-10-31T08:00:00Z', polygon: [[121.5, 29.95], [121.502, 29.95], [121.502, 29.952], [121.5, 29.952]], altitude: 80, speed: 5, frontOverlap: 80, sideOverlap: 70, heading: 0 };

test('M3E overlap grid, limits and independently authored WPML archive', () => {
  const mission = planMission(parameters);
  assert.ok(mission.plan.areaM2 > 40000 && mission.plan.areaM2 < 45000);
  assert.ok(mission.plan.waypoints.length > 10 && mission.plan.waypoints.length < 500);
  assert.ok(mission.plan.gsdCm > 2 && mission.plan.gsdCm < 3);
  assert.equal(mission.plan.photoCount, mission.plan.waypoints.length);
  for (const point of mission.plan.waypoints) {
    assert.ok(point.longitude >= 121.5 - 1e-8 && point.longitude <= 121.502 + 1e-8);
    assert.ok(point.latitude >= 29.95 - 1e-8 && point.latitude <= 29.952 + 1e-8);
  }
  const rotated = planMission({ ...parameters, heading: 45 });
  assert.ok(rotated.plan.waypoints.length > 10);
  const panorama = planMission({ ...parameters, kind: 'panorama' });
  assert.equal(panorama.plan.photoCount, 25);
  for (const patch of [{ altitude: 0 }, { speed: 99 }, { polygon: [[0, 0], [1, 0], [1, 1], [.5, .2], [0, 1]] }, { polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] }, { capturedAt: 'bad' }])
    assert.throws(() => planMission({ ...parameters, ...patch }));
  const zip = missionKmz(mission);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const text = zip.toString('utf8');
  for (const value of ['wpmz/template.kml', 'wpmz/waylines.wpml', '<wpml:droneEnumValue>77', '<wpml:payloadEnumValue>68', 'relativeToStartPoint', 'takePhoto', 'gimbalRotate', 'goBack', 'goHome']) assert.ok(text.includes(value), value);
  assert.ok(text.includes('<wpml:gimbalPitchRotateAngle>-90'));
});

test('real processing adapter exchanges NodeODM requests, publishes only existing GDAL output and persists failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gongan-pipeline-'));
  let photoUploads = 0, initOptions, shouldFail = false, invalidDownload = '', commands = 0, incompleteTiles = false;
  const archive = Buffer.from('UEsDBBQAAAAAAOxOYV1VEFQkCAAAAAgAAAAhAAAAb2RtX29ydGhvcGhvdG8vb2RtX29ydGhvcGhvdG8udGlmSUkqAAAAAABQSwECFAAUAAAAAADsTmFdVRBUJAgAAAAIAAAAIQAAAAAAAAAAAAAAgAEAAAAAb2RtX29ydGhvcGhvdG8vb2RtX29ydGhvcGhvdG8udGlmUEsFBgAAAAABAAEATwAAAEcAAAAAAA==', 'base64');
  const engine = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString();
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/task/new/init') { initOptions = input; res.end(JSON.stringify({ uuid: 'local-engine-task' })); }
    else if (req.url === '/task/new/upload/local-engine-task') { photoUploads++; res.end('{"success":true}'); }
    else if (req.url === '/task/new/commit/local-engine-task') res.end('{"uuid":"local-engine-task"}');
    else if (req.url === '/task/local-engine-task/info') res.end(JSON.stringify({ status: { code: shouldFail ? 30 : 40 }, progress: 100 }));
    else if (req.url === '/task/local-engine-task/download/all.zip') {
      if (invalidDownload === 'json') res.end('{"error":"Invalid asset"}');
      else {
        res.setHeader('Content-Type', 'application/zip');
        res.end(invalidDownload === 'header' ? Buffer.from('not a ZIP') : archive);
      }
    }
    else { res.statusCode = 404; res.end('{"error":"unsupported engine path"}'); }
  });
  await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
  const app = createApplication({ databasePath: join(directory, 'platform.sqlite'), imagery: {
    nodeodmUrl: `http://127.0.0.1:${engine.address().port}`, gdalTranslate: process.execPath, gdalInfo: process.execPath, gdal2tiles: process.execPath, pollMs: 1,
    async runCommand(executable, args) {
      commands++;
      if (args.includes('--help')) return '  --legacy            Generate a complete tile pyramid\n';
      if (args[0] === '-json') return JSON.stringify({ wgs84Extent: { coordinates: [parameters.polygon] } });
      if (args.includes('--xyz')) {
        assert.ok(args.includes('--legacy'));
        const tiles = args.at(-1);
        for (let z = 0; z <= 21; z++) {
          if (incompleteTiles && z === 0) continue;
          const n = 2 ** z, lat = 29.951 * Math.PI / 180;
          const x = Math.floor((121.501 + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n);
          const path = join(tiles, String(z), String(x)); await mkdir(path, { recursive: true });
          await writeFile(join(path, `${y}.png`), Buffer.from('89504e470d0a1a0a', 'hex'));
        }
        return '';
      }
      assert.ok(args.at(-2).startsWith('/vsizip/'));
      assert.ok(args.at(-2).endsWith('/all.zip/odm_orthophoto/odm_orthophoto.tif'));
      await writeFile(args.at(-1), Buffer.from('49492a0000000000', 'hex')); return '';
    },
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  async function request(path, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value));
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie; csrf = value.csrfToken || csrf; return value;
  }
  try {
    await request('/api/setup', 'POST', { username: 'admin', password: 'Pipeline-Local-Passphrase' }, 201);
    await request('/api/auth/login', 'POST', { username: 'admin', password: 'Pipeline-Local-Passphrase' });
    const mission = await request('/api/imagery/imports', 'POST', { name: parameters.name, capturedAt: parameters.capturedAt }, 201);
    assert.equal(mission.source, 'import'); assert.equal(mission.plan, null);
    await request(`/api/imagery/missions/${mission.id}/route.kmz`, 'GET', undefined, 409);
    await request(`/api/imagery/missions/${mission.id}/process`, 'POST', { capturedAt: parameters.capturedAt }, 400);
    const jpeg = Buffer.concat([attitudeJpeg(-90), Buffer.alloc(4095, 0xa3)]);
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${origin}/api/imagery/missions/${mission.id}/photos?filename=photo${i}.jpg`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: jpeg });
      assert.equal(response.status, 201);
      if (i === 1) await request(`/api/imagery/missions/${mission.id}/process`, 'POST', { capturedAt: parameters.capturedAt }, 400);
    }
    for (const [filename, buffer] of [['left/DJI_0001.jpg', attitudeJpeg(-45)], ['unknown/DJI_0001.jpg', plainJpeg]]) {
      const response = await fetch(`${origin}/api/imagery/missions/${mission.id}/photos?filename=${encodeURIComponent(filename)}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: buffer });
      assert.equal(response.status, 201);
    }
    const photos = await request(`/api/imagery/missions/${mission.id}/photos`);
    assert.equal(photos.selection.selected, 3); assert.equal(photos.selection.oblique, 1); assert.equal(photos.selection.unknown, 1);
    assert.equal(photos.items.find(photo => photo.name === 'photo0.jpg').jpegTrailingBytes, 4095);
    const queued = await request(`/api/imagery/missions/${mission.id}/process`, 'POST', { capturedAt: parameters.capturedAt }, 202);
    assert.equal(queued.photoIds.length, 3); assert.equal(queued.selection.total, 5);
    const later = await fetch(`${origin}/api/imagery/missions/${mission.id}/photos?filename=later-nadir.jpg`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: jpeg });
    assert.equal(later.status, 201);
    async function waitForJob() {
      for (let i = 0; i < 100; i++) {
        const snapshot = await request('/api/imagery');
        if (['completed', 'failed'].includes(snapshot.jobs[0]?.status)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Processing job did not finish');
    }
    const done = await waitForJob();
    assert.equal(done.jobs[0].status, 'completed', done.jobs[0].error);
    assert.equal(photoUploads, 3); assert.ok(initOptions.includes('fast-orthophoto'));
    assert.equal(done.assets.length, 1); assert.equal(done.jobs[0].assetId, done.assets[0].id);
    assert.equal(done.assets[0].processingMode, 'nadir-dom');
    assert.equal(done.assets[0].selection.selected, 3);
    assert.deepEqual(done.assets[0].bounds, { west: 121.5, south: 29.95, east: 121.502, north: 29.952 });
    const tile = done.assets[0].url.replace('{z}', '15').replace('{x}', '27443').replace('{y}', '13524');
    assert.equal((await fetch(origin + tile, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(origin + tile)).status, 401);
    for (const invalid of ['json', 'header']) {
      invalidDownload = invalid;
      const beforeCommands = commands;
      await request(`/api/imagery/missions/${mission.id}/process`, 'POST', { capturedAt: parameters.capturedAt }, 202);
      const failedDownload = await waitForJob();
      assert.equal(failedDownload.jobs[0].status, 'failed');
      assert.equal(failedDownload.jobs[0].stage, 'download');
      assert.match(failedDownload.jobs[0].error, invalid === 'json' ? /Invalid asset/ : /ZIP/);
      assert.equal(commands, beforeCommands);
      assert.equal(failedDownload.assets.length, 1);
    }
    invalidDownload = '';
    shouldFail = true;
    await request(`/api/imagery/missions/${mission.id}/process`, 'POST', { capturedAt: parameters.capturedAt }, 202);
    const failed = await waitForJob();
    assert.equal(failed.jobs[0].status, 'failed'); assert.ok(failed.jobs[0].error.includes('NodeODM'));
    assert.equal(failed.assets.length, 1);
    shouldFail = false; incompleteTiles = true;
    await request(`/api/imagery/missions/${mission.id}/process`, 'POST', { capturedAt: parameters.capturedAt }, 202);
    const incomplete = await waitForJob();
    assert.equal(incomplete.jobs[0].status, 'failed'); assert.equal(incomplete.jobs[0].stage, 'tiles');
    assert.match(incomplete.jobs[0].error, /0–21/); assert.equal(incomplete.assets.length, 1);
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.close();
    await new Promise(resolve => engine.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('imagery missions, assets, binary upload and truthful unavailable services persist behind authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gongan-imagery-'));
  const databasePath = join(directory, 'platform.sqlite');
  const app = createApplication({ databasePath });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  async function request(path, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie; csrf = value.csrfToken || csrf;
    return value;
  }
  try {
    await request('/api/imagery', 'GET', undefined, 401);
    await request('/api/setup', 'POST', { username: 'admin', password: 'Imagery-Local-Test-Passphrase' }, 201);
    await request('/api/auth/login', 'POST', { username: 'admin', password: 'Imagery-Local-Test-Passphrase' });
    const mission = await request('/api/imagery/missions', 'POST', parameters, 201);
    assert.ok(mission.id); assert.ok(mission.plan.waypoints.length);
    const kmz = await fetch(`${origin}/api/imagery/missions/${mission.id}/route.kmz`, { headers: { Cookie: cookie } });
    assert.equal(kmz.status, 200); assert.equal(Buffer.from(await kmz.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    await request(`/api/imagery/missions/${mission.id}/dispatch`, 'POST', {}, 503);
    await request(`/api/imagery/missions/${mission.id}/process`, 'POST', {}, 503);
    const upload = (bytes, extra = {}) => fetch(`${origin}/api/imagery/missions/${mission.id}/photos?filename=sample.jpg`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream', ...extra }, body: bytes });
    assert.equal((await upload(Buffer.from('not a photo'))).status, 400);
    assert.equal((await upload(Buffer.from('not a photo'), { 'X-CSRF-Token': 'bad' })).status, 403);
    const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 20, 0, 40, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
    assert.equal((await upload(jpeg)).status, 201);
    assert.equal((await upload(jpeg)).status, 409);
    const photos = await request(`/api/imagery/missions/${mission.id}/photos`);
    assert.equal(photos.total, 1); assert.equal(photos.items[0].name, 'sample.jpg');
    const panoramaUpload = await fetch(`${origin}/api/imagery/missions/${mission.id}/panorama?filename=stitched.jpg&capturedAt=${encodeURIComponent(parameters.capturedAt)}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: jpeg });
    assert.equal(panoramaUpload.status, 201);
    const panoramaAsset = await panoramaUpload.json();
    assert.equal(panoramaAsset.kind, 'panorama'); assert.equal(panoramaAsset.positioning, 'mission-estimate');
    assert.equal((await fetch(origin + panoramaAsset.url, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(origin + panoramaAsset.url)).status, 401);
    const unsupported = await fetch(`${origin}/api/imagery/missions/${mission.id}/orthophoto?filename=stitched.tif`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('49492a00', 'hex') });
    assert.equal(unsupported.status, 503);
    const asset = await request('/api/imagery/assets', 'POST', { name: 'Authorized DOM', kind: 'ortho', capturedAt: parameters.capturedAt, bounds: { west: 121.5, east: 121.502, south: 29.95, north: 29.952 }, url: 'https://example.com/ortho/{z}/{x}/{y}.png', minimumLevel: 0, maximumLevel: 20, tileScheme: 'xyz', missionId: mission.id }, 201);
    assert.ok(asset.id);
    await request('/api/imagery/assets', 'POST', { ...asset, url: 'file:///C:/Windows/win.ini' }, 400);
    const snapshot = await request('/api/imagery');
    assert.equal(snapshot.missions[0].photoCount, 1); assert.equal(snapshot.assets.length, 2); assert.equal(snapshot.capabilities.dispatch, false);
    await request('/api/auth/demo', 'POST', {});
    await request('/api/imagery/missions', 'POST', parameters, 403);
    await request('/api/imagery/assets', 'POST', { name: 'no' }, 403);
    assert.equal((await request('/api/imagery')).missions.length, 1);
    assert.equal((await fetch(`${origin}/api/imagery/files/../../platform.sqlite`, { headers: { Cookie: cookie } })).status, 404);
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
