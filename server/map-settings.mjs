import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { defaultMapSettings } from '../shared/map-settings.mjs';

export function createMapSettingsStore(db, databasePath, environmentToken, encryptionKey = '') {
  let key;
  if (encryptionKey) {
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error('GONGAN_SETTINGS_KEY must be a 64-character hexadecimal key');
    key = Buffer.from(encryptionKey, 'hex');
  }
  function loadKey(create = false) {
    if (key) return key;
    if (databasePath === ':memory:') {
      if (!create) throw new Error('地图配置解密密钥不存在');
      key = randomBytes(32);
      return key;
    }
    const path = `${databasePath}.settings-key`;
    try { key = readFileSync(path); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw new Error('无法读取地图配置解密密钥，请检查数据目录和备份');
      const generated = randomBytes(32);
      try { writeFileSync(path, generated, { flag: 'wx', mode: 0o600 }); key = generated; }
      catch (writeError) {
        if (writeError.code !== 'EEXIST') throw new Error('无法保存地图配置加密密钥，请检查数据目录权限');
        key = readFileSync(path);
      }
    }
    if (key.length !== 32) throw new Error('地图配置加密密钥无效');
    return key;
  }
  function encrypt(token) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', loadKey(true), iv);
    cipher.setAAD(Buffer.from('gongan:map:tianditu:v1'));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: ciphertext.toString('base64') };
  }
  function decrypt(secret) {
    const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(secret.iv, 'base64'));
    decipher.setAAD(Buffer.from('gongan:map:tianditu:v1'));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    try { return Buffer.concat([decipher.update(Buffer.from(secret.value, 'base64')), decipher.final()]).toString('utf8'); }
    catch { throw new Error('地图密钥解密失败，请恢复匹配的配置加密密钥'); }
  }
  function read() {
    const row = db.prepare("SELECT payload FROM settings WHERE key='map'").get();
    const stored = row ? JSON.parse(row.payload) : {};
    const parameters = Object.fromEntries(Object.keys(defaultMapSettings).map(name => [name, stored[name] ?? defaultMapSettings[name]]));
    const tokenMode = stored.tokenMode || 'inherit';
    const token = tokenMode === 'database' ? decrypt(stored.secret) : tokenMode === 'disabled' ? '' : environmentToken.trim();
    const tokenSource = token ? (tokenMode === 'database' ? 'database' : 'environment') : 'none';
    const version = stored.version || 0;
    const publicConfig = {
      ...parameters, version, provider: 'tianditu', configured: Boolean(token),
      ...(parameters.accessMode === 'browser' && token ? { browserToken: token } : {}),
      credit: '© 天地图 · 国家地理信息公共服务平台',
      message: token ? '' : '天地图未配置：请在后台「地图配置」保存密钥，或配置 TIANDITU_TOKEN 并重启服务',
    };
    return {
      stored, token, publicConfig,
      adminConfig: { ...parameters, version, provider: 'tianditu', tokenConfigured: Boolean(token), tokenSource, environmentAvailable: Boolean(environmentToken.trim()) },
    };
  }
  function save(parameters, body, previous) {
    let secret = previous.stored.secret;
    let tokenMode = previous.stored.tokenMode || 'inherit';
    if (body.tokenAction === 'replace') { secret = encrypt(body.token); tokenMode = 'database'; }
    if (body.tokenAction === 'clear') { secret = undefined; tokenMode = 'disabled'; }
    if (body.tokenAction === 'environment') { secret = undefined; tokenMode = 'inherit'; }
    const payload = { ...parameters, tokenMode, secret, version: previous.adminConfig.version + 1 };
    db.prepare("INSERT INTO settings(key,payload) VALUES('map',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(payload));
  }
  return { read, save };
}
