import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, resource TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '', district TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL CHECK(json_valid(payload)), demo INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_resource ON records(resource, status, district);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
      resource TEXT NOT NULL, record_id TEXT, summary TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
  `);
  if (!db.prepare("SELECT value FROM metadata WHERE key='seed-version'").get()) seed(db);
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = callback();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function insertRecord(db, resource, payload, demo = false) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO records (id,resource,name,status,district,payload,demo,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, resource, payload.name, payload.status || '', payload.district || '', JSON.stringify(payload), Number(demo), now, now);
  return decodeRecord(db.prepare('SELECT * FROM records WHERE id=?').get(id));
}

export function decodeRecord(row) {
  return row ? { ...JSON.parse(row.payload), id: row.id, demo: Boolean(row.demo), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

export function audit(db, actor, action, resource, id, summary) {
  db.prepare('INSERT INTO audit (actor,action,resource,record_id,summary,created_at) VALUES (?,?,?,?,?,?)')
    .run(actor, action, resource, id || null, summary, new Date().toISOString());
}

function seed(db) {
  transaction(db, () => {
    const areas = ['江北区', '海曙区', '鄞州区'];
    const locations = ['体育中心东广场', '滨江步道', '市民广场', '公园北入口', '会展中心', '交通枢纽', '科技园区', '体育中心西门'];
    const coordinate = i => ({ longitude: 121.516 + Math.sin(i * 2.4) * .028, latitude: 29.954 + Math.cos(i * 1.7) * .018 });
    const at = i => new Date(Date.now() - i * 41 * 60 * 1000).toISOString();
    for (let i = 0; i < 24; i++) {
      insertRecord(db, 'cameras', { name: `演示 · ${locations[i % 8]} ${Math.floor(i / 8) + 1}号点位`, code: `DEMO-CAM-${String(i + 1).padStart(3, '0')}`, district: areas[i % 3], type: ['固定枪机', '球机', '高空瞭望'][i % 3], status: i % 6 ? 'online' : 'offline', ...coordinate(i), videoUrl: '', note: '合成设备记录，在线状态为演示标记，不代表真实连接。' }, true);
    }
    for (let i = 0; i < 9; i++) {
      insertRecord(db, 'controls', { name: `演示 · ${['场馆周界巡查', '重点路段车辆布控', '夜间异常行为巡检', '交通枢纽秩序维护', '滨江步道安全巡查', '商圈夜间巡逻', '园区周界巡检', '赛事安保任务', '停车场视频巡检'][i]}`, type: ['区域巡查', '车辆布控', '行为模型'][i % 3], district: areas[i % 3], status: i === 6 ? 'paused' : 'running', library: '本地演示规则', threshold: 85 + i, hits: i * 3, note: '仅维护任务记录，未启动真实识别或飞行。' }, true);
    }
    for (let i = 0; i < 18; i++) {
      const type = ['人员聚集', '车辆布控', '入侵越界', '烟火识别', '设备异常', '徘徊预警'][i % 6];
      insertRecord(db, 'alerts', { name: `演示 · ${type}`, type, district: areas[i % 3], source: locations[i % 8], status: i < 8 ? 'pending' : i < 13 ? 'acknowledged' : 'resolved', severity: ['high', 'medium', 'low'][i % 3], occurredAt: at(i), confidence: 88 + i % 11, ...coordinate(i), note: '合成预警，不含原站业务数据。' }, true);
    }
    for (let i = 0; i < 48; i++) {
      insertRecord(db, 'captures', { name: `演示抓拍 ${String(i + 1).padStart(3, '0')}`, type: ['face', 'body', 'vehicle', 'bicycle', 'tricycle'][i % 5], district: areas[i % 3], source: locations[i % 8], occurredAt: at(i), confidence: 85 + i % 15, gender: ['未知', '男', '女'][i % 3], color: ['蓝色', '黑色', '白色', '灰色'][i % 4], plate: i % 5 === 2 ? '演示 ****' : '', ...coordinate(i), note: '图形占位，不是真实抓拍或识别结果。' }, true);
    }
    for (let i = 0; i < 2; i++) {
      insertRecord(db, 'drones', { name: `演示无人机 ${i + 1} 号`, serial: `DEMO-UAV-00${i + 1}`, model: i ? 'M350 RTK' : 'M30T', status: 'offline', battery: 90 - i * 12, altitude: 0, speed: 0, ...coordinate(i), videoUrl: '', note: '尚未接入飞控，禁止作为实时遥测使用。' }, true);
    }
    for (let i = 0; i < 3; i++) {
      insertRecord(db, 'docks', { name: `演示机场 ${i + 1}`, serial: `DEMO-DOCK-00${i + 1}`, district: areas[i], status: 'offline', ...coordinate(i + 5) }, true);
      insertRecord(db, 'fences', { name: `演示安全区域 ${i + 1}`, district: areas[i], status: 'enabled', radius: 350 + i * 120, ...coordinate(i + 4) }, true);
      insertRecord(db, 'routes', { name: `演示巡查航线 ${i + 1}`, district: areas[i], status: 'draft', altitude: 80, waypoints: Array.from({ length: 5 }, (_, n) => ({ ...coordinate(n + i), altitude: 80 })) }, true);
      insertRecord(db, 'officers', { name: `演示巡逻组 ${i + 1}`, code: `DEMO-TEAM-${i + 1}`, district: areas[i], status: 'online', team: '演示勤务单位', ...coordinate(i + 6) }, true);
      insertRecord(db, 'jobs', { name: `演示视频解析任务 ${i + 1}`, source: locations[i], algorithm: '待接入算法服务', status: 'draft', progress: 0 }, true);
      insertRecord(db, 'persons', { name: `合成档案 ${i + 1}`, code: `DEMO-PERSON-${i + 1}`, district: areas[i], status: 'active', category: '测试档案', note: '虚构占位，不含真实个人信息。' }, true);
      insertRecord(db, 'hotspots', { name: `演示热点 ${i + 1}`, district: areas[i], status: 'active', count: (i + 1) * 12, ...coordinate(i + 9) }, true);
    }
    insertRecord(db, 'rules', { name: '演示区域聚集规则', type: '人员聚集', status: 'enabled', threshold: 90, note: '配置记录；推理服务未接入。' }, true);
    db.prepare('INSERT INTO settings VALUES (?,?)').run('dji', JSON.stringify({ enabled: false, projectId: '', baseUrl: 'https://es-flight-api-cn.djigate.com' }));
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('seed-version', '1');
  });
}
