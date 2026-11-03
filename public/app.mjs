import { resources, resourceMap, statusLabels, districts, mainNavigation, uavNavigation } from '/shared/catalog.mjs';
import { mountMap } from '/map.mjs';
import { renderOverview } from '/overview.mjs';
import { mountAdminDashboard, renderMapSettings } from '/admin.mjs';
import { navigationIcon, enhanceInterface, focusFormError, updateNativeValidation } from '/ui.mjs';
import { renderSearchWorkspace } from '/search.mjs';
import { renderImageryWorkspace } from '/imagery.mjs';

const root = document.querySelector('#app');
const dialog = document.querySelector('#modal');
const state = { user: null, csrf: '', dashboard: null, route: '', tab: '', page: 1, query: {}, map: null, epoch: 0, records: [], resource: '', selectedDrone: '', alertFilter: '', needsSetup: false };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const label = value => statusLabels[value] || value || '—';
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const title = (text, english, extra = '') => `<div class="panel-title"><b>${escape(text)}</b><small>${english}</small>${extra}</div>`;
const badge = value => `<span class="badge ${escape(value)}">${escape(label(value))}</span>`;
const button = (text, action, extra = '') => `<button data-action="${action}" ${extra}>${text}</button>`;
const canWrite = () => ['admin', 'operator'].includes(state.user?.role);
const adminOnlyResources = new Set(['system', 'metrics', 'districts', 'composition', 'compute', 'trends', 'analysis-rules', 'events', 'boundaries', 'models']);
const canEditResource = key => canWrite() && (!adminOnlyResources.has(key) || state.user.role === 'admin');
const empty = message => `<div class="empty"><span>▧</span><p>${escape(message)}</p></div>`;
const countOf = key => state.dashboard?.counts[key] || 0;

