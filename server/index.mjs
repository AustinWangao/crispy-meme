import http from 'node:http';
import { openDb } from './db.mjs';
import { createApp } from './app.mjs';
import { createMailer } from './mailer.mjs';

const port = Number(process.env.PORT ?? 8787);
const dbFile = process.env.DB_FILE ?? 'data/replay.sqlite';

let mailer;
try {
  mailer = createMailer(process.env);
} catch (error) {
  console.error(`[replay-api] 启动失败：${error.message}`);
  process.exit(1);
}

const db = openDb(dbFile);
const server = http.createServer(
  createApp({
    db,
    mailer,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    secureCookies: process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production',
  }),
);

server.listen(port, '0.0.0.0', () => {
  console.log(`[replay-api] listening on http://localhost:${port} (db: ${dbFile})`);
  if (mailer.mode === 'dev') {
    console.log('[replay-api] 发信：开发模式，登录链接直接返回给浏览器，请勿用于生产。');
  } else {
    console.log(`[replay-api] 发信：SMTP 已启用，登录链接指向 ${mailer.appOrigin}`);
  }
});
