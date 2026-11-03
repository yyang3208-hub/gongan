import { test, expect } from '@playwright/test';

test('overview side panels reveal the map without fading content or losing text contrast', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '以观察员身份体验 →', exact: true }).click();
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
  await page.goto('/#/overview');
  await expect(page.locator('.ov-alert-row').first()).toBeVisible();
  const results = await page.evaluate(() => {
    const rgba = value => {
      const parts = value.match(/[\d.]+/g).map(Number);
      return [...parts.slice(0, 3), parts[3] ?? 1];
    };
    const blend = (a, b) => a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3]));
    const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const panels = [...document.querySelectorAll('.ov-left .ov-panel, .ov-right .ov-panel')].map(panel => {
      const style = getComputedStyle(panel);
      return { opacity: style.opacity, alpha: style.backgroundImage.match(/rgba?\([^)]+\)/g).map(value => rgba(value)[3]) };
    });
    const contrast = [
      '.ov-kpi-caption', '.ov-kpi-foot', '.ov-kpi-pair p', '.ov-trend-value span', '.ov-chart-footer',
      '.ov-line-chart text', '.ov-composition-list > div > span', '.ov-composition-list > div > b',
      '.ov-alert-row p', '.ov-alert-row > small', '.ov-alert-row time', '.ov-compute-summary > span',
      '.ov-compute-grid span', '.ov-compute-list > div > span', '.ov-bus-value span', '.ov-bus-foot', '.ov-bus-waiting',
    ].map(selector => {
      const element = document.querySelector(selector);
      const panel = element.closest('.ov-panel');
      const nodes = [];
      for (let node = element; node; node = node.parentElement) {
        nodes.unshift(node);
        if (node === panel) break;
      }
      let background = [255, 255, 255];
      for (const node of nodes) {
        const style = getComputedStyle(node);
        background = blend(rgba(style.backgroundColor), background);
        const stops = style.backgroundImage.match(/rgba?\([^)]+\)/g);
        if (stops) background = stops.map(stop => blend(rgba(stop), background)).sort((a, b) => luminance(b) - luminance(a))[0];
      }
      const style = getComputedStyle(element);
      const foreground = blend(rgba(element.tagName.toLowerCase() === 'text' ? style.fill : style.color), background);
      const a = luminance(foreground), b = luminance(background);
      return { selector, opacity: style.opacity, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
    return { panels, contrast };
  });
  expect(results.panels).toHaveLength(8);
  for (const panel of results.panels) {
    expect(panel.opacity).toBe('1');
    for (const alpha of panel.alpha) {
      expect(alpha).toBeGreaterThanOrEqual(.74);
      expect(alpha).toBeLessThanOrEqual(.78);
    }
  }
  for (const sample of results.contrast) {
    expect(sample.opacity).toBe('1');
    expect(sample.ratio, sample.selector).toBeGreaterThanOrEqual(4.5);
  }
});

