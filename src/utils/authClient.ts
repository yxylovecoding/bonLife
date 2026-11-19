import { requestWithRetry } from './requestWithRetry';
import { invalidateRequestCache, requestCacheVersion } from './requestCache';

export interface SessionStatus {
  authenticated: boolean;
  username?: string;
  accountId?: string;
  orcheJobId?: string;
}

export class SessionError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

let activeAccountId: string | undefined;
export function accountRequestHeaders(): Record<string, string> {
  return activeAccountId ? {
    'X-BonBills-Account': activeAccountId,
    'X-BonBills-Cache': requestCacheVersion(activeAccountId),
  } : {};
}

export function invalidateAccountRequests() {
  if (activeAccountId) invalidateRequestCache(activeAccountId);
}

export async function accountFetch(url: string, init: RequestInit = {}) {
  const account = activeAccountId;
  const writing = !['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase());
  if (writing && account) invalidateRequestCache(account);
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(accountRequestHeaders())) headers.set(key, value);
  try {
    return await fetch(url, { ...init, headers, credentials: 'same-origin', cache: init.cache ?? 'default' });
  } finally {
    // Invalidate even on a timeout: the server may already have saved the edit.
    // A second generation also excludes reads started while saving was in flight.
    if (writing && account) invalidateRequestCache(account);
  }
}

export async function requestSession(init: RequestInit = {}): Promise<SessionStatus> {
  return requestWithRetry(async (signal) => {
    const response = await fetch('/api/auth', {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
    const body = await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    }) as (SessionStatus & { error?: string }) | null;
    if (!response.ok || typeof body?.authenticated !== 'boolean') {
      throw new SessionError(body?.error || '登录服务暂不可用，请稍后重试', response.status);
    }
    // 后台检查不能把仍在编辑的旧页面切换成另一账号的写入身份。
    if (body.authenticated && !activeAccountId) activeAccountId = body.accountId;
    return body;
  }, {
    signal: init.signal,
    retry: (init.method || 'GET').toUpperCase() === 'GET',
    timeoutMessage: '登录连接超时，请重试',
    networkMessage: '网络连接失败，请重试',
  });
}

export function signIn(credentials: { username: string; password: string } | { key: string }) {
  return requestSession({ method: 'POST', body: JSON.stringify(credentials) });
}

export function register(credentials: { username: string; password: string; confirmPassword: string }) {
  return requestSession({ method: 'POST', body: JSON.stringify({ ...credentials, action: 'register' }) });
}

export async function apiFetch(url: string, init: RequestInit = {}) {
  const response = await accountFetch(url, init);
  if (response.status === 401) {
    // 个人外部服务尚未配置时，不把已登录的新账号带进重复刷新。
    const session = await requestSession();
    if (session.authenticated && session.accountId === activeAccountId) throw new Error('当前账号无法访问此服务');
    window.location.reload();
    throw new Error('登录已过期，请重新登录');
  }
  return response;
}

export function removeLegacyKey() {
  const url = new URL(window.location.href);
  if (url.searchParams.has('key')) {
    url.searchParams.delete('key');
    window.history.replaceState(window.history.state, '', url);
  }
  try { sessionStorage.removeItem('sync-secret'); } catch { /* 存储不可用时仍可登录 */ }
}

export async function restoreSession() {
  const url = new URL(window.location.href);
  let key = url.searchParams.get('key');
  if (!key) {
    try { key = sessionStorage.getItem('sync-secret'); } catch { /* 可使用登录表单 */ }
  }
  // 旧链接和旧标签页先交换服务端会话，再移除浏览器内的长期密钥。
  if (key) {
    try {
      const session = await signIn({ key });
      removeLegacyKey();
      return session;
    } catch (error) {
      // A transient failure must not consume the only credential on an old link.
      if (error instanceof SessionError && error.status === 401) removeLegacyKey();
      throw error;
    }
  }
  return requestSession();
}

export async function signOut() {
  const { triggerUpload } = await import('./syncEngine');
  await triggerUpload();
  const { useSyncStatus } = await import('./syncStatus');
  if (useSyncStatus.getState().state === 'error') throw new Error('保存失败，请重试后退出');
  await requestSession({ method: 'DELETE' });
  removeLegacyKey();
  try { localStorage.setItem('bonbills-logout-at', String(Date.now())); } catch { /* 当前页仍会退出 */ }
  window.location.reload();
}
