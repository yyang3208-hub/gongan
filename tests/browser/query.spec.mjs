import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sessionCookies;
async function enter(page) {
  if (!sessionCookies) {
    const health = await (await page.request.get('/api/health')).json();
    if (health.needsSetup) expect((await page.request.post('/api/setup', {
      headers: { Origin: 'http://127.0.0.1:3229' }, data: { username: 'admin', password: 'Browser-Test-Passphrase-91' },
    })).status()).toBe(201);
  }
  if (sessionCookies) await page.context().addCookies(sessionCookies);
  await page.goto('/');
  if (!sessionCookies) {
    await page.locator('#login-form [name="password"]').fill('Browser-Test-Passphrase-91');
    await page.getByRole('button', { name: '进 入 平 台', exact: true }).click();
  }
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
  sessionCookies = await page.context().cookies();
  await page.evaluate(() => {
    const prototype = Cesium.CesiumWidget.prototype, resize = prototype.resize;
    prototype.resize = function (...args) { const value = resize.apply(this, args); globalThis.__queryWidget = this; return value; };
  });
  await page.goto('/#/search');
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
}

async function visibleCamera(page) {
  const cameras = await (await page.request.get('/api/resources/cameras?pageSize=200')).json();
  return page.evaluate(items => {
    const widget = globalThis.__queryWidget, canvas = widget.scene.canvas.getBoundingClientRect();
    for (const item of items) {
      const pixel = widget.scene.cartesianToCanvasCoordinates(Cesium.Cartesian3.fromDegrees(item.longitude, item.latitude));
      if (pixel && pixel.x > 350 && pixel.x < canvas.width - 350 && pixel.y > 190 && pixel.y < 300)
        return { camera: item, x: pixel.x + canvas.left, y: pixel.y + canvas.top };
    }
    throw new Error('No visible camera for real map selection');
  }, cameras.items);
}

test('query uses translucent three-column layout, preview, collapse and responsive controls', async ({ page }) => {
  await enter(page);
  await expect(page.getByRole('tab', { name: '以图搜图', exact: true })).toBeEnabled();
  await expect(page.locator('.query-image-input')).not.toBeVisible();
  await expect(page.locator('.query-bounds')).not.toBeVisible();
  const desktop = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { conditions: rect('.query-panel'), results: rect('.search-results'), preview: rect('.query-right'), map: rect('#main-map'), background: getComputedStyle(document.querySelector('.search-results')).backgroundImage };
  });
  expect(desktop.conditions.right).toBeLessThan(desktop.results.left);
  expect(desktop.results.right).toBeLessThan(desktop.preview.left);
  expect(desktop.map.width).toBeGreaterThan(desktop.results.width);
  expect(desktop.background).toContain('0.77');
  const cardsAreReadable = () => page.locator('.capture-card').evaluateAll(cards => cards.every(card => {
    const image = card.querySelector('.capture-image').getBoundingClientRect();
    const text = card.querySelector('div:last-child').getBoundingClientRect();
    return image.height >= 108 && text.bottom <= card.getBoundingClientRect().bottom + 1;
  }));
  expect(await cardsAreReadable()).toBeTruthy();
  await page.locator('.capture-card').nth(1).click();
  const name = await page.locator('.capture-card').nth(1).locator('strong').textContent();
  await expect(page.locator('.query-preview-body > b')).toHaveText(name);
  await page.getByRole('button', { name: '结构化详情', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '收起结果', exact: true }).click();
  await expect(page.locator('#query-result-body')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '展开结果', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#query-result-body')).toBeVisible();
  await page.getByRole('button', { name: '近 24 小时', exact: true }).click();
  expect(await page.getByLabel('开始时间', { exact: true }).inputValue()).not.toBe('');
  await page.getByRole('button', { name: '⌕ 开始检索', exact: true }).click();
  await expect(page.locator('.query-search-status')).toHaveText('本地数据库检索完成。');
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    expect(await cardsAreReadable()).toBeTruthy();
    await expect(page.locator('.query-image-input')).not.toBeVisible();
    await page.getByRole('button', { name: '收起结果', exact: true }).click();
    await expect(page.locator('#query-result-body')).not.toBeVisible();
    await page.getByRole('button', { name: '展开结果', exact: true }).click();
    await expect(page.locator('#query-result-body')).toBeVisible();
  }
});

