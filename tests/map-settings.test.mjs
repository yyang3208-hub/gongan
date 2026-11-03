import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';

test('administrator map settings persist, redact/encrypt secrets and apply to the tile service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gongan-map-settings-'));
  const databasePath = join(directory, 'platform.sqlite');
  const savedToken = 'test-only-configured-map-token';
  const upstreamRequests = [];
  const options = {
    databasePath, tiandituToken: 'test-only-environment-token',
    tileFetch: async url => {
      upstreamRequests.push(new URL(url));
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
    },
  };
  let app;
  let origin;
  let cookie = '';
  let csrf = '';
  const start = async () => {
    app = createApplication(options);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
  };
  const stop = async () => {
    if (!app) return;
    await new Promise(resolve => app.server.close(resolve));
    app.close(); app = undefined;
  };
  const request = (path, method = 'GET', body, version) => fetch(origin + path, {
    method,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(version === undefined ? {} : { 'If-Match': String(version) }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async (username = 'admin', password = 'Map-Settings-Test-Passphrase') => {
    const result = await request('/api/auth/login', 'POST', { username, password });
    assert.equal(result.status, 200);
    cookie = result.headers.get('set-cookie').split(';')[0];
    csrf = (await (await request('/api/auth/me')).json()).csrfToken;
  };
  try {
    await start();
    assert.equal((await request('/api/admin/map')).status, 401);
    assert.equal((await request('/api/setup', 'POST', { username: 'admin', password: 'Map-Settings-Test-Passphrase' })).status, 201);
    await login();
    const original = await (await request('/api/admin/map')).json();
    assert.equal(original.tokenSource, 'environment');
    const { version, ...publicFields } = await (await request('/api/map/config')).json();
    const fields = {
      defaultBasemap: 'street', labelsVisible: false, longitude: 116.391,
      latitude: 39.907, height: 12000, heading: 35, pitch: -65,
      minimumLevel: 3, maximumLevel: 16,
    };
    const update = { ...fields, tokenAction: 'replace', token: savedToken };
    assert.equal((await request('/api/admin/map', 'PUT', update, original.version)).status, 200);
    const stored = await (await request('/api/admin/map')).json();
    assert.equal(stored.tokenConfigured, true);
    assert.equal(stored.tokenSource, 'database');
    assert.ok(!JSON.stringify(stored).includes(savedToken));
    const config = await (await request('/api/map/config')).json();
    for (const [key, value] of Object.entries(fields)) assert.equal(config[key], value);
    assert.ok(!JSON.stringify(config).includes(savedToken));
    assert.ok(!('tokenSource' in config));
    assert.equal(config.provider, publicFields.provider);
    assert.equal((await request('/api/map/tiles/vec/12/3350/1670')).status, 200);
    assert.equal(upstreamRequests.at(-1).searchParams.get('tk'), savedToken);
    assert.equal((await request('/api/map/tiles/img/2/0/0')).status, 400);
    assert.equal((await request('/api/map/tiles/img/17/0/0')).status, 400);
    assert.equal((await request('/api/admin/map', 'PUT', { ...fields, tokenAction: 'keep' }, original.version)).status, 409);
    for (const invalid of [
      { longitude: 181 }, { latitude: 86 }, { height: 0 }, { heading: '35' },
      { pitch: 0 }, { minimumLevel: 17, maximumLevel: 16 }, { maximumLevel: 19 },
      { labelsVisible: 'false' }, { defaultBasemap: 'unsupported' },
      { accessMode: 'unsupported' },
      { provider: 'custom', url: 'https://example.org' },
      { tokenAction: 'replace', token: 'invalid token with spaces' },
      { tokenAction: 'clear', token: savedToken },
    ]) {
      assert.equal((await request('/api/admin/map', 'PUT', { ...fields, tokenAction: 'keep', ...invalid }, stored.version)).status, 400);
    }
    const withoutCsrf = await fetch(origin + '/api/admin/map', { method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
    assert.equal(withoutCsrf.status, 403);
    const audit = await (await request('/api/audit')).json();
    assert.ok(audit.items.some(item => item.resource === 'map' && item.action === 'configure'));
    assert.ok(!JSON.stringify(audit).includes(savedToken));
    for (const role of ['operator', 'viewer']) {
      await request('/api/users', 'POST', { username: `map-${role}`, name: role, role, password: 'Map-Role-Test-Passphrase' });
      const adminCookie = cookie, adminCsrf = csrf;
      await login(`map-${role}`, 'Map-Role-Test-Passphrase');
      assert.equal((await request('/api/admin/map')).status, 403);
      assert.equal((await request('/api/admin/map', 'PUT', update, stored.version)).status, 403);
      assert.equal((await request('/api/map/config')).status, 200);
      cookie = adminCookie; csrf = adminCsrf;
    }
    await stop();
    assert.ok(!(await readFile(databasePath)).includes(Buffer.from(savedToken)));
    await start();
    await login();
    const reloaded = await (await request('/api/admin/map')).json();
    assert.equal(reloaded.longitude, fields.longitude);
    assert.equal(reloaded.tokenConfigured, true);
    assert.equal((await request('/api/map/tiles/vec/12/3350/1670')).status, 200);
    assert.equal(upstreamRequests.at(-1).searchParams.get('tk'), savedToken);
    assert.equal((await request('/api/admin/map', 'PUT', { ...fields, tokenAction: 'keep' }, reloaded.version)).status, 200);
    const kept = await (await request('/api/admin/map')).json();
    assert.equal(kept.tokenConfigured, true);
    assert.equal((await request('/api/admin/map', 'PUT', { ...fields, tokenAction: 'clear' }, kept.version)).status, 200);
    assert.equal((await (await request('/api/map/config')).json()).configured, false);
    assert.equal((await request('/api/map/tiles/img/12/3350/1670')).status, 503);
    const cleared = await (await request('/api/admin/map')).json();
    assert.equal(cleared.tokenSource, 'none');
    assert.equal((await request('/api/admin/map', 'PUT', { ...fields, tokenAction: 'environment' }, cleared.version)).status, 200);
    assert.equal((await (await request('/api/admin/map')).json()).tokenSource, 'environment');
    const environment = await (await request('/api/admin/map')).json();
    assert.equal((await request('/api/admin/map', 'PUT', { ...fields, accessMode: 'browser', tokenAction: 'replace', token: savedToken }, environment.version)).status, 200);
    const browserConfig = await (await request('/api/map/config')).json();
    assert.equal(browserConfig.accessMode, 'browser');
    assert.equal(browserConfig.browserToken, savedToken);
    assert.ok(!JSON.stringify(await (await request('/api/admin/map')).json()).includes(savedToken));
    const beforeProxy = upstreamRequests.length;
    assert.equal((await request('/api/map/tiles/img/12/3350/1670')).status, 400);
    assert.equal(upstreamRequests.length, beforeProxy);
    const browserStored = await (await request('/api/admin/map')).json();
    assert.equal((await request('/api/admin/map', 'PUT', { ...fields, tokenAction: 'keep' }, browserStored.version)).status, 200);
    assert.equal((await (await request('/api/map/config')).json()).accessMode, 'browser');
    await stop();
    await start();
    await login();
    assert.equal((await (await request('/api/map/config')).json()).browserToken, savedToken);
    const browserReloaded = await (await request('/api/admin/map')).json();
    assert.equal((await request('/api/admin/map', 'PUT', { ...fields, accessMode: 'server', tokenAction: 'keep' }, browserReloaded.version)).status, 200);
    const serverConfig = await (await request('/api/map/config')).json();
    assert.equal(serverConfig.accessMode, 'server');
    assert.ok(!('browserToken' in serverConfig));
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
