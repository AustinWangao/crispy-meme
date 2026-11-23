import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../db.mjs';
import { createApp } from '../app.mjs';

export async function start(options = {}) {
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

export function client(base, { autoCsrf = true } = {}) {
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
    patch: (path, body, headers) => call('PATCH', path, body, headers),
    ensureCsrf,
    raw,
  };
}

export async function registerAuthor(base, email = 'author@example.com') {
  const c = client(base);
  const link = await c.post('/api/auth/magic-link', { email });
  assert.equal(link.status, 200);
  const login = await c.post('/api/auth/session', { token: link.body.token });
  assert.equal(login.status, 200);
  return { c, actor: login.body.actor };
}

export async function createProjectWithCode(base) {
  const { c } = await registerAuthor(base);
  const project = await c.post('/api/projects', { name: '星轨修理铺' });
  assert.equal(project.status, 201);
  const code = await c.post(`/api/projects/${project.body.projectId}/codes`, { maxUses: 1 });
  assert.equal(code.status, 201);
  return { author: c, projectId: project.body.projectId, code: code.body.code };
}

export async function addTester(base, code) {
  const tester = client(base);
  const redeem = await tester.post(`/api/codes/${code}/redeem`, {});
  assert.equal(redeem.status, 200);
  return { tester, actor: redeem.body.actor };
}
