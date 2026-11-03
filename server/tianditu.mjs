const layers = new Set(['img', 'cia', 'vec', 'cva']);

export function tiandituTileUrl(layer, level, column, row, token) {
  if (!layers.has(layer) || !Number.isInteger(level) || level < 1 || level > 18 ||
      !Number.isInteger(column) || column < 0 || column >= 2 ** level ||
      !Number.isInteger(row) || row < 0 || row >= 2 ** level) {
    throw new RangeError('天地图瓦片参数无效');
  }
  return tiandituWmtsUrl(layer, level, column, row, token);
}

export async function tiandituErrorMessage(response) {
  const generic = `天地图服务返回 ${response.status}，请检查密钥类型、授权和访问白名单`;
  if (!response.headers.get('content-type')?.includes('application/json')) return generic;
  const reader = response.body?.getReader();
  if (!reader) return generic;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) return generic;
      chunks.push(Buffer.from(chunk.value));
    }
  } catch { return '天地图错误响应读取失败，请检查网络和服务状态'; }
  finally { await reader.cancel(); }
  let error;
  try { error = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return generic; }
  if (String(error?.code) === '301012' && typeof error.resolve === 'string' && error.resolve.includes('浏览器端')) {
    return '当前天地图密钥为浏览器端，请在后台「地图配置」选择浏览器直连；服务器代理需要服务器端密钥';
  }
  return generic;
}
import { tiandituWmtsUrl } from '../shared/tianditu.mjs';
