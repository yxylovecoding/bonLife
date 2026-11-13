import { createHash, createHmac, scryptSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from './auth';
import sync from './sync';
import backup from './sync-monthly-backup';
import mail from './latest-bill-attachment';
import boncv from './boncv-profile';
import ticktick from './ticktick-trips';
import outlook from './outlook-calendar';
import { READ_PHOTO } from './_clothesReads';
import { authOk, readAccount, readSession } from './_auth';

const { data, storage } = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const storage = {
    mget: vi.fn(async (...keys: string[]) => keys.map(key => data.get(key) ?? null)),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    mset: vi.fn(async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, value); return 'OK'; }),
    set: vi.fn(async (key: string, value: unknown, options?: { nx?: boolean }) => {
      if (options?.nx && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const value = Number(data.get(key) ?? 0) + 1;
      data.set(key, value);
      return value;
    }),
    hgetall: vi.fn(async (key: string) => data.get(key) ?? null),
    hget: vi.fn(async (key: string, field: string) => (data.get(key) as Record<string, unknown>)?.[field] ?? null),
    eval: vi.fn(),
    del: vi.fn(async (key: string) => Number(data.delete(key))),
  };
  return { data, storage };
});

vi.mock('@vercel/kv', () => ({ kv: storage }));

function request(method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return {
    method, body, query: {},
    headers: { host: 'bills.test', origin: 'https://bills.test', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as VercelRequest;
}

function response() {
  const result = { status: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    status(code: number) { result.status = code; return res; },
    json(body: unknown) { result.body = body; return res; },
    send(body: unknown) { result.body = body; return res; },
    setHeader(name: string, value: string) { result.headers[name] = value; return res; },
    end() { return res; },
  };
  return { res: res as unknown as VercelResponse, result };
}

async function call(req: VercelRequest, endpoint = handler) {
  const { res, result } = response();
  await endpoint(req, res);
  return result;
}

const credentials = { username: 'my-account', password: 'testpw' };
const keyCredentials = { key: 'test-original-key' };
async function login(body: unknown = keyCredentials) {
  const result = await call(request('POST', body));
  expect(result.status).toBe(200);
  return { result, cookie: result.headers['Set-Cookie'].split(';')[0] };
}

async function register(overrides: Record<string, unknown> = {}) {
  const input = { ...credentials, ...overrides };
  return call(request('POST', { action: 'register', confirmPassword: input.password, ...input }));
}

function seedLegacyOwner() {
  const salt = '00112233445566778899aabbccddeeff';
  const account = { ...credentials, password: undefined, passwordSalt: salt,
    passwordHash: scryptSync(credentials.password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex'),
    passwordAlgorithm: 'scrypt-v1', createdAt: '2026-09-01T00:00:00.000Z' };
  const key = `auth:account:v1:${createHmac('sha256', 'test-original-key').update('account-binding:v1').digest('hex')}`;
  data.set(key, account);
  return { account, key };
}

beforeEach(() => {
  vi.stubEnv('SYNC_SECRET', 'test-original-key');
  vi.stubEnv('LOGIN_USERNAME', '');
  vi.stubEnv('LOGIN_PASSWORD', undefined);
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  data.clear();
  vi.clearAllMocks();
  storage.eval.mockImplementation(async (script: string, keys: string[], args: string[]) => {
    if (script.includes("ARGV[1] then return redis.call('del'")) { if (data.get(keys[0]) === args[0]) data.delete(keys[0]); return 1; }
    if (script !== READ_PHOTO) throw new Error('Unexpected script');
    const photo = data.get(keys[0]) as string | undefined;
    if (!photo) return ['', ''];
    const etag = `"photo-v2-${createHash('sha1').update(photo).digest('hex')}"`;
    return [etag.slice(1, -1), JSON.parse(args[0]).includes(etag) ? '' : photo];
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('账号密码与 Key 登录', () => {
  it('未登录时不返回账号或账单', async () => {
    const result = await call(request());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ authenticated: false });
    expect(result.headers['Cache-Control']).toContain('no-store');
  });

  it('使用六位密码注册后可以登录，返回安全会话', async () => {
    expect((await register()).status).toBe(200);
    const { cookie, result } = await login(credentials);
    expect(result.body).toMatchObject({ authenticated: true, username: credentials.username });
    expect(result.headers['Set-Cookie']).toMatch(/HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
    expect(JSON.stringify(result)).not.toContain(credentials.password);
    const status = await call(request('GET', undefined, { cookie }));
    expect(status.body).toMatchObject({ authenticated: true, username: credentials.username });
  });

  it('原账号原密码及原 Key 保留同一份账单，迁移不修改原密码或账单', async () => {
    const legacy = seedLegacyOwner();
    const bills = { 'calendar-tags': { tagMap: { '2026-09-01': 'intern' } } };
    data.set('calendar-tags', bills['calendar-tags']);
    const passwordSession = await login(credentials);
    const keySession = await login(keyCredentials);
    for (const cookie of [passwordSession.cookie, keySession.cookie]) {
      const result = await call(request('GET', undefined, { cookie }), sync);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ...bills, bonCalRevision: expect.any(String) });
    }
    expect(await readAccount()).toEqual({ ...legacy.account, accountId: 'legacy' });
    expect(data.get(legacy.key)).toEqual(legacy.account);
    expect(data.get('calendar-tags')).toMatchObject(bills['calendar-tags']);
    expect(storage.set.mock.calls.every(([key]) => key.startsWith('auth:') || key.startsWith('boncal:') || key === 'outlook:calendar-write:lock')).toBe(true);
  });

  it.each([{ key: 'arbitrary-key' }, { username: 'other', password: 'test-original-key' }, { username: 'bon', password: 'wrong' }])(
    '错误凭据不能登录，也不会修改账单：%j', async (body) => {
      data.set('monthly-records', { records: [{ yearMonth: '2026-09', income: 1234 }] });
      const before = data.get('monthly-records');
      const result = await call(request('POST', body));
      expect(result.status).toBe(401);
      expect(result.headers['Set-Cookie']).toBeUndefined();
      expect(data.get('monthly-records')).toEqual(before);
      expect([...data.keys()].filter((key) => key.startsWith('auth:session:'))).toEqual([]);
    },
  );

  it('已有有效 Cookie 时，错误 Key 仍明确返回登录失败', async () => {
    const { cookie } = await login();
    const result = await call(request('POST', { key: 'wrong-key' }, { cookie }));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Key 错误' });
  });

  it('限制重复尝试，超过窗口后恢复', async () => {
    const start = 1_800_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    for (let index = 0; index < 10; index += 1) {
      expect((await call(request('POST', { key: 'wrong' }))).status).toBe(401);
    }
    const blocked = await call(request('POST', keyCredentials));
    expect(blocked.status).toBe(429);
    expect(blocked.headers['Retry-After']).toBe('900');
    now.mockReturnValue(start + 15 * 60 * 1000);
    expect((await call(request('POST', keyCredentials))).status).toBe(200);
  });

  it.each(['{', null, [], { username: 'bon' }, { key: '' }, { key: 'a'.repeat(1025) }])(
    '拒绝无效输入且不创建会话：%j', async (body) => {
      expect((await call(request('POST', body))).status).toBe(400);
      expect(storage.set).not.toHaveBeenCalled();
    },
  );

  it('拒绝跨站登录和表单提交', async () => {
    expect((await call(request('POST', credentials, { origin: 'https://other.test' }))).status).toBe(403);
    expect((await call(request('POST', credentials, { 'content-type': 'application/x-www-form-urlencoded' }))).status).toBe(415);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('存储故障时不放行', async () => {
    storage.set.mockRejectedValueOnce(new Error('storage unavailable'));
    const result = await call(request('POST', credentials));
    expect(result.status).toBe(503);
    expect(result.headers['Set-Cookie']).toBeUndefined();
  });

  it('未注册时不接受默认账号密码或旧环境变量账号', async () => {
    vi.stubEnv('LOGIN_USERNAME', 'configured');
    vi.stubEnv('LOGIN_PASSWORD', 'configured-password');
    expect((await call(request('POST', { username: 'bon', password: 'test-original-key' }))).status).toBe(401);
    expect((await call(request('POST', { username: 'configured', password: 'configured-password' }))).status).toBe(401);
    expect(await readAccount()).toBeNull();
  });

  it('无需 Key 即可注册，但新账号不能读取原账本或调用原账号私人代理', async () => {
    seedLegacyOwner();
    data.set('calendar-tags', { tagMap: { '2026-09-01': 'home' } });
    const created = await register({ username: 'new-user' });
    expect(created.status).toBe(200);
    const cookie = created.headers['Set-Cookie'].split(';')[0];
    expect((await call(request('GET', undefined, { cookie }), sync)).body).toMatchObject({ 'calendar-tags': { tagMap: {} }, bonCalRevision: expect.any(String) });
    for (const endpoint of [mail, boncv]) {
      expect((await call(request('GET', undefined, { cookie }), endpoint)).status).toBe(401);
    }
    expect(data.get('calendar-tags')).toEqual({ tagMap: { '2026-09-01': 'home' } });
  });

  it('绑定只保存账号和加盐密码哈希，不保存原密码或 Key', async () => {
    expect((await register()).status).toBe(200);
    const account = await readAccount(credentials.username);
    expect(account?.username).toBe(credentials.username);
    expect(account?.passwordHash).toMatch(/^[a-f0-9]{128}$/);
    expect(account?.passwordSalt).toMatch(/^[a-f0-9]{32}$/);
    expect(account?.passwordAlgorithm).toBe('scrypt-v1');
    const stored = JSON.stringify([...data]);
    expect(stored).not.toContain(credentials.password);
    expect(stored).not.toContain(keyCredentials.key);
  });

  it('新注册不能抢占旧账号名字，即使旧账号尚未登录迁移', async () => {
    const legacy = seedLegacyOwner();
    expect((await register({ password: 'replacement-password' })).status).toBe(409);
    expect(data.get(legacy.key)).toEqual(legacy.account);
    expect((await call(request('POST', credentials))).status).toBe(200);
    expect((await call(request('POST', { ...credentials, password: 'replacement-password' }))).status).toBe(401);
  });

  it('并发注册只能成功一次，绑定的密码与最终账号一致', async () => {
    const results = await Promise.all([
      register({ username: 'same-user', password: 'first-password' }),
      register({ username: 'same-user', password: 'second-password' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? 'first' : 'second';
    expect((await readAccount('same-user'))?.username).toBe('same-user');
    expect((await call(request('POST', { username: 'same-user', password: `${winner}-password` }))).status).toBe(200);
  });

  it.each([{ confirmPassword: '' }, { confirmPassword: undefined }, { confirmPassword: 'mismatch' }, { username: '' }, { password: 'short' }, { password: '' }])(
    '无效注册信息不能建立绑定：%j', async (overrides) => {
      expect((await register(overrides)).status).toBe(400);
      expect(await readAccount()).toBeNull();
    },
  );

  it('Key 登录不依赖账号注册，注册后既有 Key 会话仍有效', async () => {
    const { cookie } = await login();
    expect((await register()).status).toBe(200);
    expect(await authOk(request('GET', undefined, { cookie }))).toBe(true);
  });

  it('旧账号迁移后账号密码和会话不再依赖 Key', async () => {
    const original = seedLegacyOwner();
    const { cookie } = await login(credentials);
    for (const secret of ['another-key', '']) {
      vi.stubEnv('SYNC_SECRET', secret);
      expect(await readAccount()).toEqual({ ...original.account, accountId: 'legacy' });
      expect((await call(request('POST', credentials))).status).toBe(200);
      expect(await authOk(request('GET', undefined, { cookie }))).toBe(true);
    }
  });

  it('新账号注册和登录不要求配置 Key', async () => {
    vi.stubEnv('SYNC_SECRET', '');
    expect((await register()).status).toBe(200);
    expect((await call(request('POST', credentials))).status).toBe(200);
  });

  it('升级前的账号密码会话仍能访问原数据', async () => {
    const { account } = seedLegacyOwner();
    const token = 'b'.repeat(64);
    const version = createHmac('sha256', 'test-original-key').update(JSON.stringify([
      'account:v2', account.username, account.passwordSalt, account.passwordHash,
    ])).digest('hex');
    data.set(`auth:session:${createHash('sha256').update(token).digest('hex')}`, {
      kind: 'account', username: credentials.username, version, expiresAt: Date.now() + 60000,
    });
    expect(await readSession(request('GET', undefined, { cookie: `bonbills-session=${token}` })))
      .toMatchObject({ accountId: 'legacy', username: credentials.username });
  });

  it('新账号各自保存账单、备份，任意客户端字段不能指定他人的账本', async () => {
    data.set('bill-details', { private: 'owner' });
    const a = await register({ username: 'a' });
    const b = await register({ username: 'b' });
    const aCookie = a.headers['Set-Cookie'].split(';')[0];
    const bCookie = b.headers['Set-Cookie'].split(';')[0];
    const accountId = (a.body as { accountId: string }).accountId;
    const body = { 'bill-details': { private: 'a' }, accountId: 'legacy' };
    expect((await call(request('PUT', body, { cookie: aCookie }), sync)).status).toBe(200);
    expect((await call(request('GET', undefined, { cookie: aCookie }), sync)).body)
      .toMatchObject({ 'bill-details': { private: 'a' }, bonCalRevision: expect.any(String) });
    expect((await call(request('GET', undefined, { cookie: bCookie }), sync)).body).not.toHaveProperty('bill-details');
    expect((await call(request('POST', body, { cookie: aCookie }), backup)).status).toBe(200);
    expect(data.has(`account:${accountId}:sync-history:manual:index`)).toBe(true);
    expect(data.has('sync-history:manual:index')).toBe(false);
    expect(data.get('bill-details')).toEqual({ private: 'owner' });
  });

  it('衣柜、照片和日志通过同一账号隔离，并保留旧账号的数据', async () => {
    seedLegacyOwner();
    const originalItems = { item: { id: 'item', name: '原衣物' } };
    const originalEntries = { 'eyes:2026-10-05': { note: '原日志' } };
    data.set('bonclothes:items:v1', originalItems);
    data.set('bonlife:entries:v1:2026', originalEntries);
    const photoId = 'photo-original-id';
    const originalPhoto = 'data:image/png;base64,aGVsbG8=';
    data.set(`bonclothes:photo:v1:${photoId}`, originalPhoto);
    const created = await register({ username: 'new' });
    const cookie = created.headers['Set-Cookie'].split(';')[0];
    const clothesReq = request('GET', undefined, { cookie });
    clothesReq.query = { app: 'bonclothes', date: '2026-10-05' };
    const result = await call(clothesReq, outlook);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ items: [], records: [] });
    const lifeReq = request('GET', undefined, { cookie });
    lifeReq.query = { app: 'bonlife', year: '2026' };
    const lifeResult = await call(lifeReq, outlook);
    expect(lifeResult.status).toBe(200);
    expect(lifeResult.body).toMatchObject({ entries: {}, symptomHistory: {} });
    const photoReq = request('GET', undefined, { cookie });
    photoReq.query = { app: 'bonclothes', view: 'photo', id: photoId };
    expect((await call(photoReq, outlook)).status).toBe(404);
    const { cookie: ownerCookie } = await login(credentials);
    for (const req of [clothesReq, lifeReq, photoReq]) req.headers.cookie = ownerCookie;
    expect((await call(clothesReq, outlook)).body).toMatchObject({ items: Object.values(originalItems) });
    expect((await call(lifeReq, outlook)).body).toMatchObject({ entries: originalEntries });
    const ownerPhoto = await call(photoReq, outlook);
    expect(ownerPhoto.status).toBe(200);
    expect(ownerPhoto.body).toEqual(Buffer.from('hello'));
    // Reusing the owner's validator with another account cannot reveal existence
    // or produce a 304 for a photo that account does not own.
    photoReq.headers['if-none-match'] = ownerPhoto.headers.ETag;
    expect((await call(photoReq, outlook)).status).toBe(304);
    photoReq.headers.cookie = cookie;
    expect((await call(photoReq, outlook)).status).toBe(404);
    expect(storage.eval.mock.calls.at(-1)?.[1][0]).toMatch(/^account:[a-f0-9]{32}:bonclothes:photo:/);
    expect(storage.eval.mock.calls.at(-2)?.[1][0]).toBe(`bonclothes:photo:v1:${photoId}`);
    expect(data.get('bonclothes:items:v1')).toEqual(originalItems);
    expect(data.get('bonlife:entries:v1:2026')).toEqual(originalEntries);
  });

  it('另一标签页换账号后，旧页面请求不能写进新账号', async () => {
    const a = await register({ username: 'a' });
    const b = await register({ username: 'b' });
    const result = await call(request('PUT', { 'bill-details': { private: 'a' } }, {
      cookie: b.headers['Set-Cookie'].split(';')[0],
      'x-bonbills-account': (a.body as { accountId: string }).accountId,
    }), sync);
    expect(result.status).toBe(401);
    expect([...data.keys()].filter((key) => key.endsWith(':bill-details'))).toEqual([]);
  });

});

describe('会话与受保护接口', () => {
  it('退出立即撤销旧会话且保留账单', async () => {
    const { cookie } = await login();
    data.set('calendar-tags', { tagMap: { '2026-09-01': 'home' } });
    const result = await call(request('DELETE', undefined, { cookie }));
    expect(result.status).toBe(200);
    expect(result.headers['Set-Cookie']).toContain('Max-Age=0');
    expect(await authOk(request('GET', undefined, { cookie }))).toBe(false);
    expect(data.get('calendar-tags')).toEqual({ tagMap: { '2026-09-01': 'home' } });
  });

  it('过期、伪造、绑定已变化的会话均不能读取账单', async () => {
    expect((await register()).status).toBe(200);
    const { cookie } = await login(credentials);
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 24 * 60 * 60 * 1000);
    expect(await readSession(request('GET', undefined, { cookie }))).toBeNull();
    time.mockReturnValue(now);
    const accountKey = [...data.keys()].find((key) => key.startsWith('auth:account:'))!;
    data.set(accountKey, { ...await readAccount(credentials.username), passwordHash: '0'.repeat(128) });
    expect(await readSession(request('GET', undefined, { cookie }))).toBeNull();
    expect(await authOk(request('GET', undefined, { cookie: `bonbills-session=${'a'.repeat(64)}` }))).toBe(false);
  });

  it.each([sync, backup, mail, boncv, ticktick, outlook])('所有账单相关接口拒绝未认证访问', async (endpoint) => {
    const method = endpoint === backup ? 'POST' : 'GET';
    const result = await call(request(method, undefined, { authorization: 'Bearer arbitrary-key' }), endpoint);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'unauthorized' });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('Cookie 不能用于跨站读取或写入', async () => {
    const { cookie } = await login();
    expect(await authOk(request('PUT', {}, { cookie, origin: 'https://other.test' }))).toBe(false);
    expect(await authOk(request('GET', undefined, { cookie, 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('保留原 Bearer Key；登录 Cookie 不授权定时备份', async () => {
    expect(await authOk(request('GET', undefined, { authorization: 'Bearer test-original-key' }))).toBe(true);
    const { cookie } = await login();
    expect((await call(request('GET', undefined, { cookie }), backup)).status).toBe(401);
  });
});
