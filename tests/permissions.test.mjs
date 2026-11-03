import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.mjs';

test('setup reservation, operator boundaries, account creation and password invalidation', async () => {
  const app = createApplication({ databasePath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  async function call(path, method, body, status = 200, extraHeaders = {}) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    if (data.csrfToken) csrf = data.csrfToken;
    return data;
  }
  try {
    await call('/api/setup', 'POST', { username: 'demo-observer', password: 'Reserved-Account-Password' }, 400);
    await call('/api/setup', 'POST', { username: 'admin', password: 'Admin-Only-Test-Password' }, 201);
    await call('/api/auth/login', 'POST', { username: 'admin', password: 'Admin-Only-Test-Password' });
    await call('/api/users', 'POST', { username: 'operator', name: 'Test operator', role: 'operator', password: 'Operator-Test-Password' }, 201);
    await call('/api/auth/logout', 'POST', {});
    await call('/api/auth/login', 'POST', { username: 'operator', password: 'Operator-Test-Password' });
    const created = await call('/api/resources/cameras', 'POST', { name: 'Operator camera' }, 201);
    assert.equal((await call(`/api/resources/cameras/${created.id}`, 'GET')).name, 'Operator camera');
    await call(`/api/resources/cameras/${created.id}`, 'PATCH', { name: 'Tampered' }, 403, { Origin: 'https://untrusted.invalid' });
    await call(`/api/resources/cameras/${created.id}`, 'PATCH', { name: 'Conflict' }, 409, { 'If-Match': '99' });
    await call(`/api/resources/cameras/${created.id}`, 'DELETE', undefined, 403);
    await call('/api/resources/system', 'POST', { name: 'Forbidden' }, 403);
    await call('/api/users', 'POST', { username: 'intruder', name: 'X', role: 'admin', password: 'Should-Not-Work-Password' }, 403);
    await call('/api/drones/not-a-device/command', 'POST', { command: 'takeoff' }, 503);
    await call('/api/auth/password', 'PUT', { currentPassword: 'Operator-Test-Password', password: 'Operator-Changed-Password' });
    await call('/api/auth/me', 'GET', undefined, 401);
    await call('/api/auth/login', 'POST', { username: 'operator', password: 'Operator-Test-Password' }, 401);
    await call('/api/auth/login', 'POST', { username: 'operator', password: 'Operator-Changed-Password' });
    assert.equal((await call('/api/auth/me', 'GET')).user.role, 'operator');
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.close();
  }
});
