import { createApplication } from './server/app.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT || 3221);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
const listenHost = process.env.GONGAN_LISTEN_HOST || '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0', '::1'].includes(listenHost)) throw new Error('GONGAN_LISTEN_HOST must be a loopback address or 0.0.0.0');
const app = createApplication({
  databasePath: process.env.GONGAN_DATABASE, publicOrigin: process.env.GONGAN_PUBLIC_ORIGIN || '', tiandituToken: process.env.TIANDITU_TOKEN || '', settingsKey: process.env.GONGAN_SETTINGS_KEY || '',
  imagery: { nodeodmUrl: process.env.IMAGERY_NODEODM_URL || '', nodeodmToken: process.env.IMAGERY_NODEODM_TOKEN || '',
    gdalTranslate: process.env.IMAGERY_GDAL_TRANSLATE || '', gdalInfo: process.env.IMAGERY_GDAL_INFO || '', gdal2tiles: process.env.IMAGERY_GDAL2TILES || '', python: process.env.IMAGERY_PYTHON || '' },
});
app.server.listen(port, listenHost, () => {
  console.log(`Gongan: http://127.0.0.1:${port}`);
  console.log('First run: create your own local administrator in the browser. Reference-site credentials are not reused.');
});
app.server.on('error', error => { console.error(error); process.exitCode = 1; app.close(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.server.close(() => { app.close(); process.exit(0); }));