function notify(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast ${error ? 'error' : ''}`;
  element.textContent = message;
  document.querySelector('#notifications').append(element);
  setTimeout(() => element.remove(), 6500);
}
async function api(path, { method = 'GET', body, version, signal } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf };
  if (version !== undefined) headers['If-Match'] = String(version);
  const response = await fetch(path, { method, credentials: 'same-origin', headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user) { state.user = null; state.csrf = ''; location.hash = '/login'; }
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  if (data.csrfToken) state.csrf = data.csrfToken;
  return data;
}
async function loadCameras() {
  const items = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const result = await api(`/api/resources/cameras?page=${page}&pageSize=200`);
    items.push(...result.items); pages = Math.ceil(result.total / 200);
  }
  return items;
}
function go(route) { location.hash = `/${route}`; }
function routeInfo() {
  const [path, query = ''] = location.hash.slice(1).replace(/^\//, '').split('?');
  return { route: path || 'control', tab: new URLSearchParams(query).get('tab') || 'patrol' };
}
function closeDialog() { dialog.close(); dialog.innerHTML = ''; }
function openDialog(name, body, footer = '') {
  closeDialog();
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${escape(name)}</h2><button data-action="close" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div>${footer ? `<div class="dialog-footer">${footer}</div>` : ''}`;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  enhanceInterface(dialog);
  dialog.showModal();
}
dialog.addEventListener('click', event => {
  if (event.target.closest('[data-action="close"]')) closeDialog();
  if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  }
});
function symbol(type = 'camera') {
  if (['face', 'body'].includes(type)) return '<svg viewBox="0 0 80 70"><circle cx="40" cy="22" r="12"/><path d="M17 62v-8a23 23 0 0 1 46 0v8Z"/><path class="frame" d="M5 18V5h14M61 5h14v13M75 52v13H61M19 65H5V52"/></svg>';
  if (['vehicle', 'bicycle', 'tricycle'].includes(type)) return '<svg viewBox="0 0 80 70"><path d="m16 42 8-20h33l9 20v14H15V42Zm4 0h40M28 29h25"/><circle cx="25" cy="56" r="5"/><circle cx="56" cy="56" r="5"/></svg>';
  return '<svg viewBox="0 0 80 70"><path d="M13 21h42v31H13zM55 31l16-8v28l-16-8M22 58h27"/><circle cx="34" cy="36" r="10"/><path class="frame" d="M3 11V3h15M63 3h14v12M77 55v12H63M17 67H3V55"/></svg>';
}
function thumbnail(item) {
  return item.imageUrl ? `<img src="${escape(item.imageUrl)}" alt="${escape(item.name)}" loading="lazy" referrerpolicy="no-referrer">` : `<div class="synthetic-thumb">${symbol(item.type)}<small>演示图形</small></div>`;
}
function shell() {
  const isAdmin = state.route.startsWith('admin/');
  document.body.dataset.theme = 'dark';
  document.body.dataset.workspace = isAdmin ? 'admin' : 'screen';
  if (isAdmin) {
    const key = state.route.slice(6);
    const current = resourceMap[key]?.label || (key === 'dji' ? '司空 2 对接' : key === 'map' ? '地图配置' : '运营总览');
    const visible = resources.filter(def => !def.adminOnly || state.user.role === 'admin');
    const groups = [...new Set(visible.map(def => def.group))];
    root.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar"><div class="admin-brand"><img src="/mark.svg" alt=""><div>协同巡查 · 数据管理<small>DATA ADMIN CONSOLE</small></div></div><nav aria-label="后台导航"><p class="nav-group">概览</p><button data-nav="admin/dashboard" class="${key === 'dashboard' ? 'active' : ''}">运营总览</button>${groups.map(group => `<p class="nav-group">${group}</p>${visible.filter(def => def.group === group).map(def => `<button data-nav="admin/${def.key}" class="${key === def.key ? 'active' : ''}">${def.label}<span>${countOf(def.key)}</span></button>`).join('')}${group === '大屏配置' && state.user.role === 'admin' ? `<button data-nav="admin/map" class="${key === 'map' ? 'active' : ''}">地图配置</button>` : ''}`).join('')}${state.user.role === 'admin' ? '<p class="nav-group">对接</p><button data-nav="admin/dji" class="' + (key === 'dji' ? 'active' : '') + '">司空 2 对接</button>' : ''}</nav><div class="sidebar-user"><b>${escape(state.user.name)}</b><small>${escape(label(state.user.role))} · 本地独立平台</small></div></aside><section class="admin-content"><header class="admin-header"><div><b>${current}</b><small>${key === 'dji' ? 'DJI FLIGHTHUB 2 · PUBLIC CLOUD' : key === 'dashboard' ? 'DATA OVERVIEW' : key === 'map' ? 'MAP CONFIGURATION' : 'DATA MANAGEMENT CONSOLE'}</small></div><div class="header-actions">${button('返回大屏', 'screen')}${button('修改密码', 'password')}${button('退出登录', 'logout')}<span class="avatar">${escape(state.user.name.slice(0, 1))}</span><span class="admin-user-name">${escape(state.user.name)}</span></div></header><main class="admin-main"><div class="breadcrumb">后台管理 / ${current}<span>独立重建 · 演示数据与生产接入分离</span></div><div id="content"></div></main></section></div>`;
  } else {
    root.innerHTML = `<div class="screen-layout"><header class="screen-header"><div class="screen-brand"><img src="/mark.svg" alt=""><div>无人机+视频结构化协同巡查平台<small>PUBLIC SECURITY VIDEO INTELLIGENCE PLATFORM</small></div></div><nav aria-label="主导航">${mainNavigation.map(([key, text]) => `<button data-nav="${key}" class="${state.route === key ? 'active' : ''}"><span aria-hidden="true">${navigationIcon(key)}</span>${text}</button>`).join('')}</nav><div class="header-actions"><span class="connection"><i></i>本地服务</span>${button('⛶', 'fullscreen', 'title="全屏" aria-label="全屏"')}<div class="clock"></div><button data-action="admin" class="account-button"><span class="avatar">${escape(state.user.name.slice(0, 1))}</span><span>${escape(state.user.name)}<small>数据管理 ↗</small></span></button>${button('退出', 'logout')}</div></header><main id="content" class="screen-main"></main><footer class="screen-footer"><span><i></i> 本地服务运行中</span><span>点位记录 ${countOf('cameras')} · 演示在线 ${state.dashboard.onlineCameras}</span><span>预警 ${countOf('alerts')} · 待处置 ${state.dashboard.pendingAlerts}</span><span class="footer-update">数据刷新 ${formatTime(state.dashboard.updatedAt)}</span><strong>演示数据 · 飞控 / AI 未接入</strong><span>GONGAN V0.1</span></footer></div>`;
  }
  updateClock();
}
function updateClock() {
  const clock = document.querySelector('.clock');
  if (clock) clock.innerHTML = `<b>${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</b><small>${new Date().toLocaleDateString('zh-CN')} ${['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][new Date().getDay()]}</small>`;
}
function statsCards() {
  const values = [['视频点位', countOf('cameras'), '路'], ['演示在线点位', state.dashboard.onlineCameras, '路'], ['结构化抓拍', countOf('captures'), '条'], ['预警记录', countOf('alerts'), '条'], ['待处置预警', state.dashboard.pendingAlerts, '条'], ['布控任务', countOf('controls'), '项'], ['人员档案', countOf('persons'), '份'], ['无人机', countOf('drones'), '架']];
  return `<div class="stats-grid">${values.map(([text, number, unit], i) => `<div class="stat-card"><span>${text}</span><b class="${i === 4 ? 'amber' : ''}">${number}<small>${unit}</small></b><div class="stat-spark"></div></div>`).join('')}</div>`;
}
async function renderAdminOverview(content, epoch) {
  return mountAdminDashboard(content, {
    dashboard: state.dashboard, user: state.user, api, notify, epochCurrent: () => epoch === state.epoch,
    onUpdate(dashboard) {
      state.dashboard = dashboard;
      for (const button of document.querySelectorAll('.admin-sidebar nav [data-nav]')) {
        const count = button.querySelector('span');
        if (count) count.textContent = countOf(button.dataset.nav.slice(6));
      }
    },
  });
}
function tableMarkup(def, result) {
  const fields = def.fields.filter(field => !['note', 'imageUrl', 'videoUrl', 'url', 'geojson', 'waypoints'].includes(field.key)).slice(0, 7);
  const rows = result.items.map(item => `<tr><td class="row-check">${item.demo ? '<span class="demo-dot" title="演示数据">D</span>' : '•'}</td>${fields.map(field => {
    const text = field.type === 'datetime' ? formatTime(item[field.key]) : label(item[field.key]);
    return `<td class="${field.type === 'number' ? 'cell-number' : field.type === 'datetime' ? 'cell-date' : ''}" title="${escape(text)}">${['status', 'severity', 'role'].includes(field.key) ? badge(item[field.key]) : escape(text)}</td>`;
  }).join('')}<td class="table-actions"><button data-detail="${item.id}" data-resource="${def.key}">详情</button>${canEditResource(def.key) ? `<button data-edit="${item.id}" data-resource="${def.key}">编辑</button>` : ''}${state.user.role === 'admin' ? `<button class="danger-link" data-delete="${item.id}" data-resource="${def.key}">删除</button>` : ''}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th aria-label="记录来源"></th>${fields.map(field => `<th class="${field.type === 'number' ? 'cell-number' : ''}">${field.label}</th>`).join('')}<th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="${fields.length + 2}">${empty('暂无记录，可通过新增建立本地数据')}</td></tr>`}</tbody></table></div>`;
}
function filtersMarkup(def) {
  const statusField = def.fields.find(field => field.key === 'status');
  return `<form id="resource-filter" class="filters"><input aria-label="搜索名称或点位" name="q" placeholder="搜索名称 / 点位…" value="${escape(state.query.q || '')}">${def.fields.some(field => field.key === 'district') ? `<select aria-label="辖区" name="district"><option value="">全部辖区</option>${districts.map(area => `<option ${state.query.district === area ? 'selected' : ''}>${area}</option>`).join('')}</select>` : ''}${statusField ? `<select name="status" aria-label="状态"><option value="">全部状态</option>${statusField.options.map(value => `<option value="${value}" ${state.query.status === value ? 'selected' : ''}>${label(value)}</option>`).join('')}</select>` : ''}<button class="primary" type="submit">查询</button><button type="button" data-action="reset-filter">重置</button><span class="push"></span>${canEditResource(def.key) ? `<button type="button" data-new="${def.key}" class="primary">＋ 新增${def.label}</button>` : ''}<button type="button" data-action="export">导出当前页</button><button type="button" data-action="refresh">↻ 刷新</button></form>`;
}
function pagination(result) {
  return `<div class="pagination"><span>共 ${result.total} 条 · 每页 ${result.pageSize} 条</span><span class="push"></span><button data-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>上一页</button><b>${result.page} / ${Math.max(1, Math.ceil(result.total / result.pageSize))}</b><button data-page="${result.page + 1}" ${result.page * result.pageSize >= result.total ? 'disabled' : ''}>下一页</button></div>`;
}
async function renderResource(content, key, epoch) {
  const def = resourceMap[key];
  if (!def) throw new Error('资源页面不存在');
  state.resource = key;
  if (key === 'logs') return renderAudit(content, epoch);
  if (key === 'accounts') return renderAccounts(content, epoch);
  const query = new URLSearchParams({ ...state.query, page: String(state.page), pageSize: '15' });
  const result = await api(`/api/resources/${key}?${query}`);
  if (epoch !== state.epoch) return;
  state.records = result.items;
  content.innerHTML = `<div class="resource-page"><div class="panel">${title(def.label, def.key.toUpperCase().replaceAll('-', ' '), '<span class="push">D = 合成演示记录</span>')}${['ai-tasks', 'jobs', 'offline', 'matches', 'companions', 'loitering', 'stays', 'trajectories', 'ai-events', 'models', 'targets'].includes(key) ? '<div class="inline-notice">此处维护本地业务记录。真实推理、跨镜关联、媒体解析及模型加载尚未接入，不会因更改记录状态而自动执行。</div>' : ''}${filtersMarkup(def)}${tableMarkup(def, result)}${pagination(result)}</div></div>`;
}
async function renderAudit(content, epoch) {
  const result = await api(`/api/audit?page=${state.page}&pageSize=20`);
  if (epoch !== state.epoch) return;
  state.records = result.items;
  content.innerHTML = `<div class="panel">${title('操作日志', 'AUDIT TRAIL')}<div class="inline-notice">登录、维护、预警处置与账号变更留痕。日志只读，不可在界面修改或删除。</div><div class="table-wrap"><table><thead><tr>${['操作人', '动作', '资源', '对象', '摘要', '时间'].map(text => `<th>${text}</th>`).join('')}</tr></thead><tbody>${result.items.map(item => `<tr>${[item.actor, item.action, item.resource, item.record_id || '—', item.summary, formatTime(item.created_at)].map(text => `<td>${escape(text)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${pagination(result)}</div>`;
}
async function renderAccounts(content, epoch) {
  const result = await api('/api/resources/accounts');
  if (epoch !== state.epoch) return;
  content.innerHTML = `<div class="panel">${title('账号权限', 'ACCESS CONTROL')}<div class="filters">${button('＋ 新建账号', 'create-account', 'class="primary"')}${button('修改我的密码', 'password')}<span class="push"></span><span>管理员 / 操作员 / 观察员</span></div><div class="table-wrap"><table><thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>创建时间</th></tr></thead><tbody>${result.items.map(item => `<tr><td>${escape(item.username)}</td><td>${escape(item.name)}</td><td>${badge(item.role)}</td><td>${formatTime(item.createdAt)}</td></tr>`).join('')}</tbody></table></div><div class="inline-notice">观察员只读；操作员可维护业务记录和处置预警；管理员可配置系统、新建账号及删除记录。</div></div>`;
}
function alertCards(alerts) {
  return alerts.map(item => `<article class="alert-card"><div class="alert-thumb">${thumbnail(item)}</div><div class="alert-info"><div><b>${escape(item.type || item.name)}</b>${badge(item.severity)}<time>${new Date(item.occurredAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></div><p>${escape(item.source)} · ${escape(item.district)}</p><p>${badge(item.status)} <span>${item.confidence ?? '—'}%</span> <small>合成演示</small></p><div class="compact-actions">${item.status === 'pending' && canWrite() ? `<button class="primary" data-transition="${item.id}" data-status="acknowledged">签收</button>` : ''}${item.status === 'acknowledged' && canWrite() ? `<button data-transition="${item.id}" data-status="resolved">处置</button>` : ''}<button data-detail="${item.id}" data-resource="alerts">详情</button></div></div></article>`).join('') || empty('此状态下暂无预警');
}
function timeline() {
  const max = Math.max(1, ...state.dashboard.hourly.map(item => item.total));
  return `<div class="timeline"><div class="timeline-title">近 24 小时预警热力 <b>${state.dashboard.hourly.reduce((sum, item) => sum + item.total, 0)} 起</b><span>▰ 高危时段 · 关注 · 平稳</span></div><div class="hour-chart">${state.dashboard.hourly.map(item => `<div title="${item.hour}:00 · ${item.total} 起"><i style="height:${8 + item.total / max * 28}px"></i><small>${String(item.hour).padStart(2, '0')}</small></div>`).join('')}</div><div class="timeline-foot">按小时聚合 · 本地预警数据<span>统计随处置和数据维护更新</span></div></div>`;
}
async function renderControl(content, epoch, overview = false) {
  const [controls, alerts, cameras, fences] = await Promise.all(['controls', 'alerts', 'cameras', 'fences'].map(key => api(`/api/resources/${key}?pageSize=100`)));
  if (epoch !== state.epoch) return;
  const filtered = alerts.items.filter(item => !state.alertFilter || item.status === state.alertFilter);
  content.innerHTML = `<div class="command-grid"><aside class="panel mission-panel">${title(overview ? '全域感知' : '布控任务', overview ? 'OVERVIEW' : 'MISSIONS', `<span class="push">${state.dashboard.runningControls} 运行中</span>`)}${overview ? `<div class="overview-metrics">${statsCards()}</div>${title('辖区资源', 'DISTRICTS')}<div class="district-list">${districts.slice(0, 8).map(area => `<div><span>${area}</span><b>${cameras.items.filter(item => item.district === area).length}</b><small>路点位</small></div>`).join('')}</div>` : `<div class="mission-list">${controls.items.map(item => `<article class="mission-card"><div><b><i class="${item.status === 'running' ? '' : 'paused'}"></i>${escape(item.name.replace('演示 · ', ''))}</b>${badge(item.status)}</div><p>${escape(item.type)} · ${escape(item.library || '未关联模型')}<span>命中 ${item.hits || 0}</span></p><div class="mission-progress"><i style="width:${item.threshold || 0}%"></i></div><p>${escape(item.district)}<span>阈值 ${item.threshold || 0}%</span></p><button class="card-hit" aria-label="查看任务 ${escape(item.name)}" data-detail="${item.id}" data-resource="controls"></button></article>`).join('')}</div><div class="panel-bottom">${canWrite() ? '<button class="primary" data-new="controls">＋ 新建布控</button>' : '<span>观察员 · 只读</span>'}<button data-nav="admin/controls">布控库</button></div>`}</aside><section class="map-panel"><div class="map-heading"><div><b>${overview ? '区域态势总览' : '预警处置作战台'}</b><small>${overview ? 'REGIONAL SITUATION OVERVIEW' : 'ALERT DISPOSAL COMMAND'}</small></div><div class="map-summary"><span>待处置 <b>${state.dashboard.pendingAlerts}</b></span><span>高危 <b>${alerts.items.filter(item => item.severity === 'high').length}</b></span><span>总计 <b>${alerts.total}</b></span></div><span class="push"></span><span class="live-indicator"><i></i>本地演示</span></div><div id="main-map"></div>${timeline()}</section><aside class="panel alerts-panel">${title('实时预警', 'LIVE ALERTS', `<span class="push">◆ ${alerts.total}</span>`)}<div class="alert-tabs">${[['', '全部'], ['pending', '待处置'], ['acknowledged', '已签收'], ['resolved', '已处置']].map(([status, text]) => `<button data-alert-filter="${status}" class="${state.alertFilter === status ? 'active' : ''}">${text}</button>`).join('')}</div><div class="alerts-list">${alertCards(filtered)}</div><div class="panel-bottom"><span>本地记录 · 非实时识别流</span><button data-nav="admin/rules">预警规则</button></div></aside></div>`;
  state.map = mountMap(document.querySelector('#main-map'), overview ? cameras.items : alerts.items, { onSelect: item => detail(overview ? 'cameras' : 'alerts', item.id), notify, fences: fences.items });
}
async function renderUav(content, epoch) {
  const [drones, docks, fences, routes] = await Promise.all(['drones', 'docks', 'fences', 'routes'].map(key => api(`/api/resources/${key}?pageSize=100`)));
  if (epoch !== state.epoch) return;
  content.innerHTML = `<div class="uav-layout"><div class="uav-navigation">${uavNavigation.map(([key, text, en]) => `<button class="${state.tab === key ? 'active' : ''}" data-nav="uav?tab=${key}">${text}<small>${en}</small></button>`).join('')}<span class="push"></span><div class="uav-count"><b>${drones.total}</b>设备记录 <b>${docks.total}</b>机场记录</div></div><div id="uav-content"></div></div>`;
  const body = content.querySelector('#uav-content');
  if (state.tab === 'imagery') {
    state.map = await renderImageryWorkspace(body, {
      api, notify, escape, title, formatTime, canWrite: canWrite(), csrfToken: state.csrf,
      epochCurrent: () => epoch === state.epoch,
    });
    return;
  }
  if (resourceMap[state.tab]) return renderResource(body, state.tab, epoch);
  if (state.tab === 'stats') { body.innerHTML = `${statsCards()}<div class="panel">${title('任务趋势', 'MISSION STATISTICS')}${timeline()}<div class="inline-notice">统计为本地维护数据，暂无真实飞行架次、里程和设备遥测。</div></div>`; return; }
  if (state.tab === 'replay') {
    body.innerHTML = `<div class="panel replay-panel">${title('飞行回放', 'FLIGHT REPLAY')}<div class="inline-notice">当前支持本地航点路线预览，暂无真实飞行记录；不是飞机历史遥测回放。</div><div class="filters"><select id="replay-route" aria-label="选择航线">${routes.items.map(item => `<option value="${item.id}">${escape(item.name)}</option>`).join('')}</select><button data-action="route-preview" class="primary">查看航点</button></div><div id="main-map"></div></div>`;
    state.map = mountMap(body.querySelector('#main-map'), drones.items, { notify, routes: routes.items, onSelect: item => detail('drones', item.id) });
    return;
  }
  const drone = drones.items.find(item => item.id === state.selectedDrone) || drones.items[0];
  state.selectedDrone = drone?.id || '';
  body.innerHTML = `<div class="uav-grid"><aside class="panel">${title('无人机设备', 'UAV DEVICES', `<span class="push">${drones.total}</span>`)}<div class="drone-list">${drones.items.map(item => `<button data-drone="${item.id}" class="drone-card ${item.id === drone?.id ? 'active' : ''}"><div class="drone-icon">⌘</div><div><b>${escape(item.name)}</b>${badge(item.status)}<small>${escape(item.serial)} · ${escape(item.model)}</small><span>▰ ${item.battery ?? '—'}% · 演示电量</span></div></button>`).join('')}</div>${title('飞控', 'FLIGHT')}<div class="flight-controls"><div class="inline-notice">未接入飞控 · 指令不可用</div><button disabled class="primary">开始任务 <small>START MISSION</small></button><button disabled>起飞 <small>TAKE OFF</small></button><div class="button-grid">${['降落', '返航', '暂停', '恢复', '强制降落', '结束任务'].map(text => `<button disabled>${text}</button>`).join('')}</div><div class="flight-readout"><span>飞行模式<b>未连接</b></span><span>航线进度<b>—</b></span><span>图传<b>未接入</b></span><span>设备状态<b>未连接</b></span></div>${button('维护无人机设备', 'manage-drones')}</div></aside><section class="uav-map-wrap"><div id="main-map"></div><div class="telemetry"><span>ALT<b>${drone?.altitude ?? '—'}<small>m</small></b></span><span>SPD<b>${drone?.speed ?? '—'}<small>m/s</small></b></span><span>BAT<b>${drone?.battery ?? '—'}<small>%</small></b></span><div>合成设备记录<br><strong>非实时遥测</strong></div></div><div class="video-panel">${title('实时回传', 'LIVE VIDEO', '<span class="push">未接入网关</span>')}<div class="video-screen">${drone?.videoUrl ? `<video src="${escape(drone.videoUrl)}" controls playsinline aria-label="无人机视频"></video>` : '<div class="video-placeholder">⌘<b>暂无图传</b><small>请配置合法授权的视频地址或接入视频网关</small></div>'}</div></div></section><aside class="panel">${title('实时预警', 'LIVE ALERTS')}<div class="uav-alert-empty">${empty('暂无真实无人机识别事件')}<p>AI 推理和直播尚未接入</p></div>${title('方向控制', 'MANUAL')}<div class="direction-control"><button disabled>▲</button><div><button disabled>◀</button><span>⌘</span><button disabled>▶</button></div><button disabled>▼</button></div><div class="camera-modes">${['广角', '变焦', '红外', 'FPV'].map(text => `<button disabled>${text}</button>`).join('')}</div><div class="zoom-control"><span>变焦</span><input type="range" min="1" max="16" value="1" disabled aria-label="变焦"><b>1.0×</b></div><div class="button-grid padded"><button disabled>拍照</button><button disabled>云台回正</button></div><div class="inline-notice">飞控、拍照及云台操作需要真实设备适配器，当前不会执行。</div></aside></div>`;
  state.map = mountMap(body.querySelector('#main-map'), drones.items, { notify, onSelect: item => detail('drones', item.id), fences: fences.items, routes: routes.items });
  body.querySelector('video')?.addEventListener('error', () => notify('视频无法播放；当前播放器支持浏览器原生媒体格式，RTSP / WHEP 需要视频网关。', true));
}
async function renderSearch(content, epoch) {
  return renderSearchWorkspace(content, { state, api, loadCameras, notify, escape, title, label, thumbnail, formatTime, epochCurrent: () => epoch === state.epoch });
}
async function renderPolice(content, epoch) {
  const result = await api('/api/resources/officers?pageSize=100');
  if (epoch !== state.epoch) return;
  content.innerHTML = `<div class="police-grid"><aside class="panel">${title('警力资源', 'POLICE RESOURCES')}<div class="padded"><span class="muted">本地警力记录 · 非实时定位</span>${result.items.map(item => `<button class="officer-card" data-detail="${item.id}" data-resource="officers"><span class="avatar">◇</span><div><b>${escape(item.name)}</b><p>${escape(item.team)} · ${escape(item.district)}</p></div>${badge(item.status)}</button>`).join('')}<button data-nav="admin/officers" class="primary">维护警力记录</button></div></aside><section class="map-panel"><div class="map-heading"><b>警务执勤态势</b><span class="push"></span><span>合成演示定位</span></div><div id="main-map"></div></section></div>`;
  state.map = mountMap(document.querySelector('#main-map'), result.items, { notify, onSelect: item => detail('officers', item.id) });
}
async function renderApps(content, epoch, archive = false) {
  const tabs = archive ? ['persons', 'topics', 'archive-summary', 'trajectories'] : ['hotspots', 'loitering', 'stays', 'companions', 'footholds', 'jobs', 'offline'];
  const selected = tabs.includes(state.tab) ? state.tab : tabs[0];
  content.innerHTML = `<div class="module-layout"><div class="module-nav">${tabs.map(key => `<button data-nav="${archive ? 'archives' : 'apps'}?tab=${key}" class="${key === selected ? 'active' : ''}">${resourceMap[key].label}</button>`).join('')}<span class="push"></span><span class="muted">本地业务记录 · 推理与关联引擎未接入</span></div><div id="module-content"></div></div>`;
  await renderResource(content.querySelector('#module-content'), selected, epoch);
}
async function renderDji(content, epoch) {
  const data = await api('/api/integrations/dji');
  if (epoch !== state.epoch) return;
  content.innerHTML = `<div class="dji-grid"><section class="panel">${title('接入配置', 'FLIGHTHUB 2 · PUBLIC CLOUD', '<span class="badge medium">适配器待接入</span>')}<form id="dji-form" class="dji-form"><label>服务地址<div><input value="${escape(data.baseUrl)}" readonly><small>公有云地址；本版本不会向该服务发送请求</small></div></label><label>组织密钥<div><input type="password" placeholder="通过部署环境配置，不写入浏览器或源码" disabled><small>当前无密钥存储与云端鉴权适配器</small></div></label><label>项目 UUID<div><input name="projectId" value="${escape(data.projectId)}" maxlength="100"><small>司空 2 项目详情中的项目 UUID，仅保存本地配置</small></div></label><label>事件验签密钥<div><input type="password" placeholder="回调适配器未接入" disabled><small>回调验签、事件映射需要对照正式 API 文档开发</small></div></label><label>启用对接<div><input type="checkbox" disabled> <span class="muted">未接入 SDK，保持禁用</span></div></label><label>事件回调地址<div><input value="未开放回调端点" disabled><small>防止未验证来源的事件写入业务库</small></div></label><div class="form-buttons"><button class="primary" type="submit">保存配置</button><button type="button" data-action="dji-test">测试连接</button></div><div class="inline-notice">${escape(data.message)}</div></form></section><div class="dji-right"><section class="panel">${title('直播预览', 'OPENAPI LIVESTREAM')}<div class="filters"><input placeholder="飞机 / 机场 SN" disabled><select disabled aria-label="摄像头"><option>主相机</option></select><button disabled>播放</button></div><div class="dji-video"><span>未接入 DJI 直播 API / WHEP 播放适配器<br><small>不会使用黑屏或模拟画面冒充真实直播。</small></span></div></section><section class="panel">${title('连通性', 'CONNECTIVITY')}${empty('未连接 · 点击测试可查看当前接入状态')}</section><section class="panel">${title('最近事件', 'EVENT API', '<span>0 条</span>')}<div class="table-wrap"><table><thead><tr><th>类型</th><th>飞机 SN</th><th>机场 SN</th><th>接收时间</th><th>事件 ID</th></tr></thead></table></div>${empty('尚无事件接入')}</section></div></div>`;
}

async function detail(key, id) {
  try {
    const item = await api(`/api/resources/${key}/${id}`);
    const def = resourceMap[key];
    const body = `<div class="detail-source">${item.demo ? '<span class="badge medium">合成演示数据</span>' : '<span class="badge active">本地业务记录</span>'}<span>版本 ${item.version}</span></div><dl class="detail-grid">${def.fields.map(field => `<dt>${field.label}</dt><dd>${['status', 'severity'].includes(field.key) ? badge(item[field.key]) : field.type === 'json' ? `<pre>${escape(JSON.stringify(item[field.key] ?? null, null, 2))}</pre>` : field.type === 'datetime' ? escape(formatTime(item[field.key])) : escape(label(item[field.key]))}</dd>`).join('')}<dt>更新时间</dt><dd>${formatTime(item.updatedAt)}</dd><dt>记录 ID</dt><dd class="mono">${escape(id)}</dd></dl>`;
    const footer = `${key === 'alerts' && canWrite() && item.status === 'pending' ? `<button class="primary" data-transition="${id}" data-status="acknowledged">签收预警</button>` : ''}${key === 'alerts' && canWrite() && item.status === 'acknowledged' ? `<button class="primary" data-transition="${id}" data-status="resolved">处置预警</button>` : ''}${key === 'controls' && canWrite() && ['running', 'paused', 'draft'].includes(item.status) ? `<button data-toggle-control="${id}" data-status="${item.status === 'running' ? 'paused' : 'running'}">${item.status === 'running' ? '暂停任务记录' : '启动任务记录'}</button>` : ''}${canEditResource(key) ? `<button data-edit="${id}" data-resource="${key}">编辑</button>` : ''}<button data-action="close">关闭</button>`;
    openDialog(`${def.label}详情`, body, footer);
  } catch (error) { notify(error.message, true); }
}
function formField(field, item) {
  const value = item[field.key] ?? field.default ?? '';
  const common = `name="${field.key}" aria-label="${escape(field.label)}" ${field.required ? 'required' : ''}`;
  let input;
  if (field.type === 'select') input = `<select ${common}><option value="">请选择</option>${field.options.map(option => `<option value="${escape(option)}" ${option === value ? 'selected' : ''}>${escape(field.optionLabels?.[option] || label(option))}</option>`).join('')}</select>`;
  else if (['textarea', 'json'].includes(field.type)) input = `<textarea ${common} rows="${field.type === 'json' ? 4 : 2}" maxlength="${field.maxLength || 20000}">${escape(field.type === 'json' && value ? JSON.stringify(value, null, 2) : value)}</textarea>`;
  else {
    let display = value;
    if (field.type === 'datetime' && value) {
      const date = new Date(value);
      display = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    input = `<input ${common} type="${field.type === 'datetime' ? 'datetime-local' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}" value="${escape(display)}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${field.type === 'number' ? `step="${field.integer ? '1' : 'any'}"` : ''} maxlength="${field.maxLength || 500}">`;
  }
  return `<label class="${['textarea', 'json'].includes(field.type) ? 'full-width' : ''}">${field.label}${field.required ? '<em>*</em>' : ''}${input}</label>`;
}
async function edit(key, id) {
  const def = resourceMap[key];
  const item = id ? await api(`/api/resources/${key}/${id}`) : {};
  const cameras = key === 'captures' ? await loadCameras() : [];
  const fields = def.fields.filter(field => !(id && key === 'alerts' && field.key === 'status')).map(field => {
    if (key !== 'captures' || field.key !== 'cameraId') return field;
    const options = cameras.map(camera => camera.id);
    const optionLabels = Object.fromEntries(cameras.map(camera => [camera.id, `${camera.name} · ${camera.code || '未维护编号'}`]));
    if (item.cameraId && !options.includes(item.cameraId)) { options.push(item.cameraId); optionLabels[item.cameraId] = '原摄像头已删除，请重新选择'; }
    return { ...field, type: 'select', options, optionLabels };
  });
  openDialog(`${id ? '编辑' : '新增'}${def.label}`, `<form id="record-form" data-resource="${key}" data-id="${id || ''}" data-version="${item.version || ''}"><div class="form-grid">${fields.map(field => formField(field, item)).join('')}</div><p class="form-error" role="alert"></p><div class="dialog-footer"><button type="button" data-action="close">取消</button><button class="primary" type="submit">保存</button></div></form>`);
  if (key === 'captures') dialog.querySelector('[name="cameraId"]').addEventListener('change', event => {
    dialog.querySelector('[name="cameraCode"]').value = cameras.find(camera => camera.id === event.target.value)?.code || '';
  });
}
function confirmDelete(key, id) {
  openDialog('确认删除', '<p>将永久删除这条本地记录，操作会写入审计日志。此操作不会修改原站数据。</p>', `<button data-action="close">取消</button><button class="danger" data-confirm-delete="${id}" data-resource="${key}">确认删除</button>`);
}
async function transitionAlert(id, status) {
  if (status === 'acknowledged') {
    await api(`/api/alerts/${id}/transition`, { method: 'POST', body: { status } });
    closeDialog(); notify('预警已签收'); await render(); return;
  }
  openDialog('预警处置', `<form id="transition-form" data-id="${id}"><label>处置结果<select name="status"><option value="resolved">已处置</option><option value="ignored">忽略 / 误报</option></select></label><label>处置说明<textarea name="note" required maxlength="2000" rows="4" placeholder="填写核实情况及处置说明"></textarea></label><p class="form-error" role="alert"></p><div class="dialog-footer"><button type="button" data-action="close">取消</button><button class="primary" type="submit">提交处置</button></div></form>`);
}
function passwordDialog() {
  openDialog('修改登录密码', '<form id="password-form"><label>当前密码<input type="password" name="currentPassword" autocomplete="current-password" required></label><label>新密码<input type="password" name="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><p class="muted">至少 12 个字符；修改后所有现有会话失效。</p><p class="form-error" role="alert"></p><div class="dialog-footer"><button class="primary" type="submit">修改密码</button></div></form>');
}
function accountDialog() {
  openDialog('新建账号', '<form id="account-form"><div class="form-grid"><label>账号<input name="username" pattern="[a-zA-Z0-9_-]{3,40}" required autocomplete="off"></label><label>姓名<input name="name" maxlength="100" required></label><label>角色<select name="role"><option value="viewer">观察员</option><option value="operator">操作员</option><option value="admin">管理员</option></select></label><label>初始密码<input name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></label></div><p class="form-error" role="alert"></p><div class="dialog-footer"><button class="primary" type="submit">创建账号</button></div></form>');
}
function exportPage() {
  const blob = new Blob([JSON.stringify({ resource: state.resource, exportedAt: new Date().toISOString(), scope: 'current-page', items: state.records }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `gongan-${state.resource}-page-${state.page}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`已导出当前页 ${state.records.length} 条记录`);
}

async function loginPage() {
  document.body.dataset.theme = 'dark';
  document.body.dataset.workspace = 'login';
  const health = await api('/api/health');
  state.needsSetup = health.needsSetup;
  const setup = health.needsSetup && state.tab !== 'signin';
  root.innerHTML = `<div class="login-page"><div class="login-grid-art"></div><header class="login-header"><img src="/mark.svg" alt=""><b>协同巡查 · 本地平台</b><span class="push"></span><span class="connection"><i></i> 本地服务运行正常</span></header><main class="login-content"><section class="login-intro"><div class="eyebrow">全域感知 · 协同巡查 · 数据研判</div><h1>无人机 + 视频结构化<br>协同巡查平台</h1><div class="english-title">INTEGRATED VIDEO INTELLIGENCE PLATFORM</div><p>独立开发的指挥大屏与数据管理平台</p><div class="login-feature-row"><span><b>双端</b>协同管理</span><span><b>41 类</b>业务资源</span><span><b>本地</b>数据持久化</span></div><div class="login-note">初始数据为合成演示样例。真实视频、飞控和算法服务尚未接入。<br>账号独立于参考站点，不会使用或保存参考站点密码。</div></section><section class="login-card"><div class="login-card-title"><img src="/mark.svg" alt=""><div><h2>${setup ? '初始化管理员' : '身份认证'}</h2><small>${setup ? 'INITIAL SETUP' : 'IDENTITY AUTHENTICATION'}</small></div></div><form id="${setup ? 'setup-form' : 'login-form'}"><label>账号<input name="username" autocomplete="username" value="admin" required pattern="[a-zA-Z0-9_-]{3,40}"></label><label>${setup ? '设置本地密码（至少 12 位）' : '登录密码'}<input name="password" type="password" required ${setup ? 'minlength="12"' : ''} maxlength="128" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? '请设置独立密码，不使用原站密码' : '请输入本地账号密码'}"></label>${setup ? '<label>确认密码<input name="confirm" type="password" minlength="12" required autocomplete="new-password" placeholder="再次输入密码"></label>' : ''}<div class="login-security">◇ Cookie 会话保护 · 操作留痕 · 分级权限</div><p class="form-error" role="alert"></p><button class="primary login-submit" type="submit">${setup ? '创建本地管理员' : '进 入 平 台'}</button></form><button class="observer-entry" data-action="demo">以观察员身份体验 →</button><p class="muted">观察员只读，不需要输入参考站点账号。${setup ? '管理员初始化仅限本机。' : '忘记密码请联系本地部署管理员。'}</p></section></main><footer class="login-footer">独立重建版本 · 本地开发环境 <span>GONGAN V0.1 · 非生产验收版本</span></footer></div>`;
}
async function render() {
  const epoch = ++state.epoch;
  state.map?.destroy(); state.map = null;
  const { route, tab } = routeInfo();
  if (route !== state.route || tab !== state.tab) { state.page = 1; state.query = {}; state.records = []; state.resource = ''; }
  state.route = route; state.tab = tab;
  if (!state.user) { await loginPage(); enhanceInterface(root); return; }
  try {
    state.dashboard = await api('/api/dashboard');
    if (epoch !== state.epoch) return;
    shell();
    const content = document.querySelector('#content');
    content.innerHTML = '<div class="loading">正在读取本地数据…</div>';
    if (route === 'admin/dashboard') state.map = await renderAdminOverview(content, epoch);
    else if (route === 'admin/map') state.map = await renderMapSettings(content, { api, notify, epochCurrent: () => epoch === state.epoch });
    else if (route === 'admin/dji') await renderDji(content, epoch);
    else if (route.startsWith('admin/')) await renderResource(content, route.slice(6), epoch);
    else if (route === 'overview') state.map = await renderOverview(content, { dashboard: state.dashboard, api, notify, detail, epochCurrent: () => epoch === state.epoch });
    else if (route === 'control' || route === 'login') await renderControl(content, epoch);
    else if (route === 'uav') await renderUav(content, epoch);
    else if (route === 'search') state.map = await renderSearch(content, epoch);
    else if (route === 'police') await renderPolice(content, epoch);
    else if (route === 'apps' || route === 'archives') await renderApps(content, epoch, route === 'archives');
    else content.innerHTML = `${empty('页面不存在')}<button data-nav="control">返回布控预警</button>`;
    enhanceInterface(root);
    document.title = `${route.startsWith('admin/') ? '数据管理' : mainNavigation.find(item => item[0] === route)?.[1] || '协同巡查'} · 无人机视频平台`;
  } catch (error) {
    if (epoch !== state.epoch) return;
    const content = document.querySelector('#content') || root;
    content.innerHTML = `<div class="page-error"><h2>页面加载失败</h2><p>${escape(error.message)}</p><button data-action="refresh">重试</button><button data-nav="control">返回首页</button></div>`;
    notify(error.message, true);
  }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  try {
    if (target.dataset.nav) { go(target.dataset.nav); return; }
    if (target.dataset.new) { await edit(target.dataset.new); return; }
    if (target.dataset.detail) { await detail(target.dataset.resource, target.dataset.detail); return; }
    if (target.dataset.edit) { await edit(target.dataset.resource, target.dataset.edit); return; }
    if (target.dataset.delete) { confirmDelete(target.dataset.resource, target.dataset.delete); return; }
    if (target.dataset.confirmDelete) {
      await api(`/api/resources/${target.dataset.resource}/${target.dataset.confirmDelete}`, { method: 'DELETE' });
      closeDialog(); notify('记录已删除'); await render(); return;
    }
    if (target.dataset.transition) { await transitionAlert(target.dataset.transition, target.dataset.status); return; }
    if (target.dataset.toggleControl) {
      await api(`/api/resources/controls/${target.dataset.toggleControl}`, { method: 'PATCH', body: { status: target.dataset.status } });
      closeDialog(); notify('任务记录状态已更新；未启动实际飞行或推理'); await render(); return;
    }
    if (target.dataset.page) { state.page = Number(target.dataset.page); await render(); return; }
    if (target.dataset.alertFilter !== undefined) { state.alertFilter = target.dataset.alertFilter; await render(); return; }
    if (target.dataset.drone) { state.selectedDrone = target.dataset.drone; await render(); return; }
    switch (target.dataset.action) {
      case 'target-trend': {
        const rows = state.dashboard.targetHourly.map(item => `<tr><td>${String(item.hour).padStart(2, '0')}:00</td><td>${item.total}</td><td>${item.faceTotal}</td></tr>`).join('');
        openDialog('24 小时目标趋势数据', `<p class="muted">本地抓拍记录按小时统计，含当前未结束小时；非实时识别结果。</p><div class="table-wrap"><table><thead><tr><th>小时</th><th>全部抓拍（条）</th><th>人脸记录（条）</th></tr></thead><tbody>${rows}</tbody></table></div>`);
        break;
      }
      case 'skip-content': (document.querySelector('#content') || document.querySelector('.login-content'))?.focus(); break;
      case 'refresh': await render(); break;
      case 'reset-filter': state.query = {}; state.page = 1; await render(); break;
      case 'screen': go('control'); break;
      case 'admin': go('admin/dashboard'); break;
      case 'dji': go('admin/dji'); break;
      case 'manage-drones': go('admin/drones'); break;
      case 'manage-captures': go('admin/captures'); break;
      case 'password': passwordDialog(); break;
      case 'create-account': accountDialog(); break;
      case 'export': exportPage(); break;
      case 'route-preview': {
        const id = document.querySelector('#replay-route')?.value;
        if (id) await detail('routes', id);
        else notify('请先维护航线记录', true);
        break;
      }
      case 'dji-test': await api('/api/integrations/dji/test', { method: 'POST', body: {} }); break;
      case 'fullscreen': if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); break;
      case 'demo': {
        const result = await api('/api/auth/demo', { method: 'POST', body: {} });
        state.user = result.user;
        if (routeInfo().route === 'control') await render(); else go('control');
        break;
      }
      case 'logout': await api('/api/auth/logout', { method: 'POST', body: {} }); state.user = null; state.csrf = ''; closeDialog(); go('login'); await render(); break;
    }
  } catch (error) { notify(error.message, true); }
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const submit = form.querySelector('[type="submit"]');
  const errorNode = form.querySelector('.form-error');
  const values = Object.fromEntries(new FormData(form).entries());
  if (errorNode) errorNode.textContent = '';
  if (submit) submit.disabled = true;
  try {
    if (form.id === 'setup-form') {
      if (values.password !== values.confirm) throw new Error('两次输入的密码不一致');
      await api('/api/setup', { method: 'POST', body: { username: values.username, password: values.password } });
      const result = await api('/api/auth/login', { method: 'POST', body: { username: values.username, password: values.password } });
      state.user = result.user; notify('本地管理员创建成功');
      if (routeInfo().route === 'control') await render(); else go('control');
    } else if (form.id === 'login-form') {
      const result = await api('/api/auth/login', { method: 'POST', body: values });
      state.user = result.user;
      if (routeInfo().route === 'control') await render(); else go('control');
    } else if (form.id === 'record-form') {
      const key = form.dataset.resource;
      const body = {};
      for (const field of resourceMap[key].fields) {
        if (!(field.key in values)) continue;
        const value = values[field.key];
        if (!value && !field.required) { if (!['number', 'json'].includes(field.type)) body[field.key] = ''; continue; }
        if (field.type === 'number') body[field.key] = Number(value);
        else if (field.type === 'json') {
          try { body[field.key] = JSON.parse(value); } catch { throw new Error(`${field.label}不是有效 JSON`); }
        } else if (field.type === 'datetime') body[field.key] = new Date(value).toISOString();
        else body[field.key] = value;
      }
      await api(`/api/resources/${key}${form.dataset.id ? '/' + form.dataset.id : ''}`, { method: form.dataset.id ? 'PATCH' : 'POST', body, version: form.dataset.id ? form.dataset.version : undefined });
      closeDialog(); notify('已保存到本地数据库'); await render();
    } else if (form.id === 'transition-form') {
      await api(`/api/alerts/${form.dataset.id}/transition`, { method: 'POST', body: values });
      closeDialog(); notify('处置结果已保存'); await render();
    } else if (form.id === 'resource-filter' || form.id === 'search-form') {
      if (values.from && values.to && Date.parse(values.from) > Date.parse(values.to)) throw new Error('开始时间不能晚于结束时间');
      state.query = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
      state.page = 1; await render();
    } else if (form.id === 'dji-form') {
      await api('/api/integrations/dji', { method: 'PUT', body: { projectId: values.projectId, enabled: false } });
      notify('本地配置已保存，对接仍处于禁用状态');
    } else if (form.id === 'account-form') {
      await api('/api/users', { method: 'POST', body: values });
      closeDialog(); notify('账号已创建'); await render();
    } else if (form.id === 'password-form') {
      await api('/api/auth/password', { method: 'PUT', body: values });
      closeDialog(); state.user = null; state.csrf = ''; notify('密码已修改，请重新登录'); go('login'); await render();
    }
  } catch (error) {
    if (errorNode?.isConnected) { errorNode.textContent = error.message; focusFormError(errorNode); }
    else notify(error.message, true);
  } finally { if (submit?.isConnected) submit.disabled = false; }
});
document.addEventListener('invalid', event => {
  updateNativeValidation(event.target.form);
}, true);
document.addEventListener('input', event => {
  const input = event.target;
  if (input.getAttribute('aria-invalid') === 'true') updateNativeValidation(input.form);
});
window.addEventListener('hashchange', () => { closeDialog(); render().catch(error => notify(error.message, true)); });
window.addEventListener('unhandledrejection', event => notify(`操作失败：${event.reason?.message || event.reason}`, true));
setInterval(updateClock, 1000);
setInterval(async () => {
  if (!state.user || document.hidden || state.route.startsWith('admin/')) return;
  try {
    const dashboard = await api('/api/dashboard');
    state.dashboard = dashboard;
    const footer = document.querySelector('.footer-update');
    if (footer) footer.textContent = `服务同步 ${formatTime(dashboard.updatedAt)} · 刷新页面查看最新记录`;
  } catch (error) { notify(`后台同步失败：${error.message}`, true); }
}, 30000);
try {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (response.ok) { const data = await response.json(); state.user = data.user; state.csrf = data.csrfToken; }
  else if (response.status !== 401) throw new Error('无法检查登录状态');
  await render();
} catch (error) { root.innerHTML = `<div class="page-error"><h2>服务无法连接</h2><p>${escape(error.message)}</p><button data-action="refresh">重试</button></div>`; }
