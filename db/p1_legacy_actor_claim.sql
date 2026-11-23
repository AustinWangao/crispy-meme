-- 复玩 Replay · P1 身份体系：legacy:<姓名> 认领脚本
-- 目标数据库：PostgreSQL 14+
--
-- 前提假设（不满足就先别跑）：
--   1. 已有数据库，且 P0 数据已从 localStorage 导入到 issues / replies 两张表。
--   2. 这两张表已有文本作者列（本脚本按 issues.tester_name、replies.author 书写），
--      若你的列名不同，只需改「第 3 节」两条 UPDATE。
--   3. 尚未建立 actors / project_members（本脚本负责建）。
--
-- 核心保证：
--   * 认领只改 author_actor_id，绝不改写 author_display_name / author_role_at_post。
--     历史署名不可变，这是 P0 快照的契约。
--   * 认领幂等：同一 legacy_key 重复调用不会产生第二个身份。
--   * 同一项目内 creator 唯一由部分唯一索引强制，不靠应用层自觉。
--   * 每次认领写一条 actor_claims 审计，可据此回滚。

begin;

-- ============================================================
-- 1. 基础表
-- ============================================================

create table if not exists actors (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null check (btrim(display_name) <> ''),
  email        text,
  status       text not null default 'active'
               check (status in ('active', 'unclaimed', 'merged', 'disabled')),
  legacy_key   text unique,
  merged_into  uuid references actors (id),
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint actors_unclaimed_no_email check (status <> 'unclaimed' or email is null),
  constraint actors_unclaimed_has_key check (status <> 'unclaimed' or legacy_key is not null),
  constraint actors_merged_shape       check ((status = 'merged') = (merged_into is not null))
);

create unique index if not exists actors_email_uniq
  on actors (lower(email)) where email is not null;

create table if not exists auth_credentials (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid not null references actors (id) on delete cascade,
  provider   text not null check (provider in ('magic_link', 'passkey', 'invite_code')),
  subject    text not null,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);

-- project_id 不挂外键：projects 表由应用侧维护，避免迁移顺序耦合。
create table if not exists project_members (
  project_id uuid not null,
  actor_id   uuid not null references actors (id),
  role       text not null check (role in ('creator', 'tester', 'observer')),
  status     text not null default 'active' check (status in ('invited', 'active', 'removed')),
  joined_via text not null check (joined_via in ('invite', 'code', 'open', 'legacy')),
  created_at timestamptz not null default now(),
  primary key (project_id, actor_id)
);

create unique index if not exists project_members_single_creator
  on project_members (project_id)
  where role = 'creator' and status = 'active';

create table if not exists invite_codes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  build_id   uuid,
  code       text not null unique,
  max_uses   int  not null default 1 check (max_uses > 0),
  used_count int  not null default 0 check (used_count >= 0 and used_count <= max_uses),
  expires_at timestamptz,
  created_by uuid not null references actors (id),
  created_at timestamptz not null default now()
);

create table if not exists code_redemptions (
  code_id     uuid not null references invite_codes (id) on delete cascade,
  actor_id    uuid not null references actors (id),
  redeemed_at timestamptz not null default now(),
  primary key (code_id, actor_id)
);

-- 认领审计：回滚的唯一依据。
create table if not exists actor_claims (
  id               uuid primary key default gen_random_uuid(),
  legacy_key       text not null,
  stub_actor_id    uuid not null references actors (id),
  target_actor_id  uuid not null references actors (id),
  method           text not null check (method in ('self', 'merge')),
  moved_posts      int  not null default 0,
  moved_replies    int  not null default 0,
  dropped_members  int  not null default 0,
  note             text,
  claimed_at       timestamptz not null default now()
);

-- ============================================================
-- 2. 导入与幂等建 stub
-- ============================================================

