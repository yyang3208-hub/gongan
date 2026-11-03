import { validatePolygon } from './spatial.mjs';

const earth = 6378137, radians = Math.PI / 180;
function requireValue(condition, message) { if (!condition) throw new RangeError(message); }
export function planMission(input) {
  requireValue(input && typeof input === 'object', '采集参数不能为空');
  requireValue(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 100, '任务名称须为 1–100 个字符');
  requireValue(['ortho', 'panorama'].includes(input.kind), '采集类型无效');
  requireValue(typeof input.capturedAt === 'string' && Number.isFinite(Date.parse(input.capturedAt)), '计划采集时间无效');
  const polygon = validatePolygon(input.polygon);
  const { altitude, speed, frontOverlap, sideOverlap, heading } = input;
  for (const [value, min, max, name] of [[altitude, 20, 120, '航高'], [speed, 1, 12, '航速'], [frontOverlap, 60, 90, '航向重叠率'], [sideOverlap, 50, 90, '旁向重叠率'], [heading, 0, 359, '航线方向']])
    requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `${name}必须在 ${min}–${max} 之间`);
  const longitude = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
  const latitude = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
  requireValue(Math.abs(latitude) <= 70 && Math.max(...polygon.map(p => p[0])) - Math.min(...polygon.map(p => p[0])) < 1, '当前航测仅支持纬度 ±70° 内、不跨日期变更线的小区域');
  const cosLat = Math.cos(latitude * radians), angle = heading * radians;
  const points = polygon.map(([lon, lat]) => {
    const east = (lon - longitude) * radians * earth * cosLat, north = (lat - latitude) * radians * earth;
    return [east * Math.cos(angle) - north * Math.sin(angle), east * Math.sin(angle) + north * Math.cos(angle)];
  });
  let signedArea = 0, sign;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    signedArea += a[0] * b[1] - b[0] * a[1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-6) {
      requireValue(sign === undefined || Math.sign(cross) === sign, '为避免凹多边形转场飞出范围，本版仅生成凸多边形航线；请拆分成多个采集任务');
      sign = Math.sign(cross);
    }
  }
  const areaM2 = Math.abs(signedArea) / 2;
  requireValue(areaM2 >= 100 && areaM2 <= 1000000, '单次范围面积须在 100 平方米至 1 平方公里之间');
  const footprintWidth = altitude * 17.3 / 12.29, footprintHeight = altitude * 13 / 12.29;
  const lineSpacingM = footprintWidth * (1 - sideOverlap / 100), shotSpacing = footprintHeight * (1 - frontOverlap / 100);
  const waypoints = [];
  function toWaypoint(x, y, extra = {}) {
    const east = x * Math.cos(angle) + y * Math.sin(angle), north = -x * Math.sin(angle) + y * Math.cos(angle);
    return { longitude: longitude + east / (earth * cosLat * radians), latitude: latitude + north / (earth * radians), altitude, heading, gimbalPitch: -90, ...extra };
  }
  if (input.kind === 'panorama') {
    for (const pitch of [-60, -15, 30]) for (let yaw = 0; yaw < 360; yaw += 45)
      waypoints.push(toWaypoint(0, 0, { heading: yaw, gimbalPitch: pitch }));
    waypoints.push(toWaypoint(0, 0));
  } else {
    const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
    const rows = Math.max(1, Math.ceil((maxX - minX) / lineSpacingM));
    requireValue(rows <= 500, '航线过密，请缩小范围或调整航高和重叠率');
    for (let row = 0; row < rows; row++) {
      const x = minX + (row + .5) * (maxX - minX) / rows, intersections = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if ((a[0] <= x && b[0] > x) || (b[0] <= x && a[0] > x))
          intersections.push(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]));
      }
      if (intersections.length < 2) continue;
      const low = Math.min(...intersections), high = Math.max(...intersections), intervals = Math.max(1, Math.ceil((high - low) / shotSpacing));
      requireValue(waypoints.length + intervals + 1 <= 500, '该范围需要超过 500 个拍照航点，请拆分任务或降低重叠率');
      const line = Array.from({ length: intervals + 1 }, (_, i) => toWaypoint(x, low + (high - low) * i / intervals));
      waypoints.push(...(row % 2 ? line.reverse() : line));
    }
  }
  requireValue(waypoints.length > 0, '采集范围无法生成有效航点');
  let distanceM = 0;
  for (let i = 1; i < waypoints.length; i++)
    distanceM += Math.hypot((waypoints[i].longitude - waypoints[i - 1].longitude) * cosLat, waypoints[i].latitude - waypoints[i - 1].latitude) * earth * radians;
  return {
    name: input.name.trim(), kind: input.kind, capturedAt: new Date(input.capturedAt).toISOString(),
    polygon, altitude, speed, frontOverlap, sideOverlap, heading,
    plan: { waypoints, areaM2, distanceM, durationSeconds: Math.ceil(distanceM / speed + waypoints.length * 4 + altitude / 3 * 2), photoCount: waypoints.length, lineSpacingM, gsdCm: footprintWidth / 5280 * 100,
      warnings: ['航高相对实际起飞点，不是离地高度；本平台未计算地形、障碍物、空域和电池返航余量。', '航线采用逐点停留拍照以保证重叠，估时不含转场、风况和人工操作；飞前必须在 DJI Pilot 2 核验。', ...(input.kind === 'panorama' ? ['M3E 相机有天顶盲区；25 张组图不等于已拼接的 720° 全景，需专业拼接并处理天空区域。'] : [])] },
  };
}
