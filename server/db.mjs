import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists actors (
  id            text primary key,
  display_name  text not null,
  email         text unique,
  status        text not null check (status in ('active', 'unclaimed', 'merged', 'disabled')),
  legacy_key    text unique,
  created_at    text not null
);

create table if not exists auth_tokens (
  id         text primary key,
  email      text not null,
  actor_id   text,
  token_hash text not null unique,
  expires_at integer not null,
  created_at integer not null,
  used_at    integer
);

create table if not exists sessions (
  id         text primary key,
  actor_id   text not null references actors (id),
  token_hash text not null unique,
  expires_at integer not null,
  created_at integer not null
);

create table if not exists projects (
  id         text primary key,
  name       text not null,
  created_by text not null references actors (id),
  created_at text not null
);

create table if not exists project_members (
  project_id text not null references projects (id),
  actor_id   text not null references actors (id),
  role       text not null check (role in ('creator', 'tester', 'observer')),
  status     text not null default 'active' check (status in ('active', 'removed')),
  joined_via text not null check (joined_via in ('invite', 'code', 'open', 'legacy')),
  created_at text not null,
  primary key (project_id, actor_id)
);

create unique index if not exists project_members_single_creator
  on project_members (project_id)
  where role = 'creator' and status = 'active';

create table if not exists invite_codes (
  id         text primary key,
  project_id text not null references projects (id),
  build_id   text,
  code_hash  text not null unique,
  max_uses   integer not null default 1 check (max_uses between 1 and 50),
  used_count integer not null default 0 check (used_count >= 0),
  expires_at integer not null,
  created_by text not null references actors (id),
  revoked_at integer,
  created_at text not null
);

create table if not exists code_redemptions (
  code_id     text not null references invite_codes (id),
  actor_id    text not null references actors (id),
  redeemed_at text not null,
  primary key (code_id, actor_id)
);

create table if not exists membership_events (
  id         text primary key,
  project_id text not null,
  actor_id   text not null,
  event      text not null,
  actor_by   text not null,
  created_at text not null
);

create table if not exists posts (
  id                      text primary key,
  project_id              text not null references projects (id),
  build_id                text,
  author_actor_id         text not null references actors (id),
  author_display_name     text not null,
  author_role_at_post     text not null check (author_role_at_post in ('creator', 'tester', 'observer')),
  title                   text not null,
  category                text not null,
  severity                text not null check (severity in ('blocker', 'major', 'minor', 'preference')),
  observation             text not null,
  evidence                text not null default '',
  interpretation          text not null default '',
  draft                   integer not null default 0 check (draft in (0, 1)),
  disposition_decision    text not null default 'pending' check (disposition_decision in ('pending', 'accepted', 'deferred', 'rejected')),
  disposition_reason      text not null default '',
  disposition_next_action text not null default '',
  disposition_by          text references actors (id),
  disposition_at          text,
  created_at              text not null,
  updated_at              text not null
);

create index if not exists posts_project_created
  on posts (project_id, created_at);

create table if not exists post_replies (
  id                   text primary key,
  post_id              text not null references posts (id),
  author_actor_id      text not null references actors (id),
  author_display_name  text not null,
  author_role_at_reply text not null check (author_role_at_reply in ('creator', 'tester', 'observer')),
  body                 text not null,
  created_at           text not null
);

create index if not exists post_replies_post_created
  on post_replies (post_id, created_at);
`;

export function openDb(file = 'data/replay.sqlite') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal;');
  db.exec('pragma foreign_keys = on;');
  db.exec(SCHEMA);
  return db;
}
