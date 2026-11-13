import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runRainReminderReplay, parseRainReplay } from './_rainReminderReplay';
import { defaultRuleConfig } from '../src/utils/schedulingRules';
import { rainReminderKey } from './_ticktickRainReminder';
import type { TickTickTask } from './_ticktickTrips';

const m = vi.hoisted(() => ({ data: new Map<string, any>(), tasks: [] as TickTickTask[], abandoned: [] as TickTickTask[], history: [] as TickTickTask[],
  create: vi.fn(), get: vi.fn(), historyRead: vi.fn(), filter: vi.fn(), acquire: vi.fn(), release: vi.fn(), weather: vi.fn(), locations: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => structuredClone(m.data.get(key) ?? null),
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => {
    if (options?.nx && m.data.has(key)) return null;
    m.data.set(key, structuredClone(value)); return 'OK';
  },
} }));
vi.mock('./_ticktickLock.js', () => ({ acquireTickTickLock: m.acquire, releaseTickTickLock: m.release }));
vi.mock('./_calendarWeather.js', () => ({ readCalendarLocations: m.locations }));
vi.mock('./_dailyWeather.js', () => ({ readDailyWeather: m.weather }));
vi.mock('./_ticktickTrips.js', async original => ({ ...await original<typeof import('./_ticktickTrips')>(),
  readAllTickTickTasks: async () => structuredClone(m.tasks), decryptTickTickToken: () => 'token',
  TickTickOpenApiClient: class { getTask = m.get; createTask = m.create; listCompletedTasks = m.historyRead; filterTasks = m.filter; },
}));
const date = '2026-11-13', projectId = '69f17edc5250bc28a6022933';
const input = { date, projectId, requestId: 'bon2-authorized-replay', mode: 'run', accountId: 'legacy' };
const key = rainReminderKey(createHash('sha256').update('token').digest('hex'));
const reminder = (status = 0): TickTickTask => ({ id: 'existing', projectId, title: '关窗', status,
  startDate: `${date}T08:00:00+0800`, dueDate: `${date}T08:00:00+0800`, tags: ['活', '当天'],
  timeZone: 'Asia/Shanghai', isAllDay: false, reminders: ['TRIGGER:PT0S'],
  ...status ? { completedTime: `${date}T09:00:00+0800` } : {} });
