export const districts = ['江北区', '海曙区', '鄞州区', '镇海区', '北仑区', '奉化区', '余姚市', '慈溪市', '宁海县', '象山县', '前湾新区', '高新区'];
export const statusLabels = {
  online: '在线', offline: '离线', pending: '待处置', acknowledged: '已签收', resolved: '已处置',
  ignored: '已忽略', running: '运行中', paused: '已暂停', draft: '草稿', completed: '已完成',
  enabled: '已启用', disabled: '已停用', active: '有效', archived: '已归档',
  high: '高危', medium: '中危', low: '低危', face: '人脸', body: '人体', vehicle: '机动车',
  bicycle: '二轮车', tricycle: '三轮车', admin: '管理员', operator: '操作员', viewer: '观察员',
};
const field = (key, label, type = 'text', options = {}) => ({ key, label, type, ...options });
const name = field('name', '名称', 'text', { required: true, maxLength: 100 });
const area = field('district', '所属辖区', 'select', { options: districts });
const location = [
  field('longitude', '经度', 'number', { min: -180, max: 180 }),
  field('latitude', '纬度', 'number', { min: -90, max: 90 }),
];
const status = (options) => field('status', '状态', 'select', { options, default: options[0] });
const note = field('note', '备注', 'textarea', { maxLength: 2000 });
const score = field('confidence', '置信度 (%)', 'number', { min: 0, max: 100 });
const count = field('count', '数量', 'number', { min: 0, integer: true });
const time = field('occurredAt', '发生时间', 'datetime');
const source = field('source', '来源 / 点位');
const types = ['face', 'body', 'vehicle', 'bicycle', 'tricycle'];
const generic = [name, area, status(['active', 'archived']), count, ...location, note];
const resource = (key, label, group, fields = generic, extra = {}) => ({ key, label, group, fields, ...extra });

