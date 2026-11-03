import { test, expect } from '@playwright/test';

const password = 'Browser-Test-Passphrase-91';

async function administrator(page) {
  const health = await (await page.request.get('/api/health')).json();
  if (health.needsSetup) {
    const result = await page.request.post('/api/setup', {
      headers: { Origin: 'http://127.0.0.1:3229' }, data: { username: 'admin', password },
    });
    expect(result.status()).toBe(201);
  }
  await page.goto('/#/login');
  await page.locator('#login-form [name="username"]').fill('admin');
  await page.locator('#login-form [name="password"]').fill(password);
  await page.getByRole('button', { name: '进 入 平 台', exact: true }).click();
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
}

test('dark admin dashboard preserves navigation and accurate KPIs with alert-first geometry', async ({ page }) => {
  await administrator(page);
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('.admin-kpi')).toHaveCount(11);
  await expect(page.locator('.admin-resource-group')).toHaveCount(10);
  await expect(page.locator('.admin-resource-group button')).toHaveCount(41);
  const dashboard = await (await page.request.get('/api/dashboard')).json();
  await expect(page.locator('.admin-kpi').filter({ hasText: '后台账号' }).locator('b')).toHaveText(String(dashboard.counts.accounts));
  await expect(page.locator('.admin-kpi').filter({ hasText: '运行中任务' }).locator('b')).toHaveText(String(dashboard.runningJobs));
  for (const viewport of [{ width: 1536, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        sidebar: rect('.admin-sidebar'), header: rect('.admin-header'),
        kpis: [...document.querySelectorAll('.admin-kpi')].map(e => e.getBoundingClientRect().toJSON()),
        assets: rect('.admin-assets'), activity: rect('.admin-activity'), alerts: rect('.admin-recent-alerts'), audit: rect('.admin-recent-audit'),
        groups: getComputedStyle(document.querySelector('.admin-resource-groups')).gridTemplateColumns.split(' ').length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.sidebar.width).toBe(224);
    expect(geometry.header.height).toBe(58);
    expect(geometry.header.x).toBe(224);
    expect(geometry.groups).toBe(3);
    for (let index = 1; index < 8; index++) expect(geometry.kpis[index].y).toBe(geometry.kpis[0].y);
    expect(geometry.kpis[8].y).toBeGreaterThan(geometry.kpis[0].bottom);
    expect(geometry.kpis[10].y).toBe(geometry.kpis[8].y);
    expect(geometry.assets.x).toBeLessThan(geometry.alerts.x);
    expect(geometry.assets.width).toBeGreaterThan(geometry.alerts.width * 1.7);
    expect(geometry.activity.y).toBe(geometry.alerts.y);
    expect(geometry.assets.y).toBeGreaterThan(geometry.activity.bottom);
    expect(geometry.alerts.y).toBeLessThan(viewport.height - 200);
    expect(geometry.audit.y).toBeGreaterThan(geometry.assets.bottom);
    expect(geometry.overflow).toBe(false);
    await page.screenshot({ path: `test-results/admin-dashboard-${viewport.width}.png`, fullPage: true });
  }
  await page.locator('.admin-resource-group').getByRole('button', { name: /^视频点位/ }).click();
  await expect(page.locator('#resource-filter')).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ 新增视频点位', exact: true })).toBeVisible();
  await page.goto('/#/admin/dashboard');
  await page.locator('.admin-quick').getByRole('button', { name: '地图配置', exact: true }).click();
  await expect(page.locator('#map-settings-form')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('.admin-kpi')).toHaveCount(11);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('map settings save/redact/reload, apply actual Cesium camera and handle conflicts', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const layers = new Set();
  const directLayers = new Set();
  const tile = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d');
    context.fillStyle = '#496870'; context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.route('**/api/map/tiles/**', route => {
    layers.add(new URL(route.request().url()).pathname.split('/')[4]);
    return route.fulfill({
      status: 200, contentType: 'image/png',
      body: Buffer.from(tile, 'base64'),
    });
  });
  await page.route('https://t0.tianditu.gov.cn/**', route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('tk')).toBe('browser-test-only-map-token');
    expect(url.searchParams.get('TILEMATRIXSET')).toBe('w');
    expect(url.searchParams.get('TILEMATRIX')).toMatch(/^\d+$/);
    directLayers.add(url.searchParams.get('LAYER'));
    return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(tile, 'base64') });
  });
  await administrator(page);
  await page.evaluate(() => {
    const prototype = globalThis.Cesium.CesiumWidget.prototype;
    const resize = prototype.resize;
    prototype.resize = function (...args) {
      const result = resize.apply(this, args);
      if (this.scene) globalThis.__testedMapCamera = this.scene.camera;
      return result;
    };
  });
  await page.goto('/#/admin/map');
  await expect(page.locator('#map-settings-form')).toBeVisible();
  await page.getByLabel('密钥操作', { exact: true }).selectOption('replace');
  const token = 'browser-test-only-map-token';
  await page.getByLabel('天地图 Web 服务密钥', { exact: true }).fill(token);
  await page.getByLabel('默认底图', { exact: true }).selectOption('street');
  await page.getByLabel('显示中文地名注记', { exact: true }).uncheck();
  await page.getByLabel('中心经度', { exact: true }).fill('116.391');
  await page.getByLabel('中心纬度', { exact: true }).fill('39.907');
  await page.getByLabel('视点高度（米）', { exact: true }).fill('12000');
  await page.getByLabel('朝向角（度）', { exact: true }).fill('35');
  await page.getByLabel('俯仰角（度）', { exact: true }).fill('-65');
  await page.getByLabel('最小瓦片层级', { exact: true }).fill('3');
  await page.getByLabel('最大瓦片层级', { exact: true }).fill('16');
  await page.getByRole('button', { name: '保存地图配置', exact: true }).click();
  await expect(page.locator('.map-save-result')).toContainText('地图配置已保存');
  await expect(page.locator('[name="token"]')).toHaveValue('');
  await expect(page.locator('.map-key-status')).toContainText('已配置（不回显）');
  await expect(page.locator('#map-settings-preview')).toHaveAttribute('data-map-configured', 'true');
  await expect.poll(() => layers.has('vec')).toBeTruthy();
  await expect(page.locator('.map-error')).toHaveCount(0);
  const camera = await page.evaluate(() => {
    const C = globalThis.Cesium, camera = globalThis.__testedMapCamera;
    const position = camera.positionCartographic;
    return {
      longitude: C.Math.toDegrees(position.longitude), latitude: C.Math.toDegrees(position.latitude),
      height: position.height, heading: C.Math.toDegrees(camera.heading), pitch: C.Math.toDegrees(camera.pitch),
    };
  });
  expect(camera.longitude).toBeCloseTo(116.391, 4);
  expect(camera.latitude).toBeCloseTo(39.907, 4);
  expect(camera.height).toBeCloseTo(12000, 1);
  expect(camera.heading).toBeCloseTo(35, 1);
  expect(camera.pitch).toBeCloseTo(-65, 1);
  await expect(page.getByRole('button', { name: '显示或隐藏地名注记', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const saved = await (await page.request.get('/api/admin/map')).json();
  expect(JSON.stringify(saved)).not.toContain(token);
  await page.getByLabel('最小瓦片层级', { exact: true }).fill('17');
  expect(await page.evaluate(() => [...document.querySelector('#map-settings-form').elements]
    .filter(element => element.willValidate && !element.checkValidity())
    .map(element => ({ name: element.name, value: element.value, error: element.validationMessage })))).toEqual([]);
  await page.getByRole('button', { name: '保存地图配置', exact: true }).click();
  await expect(page.locator('.form-error')).toHaveText('最小瓦片层级不能大于最大瓦片层级');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByLabel('最小瓦片层级', { exact: true })).toHaveValue('3');
  await page.reload();
  await expect(page.getByLabel('中心经度', { exact: true })).toHaveValue('116.391');
  await expect(page.locator('[name="token"]')).toHaveValue('');
  const auth = await (await page.request.get('/api/auth/me')).json();
  const current = await (await page.request.get('/api/admin/map')).json();
  const { provider, version, tokenConfigured, tokenSource, environmentAvailable, ...parameters } = current;
  const external = await page.request.put('/api/admin/map', {
    headers: { Origin: 'http://127.0.0.1:3229', 'X-CSRF-Token': auth.csrfToken, 'If-Match': String(version) },
    data: { ...parameters, longitude: 117, tokenAction: 'keep' },
  });
  expect(external.status()).toBe(200);
  await page.getByRole('button', { name: '保存地图配置', exact: true }).click();
  await expect(page.locator('.form-error')).toContainText('地图配置已被其他管理员修改');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByLabel('中心经度', { exact: true })).toHaveValue('117');
  await page.getByLabel('密钥类型 / 接入方式', { exact: true }).selectOption('browser');
  await page.getByLabel('显示中文地名注记', { exact: true }).check();
  await page.getByRole('button', { name: '保存地图配置', exact: true }).click();
  await expect(page.locator('#map-settings-preview')).toHaveAttribute('data-map-access-mode', 'browser');
  await expect.poll(() => directLayers.has('vec') && directLayers.has('cva')).toBeTruthy();
  await expect(page.locator('.map-error')).toHaveCount(0);
  const directConfig = await (await page.request.get('/api/map/config')).json();
  expect(directConfig.browserToken).toBe(token);
  await page.reload();
  await expect(page.getByLabel('密钥类型 / 接入方式', { exact: true })).toHaveValue('browser');
  await expect(page.locator('[name="token"]')).toHaveValue('');
  await page.goto('/#/overview');
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-configured', 'true');
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-access-mode', 'browser');
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await expect(page.getByRole('button', { name: '矢量底图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '显示或隐藏地名注记', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '影像底图', exact: true }).click();
  await expect.poll(() => directLayers.has('img') && directLayers.has('cia')).toBeTruthy();
  await page.goto('/#/admin/map');
  await page.getByRole('button', { name: '恢复默认参数', exact: true }).click();
  await expect(page.getByLabel('中心经度', { exact: true })).toHaveValue('121.516');
  await expect(page.getByLabel('密钥类型 / 接入方式', { exact: true })).toHaveValue('browser');
  await page.getByLabel('密钥操作', { exact: true }).selectOption('clear');
  await page.getByRole('button', { name: '保存地图配置', exact: true }).click();
  await expect(page.locator('#map-settings-preview')).toHaveAttribute('data-map-configured', 'false');
  await page.reload();
  await expect(page.locator('.map-key-status')).toContainText('未配置');
  expect(errors).toEqual([]);
});
