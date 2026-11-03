import { randomUUID, createHash } from 'node:crypto';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { open, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { planMission } from '../shared/imagery-plan.mjs';
import { missionKmz } from './imagery-kmz.mjs';
import { audit } from './database.mjs';
import { photoAttitude, photoSelection, JpegIntegrity } from './imagery-photo.mjs';

const maxFile = 100 * 1024 * 1024, maxMissionBytes = 10 * 1024 * 1024 * 1024;
const uuidPattern = '[a-f0-9-]{36}';
function jpegMetadata(data) {
  if (data.length < 4 || data[0] !== 255 || data[1] !== 216) throw new RangeError('只接受实际 JPEG 照片');
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 255) break;
    const marker = data[offset + 1], size = data.readUInt16BE(offset + 2);
    if (size < 2) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && offset + 9 <= data.length) {
      const height = data.readUInt16BE(offset + 5), width = data.readUInt16BE(offset + 7);
      if (!width || !height || width * height > 250000000) throw new RangeError('照片尺寸无效或超过 2.5 亿像素');
      return { width, height };
    }
    offset += size + 2;
  }
  throw new RangeError('JPEG 缺少有效尺寸信息，文件可能损坏');
}
function boundsValue(value) {
  if (!value || !['west', 'east', 'south', 'north'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) ||
    value.west < -180 || value.east > 180 || value.south < -85.05112878 || value.north > 85.05112878 || value.west >= value.east || value.south >= value.north)
    throw new RangeError('影像范围须为有效 Web 墨卡托区域，不支持跨日期变更线');
  return Object.fromEntries(['west', 'south', 'east', 'north'].map(key => [key, value[key]]));
}
function captureTime(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new RangeError('请明确填写实际拍摄时间，不以航线计划时间冒充实际采集时间');
  return new Date(value).toISOString();
}
function assetValue(input, getMission) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new RangeError('成果名称须为 1–100 个字符');
  if (!['ortho', 'panorama'].includes(input.kind) || typeof input.capturedAt !== 'string' || !Number.isFinite(Date.parse(input.capturedAt))) throw new RangeError('成果类型或拍摄日期无效');
  if (input.missionId) getMission(input.missionId);
  if (typeof input.url !== 'string' || input.url.length > 2000) throw new RangeError('成果地址无效');
  let url;
  try { url = new URL(input.url, 'http://local.invalid'); } catch { throw new RangeError('成果地址无效'); }
  if ((!/^https?:\/\//i.test(input.url) && !input.url.startsWith('/api/imagery/files/')) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (input.url.startsWith('/') && !input.url.startsWith('/api/imagery/files/'))) throw new RangeError('仅允许不含凭据的 HTTP(S) 或平台影像文件地址');
  const result = { name: input.name.trim(), kind: input.kind, capturedAt: new Date(input.capturedAt).toISOString(), url: input.url, missionId: input.missionId || null };
  if (input.kind === 'ortho') {
    result.bounds = boundsValue(input.bounds);
    if (!['{z}', '{x}', '{y}'].every(part => input.url.includes(part))) throw new RangeError('正射瓦片地址必须包含 {z}/{x}/{y} 占位符');
    if (!Number.isInteger(input.minimumLevel) || !Number.isInteger(input.maximumLevel) || input.minimumLevel < 0 || input.maximumLevel > 22 || input.minimumLevel > input.maximumLevel || !['xyz', 'tms'].includes(input.tileScheme)) throw new RangeError('瓦片层级或 XYZ/TMS 类型无效');
    const n = 2 ** input.minimumLevel, b = result.bounds;
    const tileX = lon => Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n)));
    const tileY = lat => Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)));
    if ((tileX(b.east) - tileX(b.west) + 1) * (tileY(b.south) - tileY(b.north) + 1) > 4)
      throw new RangeError('最小层级覆盖超过 Cesium 允许的 4 个初始瓦片，请生成更低层级的金字塔并降低最小层级');
    Object.assign(result, { minimumLevel: input.minimumLevel, maximumLevel: input.maximumLevel, tileScheme: input.tileScheme });
  } else {
    if (!Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180 || !Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90 || !Number.isFinite(input.altitude) || input.altitude < 0 || input.altitude > 10000 || !Number.isFinite(input.heading) || input.heading < 0 || input.heading >= 360)
      throw new RangeError('全景点位、海拔和方位角无效');
    Object.assign(result, { longitude: input.longitude, latitude: input.latitude, altitude: input.altitude, heading: input.heading });
  }
  return result;
}

