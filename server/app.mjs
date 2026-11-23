import crypto from 'node:crypto';

const COOKIE = 'replay_session';
const CSRF_COOKIE = 'replay_csrf';
const MAGIC_TTL_MS = 15 * 60 * 1000;
const MAGIC_COOLDOWN_MS = 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const POST_CATEGORIES = ['功能缺陷', '目标与规则', '操作与反馈', '难度与节奏', '玩家体验', '玩法偏好'];
const POST_SEVERITIES = ['blocker', 'major', 'minor', 'preference'];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowIso = (ms) => new Date(ms).toISOString();

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

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

function sessionCookie(token, maxAgeSeconds, secure = false) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function csrfCookie(token, secure = false) {
  // 必须可被前端 JS 读取，才能做双提交校验，因此不能加 HttpOnly。
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function parsePostInput(body, { requireEvidence }) {
  const title = String(body.title ?? '').trim();
  if (!title) return { error: ['INVALID_TITLE', '帖子标题不能为空'] };
  if (title.length > 120) return { error: ['INVALID_TITLE', '标题最多 120 个字符'] };

  const observation = String(body.observation ?? '').trim();
  if (!observation) return { error: ['INVALID_OBSERVATION', '请填写实际观察，而不是修改建议'] };
  if (observation.length > 4000) return { error: ['INVALID_OBSERVATION', '实际观察最多 4000 个字符'] };

  const evidence = String(body.evidence ?? '').trim();
  if (requireEvidence && !evidence) {
    return { error: ['EVIDENCE_REQUIRED', '发布证据帖必须提供原始证据，没有证据请先存为草稿'] };
  }
  if (evidence.length > 4000) return { error: ['INVALID_EVIDENCE', '原始证据最多 4000 个字符'] };

  const interpretation = String(body.interpretation ?? '').trim();
  if (interpretation.length > 2000) return { error: ['INVALID_INTERPRETATION', '解释假设最多 2000 个字符'] };

  const category = String(body.category ?? '目标与规则');
  if (!POST_CATEGORIES.includes(category)) return { error: ['INVALID_CATEGORY', '问题类型不合法'] };

  const severity = String(body.severity ?? 'major');
  if (!POST_SEVERITIES.includes(severity)) return { error: ['INVALID_SEVERITY', '影响程度不合法'] };

  const buildId = body.buildId == null || String(body.buildId).trim() === '' ? null : String(body.buildId).trim();
  if (buildId && buildId.length > 120) return { error: ['INVALID_BUILD', '版本标识最多 120 个字符'] };

  return { value: { title, observation, evidence, interpretation, category, severity, buildId } };
}

function postPayload(row, replies = []) {
  return {
    postId: row.id,
    projectId: row.project_id,
    buildId: row.build_id,
    title: row.title,
    category: row.category,
    severity: row.severity,
    observation: row.observation,
    evidence: row.evidence,
    interpretation: row.interpretation,
    draft: Boolean(row.draft),
    author: {
      actorId: row.author_actor_id,
      displayName: row.author_display_name,
      role: row.author_role_at_post,
    },
    disposition: {
      decision: row.disposition_decision,
      reason: row.disposition_reason,
      nextAction: row.disposition_next_action,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    replies,
  };
}

function replyPayload(row) {
  return {
    replyId: row.id,
    postId: row.post_id,
    author: {
      actorId: row.author_actor_id,
      displayName: row.author_display_name,
      role: row.author_role_at_reply,
    },
    body: row.body,
    createdAt: row.created_at,
  };
}

export function createApp({
  db,
  now = () => Date.now(),
  mailer = { mode: 'dev', appOrigin: '', send: async () => {} },
  allowedOrigins = [],
  secureCookies = false,
}) {
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

  function requireMember(req, res, projectId) {
    const session = requireSession(req, res);
    if (!session) return null;
    const membership = db
      .prepare(`select role from project_members where project_id = ? and actor_id = ? and status = 'active'`)
      .get(projectId, session.actorId);
    if (!membership) {
      fail(res, 403, 'NOT_A_MEMBER', '你不是该项目成员');
      return null;
    }
    return { session, membership };
  }

  function consumeLoginToken(token) {
    const row = db.prepare('select * from auth_tokens where token_hash = ?').get(sha256(token));
    if (!row || row.used_at || row.expires_at <= now()) {
      return { error: 'INVALID_TOKEN', message: '登录链接无效或已过期' };
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
    if (actor.status === 'disabled') return { error: 'ACTOR_DISABLED', message: '该账号已停用' };
    return { actor };
  }

  const routes = [
    {
      method: 'GET',
      path: ['api', 'auth', 'csrf'],
      handler: async (req, res) => {
        const token = crypto.randomBytes(32).toString('base64url');
        return json(res, 200, { csrfToken: token }, { 'set-cookie': csrfCookie(token, secureCookies) });
      },
    },
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

        const loginUrl = `${mailer.appOrigin}/api/auth/login?token=${encodeURIComponent(token)}`;
        await mailer.send({ to: email, loginUrl, expiresAt: nowIso(expiresAt) });

        if (mailer.mode === 'dev') {
          // 开发模式没有邮件服务，令牌直接回传，便于本地自测；生产模式绝不返回。
          return json(res, 200, {
            deliveredBy: 'dev-response',
            token,
            expiresAt: nowIso(expiresAt),
            loginUrl,
          });
        }
        return json(res, 200, { deliveredBy: 'email', expiresAt: nowIso(expiresAt) });
      },
    },
    {
      method: 'GET',
      path: ['api', 'auth', 'login'],
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token') ?? '';
        const result = consumeLoginToken(token);
        const target = `${mailer.appOrigin || ''}/`;
        if (result.error) {
          res.writeHead(302, { location: `${target}?login=${result.error === 'ACTOR_DISABLED' ? 'disabled' : 'invalid'}` });
          return res.end();
        }
        res.writeHead(302, {
          location: `${target}?login=ok`,
          'set-cookie': sessionCookie(issueSession(result.actor.id), SESSION_TTL_MS / 1000, secureCookies),
        });
        return res.end();
      },
    },
    {
      method: 'POST',
      path: ['api', 'auth', 'session'],
      handler: async (req, res) => {
        const body = await readBody(req);
        const result = consumeLoginToken(String(body.token ?? ''));
        if (result.error) return fail(res, result.error === 'ACTOR_DISABLED' ? 403 : 401, result.error, result.message);

        const actor = result.actor;
        return json(
          res,
          200,
          {
            actor: { actorId: actor.id, displayName: actor.display_name, status: actor.status },
            memberships: membershipsOf(actor.id),
          },
          { 'set-cookie': sessionCookie(issueSession(actor.id), SESSION_TTL_MS / 1000, secureCookies) },
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
        res.setHeader('set-cookie', sessionCookie(parseCookies(req.headers.cookie)[COOKIE], SESSION_TTL_MS / 1000, secureCookies));
        return json(res, 200, { actor: actorPayload(session), memberships: membershipsOf(session.actorId) });
      },
    },
    {
      method: 'POST',
      path: ['api', 'auth', 'logout'],
      handler: async (req, res) => {
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (token) db.prepare('delete from sessions where token_hash = ?').run(sha256(token));
        res.writeHead(204, {
          'set-cookie': `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureCookies ? '; Secure' : ''}`,
        });
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
        if (anonymous) headers['set-cookie'] = sessionCookie(issueSession(session.actorId), SESSION_TTL_MS / 1000, secureCookies);

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
    {
      method: 'POST',
      path: ['api', 'projects', null, 'posts'],
      handler: async (req, res, params) => {
        const projectId = params[0];
        const auth = requireMember(req, res, projectId);
        if (!auth) return;

        const body = await readBody(req);
        const draft = Boolean(body.draft);
        const parsed = parsePostInput(body, { requireEvidence: !draft });
        if (parsed.error) return fail(res, 422, parsed.error[0], parsed.error[1]);

        const { session, membership } = auth;
        const id = crypto.randomUUID();
        const createdAt = nowIso(now());
        db.prepare(
          `insert into posts (
             id, project_id, build_id, author_actor_id, author_display_name, author_role_at_post,
             title, category, severity, observation, evidence, interpretation, draft,
             disposition_decision, disposition_reason, disposition_next_action, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', ?, ?)`,
        ).run(
          id,
          projectId,
          parsed.value.buildId,
          session.actorId,
          session.displayName,
          membership.role,
          parsed.value.title,
          parsed.value.category,
          parsed.value.severity,
          parsed.value.observation,
          parsed.value.evidence,
          parsed.value.interpretation,
          draft ? 1 : 0,
          createdAt,
          createdAt,
        );

        const row = db.prepare('select * from posts where id = ?').get(id);
        return json(res, 201, { post: postPayload(row) });
      },
    },
    {
      method: 'GET',
      path: ['api', 'projects', null, 'posts'],
      handler: async (req, res, params) => {
        const projectId = params[0];
        const auth = requireMember(req, res, projectId);
        if (!auth) return;

        const url = new URL(req.url, 'http://localhost');
        const buildId = url.searchParams.get('buildId');
        const rows = buildId
          ? db
              .prepare('select * from posts where project_id = ? and build_id = ? order by created_at desc')
              .all(projectId, buildId)
          : db.prepare('select * from posts where project_id = ? order by created_at desc').all(projectId);

        const repliesByPost = new Map();
        for (const reply of db
          .prepare(
            `select r.* from post_replies r join posts p on p.id = r.post_id
              where p.project_id = ? order by r.created_at`,
          )
          .all(projectId)) {
          repliesByPost.set(reply.post_id, [...(repliesByPost.get(reply.post_id) ?? []), replyPayload(reply)]);
        }

        return json(res, 200, {
          projectId,
          buildId: buildId ?? null,
          posts: rows.map((row) => postPayload(row, repliesByPost.get(row.id) ?? [])),
        });
      },
    },
    {
      method: 'PATCH',
      path: ['api', 'posts', null, 'disposition'],
      handler: async (req, res, params) => {
        const post = db.prepare('select * from posts where id = ?').get(params[0]);
        if (!post) return fail(res, 404, 'POST_NOT_FOUND', '帖子不存在');

        const session = requireCreator(req, res, post.project_id);
        if (!session) return;
        if (post.draft) return fail(res, 409, 'POST_IS_DRAFT', '草稿需要先发布才能处置');

        const body = await readBody(req);
        const decision = String(body.decision ?? '');
        if (!['accepted', 'deferred', 'rejected'].includes(decision)) {
          return fail(res, 422, 'INVALID_DECISION', '处置决定不合法');
        }
        const reason = String(body.reason ?? '').trim();
        const nextAction = String(body.nextAction ?? '').trim();
        if (decision === 'accepted' && !nextAction) {
          return fail(res, 422, 'NEXT_ACTION_REQUIRED', '采纳时必须填写下一版动作');
        }
        if (decision !== 'accepted' && !reason) {
          return fail(res, 422, 'REASON_REQUIRED', '搁置或拒绝时必须填写理由');
        }

        db.prepare(
          `update posts
              set disposition_decision = ?, disposition_reason = ?, disposition_next_action = ?,
                  disposition_by = ?, disposition_at = ?, updated_at = ?
            where id = ?`,
        ).run(decision, reason, nextAction, session.actorId, nowIso(now()), nowIso(now()), post.id);

        const row = db.prepare('select * from posts where id = ?').get(post.id);
        const replies = db
          .prepare('select * from post_replies where post_id = ? order by created_at')
          .all(post.id)
          .map(replyPayload);
        return json(res, 200, { post: postPayload(row, replies) });
      },
    },
    {
      method: 'POST',
      path: ['api', 'posts', null, 'replies'],
      handler: async (req, res, params) => {
        const post = db.prepare('select id, project_id, draft from posts where id = ?').get(params[0]);
        if (!post) return fail(res, 404, 'POST_NOT_FOUND', '帖子不存在');

        const auth = requireMember(req, res, post.project_id);
        if (!auth) return;
        if (post.draft) return fail(res, 409, 'POST_IS_DRAFT', '草稿未发布，不能回复');

        const body = await readBody(req);
        const text = String(body.body ?? '').trim();
        if (!text) return fail(res, 422, 'INVALID_REPLY', '回复内容不能为空');
        if (text.length > 4000) return fail(res, 422, 'INVALID_REPLY', '回复最多 4000 个字符');

        const id = crypto.randomUUID();
        db.prepare(
          `insert into post_replies (id, post_id, author_actor_id, author_display_name, author_role_at_reply, body, created_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, post.id, auth.session.actorId, auth.session.displayName, auth.membership.role, text, nowIso(now()));

        const row = db.prepare('select * from post_replies where id = ?').get(id);
        return json(res, 201, { reply: replyPayload(row) });
      },
    },
    {
      method: 'GET',
      path: ['api', 'posts', null, 'replies'],
      handler: async (req, res, params) => {
        const post = db.prepare('select id, project_id from posts where id = ?').get(params[0]);
        if (!post) return fail(res, 404, 'POST_NOT_FOUND', '帖子不存在');

        const auth = requireMember(req, res, post.project_id);
        if (!auth) return;

        const rows = db.prepare('select * from post_replies where post_id = ? order by created_at').all(post.id);
        return json(res, 200, { postId: post.id, replies: rows.map(replyPayload) });
      },
    },
  ];

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;

    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }

    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim().toLowerCase();
    const host = String(req.headers.host ?? '').toLowerCase();
    return [forwarded, host].filter(Boolean).some((candidate) => sameHost(candidate, originHost));
  }

  function sameHost(hostHeader, originHost) {
    if (hostHeader === originHost) return true;
    // 代理或本机访问时 127.0.0.1 / localhost / [::1] 常被互换，端口一致即视为同源。
    try {
      const left = new URL(`http://${hostHeader}`);
      const right = new URL(`http://${originHost}`);
      const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
      return (
        loopback.has(left.hostname) &&
        loopback.has(right.hostname) &&
        left.port === right.port
      );
    } catch {
      return false;
    }
  }

  return async function handle(req, res) {
    const origin = req.headers.origin;
    if (origin && originAllowed(req)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!originAllowed(req)) return fail(res, 403, 'ORIGIN_REJECTED', '来源不被允许');
      res.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
        'access-control-allow-headers': 'content-type,x-csrf-token',
        'access-control-max-age': '600',
      });
      return res.end();
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe) {
      if (!originAllowed(req)) return fail(res, 403, 'ORIGIN_REJECTED', '来源不被允许');
      // 只有申请登录链接可以免 CSRF：它不改变服务端权限状态，且发生在新会话之前。
      const isMagicLink = url.pathname === '/api/auth/magic-link';
      if (!isMagicLink) {
        const cookieToken = parseCookies(req.headers.cookie)[CSRF_COOKIE] ?? '';
        const headerToken = String(req.headers['x-csrf-token'] ?? '');
        if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
          return fail(res, 403, 'CSRF_FAILED', '防伪校验失败，请刷新页面后重试');
        }
      }
    }

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
