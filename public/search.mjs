import { districts } from '/shared/catalog.mjs';
import { imageDescriptor, imageSimilarity } from '/shared/image-search.mjs';
import { mountMap } from '/map.mjs';
import { enhanceInterface, focusFormError } from '/ui.mjs';
import { validatePolygon, pointInPolygon, pointInBounds } from '/shared/spatial.mjs';

const pageSize = 24;
const maxImageBytes = 8 * 1024 * 1024;
const types = [['', '全部'], ['face', '人脸'], ['body', '人体'], ['vehicle', '机动车'], ['bicycle', '二轮车'], ['tricycle', '三轮车']];
const localTime = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

async function descriptorFromBlob(blob) {
  if (blob.size > maxImageBytes || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('仅支持不超过 8 MB 的 PNG、JPEG、WebP 图片');
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 20000000) throw new Error('图片尺寸不能超过 2000 万像素');
    const canvas = document.createElement('canvas');
    canvas.width = 9; canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff'; context.fillRect(0, 0, 9, 8);
    context.drawImage(bitmap, 0, 0, 9, 8);
    return imageDescriptor(context.getImageData(0, 0, 9, 8).data);
  } finally { bitmap.close(); }
}

async function remoteDescriptor(url, signal) {
  const response = await fetch(url, { credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error(`图像请求失败 (${response.status})`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxImageBytes) { await reader.cancel(); throw new Error('授权图像超过 8 MB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return descriptorFromBlob(new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0].trim() || '' }));
}

export async function renderSearchWorkspace(content, { state, api, loadCameras, notify, escape, title, label, thumbnail, formatTime, epochCurrent }) {
  let [initial, cameras] = await Promise.all([api(`/api/search?${new URLSearchParams({ ...state.query, page: String(state.page), pageSize: String(pageSize) })}`), loadCameras()]);
  if (!epochCurrent()) return null;
  let disposed = false, mode = 'structured', collapsed = false, result = initial, selected, matches, image, previewUrl = '';
  let job = 0, uploadJob = 0, jobAbort;
  let selectedCameras = [], matchedCameraSelection;
  const option = (values, current) => `<option value="">不限</option>${values.map(value => `<option ${current === value ? 'selected' : ''}>${escape(value)}</option>`).join('')}`;
  content.classList.add('query-screen');
  content.innerHTML = `<div class="query-workspace">
    <div id="main-map" class="query-map"></div>
    <aside class="panel query-panel">${title('检索条件', 'QUERY BUILDER')}
      <div class="query-tabs" role="tablist" aria-label="检索方式">${[['structured', '结构化检索'], ['image', '以图搜图'], ['area', '框选搜索']].map(([key, name]) => `<button role="tab" aria-selected="${key === mode}" data-query-mode="${key}">${name}</button>`).join('')}</div>
      <form id="search-form">
        <p class="query-method-note">检索本地记录，演示占位图不是真实识别结果。</p>
        <fieldset class="query-image-input" hidden><legend>检索图片</legend><label>上传授权图片<input type="file" name="referenceImage" accept="image/png,image/jpeg,image/webp"></label><div class="query-upload-preview"></div><label>最低视觉相似度 (%)<input type="number" name="similarity" min="0" max="100" step="0.1" value="80"></label><p>图片仅在当前浏览器比对，不上传服务器。视觉相似度不表示同一人或同一目标。</p></fieldset>
        <fieldset><legend>目标类型</legend><div class="type-options">${types.map(([value, name]) => `<label><input type="radio" name="type" value="${value}" ${(state.query.type || '') === value ? 'checked' : ''}>${name}</label>`).join('')}</div></fieldset>
        <fieldset><legend>时间范围</legend><div class="query-periods">${[['1h', '近 1 小时'], ['24h', '近 24 小时'], ['7d', '近 7 天'], ['custom', '自定义']].map(([value, name]) => `<button type="button" data-query-period="${value}">${name}</button>`).join('')}</div><label>开始时间<input type="datetime-local" name="from" value="${state.query.from ? localTime(new Date(state.query.from)) : ''}"></label><label>结束时间<input type="datetime-local" name="to" value="${state.query.to ? localTime(new Date(state.query.to)) : ''}"></label></fieldset>
        <fieldset><legend>空间范围</legend><label>所属辖区<select name="district"><option value="">全部辖区</option>${districts.map(area => `<option ${state.query.district === area ? 'selected' : ''}>${area}</option>`).join('')}</select></label><label>点位 / 目标名称 / 设备编号<input name="q" placeholder="请输入名称、点位或设备编号" value="${escape(state.query.q || '')}"></label></fieldset>
        <fieldset class="query-bounds" hidden><legend>摄像头范围 · WGS84</legend><div class="query-area-actions"><button type="button" data-query-action="draw-polygon">多边形选点</button><button type="button" data-query-action="finish-polygon">完成选点</button><button type="button" data-query-action="undo-polygon">撤销上一点</button><button type="button" data-query-action="draw">开始地图框选</button><button type="button" data-query-action="clear-bounds">清除范围</button></div><p class="query-area-status" role="status">连续点击地图选点，双击完成多边形；也可拖动矩形。检索范围内摄像头关联的抓拍。</p><label>多边形顶点（经度、纬度）<textarea name="polygon" maxlength="8000" rows="2" placeholder="[[121.51,29.95],[121.52,29.95],[121.52,29.96]]">${escape(state.query.polygon || '')}</textarea></label><button type="button" data-query-action="apply-polygon">应用多边形顶点</button><div class="query-field-grid">${[['west', '西界经度', -180, 180], ['east', '东界经度', -180, 180], ['south', '南界纬度', -90, 90], ['north', '北界纬度', -90, 90]].map(([key, name, min, max]) => `<label>${name}<input type="number" name="${key}" min="${min}" max="${max}" step="any" value="${escape(state.query[key] || '')}"></label>`).join('')}</div><div class="query-camera-selection" aria-live="polite"></div></fieldset>
        <fieldset><legend>人员 / 车辆属性</legend><div class="query-field-grid"><label>性别<select name="gender">${option(['未知', '男', '女'], state.query.gender)}</select></label><label>年龄段<select name="age">${option(['未知', '少年', '青年', '中年', '老年'], state.query.age)}</select></label></div><label>上装 / 车身颜色<select name="color">${option(['蓝色', '黑色', '白色', '灰色'], state.query.color)}</select></label><label>最低置信度 (%)<input type="number" name="minConfidence" min="0" max="100" value="${escape(state.query.minConfidence || '0')}"></label><label class="query-check"><input type="checkbox" name="todayOnly">仅看当天抓拍</label><label class="query-check"><input type="checkbox" name="highConfidence">高置信度（≥ 97%）</label></fieldset>
        <p class="form-error" role="alert"></p><div class="query-actions"><button class="primary" type="submit">⌕ 开始检索</button><button type="button" data-query-action="reset">重置</button></div>
      </form>
    </aside>
    <section class="panel search-results">${title('检索结果', 'SEARCH RESULTS', '<button data-query-action="collapse" aria-controls="query-result-body" aria-expanded="true">收起结果</button>')}
      <div id="query-result-body"><div class="result-toolbar"><span class="query-total" role="status"></span><select aria-label="查询结果排序" class="query-sort"><option value="time-desc">按时间降序</option><option value="time-asc">按时间升序</option><option value="confidence-desc">按置信度降序</option><option value="similarity-desc" disabled>按视觉相似度降序</option></select><button data-query-action="refresh" aria-label="刷新查询结果">刷新</button><button data-action="export">导出当前页</button></div><div class="query-search-status" role="status"></div><div class="query-image-errors"></div><div class="capture-grid"></div><div class="query-pagination"></div></div>
      <button class="query-expand-results" data-query-action="collapse" aria-controls="query-result-body" aria-expanded="false" hidden>展开结果</button>
    </section>
    <aside class="query-right"><section class="panel query-preview" aria-label="目标预览">${title('目标预览', 'TARGET PREVIEW')}<div class="query-preview-body"></div></section><section class="panel query-summary">${title('检索概况', 'QUERY SUMMARY')}<div></div></section></aside>
  </div>`;
  const workspace = content.querySelector('.query-workspace'), form = content.querySelector('#search-form');
  const field = name => form.elements.namedItem(name);
  const status = content.querySelector('.query-search-status'), errorNode = form.querySelector('.form-error');
  const sort = content.querySelector('.query-sort');
  let map;
  function regionFromFields() {
    const text = field('polygon').value.trim();
    if (text) {
      if (['west', 'east', 'south', 'north'].some(key => field(key).value !== '')) throw new Error('请清除矩形范围后应用多边形');
      let points;
      try { points = JSON.parse(text); } catch { throw new Error('多边形顶点不是有效 JSON 数组'); }
      return { polygon: validatePolygon(points) };
    }
    const keys = ['west', 'east', 'south', 'north'];
    if (!keys.some(key => field(key).value !== '')) return null;
    if (keys.some(key => field(key).value === '')) throw new Error('请填写完整的四个矩形边界');
    const bounds = Object.fromEntries(keys.map(key => [key, Number(field(key).value)]));
    if (!keys.every(key => Number.isFinite(bounds[key])) || Math.abs(bounds.west) > 180 || Math.abs(bounds.east) > 180 || Math.abs(bounds.south) > 90 || Math.abs(bounds.north) > 90 || bounds.south > bounds.north) throw new Error('矩形范围无效');
    return { bounds };
  }
  function showCameraSelection(region, authoritative) {
    selectedCameras = authoritative?.items || (region ? cameras.filter(camera => region.polygon ? pointInPolygon(camera.longitude, camera.latitude, region.polygon) : pointInBounds(camera.longitude, camera.latitude, region.bounds)) : []);
    const ids = new Set(selectedCameras.map(camera => camera.id));
    map?.setPoints(cameras.map(camera => ({ ...camera, mapCamera: true, mapSelected: ids.has(camera.id) })));
    content.querySelector('.query-camera-selection').innerHTML = region ? `<b>范围内 ${selectedCameras.length} 个摄像头</b><ul>${selectedCameras.map(camera => `<li><button type="button" data-query-camera="${escape(camera.id)}">${escape(camera.name)}<small>${escape(camera.code || '未维护编号')}</small></button></li>`).join('') || '<li>该范围内没有摄像头。</li>'}</ul><p>仅检索明确关联摄像头 ID 或唯一设备编号的记录，未关联记录不会自动归属。</p>` : '<p>尚未选择摄像头范围。</p>';
  }
  function clearRegion() {
    for (const key of ['west', 'east', 'south', 'north', 'polygon']) field(key).value = '';
    map.clearSelection(); matches = undefined; showCameraSelection(null);
  }
  function cameraPreview(camera) {
    content.querySelector('.query-preview-body').innerHTML = `<b>${escape(camera.name)}</b><p>摄像头点位 · ${escape(label(camera.status))}</p><dl><dt>设备编号</dt><dd>${escape(camera.code || '未维护')}</dd><dt>经度</dt><dd>${camera.longitude}</dd><dt>纬度</dt><dd>${camera.latitude}</dd></dl><p>这是本地设备记录，不表示实时视频连接。</p><button data-detail="${escape(camera.id)}" data-resource="cameras">摄像头详情</button>`;
  }
  function collapse(value) {
    const expanding = !value && document.activeElement === content.querySelector('.query-expand-results');
    collapsed = value;
    workspace.classList.toggle('is-results-collapsed', value);
    content.querySelector('#query-result-body').hidden = value;
    content.querySelector('.search-results .panel-title').hidden = value;
    content.querySelector('.query-expand-results').hidden = !value;
    content.querySelectorAll('[data-query-action="collapse"]').forEach(button => button.setAttribute('aria-expanded', String(!value)));
    if (value) content.querySelector('.query-expand-results').focus();
    else if (expanding) content.querySelector('.search-results .panel-title [data-query-action="collapse"]').focus();
  }
  function setMode(value) {
    if (value !== 'area' && content.querySelector('.map-selecting')) { map.setSelectionMode(false); map.clearSelection(); }
    mode = value;
    content.querySelectorAll('[data-query-mode]').forEach(button => { button.classList.toggle('active', button.dataset.queryMode === mode); button.setAttribute('aria-selected', String(button.dataset.queryMode === mode)); });
    content.querySelector('.query-image-input').hidden = mode !== 'image';
    content.querySelector('.query-bounds').hidden = mode !== 'area';
    sort.querySelector('[value="similarity-desc"]').disabled = mode !== 'image';
    if (mode === 'image') sort.value = 'similarity-desc';
    else if (sort.value === 'similarity-desc') sort.value = 'time-desc';
    matches = undefined;
  }
  function select(item) {
    selected = item;
    const body = content.querySelector('.query-preview-body');
    body.innerHTML = item ? `<div class="query-preview-image">${thumbnail(item)}</div><b>${escape(item.name)}</b><p>${escape(item.source || '未维护点位')} · ${formatTime(item.occurredAt)}</p><dl><dt>目标类型</dt><dd>${escape(label(item.type))}</dd><dt>置信度</dt><dd>${item.confidence ?? '—'}%</dd><dt>所属辖区</dt><dd>${escape(item.district || '未维护')}</dd><dt>设备编号</dt><dd>${escape(item.cameraCode || '未维护')}</dd>${item.similarity !== undefined ? `<dt>视觉相似度</dt><dd>${item.similarity}%</dd>` : ''}</dl><div class="query-preview-actions"><button data-detail="${escape(item.id)}" data-resource="captures">结构化详情</button><button data-query-action="locate" ${Number.isFinite(item.longitude) && Number.isFinite(item.latitude) ? '' : 'disabled'}>定位点位</button></div>` : '<div class="empty">没有可预览的目标</div>';
    for (const card of content.querySelectorAll('[data-query-select]')) card.setAttribute('aria-pressed', String(card.dataset.querySelect === item?.id));
  }
  function paint() {
    state.records = result.items; state.resource = 'captures'; state.page = result.page;
    content.querySelector('.query-total').textContent = `${result.total} 条结果 · ${mode === 'image' ? '本地视觉相似检索' : '本地结构化记录'}`;
    content.querySelector('.capture-grid').innerHTML = result.items.map(item => `<button class="capture-card" data-query-select="${escape(item.id)}" aria-pressed="false"><div class="capture-image">${thumbnail(item)}<span><span class="badge">${escape(label(item.type))}</span></span><b>${item.confidence ?? '—'}%</b></div><div><strong>${escape(item.name)}</strong><small>${formatTime(item.occurredAt)}</small><p title="${escape(item.source)}">${escape(item.source || '未维护点位')}</p><p>${escape(item.gender || '未知')} · ${escape(item.age || '年龄未维护')} · ${escape(item.color || '颜色未维护')}</p>${item.similarity !== undefined ? `<p class="query-similarity">视觉相似度 ${item.similarity}%</p>` : ''}</div></button>`).join('') || '<div class="empty">没有符合条件的结果，请调整条件或维护授权图片。</div>';
    const pages = Math.max(1, Math.ceil(result.total / pageSize));
    content.querySelector('.query-pagination').innerHTML = `<span>共 ${result.total} 条 · 每页 ${pageSize} 条</span><button data-query-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>上一页</button><span>${result.page} / ${pages}</span><button data-query-page="${result.page + 1}" ${result.page >= pages ? 'disabled' : ''}>下一页</button>`;
    const region = regionFromFields();
    showCameraSelection(region, result.cameraSelection);
    content.querySelector('.query-summary > div:last-child').textContent = `本次 ${result.total} 条记录，当前页 ${result.items.length} 条。地图展示 ${cameras.filter(camera => Number.isFinite(camera.longitude) && Number.isFinite(camera.latitude)).length} 个摄像头点位${region ? `，范围内 ${selectedCameras.length} 个摄像头；只返回明确关联的抓拍。` : '；选择范围可检索关联抓拍。'}非实时算法结果。`;
    select(result.items.find(item => item.id === selected?.id) || result.items[0]);
    enhanceInterface(content);
  }
  function filters() {
    const values = Object.fromEntries(new FormData(form));
    const query = {};
    for (const key of ['type', 'district', 'q', 'gender', 'age', 'color', 'minConfidence']) if (values[key] !== '') query[key] = values[key];
    const region = regionFromFields();
    if (mode === 'area' && !region) throw new Error('请先选择摄像头范围');
    if (region) {
      query.cameraScope = '1';
      if (region.polygon) query.polygon = JSON.stringify(region.polygon);
      else Object.assign(query, Object.fromEntries(Object.entries(region.bounds).map(([key, value]) => [key, String(value)])));
    }
    for (const key of ['from', 'to']) if (values[key]) query[key] = new Date(values[key]).toISOString();
    if (values.todayOnly) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (!query.from || Date.parse(query.from) < today.getTime()) query.from = today.toISOString();
    }
    if (values.highConfidence) query.minConfidence = String(Math.max(97, Number(query.minConfidence || 0)));
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new Error('开始时间不能晚于结束时间');
    query.sort = sort.value === 'similarity-desc' ? 'time-desc' : sort.value;
    return query;
  }
  async function run(page = 1, reuseMatches = false) {
    if (disposed) return;
    const current = ++job;
    jobAbort?.abort(); jobAbort = new AbortController();
    const signal = jobAbort.signal;
    errorNode.textContent = ''; content.querySelector('.query-image-errors').innerHTML = '';
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    status.textContent = '正在检索本地记录…';
    try {
      const query = filters();
      let next;
      if (mode === 'image') {
        if (!image) throw new Error('请先上传有效的授权图片');
        if (!reuseMatches || !matches) {
          const minimum = Number(field('similarity').value);
          const found = [], failures = [];
          let checked = 0, candidates = 0;
          for (let candidatePage = 1, pages = 1; candidatePage <= pages; candidatePage++) {
            const batch = await api(`/api/search?${new URLSearchParams({ ...query, imageOnly: '1', page: String(candidatePage), pageSize: '200' })}`, { signal });
            matchedCameraSelection = batch.cameraSelection;
            candidates = batch.total; pages = Math.ceil(batch.total / 200);
            for (const item of batch.items) {
              if (signal.aborted) return;
              try {
                const descriptor = await remoteDescriptor(item.imageUrl, signal);
                const similarity = imageSimilarity(image, descriptor);
                if (similarity >= minimum) found.push({ ...item, similarity });
              } catch (error) {
                if (signal.aborted) return;
                failures.push({ name: item.name, error: `${error.message}；跨域图片需提供 CORS 读取授权。` });
              }
              checked++;
              if (disposed || current !== job) return;
              status.textContent = `正在比较授权图片 ${checked} / ${candidates}…`;
            }
          }
          if (disposed || current !== job) return;
          if (sort.value === 'similarity-desc') found.sort((a, b) => b.similarity - a.similarity || String(a.id).localeCompare(String(b.id)));
          matches = found;
          status.textContent = candidates ? `已检查 ${checked} 张授权图片，${failures.length} 张读取失败；视觉相似度不代表身份一致。` : '没有可检索的授权图片。请在后台结构化抓拍记录中维护图像地址；演示占位图不参与比对。';
          if (failures.length) content.querySelector('.query-image-errors').innerHTML = `<details><summary>${failures.length} 张图片读取失败（结果不完整）</summary><ul>${failures.map(item => `<li>${escape(item.name)}：${escape(item.error)}</li>`).join('')}</ul></details>`;
        } else status.textContent = '当前浏览器图像检索快照；重新检索可更新图片比对结果。';
        next = { items: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length, page, pageSize, cameraSelection: matchedCameraSelection };
      } else {
        next = await api(`/api/search?${new URLSearchParams({ ...query, page: String(page), pageSize: String(pageSize) })}`, { signal });
        status.textContent = '本地数据库检索完成。';
      }
      if (disposed || current !== job) return;
      state.query = query; result = next; paint(); collapse(false);
    } catch (error) {
      if (disposed || current !== job || signal.aborted) return;
      status.textContent = '本次检索失败，仍显示上一次结果。';
      errorNode.textContent = error.message; focusFormError(errorNode);
    } finally { if (!disposed && current === job) submit.disabled = false; }
  }
  map = mountMap(content.querySelector('#main-map'), cameras.map(camera => ({ ...camera, mapCamera: true })), {
    compactLabels: true, notify, onSelect: cameraPreview,
    onBounds(bounds) {
      setMode('area');
      field('polygon').value = '';
      for (const [key, value] of Object.entries(bounds)) field(key).value = value.toFixed(7);
      showCameraSelection({ bounds }); matches = undefined;
      content.querySelector('.query-area-status').textContent = '已完成地图框选，点击开始检索查询范围内摄像头的抓拍。';
      notify('地图范围已选定，点击开始检索');
    },
    onPolygon(polygon) {
      setMode('area');
      for (const key of ['west', 'east', 'south', 'north']) field(key).value = '';
      field('polygon').value = JSON.stringify(polygon);
      showCameraSelection({ polygon }); matches = undefined;
      content.querySelector('.query-area-status').textContent = `已完成 ${polygon.length} 点多边形，范围内 ${selectedCameras.length} 个摄像头，点击开始检索。`;
      notify(`已选择 ${selectedCameras.length} 个摄像头`);
    },
    onSelectionProgress(count, shape) {
      content.querySelector('.query-area-status').textContent = shape === 'polygon' ? `已选 ${count} 个顶点，至少选 3 点；双击或点击完成选点，Backspace 撤销，Esc 取消。` : '拖动地图绘制矩形，选择范围内摄像头。';
    },
  });
  const handleSubmit = event => { event.preventDefault(); event.stopPropagation(); run(); };
  form.addEventListener('submit', handleSubmit);
  const handleChange = async event => {
    if (event.target.name === 'referenceImage') {
      jobAbort?.abort();
      const current = ++uploadJob;
      const file = event.target.files[0];
      image = undefined; matches = undefined;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = ''; content.querySelector('.query-upload-preview').innerHTML = '';
      if (!file) return;
      status.textContent = '正在读取本地图片…';
      try {
        const descriptor = await descriptorFromBlob(file);
        if (disposed || current !== uploadJob) return;
        image = descriptor; previewUrl = URL.createObjectURL(file);
        content.querySelector('.query-upload-preview').innerHTML = `<img src="${previewUrl}" alt="已上传的检索图片"><small>${escape(file.name)}</small>`;
        status.textContent = '检索图片已就绪，点击开始检索。'; errorNode.textContent = '';
      } catch (error) {
        if (disposed || current !== uploadJob) return;
        status.textContent = '检索图片无法使用。'; errorNode.textContent = error.message; focusFormError(errorNode);
      }
    } else if (event.target === sort) await run();
    else matches = undefined;
  };
  const handleClick = async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.querySelect) { select(result.items.find(item => item.id === button.dataset.querySelect)); return; }
    if (button.dataset.queryCamera) {
      const camera = selectedCameras.find(item => item.id === button.dataset.queryCamera);
      if (camera) { cameraPreview(camera); try { map.locate(camera); } catch (error) { notify(error.message, true); } }
      return;
    }
    if (button.dataset.queryPage) { await run(Number(button.dataset.queryPage), true); return; }
    if (button.dataset.queryMode) { jobAbort?.abort(); setMode(button.dataset.queryMode); status.textContent = '检索方式已切换，请点击开始检索。'; return; }
    if (button.dataset.queryPeriod) {
      const period = button.dataset.queryPeriod;
      if (period !== 'custom') {
        const now = new Date(), hours = { '1h': 1, '24h': 24, '7d': 168 }[period];
        field('from').value = localTime(new Date(now.getTime() - hours * 3600000)); field('to').value = localTime(now);
      }
      field('from').focus(); matches = undefined; return;
    }
    if (['rectangle', 'polygon'].includes(button.dataset.map) && button.getAttribute('aria-pressed') === 'true') {
      clearRegion();
      setMode('area'); collapse(true);
    }
    switch (button.dataset.queryAction) {
      case 'collapse': collapse(!collapsed); break;
      case 'refresh':
        try { cameras = await loadCameras(); await run(); } catch (error) { notify(`摄像头点位刷新失败：${error.message}`, true); }
        break;
      case 'locate': try { map.locate(selected); } catch (error) { notify(error.message, true); } break;
      case 'draw':
        try { clearRegion(); map.setSelectionMode(true); collapse(true); content.querySelector('#main-map').focus(); }
        catch (error) { notify(error.message, true); }
        break;
      case 'draw-polygon':
        try { clearRegion(); map.setSelectionMode(true, 'polygon'); collapse(true); content.querySelector('#main-map').focus(); }
        catch (error) { notify(error.message, true); }
        break;
      case 'finish-polygon': try { map.finishPolygon(); } catch (error) { notify(error.message, true); } break;
      case 'undo-polygon': try { map.undoPolygonPoint(); } catch (error) { notify(error.message, true); } break;
      case 'apply-polygon':
        try {
          const region = regionFromFields();
          if (!region?.polygon) throw new Error('请填写多边形顶点');
          map.setPolygon(region.polygon); map.setSelectionMode(false); showCameraSelection(region); matches = undefined;
          content.querySelector('.query-area-status').textContent = `已应用多边形，范围内 ${selectedCameras.length} 个摄像头。`;
        } catch (error) { errorNode.textContent = error.message; focusFormError(errorNode); }
        break;
      case 'clear-bounds':
        clearRegion(); map.setSelectionMode(false);
        content.querySelector('.query-area-status').textContent = '地图范围已清除。';
        break;
      case 'reset':
        jobAbort?.abort(); ++uploadJob; image = undefined; matches = undefined;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = ''; content.querySelector('.query-upload-preview').innerHTML = '';
        for (const input of form.querySelectorAll('input,select,textarea')) {
          if (input.type === 'checkbox') input.checked = false;
          else if (input.type === 'radio') input.checked = input.value === '';
          else input.value = input.name === 'similarity' ? '80' : input.name === 'minConfidence' ? '0' : '';
        }
        sort.value = 'time-desc'; setMode('structured'); map.clearSelection(); map.setSelectionMode(false);
        await run(); break;
    }
  };
  const handleKey = event => {
    if (event.key === 'Escape' && mode === 'area') {
      if (content.querySelector('.map-selecting')) { map.setSelectionMode(false); map.clearSelection(); }
      collapse(false);
    }
    if (event.target.matches('[data-query-mode]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...content.querySelectorAll('[data-query-mode]')];
      const index = tabs.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      jobAbort?.abort(); setMode(tabs[next].dataset.queryMode); tabs[next].focus();
    }
  };
  content.addEventListener('click', handleClick);
  content.addEventListener('change', handleChange);
  content.addEventListener('keydown', handleKey);
  setMode(mode); paint();
  return {
    destroy() {
      disposed = true; ++uploadJob; jobAbort?.abort();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      form.removeEventListener('submit', handleSubmit);
      content.removeEventListener('click', handleClick); content.removeEventListener('change', handleChange); content.removeEventListener('keydown', handleKey);
      content.classList.remove('query-screen'); map.destroy();
    },
  };
}
