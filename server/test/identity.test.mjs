import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../db.mjs';
import { createApp } from '../app.mjs';
import { createMailer } from '../mailer.mjs';

async function start(options = {}) {
  const db = openDb(':memory:');
  const server = http.createServer(createApp({ db, ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

function client(base, { autoCsrf = true } = {}) {
  const jar = new Map();
  let csrf = '';

  function cookieHeader() {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function absorb(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (attrs.some((attr) => /max-age=0/i.test(attr.trim())) || !value) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function raw(method, path, body, { redirect, ...extraHeaders } = {}) {
    const headers = { ...extraHeaders };
    if (body) headers['content-type'] = 'application/json';
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect,
    });
    absorb(response);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }

  async function ensureCsrf() {
    const response = await raw('GET', '/api/auth/csrf');
    csrf = response.body.csrfToken;
    return csrf;
  }

  async function call(method, path, body, extraHeaders = {}) {
    const unsafe = method !== 'GET' && method !== 'HEAD';
    if (unsafe && autoCsrf && !csrf) await ensureCsrf();
    const headers = unsafe && autoCsrf ? { 'x-csrf-token': csrf, ...extraHeaders } : extraHeaders;
    return raw(method, path, body, headers);
  }

  return {
    get: (path, headers) => call('GET', path, undefined, headers),
    post: (path, body, headers) => call('POST', path, body, headers),
    ensureCsrf,
    raw,
  };
}

async function registerAuthor(base, email = 'author@example.com') {
  const c = client(base);
  const link = await c.post('/api/auth/magic-link', { email });
  assert.equal(link.status, 200);
  const login = await c.post('/api/auth/session', { token: link.body.token });
  assert.equal(login.status, 200);
  return { c, actor: login.body.actor };
}

async function createProjectWithCode(base) {
  const { c } = await registerAuthor(base);
  const project = await c.post('/api/projects', { name: '星轨修理铺' });
  assert.equal(project.status, 201);
  const code = await c.post(`/api/projects/${project.body.projectId}/codes`, { maxUses: 1 });
  assert.equal(code.status, 201);
  return { author: c, projectId: project.body.projectId, code: code.body.code };
}

test('未登录访问 /api/auth/me 返回 401', async () => {
  const app = await start();
  try {
    const response = await client(app.base).get('/api/auth/me');
    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'UNAUTHENTICATED');
  } finally {
    await app.close();
  }
});

test('登录链接一次性，第二次使用被拒绝', async () => {
  const app = await start();
  try {
    const c = client(app.base);
    const link = await c.post('/api/auth/magic-link', { email: 'a@b.com' });
    assert.equal(link.status, 200);
    assert.equal(link.body.deliveredBy, 'dev-response');

    const first = await c.post('/api/auth/session', { token: link.body.token });
    assert.equal(first.status, 200);
    assert.equal(first.body.actor.status, 'active');

    const second = await client(app.base).post('/api/auth/session', { token: link.body.token });
    assert.equal(second.status, 401);
    assert.equal(second.body.error, 'INVALID_TOKEN');
  } finally {
    await app.close();
  }
});

test('同一邮箱 60 秒内重复请求登录链接被限流', async () => {
  const app = await start();
  try {
    const c = client(app.base);
    assert.equal((await c.post('/api/auth/magic-link', { email: 'rate@b.com' })).status, 200);
    assert.equal((await c.post('/api/auth/magic-link', { email: 'rate@b.com' })).status, 429);
  } finally {
    await app.close();
  }
});

test('作者创建项目后成为 creator，并可发行试玩码', async () => {
  const app = await start();
  try {
    const { c } = await registerAuthor(app.base);
    const project = await c.post('/api/projects', { name: '星轨修理铺' });
    assert.equal(project.status, 201);

    const me = await c.get('/api/auth/me');
    assert.deepEqual(
      me.body.memberships.map((m) => [m.name, m.role]),
      [['星轨修理铺', 'creator']],
    );

    const code = await c.post(`/api/projects/${project.body.projectId}/codes`, { maxUses: 2, expiresInHours: 24 });
    assert.equal(code.status, 201);
    assert.match(code.body.code, /^[A-Z2-9]{8}$/);
  } finally {
    await app.close();
  }
});

test('匿名试玩者凭码进入，获得 tester 身份并可查看成员', async () => {
  const app = await start();
  try {
    const { projectId, code } = await createProjectWithCode(app.base);

    const tester = client(app.base);
    const redeem = await tester.post(`/api/codes/${code}/redeem`, {});
    assert.equal(redeem.status, 200);
    assert.equal(redeem.body.anonymous, true);
    assert.equal(redeem.body.role, 'tester');
    assert.equal(redeem.body.project.projectId, projectId);
    assert.match(redeem.body.actor.displayName, /^试玩者 #\d+$/);

    const members = await tester.get(`/api/projects/${projectId}/members`);
    assert.equal(members.status, 200);
    assert.deepEqual(
      members.body.members.map((m) => m.role).sort(),
      ['creator', 'tester'],
    );
  } finally {
    await app.close();
  }
});

test('试玩码用尽后拒绝新的兑换，但已兑换者不受影响', async () => {
  const app = await start();
  try {
    const { code } = await createProjectWithCode(app.base);
    const first = await client(app.base).post(`/api/codes/${code}/redeem`, {});
    assert.equal(first.status, 200);

    const second = await client(app.base).post(`/api/codes/${code}/redeem`, {});
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'CODE_EXHAUSTED');
  } finally {
    await app.close();
  }
});

test('同一个账号不能重复兑换同一试玩码', async () => {
  const app = await start();
  try {
    const { author, projectId } = await createProjectWithCode(app.base);
    const code = await author.post(`/api/projects/${projectId}/codes`, { maxUses: 5 });
    assert.equal(code.status, 201);

    const tester = client(app.base);
    assert.equal((await tester.post(`/api/codes/${code.body.code}/redeem`, {})).status, 200);
    const again = await tester.post(`/api/codes/${code.body.code}/redeem`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'ALREADY_REDEEMED');
  } finally {
    await app.close();
  }
});

test('过期试玩码返回 410', async () => {
  const app = await start();
  try {
    const { code } = await createProjectWithCode(app.base);
    app.db.prepare('update invite_codes set expires_at = 1').run();

    const response = await client(app.base).post(`/api/codes/${code}/redeem`, {});
    assert.equal(response.status, 410);
    assert.equal(response.body.error, 'CODE_EXPIRED');
  } finally {
    await app.close();
  }
});

test('非 creator 不能发行试玩码', async () => {
  const app = await start();
  try {
    const { projectId, code } = await createProjectWithCode(app.base);
    const tester = client(app.base);
    assert.equal((await tester.post(`/api/codes/${code}/redeem`, {})).status, 200);

    const denied = await tester.post(`/api/projects/${projectId}/codes`, {});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'NOT_CREATOR');
  } finally {
    await app.close();
  }
});

test('非项目成员看不到成员名单', async () => {
  const app = await start();
  try {
    const { projectId } = await createProjectWithCode(app.base);
    const outsider = await registerAuthor(app.base, 'outsider@example.com');

    const response = await outsider.c.get(`/api/projects/${projectId}/members`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'NOT_A_MEMBER');
  } finally {
    await app.close();
  }
});

test('生产环境缺少 SMTP 配置时拒绝启动', () => {
  assert.throws(() => createMailer({ NODE_ENV: 'production' }), /SMTP_URL/);
});

test('SMTP 模式通过邮件发送登录链接，响应不返回令牌', async () => {
  const sent = [];
  const mailer = createMailer(
    {
      SMTP_URL: 'smtp://user:pass@smtp.example.com:587',
      MAIL_FROM: 'no-reply@replay.test',
      APP_ORIGIN: 'https://replay.test',
    },
    { transportFactory: () => ({ sendMail: async (message) => sent.push(message) }) },
  );
  const app = await start({ mailer });
  try {
    const c = client(app.base);
    const link = await c.post('/api/auth/magic-link', { email: 'smtp@example.com' });
    assert.equal(link.status, 200);
    assert.equal(link.body.deliveredBy, 'email');
    assert.equal(link.body.token, undefined);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'smtp@example.com');
    assert.match(sent[0].text, /https:\/\/replay\.test\/api\/auth\/login\?token=/);

    const token = sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const login = await c.post('/api/auth/session', { token });
    assert.equal(login.status, 200);
    assert.equal(login.body.actor.displayName, 'smtp');
  } finally {
    await app.close();
  }
});

test('邮件里的登录链接可直接完成登录并跳回应用', async () => {
  const app = await start({ mailer: { mode: 'dev', appOrigin: 'https://replay.test', send: async () => {} } });
  try {
    const c = client(app.base);
    const link = await c.post('/api/auth/magic-link', { email: 'link@example.com' });
    const target = `${app.base}/api/auth/login?token=${encodeURIComponent(link.body.token)}`;

    const first = await fetch(target, { redirect: 'manual' });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), 'https://replay.test/?login=ok');
    assert.match(first.headers.getSetCookie()[0], /replay_session=/);

    const second = await fetch(target, { redirect: 'manual' });
    assert.equal(second.headers.get('location'), 'https://replay.test/?login=invalid');
  } finally {
    await app.close();
  }
});

