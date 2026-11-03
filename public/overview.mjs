import { mountMap } from './map.mjs';
import { statusLabels } from '/shared/catalog.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => Number(value || 0).toLocaleString('zh-CN');
const clock = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const heading = (text, english, extra = '') => `<div class="ov-panel-heading"><b>${text}</b><small>${english}</small>${extra}</div>`;
const colors = { face: '#43dfff', body: '#25e8ad', bicycle: '#a678ff', tricycle: '#fa936d', vehicle: '#ffd063' };

function linePath(values, width = 240, height = 148, maximum = Math.max(1, ...values)) {
  const max = Math.max(1, maximum);
  const points = values.map((value, i) => [i / Math.max(1, values.length - 1) * width, height - value / max * (height - 10)]);
  if (!points.length) return '';
  return points.reduce((path, [x, y], i) => i ? `${path} L${x.toFixed(1)} ${y.toFixed(1)}` : `M${x.toFixed(1)} ${y.toFixed(1)}`, '');
}
function trendChart(hourly, id) {
  const width = 240, height = 148;
  const maximum = Math.max(2, Math.ceil(Math.max(0, ...hourly.map(item => item.total)) / 2) * 2);
  const path = linePath(hourly.map(item => item.total), width, height, maximum);
  const facePath = linePath(hourly.map(item => item.faceTotal || 0), width, height, maximum);
  return `<svg class="ov-line-chart" viewBox="0 0 294 ${height + 30}" preserveAspectRatio="none" role="img" aria-label="近24小时结构化目标数量趋势，实线为抓拍总数，虚线为人脸记录">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1cdef7" stop-opacity=".28"/><stop offset="1" stop-color="#1cdef7" stop-opacity=".01"/></linearGradient></defs>
    <g transform="translate(34 8)">${[0, .5, 1].map(r => `<path d="M0 ${height - r * (height - 10)}H240" stroke="#86bcf1" stroke-opacity=".2" stroke-dasharray="3 4"/><text x="-8" y="${height - r * (height - 10) + 3}" text-anchor="end" fill="#b4c6d9" font-size="9">${maximum * r}</text>`).join('')}
    <path d="${path} L240 ${height} L0 ${height}Z" fill="url(#${id})"/>
    <path d="${path}" fill="none" stroke="#43e7ff" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    <path d="${facePath}" fill="none" stroke="#25e8ad" stroke-width="1.2" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
    ${[0, 5, 11, 17, 23].map(i => `<text x="${i / 23 * width}" y="${height + 17}" text-anchor="${i === 0 ? 'start' : i === 23 ? 'end' : 'middle'}" fill="#6f9ec4" font-size="7">${String(hourly[i]?.hour ?? 0).padStart(2, '0')}:00</text>`).join('')}</g></svg>`;
}

