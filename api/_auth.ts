import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { kv } from './_storage.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizeAccountScope } from './_accountScope.js';
import { ORCHE_HOST } from '../src/utils/apps.js';

const COOKIE_NAME = 'bonbills-session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;

export interface Session {
  kind: 'key' | 'account';
  accountId?: string;
  username: string;
  version: string;
  expiresAt: number;
  orcheJobId?: string;
}

export interface BoundAccount {
  accountId?: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  passwordAlgorithm: 'scrypt-v1';
  createdAt: string;
}

export function loginConfig() {
  const secret = (process.env.SYNC_SECRET || '').trim();
  return { secret };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

function equal(left: string, right: string) {
  return timingSafeEqual(new Uint8Array(digest(left)), new Uint8Array(digest(right)));
}

function legacyAccountKey() {
  const fingerprint = createHmac('sha256', loginConfig().secret).update('account-binding:v1').digest('hex');
  return `auth:account:v1:${fingerprint}`;
}

const OWNER_ACCOUNT_KEY = 'auth:owner:v2';
const usernameKey = (username: string) => `auth:account:v2:${digest(username).toString('hex')}`;

export async function readOwnerAccount(): Promise<BoundAccount | null> {
  const saved = await kv.get<BoundAccount>(OWNER_ACCOUNT_KEY);
  if (saved) return saved;
  if (!loginConfig().secret) return null;
  const legacy = await kv.get<BoundAccount>(legacyAccountKey());
  if (!legacy) return null;
  // 原密码哈希、盐和原账本不动；固定归属不再依赖 Key。保留旧绑定便于回滚。
  const owner = { ...legacy, accountId: 'legacy' };
  const created = await kv.set(OWNER_ACCOUNT_KEY, owner, { nx: true });
  return created ? owner : kv.get<BoundAccount>(OWNER_ACCOUNT_KEY);
}

export async function readAccount(username?: string): Promise<BoundAccount | null> {
  // 新注册前先保留旧账号的名字，不能让新账号抢占既有数据。
  const owner = await readOwnerAccount();
  if (username === undefined || owner?.username === username) return owner;
  return kv.get<BoundAccount>(usernameKey(username));
}

function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

export async function registerAccount(username: string, password: string): Promise<BoundAccount | null> {
  if (await readAccount(username)) return null;
  const passwordSalt = randomBytes(16).toString('hex');
  const account: BoundAccount = {
    accountId: randomBytes(16).toString('hex'),
    username,
    passwordSalt,
    passwordHash: await hashPassword(password, passwordSalt),
    passwordAlgorithm: 'scrypt-v1',
    createdAt: new Date().toISOString(),
  };
  // NX 保证同名并发注册不能替换已有密码或账本归属。
  const saved = await kv.set(usernameKey(username), account, { nx: true });
  return saved ? account : null;
}

export async function authenticateAccount(username: string, password: string): Promise<BoundAccount | null> {
  const account = await readAccount(username);
  if (!account || account.passwordAlgorithm !== 'scrypt-v1') return null;
  const usernameMatches = equal(username, account.username);
  const passwordMatches = equal(await hashPassword(password, account.passwordSalt), account.passwordHash);
  return usernameMatches && passwordMatches ? account : null;
}

export function keyMatches(key: string) {
  const secret = loginConfig().secret;
  return Boolean(secret && equal(key, secret));
}

function legacyCredentialVersion(account?: BoundAccount) {
  const identity = account
    ? ['account:v2', account.username, account.passwordSalt, account.passwordHash]
    : ['key:v2'];
  return createHmac('sha256', loginConfig().secret).update(JSON.stringify(identity)).digest('hex');
}

function credentialVersion(account: BoundAccount) {
  return digest(JSON.stringify(['account:v3', account.accountId, account.username, account.passwordSalt, account.passwordHash])).toString('hex');
}

export function sameOrigin(req: VercelRequest) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const protocol = process.env.VERCEL === '1' || process.env.RENDER === 'true' ? 'https'
      : String(req.headers['x-forwarded-proto'] || 'http');
    return url.host === req.headers.host && url.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

function sessionKey(req: VercelRequest) {
  const token = (req.headers.cookie || '').split(';')
    .map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token)
    ? `auth:session:${digest(token).toString('hex')}`
    : null;
}