const run = async (override = {}) => {
  const report = vi.fn(); await runRainReminderReplay(JSON.stringify({ ...input, ...override }), report);
  return report.mock.calls.map(([value]) => value);
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${date}T15:00:00+08:00`)); vi.resetAllMocks();
  m.data.clear(); m.tasks = []; m.abandoned = []; m.history = [];
  m.data.set('ticktick:connection:v1', { projectId, encryptedToken: {} });
  m.data.set('ticktick:rules:v1', defaultRuleConfig()); m.data.set('calendar-tags', { tagMap: { [date]: 'home' } });
  m.acquire.mockResolvedValue('lock'); m.release.mockResolvedValue(undefined);
  m.filter.mockImplementation(async () => structuredClone(m.abandoned));
  m.historyRead.mockImplementation(async () => structuredClone(m.history));
  m.get.mockImplementation(async (_project, id) => structuredClone(m.tasks.find(task => task.id === id)));
  m.create.mockImplementation(async payload => { const task = { ...payload, id: 'created', status: 0 }; m.tasks.push(task); return structuredClone(task); });
  m.locations.mockResolvedValue({ [date]: { locations: [{ name: '广州', latitude: 23.13, longitude: 113.26 }] } });
  m.weather.mockResolvedValue({ stale: false, fetchedAt: new Date().toISOString(), days: { [date]: { code: 61, precipitation: 3 } } });
});
afterEach(() => vi.useRealTimers());

it('默认关闭，不读取数据或获得锁', async () => {
  const report = vi.fn(); await runRainReminderReplay(undefined, report); await runRainReminderReplay(' ', report);
  expect(m.acquire).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
});
it.each([{ date: '2026-11-12' }, { date: '2026-11-14' }, { accountId: 'other' }, { mode: 'force' },
  { projectId: '' }, { requestId: '../../request' }, { force: true }])('参数不合法时在读写前拒绝 %j', async change => {
  expect(() => parseRainReplay(JSON.stringify({ ...input, ...change }))).toThrow();
  expect((await run(change))[0].phase).toBe('rejected'); expect(m.acquire).not.toHaveBeenCalled();
});
it('共享锁被占用时不读取或补跑，不消耗请求', async () => {
  m.acquire.mockResolvedValue(null); expect((await run())[0].phase).toBe('busy');
  expect(m.historyRead).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled(); expect(m.data.has(key)).toBe(false);
});
it('连接清单不符时拒绝，不读取其他账号数据或创建', async () => {
  m.data.set('ticktick:connection:v1', { projectId: 'other' });
  expect((await run())[0].phase).toBe('rejected'); expect(m.filter).not.toHaveBeenCalled(); expect(m.release).toHaveBeenCalledOnce();
});
it('inspect 输出实际城市预报与去重记录，没有任务或当天标记写入', async () => {
  const result = await run({ mode: 'inspect' });
  expect(result.find(row => row.phase === 'preflight')).toMatchObject({ city: '广州', forecast: { rainy: true, precipitation: 3 }, tasks: [] });
  expect(result.at(-1).phase).toBe('inspected'); expect(m.create).not.toHaveBeenCalled(); expect(m.data.has(key)).toBe(false);
  expect(m.historyRead.mock.calls.every(([projects]) => projects.includes(projectId))).toBe(true);
  expect(m.filter).toHaveBeenCalledWith([projectId], [-1]);
});
it('下午补跑经过真实规划、提交及最终回读，只创建一次 08:00 关窗，重启不重放', async () => {
  const report = vi.fn();
  m.create.mockImplementation(async payload => {
    expect(report.mock.calls.some(([value]) => value.phase === 'preflight')).toBe(true);
    expect(m.data.has(key)).toBe(false);
    const task = { ...payload, id: 'created', status: 0 }; m.tasks.push(task); return task;
  });
  await runRainReminderReplay(JSON.stringify(input), report);
  expect(report.mock.calls.at(-1)![0]).toMatchObject({ phase: 'finished', rule: { status: 'success', updated: 1 }, checkedDay: date,
    tasks: [{ id: 'created', startDate: `${date}T08:00:00+0800`, dueDate: `${date}T08:00:00+0800`, tags: ['活', '当天'], reminders: ['TRIGGER:PT0S'] }] });
  expect(m.get).toHaveBeenCalledTimes(2); expect(m.data.get(key)).toBe(date);
  expect((await run())[0].phase).toBe('already-attempted'); expect(m.create).toHaveBeenCalledOnce();
});
it.each([0, 2, -1])('无当天标记但已有状态 %s 的今日提醒不重复创建', async status => {
  if (status === 0) m.tasks = [reminder()]; else if (status === 2) m.history = [reminder(2)]; else m.abandoned = [reminder(-1)];
  const result = await run();
  expect(result.at(-1).rule).toMatchObject({ status: 'success', reason: '已有同日关窗，不重复创建' });
  expect(m.create).not.toHaveBeenCalled(); expect(m.data.get(key)).toBe(date);
});
it('已检查标记仍有效，手动补跑不强制重建', async () => {
  m.data.set(key, date); const result = await run();
  expect(result.at(-1).rule.reason).toBe('当天已检查'); expect(m.create).not.toHaveBeenCalled();
});
it('无雨如实返回并保留原有无雨处理策略', async () => {
  m.weather.mockResolvedValue({ stale: false, days: { [date]: { code: 0, precipitation: 0 } } });
  const result = await run(); expect(result.at(-1).rule.reason).toBe('当天预报无雨，无需关窗提醒');
  expect(m.create).not.toHaveBeenCalled(); expect(m.data.get(key)).toBe(date);
});
it.each(['unknown-city', 'stale-weather', 'history', 'abandoned'] as const)('%s 未确认则不补建、不消耗当天', async kind => {
  if (kind === 'unknown-city') m.locations.mockResolvedValue({ [date]: { locations: [] } });
  if (kind === 'stale-weather') m.weather.mockResolvedValue({ stale: true, days: {} });
  if (kind === 'history') m.historyRead.mockRejectedValue(new Error('unavailable'));
  if (kind === 'abandoned') m.filter.mockResolvedValue(Array.from({ length: 200 }, () => reminder(-1)));
  const result = await run();
  if (kind === 'unknown-city' || kind === 'stale-weather') expect(result.at(-1).rule.status).toBe('failed');
  else expect(result.at(-1).phase).toBe('failed');
  expect(m.create).not.toHaveBeenCalled(); expect(m.data.has(key)).toBe(false);
});
it('缺少当天预报时保留城市与来源诊断，实际雨天规则失败且不建任务', async () => {
  m.weather.mockResolvedValue({ stale: false, fetchedAt: new Date().toISOString(), days: {} });
  const result = await run();
  expect(result).toContainEqual(expect.objectContaining({ phase: 'source', city: '广州' }));
  expect(result).toContainEqual(expect.objectContaining({ phase: 'source', forecast: expect.objectContaining({ available: false, stale: false }) }));
  expect(result.at(-1).rule).toMatchObject({ status: 'failed', reason: '当天降雨预报未确认' });
  expect(m.create).not.toHaveBeenCalled(); expect(m.data.has(key)).toBe(false);
});
it('回读失败保留重试机会但同一人工请求不自动重复，下一请求从真实记录恢复', async () => {
  m.get.mockResolvedValue(undefined); const failed = await run();
  expect(failed.at(-1).rule.status).toBe('failed'); expect(m.data.has(key)).toBe(false);
  expect((await run())[0].phase).toBe('already-attempted'); expect(m.create).toHaveBeenCalledOnce();
  m.get.mockImplementation(async (_project, id) => structuredClone(m.tasks.find(task => task.id === id)));
  const recovered = await run({ requestId: 'bon2-confirmed-recovery' });
  expect(recovered.at(-1).rule.status).toBe('success'); expect(m.create).toHaveBeenCalledOnce(); expect(m.data.get(key)).toBe(date);
});
it('上次进程中断只有 started 记录时不自动重放', async () => {
  m.data.set(`ticktick:rain-replay:v1:${input.requestId}:run`, { phase: 'started' });
  expect((await run())[0].phase).toBe('already-attempted'); expect(m.create).not.toHaveBeenCalled(); expect(m.historyRead).not.toHaveBeenCalled();
});
it('创建后的最终回读变化不能保存当天成功，也不把旧快照作为确认结果返回', async () => {
  let reads = 0;
  m.get.mockImplementation(async () => ({ ...m.tasks[0], ...++reads === 2 ? { startDate: '2026-11-14T08:00:00+0800' } : {} }));
  const result = await run(); expect(result.at(-1).rule.status).toBe('failed');
  expect(result.at(-1).tasks).toEqual([]); expect(m.data.has(key)).toBe(false); expect(m.create).toHaveBeenCalledOnce();
});
it.each(['removed', 'predecessor'])('仍尊重雨天规则 %s 配置', async kind => {
  const config = defaultRuleConfig();
  if (kind === 'removed') config.removed = ['rain-reminder']; else config.predecessors['rain-reminder'] = ['calendar-travel'];
  m.data.set('ticktick:rules:v1', config);
  const result = await run(); expect(result.at(-1).rule.status).toBe('skipped'); expect(m.create).not.toHaveBeenCalled(); expect(m.data.has(key)).toBe(false);
});
