import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { resources, resourceMap } from '../shared/catalog.mjs';
import { openDatabase, decodeRecord, insertRecord, audit, transaction } from './database.mjs';
import { tiandituTileUrl, tiandituErrorMessage } from './tianditu.mjs';
import { validateMapSettings } from '../shared/map-settings.mjs';
import { createMapSettingsStore } from './map-settings.mjs';
import { validatePolygon, pointInPolygon, pointInBounds } from '../shared/spatial.mjs';
import { createImageryService } from './imagery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireThat(condition, status, message) { if (!condition) throw new HttpError(status, message); }
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex'));
}
function validPassword(password) {
  requireThat(typeof password === 'string' && password.length >= 12 && password.length <= 128, 400, '密码长度须为 12–128 个字符');
}
function integerQuery(url, key, fallback, max) {
  const text = url.searchParams.get(key);
  if (text === null) return fallback;
  const value = Number(text);
  requireThat(/^\d+$/.test(text) && Number.isSafeInteger(value) && value >= 1 && value <= max, 400, `${key} 参数无效`);
  return value;
}
function validate(def, input, partial = false) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 400, '请求必须为 JSON 对象');
  const allowed = new Set(def.fields.map(field => field.key));
  for (const key of Object.keys(input)) requireThat(allowed.has(key), 400, `未知字段：${key}`);
  const result = {};
  for (const field of def.fields) {
    let value = input[field.key];
    if (value === undefined && partial) continue;
    if (value === undefined && field.default !== undefined) value = field.default;
    if (value === undefined || value === '') {
      requireThat(!field.required, 400, `${field.label}不能为空`);
      if (value === '') result[field.key] = '';
      continue;
    }
    if (field.type === 'number') {
      requireThat(typeof value === 'number' && Number.isFinite(value), 400, `${field.label}必须为数字`);
      requireThat((field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max) && (!field.integer || Number.isInteger(value)), 400, `${field.label}超出范围`);
    } else if (field.type === 'json') {
      requireThat(value !== null && typeof value === 'object' && JSON.stringify(value).length <= 20000, 400, `${field.label}必须为有效 JSON 对象或数组`);
      if (field.key === 'waypoints') {
        requireThat(Array.isArray(value) && value.length >= 2 && value.length <= 500, 400, '航线须包含 2–500 个航点');
        for (const point of value) {
          requireThat(point && typeof point === 'object' && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180 && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.altitude) && point.altitude > 0 && point.altitude <= 500, 400, '航点经纬度或航高无效');
        }
      }
    } else {
      requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= (field.maxLength || 500), 400, `${field.label}格式或长度无效`);
      value = value.trim();
      if (field.type === 'select') requireThat(field.options.includes(value), 400, `${field.label}选项无效`);
      if (field.type === 'datetime') requireThat(Number.isFinite(Date.parse(value)), 400, `${field.label}日期无效`);
      if (field.type === 'url') {
        let parsed;
        try { parsed = new URL(value); } catch { throw new HttpError(400, `${field.label}地址无效`); }
        requireThat(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 400, '仅支持不含凭据的 HTTP(S) 地址');
      }
    }
    result[field.key] = value;
  }
  return result;
}

