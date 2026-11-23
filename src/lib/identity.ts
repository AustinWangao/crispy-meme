const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export const identityEnabled = import.meta.env.VITE_IDENTITY === 'on';

export interface IdentityActor {
  actorId: string;
  displayName: string;
  status: 'active' | 'unclaimed' | 'merged' | 'disabled';
}

export interface IdentityMembership {
  projectId: string;
  name: string;
  role: 'creator' | 'tester' | 'observer';
  status: string;
}

export interface SessionPayload {
  actor: IdentityActor;
  memberships: IdentityMembership[];
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let csrfToken: string | null = null;

async function getCsrfToken(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  const response = await fetch(`${BASE}/api/auth/csrf`, { credentials: 'include' });
  if (!response.ok) throw new ApiError(response.status, '无法获取防伪令牌');
  const data = (await response.json()) as { csrfToken: string };
  csrfToken = data.csrfToken;
  return csrfToken;
}

async function request<T>(path: string, init: RequestInit = {}, retryCsrf = true): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const unsafe = method !== 'GET' && method !== 'HEAD';
  const headers: Record<string, string> = {
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (unsafe) headers['x-csrf-token'] = await getCsrfToken();

  const response = await fetch(`${BASE}${path}`, { ...init, credentials: 'include', headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 403 && data?.error === 'CSRF_FAILED' && retryCsrf) {
      csrfToken = null;
      return request<T>(path, init, false);
    }
    throw new ApiError(response.status, data?.message ?? '请求失败');
  }
  return data as T;
}

export function requestMagicLink(email: string) {
  return request<{ deliveredBy: string; token?: string; expiresAt: string }>('/api/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function loginWithToken(token: string) {
  return request<SessionPayload>('/api/auth/session', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function fetchSession(): Promise<SessionPayload | null> {
  try {
    return await request<SessionPayload>('/api/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function logout() {
  await request<null>('/api/auth/logout', { method: 'POST' });
}

export function createProject(name: string) {
  return request<{ projectId: string; name: string; role: string }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function listMemberships() {
  return request<{ memberships: IdentityMembership[] }>('/api/projects');
}

export function issueCode(projectId: string, options: { maxUses?: number; expiresInHours?: number } = {}) {
  return request<{ code: string; maxUses: number; expiresAt: string }>(`/api/projects/${projectId}/codes`, {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

export function redeemCode(code: string) {
  return request<{
    anonymous: boolean;
    actor: IdentityActor;
    project: { projectId: string; name: string };
    role: string;
    verifiedBuildId: string | null;
  }>(`/api/codes/${encodeURIComponent(code.trim().toUpperCase())}/redeem`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export type PostCategory = '功能缺陷' | '目标与规则' | '操作与反馈' | '难度与节奏' | '玩家体验' | '玩法偏好';
export type PostSeverity = 'blocker' | 'major' | 'minor' | 'preference';
export type PostDecision = 'pending' | 'accepted' | 'deferred' | 'rejected';

export interface ServerPostAuthor {
  actorId: string;
  displayName: string;
  role: 'creator' | 'tester' | 'observer';
}

export interface ServerPostReply {
  replyId: string;
  postId: string;
  author: ServerPostAuthor;
  body: string;
  createdAt: string;
}

export interface ServerPost {
  postId: string;
  projectId: string;
  buildId: string | null;
  title: string;
  category: PostCategory;
  severity: PostSeverity;
  observation: string;
  evidence: string;
  interpretation: string;
  draft: boolean;
  author: ServerPostAuthor;
  disposition: { decision: PostDecision; reason: string; nextAction: string };
  createdAt: string;
  updatedAt: string;
  replies: ServerPostReply[];
}

export interface NewPostInput {
  title: string;
  category: PostCategory;
  severity: PostSeverity;
  observation: string;
  evidence: string;
  interpretation: string;
  buildId?: string;
  draft: boolean;
}

export function listProjectPosts(projectId: string) {
  return request<{ projectId: string; posts: ServerPost[] }>(`/api/projects/${projectId}/posts`);
}

export function createPost(projectId: string, input: NewPostInput) {
  return request<{ post: ServerPost }>(`/api/projects/${projectId}/posts`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function setPostDisposition(
  postId: string,
  input: { decision: Exclude<PostDecision, 'pending'>; reason: string; nextAction: string },
) {
  return request<{ post: ServerPost }>(`/api/posts/${postId}/disposition`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function createPostReply(postId: string, body: string) {
  return request<{ reply: ServerPostReply }>(`/api/posts/${postId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}
