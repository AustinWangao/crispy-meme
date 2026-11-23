import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../db.mjs';
import { createApp } from '../app.mjs';

async function start() {
  const db = openDb(':memory:');
  const server = http.createServer(createApp({ db }));
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

function client(base) {
  let cookie = '';
  async function call(method, path, body) {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length) cookie = setCookies[0].split(';')[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
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