export function createImageryService(db, databasePath, { nodeodmUrl = '', nodeodmToken = '', gdalTranslate = '', gdalInfo = '', gdal2tiles = '', python = '', runCommand, pollMs = 5000, processingTimeoutMs = 6 * 60 * 60 * 1000 } = {}, HttpError) {
  const fail = (status, message) => { throw new HttpError(status, message); };
  const temporary = databasePath === ':memory:';
  const root = temporary ? mkdtempSync(join(tmpdir(), 'gongan-imagery-')) : resolve(dirname(databasePath), 'imagery');
  mkdirSync(root, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS imagery_missions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imagery_photos (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES imagery_missions(id), name TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS imagery_photos_mission ON imagery_photos(mission_id,state);
    CREATE UNIQUE INDEX IF NOT EXISTS imagery_photo_names ON imagery_photos(mission_id,name);
    CREATE TABLE IF NOT EXISTS imagery_assets (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imagery_jobs (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES imagery_missions(id), payload TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  for (const row of db.prepare("SELECT * FROM imagery_jobs WHERE status IN ('queued','running')").all()) {
    const job = JSON.parse(row.payload);
    job.status = 'failed'; job.error = '平台重启中断了处理，请人工重试；外部任务可能仍在处理，不会伪报已发布'; job.updatedAt = new Date().toISOString();
    db.prepare('UPDATE imagery_jobs SET payload=?,status=? WHERE id=?').run(JSON.stringify(job), job.status, job.id);
  }
  for (const row of db.prepare("SELECT path FROM imagery_photos WHERE state='uploading'").all()) rmSync(resolve(root, row.path), { force: true });
  db.prepare("DELETE FROM imagery_photos WHERE state='uploading'").run();
  let closed = false, running = false;
  const controller = new AbortController(), children = new Set(), queue = [], uploads = new Set();
  const configuredGdal = () => [gdalTranslate, gdalInfo, gdal2tiles].every(path => path && isAbsolute(path) && existsSync(path)) && (!gdal2tiles.endsWith('.py') || Boolean(python && isAbsolute(python) && existsSync(python)));
  const capabilities = () => ({
    nodeodm: Boolean(nodeodmUrl), gdal: configuredGdal(), dispatch: false, panoramaStitch: false,
    maxFileBytes: maxFile, maxMissionBytes, maxPhotos: 5000,
    message: '本地持久化存储。照片正射处理需配置 NodeODM 与 GDAL；已拼接 GeoTIFF 只需 GDAL。FlightHub 2 自动下发和全景组图拼接未接通；支持发布已拼接的 2:1 全景。',
  });
  const decode = row => row ? { ...JSON.parse(row.payload), id: row.id, createdAt: row.created_at } : null;
  const getMission = id => {
    const result = decode(db.prepare('SELECT * FROM imagery_missions WHERE id=?').get(id));
    if (!result) fail(404, '采集任务不存在');
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(json_extract(payload,'$.viewClass')='nadir'),0) AS selected,
      COALESCE(SUM(json_extract(payload,'$.viewClass')='oblique'),0) AS oblique
      FROM imagery_photos WHERE mission_id=? AND state='ready' AND json_extract(payload,'$.type')='photos'`).get(id);
    result.photoCount = counts.total;
    result.selection = { ...counts, unknown: counts.total - counts.selected - counts.oblique, rule: 'DJI GimbalPitchDegree = −90°±2°' };
    return result;
  };
  const photoList = id => db.prepare("SELECT * FROM imagery_photos WHERE mission_id=? AND state='ready' ORDER BY created_at,id").all(id).map(row => ({
    id: row.id, name: row.name, size: row.size, createdAt: row.created_at, ...JSON.parse(row.payload), url: `/api/imagery/files/${row.id}/image.jpg`,
  }));
  const saveAsset = input => {
    const asset = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    db.prepare('INSERT INTO imagery_assets VALUES (?,?,?)').run(asset.id, JSON.stringify(asset), asset.createdAt);
    return asset;
  };
  const saveJob = (job, update = {}) => {
    if (closed) return;
    Object.assign(job, update, { updatedAt: new Date().toISOString() });
    db.prepare('UPDATE imagery_jobs SET payload=?,status=? WHERE id=?').run(JSON.stringify(job), job.status, job.id);
  };
  function command(executable, args, timeout) {
    if (runCommand) return runCommand(executable, args, timeout);
    return new Promise((resolveCommand, reject) => {
      const child = spawn(executable, args, { windowsHide: true, shell: false, signal: controller.signal });
      children.add(child); let errors = '', output = '';
      child.stdout?.on('data', data => { output = (output + data.toString()).slice(-4 * 1024 * 1024); });
      child.stderr?.on('data', data => { errors = (errors + data.toString()).slice(-4000); });
      const timer = setTimeout(() => child.kill(), timeout);
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer); children.delete(child);
        if (code === 0) resolveCommand(output); else reject(new Error(`影像处理程序退出 (${code})：${errors || '请检查 GDAL 路径和运行日志'}`));
      });
    });
  }
  async function odmRequest(path, options = {}) {
    const url = new URL(path, nodeodmUrl.endsWith('/') ? nodeodmUrl : `${nodeodmUrl}/`);
    if (nodeodmToken) url.searchParams.set('token', nodeodmToken);
    const response = await fetch(url, { ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeout || 120000)]) });
    if (!response.ok) throw new Error(`NodeODM 请求失败 (${response.status})`);
    return response;
  }
  async function runJob(job) {
    const mission = getMission(job.missionId), work = join(root, 'jobs', job.id);
    await mkdir(work, { recursive: true });
    let tif = job.inputPath ? resolve(root, job.inputPath) : join(work, 'orthophoto.tif');
    saveJob(job, { status: 'running', stage: 'prepare', progress: 0 });
    const deadline = Date.now() + processingTimeoutMs;
    if (!job.inputPath) {
      const options = new FormData();
      options.append('name', mission.name);
      options.append('options', JSON.stringify([
        { name: 'fast-orthophoto', value: true }, { name: 'skip-report', value: true }, { name: 'orthophoto-resolution', value: 10 }, { name: 'feature-quality', value: 'low' },
      ]));
      const init = await (await odmRequest('task/new/init', { method: 'POST', body: options })).json();
      if (!init.uuid || typeof init.uuid !== 'string' || !/^[a-zA-Z0-9-]+$/.test(init.uuid)) throw new Error('NodeODM 未返回有效任务 UUID');
      saveJob(job, { remoteTaskId: init.uuid, stage: 'upload' });
      const selectedIds = new Set(job.photoIds), selectedPhotos = photoList(mission.id).filter(item => selectedIds.has(item.id));
      if (selectedPhotos.length !== selectedIds.size || selectedPhotos.length < 3) throw new Error('已选照片清单不完整，请核对文件后重新提交');
      for (const photo of selectedPhotos) {
        const row = db.prepare('SELECT path FROM imagery_photos WHERE id=?').get(photo.id);
        const form = new FormData();
        form.append('images', await openAsFile(resolve(root, row.path)), `${photo.id}.jpg`);
        const uploaded = await (await odmRequest(`task/new/upload/${init.uuid}`, { method: 'POST', body: form })).json();
        if (uploaded.error || uploaded.success !== true) throw new Error('NodeODM 拒绝照片，请检查照片和任务日志');
      }
      const commit = await (await odmRequest(`task/new/commit/${init.uuid}`, { method: 'POST' })).json();
      if (commit.error || commit.uuid !== init.uuid) throw new Error('NodeODM 任务提交失败或任务 UUID 不匹配');
      saveJob(job, { stage: 'orthomosaic' });
      while (true) {
        if (Date.now() > deadline) throw new Error('正射拼接超过处理时限，请检查 NodeODM 任务');
        const info = await (await odmRequest(`task/${init.uuid}/info`)).json();
        if (info.status?.code === 40) break;
        if ([30, 50].includes(info.status?.code) || info.error) throw new Error(`NodeODM 处理失败或被取消：${String(info.lastError || info.error || '请检查照片定位、重叠和外部任务日志').slice(0, 1000)}`);
        saveJob(job, { progress: Math.max(0, Math.min(80, Number(info.progress || 0) * .8)) });
        await sleep(pollMs, undefined, { signal: controller.signal });
      }
      saveJob(job, { stage: 'download', progress: 80 });
      const response = await odmRequest(`task/${init.uuid}/download/all.zip`, { timeout: 600000 });
      if (response.headers.get('content-type')?.includes('application/json')) {
        const result = await response.json();
        throw new Error(`NodeODM 成果下载失败：${String(result.error || '引擎未返回二进制成果').slice(0, 1000)}`);
      }
      if (!response.body) throw new Error('NodeODM 未返回成果文件内容');
      const archive = join(work, 'all.zip');
      let downloaded = 0, signature = Buffer.alloc(0);
      const handle = await open(archive, 'wx');
      try {
        for await (const chunk of response.body) {
          downloaded += chunk.length;
          if (downloaded > 4 * 1024 * 1024 * 1024) throw new Error('正射文件超过 4 GB 限额');
          if (signature.length < 4) {
            signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
            if (signature.length === 4 && signature.readUInt32LE(0) !== 0x04034b50) throw new Error('NodeODM 成果不是有效 ZIP 文件，未进入 GDAL 处理');
          }
          await handle.writeFile(chunk);
        }
      } finally { await handle.close(); }
      if (signature.length < 4) throw new Error('NodeODM 成果 ZIP 文件不完整');
      tif = `/vsizip/${archive.replaceAll('\\', '/')}/odm_orthophoto/odm_orthophoto.tif`;
    }
    const tiles = join(work, 'tiles'), normalized = join(work, 'normalized.tif');
    saveJob(job, { stage: 'normalize', progress: 85 });
    await command(gdalTranslate, ['-of', 'GTiff', '-ot', 'Byte', '-scale', '-co', 'TILED=YES', '-co', 'COMPRESS=DEFLATE', tif, normalized], 600000);
    const metadata = JSON.parse(await command(gdalInfo, ['-json', normalized], 120000));
    const extent = metadata.wgs84Extent?.coordinates?.flat();
    if (!Array.isArray(extent) || !extent.length || extent.some(point => !Array.isArray(point) || point.length < 2)) throw new Error('GeoTIFF 缺少有效地理参考，不能发布到 Cesium');
    const bounds = boundsValue({ west: Math.min(...extent.map(p => p[0])), south: Math.min(...extent.map(p => p[1])), east: Math.max(...extent.map(p => p[0])), north: Math.max(...extent.map(p => p[1])) });
    saveJob(job, { stage: 'tiles', progress: 90 });
    const tileProgram = gdal2tiles.endsWith('.py') ? python : gdal2tiles;
    const tilePrefix = gdal2tiles.endsWith('.py') ? [gdal2tiles] : [];
    const tileHelp = await command(tileProgram, [...tilePrefix, '--help'], 120000);
    const tileArgs = ['--xyz', '--webviewer=none', '--processes=2', '-z', '0-21', normalized, tiles];
    if (/^\s*--legacy(?:\s|,|$)/m.test(tileHelp)) tileArgs.unshift('--legacy');
    await command(tileProgram, [...tilePrefix, ...tileArgs], Math.max(60000, deadline - Date.now()));
    const levels = new Set((await readdir(tiles, { recursive: true })).flatMap(name => {
      const match = /^(\d+)[\\/]\d+[\\/]\d+\.png$/.exec(name);
      return match ? [Number(match[1])] : [];
    }));
    if (Array.from({ length: 22 }, (_, level) => level).some(level => !levels.has(level)))
      throw new Error('切片未生成完整的 0–21 级 PNG 金字塔（含透明无数据瓦片），成果未发布；请检查 GDAL 完整切片模式');
    const asset = saveAsset({ name: `${mission.name} · 正射`, kind: 'ortho', missionId: mission.id, capturedAt: job.capturedAt, bounds,
      minimumLevel: 0, maximumLevel: 21, tileScheme: 'xyz', storageJobId: job.id, processingMode: job.inputPath ? 'geotiff' : 'nadir-dom',
      ...(job.selection ? { selection: job.selection } : {}), url: `/api/imagery/files/${job.id}/tiles/{z}/{x}/{y}.png` });
    saveJob(job, { status: 'completed', stage: 'published', progress: 100, assetId: asset.id });
    audit(db, job.actor, 'publish', 'imagery', asset.id, '实际正射拼接/切片成果已发布');
  }
  async function drain() {
    if (running || closed) return;
    running = true;
    try {
      while (queue.length && !closed) {
        const job = queue.shift();
        try { await runJob(job); }
        catch (error) {
          if (closed) break;
          console.error(`Imagery job ${job.id}: ${error.message}`);
          saveJob(job, { status: 'failed', error: error.message });
          audit(db, job.actor, 'processing-failed', 'imagery', job.id, `阶段 ${job.stage} 失败；请检查处理服务`);
        }
      }
    } finally { running = false; }
  }
  function enqueue(mission, user, inputPath, capturedAt) {
    if (!configuredGdal()) fail(503, 'GDAL 切片服务未配置：请设置 IMAGERY_GDAL_TRANSLATE、IMAGERY_GDAL_INFO、IMAGERY_GDAL2TILES 绝对路径（.py 脚本还需 IMAGERY_PYTHON）');
    if (!inputPath && !nodeodmUrl) fail(503, 'NodeODM 拼接服务未配置：请部署后设置 IMAGERY_NODEODM_URL');
    if (!inputPath && mission.kind !== 'ortho') fail(409, '全景组图拼接引擎尚未接入，请先上传已拼接的 2:1 全景成果');
    const selection = !inputPath ? photoSelection(photoList(mission.id)) : null;
    if (selection && selection.summary.selected < 3) fail(400, `快速 DOM 至少需要 3 张下视照片（−90°±2°）；当前下视 ${selection.summary.selected}、倾斜 ${selection.summary.oblique}、姿态未知 ${selection.summary.unknown}。未知姿态不自动选入，且需确认 GPS 与重叠率`);
    if (db.prepare("SELECT id FROM imagery_jobs WHERE mission_id=? AND status IN ('queued','running')").get(mission.id)) fail(409, '该任务已有排队或运行中的处理作业');
    const job = { id: randomUUID(), missionId: mission.id, name: mission.name, actor: user.username, capturedAt: captureTime(capturedAt), status: 'queued', stage: 'queued', progress: 0, createdAt: new Date().toISOString(),
      ...(inputPath ? { inputPath } : { photoIds: selection.photoIds, selection: selection.summary, processingMode: 'nadir-dom' }) };
    db.prepare('INSERT INTO imagery_jobs VALUES (?,?,?,?,?)').run(job.id, mission.id, JSON.stringify(job), job.status, job.createdAt);
    queue.push(job); audit(db, user.username, 'process', 'imagery', mission.id, '提交实际影像处理队列'); setImmediate(drain);
    return job;
  }
  async function upload(req, mission, filename, type) {
    if (uploads.size >= 4) fail(429, '同时最多上传 4 个文件，请稍后重试');
    if (!filename || filename.length > 1000 || /[\\:\x00-\x1f]/.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..')) fail(400, '文件名须为有效相对路径，不能包含盘符、空目录或 ..');
    if (db.prepare('SELECT id FROM imagery_photos WHERE mission_id=? AND name=?').get(mission.id, filename)) fail(409, '任务中已有同名文件，请核对上传清单，不要重复上传；不同照片请先重命名');
    const quota = db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(size),0) AS bytes FROM imagery_photos WHERE mission_id=?').get(mission.id);
    if (quota.total >= 5000 || quota.bytes + maxFile > maxMissionBytes) fail(413, '任务超过 5000 个文件或 10 GB 存储配额');
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxFile) fail(413, '单文件不能超过 100 MB');
    const id = randomUUID(), relative = join('uploads', `${id}${type === 'orthophoto' ? '.tif' : '.jpg'}`), target = resolve(root, relative), createdAt = new Date().toISOString();
    await mkdir(dirname(target), { recursive: true });
    try { db.prepare('INSERT INTO imagery_photos VALUES (?,?,?,?,?,?,?,?)').run(id, mission.id, filename, relative, maxFile, 'uploading', '{}', createdAt); }
    catch (error) { if (error.errcode === 2067) fail(409, '同名文件正在上传，请勿重复提交'); throw error; }
    uploads.add(req);
    const file = await open(target, 'wx');
    let size = 0, headSize = 0, meta; const head = [], jpeg = type === 'orthophoto' ? null : new JpegIntegrity(), hash = createHash('sha256');
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxFile) fail(413, '单文件不能超过 100 MB');
        jpeg?.write(chunk);
        hash.update(chunk);
        if (headSize < 1024 * 1024) { const sample = chunk.subarray(0, 1024 * 1024 - headSize); head.push(sample); headSize += sample.length; }
        await file.write(chunk);
      }
      const prefix = Buffer.concat(head);
      if (closed) throw new Error('服务关闭，上传中断');
      if (type === 'orthophoto') {
        if (!['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(prefix.subarray(0, 4).toString('hex'))) fail(400, '文件不是有效 TIFF / GeoTIFF');
        meta = { type: 'orthophoto' };
      } else {
        meta = { ...jpegMetadata(prefix), ...jpeg.finish() };
        if (type === 'panorama' && Math.abs(meta.width / meta.height - 2) > .02) fail(400, '全景成果必须为 2:1 等距柱状 JPEG');
        meta.type = type;
        if (type === 'photos') Object.assign(meta, photoAttitude(prefix));
      }
      meta.sha256 = hash.digest('hex');
      db.prepare("UPDATE imagery_photos SET size=?,state='ready',payload=? WHERE id=?").run(size, JSON.stringify(meta), id);
      return { id, name: filename, size, createdAt, ...meta, path: relative, url: `/api/imagery/files/${id}/image.jpg` };
    } catch (error) {
      if (!closed) db.prepare('DELETE FROM imagery_photos WHERE id=?').run(id);
      await file.close(); await rm(target, { force: true }); throw error;
    } finally { uploads.delete(req); if (file.fd !== -1) await file.close(); }
  }
  return {
    async handle({ path, method, url, req, res, body, send, writer, user }) {
      if (path !== '/api/imagery' && !path.startsWith('/api/imagery/')) return false;
      try {
        if (path === '/api/imagery' && method === 'GET') {
          const missions = db.prepare('SELECT id FROM imagery_missions ORDER BY created_at DESC LIMIT 200').all().map(row => getMission(row.id));
          send(200, { missions, assets: db.prepare('SELECT * FROM imagery_assets ORDER BY created_at DESC LIMIT 500').all().map(decode), jobs: db.prepare('SELECT * FROM imagery_jobs ORDER BY created_at DESC LIMIT 200').all().map(decode), capabilities: capabilities(), limits: { missions: 200, assets: 500, jobs: 200 } }); return true;
        }
        if (path === '/api/imagery/missions' && method === 'POST') {
          writer(); const mission = { ...planMission(body), id: randomUUID(), photoCount: 0, version: 1, createdAt: new Date().toISOString() };
          db.prepare('INSERT INTO imagery_missions VALUES (?,?,?)').run(mission.id, JSON.stringify(mission), mission.createdAt);
          audit(db, user.username, 'create', 'imagery', mission.id, '创建 M3E 采集规划，未执行飞行'); send(201, mission); return true;
        }
        if (path === '/api/imagery/imports' && method === 'POST') {
          writer();
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) fail(400, '导入任务名称须为 1–100 个字符');
          const mission = { id: randomUUID(), name: body.name.trim(), kind: 'ortho', source: 'import', capturedAt: captureTime(body.capturedAt), polygon: [], plan: null, photoCount: 0, version: 1, createdAt: new Date().toISOString() };
          db.prepare('INSERT INTO imagery_missions VALUES (?,?,?)').run(mission.id, JSON.stringify(mission), mission.createdAt);
          audit(db, user.username, 'import', 'imagery', mission.id, '创建历史照片导入任务，未伪造航线或执行飞行'); send(201, mission); return true;
        }
        if (path === '/api/imagery/assets' && method === 'POST') {
          writer(); const asset = saveAsset(assetValue(body, getMission));
          audit(db, user.username, 'register', 'imagery', asset.id, '登记授权影像地址；不代表第三方服务连通或本平台已处理照片'); send(201, asset); return true;
        }
        const missionMatch = new RegExp(`^/api/imagery/missions/(${uuidPattern})/(route\\.kmz|photos|panorama|orthophoto|process|dispatch)$`).exec(path);
        if (missionMatch) {
          const mission = getMission(missionMatch[1]), action = missionMatch[2];
          if (action === 'route.kmz' && method === 'GET') {
            if (!mission.plan) fail(409, '历史照片导入任务没有飞行航线，不可下载 KMZ');
            const bytes = missionKmz(mission); res.writeHead(200, { 'Content-Type': 'application/vnd.google-earth.kmz', 'Content-Disposition': `attachment; filename="M3E-${mission.id}.kmz"`, 'Cache-Control': 'no-store', 'Content-Length': bytes.length }); res.end(bytes); return true;
          }
          if (action === 'photos' && method === 'GET') { const items = photoList(mission.id); send(200, { items, total: items.length, selection: photoSelection(items).summary }); return true; }
          if (method === 'POST') {
            writer();
            if (action === 'dispatch') fail(503, 'FlightHub 2 自动下发适配器尚未接通，未向机场或飞机发送指令；请下载 KMZ 并在 DJI Pilot 2 核验后人工导入');
            if (action === 'process') { send(202, enqueue(mission, user, undefined, body.capturedAt)); return true; }
            if (['photos', 'panorama', 'orthophoto'].includes(action)) {
              if (action === 'panorama' && !mission.plan) fail(409, '历史照片任务未绑定全景坐标，请使用“登记已有成果”填写实测位置后发布');
              if (action === 'orthophoto' && !configuredGdal()) fail(503, 'GDAL 尚未配置，暂不能将 GeoTIFF 转为可发布瓦片');
              const capturedAt = action !== 'photos' ? captureTime(url.searchParams.get('capturedAt')) : null;
              const photo = await upload(req, mission, url.searchParams.get('filename'), action);
              audit(db, user.username, 'upload', 'imagery', mission.id, `上传 ${action} 文件；${photo.size} 字节`);
              if (action === 'panorama') {
                const longitude = mission.polygon.reduce((s, p) => s + p[0], 0) / mission.polygon.length, latitude = mission.polygon.reduce((s, p) => s + p[1], 0) / mission.polygon.length;
                const asset = saveAsset({ name: `${mission.name} · 全景`, kind: 'panorama', missionId: mission.id, capturedAt, url: photo.url, longitude, latitude, altitude: mission.altitude, heading: mission.heading, positioning: 'mission-estimate', altitudeReference: 'relativeToStartPoint' });
                send(201, asset);
              } else if (action === 'orthophoto') send(202, enqueue(mission, user, photo.path, capturedAt));
              else { const { path: internal, ...publicPhoto } = photo; send(201, publicPhoto); }
              return true;
            }
          }
        }
        if (method === 'GET' && path.startsWith('/api/imagery/files/')) {
          const photoMatch = new RegExp(`^/api/imagery/files/(${uuidPattern})/image\\.jpg$`).exec(path);
          const tileMatch = new RegExp(`^/api/imagery/files/(${uuidPattern})/tiles/(\\d{1,2})/(\\d{1,8})/(\\d{1,8})\\.png$`).exec(path);
          let file, mime;
          if (photoMatch) {
            const photo = db.prepare("SELECT * FROM imagery_photos WHERE id=? AND state='ready'").get(photoMatch[1]);
            if (!photo || JSON.parse(photo.payload).type === 'orthophoto') fail(404, '影像文件不存在');
            file = resolve(root, photo.path); mime = 'image/jpeg';
          } else if (tileMatch) {
            const [, jobId, z, x, y] = tileMatch;
            if (+z > 22 || +x >= 2 ** +z || +y >= 2 ** +z || !db.prepare('SELECT id FROM imagery_assets WHERE json_extract(payload,\'$.storageJobId\')=?').get(jobId)) fail(404, '瓦片不存在');
            file = join(root, 'jobs', jobId, 'tiles', z, x, `${y}.png`); mime = 'image/png';
          } else fail(404, '影像文件不存在');
          let info;
          try { info = await stat(file); } catch (error) { if (error.code === 'ENOENT') fail(404, '影像文件不存在'); throw error; }
          if (!info.isFile()) fail(404, '影像文件不存在');
          res.writeHead(200, { 'Content-Type': mime, 'Content-Length': info.size, 'Cache-Control': 'private,max-age=3600' });
          await pipeline(createReadStream(file), res); return true;
        }
        fail(404, '影像接口不存在');
      } catch (error) { if (error instanceof RangeError) fail(400, error.message); throw error; }
    },
    close() {
      closed = true; controller.abort();
      for (const child of children) child.kill();
      for (const req of uploads) req.destroy();
      if (temporary) rmSync(root, { recursive: true, force: true });
    },
  };
}
async function openAsFile(path) {
  const { openAsBlob } = await import('node:fs');
  return openAsBlob(path, { type: 'image/jpeg' });
}