export async function renderOverview(content, { dashboard, api, notify, detail, epochCurrent }) {
  const [cameras, fences, compute] = await Promise.all(['cameras', 'fences', 'compute'].map(key => api(`/api/resources/${key}?pageSize=200`)));
  if (!epochCurrent()) return null;
  const counts = dashboard.counts;
  const composition = ['face', 'body', 'bicycle', 'tricycle', 'vehicle'].map(type => ({
    type, total: dashboard.composition.find(item => item.type === type)?.total || 0,
  }));
  const peak = Math.max(0, ...dashboard.targetHourly.map(item => item.total));
  const faceTotal = composition.find(item => item.type === 'face').total;
  const timestamp = new Date(dashboard.updatedAt).toLocaleDateString('zh-CN').replaceAll('/', '-');
  const pending = dashboard.recentAlerts.filter(item => item.status === 'pending');
  const recentAlerts = pending.length ? pending : dashboard.recentAlerts;
  content.classList.add('overview-screen');
  content.innerHTML = `<div class="overview-scene">
    <div id="main-map" class="ov-map"></div>
    <aside class="ov-left" aria-label="左侧态势指标">
      <section class="ov-panel ov-hero"><div class="ov-kpi-caption">◉ 今日结构化目标</div><div class="ov-kpi-number">${number(dashboard.todayTargets)}<small>条</small></div><div class="ov-kpi-foot"><span>本地抓拍记录 · 按日统计</span><b>${timestamp}</b></div></section>
      <div class="ov-kpi-pair"><section class="ov-panel"><span><i></i>人脸大图</span><b>${number(faceTotal)}<small>条</small></b><p>本地人脸记录</p></section><section class="ov-panel"><span><i></i>全结构化</span><b>${number(counts.captures)}<small>条</small></b><p>覆盖 ${composition.filter(item => item.total).length} 类目标</p></section></div>
      <section class="ov-panel ov-trend">${heading('24 小时目标趋势', 'TARGET TREND', '<span class="ov-live">本地</span>')}<div class="ov-trend-value"><div class="ov-chart-key"><span><i></i>全部抓拍</span><span><i></i>人脸记录</span></div><div><b>${number(peak)}</b><span>峰值 · 条/小时</span></div></div>${trendChart(dashboard.targetHourly, 'target-trend')}<div class="ov-chart-footer"><span>按小时聚合</span><button data-action="target-trend">逐小时数据</button></div></section>
      <section class="ov-panel ov-composition">${heading('数据构成', 'COMPOSITION', '<span class="ov-tag">本地统计</span>')}<div class="ov-composition-list">${composition.map(item => {
        const percentage = counts.captures ? item.total / counts.captures * 100 : 0;
        return `<div style="--series:${colors[item.type]}"><span><i></i>${statusLabels[item.type]}</span><div class="ov-bar"><i style="width:${percentage}%"></i></div><b>${percentage.toFixed(1)}%</b></div>`;
      }).join('')}</div></section>
    </aside>
    <section class="ov-center-heading"><div><b>宁波全域视频态势 <span class="ov-tag">本地演示</span></b><small>NINGBO FULL-DOMAIN VIDEO SITUATION</small></div><div class="ov-top-metrics">${[
      ['设备在线', dashboard.onlineCameras, '路'], ['解析视频', '—', '路'],
      ['今日目标', dashboard.todayTargets, '条'], ['算力负载', '—', '%'], ['待处置预警', dashboard.pendingAlerts, '起'],
    ].map(([text, value, unit]) => `<div><span>${text}</span><b>${value === '—' ? value : number(value)}<small>${unit}</small></b></div>`).join('')}</div></section>
    <div class="ov-center-bottom">
      <div class="ov-map-legend" aria-label="地图图层分类">${[['cameras', '人脸抓拍', '#43deff'], ['all', '全结构化', '#30edba'], ['vehicle', '车辆卡口', '#ffc356'], ['dome', '智能球机', '#aa79fb'], ['alerts', '预警圈层', '#ff647b']].map(([key, text, color]) => `<button data-ov-layer="${key}" aria-pressed="${key === 'all'}"><i style="background:${color}"></i>${text}</button>`).join('')}</div>
      <div class="ov-bottom-panels"><section class="ov-panel ov-feed">${heading('实时解析流', 'DATA FEED', '<span class="ov-tag">本地记录</span>')}<div class="ov-feed-list">${dashboard.recentCaptures.map(item => `<button data-detail="${item.id}" data-resource="captures"><i></i><span>${escape(item.source)} <small>${escape(statusLabels[item.type] || item.type)} · 合成演示</small></span><time>${clock(item.occurredAt)}</time></button>`).join('') || '<p class="muted">暂无抓拍记录</p>'}</div></section>
      <section class="ov-panel ov-heat">${heading('区域目标热度', '', '<span class="push">TOP 3</span>')}<div class="ov-heat-list">${dashboard.topDistricts.map(item => `<div><span>${escape(item.district)}</span><b>${number(item.total)} 条</b><i style="width:${item.total / Math.max(1, ...dashboard.topDistricts.map(item => item.total)) * 100}%"></i></div>`).join('') || '<p class="muted">暂无区域数据</p>'}</div></section></div>
    </div>
    <aside class="ov-right" aria-label="右侧预警和算力">
      <section class="ov-panel ov-alerts">${heading('实时预警', 'LIVE ALERTS', `<span class="ov-alert-count">${dashboard.pendingAlerts}</span><button data-nav="control">全部 ›</button>`)}<div class="ov-alert-list">${recentAlerts.map(item => `<button class="ov-alert-row ${escape(item.severity)}" data-detail="${item.id}" data-resource="alerts"><div><b>${escape(item.type || item.name)}</b><span class="badge ${escape(item.severity)}">${escape(statusLabels[item.severity])}</span><time>${clock(item.occurredAt)}</time></div><p>${escape(item.note || '本地预警记录；尚未接入实时算法')}</p><small>${escape(item.source)} · ${escape(item.district)}</small></button>`).join('')}</div></section>
      <section class="ov-panel ov-compute">${heading('算力资源', 'COMPUTE', '<span class="ov-tag">未接入</span>')}<div class="ov-compute-summary"><b>—<small>%</small></b><span>整体负载</span><div class="ov-load-segments" aria-label="暂无真实算力负载">${'<i></i>'.repeat(22)}</div></div><div class="ov-compute-grid">${[['已分配', '—'], ['总量', '— TFLOPS'], ['空闲', '—'], ['排队', '—']].map(([text, value]) => `<div><span>${text}</span><b>${value}</b></div>`).join('')}</div><div class="ov-compute-list">${(compute.items.length ? compute.items : [{ name: '视频结构化' }, { name: '人脸大图解析' }, { name: '离线分析' }, { name: '算法训练' }]).slice(0, 4).map((item, i) => `<div style="--series:${Object.values(colors)[i]}"><span><i></i>${escape(item.name)}</span><div class="ov-bar"><i style="width:0%"></i></div><b>${item.count !== undefined ? number(item.count) : '—'}</b></div>`).join('')}</div></section>
      <section class="ov-panel ov-bus">${heading('数据总线', 'DATA BUS', '<span class="ov-live">未接入</span>')}<div class="ov-bus-value"><b>—</b><span>条 / 秒 · 未接入</span></div><div class="ov-bus-waiting"><i></i><span>等待数据总线接入</span></div><div class="ov-bus-foot"><span>本地入库 ${number(counts.captures)}</span><span>队列 —</span><span>在线率 —</span></div></section>
    </aside>
    <button class="ov-collapse left" data-ov-collapse="left" aria-label="收起左侧面板" aria-expanded="true">‹</button>
    <button class="ov-collapse right" data-ov-collapse="right" aria-label="收起右侧面板" aria-expanded="true">›</button>
  </div>`;
  const mapContainer = content.querySelector('#main-map');
  let map;
  let selectedLayer = 'all';
  const allPoints = [
    ...cameras.items.map(item => ({ ...item, mapResource: 'cameras' })),
    ...dashboard.recentAlerts.map(item => ({ ...item, mapResource: 'alerts' })),
  ];
  const mount = () => {
    map?.destroy();
    const records = allPoints.filter(item => selectedLayer === 'all' ||
      (selectedLayer === 'alerts' ? item.mapResource === 'alerts' :
        selectedLayer === 'dome' ? item.type === '球机' :
          selectedLayer === 'vehicle' ? item.type === '车辆布控' : item.mapResource === 'cameras'));
    map = mountMap(mapContainer, records, { notify, compactLabels: true, fences: selectedLayer === 'alerts' || selectedLayer === 'all' ? fences.items : [], onSelect: item => detail(item.mapResource, item.id) });
  };
  content.querySelector('.overview-scene').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.dataset.ovCollapse) {
      const side = button.dataset.ovCollapse;
      const collapsed = content.querySelector('.overview-scene').classList.toggle(`ov-${side}-collapsed`);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}${side === 'left' ? '左' : '右'}侧面板`);
    }
    if (button?.dataset.ovLayer) {
      selectedLayer = button.dataset.ovLayer;
      content.querySelectorAll('[data-ov-layer]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.ovLayer === selectedLayer)));
      mount();
    }
  });
  mount();
  return { destroy() { map?.destroy(); }, get mode() { return map?.mode; } };
}