test('actual Cesium rectangle drag produces spatial filters and restores camera navigation', async ({ page }) => {
  await enter(page);
  const point = await visibleCamera(page);
  const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://127.0.0.1:3229', 'X-CSRF-Token': csrfToken };
  const created = await page.request.post('/api/resources/captures', { headers, data: { name: 'Rectangle camera link proof', cameraId: point.camera.id, longitude: 20, latitude: 20, confidence: 95 } });
  expect(created.status()).toBe(201);
  const capture = await created.json();
  try {
  await page.getByLabel('点位 / 目标名称 / 设备编号', { exact: true }).fill('Rectangle camera link proof');
  await page.getByRole('tab', { name: '框选搜索', exact: true }).click();
  await page.getByRole('button', { name: '开始地图框选', exact: true }).click();
  await expect(page.locator('#query-result-body')).not.toBeVisible();
  expect(await page.evaluate(() => globalThis.__queryWidget.scene.screenSpaceCameraController.enableInputs)).toBe(false);
  await page.mouse.move(point.x - 45, point.y - 45);
  await page.mouse.down();
  await page.mouse.move(point.x + 45, point.y + 45, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('.query-area-status')).toContainText('已完成地图框选');
  expect(await page.evaluate(() => globalThis.__queryWidget.scene.screenSpaceCameraController.enableInputs)).toBe(true);
  const bounds = {};
  for (const [key, label] of [['west', '西界经度'], ['east', '东界经度'], ['south', '南界纬度'], ['north', '北界纬度']]) {
    bounds[key] = Number(await page.getByLabel(label, { exact: true }).inputValue());
  }
  const response = page.waitForResponse(r => r.url().includes('/api/search?') && new URL(r.url()).searchParams.has('west'));
  await page.getByRole('button', { name: '⌕ 开始检索', exact: true }).click();
  const result = await (await response).json();
  expect(result.total).toBe(1);
  expect(result.items[0].id).toBe(capture.id);
  for (const camera of result.cameraSelection.items) {
    expect(camera.longitude).toBeGreaterThanOrEqual(bounds.west); expect(camera.longitude).toBeLessThanOrEqual(bounds.east);
    expect(camera.latitude).toBeGreaterThanOrEqual(bounds.south); expect(camera.latitude).toBeLessThanOrEqual(bounds.north);
  }
  await expect(page.locator('#query-result-body')).toBeVisible();
  await page.getByRole('button', { name: '清除范围', exact: true }).click();
  await expect(page.getByLabel('西界经度', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '开始地图框选', exact: true }).click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => globalThis.__queryWidget.scene.screenSpaceCameraController.enableInputs)).toBe(true);
  await page.goto('/#/overview');
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
  await expect(page.getByRole('button', { name: '地图框选', exact: true })).toHaveCount(0);
  } finally { expect((await page.request.delete(`/api/resources/captures/${capture.id}`, { headers, data: {} })).status()).toBe(200); }
});

