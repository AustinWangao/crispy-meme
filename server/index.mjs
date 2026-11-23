import http from 'node:http';
import { openDb } from './db.mjs';
import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 8787);
const dbFile = process.env.DB_FILE ?? 'data/replay.sqlite';

const db = openDb(dbFile);
const server = http.createServer(createApp({ db }));

server.listen(port, '0.0.0.0', () => {
  console.log(`[replay-api] listening on http://localhost:${port} (db: ${dbFile})`);
  console.log('[replay-api] 注意：未接入邮件服务，登录链接直接在接口响应里返回。');
});
