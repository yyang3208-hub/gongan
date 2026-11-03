const epsilon = 1e-9;
const unwrap = (longitude, anchor) => anchor + ((longitude - anchor + 540) % 360) - 180;
const normalized = points => points.map(([longitude, latitude]) => [unwrap(longitude, points[0][0]), latitude]);
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function onSegment(a, b, p) {
  return Math.abs(cross(a, b, p)) <= epsilon && p[0] >= Math.min(a[0], b[0]) - epsilon && p[0] <= Math.max(a[0], b[0]) + epsilon && p[1] >= Math.min(a[1], b[1]) - epsilon && p[1] <= Math.max(a[1], b[1]) + epsilon;
}
function intersects(a, b, c, d) {
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
    || (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0);
}

export function validatePolygon(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 64) throw new Error('多边形须包含 3–64 个顶点');
  if (!value.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)) throw new Error('多边形顶点须为有效经纬度数组');
  const points = value.map(point => [...point]);
  if (points[0].every((v, i) => v === points.at(-1)[i])) points.pop();
  if (points.length < 3 || new Set(points.map(point => point.join(','))).size !== points.length) throw new Error('多边形须包含至少三个不同顶点，不能重复选点');
  const flat = normalized(points);
  if (Math.max(...flat.map(point => point[0])) - Math.min(...flat.map(point => point[0])) >= 180) throw new Error('多边形经度跨度须小于 180 度');
  const area = flat.reduce((sum, point, i) => { const next = flat[(i + 1) % flat.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0);
  if (Math.abs(area) <= epsilon) throw new Error('多边形面积无效，顶点不能共线');
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
    if (j === i + 1 || (i === 0 && j === flat.length - 1)) continue;
    if (intersects(flat[i], flat[(i + 1) % flat.length], flat[j], flat[(j + 1) % flat.length])) throw new Error('多边形边界不能交叉');
  }
  return points;
}

export function pointInPolygon(longitude, latitude, polygon) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  const points = normalized(polygon), p = [unwrap(longitude, polygon[0][0]), latitude];
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    if (onSegment(a, b, p)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function pointInBounds(longitude, latitude, bounds) {
  return Number.isFinite(longitude) && Number.isFinite(latitude) && latitude >= bounds.south && latitude <= bounds.north
    && (bounds.west <= bounds.east ? longitude >= bounds.west && longitude <= bounds.east : longitude >= bounds.west || longitude <= bounds.east);
}
