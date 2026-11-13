import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readTickTickPlanDetails } from './_ticktickPlanDetails';
import { DAILY_PLAN_KEY } from './_ticktickDailyPlan';
const { data, upstream, write } = vi.hoisted(() => ({ data: new Map<string, any>(), upstream: vi.fn(), write: vi.fn() }));
vi.mock('@vercel/kv', () => ({ kv: { get: async (key: string) => structuredClone(data.get(key) ?? null), set: write } }));
vi.mock('./_ticktickTrips.js', async original => ({ ...await original<typeof import('./_ticktickTrips')>(),
  decryptTickTickToken: () => 'test-token', TickTickOpenApiClient: upstream }));
beforeEach(() => {
  data.clear(); vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());
it('仅返回当前连接已保存的排期快照，兼容旧版；不读取上游或触发重排', async () => {
  const briefing = { date: '2026-10-05', generatedAt: '2026-10-05T10:00:00Z',
    selected: [{ id: 'one', projectId: 'life', title: '只需一分钟', minutes: 1, reasons: ['上次完成较早'] }] };
  data.set('ticktick:connection:v1', { encryptedToken: {} });
  data.set(DAILY_PLAN_KEY, { connectionId: createHash('sha256').update('test-token').digest('hex'), briefing,
    history: [{ title: 'unrelated history' }], deadlines: { one: {} } });
  expect(await readTickTickPlanDetails()).toEqual(briefing);
  expect(upstream).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  data.get(DAILY_PLAN_KEY).connectionId = 'other-connection';
  expect(await readTickTickPlanDetails()).toBeNull();
  data.delete('ticktick:connection:v1');
  expect(await readTickTickPlanDetails()).toBeNull();
});

it('上海午夜后不返回昨日快照，不删除保存的历史；生成今日快照后即可读取', async () => {
  const briefing = { date: '2026-11-12', generatedAt: '2026-11-12T15:59:00Z', selected: [] };
  data.set('ticktick:connection:v1', { encryptedToken: {} });
  data.set(DAILY_PLAN_KEY, { connectionId: createHash('sha256').update('test-token').digest('hex'), briefing });
  vi.setSystemTime(new Date('2026-11-12T15:59:59Z'));
  expect(await readTickTickPlanDetails()).toEqual(briefing);
  vi.setSystemTime(new Date('2026-11-12T16:00:00Z'));
  expect(await readTickTickPlanDetails()).toBeNull();
  expect(data.get(DAILY_PLAN_KEY).briefing).toEqual(briefing);
  const today = { ...briefing, date: '2026-11-13', generatedAt: '2026-11-12T16:01:00Z' };
  data.get(DAILY_PLAN_KEY).briefing = today;
  vi.setSystemTime(new Date('2026-11-12T16:01:00Z'));
  expect(await readTickTickPlanDetails()).toEqual(today);
  expect(upstream).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it('按计划日期筛选，昨日轮次跨午夜才写入也不能成为今日排期', async () => {
  vi.setSystemTime(new Date('2026-11-12T16:01:00Z'));
  data.set('ticktick:connection:v1', { encryptedToken: {} });
  data.set(DAILY_PLAN_KEY, { connectionId: createHash('sha256').update('test-token').digest('hex'),
    briefing: { date: '2026-11-12', generatedAt: '2026-11-12T16:00:30Z', selected: [] } });
  expect(await readTickTickPlanDetails()).toBeNull();
});