test('缺少 CSRF 头的写请求被拒绝，但申请登录链接不受影响', async () => {
  const app = await start();
  try {
    const c = client(app.base, { autoCsrf: false });
    const denied = await c.post('/api/projects', { name: '无令牌' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'CSRF_FAILED');
    assert.equal((await c.post('/api/auth/magic-link', { email: 'nocsrf@example.com' })).status, 200);
  } finally {
    await app.close();
  }
});

test('CSRF 头与 Cookie 不一致时拒绝写入', async () => {
  const app = await start();
  try {
    const c = client(app.base, { autoCsrf: false });
    await c.ensureCsrf();
    const denied = await c.post('/api/projects', { name: '错令牌' }, { 'x-csrf-token': 'wrong-token' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'CSRF_FAILED');
  } finally {
    await app.close();
  }
});

test('跨站 Origin 的写请求被拒绝', async () => {
  const app = await start();
  try {
    const c = client(app.base);
    const denied = await c.post('/api/auth/magic-link', { email: 'origin@example.com' }, { origin: 'https://evil.example' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'ORIGIN_REJECTED');
  } finally {
    await app.close();
  }
});

test('生产 Cookie 模式会为会话与 CSRF Cookie 加 Secure', async () => {
  const app = await start({ secureCookies: true });
  try {
    const c = client(app.base);
    const link = await c.post('/api/auth/magic-link', { email: 'secure@example.com' });
    const login = await c.post('/api/auth/session', { token: link.body.token });
    assert.match(login.headers.getSetCookie()[0], /; Secure/);

    const csrf = await c.get('/api/auth/csrf');
    const csrfCookie = csrf.headers.getSetCookie()[0];
    assert.match(csrfCookie, /; Secure/);
    assert.doesNotMatch(csrfCookie, /HttpOnly/);
  } finally {
    await app.close();
  }
});

test('本机回环别名（localhost 与 127.0.0.1）不被 Origin 校验误拦', async () => {
  const app = await start();
  try {
    const port = new URL(app.base).port;
    const c = client(app.base);
    const response = await c.post(
      '/api/auth/magic-link',
      { email: 'loopback@example.com' },
      { origin: `http://localhost:${port}` },
    );
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }
});

test('信任代理转发的 x-forwarded-host', async () => {
  const app = await start();
  try {
    const c = client(app.base);
    const response = await c.post(
      '/api/auth/magic-link',
      { email: 'forwarded@example.com' },
      { origin: 'https://app.example.com', 'x-forwarded-host': 'app.example.com' },
    );
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }
});
