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
`;

export function openDb(file = 'data/replay.sqlite') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal;');
  db.exec('pragma foreign_keys = on;');
  db.exec(SCHEMA);
  return db;
}
