import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('authenticated operations persist and enforce permissions and state transitions', async () => {
  const { createApplication } = await import('../server/app.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'gongan-test-'));
  let app;
  let origin;
  let cookie = '';
  let csrf = '';
  async function start() {
    app = createApplication({ databasePath: join(directory, 'platform.sqlite') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() {
    await new Promise(resolve => app.server.close(resolve));
    app.close();
  }
  async function request(path, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    if (value.csrfToken) csrf = value.csrfToken;
    return value;
  }
  try {
    await start();
    assert.equal((await request('/api/health')).status, 'ok');
    await request('/api/resources/cameras', 'GET', undefined, 401);
    await request('/api/setup', 'POST', { username: 'admin', password: 'Test-only-passphrase-47' }, 201);
    await request('/api/setup', 'POST', { username: 'admin', password: 'Different-password-47' }, 409);
    await request('/api/auth/login', 'POST', { username: 'admin', password: 'incorrect' }, 401);
    await request('/api/auth/login', 'POST', { username: 'admin', password: 'Test-only-passphrase-47' });
    assert.equal((await request('/api/auth/me')).user.role, 'admin');
    const catalog = await request('/api/catalog');
    assert.equal(catalog.resources.length, 41);
    for (const resource of catalog.resources) {
      const list = await request(`/api/resources/${resource.key}`);
      assert.ok(Array.isArray(list.items));
      assert.equal(typeof list.total, 'number');
    }
    const camera = await request('/api/resources/cameras', 'POST', {
      name: 'Persistence camera', district: '江北区', status: 'offline', longitude: 121.51, latitude: 29.95,
    }, 201);
    const search = await request('/api/resources/cameras?q=Persistence');
    assert.equal(search.total, 1);
    await request(`/api/resources/cameras/${camera.id}`, 'PATCH', { latitude: 999 }, 400);
    await request(`/api/resources/cameras/${camera.id}`, 'PATCH', { status: 'online' });
    await request('/api/resources/cameras', 'POST', { name: '<img onerror=alert(1)>', unknown: 1 }, 400);
    await request('/api/resources/cameras?page=abc', 'GET', undefined, 400);
    const alerts = await request('/api/resources/alerts');
    const pending = alerts.items.find(item => item.status === 'pending');
    await request(`/api/resources/alerts/${pending.id}`, 'PATCH', { status: 'resolved' }, 400);
    await request(`/api/alerts/${pending.id}/transition`, 'POST', { status: 'resolved', note: 'skip' }, 409);
    await request(`/api/alerts/${pending.id}/transition`, 'POST', { status: 'acknowledged' });
    await request(`/api/alerts/${pending.id}/transition`, 'POST', { status: 'resolved', note: 'Reviewed locally' });
    await request('/api/integrations/dji/test', 'POST', {}, 503);
    await request('/api/integrations/dji', 'PUT', { projectId: 'local-project', enabled: false });
    assert.equal((await request('/api/integrations/dji')).projectId, 'local-project');
    await request('/api/search?type=vehicle&minConfidence=90');
    await request('/api/dashboard');
    const audit = await request('/api/audit');
    assert.ok(audit.items.some(row => row.action === 'create'));
    const savedCookie = cookie;
    const savedCsrf = csrf;
    csrf = 'wrong';
    await request(`/api/resources/cameras/${camera.id}`, 'DELETE', undefined, 403);
    csrf = savedCsrf;
    await request('/api/auth/logout', 'POST', {});
    await request('/api/auth/demo', 'POST', {});
    await request('/api/resources/cameras', 'POST', { name: 'Forbidden' }, 403);
    await request('/api/audit', 'GET', undefined, 403);
    await request('/api/integrations/dji', 'GET', undefined, 403);
    await request('/api/auth/login', 'POST', { username: 'admin', password: 'Test-only-passphrase-47' });
    await stop();
    await start();
    const persisted = await request(`/api/resources/cameras/${camera.id}`);
    assert.equal(persisted.status, 'online');
    await request(`/api/resources/cameras/${camera.id}`, 'DELETE');
    await request(`/api/resources/cameras/${camera.id}`, 'GET', undefined, 404);
    cookie = savedCookie;
    await request('/api/auth/me', 'GET', undefined, 401);
    await stop();
    app = null;
  } finally {
    if (app) await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
