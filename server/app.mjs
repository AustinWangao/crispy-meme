import crypto from 'node:crypto';

const COOKIE = 'replay_session';
const MAGIC_TTL_MS = 15 * 60 * 1000;
const MAGIC_COOLDOWN_MS = 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowIso = (ms) => new Date(ms).toISOString();

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, error, message) {
  json(res, status, { error, message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index > 0) acc[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    return acc;
  }, {});
}

function randomCode() {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function createApp({ db, now = () => Date.now() }) {
  function findSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db
      .prepare(
        `select s.id as sessionId, s.actor_id as actorId, s.expires_at as expiresAt,
                a.display_name as displayName, a.status
           from sessions s join actors a on a.id = s.actor_id
          where s.token_hash = ?`,
      )
      .get(sha256(token));
    if (!row || row.expiresAt <= now()) return null;
    return row;
  }

  function membershipsOf(actorId) {
    return db
      .prepare(
        `select m.project_id as projectId, m.role, m.status, p.name
           from project_members m join projects p on p.id = m.project_id
          where m.actor_id = ? and m.status = 'active'
          order by m.created_at`,
      )
      .all(actorId);
  }

  function actorPayload(actor) {
    return {
      actorId: actor.actorId ?? actor.id,
      displayName: actor.displayName ?? actor.display_name,
      status: actor.status,
    };
  }

  function issueSession(actorId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('insert into sessions (id, actor_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?)').run(
      crypto.randomUUID(),
      actorId,
      sha256(token),
      now() + SESSION_TTL_MS,
      now(),
    );
    return token;
  }

  function requireSession(req, res) {
    const session = findSession(req);
    if (!session) {
      fail(res, 401, 'UNAUTHENTICATED', '请先登录');
      return null;
    }
    return session;
  }

  function requireCreator(req, res, projectId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const membership = db
      .prepare(`select role from project_members where project_id = ? and actor_id = ? and status = 'active'`)
      .get(projectId, session.actorId);
    if (!membership || membership.role !== 'creator') {
      fail(res, 403, 'NOT_CREATOR', '只有项目作者可以执行此操作');
      return null;
    }
    return session;
  }

  const routes = [
    {
      method: 'POST',
      path: ['api', 'auth', 'magic-link'],
      handler: async (req, res) => {
        const body = await readBody(req);
        const email = String(body.email ?? '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return fail(res, 422, 'INVALID_EMAIL', '邮箱格式不正确');
        }

        const existing = db.prepare('select id from actors where email = ?').get(email);
        const lastToken = db
          .prepare('select max(created_at) as last from auth_tokens where email = ?')
          .get(email)?.last;
        if (lastToken && now() - lastToken < MAGIC_COOLDOWN_MS) {
          return fail(res, 429, 'TOO_MANY_REQUESTS', '请 60 秒后再试');
        }

        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = now() + MAGIC_TTL_MS;
        db.prepare(
          'insert into auth_tokens (id, email, actor_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?, ?)',
        ).run(crypto.randomUUID(), email, existing?.id ?? null, sha256(token), expiresAt, now());

        // 尚未接入邮件服务：开发模式直接返回登录令牌，生产环境必须改为发信。
        return json(res, 200, {
          deliveredBy: 'dev-response',
          token,
          expiresAt: nowIso(expiresAt),
          loginUrl: `/api/auth/session?token=${token}`,
        });
      },
    },
    {
      method: 'POST',
      path: ['api', 'auth', 'session'],
      handler: async (req, res) => {
        const body = await readBody(req);
        const token = String(body.token ?? '');
        const row = db.prepare('select * from auth_tokens where token_hash = ?').get(sha256(token));
        if (!row || row.used_at || row.expires_at <= now()) {
          return fail(res, 401, 'INVALID_TOKEN', '登录链接无效或已过期');
        }

        db.prepare('update auth_tokens set used_at = ? where id = ?').run(now(), row.id);

        let actor = db.prepare('select * from actors where email = ?').get(row.email);
        if (!actor) {
          const id = crypto.randomUUID();
          db.prepare(
            `insert into actors (id, display_name, email, status, created_at)
             values (?, ?, ?, 'active', ?)`,
          ).run(id, row.email.split('@')[0], row.email, nowIso(now()));
          actor = db.prepare('select * from actors where id = ?').get(id);
        }
        if (actor.status === 'disabled') return fail(res, 403, 'ACTOR_DISABLED', '该账号已停用');

        const sessionToken = issueSession(actor.id);
        return json(
          res,
          200,
          { actor: { actorId: actor.id, displayName: actor.display_name, status: actor.status }, memberships: membershipsOf(actor.id) },
          { 'set-cookie': sessionCookie(sessionToken, SESSION_TTL_MS / 1000) },
        );
      },
    },
    {
      method: 'GET',
      path: ['api', 'auth', 'me'],
      handler: async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        db.prepare('update sessions set expires_at = ? where id = ?').run(now() + SESSION_TTL_MS, session.sessionId);
        res.setHeader('set-cookie', sessionCookie(parseCookies(req.headers.cookie)[COOKIE], SESSION_TTL_MS / 1000));
        return json(res, 200, { actor: actorPayload(session), memberships: membershipsOf(session.actorId) });
      },
    },
    {
      method: 'POST',
      path: ['api', 'auth', 'logout'],
      handler: async (req, res) => {
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (token) db.prepare('delete from sessions where token_hash = ?').run(sha256(token));
        res.writeHead(204, { 'set-cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
        res.end();
      },
    },
    {
      method: 'POST',
      path: ['api', 'projects'],
      handler: async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        const body = await readBody(req);
        const name = String(body.name ?? '').trim();
        if (name.length < 1 || name.length > 80) return fail(res, 422, 'INVALID_NAME', '项目名称需为 1–80 个字符');

        const projectId = crypto.randomUUID();
        db.prepare('insert into projects (id, name, created_by, created_at) values (?, ?, ?, ?)').run(
          projectId,
          name,
          session.actorId,
          nowIso(now()),
        );
        db.prepare(
          `insert into project_members (project_id, actor_id, role, status, joined_via, created_at)
           values (?, ?, 'creator', 'active', 'open', ?)`,
        ).run(projectId, session.actorId, nowIso(now()));
        db.prepare(`insert into membership_events (id, project_id, actor_id, event, actor_by, created_at) values (?, ?, ?, 'joined', ?, ?)`).run(
          crypto.randomUUID(),
          projectId,
          session.actorId,
          session.actorId,
          nowIso(now()),
        );

        return json(res, 201, { projectId, name, role: 'creator' });
      },
    },
    {
      method: 'GET',
      path: ['api', 'projects'],
      handler: async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        return json(res, 200, { memberships: membershipsOf(session.actorId) });
      },
    },
    {
      method: 'POST',
      path: ['api', 'codes', null, 'redeem'],
      handler: async (req, res, params) => {
        const code = String(params[0] ?? '').trim().toUpperCase();
        const row = db.prepare('select * from invite_codes where code_hash = ?').get(sha256(code));
        if (!row) return fail(res, 404, 'CODE_NOT_FOUND', '试玩码不存在');
        if (row.revoked_at) return fail(res, 410, 'CODE_REVOKED', '试玩码已撤销');
        if (row.expires_at <= now()) return fail(res, 410, 'CODE_EXPIRED', '试玩码已过期');
        if (row.used_count >= row.max_uses) return fail(res, 409, 'CODE_EXHAUSTED', '试玩码已用尽');

        let session = findSession(req);
        let anonymous = false;

        if (!session) {
          const id = crypto.randomUUID();
          const seq = db.prepare(`select count(*) as n from actors where status = 'unclaimed'`).get().n + 1;
          db.prepare(
            `insert into actors (id, display_name, status, created_at) values (?, ?, 'unclaimed', ?)`,
          ).run(id, `试玩者 #${seq}`, nowIso(now()));
          session = { actorId: id, displayName: `试玩者 #${seq}`, status: 'unclaimed' };
          anonymous = true;
        }

        const already = db
          .prepare('select 1 as hit from code_redemptions where code_id = ? and actor_id = ?')
          .get(row.id, session.actorId);
        if (already) return fail(res, 409, 'ALREADY_REDEEMED', '你已经兑换过这个试玩码');

        db.prepare('insert into code_redemptions (code_id, actor_id, redeemed_at) values (?, ?, ?)').run(
          row.id,
          session.actorId,
          nowIso(now()),
        );
        db.prepare('update invite_codes set used_count = used_count + 1 where id = ?').run(row.id);

        db.prepare(
          `insert into project_members (project_id, actor_id, role, status, joined_via, created_at)
           values (?, ?, 'tester', 'active', 'code', ?)
           on conflict (project_id, actor_id) do update set status = 'active'`,
        ).run(row.project_id, session.actorId, nowIso(now()));
        db.prepare(`insert into membership_events (id, project_id, actor_id, event, actor_by, created_at) values (?, ?, ?, 'joined_via_code', ?, ?)`).run(
          crypto.randomUUID(),
          row.project_id,
          session.actorId,
          session.actorId,
          nowIso(now()),
        );

        const project = db.prepare('select id as projectId, name from projects where id = ?').get(row.project_id);
        const headers = {};
        if (anonymous) headers['set-cookie'] = sessionCookie(issueSession(session.actorId), SESSION_TTL_MS / 1000);

        return json(
          res,
          200,
          {
            anonymous,
            actor: { actorId: session.actorId, displayName: session.displayName, status: session.status },
            project,
            role: 'tester',
            verifiedBuildId: row.build_id ?? null,
          },
          headers,
        );
      },
    },
    {
      method: 'POST',
      path: ['api', 'projects', null, 'codes'],
      handler: async (req, res, params) => {
        const projectId = params[0];
        const session = requireCreator(req, res, projectId);
        if (!session) return;
        const body = await readBody(req);
        const maxUses = Number(body.maxUses ?? 1);
        const expiresInHours = Number(body.expiresInHours ?? 168);
        if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 50) {
          return fail(res, 422, 'INVALID_MAX_USES', '使用次数需为 1–50');
        }
        if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
          return fail(res, 422, 'INVALID_EXPIRY', '有效期需为 1–720 小时');
        }

        const code = randomCode();
        const expiresAt = now() + expiresInHours * 60 * 60 * 1000;
        db.prepare(
          `insert into invite_codes (id, project_id, build_id, code_hash, max_uses, expires_at, created_by, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), projectId, body.buildId ?? null, sha256(code), maxUses, expiresAt, session.actorId, nowIso(now()));

        // 明文只在此刻返回一次，服务端只存哈希。
        return json(res, 201, { code, maxUses, expiresAt: nowIso(expiresAt) });
      },
    },
    {
      method: 'GET',
      path: ['api', 'projects', null, 'members'],
      handler: async (req, res, params) => {
        const projectId = params[0];
        const session = requireSession(req, res);
        if (!session) return;
        const membership = db
          .prepare(`select role from project_members where project_id = ? and actor_id = ? and status = 'active'`)
          .get(projectId, session.actorId);
        if (!membership) return fail(res, 403, 'NOT_A_MEMBER', '你不是该项目成员');

        const members = db
          .prepare(
            `select a.id as actorId, a.display_name as displayName, a.status, m.role, m.joined_via as joinedVia
               from project_members m join actors a on a.id = m.actor_id
              where m.project_id = ? and m.status = 'active'
              order by m.created_at`,
          )
          .all(projectId);
        return json(res, 200, { projectId, role: membership.role, members });
      },
    },
  ];

  return async function handle(req, res) {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    for (const route of routes) {
      if (route.method !== req.method || route.path.length !== parts.length) continue;
      const params = [];
      const matched = route.path.every((segment, index) => {
        if (segment === null) {
          params.push(parts[index]);
          return true;
        }
        return segment === parts[index];
      });
      if (!matched) continue;
      try {
        return await route.handler(req, res, params);
      } catch (error) {
        if (error.message === 'INVALID_JSON') return fail(res, 400, 'INVALID_JSON', '请求体不是合法 JSON');
        if (error.message === 'BODY_TOO_LARGE') return fail(res, 413, 'BODY_TOO_LARGE', '请求体过大');
        console.error(error);
        return fail(res, 500, 'INTERNAL', '服务内部错误');
      }
    }

    return fail(res, 404, 'NOT_FOUND', '没有这个接口');
  };
}
