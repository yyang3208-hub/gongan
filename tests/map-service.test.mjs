import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.mjs';

test('Tianditu configuration and authenticated tile proxy do not expose the token', async () => {
  const token = 'test-only-tianditu-token';
  const upstreamRequests = [];
  let failUpstream = false;
  let browserKeyError = false;
  let jpegResponse = false;
  const app = createApplication({
    databasePath: ':memory:', tiandituToken: token,
    tileFetch: async url => {
      upstreamRequests.push(new URL(url));
      if (browserKeyError) return new Response(JSON.stringify({ code: 301012, resolve: 'Key权限类型为:浏览器端，请使用浏览器访问！' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      if (jpegResponse) return new Response(new Uint8Array([255, 216, 255]), { headers: { 'Content-Type': 'image/jpg' } });
      return failUpstream
        ? new Response('invalid token', { status: 200, headers: { 'Content-Type': 'text/xml' } })
        : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const fetchLocal = (path, options = {}) => fetch(origin + path, { ...options, headers: { Cookie: cookie, ...options.headers } });
  try {
    assert.equal((await fetchLocal('/api/map/config')).status, 401);
    assert.equal((await fetchLocal('/api/map/tiles/img/12/3350/1670')).status, 401);
    const login = await fetchLocal('/api/auth/demo', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    cookie = login.headers.get('set-cookie').split(';')[0];
    const config = await (await fetchLocal('/api/map/config')).json();
    assert.equal(config.provider, 'tianditu');
    assert.equal(config.configured, true);
    assert.ok(!JSON.stringify(config).includes(token));
    for (const layer of ['img', 'cia', 'vec', 'cva']) {
      const result = await fetchLocal(`/api/map/tiles/${layer}/12/3350/1670`);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('content-type'), 'image/png');
      assert.ok(!JSON.stringify([...result.headers]).includes(token));
      const upstream = upstreamRequests.at(-1);
      assert.equal(upstream.hostname, 't0.tianditu.gov.cn');
      assert.equal(upstream.searchParams.get('LAYER'), layer);
      assert.equal(upstream.searchParams.get('TILEMATRIXSET'), 'w');
      assert.equal(upstream.searchParams.get('TILEMATRIX'), '12');
      assert.equal(upstream.searchParams.get('TILECOL'), '3350');
      assert.equal(upstream.searchParams.get('TILEROW'), '1670');
      assert.equal(upstream.searchParams.get('tk'), token);
    }
    for (const path of ['/api/map/tiles/not-allowed/12/3/4', '/api/map/tiles/img/0/0/0', '/api/map/tiles/img/19/0/0', '/api/map/tiles/img/2/4/0']) {
      assert.equal((await fetchLocal(path)).status, 400);
    }
    failUpstream = true;
    const failure = await fetchLocal('/api/map/tiles/img/12/3350/1670');
    assert.equal(failure.status, 502);
    assert.ok(!(await failure.text()).includes(token));
    failUpstream = false; jpegResponse = true;
    const jpeg = await fetchLocal('/api/map/tiles/img/12/3350/1670');
    assert.equal(jpeg.status, 200);
    assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
    jpegResponse = false; browserKeyError = true;
    const keyTypeError = await fetchLocal('/api/map/tiles/img/12/3350/1670');
    assert.equal(keyTypeError.status, 502);
    assert.match((await keyTypeError.json()).error, /浏览器端.*直连/);
    const dashboard = await (await fetchLocal('/api/dashboard')).json();
    assert.equal(dashboard.targetHourly.length, 24);
    assert.ok(dashboard.targetHourly.every(item => item.faceTotal >= 0 && item.faceTotal <= item.total));
    assert.equal(dashboard.composition.reduce((sum, row) => sum + row.total, 0), dashboard.counts.captures);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.close();
  }
});

test('missing Tianditu key returns an explicit unconfigured state', async () => {
  const app = createApplication({ databasePath: ':memory:', tiandituToken: '' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await fetch(origin + '/api/auth/demo', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const config = await (await fetch(origin + '/api/map/config', { headers: { Cookie: cookie } })).json();
    assert.equal(config.configured, false);
    const tile = await fetch(origin + '/api/map/tiles/img/12/3350/1670', { headers: { Cookie: cookie } });
    assert.equal(tile.status, 503);
    assert.match((await tile.json()).error, /TIANDITU_TOKEN/);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.close();
  }
});