export async function readSession(req: VercelRequest): Promise<Session | null> {
  if (!sameOrigin(req)) return null;
  const key = sessionKey(req);
  if (!key) return null;
  const session = await kv.get<Session>(key);
  if (!session || session.expiresAt <= Date.now()) return null;
  if (session.kind === 'key') {
    if (!loginConfig().secret || !equal(session.version, legacyCredentialVersion())) return null;
    const owner = await readOwnerAccount();
    return { ...session, accountId: 'legacy', username: owner?.username ?? '' };
  }
  if (session.kind !== 'account') return null;
  const account = await readAccount(session.username);
  const version = account && (session.accountId ? credentialVersion(account) : legacyCredentialVersion(account));
  if (!account || session.username !== account.username
    || (session.accountId && session.accountId !== account.accountId)
    || (!session.accountId && account.accountId !== 'legacy')
    || !version || !equal(session.version, version)) return null;
  return { ...session, accountId: account.accountId };
}

export async function authOk(req: VercelRequest, options: { ownerOnly?: boolean } = {}) {
  // 保留服务端脚本使用的 Bearer 鉴权；浏览器只使用 HttpOnly 会话。
  const secret = loginConfig().secret;
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1].trim();
  if (secret && bearer && equal(bearer, secret)) {
    authorizeAccountScope('legacy');
    return true;
  }
  const session = await readSession(req);
  if (!session?.accountId || (options.ownerOnly && session.accountId !== 'legacy')) return false;
  const expectedAccount = req.headers['x-bonbills-account'];
  if (expectedAccount && expectedAccount !== session.accountId) return false;
  authorizeAccountScope(session.accountId);
  return true;
}

function cookie(req: VercelRequest, value: string, maxAge: number) {
  const secure = process.env.VERCEL === '1' || process.env.RENDER === 'true' || process.env.NODE_ENV === 'production'
    || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export async function deleteSession(req: VercelRequest) {
  const key = sessionKey(req);
  if (key) await kv.del(key);
}

export async function createSession(req: VercelRequest, res: VercelResponse, account?: BoundAccount) {
  await deleteSession(req);
  const token = randomBytes(32).toString('hex');
  const session: Session = {
    kind: account ? 'account' : 'key',
    accountId: account?.accountId ?? 'legacy',
    username: account?.username ?? '',
    version: account ? credentialVersion(account) : legacyCredentialVersion(),
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  };
  const orcheRequestId = req.headers.host === ORCHE_HOST && session.accountId === 'legacy' ? randomUUID() : undefined;
  if (orcheRequestId) session.orcheJobId = `manual-${orcheRequestId}`;
  const key = `auth:session:${digest(token).toString('hex')}`;
  await kv.set(key, session, { ex: SESSION_SECONDS });
  res.setHeader('Set-Cookie', cookie(req, token, SESSION_SECONDS));

  if (orcheRequestId) {
    try {
      const { dispatchFullReplan } = await import('./_cloudScheduler.js');
      const { jobId } = await dispatchFullReplan(orcheRequestId);
      // The queue can join an existing full run. Keep that run attached to this login.
      if (jobId !== session.orcheJobId) {
        const confirmed = { ...session, orcheJobId: jobId };
        await kv.set(key, confirmed, { xx: true, keepTtl: true });
        return confirmed;
      }
    } catch {
      // Login remains valid. The session can still look up the assigned ID
      // after an uncertain queue response without dispatching a second run.
    }
  }
  return session;
}

export function clearSessionCookie(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Set-Cookie', cookie(req, '', 0));
}

export async function allowLoginAttempt(req: VercelRequest) {
  // Vercel 覆盖该头，避免用客户端可伪造的普通 forwarded-for 绕过限流。
  const ip = process.env.VERCEL === '1'
    ? String(req.headers['x-vercel-forwarded-for'] || 'unknown').split(',')[0].trim()
    : req.socket?.remoteAddress || 'local';
  const window = Math.floor(Date.now() / (LOGIN_WINDOW_SECONDS * 1000));
  const key = `auth:attempts:${digest(ip).toString('hex')}:${window}`;
  await kv.set(key, 0, { nx: true, ex: LOGIN_WINDOW_SECONDS });
  return await kv.incr(key) <= 10;
}
