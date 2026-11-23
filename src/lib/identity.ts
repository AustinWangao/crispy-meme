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
