import { defaultMapSettings } from '/shared/map-settings.mjs';
import { tiandituWmtsUrl } from '/shared/tianditu.mjs';
import { navigationIcon } from '/ui.mjs';
import { validatePolygon } from '/shared/spatial.mjs';

export function mountMap(container, records, { onSelect, notify, fences = [], routes = [], compactLabels = false, onBounds, onPolygon, onSelectionProgress } = {}) {
  let viewer;
  let display;
  let sources;
  let removeTick;
  let disposed = false;
  let mode = 'satellite';
  let config;
  let errorReported = false;
  let labelsVisible = true;
  let pointsVisible = true;
  let tilted = false;
  let pointNamesVisible = !compactLabels;
  let highlighted;
  let pointSource, selection, selectionStart, selectionPixel, selecting = false, cameraInputs;
  let selectionShape = 'rectangle', polygonVertices = [], polygonPixels = [], selectionLine;
  const vertexEntities = [];
  const pointEntities = [];
  let baseLayers = [], comparisonLayers = [], comparison, routeEntity, previewRoute;
  let positioned = records.filter(item => Number.isFinite(item.longitude) && Number.isFinite(item.latitude));
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Cesium 地图，提供定位、缩放和图层按钮');
  if (onBounds || onPolygon) container.tabIndex = 0;
  container.innerHTML = `<div class="map-stage"></div><div class="map-tools" aria-label="地图工具">
    <button data-map="home" title="回到中心" aria-label="回到中心">${navigationIcon('home')}</button>
    <button data-map="locate" title="定位本地点位" aria-label="定位本地点位">${navigationIcon('locate')}</button>
    <button data-map="points" title="显示或隐藏点位" aria-label="显示或隐藏点位" aria-pressed="true">${navigationIcon('points')}</button>
    <button data-map="tilt" title="切换俯视 / 倾斜" aria-label="切换俯视 / 倾斜">${navigationIcon('globe')}</button>
    <button data-map="layers" title="地图图层" aria-label="地图图层" aria-expanded="false">${navigationIcon('layers')}</button>
    <button data-map="labels" title="显示或隐藏地名注记" aria-label="显示或隐藏地名注记" aria-pressed="true">字</button>
    ${compactLabels ? `<button data-map="point-names" title="显示或隐藏点位名称" aria-label="显示或隐藏点位名称" aria-pressed="false">${navigationIcon('label')}</button>` : ''}
    ${onBounds ? `<button data-map="rectangle" aria-label="地图框选" aria-pressed="false">${navigationIcon('rectangle')}</button>` : ''}
    ${onPolygon ? `<button data-map="polygon" aria-label="地图多边形选点" aria-pressed="false">${navigationIcon('polygon')}</button>` : ''}
    <button data-map="plus" title="放大" aria-label="放大">${navigationIcon('plus')}</button>
    <button data-map="minus" title="缩小" aria-label="缩小">${navigationIcon('minus')}</button>
    <button data-map="fullscreen" title="全屏地图" aria-label="全屏地图">${navigationIcon('fullscreen')}</button>
  </div><div class="map-layer-panel" hidden><b>天地图底图</b><button data-map="satellite" aria-pressed="true">影像底图</button><button data-map="street" aria-pressed="false">矢量底图</button><small>影像 / 矢量 + 中文注记</small></div><div class="map-status" role="status">正在初始化 Cesium 地图…</div><div class="map-credit">© 天地图 · 国家地理信息公共服务平台</div>`;
  const stage = container.querySelector('.map-stage');
  const status = container.querySelector('.map-status');
  const layerPanel = container.querySelector('.map-layer-panel');
  const clearHoveredName = () => {
    if (!highlighted) return;
    if (!pointNamesVisible) highlighted.label.show = false;
    highlighted = undefined;
    viewer?.scene.requestRender();
  };
  function setPoints(items) {
    positioned = items.filter(item => Number.isFinite(item.longitude) && Number.isFinite(item.latitude));
    if (!pointSource) return;
    clearHoveredName();
    for (const entity of pointEntities) pointSource.entities.remove(entity);
    pointEntities.length = 0;
    const C = globalThis.Cesium;
    for (const item of positioned) {
      const color = item.mapSelected ? '#8cf4d8' : item.mapCamera && item.status === 'offline' ? '#91a6bd' : item.severity === 'high' ? '#ff5e7e' : item.severity === 'medium' ? '#f4c765' : '#63cedf';
      pointEntities.push(pointSource.entities.add({
        id: item.id, position: C.Cartesian3.fromDegrees(item.longitude, item.latitude, 12),
        point: { pixelSize: item.mapSelected ? 10 : compactLabels ? 7 : 5, color: C.Color.fromCssColorString(color), outlineColor: C.Color.fromCssColorString('#08244b'), outlineWidth: compactLabels ? 2 : 1, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { show: pointNamesVisible, text: item.code || item.name.replace('演示 · ', ''), font: '12px "Microsoft YaHei", sans-serif', fillColor: C.Color.fromCssColorString('#e8f6ff'), showBackground: true, backgroundColor: C.Color.fromCssColorString('#09294beF'), backgroundPadding: new C.Cartesian2(7, 4), pixelOffset: new C.Cartesian2(0, -19), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    }
    viewer.scene.requestRender();
  }
  function setSelectionMode(enabled, shape = 'rectangle') {
    if (!viewer || disposed) throw new Error('Cesium 地图尚未初始化');
    if (enabled && !pointSource) throw new Error('地图点位尚未加载');
    if (enabled && (!['rectangle', 'polygon'].includes(shape) || (shape === 'polygon' && !onPolygon))) throw new Error('地图选点方式不可用');
    if (enabled && !selecting) cameraInputs = viewer.scene.screenSpaceCameraController.enableInputs;
    if (!enabled && selecting) viewer.scene.screenSpaceCameraController.enableInputs = cameraInputs;
    selecting = enabled;
    if (enabled) { selectionShape = shape; clearSelection(); onSelectionProgress?.(0, shape); }
    if (enabled) viewer.scene.screenSpaceCameraController.enableInputs = false;
    selectionStart = undefined;
    stage.classList.toggle('map-selecting', enabled);
    for (const key of ['rectangle', 'polygon']) container.querySelector(`[data-map="${key}"]`)?.setAttribute('aria-pressed', String(enabled && key === selectionShape));
  }
  function clearSelection() {
    if (selection) pointSource?.entities.remove(selection);
    if (selectionLine) pointSource?.entities.remove(selectionLine);
    for (const entity of vertexEntities) pointSource?.entities.remove(entity);
    vertexEntities.length = 0; polygonVertices = []; polygonPixels = []; selectionLine = undefined;
    selection = undefined; selectionStart = undefined;
    viewer?.scene.requestRender();
  }
  function groundPoint(pixel) {
    const C = globalThis.Cesium;
    const ray = viewer.camera.getPickRay(pixel);
    const position = (ray && viewer.scene.globe.pick(ray, viewer.scene)) || viewer.camera.pickEllipsoid(pixel);
    if (!position) return undefined;
    const coordinate = viewer.scene.globe.ellipsoid.cartesianToCartographic(position);
    return { longitude: C.Math.toDegrees(coordinate.longitude), latitude: C.Math.toDegrees(coordinate.latitude) };
  }
  function drawSelection(end) {
    const a = selectionStart;
    let west = Math.min(a.longitude, end.longitude), east = Math.max(a.longitude, end.longitude);
    if (east - west > 180) [west, east] = [east, west];
    const bounds = { west, east, south: Math.min(a.latitude, end.latitude), north: Math.max(a.latitude, end.latitude) };
    const C = globalThis.Cesium;
    const coordinates = C.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north);
    if (selection) selection.rectangle.coordinates = coordinates;
    else selection = pointSource.entities.add({ rectangle: { coordinates, material: C.Color.CYAN.withAlpha(.16), outline: true, outlineColor: C.Color.CYAN, height: 1 } });
    viewer.scene.requestRender();
    return bounds;
  }
  function drawPolygonLine(end) {
    if (!polygonVertices.length) return;
    const C = globalThis.Cesium;
    const points = end ? [...polygonVertices, [end.longitude, end.latitude]] : polygonVertices;
    if (points.length < 2) {
      if (selectionLine) pointSource.entities.remove(selectionLine);
      selectionLine = undefined; return;
    }
    const positions = C.Cartesian3.fromDegreesArrayHeights(points.flatMap(([longitude, latitude]) => [longitude, latitude, 2]));
    if (selectionLine) selectionLine.polyline.positions = positions;
    else selectionLine = pointSource.entities.add({ polyline: { positions, width: 2, material: C.Color.CYAN } });
    viewer.scene.requestRender();
  }
  function addPolygonPoint(point, pixel) {
    const previousPixel = polygonPixels.at(-1);
    if (previousPixel && Math.hypot(previousPixel.x - pixel.x, previousPixel.y - pixel.y) <= 3) return;
    if (polygonVertices.length && polygonVertices.at(-1).every((value, i) => Math.abs(value - [point.longitude, point.latitude][i]) < 1e-8)) return;
    if (polygonVertices.length >= 64) throw new Error('多边形最多选择 64 个顶点');
    polygonVertices.push([point.longitude, point.latitude]);
    polygonPixels.push({ x: pixel.x, y: pixel.y });
    const C = globalThis.Cesium;
    vertexEntities.push(pointSource.entities.add({ position: C.Cartesian3.fromDegrees(point.longitude, point.latitude, 2), point: { pixelSize: 6, color: C.Color.CYAN, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
    drawPolygonLine(); onSelectionProgress?.(polygonVertices.length, 'polygon');
  }
  function setPolygon(points) {
    if (!pointSource || !viewer) throw new Error('地图尚未初始化');
    const polygon = validatePolygon(points), C = globalThis.Cesium;
    clearSelection();
    selection = pointSource.entities.add({ polygon: { hierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(polygon.flat())), material: C.Color.CYAN.withAlpha(.16), height: 1, outline: true, outlineColor: C.Color.CYAN } });
    viewer.scene.requestRender();
    return polygon;
  }
  function finishPolygon() {
    if (!selecting || selectionShape !== 'polygon') throw new Error('请先开启多边形选点');
    const polygon = setPolygon(polygonVertices);
    setSelectionMode(false); onPolygon(polygon);
  }
  function undoPolygonPoint() {
    if (!selecting || selectionShape !== 'polygon') throw new Error('请先开启多边形选点');
    if (!polygonVertices.length) throw new Error('当前没有可撤销的顶点');
    polygonVertices.pop(); polygonPixels.pop(); pointSource.entities.remove(vertexEntities.pop());
    drawPolygonLine(); onSelectionProgress?.(polygonVertices.length, 'polygon'); viewer.scene.requestRender();
  }
  function showStatus(message, error = false) {
    status.hidden = !message;
    status.textContent = message;
    status.classList.toggle('map-error', error);
  }
  function destroyViewer() {
    removeTick?.(); removeTick = undefined;
    if (display && !display.isDestroyed()) display.destroy();
    if (sources && !sources.isDestroyed()) sources.destroy();
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    display = undefined; sources = undefined; viewer = undefined; pointSource = undefined;
  }
  function reportTileError() {
    if (disposed || errorReported) return;
    errorReported = true;
    const message = config?.accessMode === 'browser'
      ? '天地图直连加载失败，请检查浏览器端密钥、域名/IP 白名单和网络。'
      : '天地图代理加载失败，请确认密钥为服务器端，并检查服务授权和网络。';
    showStatus(message, true);
    notify(message, true);
  }
  function setLayers() {
    viewer.imageryLayers.removeAll(true);
    baseLayers = []; comparisonLayers = [];
    if (!config?.configured) { applyComparison(); return; }
    const C = globalThis.Cesium;
    for (const [index, layer] of (mode === 'satellite' ? ['img', 'cia'] : ['vec', 'cva']).entries()) {
      const provider = new C.UrlTemplateImageryProvider({
        url: config.accessMode === 'browser'
          ? tiandituWmtsUrl(layer, '{z}', '{x}', '{y}', config.browserToken).href.replace(/%7B([zxy])%7D/g, '{$1}')
          : `/api/map/tiles/${layer}/{z}/{x}/{y}?v=${config.version || 0}`,
        tilingScheme: new C.WebMercatorTilingScheme(),
        minimumLevel: config.minimumLevel, maximumLevel: config.maximumLevel,
        credit: config.credit,
      });
      provider.errorEvent.addEventListener(reportTileError);
      const imagery = viewer.imageryLayers.addImageryProvider(provider);
      baseLayers.push(imagery);
      if (index === 1) imagery.show = labelsVisible;
      if (compactLabels && index === 0) { imagery.brightness = .82; imagery.saturation = .85; }
    }
    applyComparison();
    viewer.scene.requestRender();
  }
  function applyComparison() {
    if (!viewer) return;
    for (const layer of comparisonLayers) viewer.imageryLayers.remove(layer, true);
    comparisonLayers = [];
    const C = globalThis.Cesium;
    for (const [asset, direction] of [[comparison?.left, comparison?.right ? C.SplitDirection.LEFT : C.SplitDirection.NONE], [comparison?.right, C.SplitDirection.RIGHT]]) {
      if (!asset) continue;
      const bounds = asset.bounds;
      const provider = new C.UrlTemplateImageryProvider({
        url: asset.tileScheme === 'tms' ? asset.url.replace('{y}', '{reverseY}') : asset.url,
        tilingScheme: new C.WebMercatorTilingScheme(),
        rectangle: C.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
        minimumLevel: asset.minimumLevel, maximumLevel: asset.maximumLevel,
        credit: asset.name,
      });
      let reported = false;
      provider.errorEvent.addEventListener(() => {
        if (!disposed && !reported) { reported = true; notify(`影像“${asset.name}”加载失败，请检查瓦片地址、层级、权限和跨域配置。`, true); }
      });
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      layer.splitDirection = direction; layer.alpha = comparison.alpha ?? 1;
      comparisonLayers.push(layer);
    }
    viewer.scene.splitPosition = comparison?.split ?? .5;
    viewer.scene.requestRender();
  }
  function setComparison(value) { comparison = value; applyComparison(); }
  function setSplit(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('卷帘位置必须在 0–1 之间');
    if (comparison) comparison.split = value;
    if (viewer) { viewer.scene.splitPosition = value; viewer.scene.requestRender(); }
  }
  function setRoute(points) {
    previewRoute = points;
    if (!pointSource || !viewer) return;
    if (routeEntity) pointSource.entities.remove(routeEntity);
    routeEntity = undefined;
    if (points?.length > 1) {
      const C = globalThis.Cesium;
      routeEntity = pointSource.entities.add({ polyline: {
        positions: C.Cartesian3.fromDegreesArrayHeights(points.flatMap(point => [point.longitude, point.latitude, 3])),
        width: 3, material: C.Color.fromCssColorString('#f9c56b'),
      } });
    }
    viewer.scene.requestRender();
  }
  function center(longitude = config?.longitude ?? defaultMapSettings.longitude, latitude = config?.latitude ?? defaultMapSettings.latitude, pitch = config?.pitch ?? defaultMapSettings.pitch) {
    const C = globalThis.Cesium;
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(longitude, latitude, config?.height ?? defaultMapSettings.height),
      orientation: { heading: C.Math.toRadians(config?.heading ?? defaultMapSettings.heading), pitch: C.Math.toRadians(pitch), roll: 0 },
    });
    tilted = pitch !== -90;
    viewer.scene.requestRender();
  }
  async function initialize() {
    try {
      const C = globalThis.Cesium;
      if (!C) throw new Error('Cesium 未加载，请运行 npm run build 后刷新');
      viewer = new C.CesiumWidget(stage, {
        baseLayer: false, terrainProvider: new C.EllipsoidTerrainProvider(),
        requestRenderMode: true, skyBox: false, skyAtmosphere: false,
      });
      viewer.scene.globe.baseColor = C.Color.fromCssColorString('#142632');
      viewer.scene.backgroundColor = C.Color.fromCssColorString('#071727');
      viewer.scene.globe.showGroundAtmosphere = false;
      sources = new C.DataSourceCollection();
      const currentViewer = viewer;
      const dataSource = new C.CustomDataSource('local-records');
      await sources.add(dataSource);
      if (disposed || viewer !== currentViewer) return;
      display = new C.DataSourceDisplay({ scene: viewer.scene, dataSourceCollection: sources });
      removeTick = viewer.clock.onTick.addEventListener(() => display?.update(C.JulianDate.now()));
      pointSource = dataSource;
      setPoints(positioned);
      if (previewRoute) setRoute(previewRoute);
      for (const item of fences) if (Number.isFinite(item.longitude) && Number.isFinite(item.latitude)) {
        dataSource.entities.add({ position: C.Cartesian3.fromDegrees(item.longitude, item.latitude), ellipse: {
          semiMajorAxis: item.radius || 300, semiMinorAxis: item.radius || 300, height: 0,
          material: C.Color.CYAN.withAlpha(.025), outline: true, outlineColor: C.Color.CYAN.withAlpha(.4),
        } });
      }
      for (const route of routes) if (Array.isArray(route.waypoints) && route.waypoints.length > 1) {
        dataSource.entities.add({ polyline: {
          positions: C.Cartesian3.fromDegreesArrayHeights(route.waypoints.flatMap(point => [point.longitude, point.latitude, point.altitude || 80])),
          width: 2, material: C.Color.CYAN.withAlpha(.7),
        } });
      }
      viewer.screenSpaceEventHandler.setInputAction(event => {
        if (selecting) {
          container.focus({ preventScroll: true });
          if (selectionShape === 'polygon') {
            const point = groundPoint(event.position);
            if (!point) { notify('未拾取到地图地面，请调整视角后重试', true); return; }
            try { addPolygonPoint(point, event.position); } catch (error) { notify(error.message, true); }
          }
          return;
        }
        const entity = viewer.scene.pick(event.position)?.id;
        const item = entity && positioned.find(item => item.id === entity.id);
        if (item) onSelect?.(item);
      }, C.ScreenSpaceEventType.LEFT_CLICK);
      if (compactLabels || onBounds || onPolygon) viewer.screenSpaceEventHandler.setInputAction(event => {
        if (selecting) {
          const end = groundPoint(event.endPosition);
          if (end && selectionShape === 'polygon') drawPolygonLine(end);
          else if (end && selectionStart) drawSelection(end);
          return;
        }
        if (!compactLabels) return;
        const entity = viewer.scene.pick(event.endPosition)?.id;
        const next = pointEntities.includes(entity) ? entity : undefined;
        if (next === highlighted || pointNamesVisible) return;
        if (highlighted) highlighted.label.show = false;
        highlighted = next;
        if (highlighted) highlighted.label.show = true;
        viewer.scene.requestRender();
      }, C.ScreenSpaceEventType.MOUSE_MOVE);
      if (onBounds || onPolygon) {
        viewer.screenSpaceEventHandler.setInputAction(event => {
          if (!selecting || selectionShape !== 'rectangle') return;
          container.focus({ preventScroll: true });
          clearSelection();
          selectionStart = groundPoint(event.position); selectionPixel = event.position;
          if (!selectionStart) notify('未拾取到地图地面，请调整视角后重试', true);
        }, C.ScreenSpaceEventType.LEFT_DOWN);
        viewer.screenSpaceEventHandler.setInputAction(event => {
          if (!selecting || selectionShape !== 'rectangle' || !selectionStart) return;
          const end = groundPoint(event.position);
          if (!end || Math.hypot(event.position.x - selectionPixel.x, event.position.y - selectionPixel.y) < 8) {
            clearSelection(); notify('请在地图上拖动绘制有效矩形', true); return;
          }
          const bounds = drawSelection(end);
          setSelectionMode(false); onBounds(bounds);
        }, C.ScreenSpaceEventType.LEFT_UP);
        if (onPolygon) viewer.screenSpaceEventHandler.setInputAction(() => {
          if (selecting && selectionShape === 'polygon') try { finishPolygon(); } catch (error) { notify(error.message, true); }
        }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      }
      center();
      const response = await fetch('/api/map/config', { credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法读取地图配置');
      if (disposed) return;
      config = { ...defaultMapSettings, ...result };
      if (config.configured && config.accessMode === 'browser' && !config.browserToken) throw new Error('浏览器直连密钥缺失，请重新保存地图配置');
      mode = config.defaultBasemap;
      labelsVisible = config.labelsVisible;
      container.querySelector('[data-map="labels"]').setAttribute('aria-pressed', String(labelsVisible));
      for (const action of ['satellite', 'street']) container.querySelector(`[data-map="${action}"]`).setAttribute('aria-pressed', String(mode === action));
      center();
      setLayers();
      showStatus(config.configured ? '' : config.message, !config.configured);
      container.dataset.mapReady = 'true';
      container.dataset.mapConfigured = String(config.configured);
      container.dataset.mapAccessMode = config.accessMode;
    } catch (error) {
      if (disposed) return;
      showStatus(`地图加载失败：${error.message}`, true);
      notify(`地图加载失败：${error.message}`, true);
    }
  }
  const handleClick = event => {
    const target = event.target.closest('[data-map]');
    const action = target?.dataset.map;
    if (!action || disposed) return;
    try {
      if (action === 'layers') {
        layerPanel.hidden = !layerPanel.hidden;
        target.setAttribute('aria-expanded', String(!layerPanel.hidden));
        return;
      }
      if (!viewer) throw new Error('Cesium 地图尚未初始化');
      if (action === 'rectangle') setSelectionMode(!(selecting && selectionShape === 'rectangle'), 'rectangle');
      if (action === 'polygon') setSelectionMode(!(selecting && selectionShape === 'polygon'), 'polygon');
      if (action === 'satellite' || action === 'street') {
        mode = action; errorReported = false;
        setLayers();
        layerPanel.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.map === mode)));
        showStatus(config?.configured ? '' : '天地图未配置：请设置 TIANDITU_TOKEN 并重启服务', !config?.configured);
      }
      if (action === 'labels') {
        labelsVisible = !labelsVisible;
        target.setAttribute('aria-pressed', String(labelsVisible));
        if (baseLayers[1]) baseLayers[1].show = labelsVisible;
      }
      if (action === 'points') {
        pointsVisible = !pointsVisible;
        target.setAttribute('aria-pressed', String(pointsVisible));
        for (const source of Array.from({ length: sources.length }, (_, i) => sources.get(i))) source.show = pointsVisible;
      }
      if (action === 'point-names') {
        pointNamesVisible = !pointNamesVisible;
        highlighted = undefined;
        target.setAttribute('aria-pressed', String(pointNamesVisible));
        for (const entity of pointEntities) entity.label.show = pointNamesVisible;
      }
      if (action === 'home') center();
      if (action === 'locate') {
        if (!positioned.length) throw new Error('暂无本地点位坐标');
        center(positioned[0].longitude, positioned[0].latitude);
      }
      if (action === 'plus') viewer.camera.zoomIn(viewer.camera.positionCartographic.height * .3);
      if (action === 'minus') viewer.camera.zoomOut(viewer.camera.positionCartographic.height * .3);
      if (action === 'tilt') {
        center(undefined, undefined, tilted ? -90 : -45);
      }
      if (action === 'fullscreen') {
        const promise = document.fullscreenElement ? document.exitFullscreen() : container.requestFullscreen();
        promise.catch(error => notify(`全屏操作失败：${error.message}`, true));
      }
      viewer.scene.requestRender();
    } catch (error) { notify(error.message, true); }
  };
  container.addEventListener('click', handleClick);
  const handleKey = event => {
    if (event.key === 'Escape' && selecting) { setSelectionMode(false); clearSelection(); notify('已取消地图框选'); }
    if (selecting && selectionShape === 'polygon' && ['Enter', 'Backspace'].includes(event.key)) {
      event.preventDefault();
      try { if (event.key === 'Enter') finishPolygon(); else undoPolygonPoint(); } catch (error) { notify(error.message, true); }
    }
  };
  container.addEventListener('keydown', handleKey);
  if (compactLabels) stage.addEventListener('mouseleave', clearHoveredName);
  initialize();
  return {
    destroy() { disposed = true; container.removeEventListener('click', handleClick); container.removeEventListener('keydown', handleKey); stage.removeEventListener('mouseleave', clearHoveredName); destroyViewer(); },
    setPoints, setSelectionMode, clearSelection, setPolygon, finishPolygon, undoPolygonPoint,
    setComparison, setSplit, setRoute,
    fitBounds(bounds) {
      if (!viewer) throw new Error('Cesium 地图尚未初始化');
      viewer.camera.setView({ destination: globalThis.Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north) });
      viewer.scene.requestRender();
    },
    locate(item) {
      if (!viewer || !Number.isFinite(item.longitude) || !Number.isFinite(item.latitude)) throw new Error('该记录没有可定位的经纬度');
      center(item.longitude, item.latitude);
    },
    get mode() { return mode; },
  };
}
