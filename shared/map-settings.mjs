export const mapNumericFields = [
  { key: 'longitude', label: '中心经度', min: -180, max: 180, default: 121.516, step: 'any' },
  { key: 'latitude', label: '中心纬度', min: -85, max: 85, default: 29.954, step: 'any' },
  { key: 'height', label: '视点高度（米）', min: 100, max: 20000000, default: 7800, step: 'any' },
  { key: 'heading', label: '朝向角（度）', min: 0, max: 360, default: 0, step: 'any' },
  { key: 'pitch', label: '俯仰角（度）', min: -90, max: -10, default: -90, step: 'any' },
  { key: 'minimumLevel', label: '最小瓦片层级', min: 1, max: 18, default: 1, step: '1' },
  { key: 'maximumLevel', label: '最大瓦片层级', min: 1, max: 18, default: 18, step: '1' },
];
export const defaultMapSettings = Object.freeze({
  ...Object.fromEntries(mapNumericFields.map(field => [field.key, field.default])),
  defaultBasemap: 'satellite', labelsVisible: true, accessMode: 'server',
});

export function validateMapSettings(body, existingAccessMode = 'server') {
  const allowed = new Set([...Object.keys(defaultMapSettings), 'tokenAction', 'token']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new RangeError('存在不支持的地图配置字段');
  for (const field of mapNumericFields) {
    const value = body[field.key];
    if (!Number.isFinite(value) || value < field.min || value > field.max || (field.step === '1' && !Number.isInteger(value))) {
      throw new RangeError(`${field.label}须在 ${field.min}–${field.max} 范围内${field.step === '1' ? '且为整数' : ''}`);
    }
  }
  if (body.minimumLevel > body.maximumLevel) throw new RangeError('最小瓦片层级不能大于最大瓦片层级');
  if (!['satellite', 'street'].includes(body.defaultBasemap)) throw new RangeError('仅支持天地图影像或矢量底图');
  if (typeof body.labelsVisible !== 'boolean') throw new RangeError('地名注记开关无效');
  const accessMode = body.accessMode ?? existingAccessMode;
  if (!['server', 'browser'].includes(accessMode)) throw new RangeError('地图密钥接入方式无效');
  if (!['keep', 'replace', 'clear', 'environment'].includes(body.tokenAction)) throw new RangeError('密钥操作无效');
  if (body.tokenAction === 'replace') {
    if (typeof body.token !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.token)) throw new RangeError('天地图密钥须为 8–128 位字母、数字、下划线或连字符');
  } else if ('token' in body) throw new RangeError('仅在替换密钥时提交密钥');
  return { ...Object.fromEntries(Object.keys(defaultMapSettings).map(key => [key, body[key]])), accessMode };
}