test('map engine runs under CSP, supports imagery and cleans up on navigation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requestedLayers = new Set();
  await page.route('**/api/map/config', route => route.fulfill({
    json: { provider: 'tianditu', configured: true, maximumLevel: 18, credit: '© 天地图' },
  }));
  await page.route('**/api/map/tiles/**', route => {
    requestedLayers.add(new URL(route.request().url()).pathname.split('/')[4]);
    return route.fulfill({
    status: 200, contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=', 'base64'),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '以观察员身份体验 →', exact: true }).click();
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/control-desktop.png', fullPage: true });
  await expect(page.locator('.cesium-widget canvas')).toBeVisible();
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-configured', 'true');
  await expect.poll(() => requestedLayers.has('img') && requestedLayers.has('cia')).toBeTruthy();
  await expect(page.getByText('地图加载失败', { exact: false })).toHaveCount(0);
  await page.getByTitle('切换俯视 / 倾斜', { exact: true }).click();
  await page.getByRole('button', { name: '地图图层', exact: true }).click();
  await page.getByRole('button', { name: '矢量底图', exact: true }).click();
  await expect.poll(() => requestedLayers.has('vec') && requestedLayers.has('cva')).toBeTruthy();
  await page.getByRole('button', { name: '显示或隐藏地名注记', exact: true }).click();
  await expect(page.getByRole('button', { name: '显示或隐藏地名注记', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /无人机巡查/ }).click();
  await expect(page.getByText('未接入飞控 · 指令不可用', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /起飞/ })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('overview matches reference panel layout and exposes missing map configuration', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '以观察员身份体验 →', exact: true }).click();
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
  await page.goto('/#/overview');
  await expect(page.locator('.overview-scene')).toBeVisible();
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-configured', 'false');
  await expect(page.getByText('天地图未配置：请在后台「地图配置」保存密钥，或配置 TIANDITU_TOKEN 并重启服务', { exact: true })).toBeVisible();
  await expect(page.locator('.cesium-widget canvas')).toBeVisible();
  await expect(page.locator('.schematic-map')).toHaveCount(0);
  for (const viewport of [{ width: 1536, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { header: rect('.screen-header'), map: rect('#main-map'), content: rect('#content'), left: rect('.ov-left'), right: rect('.ov-right'), bottom: rect('.ov-center-bottom'), footer: rect('.screen-footer'), chart: rect('.ov-trend'), composition: rect('.ov-composition') };
    });
    expect(geometry.header.height).toBe(54);
    expect(geometry.map.width).toBe(viewport.width);
    expect(geometry.map.height).toBe(geometry.content.height);
    expect(geometry.left.width / viewport.width).toBeGreaterThan(.15);
    expect(geometry.left.width / viewport.width).toBeLessThan(.18);
    expect(geometry.right.width / viewport.width).toBeGreaterThan(.16);
    expect(geometry.right.width / viewport.width).toBeLessThan(.19);
    expect(geometry.chart.height).toBeGreaterThan(150);
    expect(geometry.composition.bottom).toBeLessThan(geometry.footer.y);
    expect(geometry.bottom.x).toBeGreaterThan(geometry.left.right);
    expect(geometry.bottom.right).toBeLessThan(geometry.right.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({ path: `test-results/overview-${viewport.width}.png` });
  }
  await page.getByRole('button', { name: '收起左侧面板', exact: true }).click();
  await expect(page.locator('.ov-left')).toBeHidden();
  await page.getByRole('button', { name: '展开左侧面板', exact: true }).click();
  await expect(page.locator('.ov-left')).toBeVisible();
  await page.getByRole('button', { name: '车辆卡口', exact: true }).click();
  await expect(page.getByRole('button', { name: '车辆卡口', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('reference-inspired overview keeps names optional, tools visible and chart data inspectable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '以观察员身份体验 →', exact: true }).click();
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    globalThis.__screenPointEntities = [];
    const widgetPrototype = Cesium.CesiumWidget.prototype;
    const resize = widgetPrototype.resize;
    widgetPrototype.resize = function (...args) {
      const result = resize.apply(this, args);
      globalThis.__screenWidget = this;
      return result;
    };
    const prototype = new Cesium.CustomDataSource().entities.constructor.prototype;
    const original = prototype.add;
    prototype.add = function (options) {
      const entity = original.call(this, options);
      if (entity.point && entity.label) globalThis.__screenPointEntities.push(entity);
      return entity;
    };
  });
  await page.goto('/#/overview');
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
  const visibleNames = () => page.evaluate(() => globalThis.__screenPointEntities.filter(entity => entity.label.show.getValue(Cesium.JulianDate.now())).length);
  expect(await page.evaluate(() => globalThis.__screenPointEntities.length)).toBeGreaterThan(0);
  expect(await visibleNames()).toBe(0);
  const names = page.getByRole('button', { name: '显示或隐藏点位名称', exact: true });
  await expect(names).toHaveAttribute('aria-pressed', 'false');
  await names.click();
  expect(await visibleNames()).toBe(await page.evaluate(() => globalThis.__screenPointEntities.length));
  await names.click();
  expect(await visibleNames()).toBe(0);
  const hoverPoint = await page.evaluate(() => {
    const widget = globalThis.__screenWidget;
    const bounds = widget.scene.canvas.getBoundingClientRect();
    for (const entity of globalThis.__screenPointEntities) {
      const point = widget.scene.cartesianToCanvasCoordinates(entity.position.getValue(widget.clock.currentTime));
      if (point && point.x > 300 && point.x < bounds.width - 360 && point.y > 170 && point.y < bounds.height - 170) {
        return { x: bounds.left + point.x, y: bounds.top + point.y };
      }
    }
    throw new Error('No unobscured map point available for pointer validation');
  });
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await expect.poll(visibleNames).toBe(1);
  await page.mouse.move(20, 20);
  await expect.poll(visibleNames).toBe(0);
  await expect(page.locator('.ov-bus .ov-line-chart')).toHaveCount(0);
  await expect(page.locator('.ov-bus-waiting')).toHaveText('等待数据总线接入');
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }, { width: 1536, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { map: rect('#main-map'), tools: rect('.map-tools'), metrics: rect('.ov-top-metrics'), heading: rect('.ov-center-heading') };
    });
    expect(geometry.tools.bottom).toBeLessThanOrEqual(geometry.map.bottom);
    expect(geometry.tools.right).toBeLessThanOrEqual(geometry.map.right);
    expect(geometry.metrics.left).toBeGreaterThanOrEqual(geometry.heading.left);
    expect(geometry.metrics.right).toBeLessThanOrEqual(geometry.heading.right);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  }
  await page.getByRole('button', { name: '逐小时数据', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('24 小时目标趋势数据');
  const dashboard = await (await page.request.get('/api/dashboard')).json();
  const rows = page.getByRole('dialog').locator('tbody tr');
  await expect(rows).toHaveCount(24);
  for (let index = 0; index < 24; index++) {
    await expect(rows.nth(index).locator('td').nth(1)).toHaveText(String(dashboard.targetHourly[index].total));
    await expect(rows.nth(index).locator('td').nth(2)).toHaveText(String(dashboard.targetHourly[index].faceTotal));
  }
  await page.keyboard.press('Escape');
  await page.evaluate(() => { globalThis.__screenPointEntities = []; });
  await page.goto('/#/control');
  await expect(page.locator('#main-map')).toHaveAttribute('data-map-ready', 'true');
  expect(await visibleNames()).toBeGreaterThan(0);
  expect(await visibleNames()).toBe(await page.evaluate(() => globalThis.__screenPointEntities.length));
  await expect(names).toHaveCount(0);
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('.admin-activity')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-workspace', 'admin');
  expect(await page.locator('.admin-header').evaluate(e => e.getBoundingClientRect().height)).toBe(58);
});
