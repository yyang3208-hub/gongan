import { test, expect } from '@playwright/test';

async function observer(page) {
  await page.goto('/#/login');
  await page.getByRole('button', { name: '以观察员身份体验 →', exact: true }).click();
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
}

async function administrator(page) {
  const password = 'Browser-Test-Passphrase-91';
  const health = await (await page.request.get('/api/health')).json();
  if (health.needsSetup) expect((await page.request.post('/api/setup', {
    headers: { Origin: 'http://127.0.0.1:3229' }, data: { username: 'admin', password },
  })).status()).toBe(201);
  await page.goto('/#/login');
  await page.locator('#login-form [name="password"]').fill(password);
  await page.getByRole('button', { name: '进 入 平 台', exact: true }).click();
  await expect(page.getByText('预警处置作战台', { exact: true })).toBeVisible();
}

async function checkContrast(page) {
  const pairs = await page.evaluate(() => {
    const css = getComputedStyle(document.body);
    const parse = name => {
      const value = css.getPropertyValue(name).trim().replace('#', '');
      return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255)
        .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    };
    return ['--ui-text', '--ui-secondary', '--ui-danger', '--ui-warning', '--ui-success', '--ui-link']
      .flatMap(foreground => ['--ui-surface', '--ui-elevated'].map(background => {
        const a = parse(foreground), b = parse(background);
        return { foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      }));
  });
  for (const pair of pairs) expect(pair.ratio, JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5);
}

