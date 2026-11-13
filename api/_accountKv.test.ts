import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kv } from './_accountKv';
import { authorizeAccountScope, runAccountRequest } from './_accountScope';
import { SAVE_WELL } from './_lifeWell';

const raw = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), hget: vi.fn(), hgetall: vi.fn(),
  del: vi.fn(), mset: vi.fn(), eval: vi.fn() }));
vi.mock('@vercel/kv', () => ({ kv: raw }));
const userA = 'a'.repeat(32), userB = 'b'.repeat(32);
beforeEach(() => vi.clearAllMocks());

describe('账号存储边界', () => {
  it('bonWell 日记录、症状索引和保存回执全部按账号隔离', async () => {
    const keys = ['bonlife:entries:v1:2026', 'bonlife:symptom-entries:v1', 'bonlife:well-mutation:v1:mutation'];
    await runAccountRequest(async () => { authorizeAccountScope(userA); await kv.eval(SAVE_WELL, keys, ['2026-11-13']); });
    expect(raw.eval).toHaveBeenCalledWith(SAVE_WELL, keys.map(key => `account:${userA}:${key}`), ['2026-11-13']);
  });
  it('已包装的 HTTP 请求在鉴权前不能读写数据', () => {
    expect(() => runAccountRequest(() => kv.get('bill-details'))).toThrow('Unauthenticated');
    expect(raw.get).not.toHaveBeenCalled();
  });

  it('原账号保持原键，注册账号隔离普通键、hash、批量写入和删除', async () => {
    await runAccountRequest(async () => {
      authorizeAccountScope('legacy');
      await kv.get('bill-details');
    });
    expect(raw.get).toHaveBeenCalledWith('bill-details');
    await runAccountRequest(async () => {
      authorizeAccountScope(userA);
      await kv.hget('bonclothes:items:v1', 'item');
      await kv.hgetall('bonlife:entries:v1:2026');
      await kv.set('bill-details', { amount: 10 }, { nx: true });
      await kv.mset({ 'calendar-tags': { test: 1 }, 'trip-tags': {} });
      await kv.del('first', 'second');
    });
    expect(raw.hget).toHaveBeenCalledWith(`account:${userA}:bonclothes:items:v1`, 'item');
    expect(raw.hgetall).toHaveBeenCalledWith(`account:${userA}:bonlife:entries:v1:2026`);
    expect(raw.set).toHaveBeenCalledWith(`account:${userA}:bill-details`, { amount: 10 }, { nx: true });
    expect(raw.mset).toHaveBeenCalledWith({ [`account:${userA}:calendar-tags`]: { test: 1 }, [`account:${userA}:trip-tags`]: {} });
    expect(raw.del).toHaveBeenCalledWith(`account:${userA}:first`, `account:${userA}:second`);
  });

  it('Lua 脚本使用的照片、回执和记录键全部隔离，保留空占位键', async () => {
    await runAccountRequest(async () => {
      authorizeAccountScope(userB);
      await kv.eval('script', ['items', 'receipt', 'photos', ''], ['original-argument']);
    });
    expect(raw.eval).toHaveBeenCalledWith('script', [`account:${userB}:items`, `account:${userB}:receipt`, `account:${userB}:photos`, ''], ['original-argument']);
  });

  it('并发请求及异步续接保持各自的账号，不污染定时任务', async () => {
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const first = runAccountRequest(async () => {
      authorizeAccountScope(userA);
      await pause;
      await kv.get('bill-details');
    });
    await runAccountRequest(async () => {
      authorizeAccountScope(userB);
      await kv.get('bill-details');
    });
    release();
    await first;
    await kv.get('bill-details');
    expect(raw.get.mock.calls).toEqual([[`account:${userB}:bill-details`], [`account:${userA}:bill-details`], ['bill-details']]);
  });

  it('未知命令不能绕过隔离', () => {
    expect(() => kv.keys('*')).toThrow('Unsupported');
  });
});