create or replace function upsert_legacy_actor(p_legacy_key text, p_display_name text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  if p_legacy_key is null or p_legacy_key not like 'legacy:%' then
    raise exception 'legacy_key 必须以 legacy: 开头，收到 %', p_legacy_key using errcode = '22023';
  end if;

  insert into actors (display_name, status, legacy_key)
  values (coalesce(nullif(btrim(p_display_name), ''), substr(p_legacy_key, 8)), 'unclaimed', p_legacy_key)
  on conflict (legacy_key) do update set display_name = actors.display_name
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function import_legacy_author(p_display_name text)
returns uuid
language plpgsql
as $$
declare
  v_name text := coalesce(nullif(btrim(p_display_name), ''), '匿名');
begin
  return upsert_legacy_actor('legacy:' || v_name, v_name);
end;
$$;

-- ============================================================
-- 3. 回填 author_actor_id（按你的实际列名调整这两条）
-- ============================================================

alter table issues  add column if not exists author_actor_id uuid references actors (id);
alter table issues  add column if not exists author_display_name text;
alter table issues  add column if not exists author_role_at_post text;
alter table replies add column if not exists author_actor_id uuid references actors (id);
alter table replies add column if not exists author_display_name text;
alter table replies add column if not exists author_role_at_post text;

update issues i
   set author_actor_id = import_legacy_author(i.tester_name)
 where i.author_actor_id is null;

update replies r
   set author_actor_id = import_legacy_author(r.author)
 where r.author_actor_id is null;

-- 快照备份：用于事后比对「署名是否被改写」。
create table if not exists legacy_author_snapshot as
select 'issue'::text as source, id, author_display_name, author_role_at_post
  from issues
 where author_actor_id is not null
union all
select 'reply'::text as source, id, author_display_name, author_role_at_post
  from replies
 where author_actor_id is not null;

create index if not exists issues_author_idx  on issues  (author_actor_id);
create index if not exists replies_author_idx on replies (author_actor_id);

-- ============================================================
-- 4. 认领方式 A：本人认领（stub 直接转正，绑定登录凭据）
-- ============================================================

create or replace function claim_legacy_as_self(
  p_legacy_key   text,
  p_display_name text,
  p_email        text
) returns uuid
language plpgsql
as $$
declare
  v_id      uuid;
  v_display text;
begin
  if p_email is null or btrim(p_email) = '' then
    raise exception '认领必须绑定可验证的登录凭据' using errcode = '22023';
  end if;

  select id into v_id
    from actors
   where legacy_key = p_legacy_key and status = 'unclaimed'
   for update;

  if v_id is null then
    raise exception '未找到待认领的身份：%（可能已认领或不存在）', p_legacy_key using errcode = 'P0002';
  end if;

  v_display := coalesce(nullif(btrim(p_display_name), ''), '匿名');

  update actors
     set display_name = v_display,
         email        = lower(btrim(p_email)),
         status       = 'active',
         claimed_at   = now()
   where id = v_id;

  insert into actor_claims (legacy_key, stub_actor_id, target_actor_id, method)
  values (p_legacy_key, v_id, v_id, 'self');

  return v_id;
exception
  when unique_violation then
    raise exception '该邮箱已绑定其他身份，请改用「合并认领」' using errcode = '23505';
end;
$$;

-- ============================================================
-- 5. 认领方式 B：合并到已存在账号（推荐，先有账号再认领历史）
-- ============================================================

create or replace function claim_legacy_merge(
  p_legacy_key    text,
  p_target_actor  uuid,
  p_note          text default null
) returns jsonb
language plpgsql
as $$
declare
  v_stub    uuid;
  v_posts   int := 0;
  v_replies int := 0;
  v_members int := 0;
begin
  select id into v_stub
    from actors
   where legacy_key = p_legacy_key and status = 'unclaimed'
   for update;

  if v_stub is null then
    raise exception '未找到待认领的身份：%', p_legacy_key using errcode = 'P0002';
  end if;

  if v_stub = p_target_actor then
    raise exception '目标账号就是待认领身份，请用 claim_legacy_as_self' using errcode = '22023';
  end if;

  perform 1 from actors where id = p_target_actor and status = 'active' for update;
  if not found then
    raise exception '目标账号不存在或不可用：%', p_target_actor using errcode = 'P0002';
  end if;

  -- 只改归属，不动署名快照三列
  update issues set author_actor_id = p_target_actor where author_actor_id = v_stub;
  get diagnostics v_posts = row_count;

  update replies set author_actor_id = p_target_actor where author_actor_id = v_stub;
  get diagnostics v_replies = row_count;

  -- 成员关系去重：目标已是该项目成员时，丢弃 stub 的重复关系，
  -- 否则改指向会撞 (project_id, actor_id) 主键。
  delete from project_members pm
   using project_members t
   where pm.actor_id = v_stub
     and t.actor_id = p_target_actor
     and t.project_id = pm.project_id;
  get diagnostics v_members = row_count;

  update project_members set actor_id = p_target_actor where actor_id = v_stub;

  update actors
     set status      = 'merged',
         merged_into = p_target_actor,
         claimed_at  = now()
   where id = v_stub;

  insert into actor_claims
    (legacy_key, stub_actor_id, target_actor_id, method, moved_posts, moved_replies, dropped_members, note)
  values
    (p_legacy_key, v_stub, p_target_actor, 'merge', v_posts, v_replies, v_members, p_note);

  return jsonb_build_object(
    'stub', v_stub,
    'target', p_target_actor,
    'posts', v_posts,
    'replies', v_replies,
    'droppedMemberships', v_members
  );
end;
$$;

-- ============================================================
-- 6. 拆帖：一个 stub 混了两个人的情况
--    P0 按姓名生成 actorId，同名会被并为一人。认领时不能整包接受，
--    需要把属于另一个人的帖子单独改归属。
-- ============================================================

create or replace function reassign_post_author(p_post_id uuid, p_actor_id uuid)
returns void
language plpgsql
as $$
begin
  perform 1 from actors where id = p_actor_id and status = 'active';
  if not found then
    raise exception '目标账号不可用：%', p_actor_id using errcode = 'P0002';
  end if;

  update issues set author_actor_id = p_actor_id where id = p_post_id;
  if not found then
    raise exception '帖子不存在：%', p_post_id using errcode = 'P0002';
  end if;
end;
$$;

commit;

-- ============================================================
-- 7. 验证查询（单独执行，任何一条返回非预期都视为失败）
-- ============================================================

-- 7.1 已合并身份不应再被任何帖子或回复引用，期望 0 行
-- select a.legacy_key, count(*) from issues i join actors a on a.id = i.author_actor_id
--  where a.status = 'merged' group by 1;

-- 7.2 同一项目 creator 唯一，期望 0 行
-- select project_id, count(*) from project_members
--  where role = 'creator' and status = 'active' group by 1 having count(*) > 1;

-- 7.3 历史署名未被改写，期望 0 行
-- select s.* from legacy_author_snapshot s
--  left join issues i on s.source = 'issue' and i.id = s.id
--  left join replies r on s.source = 'reply' and r.id = s.id
--  where coalesce(i.author_display_name, r.author_display_name) is distinct from s.author_display_name
--     or coalesce(i.author_role_at_post, r.author_role_at_post) is distinct from s.author_role_at_post;

-- 7.4 未认领 stub 占比（按项目），这就是回退判定的输入
-- select pm.project_id,
--        count(*) filter (where a.status = 'unclaimed') as unclaimed,
--        count(*) as total
--   from project_members pm join actors a on a.id = pm.actor_id
--  group by 1;

-- ============================================================
-- 8. 回滚一次的写法（依据 actor_claims 记录）
-- ============================================================
-- begin;
-- update issues  set author_actor_id = c.stub_actor_id
--   from actor_claims c where c.id = '<claim_id>' and issues.author_actor_id = c.target_actor_id;
-- update replies set author_actor_id = c.stub_actor_id
--   from actor_claims c where c.id = '<claim_id>' and replies.author_actor_id = c.target_actor_id;
-- update actors set status = 'unclaimed', merged_into = null, claimed_at = null
--  where id = (select stub_actor_id from actor_claims where id = '<claim_id>');
-- commit;
-- 注意：成员关系去重丢掉的行不会自动恢复，需要从备份还原 project_members。
