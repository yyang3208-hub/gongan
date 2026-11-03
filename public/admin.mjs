import { resources, resourceMap, statusLabels } from '/shared/catalog.mjs';
import { mapNumericFields, defaultMapSettings } from '/shared/map-settings.mjs';
import { mountMap } from '/map.mjs';
import { enhanceInterface, focusFormError } from '/ui.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const heading = (text, english, extra = '') => `<div class="panel-title"><b>${text}</b><small>${english}</small>${extra}</div>`;
const auditActions = { login: '登录', create: '新增', update: '修改', delete: '删除', configure: '配置', transition: '处置', password: '修改密码' };
const number = value => Number(value).toLocaleString('zh-CN');

function activityChart(dashboard) {
  const targets = dashboard.targetHourly;
  const alerts = dashboard.hourly;
  const peak = Math.max(1, ...targets.map(item => item.total), ...alerts.map(item => item.total));
  const ceiling = Math.max(2, Math.ceil(peak / 2) * 2);
  const x = index => 38 + index / Math.max(1, targets.length - 1) * 578;
  const y = total => 132 - total / ceiling * 104;
  const path = values => values.map((item, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(item.total).toFixed(1)}`).join(' ');
  const rows = targets.map((item, index) => `<tr><td>${String(item.hour).padStart(2, '0')}:00</td><td>${number(item.total)}</td><td>${number(alerts[index].total)}</td></tr>`).join('');
  return `<section class="panel admin-activity">
    ${heading('24 小时数据趋势', 'ACTIVITY', '<span class="push">按小时聚合 · 条</span>')}
    <div class="admin-chart-summary"><span><i class="series-target"></i>结构化抓拍 <b>${number(targets.reduce((sum, item) => sum + item.total, 0))}</b></span><span><i class="series-alert"></i>预警记录 <b>${number(alerts.reduce((sum, item) => sum + item.total, 0))}</b></span><small>含当前未结束小时</small></div>
    <div class="admin-chart-scroll" tabindex="0" role="region" aria-label="24 小时趋势图，可横向滚动">
      <svg class="admin-trend-chart" viewBox="0 0 640 166" role="img" aria-labelledby="admin-trend-title admin-trend-description">
        <title id="admin-trend-title">近 24 小时抓拍和预警数量</title><desc id="admin-trend-description">实线表示抓拍，虚线表示预警。按小时统计本地记录，详细数值可展开下方数据表。</desc>
        <defs><linearGradient id="admin-activity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6bcfff" stop-opacity=".18"/><stop offset="1" stop-color="#6bcfff" stop-opacity="0"/></linearGradient></defs>
        ${[0, 1, 2].map(index => `<path class="chart-grid" d="M38 ${y(ceiling * index / 2)}H616"/><text x="28" y="${y(ceiling * index / 2) + 4}" text-anchor="end">${ceiling * index / 2}</text>`).join('')}
        <path d="${path(targets)} L616 132 L38 132Z" fill="url(#admin-activity-fill)"/>
        <path class="chart-target-line" d="${path(targets)}"/><path class="chart-alert-line" d="${path(alerts)}"/>
        ${targets.map((item, index) => `<circle class="chart-target-point" cx="${x(index)}" cy="${y(item.total)}" r="2.5"><title>${String(item.hour).padStart(2, '0')}:00 · 抓拍 ${item.total} 条 · 预警 ${alerts[index].total} 条</title></circle>`).join('')}
        ${[0, 5, 11, 17, 23].map(index => `<text x="${x(index)}" y="156" text-anchor="${index === 0 ? 'start' : index === 23 ? 'end' : 'middle'}">${String(targets[index].hour).padStart(2, '0')}:00</text>`).join('')}
      </svg>
    </div>
    <details class="admin-chart-data"><summary>查看逐小时数据</summary><div class="table-wrap"><table><thead><tr><th>小时</th><th>结构化抓拍（条）</th><th>预警记录（条）</th></tr></thead><tbody>${rows}</tbody></table></div></details>
  </section>`;
}

function compositionChart(dashboard) {
  const palette = { face: '#6bcfff', body: '#6ce3c3', vehicle: '#f5ca80', bicycle: '#b9abff', tricycle: '#ffa38c' };
  const total = dashboard.counts.captures || 0;
  const items = dashboard.composition.map(item => ({ ...item, percentage: total ? item.total / total * 100 : 0 }));
  return `<section class="panel admin-composition">
    ${heading('结构化目标构成', 'COMPOSITION', '<span class="push">全部本地记录</span>')}
    <div class="admin-composition-total"><b>${number(total)}</b><span>条目标记录</span><small>${items.length} 类目标</small></div>
    <div class="admin-distribution">${items.map(item => `<div class="admin-distribution-row" style="--series:${palette[item.type] || '#9eb6cf'}"><span>${escape(statusLabels[item.type] || item.type || '未分类')}</span><div class="admin-distribution-track"><i style="width:${item.percentage}%"></i></div><b>${number(item.total)}</b><small>${item.percentage.toFixed(1)}%</small></div>`).join('') || '<p class="empty">暂无结构化记录</p>'}</div>
    <p class="admin-chart-note">按目标类型统计 · 非实时识别流</p>
  </section>`;
}

export function renderAdminDashboard(content, { dashboard, user }) {
  const count = key => dashboard.counts[key] || 0;
  const metrics = [
    ['视频点位', count('cameras'), '路', 'cameras'], ['在线点位', dashboard.onlineCameras, '路', 'cameras'],
    ['结构化抓拍', count('captures'), '条', 'captures'], ['今日抓拍', dashboard.todayTargets, '条', 'captures'],
    ['预警记录', count('alerts'), '条', 'alerts'], ['待处置预警', dashboard.pendingAlerts, '条', 'alerts'],
    ['人员档案', count('persons'), '份', 'persons'], ['解析任务', count('jobs'), '个', 'jobs'],
    ['运行中任务', dashboard.runningJobs, '个', 'jobs'],
    ...(user.role === 'admin' ? [['后台账号', count('accounts'), '个', 'accounts'], ['操作日志', count('logs'), '条', 'logs']] : []),
  ];
  const visible = resources.filter(def => !def.adminOnly || user.role === 'admin');
  const groups = [...new Set(visible.map(def => def.group))];
  const quick = [['cameras', '视频点位'], ['captures', '结构化抓拍'], ['alerts', '预警记录'], ['persons', '人员档案'], ['jobs', '解析任务'], [user.role === 'admin' ? 'map' : 'districts', user.role === 'admin' ? '地图配置' : '辖区配置']];
  const logs = dashboard.recentAudit.map(item => `<tr><td>${escape(item.actor)}</td><td>${escape(auditActions[item.action] || item.action)}</td><td>${escape(resourceMap[item.resource]?.label || (item.resource === 'map' ? '地图配置' : item.resource))}</td><td title="${escape(item.record_id)}">${escape(item.record_id || '—')}</td><td title="${escape(item.summary)}">${escape(item.summary)}</td><td>${escape(time(item.created_at))}</td></tr>`).join('');
  content.innerHTML = `<div class="admin-dashboard">
    <div class="admin-dashboard-intro"><div><span class="admin-eyebrow">OPERATIONS CENTER</span><h1>巡查数据运营中心</h1><p>资源、预警与任务一屏掌握 <span>· 本地数据快照</span></p></div><div class="admin-snapshot"><time datetime="${escape(dashboard.updatedAt)}">更新于 ${escape(time(dashboard.updatedAt))}</time><div class="admin-refresh-controls"><label><input type="checkbox" data-admin-auto>30 秒自动更新</label><button data-admin-refresh class="admin-refresh">更新数据</button></div><span class="admin-refresh-status" role="status"></span></div></div>
    <div class="admin-kpis">${metrics.map(([text, value, unit, key], index) => `<button class="admin-kpi ${index === 5 ? 'admin-kpi--alert' : index === 1 ? 'admin-kpi--online' : ''}" data-nav="admin/${key}"><span>${text}</span><div><b>${number(value)}</b><small>${unit}</small></div></button>`).join('')}<div class="admin-kpi-context ${user.role === 'admin' ? '' : 'observer-context'}"><div><span class="admin-local-status">本地服务</span><b>数据统计已更新</b><small>设备状态以本地记录为准，非网络在线探测</small></div><div class="admin-integration-tags">${[['video', '实时视频'], ['dji', '飞控'], ['ai', 'AI 推理']].map(([key, text]) => `<span>${text}<b>${dashboard.integrations[key] ? '已接入' : '未接入'}</b></span>`).join('')}</div></div></div>
    <div class="admin-dashboard-grid"><div class="admin-dashboard-left">${activityChart(dashboard)}<section class="panel admin-assets">
      ${heading('数据资产', 'DATASETS', `<span class="push">共 ${visible.length} 类资源，点击进入维护</span>`)}
      <div class="admin-resource-groups">${groups.map(group => `<section class="admin-resource-group"><h3>${escape(group)}</h3>${visible.filter(def => def.group === group).map(def => `<button data-nav="admin/${def.key}"><span>${escape(def.label)}</span><b>${count(def.key)}</b></button>`).join('')}</section>`).join('')}</div>
    </section></div><aside class="admin-dashboard-right"><section class="panel admin-recent-alerts">
      ${heading('最新预警', 'RECENT ALERTS', '<button class="panel-link push" data-nav="admin/alerts">全部</button>')}
      <div class="admin-alert-summary"><b>${number(dashboard.pendingAlerts)}</b><span>待处置预警</span><small>全部记录 ${number(count('alerts'))} 条</small></div>
      <div>${dashboard.recentAlerts.slice(0, 6).map(item => `<button class="admin-alert-row" data-severity="${escape(item.severity)}" data-detail="${item.id}" data-resource="alerts"><span><b>${escape(item.type || item.name)}</b><small>${escape(item.source || item.name)} · ${escape(statusLabels[item.status] || item.status)}</small></span><time>${escape(time(item.occurredAt))}</time><span class="ui-alert-severity badge ${escape(item.severity)}">${escape(statusLabels[item.severity] || item.severity)}</span></button>`).join('') || '<div class="empty">暂无预警记录</div>'}</div>
    </section>${compositionChart(dashboard)}<section class="panel">${heading('快捷维护', 'QUICK ACCESS')}<div class="admin-quick">${quick.map(([key, text]) => `<button data-nav="admin/${key}">${text}</button>`).join('')}</div></section>
    <p class="admin-data-note">统计来自本地数据。演示设备状态不代表真实连接。</p></aside></div>
    ${user.role === 'admin' ? `<section class="panel admin-recent-audit">${heading('最近操作', 'AUDIT TRAIL', '<button class="panel-link push" data-nav="admin/logs">查看全部</button>')}<div class="table-wrap"><table><thead><tr>${['操作人', '动作', '资源', '对象', '摘要', '时间'].map(text => `<th>${text}</th>`).join('')}</tr></thead><tbody>${logs || '<tr><td colspan="6">暂无操作日志</td></tr>'}</tbody></table></div></section>` : ''}
  </div>`;
}

export function mountAdminDashboard(content, { dashboard, user, api, notify, epochCurrent, onUpdate }) {
  let disposed = false;
  let updating = false;
  let automatic = false;
  let timer;
  const current = () => !disposed && epochCurrent();
  renderAdminDashboard(content, { dashboard, user });
  async function refresh() {
    if (!current() || updating) return;
    updating = true;
    const button = content.querySelector('[data-admin-refresh]');
    button.disabled = true;
    const active = document.activeElement;
    const restore = active === button ? '[data-admin-refresh]' : active.matches('[data-admin-auto]') ? '[data-admin-auto]' : null;
    const status = content.querySelector('.admin-refresh-status');
    status.textContent = '正在读取最新本地数据…';
    status.classList.remove('refresh-error');
    try {
      const fresh = await api('/api/dashboard');
      if (!current()) return;
      const scrollArea = content.closest('.admin-main');
      const scrollTop = scrollArea.scrollTop;
      renderAdminDashboard(content, { dashboard: fresh, user });
      content.querySelector('[data-admin-auto]').checked = automatic;
      enhanceInterface(content);
      onUpdate(fresh);
      if (restore) content.querySelector(restore).focus({ preventScroll: true });
      scrollArea.scrollTop = scrollTop;
    } catch (error) {
      if (!current()) return;
      status.textContent = `更新失败：${error.message}；仍显示上次数据快照`;
      status.classList.add('refresh-error');
      notify(error.message, true);
    } finally {
      updating = false;
      if (current()) content.querySelector('[data-admin-refresh]').disabled = false;
    }
  }
  function click(event) {
    if (event.target.closest('[data-admin-refresh]')) void refresh();
  }
  function change(event) {
    if (!event.target.matches('[data-admin-auto]')) return;
    automatic = event.target.checked;
    clearInterval(timer);
    if (automatic) timer = setInterval(() => {
      if (!current() || document.hidden || document.querySelector('#modal').open) return;
      const active = document.activeElement;
      if ((content.contains(active) && !active.matches('[data-admin-auto], [data-admin-refresh]')) || content.querySelector('details[open]')) return;
      void refresh();
    }, 30000);
  }
  content.addEventListener('click', click);
  content.addEventListener('change', change);
  return { destroy() { disposed = true; clearInterval(timer); content.removeEventListener('click', click); content.removeEventListener('change', change); } };
}

export async function renderMapSettings(content, { api, notify, epochCurrent }) {
  const config = await api('/api/admin/map');
  if (!epochCurrent()) return null;
  const source = { database: '后台加密配置', environment: '服务启动环境', none: '未配置' };
  content.innerHTML = `<div class="map-settings-layout"><section class="panel">
    ${heading('地图服务配置', 'MAP CONFIGURATION')}
    <form id="map-settings-form" class="map-settings-form">
      <fieldset><legend>底图与授权</legend>
        <label>地图引擎<input value="Cesium · Web Mercator WMTS" readonly></label>
        <label>地图供应商<input value="天地图 · 国家地理信息公共服务平台" readonly></label>
        <label>密钥类型 / 接入方式<select name="accessMode" aria-label="密钥类型 / 接入方式"><option value="server">服务器端密钥 · 后端代理</option><option value="browser">浏览器端密钥 · 浏览器直连</option></select></label>
        <p class="inline-notice">接入方式必须匹配天地图控制台的密钥类型。浏览器直连会向已登录用户的浏览器提供授权密钥，开发者工具中可查看；请设置域名/IP 白名单与访问配额。服务器代理不向浏览器提供密钥。</p>
        <p class="map-key-status" role="status">密钥状态：<b>${config.tokenConfigured ? '已配置（不回显）' : '未配置'}</b> · 来源：${source[config.tokenSource]}</p>
        <label>密钥操作<select name="tokenAction" aria-label="密钥操作"><option value="keep">保留当前密钥</option><option value="replace">设置 / 替换密钥</option><option value="clear">清除密钥（同时停用环境密钥）</option><option value="environment">恢复使用环境变量 TIANDITU_TOKEN</option></select></label>
        <label class="map-token-field" hidden>天地图 Web 服务密钥<input name="token" type="password" autocomplete="new-password" minlength="8" maxlength="128" pattern="[a-zA-Z0-9_-]{8,128}" disabled placeholder="输入本项目的合法授权密钥"></label>
        <p class="muted">密钥通过本地认证接口提交，服务端 AES-256-GCM 加密保存，不写入审计内容。后台表单不回显原文；仅浏览器直连模式会通过认证后的地图接口提供浏览器端密钥。${config.environmentAvailable ? '服务已提供环境密钥。' : '服务未提供环境密钥。'}</p>
        <div class="map-settings-grid"><label>默认底图<select name="defaultBasemap" aria-label="默认底图"><option value="satellite">影像底图</option><option value="street">矢量底图</option></select></label>
        <label class="map-checkbox"><input name="labelsVisible" type="checkbox">显示中文地名注记</label></div>
      </fieldset>
      <fieldset><legend>初始视角与瓦片范围</legend>
        <div class="map-settings-grid">${mapNumericFields.map(field => `<label>${field.label}<input name="${field.key}" type="number" value="${config[field.key]}" min="${field.min}" max="${field.max}" step="${field.step}" required></label>`).join('')}</div>
        <p class="muted">经纬度采用 WGS84；高度为摄像机高度，俯仰角 -90° 为俯视。瓦片层级限制影像细节，不是摄像机高度上限。地图署名不可移除。</p>
      </fieldset>
      <p class="form-error" role="alert"></p><p class="map-save-result" role="status"></p>
      <div class="form-buttons"><button class="primary" type="submit">保存地图配置</button><button type="button" data-map-reset>恢复默认参数</button><button type="button" data-map-reload>重新加载</button></div>
      <p class="muted">保存后无需重启服务。右侧预览立即更新；其他已打开的地图刷新后读取新配置。恢复默认参数不会修改密钥，需点击保存才生效。</p>
    </form>
  </section><aside class="map-settings-preview panel">
    ${heading('地图预览', 'LIVE PREVIEW')}<div id="map-settings-preview"></div>
    <div class="map-settings-hints"><b>接入说明</b><p>当前只接入天地图影像、矢量与对应中文注记。其他地图供应商和自定义服务地址尚未实现，不能仅保存地址就作为已接通服务。</p><p>预览使用已保存的配置，不会把尚未保存的密钥发送给第三方。成功保存不等于第三方授权校验成功；瓦片错误会在地图明确显示。</p></div>
  </aside></div>`;
  const form = content.querySelector('#map-settings-form');
  const status = form.querySelector('.map-save-result');
  const errorNode = form.querySelector('.form-error');
  let currentVersion = config.version;
  let disposed = false;
  let preview;
  const fields = form.elements;
  function fill(parameters) {
    for (const field of mapNumericFields) fields.namedItem(field.key).value = parameters[field.key];
    fields.namedItem('defaultBasemap').value = parameters.defaultBasemap;
    fields.namedItem('accessMode').value = parameters.accessMode;
    fields.namedItem('labelsVisible').checked = parameters.labelsVisible;
  }
  function updateTokenField() {
    const replace = fields.namedItem('tokenAction').value === 'replace';
    const token = fields.namedItem('token');
    token.disabled = !replace; token.required = replace;
    form.querySelector('.map-token-field').hidden = !replace;
    if (!replace) token.value = '';
  }
  function refreshPreview() {
    preview?.destroy();
    preview = mountMap(content.querySelector('#map-settings-preview'), [], { notify });
  }
  fill(config);
  refreshPreview();
  form.addEventListener('input', () => { status.textContent = ''; });
  form.addEventListener('change', event => {
    if (event.target.name === 'tokenAction') updateTokenField();
  });
  form.querySelector('[data-map-reset]').addEventListener('click', () => {
    fill({ ...defaultMapSettings, accessMode: fields.namedItem('accessMode').value }); status.textContent = '已恢复默认参数，尚未保存；密钥和接入方式未改变。';
  });
  form.querySelector('[data-map-reload]').addEventListener('click', async () => {
    try {
      const fresh = await api('/api/admin/map');
      if (disposed) return;
      fill(fresh); currentVersion = fresh.version;
      fields.namedItem('tokenAction').value = 'keep'; updateTokenField();
      form.querySelector('.map-key-status').textContent = `密钥状态：${fresh.tokenConfigured ? '已配置（不回显）' : '未配置'} · 来源：${source[fresh.tokenSource]}`;
      errorNode.textContent = ''; status.textContent = '已重新加载保存的配置。'; refreshPreview();
    } catch (error) { if (!disposed) { errorNode.textContent = error.message; focusFormError(errorNode); notify(error.message, true); } }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true; errorNode.textContent = ''; status.textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form));
      const body = {
        ...Object.fromEntries(mapNumericFields.map(field => [field.key, Number(values[field.key])])),
        defaultBasemap: values.defaultBasemap, labelsVisible: fields.namedItem('labelsVisible').checked,
        accessMode: values.accessMode,
        tokenAction: values.tokenAction,
        ...(values.tokenAction === 'replace' ? { token: values.token } : {}),
      };
      if (body.minimumLevel > body.maximumLevel) throw new Error('最小瓦片层级不能大于最大瓦片层级');
      const saved = await api('/api/admin/map', { method: 'PUT', body, version: currentVersion });
      if (disposed) return;
      currentVersion = saved.version;
      fields.namedItem('tokenAction').value = 'keep'; updateTokenField();
      form.querySelector('.map-key-status').textContent = `密钥状态：${saved.tokenConfigured ? '已配置（不回显）' : '未配置'} · 来源：${source[saved.tokenSource]}`;
      status.textContent = saved.message; notify(saved.message); refreshPreview();
    } catch (error) { if (!disposed) { errorNode.textContent = error.message; focusFormError(errorNode); notify(error.message, true); } }
    finally { if (!disposed) submit.disabled = false; }
  });
  return { destroy() { disposed = true; preview?.destroy(); fields.namedItem('token').value = ''; } };
}