async function checkComponentContrast(page, selectors) {
  const pairs = await page.evaluate(selectors => {
    const rgba = color => {
      const values = color.match(/[\d.]+/g).map(Number);
      return [...values.slice(0, 3), values[3] ?? 1];
    };
    const blend = (foreground, background) => foreground.slice(0, 3).map((value, i) => value * foreground[3] + background[i] * (1 - foreground[3]));
    const luminance = rgb => rgb.map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    return selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing contrast sample: ${selector}`);
      const ancestors = [];
      for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
      let background = [255, 255, 255];
      for (const node of ancestors) background = blend(rgba(getComputedStyle(node).backgroundColor), background);
      const foreground = blend(rgba(getComputedStyle(element).color), background);
      const a = luminance(foreground), b = luminance(background);
      return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  }, selectors);
  for (const pair of pairs) expect(pair.ratio, JSON.stringify(pair)).toBeGreaterThanOrEqual(4.5);
}

test('both workspaces have readable semantic colors and accessible navigation, tables and dialogs', async ({ page }) => {
  await observer(page);
  await page.goto('/#/overview');
  await expect(page.locator('.ov-alert-row').first()).toBeVisible();
  await checkContrast(page);
  await checkComponentContrast(page, ['.ov-kpi-caption', '.ov-kpi-foot', '.ov-panel-heading small', '.ov-alert-row p', '.ov-alert-row .badge']);
  await expect(page.locator('nav [aria-current="page"]')).toHaveCount(1);
  await expect(page.locator('.screen-header nav .ui-nav-icon')).toHaveCount(7);
  await expect(page.locator('.screen-header nav .ui-nav-icon').first()).toHaveAttribute('aria-hidden', 'true');
  await page.reload();
  await expect(page.locator('.ov-alert-row').first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '跳到主要内容', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#content')).toBeFocused();
  const focus = await page.locator('#content').evaluate(e => getComputedStyle(e).outlineStyle);
  expect(focus).toBe('solid');
  await page.locator('.ov-alert-row').first().click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('预警记录详情');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.goto('/#/admin/cameras');
  await expect(page.getByRole('region', { name: '数据表格，可横向滚动查看全部列' })).toHaveAttribute('tabindex', '0');
  await expect(page.locator('th').first()).toHaveAttribute('scope', 'col');
  await checkContrast(page);
  await checkComponentContrast(page, ['th', 'td', '.breadcrumb span', '.admin-header small']);
  await expect(page.locator('nav [aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '视频点位', exact: true })).toBeVisible();
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('.admin-kpi').first()).toBeVisible();
  await checkComponentContrast(page, ['.admin-kpi > span', '.admin-kpi small', '.admin-alert-row time', '.admin-alert-row .badge.low']);
});

test('front and admin pages stay usable at phone, tablet and landscape widths with reduced motion', async ({ page }) => {
  await observer(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const viewport of [
    { width: 375, height: 812 }, { width: 812, height: 375 },
    { width: 768, height: 1024 }, { width: 1024, height: 768 },
    { width: 1280, height: 800 }, { width: 1536, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of ['overview', 'control', 'search', 'uav', 'police', 'apps', 'archives', 'admin/dashboard', 'admin/cameras']) {
      await page.goto(`/#/${route}`);
      await expect(page.locator('#content')).toBeVisible();
      await expect(page.locator('#content .loading')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} at ${viewport.width}`).toBeTruthy();
      expect(await page.locator('button').first().evaluate(e => getComputedStyle(e).transitionDuration)).toBe('0s');
      if (route === 'overview' && viewport.width <= 1000) {
        const boxes = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
          return { map: rect('#main-map'), left: rect('.ov-left'), right: rect('.ov-right') };
        });
        expect(boxes.left.y).toBeGreaterThanOrEqual(boxes.map.bottom);
        expect(boxes.right.y).toBeGreaterThanOrEqual(boxes.map.bottom);
        expect(boxes.left.width).toBeGreaterThan(300);
        const panels = await page.evaluate(() => {
          const right = document.querySelector('.ov-right').getBoundingClientRect();
          const bus = document.querySelector('.ov-bus').getBoundingClientRect();
          const bottom = document.querySelector('.ov-center-bottom').getBoundingClientRect();
          return { rightBottom: right.bottom, busBottom: bus.bottom, feedTop: bottom.top };
        });
        expect(panels.rightBottom).toBeGreaterThanOrEqual(panels.busBottom - 1);
        expect(panels.feedTop).toBeGreaterThanOrEqual(panels.busBottom);
      }
    }
    if (viewport.width === 375 || viewport.width === 1536) {
      await page.goto('/#/overview');
      await expect(page.locator('.ov-alert-row').first()).toBeVisible();
      await page.screenshot({ path: `test-results/ui-overview-${viewport.width}.png`, fullPage: true });
      await page.goto('/#/admin/dashboard');
      await expect(page.locator('.admin-kpi').first()).toBeVisible();
      await page.screenshot({ path: `test-results/ui-admin-${viewport.width}.png`, fullPage: true });
    }
  }
});

test('administrator forms retain business validation and provide named fields and error focus', async ({ page }) => {
  await administrator(page);
  await page.goto('/#/admin/map');
  await expect(page.locator('#map-settings-form')).toBeVisible();
  await page.getByLabel('最小瓦片层级', { exact: true }).fill('17');
  await page.getByLabel('最大瓦片层级', { exact: true }).fill('16');
  await page.getByRole('button', { name: '保存地图配置', exact: true }).click();
  await expect(page.locator('.form-error')).toHaveText('最小瓦片层级不能大于最大瓦片层级');
  await expect(page.locator('.form-error')).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.goto('/#/admin/cameras');
  await page.getByRole('button', { name: '＋ 新增视频点位', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('新增视频点位');
  await page.getByRole('dialog').getByLabel('经度', { exact: true }).fill('181');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('名称', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('dialog').locator('.form-error')).not.toBeEmpty();
  await expect(page.getByRole('dialog').locator('.form-error')).toContainText('经度');
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('无障碍表单验证');
  await expect(page.getByRole('dialog').getByLabel('名称', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('dialog').locator('.form-error')).not.toContainText('名称');
  await expect(page.getByRole('dialog').getByLabel('经度', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('dark glass dashboard exposes accurate chart data, alert priority and consistent operation surfaces', async ({ page }) => {
  await administrator(page);
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('.admin-activity')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveAttribute('data-workspace', 'admin');
  expect(await page.locator('.admin-sidebar nav svg').count()).toBe(await page.locator('.admin-sidebar nav button').count());
  const dashboard = await (await page.request.get('/api/dashboard')).json();
  await expect(page.locator('.admin-alert-summary > b')).toHaveText(String(dashboard.pendingAlerts));
  await expect(page.locator('.admin-composition-total > b')).toHaveText(String(dashboard.counts.captures));
  const distribution = page.locator('.admin-distribution-row');
  await expect(distribution).toHaveCount(dashboard.composition.length);
  for (let index = 0; index < dashboard.composition.length; index++) {
    await expect(distribution.nth(index).locator('b')).toHaveText(String(dashboard.composition[index].total));
    await expect(distribution.nth(index).locator('small')).toHaveText(`${(dashboard.composition[index].total / dashboard.counts.captures * 100).toFixed(1)}%`);
  }
  await checkComponentContrast(page, ['.admin-eyebrow', '.admin-kpi--alert > span', '.admin-kpi--alert b', '.admin-integration-tags b', '.admin-chart-note', '.admin-alert-summary > span', '.admin-alert-row .badge.high', '.admin-alert-row .badge.medium', '.admin-sidebar nav button.active']);
  await page.getByText('查看逐小时数据', { exact: true }).click();
  const rows = page.locator('.admin-chart-data tbody tr');
  await expect(rows).toHaveCount(24);
  for (let index = 0; index < 24; index++) {
    await expect(rows.nth(index).locator('td').nth(1)).toHaveText(String(dashboard.targetHourly[index].total));
    await expect(rows.nth(index).locator('td').nth(2)).toHaveText(String(dashboard.hourly[index].total));
  }
  await page.getByText('查看逐小时数据', { exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.querySelector('.admin-dashboard-right').getBoundingClientRect().top < document.querySelector('.admin-dashboard-left').getBoundingClientRect().top)).toBeTruthy();
  await page.goto('/#/admin/controls');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  expect(await page.locator('.table-actions').first().evaluate(e => getComputedStyle(e).position)).toBe('sticky');
  await checkComponentContrast(page, ['th', 'td', '.table-actions button', '.danger-link', '.badge.running', '.badge.paused']);
  await page.setViewportSize({ width: 1536, height: 768 });
  await page.screenshot({ path: 'test-results/admin-dark-controls-1536.png', fullPage: true });
  await page.locator('[data-edit]').first().click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('编辑布控任务');
  await checkComponentContrast(page, ['.dialog-header h2', '.form-grid label', '.dialog-footer .primary']);
  await page.screenshot({ path: 'test-results/admin-dark-operation-1536.png' });
  await page.keyboard.press('Escape');
  await page.goto('/#/control');
  await expect(page.locator('body')).toHaveAttribute('data-workspace', 'screen');
  expect(await page.locator('.screen-header').evaluate(e => e.getBoundingClientRect().height)).toBe(54);
});

test('dashboard refresh is optional, pauses while reading, reports errors and stops on navigation', async ({ page }) => {
  await page.clock.install();
  await administrator(page);
  await page.goto('/#/admin/dashboard');
  await expect(page.locator('.admin-activity')).toBeVisible();
  const baseline = await (await page.request.get('/api/dashboard')).json();
  let requests = 0;
  let fail = false;
  await page.route('**/api/dashboard', async route => {
    requests++;
    if (fail) return route.fulfill({ status: 503, json: { error: '统计服务暂不可用' } });
    return route.fulfill({ json: { ...baseline, todayTargets: baseline.todayTargets + requests, updatedAt: new Date().toISOString() } });
  });
  const today = () => page.locator('.admin-kpi').filter({ hasText: '今日抓拍' }).locator('b');
  await expect(page.locator('[data-admin-auto]')).not.toBeChecked();
  await page.clock.runFor(31000);
  expect(requests).toBe(0);
  await page.getByRole('button', { name: '更新数据', exact: true }).click();
  await expect(today()).toHaveText(String(baseline.todayTargets + 1));
  await expect(page.getByRole('button', { name: '更新数据', exact: true })).toBeFocused();
  await page.getByLabel('30 秒自动更新', { exact: true }).check();
  await page.clock.runFor(31000);
  await expect(today()).toHaveText(String(baseline.todayTargets + 2));
  await expect(page.locator('[data-admin-auto]')).toBeChecked();
  await expect(page.locator('[data-admin-auto]')).toBeFocused();
  await page.getByText('查看逐小时数据', { exact: true }).click();
  await page.clock.runFor(31000);
  expect(requests).toBe(2);
  await page.getByText('查看逐小时数据', { exact: true }).click();
  await page.getByRole('button', { name: '更新数据', exact: true }).focus();
  fail = true;
  await page.getByRole('button', { name: '更新数据', exact: true }).click();
  await expect(page.locator('.admin-refresh-status')).toContainText('仍显示上次数据快照');
  await expect(page.locator('.toast.error')).toHaveText('统计服务暂不可用');
  await expect(today()).toHaveText(String(baseline.todayTargets + 2));
  fail = false;
  await page.goto('/#/admin/controls');
  await expect(page.locator('#resource-filter')).toBeVisible();
  const afterNavigation = requests;
  await page.clock.runFor(61000);
  expect(requests).toBe(afterNavigation);
});
