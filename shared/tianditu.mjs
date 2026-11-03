export function tiandituWmtsUrl(layer, level, column, row, token) {
  if (!['img', 'cia', 'vec', 'cva'].includes(layer)) throw new RangeError('天地图图层无效');
  const url = new URL(`https://t0.tianditu.gov.cn/${layer}_w/wmts`);
  url.search = new URLSearchParams({
    SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: layer,
    STYLE: 'default', TILEMATRIXSET: 'w', FORMAT: 'tiles',
    TILEMATRIX: String(level), TILECOL: String(column), TILEROW: String(row), tk: token,
  }).toString();
  return url;
}
