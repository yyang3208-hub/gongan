import { mountMap } from '/map.mjs';
import { planMission } from '/shared/imagery-plan.mjs';
import { validatePolygon } from '/shared/spatial.mjs';
import { enhanceInterface, focusFormError } from '/ui.mjs';
import { mountPanoramaPair } from '/panorama.mjs';
import { planPhotoImport, validateUploadBatch } from '/shared/imagery-upload.mjs';

const kindName = value => value === 'panorama' ? '全景' : '正射';
const viewName = value => ({ nadir: '下视 · 选入', oblique: '倾斜 · 排除', unknown: '姿态未知 · 排除' })[value] || '姿态未知 · 排除';
const jobNames = { queued: '排队中', running: '处理中', completed: '已发布', failed: '失败', prepare: '准备', upload: '照片送入引擎', orthomosaic: '正射拼接', download: '接收成果', normalize: '栅格标准化', tiles: '瓦片切片', published: '发布完成' };
const localTime = value => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const boundsFor = polygon => ({ west: Math.min(...polygon.map(p => p[0])), south: Math.min(...polygon.map(p => p[1])), east: Math.max(...polygon.map(p => p[0])), north: Math.max(...polygon.map(p => p[1])) });

export async function renderImageryWorkspace(content, { api, notify, escape, title, formatTime, canWrite, csrfToken, epochCurrent }) {
  let data = await api('/api/imagery');
  if (!epochCurrent()) return null;
  let disposed = false, missionId = '', activeAsset = '', currentPlan, activePanel = 'plan', timer, playing, pano;
  let busy = false, refreshing = false, uploadRequest, importBatch, uploadScope = '';
  const abort = new AbortController();
  const disabled = canWrite ? '' : 'disabled';
  const number = (name, text, value, min, max, step = 1) => `<label>${text}<input name="${name}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required></label>`;
  content.innerHTML = `<section class="imagery-workspace">
    <header class="imagery-header"><div><span class="imagery-eyebrow">M3E · IMAGERY OPERATIONS</span><h2>影像采集</h2><p>圈定范围 → 下载航线 → 人工执行 → 上传处理 → 发布对比</p></div><div class="imagery-header-actions"><span class="badge medium">人工导入模式</span><button type="button" data-imagery="refresh">刷新任务</button></div></header>
    <div class="imagery-pipeline" aria-label="采集流水线"><span><i>01</i>范围与航线<b>本地规划</b></span><span><i>02</i>M3E 采集<b>DJI Pilot 2 人工执行</b></span><span data-capability="processor"><i>03</i>快拼与切片<b></b></span><span><i>04</i>影像持久化<b>本地私有文件存储</b></span><span><i>05</i>时序与卷帘<b>Cesium 多期对比</b></span></div>
    <p class="imagery-global-status" role="status"></p><p class="imagery-global-error form-error" role="alert" tabindex="-1"></p>
    <nav class="imagery-tabs" aria-label="影像工作区"><button data-imagery-tab="plan" aria-pressed="true">采集规划</button><button data-imagery-tab="import" aria-pressed="false">照片导入</button><button data-imagery-tab="assets" aria-pressed="false">成果发布</button><button data-imagery-tab="compare" aria-pressed="false">多期对比</button><button data-imagery-tab="jobs" aria-pressed="false">处理队列</button></nav>
    <div class="imagery-grid">
      <aside class="panel imagery-editor">
        <section data-imagery-panel="import" hidden>${title('U 盘 / 历史航拍导入', 'USB PHOTO IMPORT')}
          <form id="imagery-import-form"><label>导入任务名称<input name="name" maxlength="100" required placeholder="例如：奥体中心 · 历史航拍" ${disabled}></label>
          <label>实际拍摄时间<input name="capturedAt" type="datetime-local" required ${disabled}></label>
          <label>选择照片根文件夹（包含所有子目录）<input id="imagery-import-folder" type="file" webkitdirectory multiple required ${disabled}></label>
          <p class="imagery-import-selection muted" role="status">一次选择根目录，按一级航次子目录自动拆分任务，递归上传每个航次下面的全部 JPEG。原始文件不会修改。</p><p class="imagery-import-progress muted" role="status"></p>
          <p class="muted">上传 JPEG 后读取 DJI XMP 云台俯仰角，仅选 −90°±2°下视照片；倾斜及姿态未知照片保留但不参与快速 DOM。不同子目录的同名照片按相对路径区分。</p>
          <button type="submit" class="primary" ${disabled}>按航次创建任务并上传全部照片</button></form>
          <div class="inline-notice">历史照片无需先画范围或伪造航线。保留 EXIF/GPS，勿混合不同航次；下视数量不代表定位、重叠率或成图精度合格。快速 DOM 不承诺真正射 TDOM 或消除所有遮挡。</div>
        </section>
        <section data-imagery-panel="plan">${title('采集范围与参数', 'SURVEY PLANNER')}
          <form id="imagery-plan-form"><label>采集任务名称<input name="name" maxlength="100" required placeholder="例如：河道巡查 · 第一期" ${disabled}></label><label>采集类型<select name="kind" ${disabled}><option value="ortho">正射网格 · M3E 可见光</option><option value="panorama">航拍全景 · 25 张组图</option></select></label><label>计划拍摄时间<input name="capturedAt" type="datetime-local" value="${localTime(new Date())}" required ${disabled}></label>
          <div class="imagery-button-row"><button type="button" data-imagery="draw" ${disabled}>地图选点</button><button type="button" data-imagery="finish" ${disabled}>完成选点</button><button type="button" data-imagery="undo" ${disabled}>撤销一点</button><button type="button" data-imagery="clear" ${disabled}>清除范围</button></div>
          <p class="imagery-draw-status" role="status">连续点击地图，双击闭合；Enter 完成，Backspace 撤销，Esc 取消。支持凸多边形，凹区域请拆分任务。</p><label>采集范围 WGS84 顶点<textarea name="polygon" rows="3" maxlength="8000" required placeholder="[[121.51,29.95],[121.512,29.95],[121.512,29.952],[121.51,29.952]]" ${disabled}></textarea></label>
          <div class="imagery-fields">${number('altitude', '相对起飞点航高 (m)', 80, 20, 120)}${number('speed', '航速 (m/s)', 5, 1, 12, .5)}${number('frontOverlap', '航向重叠率 (%)', 80, 60, 90)}${number('sideOverlap', '旁向重叠率 (%)', 70, 50, 90)}${number('heading', '航线方向 (°)', 0, 0, 359)}</div>
          <div class="imagery-button-row"><button type="button" data-imagery="preview" ${disabled}>预览估算</button><button class="primary" type="submit" ${disabled}>生成并保存航线</button></div></form>
          <div class="imagery-plan-metrics"></div><div class="inline-notice imagery-flight-notice">仅生成规划，不控制飞行。航高不是离地高度；未检测地形、障碍物、空域及返航余量。导入后须在 DJI Pilot 2 检查机型、航高、动作与航线，通过实机小范围验证后再作业。</div>
        </section>
        <section data-imagery-panel="assets" hidden>${title('登记已有成果', 'ASSET PUBLISH')}
          <form id="imagery-asset-form"><label>成果名称<input name="name" maxlength="100" required ${disabled}></label><label>成果类型<select name="kind" ${disabled}><option value="ortho">正射瓦片</option><option value="panorama">已拼接全景</option></select></label><label>实际拍摄时间<input name="capturedAt" type="datetime-local" value="${localTime(new Date())}" required ${disabled}></label><label>授权成果地址<input name="url" required maxlength="2000" placeholder="https://.../{z}/{x}/{y}.png" ${disabled}></label>
          <fieldset data-asset-fields="ortho"><legend>正射范围与瓦片</legend><div class="imagery-fields">${number('west', '西界经度', 121.51, -180, 180, 'any')}${number('south', '南界纬度', 29.95, -85, 85, 'any')}${number('east', '东界经度', 121.52, -180, 180, 'any')}${number('north', '北界纬度', 29.96, -85, 85, 'any')}${number('minimumLevel', '最小层级', 0, 0, 22)}${number('maximumLevel', '最大层级', 21, 0, 22)}</div><label>瓦片类型<select name="tileScheme"><option value="xyz">XYZ · Y 从北向南</option><option value="tms">TMS · Y 从南向北</option></select></label></fieldset>
          <fieldset data-asset-fields="panorama" hidden disabled><legend>全景位置与方向</legend><div class="imagery-fields">${number('longitude', '全景经度', 121.51, -180, 180, 'any')}${number('latitude', '全景纬度', 29.95, -90, 90, 'any')}${number('altitude', '全景海拔 (m)', 80, 0, 10000, 'any')}${number('heading', '图像中心方位 (°)', 0, 0, 359, 'any')}</div></fieldset><p class="muted">正射需 Web 墨卡托瓦片；全景需 2:1 等距柱状 JPEG。外部服务器须允许当前平台 CORS 访问。登记地址不会冒充照片已完成拼接。</p><button class="primary" type="submit" ${disabled}>登记成果</button></form>
        </section>
        <section data-imagery-panel="compare" hidden>${title('多时相影像', 'TEMPORAL COMPARE')}
          <label>对比类型<select id="imagery-compare-kind"><option value="ortho">正射 · 卷帘 / 时序</option><option value="panorama">全景 · 同视角联动</option></select></label><label>前期成果<select id="imagery-past"></select></label><label>后期成果<select id="imagery-current"></select></label>
          <div class="imagery-button-row"><button data-imagery="compare" type="button" class="primary">加载对比</button><button data-imagery="single" type="button">仅看后期</button><button data-imagery="remove-layers" type="button">卸载成果</button></div><label class="imagery-split-label">卷帘位置<input id="imagery-split" type="range" min="0" max="100" value="50"></label>
          <label>历史时间轴<input id="imagery-timeline" type="range" min="0" max="0" value="0" disabled></label><div class="imagery-button-row"><button data-imagery="play" type="button" aria-pressed="false">播放时序</button><button data-imagery="pause" type="button">暂停</button></div><p class="imagery-time-readout" role="status">请先登记或处理发布影像。</p><p class="muted">按实际拍摄时间排序。全景按北向方位联动；请选同一位置、方位已校准的两期成果。正射跨期未重叠区域仍显示底图，不代表无变化。</p>
        </section>
        <section data-imagery-panel="jobs" hidden>${title('处理服务与流程', 'PROCESSING SERVICES')}<div class="imagery-capabilities"></div><p class="muted">先上传 M3E 原始 JPEG（保留 EXIF/GPS），再提交快拼。只有处理引擎返回正射并完成切片后才会发布。低精度快拼不等于测绘级成果。</p><p class="muted">当前本地持久化；未接入 MinIO/S3。速度受照片数量、算力、定位和网络影响，不保证固定分钟数。全景组图需外部拼接后上传。</p><button data-nav="admin/dji" type="button">FlightHub 2 接入状态</button></section>
      </aside>
      <section class="imagery-map-column"><div class="imagery-map-head"><b>采集作业区 <small>WGS84 / CESIUM</small></b><span class="imagery-map-caption">规划预览 · 不执行飞行</span></div><div class="imagery-map-stage"><div id="main-map"></div><div class="imagery-split-marker" hidden aria-hidden="true"><span>前期 ⇄ 后期</span></div></div><div class="imagery-map-legend"><span><i></i>青色：采集范围</span><span><i></i>金色：拍照航点连线（地面示意）</span><span>全景热点按成果时间定位</span></div><section class="imagery-panorama-panel panel" hidden></section><section class="panel imagery-job-section">${title('处理队列', 'PIPELINE JOBS')}<div class="imagery-jobs"></div></section></section>
      <aside class="imagery-library"><section class="panel">${title('采集任务', 'COLLECTION MISSIONS')}<div class="imagery-missions"></div></section><section class="panel imagery-mission-detail"></section><section class="panel">${title('影像资产', 'TEMPORAL ASSETS')}<div class="imagery-assets"></div></section></aside>
    </div>
  </section>`;
  const workspace = content.querySelector('.imagery-workspace'), planForm = content.querySelector('#imagery-plan-form'), assetForm = content.querySelector('#imagery-asset-form'), importForm = content.querySelector('#imagery-import-form');
  if (!canWrite) for (const element of content.querySelectorAll('form input,form select,form textarea,form button')) element.disabled = true;
  const field = name => planForm.elements.namedItem(name);
  const status = content.querySelector('.imagery-global-status'), errorNode = content.querySelector('.imagery-global-error');
  const mapContainer = content.querySelector('#main-map');
  const marker = content.querySelector('.imagery-split-marker');
  function showError(error) { if (!disposed) { errorNode.textContent = error.message || String(error); focusFormError(errorNode); } }
  function clearError() { errorNode.textContent = ''; }
  const map = mountMap(mapContainer, [], {
    notify, compactLabels: true,
    onPolygon(points) {
      field('polygon').value = JSON.stringify(points); currentPlan = undefined; map.setRoute([]);
      content.querySelector('.imagery-draw-status').textContent = `已完成 ${points.length} 点范围，请预览或生成航线。`;
      mapContainer.focus({ preventScroll: true });
    },
    onSelectionProgress(count) {
      field('polygon').value = ''; currentPlan = undefined; map.setRoute([]);
      content.querySelector('.imagery-draw-status').textContent = `已选 ${count} 个顶点，至少 3 点；双击闭合。`;
    },
    onSelect(asset) {
      if (asset.kind === 'panorama') { setPanel('compare'); content.querySelector('#imagery-compare-kind').value = 'panorama'; paintCompareOptions(); content.querySelector('#imagery-current').value = asset.id; loadComparison(true); }
    },
  });
  function setPanel(value) {
    activePanel = value;
    for (const button of content.querySelectorAll('[data-imagery-tab]')) button.setAttribute('aria-pressed', String(button.dataset.imageryTab === value));
    for (const section of content.querySelectorAll('[data-imagery-panel]')) section.hidden = section.dataset.imageryPanel !== value;
  }
  function planParameters() {
    let polygon;
    try { polygon = JSON.parse(field('polygon').value); } catch { throw new Error('请先在地图选点，或输入有效的 JSON 顶点数组'); }
    const value = { name: field('name').value, kind: field('kind').value, capturedAt: field('capturedAt').value ? new Date(field('capturedAt').value).toISOString() : '', polygon };
    for (const key of ['altitude', 'speed', 'frontOverlap', 'sideOverlap', 'heading']) value[key] = Number(field(key).value);
    return value;
  }
  function showPlan(mission) {
    currentPlan = mission;
    map.setSelectionMode(false); map.setPolygon(mission.polygon); map.setRoute(mission.plan.waypoints);
    content.querySelector('.imagery-plan-metrics').innerHTML = `<dl>${[
      ['覆盖面积', `${(mission.plan.areaM2 / 10000).toFixed(2)} ha`], ['照片估算', `${mission.plan.photoCount} 张`],
      ['路线长度', `${(mission.plan.distanceM / 1000).toFixed(2)} km`], ['估计作业', `${Math.ceil(mission.plan.durationSeconds / 60)} min`],
      ['GSD 估算', `${mission.plan.gsdCm.toFixed(2)} cm/px`], ['航线间距', `${mission.plan.lineSpacingM.toFixed(1)} m`],
    ].map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl><p>${(mission.plan.warnings || []).map(escape).join('<br>')}</p>`;
  }
  function missionDetail() {
    const host = content.querySelector('.imagery-mission-detail'), mission = data.missions.find(item => item.id === missionId);
    if (!mission) { host.innerHTML = '<div class="imagery-empty">选择任务后下载航线、上传照片和处理成果。</div>'; return; }
    host.innerHTML = `${title('任务作业', 'MISSION WORKBENCH')}<div class="imagery-detail-body"><b>${escape(mission.name)}</b><p>${formatTime(mission.capturedAt)} · 已上传 ${mission.photoCount} 张原始照片</p>
      ${mission.plan ? `<p class="muted">M3E / 相对起飞点 ${mission.altitude} m / ${mission.plan.photoCount} 个拍照航点</p>
      <label class="imagery-ack"><input type="checkbox" id="imagery-route-ack">我已知悉：航线未经实机验证，导入后须在 DJI Pilot 2 完成飞前检查。</label>
      <div class="imagery-button-row"><button type="button" data-imagery="download" ${disabled}>下载 M3E KMZ</button><button type="button" disabled title="真实 FlightHub 2 下发尚未接通">发送至机场 · 未接通</button></div>` : '<p class="muted">历史照片导入 · 无预设飞行航线，范围以实际正射成果为准。</p>'}
      <p class="imagery-photo-summary" role="status">快速 DOM：下视 ${mission.selection?.selected || 0} 张 · 倾斜 ${mission.selection?.oblique || 0} 张 · 姿态未知 ${mission.selection?.unknown || 0} 张。仅下视参与处理（−90°±2°）。</p>
      <label>实际拍摄时间（发布前核对）<input type="datetime-local" id="imagery-actual-time" value="${mission.source === 'import' ? escape(localTime(new Date(mission.capturedAt))) : ''}" required ${disabled}></label><label>上传原始航测照片（JPEG，多选）<input type="file" id="imagery-photo-upload" accept="image/jpeg" multiple ${disabled}></label>
      <label>追加 U 盘航次文件夹<input type="file" id="imagery-folder-upload" webkitdirectory multiple ${disabled}></label>
      <div class="imagery-button-row"><button type="button" data-imagery="photos" ${disabled}>上传所选照片</button><button type="button" data-imagery="folder" ${disabled}>上传文件夹</button><button type="button" data-imagery="process" ${disabled}>提交正射处理</button></div>
      <label>已有处理成果<input type="file" id="imagery-result-upload" accept=".tif,.tiff,image/jpeg" ${disabled}></label><div class="imagery-button-row"><button type="button" data-imagery="orthophoto" ${disabled}>GeoTIFF 切片发布</button><button type="button" data-imagery="panorama" ${disabled}>发布已拼接全景</button></div>
      <p class="muted">每文件 ≤100 MB，每任务 ≤10 GB / 5000 文件。全景 JPEG 必须是 2:1 等距柱状图；位置、方向暂取任务规划值，并非照片 EXIF 实测海拔，可另行登记校准成果。</p><div class="imagery-button-row"><button type="button" data-imagery="list-photos">查看上传文件</button><button type="button" data-imagery="export-photos">导出完整筛选清单</button></div><div class="imagery-upload-files"></div></div>`;
  }
  function compareAssets() {
    const kind = content.querySelector('#imagery-compare-kind').value;
    return data.assets.filter(item => item.kind === kind).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  }
  function paintCompareOptions() {
    const assets = compareAssets();
    for (const [index, selector] of ['#imagery-past', '#imagery-current'].entries()) {
      const select = content.querySelector(selector), old = select.value;
      select.innerHTML = assets.length ? assets.map(item => `<option value="${item.id}">${escape(item.name)} · ${formatTime(item.capturedAt)}</option>`).join('') : '<option value="">暂无已发布成果</option>';
      select.value = assets.some(item => item.id === old) ? old : assets[index === 0 ? 0 : assets.length - 1]?.id || '';
    }
    const timeline = content.querySelector('#imagery-timeline');
    timeline.max = Math.max(0, assets.length - 1); timeline.disabled = !assets.length;
    timeline.value = Math.min(Number(timeline.value), assets.length - 1);
    content.querySelector('.imagery-split-label').hidden = content.querySelector('#imagery-compare-kind').value !== 'ortho';
  }
  function paint() {
    const caps = data.capabilities;
    content.querySelector('[data-capability="processor"] b').textContent = caps.nodeodm && caps.gdal ? '已配置 · 作业时验证连通' : '服务待配置';
    content.querySelector('.imagery-capabilities').innerHTML = `<dl>${[['NodeODM', caps.nodeodm], ['GDAL', caps.gdal], ['FlightHub 2 自动下发', caps.dispatch], ['全景组图拼接', caps.panoramaStitch]].map(([name, ready]) => `<div><dt>${name}</dt><dd class="${ready ? 'imagery-ready' : ''}">${ready ? '已配置' : '未接通'}</dd></div>`).join('')}</dl><p>${escape(caps.message)}</p>`;
    content.querySelector('.imagery-missions').innerHTML = data.missions.length ? data.missions.map(item => `<button type="button" class="imagery-list-item ${item.id === missionId ? 'active' : ''}" data-imagery-mission="${item.id}"><span class="imagery-kind">${kindName(item.kind)}</span><b>${escape(item.name)}</b><small>${formatTime(item.capturedAt)} · ${item.photoCount} 张已上传</small></button>`).join('') : '<div class="imagery-empty">尚无采集任务<br>在地图圈选范围并保存航线。</div>';
    content.querySelector('.imagery-assets').innerHTML = data.assets.length ? data.assets.map(item => `<button type="button" class="imagery-list-item ${item.id === activeAsset ? 'active' : ''}" data-imagery-asset="${item.id}"><span class="imagery-kind">${kindName(item.kind)}</span><b>${escape(item.name)}</b><small>${formatTime(item.capturedAt)} · ${item.storageJobId ? '本平台已处理发布' : '已有成果'}</small></button>`).join('') : '<div class="imagery-empty">暂无成果<br>上传处理或登记已授权成果后发布。</div>';
    content.querySelector('.imagery-jobs').innerHTML = data.jobs.length ? data.jobs.map(job => `<article class="imagery-job ${job.status === 'failed' ? 'imagery-job-failed' : ''}"><header><b>${escape(job.name)}</b><span>${jobNames[job.status] || escape(job.status)}</span></header><p>${jobNames[job.stage] || escape(job.stage)} · ${formatTime(job.updatedAt || job.createdAt)}</p>${job.selection ? `<p>快速 DOM · 已选下视 ${job.selection.selected}/${job.selection.total} 张，排除倾斜 ${job.selection.oblique}、未知 ${job.selection.unknown} 张</p>` : ''}<progress max="100" value="${Math.max(0, Math.min(100, job.progress || 0))}" aria-label="${escape(job.name)}处理进度"></progress>${job.error ? `<p role="alert">${escape(job.error)}</p>` : ''}</article>`).join('') : '<div class="imagery-empty">尚无真实处理作业。提交后显示实际阶段与失败原因，不显示模拟进度。</div>';
    paintCompareOptions();
    map.setPoints(data.assets.filter(item => item.kind === 'panorama'));
    enhanceInterface(workspace);
  }
  async function refresh() {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      const snapshot = await api('/api/imagery', { signal: abort.signal });
      if (disposed) return;
      data = snapshot; paint();
    } finally { refreshing = false; }
  }
  function stopPlayback() {
    clearInterval(playing); playing = undefined;
    content.querySelector('[data-imagery="play"]').setAttribute('aria-pressed', 'false');
  }
  function clearPano() { pano?.destroy(); pano = undefined; content.querySelector('.imagery-panorama-panel').hidden = true; }
  function showPano(assets) {
    clearPano(); const host = content.querySelector('.imagery-panorama-panel');
    host.hidden = false;
    host.innerHTML = `${title('全景同视角对比', 'SYNCHRONIZED PANORAMA')}<div class="imagery-panorama-controls"><button type="button" data-pano-reset>复位视角</button><span data-pano-readout role="status"></span></div><div class="imagery-panorama-pair">${assets.map(item => `<section><b>${escape(item.name)}</b><time>${formatTime(item.capturedAt)}</time><canvas tabindex="0" aria-label="${escape(item.name)}全景，拖动或方向键调整，滚轮或加减键缩放"></canvas></section>`).join('')}</div><p class="muted">左右视角同步；拖动旋转，滚轮或 +/- 缩放，方向键可操作。图像中心方向以登记的方位角校准。</p>`;
    pano = mountPanoramaPair(host, assets, { onError: message => showError(new Error(message)) });
  }
  function loadComparison(single = false) {
    stopPlayback(); clearPano();
    const left = data.assets.find(item => item.id === content.querySelector('#imagery-past').value);
    const right = data.assets.find(item => item.id === content.querySelector('#imagery-current').value);
    if (!right || (!single && !left)) throw new Error('请先选择已发布成果');
    if (!single && left.id === right.id) throw new Error('请选择两期不同成果；单期可使用“仅看后期”');
    activeAsset = right.id;
    if (right.kind === 'panorama') {
      map.setComparison(null); marker.hidden = true;
      showPano(single ? [right] : [left, right]); map.locate(right);
    } else {
      map.setComparison({ left: single ? right : left, right: single ? null : right, split: Number(content.querySelector('#imagery-split').value) / 100 });
      marker.hidden = single;
      map.fitBounds(right.bounds);
    }
    content.querySelector('.imagery-time-readout').textContent = single ? `显示：${right.name} · ${formatTime(right.capturedAt)}` : `前期 ${formatTime(left.capturedAt)} ⇄ 后期 ${formatTime(right.capturedAt)}`;
  }
  function timelineFrame(index) {
    const assets = compareAssets(), asset = assets[index];
    if (!asset) throw new Error('暂无可播放成果');
    clearPano(); marker.hidden = true; activeAsset = asset.id;
    if (asset.kind === 'ortho') map.setComparison({ left: asset });
    else { map.setComparison(null); showPano([asset]); }
    content.querySelector('#imagery-current').value = asset.id;
    content.querySelector('#imagery-timeline').value = index;
    content.querySelector('.imagery-time-readout').textContent = `${index + 1} / ${assets.length} · ${asset.name} · ${formatTime(asset.capturedAt)}`;
  }
  async function download() {
    if (!content.querySelector('#imagery-route-ack')?.checked) throw new Error('请先勾选飞前核验提示');
    const response = await fetch(`/api/imagery/missions/${missionId}/route.kmz`, { credentials: 'same-origin', signal: abort.signal });
    if (!response.ok) throw new Error((await response.json()).error || '航线下载失败');
    const blob = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = blob; link.download = `M3E-${missionId}.kmz`; link.click(); setTimeout(() => URL.revokeObjectURL(blob), 1000);
    status.textContent = 'KMZ 已下载。请传至遥控器，在 DJI Pilot 2 中导入并完成飞前核验，平台未执行飞行。';
  }
  function uploadFile(file, type, index, total) {
    return new Promise((resolveUpload, reject) => {
      if (!file || file.size > 100 * 1024 * 1024) { reject(new Error('请选择不超过 100 MB 的文件')); return; }
      const xhr = new XMLHttpRequest();
      uploadRequest = xhr;
      const time = type === 'photos' ? '' : `&capturedAt=${encodeURIComponent(actualTime())}`;
      xhr.open('POST', `/api/imagery/missions/${missionId}/${type}?filename=${encodeURIComponent(file.webkitRelativePath || file.name)}${time}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.timeout = 300000;
      xhr.upload.onprogress = event => { if (!disposed) status.textContent = `${uploadScope}上传 ${index}/${total}：${file.name} ${event.lengthComputable ? `${Math.round(event.loaded / event.total * 100)}%` : ''}（已完成文件不会重复上传）`; };
      xhr.onload = () => {
        uploadRequest = undefined;
        let result; try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('上传接口返回格式无效')); return; }
        if (xhr.status < 200 || xhr.status >= 300) reject(new Error(result.error || `上传失败 (${xhr.status})`)); else resolveUpload(result);
      };
      xhr.onerror = () => { uploadRequest = undefined; reject(new Error('文件上传网络失败，已完成文件保留，请核对文件列表后重试')); };
      xhr.ontimeout = () => { uploadRequest = undefined; reject(new Error('文件上传超时，请核对已上传文件后重试')); };
      xhr.onabort = () => { uploadRequest = undefined; reject(new DOMException('上传已取消', 'AbortError')); };
      xhr.send(file);
    });
  }
  async function files(type, provided, resume = false) {
    if (!missionId) throw new Error('请先选择一个采集任务');
    const input = content.querySelector(type === 'folder' ? '#imagery-folder-upload' : type === 'photos' ? '#imagery-photo-upload' : '#imagery-result-upload');
    const all = [...(provided || input?.files || [])], raw = type === 'folder' || type === 'photos';
    const list = raw ? all.filter(file => /\.jpe?g$/i.test(file.name)) : all;
    const ignored = all.length - list.length, actual = content.querySelector('#imagery-actual-time')?.value || '';
    validateUploadBatch(list, data.capabilities);
    let completed = 0, reused = 0;
    try {
      const existing = resume ? new Map((await api(`/api/imagery/missions/${missionId}/photos`, { signal: abort.signal })).items.map(item => [item.name, item])) : new Map();
      for (const file of list) {
        const old = existing.get(file.webkitRelativePath || file.name);
        if (old) {
          if (old.size !== file.size || !old.sha256) throw new Error(`已有同名文件不能安全续传：${file.name}，请核对后新建任务`);
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
          if ([...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') !== old.sha256) throw new Error(`同名照片内容已改变：${file.name}，未覆盖原文件`);
          completed++; reused++; continue;
        }
        await uploadFile(file, raw ? 'photos' : type, completed + 1, list.length); completed++;
        if (disposed) return;
      }
      input.value = '';
      status.textContent = raw ? `已上传 ${completed} 张 JPEG（其中 ${reused} 张经 SHA-256 核对复用），忽略 ${ignored} 个非 JPEG 文件；请核对下视筛选清单后提交处理。` : '成果已接收，正射切片请查看队列；已拼接全景可在资产列表查看。';
    } catch (error) {
      error.message = `${error.message}；本次已完成 ${completed}/${list.length} 个文件，请勿重复上传已完成文件。`; throw error;
    } finally { if (!disposed) { await refresh(); missionDetail(); if (actual) content.querySelector('#imagery-actual-time').value = actual; } }
  }
  function actualTime() {
    const value = content.querySelector('#imagery-actual-time')?.value;
    if (!value) throw new Error('请填写实际拍摄时间，平台不会使用计划时间冒充真实拍摄时间');
    return new Date(value).toISOString();
  }
  async function onSubmit(event) {
    if (![planForm, assetForm, importForm].includes(event.target)) return;
    event.preventDefault(); if (busy) return; clearError(); busy = true;
    try {
      if (!canWrite) throw new Error('观察员仅可查看');
      if (event.target === importForm) {
        const selected = [...content.querySelector('#imagery-import-folder').files];
        const plan = planPhotoImport(selected, { ...data.capabilities, maxGroups: data.limits.missions });
        const entries = Object.fromEntries(new FormData(importForm));
        const capturedAt = new Date(entries.capturedAt).toISOString();
        if (!importBatch || importBatch.name !== entries.name || importBatch.capturedAt !== capturedAt ||
          selected.length !== importBatch.files.length || selected.some((file, index) => file !== importBatch.files[index]))
          importBatch = { name: entries.name, capturedAt, files: selected, groups: plan.groups.map(group => ({ ...group, missionId: '', completed: false })) };
        for (const element of importForm.elements) element.disabled = true;
        map.setRoute([]); map.clearSelection();
        content.querySelector('.imagery-map-caption').textContent = '历史照片 · 无预设航线';
        for (const [index, group] of importBatch.groups.entries()) {
          if (group.completed) continue;
          uploadScope = `航次 ${index + 1}/${plan.groups.length} · ${group.label}：`;
          content.querySelector('.imagery-import-progress').textContent = `${uploadScope}${group.files.length} 张 / ${(group.bytes / 1024 ** 3).toFixed(2)} GB`;
          if (!group.missionId) {
            const name = plan.groups.length === 1 ? entries.name : `${entries.name.slice(0, 45)} · ${index + 1}/${plan.groups.length} · ${group.label.slice(0, 40)}`;
            const mission = await api('/api/imagery/imports', { method: 'POST', body: { name, capturedAt }, signal: abort.signal });
            if (disposed) return;
            group.missionId = mission.id;
          }
          missionId = group.missionId; await refresh(); missionDetail(); await files('folder', group.files, true);
          if (disposed) return;
          group.completed = true;
        }
        status.textContent = `本批次 ${plan.groups.length} 个航次、${plan.total} 张 JPEG 全部上传完成，忽略 ${plan.ignored} 个非 JPEG 文件。原文件未修改；各航次独立筛选下视并处理。`;
        content.querySelector('.imagery-import-progress').textContent = `已完成 ${plan.groups.length}/${plan.groups.length} 个航次；在右侧选择任务查看筛选清单。`;
        importBatch = undefined; importForm.reset(); content.querySelector('.imagery-import-selection').textContent = '本批次上传完成；可继续选择其他根目录。';
      } else if (event.target === planForm) {
        const parameters = planParameters(), mission = await api('/api/imagery/missions', { method: 'POST', body: parameters, signal: abort.signal });
        if (disposed) return;
        missionId = mission.id; showPlan(mission); await refresh(); missionDetail();
        status.textContent = '采集规划已持久保存，请下载航线并在 DJI Pilot 2 核验后人工执行。';
      } else {
        const entries = Object.fromEntries(new FormData(assetForm));
        const body = { name: entries.name, kind: entries.kind, capturedAt: new Date(entries.capturedAt).toISOString(), url: entries.url };
        if (body.kind === 'ortho') {
          body.bounds = Object.fromEntries(['west', 'south', 'east', 'north'].map(key => [key, Number(entries[key])]));
          Object.assign(body, { minimumLevel: Number(entries.minimumLevel), maximumLevel: Number(entries.maximumLevel), tileScheme: entries.tileScheme });
        } else for (const key of ['longitude', 'latitude', 'altitude', 'heading']) body[key] = Number(entries[key]);
        const asset = await api('/api/imagery/assets', { method: 'POST', body, signal: abort.signal });
        if (disposed) return;
        activeAsset = asset.id; await refresh(); status.textContent = '授权成果地址已登记；加载时将验证实际图像服务，失败会明确提示。';
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (event.target === importForm && importBatch) error.message += `；本批次已完成 ${importBatch.groups.filter(group => group.completed).length}/${importBatch.groups.length} 个航次。保留当前目录和表单，再次提交可安全续传；刷新或重新选目录会开启新批次。`;
        showError(error);
      }
    }
    finally {
      if (event.target === importForm) for (const element of importForm.elements) element.disabled = !canWrite;
      uploadScope = ''; busy = false;
    }
  }
  async function onClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.imageryTab) { clearError(); setPanel(button.dataset.imageryTab); return; }
    if (busy && (button.dataset.imagery || button.dataset.imageryMission)) { status.textContent = '当前操作尚未完成，请稍候。'; return; }
    clearError();
    try {
      if (button.dataset.imageryMission) {
        missionId = button.dataset.imageryMission;
        const mission = data.missions.find(item => item.id === missionId);
        content.querySelector('.imagery-map-caption').textContent = mission.plan ? '规划预览 · 不执行飞行' : '历史照片 · 无预设航线';
        if (!mission.plan) { setPanel('import'); map.setRoute([]); map.clearSelection(); paint(); missionDetail(); return; }
        for (const key of ['name', 'kind', 'altitude', 'speed', 'frontOverlap', 'sideOverlap', 'heading']) field(key).value = mission[key];
        field('capturedAt').value = localTime(new Date(mission.capturedAt)); field('polygon').value = JSON.stringify(mission.polygon);
        setPanel('plan'); showPlan(mission); map.fitBounds(boundsFor(mission.polygon)); paint(); missionDetail(); return;
      }
      if (button.dataset.imageryAsset) {
        const asset = data.assets.find(item => item.id === button.dataset.imageryAsset);
        setPanel('compare'); content.querySelector('#imagery-compare-kind').value = asset.kind; paintCompareOptions();
        content.querySelector('#imagery-current').value = asset.id; loadComparison(true); return;
      }
      switch (button.dataset.imagery) {
        case 'draw': setPanel('plan'); map.setSelectionMode(true, 'polygon'); mapContainer.focus(); break;
        case 'finish': map.finishPolygon(); break;
        case 'undo': map.undoPolygonPoint(); mapContainer.focus(); break;
        case 'clear': field('polygon').value = ''; currentPlan = undefined; map.setSelectionMode(false); map.clearSelection(); map.setRoute([]); content.querySelector('.imagery-plan-metrics').innerHTML = ''; break;
        case 'preview': {
          if (!planForm.reportValidity()) return;
          const mission = planMission(planParameters()); showPlan(mission); map.fitBounds(boundsFor(mission.polygon));
          status.textContent = '仅为本地预览，尚未保存。'; break;
        }
        case 'refresh': await refresh(); status.textContent = '任务、成果与处理状态已刷新。'; break;
        case 'download': busy = true; await download(); break;
        case 'photos': case 'folder': case 'orthophoto': case 'panorama': busy = true; await files(button.dataset.imagery); break;
        case 'process':
          busy = true;
          await api(`/api/imagery/missions/${missionId}/process`, { method: 'POST', body: { capturedAt: actualTime() }, signal: abort.signal });
          await refresh(); setPanel('jobs'); status.textContent = '已提交处理队列，只有实际处理完成后才会发布。'; break;
        case 'export-photos': case 'list-photos': {
          const photos = await api(`/api/imagery/missions/${missionId}/photos`, { signal: abort.signal });
          if (disposed) return;
          if (button.dataset.imagery === 'export-photos') {
            const url = URL.createObjectURL(new Blob([JSON.stringify(photos, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = `photo-selection-${missionId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            status.textContent = '完整照片姿态与筛选清单已导出；未知姿态不会自动选入。'; break;
          }
          if (!disposed) content.querySelector('.imagery-upload-files').innerHTML = photos.items.length ? `<p>共 ${photos.items.length} 个文件，展示前 100 个；下视 ${photos.selection.selected}、倾斜 ${photos.selection.oblique}、未知 ${photos.selection.unknown} 张。</p><ul>${photos.items.slice(0, 100).map(item => `<li><b>${escape(item.name)}</b> · ${(item.size / 1048576).toFixed(2)} MB${item.type === 'photos' ? `<br>${viewName(item.viewClass)}${Number.isFinite(item.gimbalPitch) ? ` / ${item.gimbalPitch}°` : ''}<small>${escape(item.attitudeReason || '旧文件未读取姿态信息，请核对原文件')}</small>${item.jpegWarning ? `<small>${escape(item.jpegWarning)}</small>` : ''}` : ''}</li>`).join('')}</ul>` : '<p>尚未上传文件。</p>';
          break;
        }
        case 'compare': loadComparison(); break;
        case 'single': loadComparison(true); break;
        case 'remove-layers': stopPlayback(); clearPano(); map.setComparison(null); marker.hidden = true; activeAsset = ''; content.querySelector('.imagery-time-readout').textContent = '已卸载成果图层，底图保留。'; break;
        case 'play':
          if (compareAssets().length < 2) throw new Error('时序播放至少需要两期成果');
          stopPlayback(); content.querySelector('[data-imagery="play"]').setAttribute('aria-pressed', 'true');
          timelineFrame(Number(content.querySelector('#imagery-timeline').value));
          playing = setInterval(() => {
            if (document.hidden) return;
            try { timelineFrame((Number(content.querySelector('#imagery-timeline').value) + 1) % compareAssets().length); }
            catch (error) { stopPlayback(); showError(error); }
          }, 2500); break;
        case 'pause': stopPlayback(); break;
      }
    } catch (error) { if (error.name !== 'AbortError') showError(error); }
    finally { busy = false; }
  }
  function onInput(event) {
    try {
      if (event.target.id === 'imagery-split') {
        map.setSplit(Number(event.target.value) / 100); marker.style.left = `${event.target.value}%`;
      }
      if (event.target.id === 'imagery-timeline') { stopPlayback(); timelineFrame(Number(event.target.value)); }
    } catch (error) { showError(error); }
  }
  function onChange(event) {
    if (event.target.id === 'imagery-import-folder') {
      if (busy) { status.textContent = '当前批次正在上传，请勿重新选择目录。'; return; }
      const selected = [...event.target.files];
      importBatch = undefined; clearError(); content.querySelector('.imagery-import-progress').textContent = '';
      try {
        const plan = planPhotoImport(selected, { ...data.capabilities, maxGroups: data.limits.missions });
        content.querySelector('.imagery-import-selection').textContent = `已选 ${selected.length} 个文件，其中 ${plan.total} 张 JPEG，${plan.groups.length} 个航次 / ${(plan.totalBytes / 1024 ** 3).toFixed(2)} GB；忽略 ${plan.ignored} 个非 JPEG 文件。${plan.groups.slice(0, 8).map(group => `${group.label}：${group.files.length} 张 / ${(group.bytes / 1024 ** 3).toFixed(2)} GB`).join('；')}${plan.groups.length > 8 ? `；另有 ${plan.groups.length - 8} 个航次` : ''}`;
      } catch (error) { content.querySelector('.imagery-import-selection').textContent = '目录未通过上传预检，尚未创建任何任务。'; showError(error); }
      if (!importForm.elements.namedItem('name').value) importForm.elements.namedItem('name').value = selected[0]?.webkitRelativePath.split('/')[0] || '';
    }
    if (event.target === assetForm.elements.namedItem('kind')) {
      for (const section of assetForm.querySelectorAll('[data-asset-fields]')) {
        section.hidden = section.dataset.assetFields !== event.target.value; section.disabled = section.hidden;
      }
    }
    if (event.target.id === 'imagery-compare-kind') { stopPlayback(); clearPano(); map.setComparison(null); marker.hidden = true; paintCompareOptions(); }
  }
  function onKey(event) {
    if (event.key === 'Escape' && content.querySelector('.map-selecting')) {
      map.setSelectionMode(false); map.clearSelection(); field('polygon').value = '';
      content.querySelector('.imagery-draw-status').textContent = '已取消范围选点。';
    }
  }
  workspace.addEventListener('submit', onSubmit); workspace.addEventListener('click', onClick);
  workspace.addEventListener('input', onInput); workspace.addEventListener('change', onChange);
  workspace.addEventListener('keydown', onKey);
  paint(); missionDetail();
  timer = setInterval(async () => {
    if (disposed || document.hidden || busy || !data.jobs.some(job => ['queued', 'running'].includes(job.status))) return;
    try { await refresh(); } catch (error) { if (error.name !== 'AbortError') { clearInterval(timer); showError(new Error(`处理状态刷新失败：${error.message}。请手动刷新。`)); } }
  }, 5000);
  return {
    destroy() {
      disposed = true; abort.abort(); uploadRequest?.abort(); clearInterval(timer); stopPlayback(); clearPano(); map.destroy();
      workspace.removeEventListener('submit', onSubmit); workspace.removeEventListener('click', onClick);
      workspace.removeEventListener('input', onInput); workspace.removeEventListener('change', onChange); workspace.removeEventListener('keydown', onKey);
    },
  };
}