export function createApplication({ databasePath = resolve(root, 'data', 'platform.sqlite'), publicOrigin = '', tiandituToken = '', settingsKey = '', tileFetch = fetch, imagery: imageryOptions = {} } = {}) {
  const db = openDatabase(databasePath);
  const mapSettings = createMapSettingsStore(db, databasePath, tiandituToken, settingsKey);
  const imagery = createImageryService(db, databasePath, imageryOptions, HttpError);
  const attempts = new Map();
  let activeTiles = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self' https: http:; media-src 'self' blob: https: http:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    let requestId = randomUUID();
    function send(status, value) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    }
    try {
      const host = req.headers.host || '';
      const isLocalHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
      requireThat(isLocalHost || (publicOrigin && new URL(publicOrigin).host === host), 403, '不允许的主机名');
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;
      const method = req.method;
      if (!path.startsWith('/api/')) {
        requireThat(method === 'GET' || method === 'HEAD', 405, '不支持此方法');
        let base = resolve(root, 'public');
        let relative = decodeURIComponent(path);
        if (relative.startsWith('/shared/')) { base = resolve(root, 'shared'); relative = relative.slice('/shared'.length); }
        if (relative.startsWith('/vendor/cesium/')) {
          const bundled = resolve(root, 'public', 'vendor', 'cesium');
          base = existsSync(bundled) ? bundled : resolve(root, 'node_modules', 'cesium', 'Build', 'Cesium');
          relative = relative.slice('/vendor/cesium'.length);
        }
        if (relative === '/') relative = '/index.html';
        const file = resolve(base, `.${relative}`);
        requireThat(file.startsWith(base + sep), 403, '禁止访问');
        const allowedExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.wasm', '.ktx2', '.woff', '.woff2', '.ico']);
        requireThat(allowedExtensions.has(extname(file)), 404, '资源不存在');
        let info;
        try { info = await stat(file); } catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, '资源不存在'); throw error; }
        requireThat(info.isFile(), 404, '资源不存在');
        const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm' };
        res.writeHead(200, { 'Content-Type': (mime[extname(file)] || 'application/octet-stream') + (['.html', '.css', '.js', '.mjs'].includes(extname(file)) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-cache' });
        res.end(method === 'HEAD' ? undefined : await readFile(file));
        return;
      }
      const mutation = !['GET', 'HEAD'].includes(method);
      if (mutation) {
        const expectedOrigin = publicOrigin || `http://${host}`;
        requireThat(req.headers.origin === expectedOrigin, 403, '请求来源校验失败');
      }
      let body = {};
      const imageryUpload = method === 'POST' && /^\/api\/imagery\/missions\/[a-f0-9-]{36}\/(photos|panorama|orthophoto)$/.test(path);
      if (imageryUpload) requireThat((req.headers['content-type'] || '').startsWith('application/octet-stream'), 415, '影像文件上传请使用 application/octet-stream');
      if (mutation && !imageryUpload) {
        requireThat((req.headers['content-type'] || '').startsWith('application/json'), 415, '请使用 application/json');
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          requireThat(size <= 65536, 413, '请求超过 64KB');
          chunks.push(chunk);
        }
        if (size) {
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'JSON 格式无效'); }
          requireThat(body && typeof body === 'object' && !Array.isArray(body), 400, '请求必须为对象');
        }
      }
      const needsSetup = () => !db.prepare("SELECT id FROM users WHERE role='admin'").get();
      if (path === '/api/health' && method === 'GET') return send(200, { status: 'ok', version: '0.1.0', needsSetup: needsSetup(), demo: true });
      function checkAttempts() {
        const now = Date.now();
        for (const [key, value] of attempts) if (value.expires < now) attempts.delete(key);
        const key = req.socket.remoteAddress;
        const value = attempts.get(key) || { count: 0, expires: now + 10 * 60 * 1000 };
        requireThat(value.count < 15, 429, '登录尝试过多，请稍后重试');
        value.count++;
        attempts.set(key, value);
      }
      if (path === '/api/setup' && method === 'POST') {
        requireThat(isLocalHost && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress), 403, '首次初始化仅允许本机访问');
        requireThat(needsSetup(), 409, '管理员已经初始化');
        checkAttempts();
        validPassword(body.password);
        requireThat(typeof body.username === 'string' && /^[a-zA-Z0-9_-]{3,40}$/.test(body.username) && body.username !== 'demo-observer', 400, '账号须为 3–40 位字母、数字、下划线或短横线，且不能使用演示账号名称');
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(randomUUID(), body.username, '本地管理员', 'admin', hashPassword(body.password), new Date().toISOString());
        audit(db, body.username, 'setup', 'accounts', null, '初始化本地管理员');
        return send(201, { message: '管理员已创建，请登录' });
      }
      function createSession(user) {
        const token = randomBytes(32).toString('hex');
        const csrf = randomBytes(32).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token), user.id, csrf, Date.now() + 12 * 60 * 60 * 1000);
        res.setHeader('Set-Cookie', `gongan_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
        return { user: { id: user.id, username: user.username, name: user.name, role: user.role }, csrfToken: csrf };
      }
      if (path === '/api/auth/login' && method === 'POST') {
        checkAttempts();
        requireThat(typeof body.username === 'string' && typeof body.password === 'string' && body.password.length <= 128, 400, '请填写账号和密码');
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(body.username);
        requireThat(user && verifyPassword(body.password, user.password_hash), 401, '账号或密码错误');
        audit(db, user.username, 'login', 'accounts', user.id, '本地账号登录');
        return send(200, createSession(user));
      }
      if (path === '/api/auth/demo' && method === 'POST') {
        checkAttempts();
        let user = db.prepare("SELECT * FROM users WHERE username='demo-observer'").get();
        if (!user) {
          db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(randomUUID(), 'demo-observer', '演示观察员', 'viewer', hashPassword(randomBytes(32).toString('hex')), new Date().toISOString());
          user = db.prepare("SELECT * FROM users WHERE username='demo-observer'").get();
        }
        return send(200, createSession(user));
      }
      const token = /(?:^|;\s*)gongan_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = token && db.prepare('SELECT s.*, u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND expires_at>?').get(digest(token), Date.now());
      requireThat(session, 401, '请先登录');
      const user = { id: session.user_id, username: session.username, name: session.name, role: session.role };
      if (mutation) requireThat(req.headers['x-csrf-token'] === session.csrf, 403, '会话校验失败，请刷新页面');
      const admin = () => requireThat(user.role === 'admin', 403, '需要管理员权限');
      const writer = () => requireThat(user.role === 'admin' || user.role === 'operator', 403, '观察员仅有只读权限');
      if (await imagery.handle({ path, method, url, req, res, body, send, writer, user })) return;
      if (path === '/api/auth/me' && method === 'GET') return send(200, { user, csrfToken: session.csrf });
      if (path === '/api/map/config' && method === 'GET') return send(200, mapSettings.read().publicConfig);
      if (path === '/api/admin/map') {
        admin();
        if (method === 'GET') return send(200, mapSettings.read().adminConfig);
        if (method === 'PUT') {
          transaction(db, () => {
            const previous = mapSettings.read();
            let parameters;
            try { parameters = validateMapSettings(body, previous.publicConfig.accessMode); }
            catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
            requireThat(req.headers['if-match'] !== undefined, 428, '请携带地图配置版本号');
            requireThat(req.headers['if-match'] === String(previous.adminConfig.version), 409, '地图配置已被其他管理员修改，请重新加载后保存');
            mapSettings.save(parameters, body, previous);
            audit(db, user.username, 'configure', 'map', null, `保存地图参数；接入方式：${parameters.accessMode}；密钥操作：${body.tokenAction}（不记录密钥内容）`);
          });
          return send(200, { ...mapSettings.read().adminConfig, message: '地图配置已保存，新打开或刷新的地图立即生效' });
        }
      }
      if (path.startsWith('/api/map/tiles/') && method === 'GET') {
        const tile = /^\/api\/map\/tiles\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
        requireThat(tile, 400, '天地图瓦片参数无效');
        const { token: mapToken, publicConfig } = mapSettings.read();
        let upstream;
        try { upstream = tiandituTileUrl(tile[1], Number(tile[2]), Number(tile[3]), Number(tile[4]), mapToken); }
        catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
        requireThat(Number(tile[2]) >= publicConfig.minimumLevel && Number(tile[2]) <= publicConfig.maximumLevel, 400, '瓦片层级超出管理员配置范围');
        requireThat(mapToken, 503, publicConfig.message);
        requireThat(publicConfig.accessMode === 'server', 400, '浏览器端密钥使用天地图直连，不能通过服务器代理请求瓦片');
        requireThat(activeTiles < 32, 429, '地图请求过多，请稍后重试');
        activeTiles++;
        try {
          let result;
          try { result = await tileFetch(upstream, { signal: AbortSignal.timeout(10000), redirect: 'error' }); }
          catch { throw new HttpError(502, '天地图服务连接失败，请检查网络及服务授权'); }
          if (!result.ok) throw new HttpError(502, await tiandituErrorMessage(result));
          const upstreamType = (result.headers.get('content-type') || '').split(';')[0].toLowerCase();
          const type = upstreamType === 'image/jpg' ? 'image/jpeg' : upstreamType;
          requireThat(['image/png', 'image/jpeg', 'image/webp'].includes(type), 502, '天地图未返回有效影像，请检查密钥及服务权限');
          const reader = result.body?.getReader();
          requireThat(reader, 502, '天地图影像为空');
          const chunks = [];
          let size = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              requireThat(size <= 2 * 1024 * 1024, 502, '天地图瓦片超过大小限制');
              chunks.push(Buffer.from(chunk.value));
            }
          } finally { await reader.cancel(); }
          requireThat(size > 0, 502, '天地图影像为空');
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' });
          res.end(Buffer.concat(chunks));
          return;
        } finally { activeTiles--; }
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
        res.setHeader('Set-Cookie', 'gongan_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(200, { message: '已退出' });
      }
      if (path === '/api/auth/password' && method === 'PUT') {
        requireThat(user.username !== 'demo-observer', 403, '演示账号不能修改密码');
        validPassword(body.password);
        requireThat(typeof body.currentPassword === 'string' && body.currentPassword.length <= 128, 400, '请输入当前密码');
        const current = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
        requireThat(verifyPassword(body.currentPassword, current.password_hash), 403, '当前密码错误');
        transaction(db, () => {
          db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(body.password), user.id);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
          audit(db, user.username, 'password', 'accounts', user.id, '修改密码并注销全部会话');
        });
        return send(200, { message: '密码已修改，请重新登录' });
      }
      if (path === '/api/catalog' && method === 'GET') return send(200, { resources: resources.filter(def => !def.adminOnly || user.role === 'admin') });
      function listRows(resource, extraWhere = '', extraArgs = [], order = 'created_at DESC,id') {
        const page = integerQuery(url, 'page', 1, 100000);
        const pageSize = integerQuery(url, 'pageSize', 20, 200);
        const where = ['resource=?', ...extraWhere ? [extraWhere] : []];
        const args = [resource, ...extraArgs];
        for (const key of ['status', 'district']) {
          const value = url.searchParams.get(key);
          if (value) { where.push(`${key}=?`); args.push(value); }
        }
        const q = url.searchParams.get('q')?.trim();
        if (q) {
          requireThat(q.length <= 100, 400, '查询词过长');
          where.push(`(name LIKE ? ESCAPE '\\' OR json_extract(payload,'$.source') LIKE ? ESCAPE '\\'${resource === 'captures' ? " OR json_extract(payload,'$.cameraCode') LIKE ? ESCAPE '\\'" : ''})`);
          const escaped = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
          args.push(escaped, escaped);
          if (resource === 'captures') args.push(escaped);
        }
        const clause = where.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) total FROM records WHERE ${clause}`).get(...args).total;
        const items = db.prepare(`SELECT * FROM records WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize).map(decodeRecord);
        return { items, total, page, pageSize };
      }
      if (path === '/api/search' && method === 'GET') {
        const where = [];
        const args = [];
        for (const key of ['type', 'gender', 'color', 'age']) {
          const value = url.searchParams.get(key);
          if (value) { where.push(`json_extract(payload,'$.${key}')=?`); args.push(value); }
        }
        if (url.searchParams.has('minConfidence')) {
          const minimum = Number(url.searchParams.get('minConfidence'));
          requireThat(Number.isFinite(minimum) && minimum >= 0 && minimum <= 100, 400, '置信度无效');
          where.push("json_extract(payload,'$.confidence')>=?"); args.push(minimum);
        }
        for (const [key, operator] of [['from', '>='], ['to', '<=']]) {
          const value = url.searchParams.get(key);
          if (value) {
            requireThat(Number.isFinite(Date.parse(value)), 400, '时间范围无效');
            where.push(`julianday(json_extract(payload,'$.occurredAt'))${operator}julianday(?)`); args.push(new Date(value).toISOString());
          }
        }
        const from = url.searchParams.get('from'), to = url.searchParams.get('to');
        requireThat(!from || !to || Date.parse(from) <= Date.parse(to), 400, '开始时间不能晚于结束时间');
        let region, polygon, cameraSelection;
        const bounds = ['west', 'east', 'south', 'north'];
        if (bounds.some(key => url.searchParams.has(key))) {
          const values = bounds.map(key => {
            const text = url.searchParams.get(key);
            requireThat(text !== null && text.trim() !== '' && Number.isFinite(Number(text)), 400, '框选范围须包含有效的四个边界');
            return Number(text);
          });
          const [west, east, south, north] = values;
          requireThat(Math.abs(west) <= 180 && Math.abs(east) <= 180 && Math.abs(south) <= 90 && Math.abs(north) <= 90 && south <= north, 400, '框选经纬度范围无效');
          region = { west, east, south, north };
        }
        if (url.searchParams.has('polygon')) {
          requireThat(!region, 400, '不能同时提交多边形和矩形范围');
          const text = url.searchParams.get('polygon');
          requireThat(text.length <= 8000, 400, '多边形顶点过多');
          try { polygon = validatePolygon(JSON.parse(text)); } catch (error) { throw new HttpError(400, `多边形范围无效：${error.message}`); }
        }
        if (url.searchParams.has('cameraScope')) {
          requireThat(url.searchParams.get('cameraScope') === '1' && (region || polygon), 400, '摄像头范围检索须指定有效范围');
          const cameras = db.prepare("SELECT * FROM records WHERE resource='cameras'").all().map(decodeRecord);
          const selected = cameras.filter(camera => polygon ? pointInPolygon(camera.longitude, camera.latitude, polygon) : pointInBounds(camera.longitude, camera.latitude, region));
          const counts = new Map();
          for (const camera of cameras) if (camera.code) counts.set(camera.code, (counts.get(camera.code) || 0) + 1);
          const uniqueCodes = selected.filter(camera => camera.code && counts.get(camera.code) === 1).map(camera => camera.code);
          where.push("(json_extract(payload,'$.cameraId') IN (SELECT value FROM json_each(?)) OR (length(trim(COALESCE(json_extract(payload,'$.cameraId'),'')))=0 AND json_extract(payload,'$.cameraCode') IN (SELECT value FROM json_each(?))))");
          args.push(JSON.stringify(selected.map(camera => camera.id)), JSON.stringify(uniqueCodes));
          cameraSelection = { total: selected.length, items: selected.map(({ id, name, code, longitude, latitude, status }) => ({ id, name, code, longitude, latitude, status })) };
        } else if (polygon) {
          throw new HttpError(400, '多边形检索须启用摄像头范围检索');
        } else if (region) {
          where.push(`(json_extract(payload,'$.longitude')>=? ${region.west <= region.east ? 'AND' : 'OR'} json_extract(payload,'$.longitude')<=?) AND json_extract(payload,'$.latitude')>=? AND json_extract(payload,'$.latitude')<=?`);
          args.push(region.west, region.east, region.south, region.north);
        }
        if (url.searchParams.has('imageOnly')) {
          requireThat(url.searchParams.get('imageOnly') === '1', 400, '图像筛选参数无效');
          where.push("length(trim(COALESCE(json_extract(payload,'$.imageUrl'),'')))>0");
        }
        const orders = {
          'time-desc': "julianday(json_extract(payload,'$.occurredAt')) DESC,id",
          'time-asc': "julianday(json_extract(payload,'$.occurredAt')) ASC,id",
          'confidence-desc': "json_extract(payload,'$.confidence') DESC,julianday(json_extract(payload,'$.occurredAt')) DESC,id",
        };
        const sort = url.searchParams.get('sort') || 'time-desc';
        requireThat(Object.hasOwn(orders, sort), 400, '排序方式无效');
        const result = listRows('captures', where.join(' AND '), args, orders[sort]);
        return send(200, { ...result, ...(cameraSelection ? { cameraSelection } : {}) });
      }
      if (path === '/api/dashboard' && method === 'GET') {
        const counts = Object.fromEntries(db.prepare('SELECT resource,COUNT(*) total FROM records GROUP BY resource').all().map(row => [row.resource, row.total]));
        const cameras = db.prepare("SELECT COUNT(*) total FROM records WHERE resource='cameras' AND status='online'").get().total;
        const pending = db.prepare("SELECT COUNT(*) total FROM records WHERE resource='alerts' AND status='pending'").get().total;
        const running = db.prepare("SELECT COUNT(*) total FROM records WHERE resource='controls' AND status='running'").get().total;
        const runningJobs = db.prepare("SELECT COUNT(*) total FROM records WHERE resource='jobs' AND status='running'").get().total;
        if (user.role === 'admin') {
          counts.accounts = db.prepare("SELECT COUNT(*) total FROM users WHERE username<>'demo-observer'").get().total;
          counts.logs = db.prepare('SELECT COUNT(*) total FROM audit').get().total;
        }
        const recentAudit = user.role === 'admin' ? db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 8').all() : [];
        const recent = db.prepare("SELECT * FROM records WHERE resource='alerts' ORDER BY json_extract(payload,'$.occurredAt') DESC LIMIT 10").all().map(decodeRecord);
        const hourly = Array.from({ length: 24 }, (_, index) => {
          const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() - (23 - index));
          const end = new Date(start.getTime() + 3600000);
          const total = db.prepare("SELECT COUNT(*) total FROM records WHERE resource='alerts' AND json_extract(payload,'$.occurredAt')>=? AND json_extract(payload,'$.occurredAt')<?").get(start.toISOString(), end.toISOString()).total;
          return { hour: start.getHours(), total };
        });
        const targetHourly = hourly.map(({ hour }, index) => {
          const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() - (23 - index));
          const end = new Date(start.getTime() + 3600000);
          const totals = db.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN json_extract(payload,'$.type')='face' THEN 1 ELSE 0 END),0) faceTotal FROM records WHERE resource='captures' AND json_extract(payload,'$.occurredAt')>=? AND json_extract(payload,'$.occurredAt')<?").get(start.toISOString(), end.toISOString());
          return { hour, total: totals.total, faceTotal: totals.faceTotal };
        });
        const composition = db.prepare("SELECT json_extract(payload,'$.type') type,COUNT(*) total FROM records WHERE resource='captures' GROUP BY json_extract(payload,'$.type')").all();
        const topDistricts = db.prepare("SELECT district,COUNT(*) total FROM records WHERE resource='captures' GROUP BY district ORDER BY total DESC,district LIMIT 3").all();
        const recentCaptures = db.prepare("SELECT * FROM records WHERE resource='captures' ORDER BY json_extract(payload,'$.occurredAt') DESC LIMIT 8").all().map(decodeRecord);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const todayTargets = db.prepare("SELECT COUNT(*) total FROM records WHERE resource='captures' AND json_extract(payload,'$.occurredAt')>=?").get(today.toISOString()).total;
        return send(200, { counts, onlineCameras: cameras, pendingAlerts: pending, runningControls: running, runningJobs, recentAudit, recentAlerts: recent, hourly, targetHourly, composition, topDistricts, recentCaptures, todayTargets, updatedAt: new Date().toISOString(), integrations: { dji: false, ai: false, video: false }, demo: true });
      }
      if ((path === '/api/audit' || path === '/api/resources/logs') && method === 'GET') {
        admin();
        const page = integerQuery(url, 'page', 1, 100000), pageSize = integerQuery(url, 'pageSize', 20, 200);
        return send(200, { items: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize), total: db.prepare('SELECT COUNT(*) total FROM audit').get().total, page, pageSize });
      }
      if (path === '/api/resources/accounts' && method === 'GET') {
        admin();
        const items = db.prepare("SELECT id,username,name,role,created_at AS createdAt FROM users WHERE username<>'demo-observer' ORDER BY created_at").all();
        return send(200, { items, total: items.length, page: 1, pageSize: 200 });
      }
      if (path === '/api/users' && method === 'POST') {
        admin(); validPassword(body.password);
        requireThat(typeof body.username === 'string' && /^[a-zA-Z0-9_-]{3,40}$/.test(body.username) && body.username !== 'demo-observer', 400, '账号格式无效');
        requireThat(['admin', 'operator', 'viewer'].includes(body.role), 400, '角色无效');
        requireThat(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 100, 400, '姓名无效');
        requireThat(!db.prepare('SELECT id FROM users WHERE username=?').get(body.username), 409, '账号已存在');
        const id = randomUUID();
        transaction(db, () => {
          db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id, body.username, body.name.trim(), body.role, hashPassword(body.password), new Date().toISOString());
          audit(db, user.username, 'create', 'accounts', id, `创建 ${body.role} 账号`);
        });
        return send(201, { id, username: body.username, role: body.role, name: body.name });
      }
      if (path === '/api/integrations/dji') {
        admin();
        if (method === 'GET') return send(200, { ...JSON.parse(db.prepare("SELECT payload FROM settings WHERE key='dji'").get().payload), adapterReady: false, hasToken: false, message: 'SDK 适配器尚未接入；此页仅保存非敏感配置。' });
        if (method === 'PUT') {
          requireThat(Object.keys(body).every(key => ['projectId', 'enabled'].includes(key)), 400, '不支持的配置字段；密钥应通过部署环境配置');
          requireThat(typeof body.projectId === 'string' && body.projectId.length <= 100 && body.enabled === false, 400, 'SDK 未接入，不能启用对接');
          const value = { baseUrl: 'https://es-flight-api-cn.djigate.com', projectId: body.projectId.trim(), enabled: false };
          transaction(db, () => {
            db.prepare("UPDATE settings SET payload=? WHERE key='dji'").run(JSON.stringify(value));
            audit(db, user.username, 'configure', 'dji', null, '保存项目 UUID；对接保持禁用');
          });
          return send(200, value);
        }
      }
      if (path.startsWith('/api/integrations/dji/') && method === 'POST') { admin(); throw new HttpError(503, 'DJI 适配器未安装，未向设备发送任何指令'); }
      if (/^\/api\/drones\/[^/]+\/command$/.test(path) && method === 'POST') { writer(); throw new HttpError(503, '未接入真实飞控；飞行指令未执行'); }
      const transition = /^\/api\/alerts\/([^/]+)\/transition$/.exec(path);
      if (transition && method === 'POST') {
        writer();
        const row = db.prepare("SELECT * FROM records WHERE id=? AND resource='alerts'").get(transition[1]);
        requireThat(row, 404, '预警不存在');
        const allowed = { pending: ['acknowledged', 'ignored'], acknowledged: ['resolved', 'ignored'], resolved: [], ignored: [] };
        requireThat(allowed[row.status]?.includes(body.status), 409, '预警状态已变化或不允许此操作，请刷新');
        requireThat(body.note === undefined || (typeof body.note === 'string' && body.note.length <= 2000), 400, '处置说明无效');
        if (['resolved', 'ignored'].includes(body.status)) requireThat(body.note?.trim(), 400, '请填写处置说明');
        const data = { ...JSON.parse(row.payload), status: body.status, note: body.note?.trim() || JSON.parse(row.payload).note || '', handledBy: user.username };
        transaction(db, () => {
          db.prepare('UPDATE records SET payload=?,status=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data), data.status, new Date().toISOString(), row.id);
          audit(db, user.username, 'transition', 'alerts', row.id, `${row.status} → ${data.status}`);
        });
        return send(200, decodeRecord(db.prepare('SELECT * FROM records WHERE id=?').get(row.id)));
      }
      const match = /^\/api\/resources\/([a-z-]+)(?:\/([^/]+))?$/.exec(path);
      if (match) {
        const [, key, id] = match;
        const def = resourceMap[key];
        requireThat(def && !def.special, 404, '资源不存在或需使用专用接口');
        if (def.adminOnly) admin();
        if (method === 'GET') {
          if (!id) return send(200, listRows(key));
          const row = db.prepare('SELECT * FROM records WHERE resource=? AND id=?').get(key, id);
          requireThat(row, 404, '记录不存在');
          return send(200, decodeRecord(row));
        }
        writer();
        if (['system', 'metrics', 'districts', 'composition', 'compute', 'trends', 'analysis-rules', 'events', 'boundaries', 'models'].includes(key)) admin();
        if (method === 'POST' && !id) {
          const value = validate(def, body);
          if (key === 'captures' && value.cameraId) requireThat(db.prepare("SELECT id FROM records WHERE resource='cameras' AND id=?").get(value.cameraId), 400, '关联摄像头不存在，请重新选择');
          if (key === 'alerts') requireThat(value.status === 'pending', 400, '新增预警必须待处置');
          const item = transaction(db, () => {
            const item = insertRecord(db, key, value);
            audit(db, user.username, 'create', key, item.id, `新增${def.label}：${item.name}`);
            return item;
          });
          return send(201, item);
        }
        requireThat(id, 400, '缺少记录 ID');
        const row = db.prepare('SELECT * FROM records WHERE resource=? AND id=?').get(key, id);
        requireThat(row, 404, '记录不存在');
        if (method === 'PATCH') {
          if (req.headers['if-match']) requireThat(String(row.version) === req.headers['if-match'], 409, '记录已被修改，请刷新后重试');
          const changes = validate(def, body, true);
          if (key === 'captures' && changes.cameraId) requireThat(db.prepare("SELECT id FROM records WHERE resource='cameras' AND id=?").get(changes.cameraId), 400, '关联摄像头不存在，请重新选择');
          if (key === 'alerts') requireThat(changes.status === undefined || changes.status === row.status, 400, '请使用签收 / 处置操作更新预警状态');
          const data = { ...JSON.parse(row.payload), ...changes };
          transaction(db, () => {
            db.prepare('UPDATE records SET name=?,status=?,district=?,payload=?,version=version+1,updated_at=? WHERE id=?').run(data.name, data.status || '', data.district || '', JSON.stringify(data), new Date().toISOString(), id);
            audit(db, user.username, 'update', key, id, `更新字段：${Object.keys(changes).join(', ')}`);
          });
          return send(200, decodeRecord(db.prepare('SELECT * FROM records WHERE id=?').get(id)));
        }
        if (method === 'DELETE') {
          admin();
          transaction(db, () => {
            db.prepare('DELETE FROM records WHERE id=?').run(id);
            audit(db, user.username, 'delete', key, id, `删除${def.label}：${row.name}`);
          });
          return send(200, { message: '已删除' });
        }
      }
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error(`[${requestId}] ${req.method} ${req.url}:`, error.message);
      if (!res.headersSent) send(status, { error: status === 500 ? '服务内部错误，请查看服务端日志' : error.message, requestId });
      else res.destroy();
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  return { server, close: () => { imagery.close(); db.close(); } };
}