test('real polygon point picking selects cameras and searches their linked captures, not capture positions', async ({ page }) => {
  await enter(page);
  const point = await visibleCamera(page);
  const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://127.0.0.1:3229', 'X-CSRF-Token': csrfToken }, ids = [];
  try {
    for (const [name, linkage] of [['linked', { cameraId: point.camera.id, longitude: 20, latitude: 20 }], ['unlinked', { longitude: point.camera.longitude, latitude: point.camera.latitude }]]) {
      const response = await page.request.post('/api/resources/captures', { headers, data: { name: `Polygon camera proof ${name}`, ...linkage, confidence: 95 } });
      expect(response.status()).toBe(201); ids.push((await response.json()).id);
    }
    await page.evaluate(() => {
      globalThis.__queryPointEntities = [];
      const prototype = new Cesium.CustomDataSource().entities.constructor.prototype, add = prototype.add;
      prototype.add = function (options) { const entity = add.call(this, options); if (entity.point && entity.label) globalThis.__queryPointEntities.push(entity); return entity; };
    });
    await page.getByLabel('点位 / 目标名称 / 设备编号', { exact: true }).fill('Polygon camera proof');
    await page.getByRole('tab', { name: '框选搜索', exact: true }).click();
    await page.getByRole('button', { name: '多边形选点', exact: true }).click();
    await page.mouse.click(point.x - 55, point.y - 55);
    await page.mouse.click(point.x + 55, point.y - 55);
    await page.mouse.click(point.x, point.y + 70);
    await expect(page.locator('.query-area-status')).toContainText('已选 3 个顶点');
    await page.getByRole('button', { name: '撤销上一点', exact: true }).click();
    await expect(page.locator('.query-area-status')).toContainText('已选 2 个顶点');
    await page.mouse.dblclick(point.x, point.y + 70, { delay: 100 });
    await expect(page.locator('.query-area-status')).toContainText('已完成 3 点多边形');
    const polygon = JSON.parse(await page.getByLabel('多边形顶点（经度、纬度）', { exact: true }).inputValue());
    expect(polygon).toHaveLength(3);
    expect(await page.evaluate(() => globalThis.__queryWidget.scene.screenSpaceCameraController.enableInputs)).toBe(true);
    expect(await page.evaluate(id => globalThis.__queryPointEntities.filter(entity => entity.id === id).at(-1).point.pixelSize.getValue(Cesium.JulianDate.now()), point.camera.id)).toBe(10);
    await expect(page.locator('.query-camera-selection')).toContainText(point.camera.name);
    const response = page.waitForResponse(r => r.url().includes('/api/search?') && new URL(r.url()).searchParams.has('polygon'));
    await page.getByRole('button', { name: '⌕ 开始检索', exact: true }).click();
    const result = await (await response).json();
    expect(result.items.map(item => item.id)).toEqual([ids[0]]);
    expect(result.cameraSelection.items.map(camera => camera.id)).toContain(point.camera.id);
    await expect(page.locator('.query-search-status')).toHaveText('本地数据库检索完成。');
    await page.getByRole('button', { name: '多边形选点', exact: true }).click();
    await page.mouse.click(point.x - 40, point.y - 40);
    await expect(page.locator('.query-area-status')).toContainText('已选 1 个顶点');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => globalThis.__queryWidget.scene.screenSpaceCameraController.enableInputs)).toBe(true);
    await expect(page.getByLabel('多边形顶点（经度、纬度）', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '多边形选点', exact: true }).click();
    await page.mouse.click(point.x - 55, point.y - 55);
    await page.mouse.click(point.x + 55, point.y - 55);
    await page.mouse.click(point.x, point.y + 70);
    await page.keyboard.press('Backspace');
    await expect(page.locator('.query-area-status')).toContainText('已选 2 个顶点');
    await page.mouse.click(point.x, point.y + 70);
    await page.keyboard.press('Enter');
    await expect(page.locator('.query-area-status')).toContainText('已完成 3 点多边形');
    await page.goto('/#/admin/captures');
    await page.getByLabel('搜索名称或点位').fill('Polygon camera proof unlinked');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('dialog').getByLabel('关联摄像头', { exact: true }).selectOption(point.camera.id);
    await expect(page.getByRole('dialog').getByLabel('设备编号', { exact: true })).toHaveValue(point.camera.code);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const saved = await (await page.request.get(`/api/resources/captures/${ids[1]}`)).json();
    expect(saved.cameraId).toBe(point.camera.id); expect(saved.cameraCode).toBe(point.camera.code);
    await page.goto('/#/search');
    await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
    await page.getByRole('tab', { name: '框选搜索', exact: true }).click();
    await page.getByLabel('多边形顶点（经度、纬度）', { exact: true }).fill(JSON.stringify(polygon));
    await page.getByRole('button', { name: '应用多边形顶点', exact: true }).click();
    await expect(page.locator('.query-area-status')).toContainText('已应用多边形');
    const linked = page.waitForResponse(r => r.url().includes('/api/search?') && new URL(r.url()).searchParams.has('polygon'));
    await page.getByRole('button', { name: '⌕ 开始检索', exact: true }).click();
    expect((await (await linked).json()).items.map(item => item.id).sort()).toEqual([...ids].sort());
  } finally {
    for (const id of ids) expect((await page.request.delete(`/api/resources/captures/${id}`, { headers, data: {} })).status()).toBe(200);
  }
});

  test('M3E imagery collection draws a real map region, downloads WPML and uploads photographs without simulating processing', async ({ page }) => {
    await enter(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/#/uav?tab=imagery');
    await expect(page.getByRole('heading', { name: '影像采集', exact: true })).toBeVisible();
    await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
    await page.getByLabel('采集任务名称', { exact: true }).fill('Browser M3E collection');
    const planForm = page.locator('#imagery-plan-form');
    await page.getByRole('button', { name: '地图选点', exact: true }).click();
    const rect = await page.locator('.imagery-map-stage').boundingBox();
    const x = rect.x + rect.width * .45, y = rect.y + rect.height * .25;
    for (const [index, [dx, dy]] of [[-12, -12], [12, -12], [12, 12]].entries()) {
      await page.mouse.click(x + dx, y + dy);
      await expect(page.locator('.imagery-draw-status')).toContainText(`已选 ${index + 1} 个顶点`);
    }
    await page.mouse.dblclick(x - 12, y + 12, { delay: 100 });
    await expect(page.locator('.imagery-draw-status')).toContainText('已完成 4 点范围');
    expect(JSON.parse(await planForm.getByLabel('采集范围 WGS84 顶点', { exact: true }).inputValue())).toHaveLength(4);
    await page.getByRole('button', { name: '预览估算', exact: true }).click();
    await expect(page.locator('.imagery-plan-metrics')).toContainText('照片估算');
    await expect(page.locator('.imagery-global-error')).toBeEmpty();
    await page.getByRole('button', { name: '生成并保存航线', exact: true }).click();
    await expect(page.locator('.imagery-missions')).toContainText('Browser M3E collection');
    await expect(page.locator('.imagery-mission-detail')).toContainText('已上传 0 张');
    await page.getByRole('button', { name: '下载 M3E KMZ', exact: true }).click();
    await expect(page.locator('.imagery-global-error')).toContainText('请先勾选');
    await page.locator('#imagery-route-ack').check();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 M3E KMZ', exact: true }).click();
    const stream = await (await download).createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const kmz = Buffer.concat(chunks).toString('utf8');
    expect(kmz).toContain('wpmz/waylines.wpml'); expect(kmz).toContain('takePhoto');
    await expect(page.getByRole('button', { name: '发送至机场 · 未接通', exact: true })).toBeDisabled();
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
      const context = canvas.getContext('2d'); context.fillStyle = '#406c89'; context.fillRect(0, 0, 120, 80);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    await page.locator('#imagery-photo-upload').setInputFiles([{ name: 'm3e-authorized-test.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(base64, 'base64') }]);
    await page.getByRole('button', { name: '上传所选照片', exact: true }).click();
    await expect(page.locator('.imagery-mission-detail')).toContainText('已上传 1 张');
    await page.getByRole('button', { name: '查看上传文件', exact: true }).click();
    await expect(page.locator('.imagery-upload-files')).toContainText('m3e-authorized-test.jpg');
    await page.locator('#imagery-actual-time').fill('2026-10-31T10:00');
    await page.getByRole('button', { name: '提交正射处理', exact: true }).click();
    await expect(page.locator('.imagery-global-error')).toContainText('GDAL');
    await expect(page.locator('.imagery-jobs')).toContainText('尚无真实处理作业');
    await page.reload();
    await page.locator('[data-imagery-mission]').filter({ hasText: 'Browser M3E collection' }).click();
    await expect(page.locator('.imagery-mission-detail')).toContainText('已上传 1 张');
    await expect(page.locator('.imagery-photo-summary')).toContainText('姿态未知 1 张');
    const directory = await mkdtemp(join(tmpdir(), 'gongan-usb-'));
    try {
      for (const [index, pitch] of [-92, -90, -88, -45, null].entries()) {
        const folder = join(directory, '001-flight', `camera-${index}`); await mkdir(folder, { recursive: true });
        const jpeg = Buffer.from(base64, 'base64');
        let photo = jpeg;
        if (pitch !== null) {
          const xmp = Buffer.from(`http://ns.adobe.com/xap/1.0/\0<rdf:Description drone-dji:GimbalPitchDegree="${pitch}"/>`);
          const header = Buffer.alloc(4); header[0] = 255; header[1] = 0xe1; header.writeUInt16BE(xmp.length + 2, 2);
          photo = Buffer.concat([jpeg.subarray(0, 2), header, xmp, jpeg.subarray(2)]);
        }
        await writeFile(join(folder, 'DJI_0001.JPG'), photo);
      }
      await mkdir(join(directory, '002-flight', 'nested'), { recursive: true });
      await writeFile(join(directory, '002-flight', 'nested', 'DJI_0001.JPG'), Buffer.from(base64, 'base64'));
      await writeFile(join(directory, 'flight-log.txt'), 'not a photo');
      await page.getByRole('button', { name: '照片导入', exact: true }).click();
      await page.locator('#imagery-import-folder').setInputFiles(directory);
      await expect(page.locator('.imagery-import-selection')).toContainText('6 张 JPEG，2 个航次');
      await page.locator('#imagery-import-form [name="name"]').fill('USB historical oblique survey');
      await page.locator('#imagery-import-form [name="capturedAt"]').fill('2026-10-30T09:00');
      let interrupted = false;
      await page.route('**/api/imagery/missions/*/photos?*', async route => {
        if (!interrupted && decodeURIComponent(route.request().url()).includes('camera-2/')) {
          interrupted = true;
          const response = await route.fetch({ postData: await readFile(join(directory, '001-flight', 'camera-2', 'DJI_0001.JPG')) });
          expect(response.status(), await response.text()).toBe(201); await route.abort('failed');
        } else await route.continue();
      });
      const submitImport = page.getByRole('button', { name: '按航次创建任务并上传全部照片', exact: true });
      await submitImport.click();
      await expect(page.locator('.imagery-global-error')).toContainText('安全续传');
      let imports = (await (await page.request.get('/api/imagery')).json()).missions.filter(item => item.name.startsWith('USB historical oblique survey'));
      expect(imports).toHaveLength(1); expect(imports[0].photoCount).toBe(3);
      await submitImport.click();
      await expect(page.locator('.imagery-import-progress')).toContainText('已完成 2/2 个航次');
      imports = (await (await page.request.get('/api/imagery')).json()).missions.filter(item => item.name.startsWith('USB historical oblique survey'));
      expect(imports).toHaveLength(2); expect(imports.map(item => item.photoCount).sort()).toEqual([1, 5]);
      await page.locator('[data-imagery-mission]').filter({ hasText: 'USB historical oblique survey · 1/2' }).click();
      await expect(page.locator('.imagery-mission-detail')).toContainText('已上传 5 张');
      await expect(page.locator('.imagery-photo-summary')).toContainText('下视 3 张 · 倾斜 1 张 · 姿态未知 1 张');
      await expect(page.locator('.imagery-mission-detail')).toContainText('无预设飞行航线');
      await expect(page.locator('#imagery-actual-time')).toHaveValue('2026-10-30T09:00');
      await page.getByRole('button', { name: '查看上传文件', exact: true }).click();
      await expect(page.locator('.imagery-upload-files')).toContainText('camera-3/DJI_0001.JPG');
      await expect(page.locator('.imagery-upload-files')).toContainText('倾斜 · 排除');
      await expect(page.locator('.imagery-global-status')).toContainText('忽略 1 个非 JPEG 文件');
      const reportDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出完整筛选清单', exact: true }).click();
      const reportStream = await (await reportDownload).createReadStream(), reportChunks = [];
      for await (const chunk of reportStream) reportChunks.push(chunk);
      const report = JSON.parse(Buffer.concat(reportChunks).toString('utf8'));
      expect(report.items).toHaveLength(5); expect(report.selection.selected).toBe(3);
      expect(report.items.every(item => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
      await page.reload();
      await page.locator('[data-imagery-mission]').filter({ hasText: 'USB historical oblique survey · 1/2' }).click();
      await expect(page.locator('.imagery-photo-summary')).toContainText('下视 3 张 · 倾斜 1 张 · 姿态未知 1 张');
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
    expect(errors).toEqual([]);
  });

  test('published imagery uses real Cesium split layers and chronological frames, with linked WebGL panoramas and cleanup', async ({ page }) => {
    await enter(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
    const headers = { Origin: 'http://127.0.0.1:3229', 'X-CSRF-Token': csrfToken };
    const tile = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
      const context = canvas.getContext('2d'); context.fillStyle = '#549c71'; context.fillRect(0, 0, 256, 256);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    const panorama = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 400;
      const context = canvas.getContext('2d'), gradient = context.createLinearGradient(0, 0, 800, 400);
      gradient.addColorStop(0, '#2667c9'); gradient.addColorStop(.5, '#a08c39'); gradient.addColorStop(1, '#1d7453');
      context.fillStyle = gradient; context.fillRect(0, 0, 800, 400);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    }), 'base64');
    await page.route('https://imagery.test/**', route => route.fulfill({ contentType: route.request().url().includes('pano') ? 'image/jpeg' : 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: route.request().url().includes('pano') ? panorama : tile }));
    const ids = [];
    for (const kind of ['ortho', 'panorama']) for (const [index, capturedAt] of ['2026-03-01T08:00:00Z', '2026-10-31T08:00:00Z'].entries()) {
      const response = await page.request.post('/api/imagery/assets', { headers, data: {
        name: `${kind} browser ${index}`, kind, capturedAt,
        url: kind === 'ortho' ? `https://imagery.test/${index}/{z}/{x}/{y}.png` : `https://imagery.test/pano${index}.jpg`,
        ...(kind === 'ortho' ? { bounds: { west: 121.51, south: 29.95, east: 121.52, north: 29.96 }, minimumLevel: 0, maximumLevel: 21, tileScheme: 'xyz' } : { longitude: 121.515, latitude: 29.955, altitude: 80, heading: 0 }),
      } });
      expect(response.status()).toBe(201); ids.push((await response.json()).id);
    }
    await page.goto('/#/uav?tab=imagery');
    await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
    await page.getByRole('button', { name: '多期对比', exact: true }).click();
    await page.getByRole('button', { name: '加载对比', exact: true }).click();
    await expect(page.locator('.imagery-split-marker')).toBeVisible();
    expect(await page.evaluate(() => {
      const widget = globalThis.__queryWidget, collection = widget.imageryLayers;
      const layers = Array.from({ length: collection.length }, (_, i) => collection.get(i));
      return layers.slice(-2).map(layer => layer.splitDirection);
    })).toEqual([-1, 1]);
    await page.waitForFunction(() => {
      const tiles = globalThis.__queryWidget.scene.globe._surface._tilesToRender;
      return [-1, 1].every(direction => tiles.some(tile => tile.data?.imagery?.some(item =>
        item.readyImagery?.imageryLayer.splitDirection === direction && (item.readyImagery.texture || item.readyImagery.textureWebMercator))));
    });
    await page.locator('#imagery-split').fill('25');
    expect(await page.evaluate(() => globalThis.__queryWidget.scene.splitPosition)).toBe(.25);
    await page.bringToFront();
    expect(await page.evaluate(() => document.hidden)).toBe(false);
    await page.getByRole('button', { name: '播放时序', exact: true }).click();
    await expect(page.locator('.imagery-time-readout')).toContainText('1 / 2');
    await expect(page.locator('.imagery-time-readout')).toContainText('2 / 2', { timeout: 5000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '卸载成果', exact: true }).click();
    expect(await page.evaluate(() => globalThis.__queryWidget.imageryLayers.length)).toBe(0);
    await page.locator('#imagery-compare-kind').selectOption('panorama');
    await page.getByRole('button', { name: '加载对比', exact: true }).click();
    const canvases = page.locator('.imagery-panorama-pair canvas');
    await expect(canvases).toHaveCount(2);
    for (const canvas of await canvases.all()) await expect(canvas).toHaveAttribute('data-panorama-ready', 'true');
    await canvases.first().scrollIntoViewIfNeeded();
    const box = await canvases.first().boundingBox();
    await page.mouse.move(box.x + 50, box.y + 70); await page.mouse.down(); await page.mouse.move(box.x + 130, box.y + 90, { steps: 4 }); await page.mouse.up();
    expect(await canvases.first().getAttribute('data-view')).toBe(await canvases.last().getAttribute('data-view'));
    expect(await canvases.first().getAttribute('data-view')).not.toBe('0.0,0.0,80.0');
    await canvases.last().focus(); await page.keyboard.press('ArrowUp');
    expect(await canvases.first().getAttribute('data-view')).toBe(await canvases.last().getAttribute('data-view'));
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    }
    await page.goto('/#/overview'); await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
    await expect(page.locator('.imagery-panorama-pair')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
test('image search compares real authorized image pixels, reports failures and excludes placeholders', async ({ page }) => {
  await enter(page);
  const { csrfToken } = await (await page.request.get('/api/auth/me')).json();
  const headers = { Origin: 'http://127.0.0.1:3229', 'X-CSRF-Token': csrfToken };
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d');
    return ['white', 'black'].map(color => { context.fillStyle = color; context.fillRect(0, 0, 32, 32); return canvas.toDataURL('image/png').split(',')[1]; });
  });
  const white = Buffer.from(imageData[0], 'base64'), black = Buffer.from(imageData[1], 'base64');
  await page.route('**/__query/*.png', route => {
    const name = new URL(route.request().url()).pathname;
    return name.includes('failed') ? route.fulfill({ status: 404, body: 'missing' }) : route.fulfill({ contentType: 'image/png', body: name.includes('white') ? white : black });
  });
  const ids = [];
  try {
    for (const name of ['white', 'black', 'failed', 'placeholder']) {
      const response = await page.request.post('/api/resources/captures', { headers, data: {
        name: `Image regression ${name}`, type: 'vehicle', confidence: 95, occurredAt: new Date().toISOString(),
        ...(name === 'placeholder' ? {} : { imageUrl: `http://127.0.0.1:3229/__query/${name}.png` }),
      } });
      expect(response.status()).toBe(201); ids.push((await response.json()).id);
    }
    await page.getByLabel('点位 / 目标名称 / 设备编号', { exact: true }).fill('Image regression');
    await page.getByRole('tab', { name: '以图搜图', exact: true }).click();
    await page.getByLabel('上传授权图片', { exact: true }).setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: white });
    await expect(page.locator('.query-search-status')).toContainText('检索图片已就绪');
    await page.getByRole('button', { name: '⌕ 开始检索', exact: true }).click();
    await expect(page.locator('.query-search-status')).toContainText('已检查 3 张授权图片，1 张读取失败');
    await expect(page.locator('.capture-card')).toHaveCount(1);
    await expect(page.locator('.capture-card strong')).toHaveText('Image regression white');
    await expect(page.locator('.query-similarity')).toHaveText('视觉相似度 100%');
    await expect(page.locator('.query-image-errors summary')).toContainText('结果不完整');
    await page.getByLabel('最低视觉相似度 (%)', { exact: true }).fill('0');
    await page.getByRole('button', { name: '⌕ 开始检索', exact: true }).click();
    await expect(page.locator('.capture-card')).toHaveCount(2);
    await expect(page.locator('.capture-card strong')).not.toContainText(['placeholder']);
    await page.getByLabel('上传授权图片', { exact: true }).setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
    await expect(page.locator('.query-search-status')).toHaveText('检索图片无法使用。');
    await expect(page.locator('#search-form .form-error')).not.toHaveText('');
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await expect(page.locator('.query-search-status')).toHaveText('本地数据库检索完成。');
    await expect(page.locator('.query-image-input')).not.toBeVisible();
  } finally {
    for (const id of ids) expect((await page.request.delete(`/api/resources/captures/${id}`, { headers, data: {} })).status()).toBe(200);
  }
});