export const resources = [
  resource('cameras', '视频点位', '视频资源', [name, field('code', '设备编号'), area, status(['offline', 'online']), field('type', '点位类型', 'select', { options: ['固定枪机', '球机', '高空瞭望', '无人机'] }), ...location, field('videoUrl', '视频地址', 'url'), note]),
  resource('camera-types', '点位类型', '视频资源', [name, count, note]),
  resource('captures', '结构化抓拍', '视频资源', [name, field('type', '目标类型', 'select', { options: types }), area, source, field('cameraId', '关联摄像头'), field('cameraCode', '设备编号'), time, score, field('gender', '性别', 'select', { options: ['未知', '男', '女'] }), field('age', '年龄段', 'select', { options: ['未知', '少年', '青年', '中年', '老年'] }), field('color', '上装 / 车身颜色'), field('plate', '车牌（脱敏）'), field('imageUrl', '授权图像地址', 'url'), ...location, note]),
  resource('alerts', '预警记录', '预警布控', [name, field('type', '预警类型', 'select', { options: ['人员聚集', '车辆布控', '入侵越界', '烟火识别', '设备异常', '徘徊预警'] }), area, source, status(['pending', 'acknowledged', 'resolved', 'ignored']), field('severity', '预警等级', 'select', { options: ['high', 'medium', 'low'] }), time, score, ...location, note]),
  resource('rules', '预警规则', '预警布控', [name, field('type', '规则类型'), status(['enabled', 'disabled']), field('threshold', '阈值 (%)', 'number', { min: 0, max: 100 }), note]),
  resource('alert-stats', '预警统计', '预警布控'),
  resource('controls', '布控任务', '预警布控', [name, field('type', '任务类型', 'select', { options: ['区域巡查', '车辆布控', '行为模型', '视频巡检'] }), area, status(['draft', 'running', 'paused', 'completed']), field('library', '关联库 / 模型'), field('threshold', '阈值 (%)', 'number', { min: 0, max: 100, default: 90 }), field('hits', '累计命中', 'number', { min: 0, integer: true, default: 0 }), note]),
  resource('hotspots', '聚集热点', '智能应用'),
  resource('loitering', '徘徊目标', '智能应用'),
  resource('stays', '辖区停留', '智能应用'),
  resource('persons', '人员档案', '智能应用', [name, field('code', '档案编号'), area, status(['active', 'archived']), field('category', '档案分类'), field('imageUrl', '授权图像地址', 'url'), note]),
  resource('archive-summary', '档案概览', '智能应用'),
  resource('topics', '专题档案', '智能应用'),
  resource('companions', '同行分析', '智能应用'),
  resource('footholds', '落脚点', '智能应用'),
  resource('trajectories', '目标轨迹', '智能应用'),
  resource('track-points', '轨迹点位', '智能应用'),
  resource('jobs', '解析任务', '离线与任务', [name, source, field('algorithm', '算法名称'), status(['draft', 'running', 'paused', 'completed']), field('progress', '进度 (%)', 'number', { min: 0, max: 100, default: 0 }), note]),
  resource('offline', '离线解析', '离线与任务', [name, field('videoUrl', '视频地址', 'url'), field('algorithm', '算法名称'), status(['draft', 'running', 'paused', 'completed']), note]),
  resource('system', '系统信息', '大屏配置', [name, field('subtitle', '英文副标题'), note]),
  resource('metrics', '核心指标', '大屏配置', [name, field('value', '数值', 'number'), field('unit', '单位'), note]),
  resource('districts', '辖区配置', '大屏配置'),
  resource('composition', '数据构成', '大屏配置'),
  resource('compute', '算力类型', '大屏配置'),
  resource('trends', '趋势曲线', '大屏配置'),
  resource('analysis-rules', '研判规则', '大屏配置'),
  resource('events', '实时事件流', '大屏配置', [name, area, source, time, note]),
  resource('boundaries', '区域边界', '大屏配置', [name, field('geojson', 'GeoJSON 几何', 'json'), note]),
  resource('officers', '警员警力', '警务执勤', [name, field('code', '警号 / 编号'), area, status(['online', 'offline']), field('team', '所属单位'), ...location, note]),
  resource('models', '三维模型图层', '三维模型', [name, field('url', 'Tileset 地址', 'url'), status(['disabled', 'enabled']), ...location, note]),
  resource('accounts', '账号权限', '系统管理', [name, field('username', '账号'), field('role', '角色', 'select', { options: ['admin', 'operator', 'viewer'] })], { adminOnly: true, special: true }),
  resource('logs', '操作日志', '系统管理', [name], { adminOnly: true, special: true, readOnly: true }),
  resource('drones', '无人机', '无人机管理', [name, field('serial', '飞机 SN'), field('model', '机型'), status(['offline', 'online']), field('battery', '电量 (%)', 'number', { min: 0, max: 100 }), field('altitude', '航高 (m)', 'number', { min: 0, max: 10000 }), field('speed', '航速 (m/s)', 'number', { min: 0, max: 200 }), ...location, field('videoUrl', '授权图传地址', 'url'), note]),
  resource('docks', '无人机场', '无人机管理', [name, field('serial', '机场 SN'), area, status(['offline', 'online']), ...location, note]),
  resource('targets', '重点人员', '无人机管理', [name, field('code', '内部编号'), area, status(['active', 'archived']), note]),
  resource('fences', '电子围栏', '无人机管理', [name, area, status(['enabled', 'disabled']), field('radius', '半径 (m)', 'number', { min: 1, max: 100000 }), ...location, note]),
  resource('routes', '航线', '无人机管理', [name, area, field('altitude', '默认航高 (m)', 'number', { min: 1, max: 500 }), field('waypoints', '航点 [{longitude, latitude, altitude}]', 'json'), status(['draft', 'active', 'archived']), note]),
  resource('cases', '案件', '无人机管理', [name, field('code', '案件编号'), area, status(['pending', 'active', 'archived']), field('owner', '负责人'), note]),
  resource('matches', '比对记录', '无人机管理', [name, source, score, time, status(['pending', 'resolved']), note]),
  resource('ai-tasks', '识别任务', 'AI 识别', [name, source, field('algorithm', '算法名称'), status(['draft', 'running', 'paused', 'completed']), score, note]),
  resource('ai-events', '识别事件', 'AI 识别', [name, source, field('algorithm', '算法名称'), time, score, note]),
];
export const resourceMap = Object.fromEntries(resources.map(item => [item.key, item]));
export const mainNavigation = [
  ['overview', '区域总览', '▦'], ['control', '布控预警', '◈'], ['uav', '无人机巡查', '⌘'],
  ['police', '警务执勤', '◇'], ['search', '综合查询', '⌕'], ['apps', '智能应用', '▧'], ['archives', '档案库', '▤'],
];
export const uavNavigation = [
  ['patrol', '巡查总览', 'PATROL'], ['imagery', '影像采集', 'MAPPING'], ['docks', '机场总览', 'DOCK'], ['controls', '任务管理', 'MISSION'],
  ['cases', '案件管理', 'CASE'], ['fences', '安全管理', 'SAFETY'], ['replay', '飞行回放', 'REPLAY'],
  ['captures', '数据应用', 'DATA'], ['stats', '应用统计', 'STATS'], ['drones', '设备与人员', 'MANAGE'], ['routes', '资源库', 'RESOURCE'],
];
