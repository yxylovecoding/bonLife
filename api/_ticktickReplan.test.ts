import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRuleReplan } from './_ruleReplan';
import { replanRemainingToday } from './_ticktickReplan';
import { defaultRuleConfig, readRuleConfig, removeSchedulingRule, type SchedulingRuleId } from '../src/utils/schedulingRules';
import { DAILY_PLAN_KEY, DAILY_PLAN_SETTINGS_KEY } from './_ticktickDailyPlan';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';
import type { TickTickTask } from './_ticktickTrips';

const m = vi.hoisted(() => ({ data: new Map<string, any>(), tasks: [] as TickTickTask[], history: [] as TickTickTask[], abandoned: [] as TickTickTask[], abandonedRead: vi.fn(),
  get: vi.fn(), write: vi.fn(), create: vi.fn(), historyRead: vi.fn(), snapshot: vi.fn(), fullOutlook: vi.fn(), saveOutlook: vi.fn(),
  acquire: vi.fn(), release: vi.fn(), laundry: vi.fn(), exercise: vi.fn(), hairOutlook: vi.fn(), chargingOutlook: vi.fn(),
  trip: vi.fn(), wish: vi.fn(), period: vi.fn(), pickupOutlook: vi.fn(), locationFailure: false, city: '北京' }));
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => structuredClone(m.data.get(key) ?? null), hgetall: async (key: string) => structuredClone(m.data.get(key) ?? null),
  set: async (key: string, value: unknown) => { m.data.set(key, structuredClone(value)); return 'OK'; },
} }));
vi.mock('./_ticktickLock.js', () => ({ acquireTickTickLock: m.acquire, releaseTickTickLock: m.release }));
vi.mock('./_outlookSync.js', () => ({ OUTLOOK_CONNECTION_KEY: 'outlook:calendar-connection:v1', syncOutlookCalendar: m.fullOutlook, saveOutlookSnapshot: m.saveOutlook }));
vi.mock('./_outlookCalendar.js', () => ({ decryptOutlookConnection: () => ({ policy: 'manual' }), readOutlookSnapshot: m.snapshot }));
vi.mock('./_taskVisibilityRules.js', async original => ({ ...await original<typeof import('./_taskVisibilityRules')>(),
  visibilityInputs: async () => ({ journal: m.data.get('journal') ?? {}, locations: m.locationFailure ? null : { names: ['北京', '广州', '清迈'], today: m.city ? [m.city] : [], unknown: !m.city } }) }));
vi.mock('./_ticktickLaundry.js', async original => ({ ...await original<typeof import('./_ticktickLaundry')>(), syncLaundrySchedule: m.laundry }));
vi.mock('./_ticktickExercise.js', async original => ({ ...await original<typeof import('./_ticktickExercise')>(), syncExerciseSchedule: m.exercise }));
vi.mock('./_lifeTraining.js', () => ({ syncTrainingSource: async () => ({}) }));
vi.mock('./_outlookHairWash.js', () => ({ syncHairWashOutlook: m.hairOutlook }));
vi.mock('./_outlookCharging.js', () => ({ syncChargingOutlook: m.chargingOutlook }));
vi.mock('./_outlookLaundry.js', () => ({ syncLaundryOutlook: async () => ({ created: 0, updated: 0 }) }));
vi.mock('./_outlookRecurringTaskEvents.js', () => ({ syncRecurringTaskOutlook: m.pickupOutlook }));
vi.mock('./_ticktickPeriodPrediction.js', () => ({ syncPeriodPredictionTask: m.period }));
vi.mock('./_ticktickTrips.js', async original => ({ ...await original<typeof import('./_ticktickTrips')>(),
  decryptTickTickToken: () => 'test-token', readAllTickTickTasks: async (api: any, statuses: number[]) => api.filterTasks
    ? api.filterTasks([], statuses) : structuredClone(m.tasks.filter(t => statuses.includes(t.status ?? 0))),
  readConnectedTickTickTemplate: async () => ({ rootTask: { id: 'template' }, tasks: [] }),
  reconcileTickTickTrips: m.trip, reconcileTickTickWishPreparations: m.wish,
  TickTickOpenApiClient: class { getTask = m.get; updateTask = m.write; createTask = m.create; listCompletedTasks = m.historyRead; filterTasks = m.abandonedRead; },
}));
const day = '2026-11-03';
const task = (id: string, extra: Partial<TickTickTask> = {}): TickTickTask => ({ id, projectId: 'life', title: id, status: 0,
  isAllDay: true, dueDate: `${day}T00:00:00+0800`, content: '(15m)', ...extra });
const hash = createHash('sha256').update('test-token').digest('hex');
const config = (first: SchedulingRuleId[], predecessors = {}) => { const value = defaultRuleConfig();
  m.data.set('ticktick:rules:v1', readRuleConfig({ ...value, version: 7, order: [...first, ...value.order.filter(id => !first.includes(id))], predecessors })); };
const status = (result: any, id: SchedulingRuleId) => result.rules.results.find((r: any) => r.id === id);

it.each(['full', 'hourly', 'visibility'] as const)('%s 删除阅读显隐后不再改变对应标签，独立规则照常完成', async scope => {
  const saved = removeSchedulingRule(readRuleConfig(defaultRuleConfig()), 'visibility-reading');
  m.data.set('ticktick:rules:v1', saved);
  m.tasks = [task('reading', { title: '阅读', tags: ['routine', 'hidden'] })];
  const result = await runRuleReplan({ scope });
  expect(status(result, 'visibility-reading')).toMatchObject({ status: 'skipped', reason: '已删除，不执行' });
  expect(m.tasks[0].tags).toEqual(['routine', 'hidden']);
  expect(result.rulesComplete).toBe(true);
});

it('删除 Outlook 写入及日历规则不会调用该写入，也不阻断其他规则', async () => {
  let saved = removeSchedulingRule(readRuleConfig(defaultRuleConfig()), 'outlook-hair');
  saved = removeSchedulingRule(saved, 'calendar-travel');
  m.data.set('ticktick:rules:v1', saved);
  const result = await runRuleReplan({ scope: 'full' });
  expect(m.hairOutlook).not.toHaveBeenCalled(); expect(m.chargingOutlook).toHaveBeenCalledOnce();
  expect(status(result, 'calendar-travel').status).toBe('skipped');
  expect(status(result, 'daily-plan').status).toBe('success'); expect(result.rulesComplete).toBe(true);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${day}T21:45:00+08:00`)); vi.resetAllMocks();
  m.data.clear(); m.tasks = []; m.history = []; m.abandoned = []; m.city = '北京'; m.locationFailure = false;
  m.acquire.mockResolvedValue('lock'); m.release.mockResolvedValue(undefined);
  m.data.set('ticktick:connection:v1', { encryptedToken: {}, projectId: 'life', templateRootId: 'template', timeZone: 'Asia/Shanghai' });
  m.data.set('outlook:laundry-write:v1', { calendarId: 'test-calendar' });
  m.data.set(DAILY_PLAN_SETTINGS_KEY, { budgetMinutes: 240 });
  m.data.set('calendar-tags', { tagMap: { [day]: 'school', '2026-11-04': 'school', '2026-11-05': 'home' } });
  m.get.mockImplementation(async (_project, id) => structuredClone(m.tasks.find(t => t.id === id)));
  m.write.mockImplementation(async (id, payload) => { const current = m.tasks.find(t => t.id === id)!; Object.assign(current, payload); return structuredClone(current); });
  m.create.mockImplementation(async payload => { const saved = { ...payload, id: `created-${m.tasks.length}`, status: 0 }; m.tasks.push(saved); return structuredClone(saved); });
  m.abandonedRead.mockImplementation(async (projects, statuses) => structuredClone(statuses.includes(-1)
    ? m.abandoned.filter(t => projects.includes(t.projectId)) : m.tasks.filter(t => statuses.includes(t.status ?? 0))));
  m.historyRead.mockImplementation(async () => structuredClone(m.history));
  m.snapshot.mockResolvedValue({ startDate: day, endDate: '2026-12-03', tags: {}, availability: { startDate: day, endDate: '2026-12-03', events: [] } });
  m.fullOutlook.mockResolvedValue({ connected: false });
  m.laundry.mockResolvedValue({ updated: 0, managedTaskIds: new Set(), decisions: [] });
  m.exercise.mockResolvedValue({ updated: 0, managedTaskIds: new Set(), minimumDates: new Map(), fixedDates: new Map() });
  m.hairOutlook.mockResolvedValue({ created: 0, updated: 0 }); m.chargingOutlook.mockResolvedValue({ created: 0, updated: 0 });
  m.pickupOutlook.mockResolvedValue({ created: 0, updated: 0 });
  m.trip.mockResolvedValue({}); m.wish.mockResolvedValue({}); m.period.mockResolvedValue({ created: 0, updated: 0 });
});
afterEach(() => vi.useRealTimers());

describe('每天首次 Orche 显示 BonLog 今日训练', () => {
  const key = `ticktick:training-visible-day:v1:${hash}`;
  const workout = (id: string, extra: Partial<TickTickTask> = {}) => task(id, { title: '燃脂操-运动💪🏻是生活的第一个锚点🪝',
    priority: 5, tags: ['hidden', 'bon-hidden', 'routine', '动', '当天'], repeatFlag: 'RRULE:FREQ=WEEKLY;BYDAY=SA', ...extra });
  const planned = (dates = new Map([['training', day]])) => m.exercise.mockResolvedValue({ updated: 0,
    managedTaskIds: new Set(dates.keys()), minimumDates: new Map(), fixedDates: dates });
  it('首次仅去掉当天已安排训练的隐藏标签，保留其他字段；同日不重清，次日重新处理', async () => {
    const original = workout('training');
    m.tasks = [structuredClone(original), workout('future', { dueDate: '2026-11-05T00:00:00+0800' }), task('other', { tags: ['hidden'], priority: 5 })];
    planned(new Map([['training', day], ['future', '2026-11-05']]));
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0]).toEqual({ ...original, tags: ['routine', '动', '当天'] });
    expect(m.tasks[1].tags).toContain('hidden'); expect(m.tasks[2].tags).toContain('hidden');
    expect(m.data.get(key)).toBe(day);
    m.tasks[0].tags!.push('hidden'); m.write.mockClear();
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].tags).toContain('hidden'); expect(m.write).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-11-04T09:00:00+08:00'));
    m.tasks[0].dueDate = '2026-11-04T00:00:00+0800'; planned(new Map([['training', '2026-11-04']]));
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].tags).not.toContain('hidden'); expect(m.data.get(key)).toBe('2026-11-04');
  });
  it('改到今天与取消隐藏合并写入，并覆盖当次具体时刻隐藏', async () => {
    m.tasks = [workout('training', { tags: ['hidden', '动'], isAllDay: false, startDate: '2026-11-04T22:00:00+0800', dueDate: '2026-11-04T22:00:00+0800' })];
    m.exercise.mockImplementation(async (api, options) => {
      if (options.rolling) await api.updateTask('training', { startDate: `${day}T22:00:00+0800`, dueDate: `${day}T22:00:00+0800` });
      return { updated: 0, managedTaskIds: new Set(['training']), minimumDates: new Map(), fixedDates: new Map([['training', day]]) };
    });
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].tags).toEqual(['动']); expect(m.write).toHaveBeenCalledOnce(); expect(m.data.get(key)).toBe(day);
  });
  it.each(['hourly', 'visibility', 'midnight'] as const)('%s 不消耗当天首次训练显示', async mode => {
    m.tasks = [workout('training')]; planned();
    if (mode === 'midnight') vi.setSystemTime(new Date(`${day}T00:10:00+08:00`));
    await runRuleReplan({ scope: mode === 'midnight' ? 'full' : mode });
    expect(m.tasks[0].tags).toContain('hidden'); expect(m.data.has(key)).toBe(false);
  });
  it('当天完成和放弃的系列不取消隐藏', async () => {
    m.tasks = [workout('training'), workout('abandoned', { title: '全身力训-运动💪🏻是生活的第一个锚点🪝' })];
    m.history = [{ ...m.tasks[0], status: 2, completedTime: `${day}T08:00:00+08:00` }];
    m.abandoned = [{ ...m.tasks[1], status: -1, completedTime: `${day}T08:00:00+08:00` }];
    planned(new Map(m.tasks.map(t => [t.id, day])));
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks.every(t => t.tags?.includes('hidden'))).toBe(true);
  });
  it('训练读取失败或标签写入未确认时不记录成功，修复后可继续首次处理', async () => {
    m.tasks = [workout('training')]; m.exercise.mockRejectedValue(new Error('training unavailable'));
    await runRuleReplan({ scope: 'full' }); expect(m.data.has(key)).toBe(false);
    planned(); m.write.mockResolvedValue(undefined);
    const failed = await runRuleReplan({ scope: 'full' });
    expect(status(failed, 'exercise').status).toBe('failed'); expect(m.data.has(key)).toBe(false);
    m.write.mockImplementation(async (id, payload) => { Object.assign(m.tasks.find(t => t.id === id)!, payload); return structuredClone(m.tasks.find(t => t.id === id)!); });
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].tags).not.toContain('hidden'); expect(m.data.get(key)).toBe(day);
  });
});

describe('统一显隐裁决', () => {
  it.each(['full', 'hourly', 'visibility'] as const)('%s 使用 hidden，兼容清理旧标签且未变化不重写', async scope => {
    config(['visibility-location', 'visibility-reading']);
    const original = task('r', { title: '阅读', tags: ['广州', 'routine', 'bon-hidden', 'hidden'],
      priority: 3, repeatFlag: 'RRULE:FREQ=DAILY', reminders: ['TRIGGER:PT0S'] });
    m.tasks = [structuredClone(original)];
    await runRuleReplan({ scope });
    expect(m.tasks[0]).toEqual({ ...original, tags: ['广州', 'routine', 'hidden'] });
    expect(m.write).toHaveBeenCalledOnce();
    await runRuleReplan({ scope });
    expect(m.write).toHaveBeenCalledOnce();
    m.city = '广州';
    await runRuleReplan({ scope });
    expect(m.tasks[0]).toEqual({ ...original, tags: ['广州', 'routine'] });
    expect(m.write).toHaveBeenCalledTimes(2);
  });
  it('地点读取失败时不迁移旧隐藏标签，保留原状态', async () => {
    m.locationFailure = true;
    const original = task('r', { title: '阅读', tags: ['广州', 'routine', 'bon-hidden'] });
    m.tasks = [structuredClone(original)];
    await runRuleReplan({ scope: 'visibility' });
    expect(m.tasks[0]).toEqual(original); expect(m.write).not.toHaveBeenCalled();
  });
  it.each(['full', 'hourly', 'visibility'] as const)('%s 入口读取同一配置，地点优先于阅读，其他字段不变', async scope => {
    config(['visibility-location', 'visibility-reading']);
    m.tasks = [task('r', { title: '阅读', tags: ['广州', 'routine', '活'], priority: 3, repeatFlag: 'RRULE:FREQ=DAILY', reminders: ['TRIGGER:PT0S'] })];
    const before = structuredClone(m.tasks[0]); const result = await runRuleReplan({ scope });
    expect(result.rules!.version).toBe(7); expect(m.tasks[0]).toEqual({ ...before, tags: [...before.tags!, 'hidden'] });
    expect(m.write).toHaveBeenCalledOnce();
  });
  it('拖动阅读到地点之前确实改变冲突结果', async () => {
    m.tasks = [task('r', { title: '阅读', tags: ['广州', 'routine', 'hidden'] })];
    config(['visibility-reading', 'visibility-location']); await runRuleReplan({ scope: 'visibility' });
    expect(m.tasks[0].tags).toEqual(['广州', 'routine']);
  });
  it('跨日切换城市，多地点满足任一，移除地点标签后解除系统持有的隐藏', async () => {
    m.tasks = [task('r', { tags: ['广州', '清迈', 'routine'] }), task('plain', { tags: ['routine'] })];
    await runRuleReplan({ scope: 'visibility' }); expect(m.tasks[0].tags).toContain('hidden');
    m.city = '广州'; vi.setSystemTime(new Date('2026-11-04T09:00:00+08:00'));
    await runRuleReplan({ scope: 'visibility' }); expect(m.tasks[0].tags).not.toContain('hidden');
    m.city = ''; await runRuleReplan({ scope: 'visibility' }); expect(m.tasks[0].tags).toContain('hidden');
    m.tasks[0].tags = ['routine', 'hidden']; await runRuleReplan({ scope: 'visibility' });
    expect(m.tasks[0].tags).toEqual(['routine']); expect(m.tasks[1].tags).toEqual(['routine']);
  });
  it('地点读取失败保留原显隐，并标记失败而非误判地点', async () => {
    m.locationFailure = true; m.tasks = [task('r', { title: '阅读', tags: ['广州', 'hidden'] })];
    const result = await runRuleReplan({ scope: 'visibility' }); expect(status(result, 'visibility-location').status).toBe('failed');
    expect(m.write).not.toHaveBeenCalled(); expect(m.tasks[0].tags).toContain('hidden');
  });
  it('无日期改动的显隐入口不会调用完整日历、生成任务或专项排期', async () => {
    m.tasks = [task('t', { isAllDay: false, dueDate: '2026-11-04T22:00:00+0800' })];
    await runRuleReplan({ scope: 'visibility', visibilityKind: 'timed' });
    expect(m.tasks[0].tags).toEqual(['hidden']); expect(m.fullOutlook).not.toHaveBeenCalled();
    for (const fn of [m.trip, m.wish, m.exercise, m.laundry, m.hairOutlook]) expect(fn).not.toHaveBeenCalled();
  });
  it('夜间入口只维护显隐和运动，不扩大到完整重排', async () => {
    await runRuleReplan({ scope: 'visibility', visibilityKind: 'night' }); expect(m.exercise).toHaveBeenCalledOnce();
    for (const fn of [m.fullOutlook, m.trip, m.wish, m.laundry, m.hairOutlook]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('城市待办日期', () => {
  const arrival = '2027-02-12';
  beforeEach(() => {
    m.city = '广州';
    m.data.set('app-config', { config: { schoolCity: BEIJING, homeCity: GUANGZHOU } });
    m.data.set('calendar-tags', { tagMap: { [day]: 'home', '2027-02-11': 'home', [arrival]: 'school', '2027-02-13': 'school' } });
  });
  it.each(['full', 'hourly', 'visibility', 'midnight'] as const)('%s 固定今日先满足地点，排到二月且重复同步不拉回', async mode => {
    if (mode === 'midnight') vi.setSystemTime(new Date(`${day}T00:01:00+08:00`));
    m.data.set('calendar-tags', { tagMap: { [day]: 'school', [arrival]: 'school' }, dayOverrides: { [day]: { city: GUANGZHOU } } });
    const original = task('bedtime', { title: '下班洗洗睡觉!', priority: 5, tags: ['always-today', '北京', '居', 'routine', 'hidden'],
      startDate: `${day}T21:50:00+0800`, dueDate: `${day}T22:20:00+0800`, isAllDay: false,
      repeatFlag: 'RRULE:FREQ=DAILY', repeatFrom: '1', reminders: ['TRIGGER:PT0S'] });
    m.tasks = [structuredClone(original)];
    const options = { scope: mode === 'midnight' ? 'hourly' as const : mode, visibilityKind: 'all' as const };
    const result = await runRuleReplan(options);
    expect(status(result, 'always-today').status).toBe('success');
    expect(m.tasks[0]).toEqual({ ...original, startDate: `${arrival}T21:50:00+0800`, dueDate: `${arrival}T22:20:00+0800` });
    expect(m.write).toHaveBeenCalledOnce();
    await runRuleReplan(options); expect(m.write).toHaveBeenCalledOnce();
  });
  it.each([['always-today', 'scene-date'], ['scene-date', 'always-today']] as SchedulingRuleId[][])('%s / %s 的排序都不能绕过地点', async (first, second) => {
    config([first, second]);
    m.tasks = [task('bedtime', { tags: ['always-today', '北京', '居', 'hidden'], repeatFlag: 'RRULE:FREQ=DAILY' })];
    await runRuleReplan({ scope: 'hourly' });
    expect(m.tasks[0].dueDate).toBe(`${arrival}T00:00:00+0800`);
  });
  it('固定今日的城市来源失败时不改日期', async () => {
    m.locationFailure = true;
    m.tasks = [task('bedtime', { tags: ['always-today', '北京', '居', 'hidden'] })];
    const result = await runRuleReplan({ scope: 'hourly' });
    expect(status(result, 'always-today').status).toBe('failed');
    expect(m.write).not.toHaveBeenCalled();
  });
  it.each(['full', 'hourly'] as const)('%s 喷雾地点与错日共同满足，不锁住逾期日，重复运行不漂移', async scope => {
    m.tasks = [task('fragrance', { title: '香香喷雾', tags: ['北京', '居', '寄', 'hidden'],
      repeatFlag: 'RRULE:FREQ=WEEKLY', repeatFrom: '1', startDate: '2026-11-01T08:00:00+0800',
      dueDate: '2026-11-01T08:01:00+0800', isAllDay: false, reminders: ['TRIGGER:PT0S'] }),
      task('mite', { title: '除螨喷雾', tags: ['北京', '居', 'hidden'], repeatFlag: 'RRULE:FREQ=WEEKLY' })];
    m.history = [{ ...m.tasks[0], status: 2, completedTime: '2026-10-01T08:00:00+0800' },
      { ...m.tasks[1], status: 2, completedTime: '2026-10-02T08:00:00+0800' }];
    const result = await runRuleReplan({ scope });
    expect(status(result, 'sprays')).toMatchObject({ status: 'success', conflicts: [] });
    expect(m.tasks[0]).toMatchObject({ startDate: `${arrival}T08:00:00+0800`, dueDate: `${arrival}T08:01:00+0800`,
      repeatFlag: 'RRULE:FREQ=WEEKLY', repeatFrom: '1', reminders: ['TRIGGER:PT0S'] });
    expect(m.tasks[1].dueDate).toBe('2027-02-13T00:00:00+0800');
    expect(m.tasks[0].tags).toEqual(['北京', '居', '寄', 'hidden']);
    expect(m.write).toHaveBeenCalledTimes(2);
    await runRuleReplan({ scope }); expect(m.write).toHaveBeenCalledTimes(2);
  });
  it.each([['sprays', 'scene-date'], ['scene-date', 'sprays']] as SchedulingRuleId[][])('交换 %s / %s 顺序不改变兼容约束', async (first, second) => {
    config([first, second]);
    m.tasks = [task('fragrance', { title: '香香喷雾', tags: ['北京', '居', 'hidden'], repeatFlag: 'RRULE:FREQ=WEEKLY' })];
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].dueDate).toBe(`${arrival}T00:00:00+0800`);
  });
  it('返京次日地点不符时继续找共同适用日，不能仅加一天', async () => {
    m.data.set('calendar-tags', { tagMap: { [day]: 'home', [arrival]: 'school', '2027-02-13': 'home', '2027-02-14': 'school' } });
    m.tasks = [task('a', { title: '香香喷雾', tags: ['北京', '居', 'hidden'] }), task('b', { title: '除螨喷雾', tags: ['北京', '居', 'hidden'] })];
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks.map(t => t.dueDate)).toEqual([`${arrival}T00:00:00+0800`, '2027-02-14T00:00:00+0800']);
  });
  it('当天放弃与未知重复不被错日覆盖，其他喷雾避开其日期', async () => {
    m.tasks = [task('a', { title: '香香喷雾', tags: ['北京', '居', 'hidden'], dueDate: `${arrival}T00:00:00+0800` }),
      task('b', { title: '除螨喷雾', tags: ['北京', '居', 'hidden'], repeatFlag: 'unsupported', dueDate: `${arrival}T00:00:00+0800` })];
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks.map(t => t.dueDate)).toEqual(['2027-02-13T00:00:00+0800', `${arrival}T00:00:00+0800`]);
    m.tasks[1].repeatFlag = 'RRULE:FREQ=WEEKLY';
    m.abandoned = [{ ...m.tasks[1], status: -1, completedTime: `${day}T08:00:00+0800` }];
    m.write.mockClear(); await runRuleReplan({ scope: 'full' }); expect(m.write).not.toHaveBeenCalled();
  });
  it('喷雾错开后的未来时刻会重新隐藏', async () => {
    m.city = '北京';
    m.data.set('calendar-tags', { tagMap: { [day]: 'school', '2026-11-04': 'school' } });
    m.tasks = [task('a', { title: '香香喷雾', tags: ['居', 'routine'], isAllDay: false, startDate: `${day}T20:00:00+0800`, dueDate: `${day}T20:01:00+0800` }),
      task('b', { title: '除螨喷雾', tags: ['居', 'routine'], isAllDay: false, startDate: `${day}T20:00:00+0800`, dueDate: `${day}T20:01:00+0800` })];
    const result = await runRuleReplan({ scope: 'full' });
    expect(status(result, 'sprays').status).toBe('success');
    expect(m.tasks[1]).toMatchObject({ startDate: '2026-11-04T20:00:00+0800', dueDate: '2026-11-04T20:01:00+0800', tags: ['居', 'routine', 'hidden'] });
  });
  it('实际完成占用当天；写后未确认时标记喷雾规则失败', async () => {
    m.city = '北京';
    m.data.set('calendar-tags', { tagMap: { [day]: 'school', '2026-11-04': 'school' } });
    m.tasks = [task('a', { title: '香香喷雾', tags: ['北京', '居', 'routine'], repeatFlag: 'RRULE:FREQ=WEEKLY' })];
    m.history = [task('done-mite', { title: '除螨喷雾', status: 2, completedTime: `${day}T08:00:00+0800` })];
    m.write.mockResolvedValue(undefined);
    const failed = await runRuleReplan({ scope: 'full' });
    expect(status(failed, 'sprays').status).toBe('failed');
    expect(m.tasks[0].dueDate).toBe(`${day}T00:00:00+0800`);
    m.write.mockImplementation(async (id, payload) => { Object.assign(m.tasks.find(t => t.id === id)!, payload); return structuredClone(m.tasks.find(t => t.id === id)!); });
    const result = await runRuleReplan({ scope: 'full' });
    expect(status(result, 'sprays').status).toBe('success');
    expect(m.tasks[0].dueDate).toBe('2026-11-04T00:00:00+0800');
  });
  it('无共同可用日期或地点读取失败时不提交部分喷雾改期', async () => {
    m.data.set('calendar-tags', { tagMap: { [day]: 'home', [arrival]: 'school' } });
    m.tasks = [task('a', { title: '香香喷雾', tags: ['北京', '居', 'hidden'] }), task('b', { title: '除螨喷雾', tags: ['北京', '居', 'hidden'] })];
    const result = await runRuleReplan({ scope: 'full' });
    expect(status(result, 'sprays').status).toBe('failed'); expect(m.write).not.toHaveBeenCalled();
    m.locationFailure = true;
    await runRuleReplan({ scope: 'full' }); expect(m.write).not.toHaveBeenCalled();
  });
  it.each(['full', 'hourly'] as const)('%s 将已隐藏的过期北京待办跨年顺延并保持重复、提醒和时刻，重试幂等', async scope => {
    const original = task('beijing', { tags: ['hidden', '北京市', '玩'], dueDate: '2026-11-01T15:30:00+0800',
      startDate: '2026-11-01T14:30:00+0800', isAllDay: false, priority: 3,
      repeatFlag: 'RRULE:FREQ=WEEKLY', repeatFrom: 2, reminders: ['TRIGGER:PT0S'] });
    m.tasks = [structuredClone(original)];
    const result = await runRuleReplan({ scope });
    expect(status(result, 'scene-date').status).toBe('success');
    expect(m.tasks[0]).toEqual({ ...original, startDate: `${arrival}T14:30:00+0800`, dueDate: `${arrival}T15:30:00+0800` });
    expect(m.write).toHaveBeenCalledOnce();
    await runRuleReplan({ scope });
    expect(m.write).toHaveBeenCalledOnce();
  });
  it('城市和场景共同匹配，当前同属居也不能保留异地长周期的过期日', async () => {
    m.data.set('calendar-tags', { tagMap: { [day]: 'school', [arrival]: 'school' }, dayOverrides: { [day]: { city: GUANGZHOU } } });
    m.tasks = [task('both', { tags: ['居', '北京', 'hidden'], repeatFlag: 'RRULE:FREQ=WEEKLY' }),
      task('no-match', { tags: ['寄', '北京', 'hidden'] }), task('either', { tags: ['广州', '北京', 'routine'] })];
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].dueDate).toBe(`${arrival}T00:00:00+0800`);
    expect(m.tasks[1].dueDate).toBe(`${day}T00:00:00+0800`);
    expect(m.tasks[2].dueDate).toBe(`${day}T00:00:00+0800`);
  });
  it('未来正确日期、已完成、当天放弃和未知重复规则保留，独立显隐不改日期', async () => {
    m.tasks = [task('future', { tags: ['北京', 'hidden'], dueDate: '2027-02-13T00:00:00+0800' }),
      task('done', { tags: ['北京'], status: 2, completedTime: `${day}T10:00:00+0800` }),
      task('abandoned', { tags: ['北京', 'hidden'] }),
      task('unknown', { tags: ['北京', 'hidden'], repeatFlag: 'unsupported' }),
      task('overdue', { tags: ['北京', 'hidden'] })];
    m.abandoned = [task('abandoned', { status: -1, completedTime: `${day}T10:00:00+0800` })];
    const dates = m.tasks.map(t => t.dueDate);
    await runRuleReplan({ scope: 'visibility' });
    expect(m.tasks.map(t => t.dueDate)).toEqual(dates);
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks.slice(0, 4).map(t => t.dueDate)).toEqual(dates.slice(0, 4));
    expect(m.tasks[4].dueDate).toBe(`${arrival}T00:00:00+0800`);
  });
  it('城市读取失败或没有明确的未来地点时保留原日期', async () => {
    m.tasks = [task('beijing', { tags: ['北京', 'hidden'] })];
    m.locationFailure = true;
    const result = await runRuleReplan({ scope: 'hourly' });
    expect(status(result, 'scene-date').status).toBe('failed');
    expect(m.write).not.toHaveBeenCalled();
    m.locationFailure = false;
    m.data.set('calendar-tags', { tagMap: { [day]: 'home', [arrival]: 'travel' } });
    await runRuleReplan({ scope: 'hourly' });
    expect(m.tasks[0].dueDate).toBe(`${day}T00:00:00+0800`);
  });
});

describe('残留完成时间的固定今日任务', () => {
  it.each(['full', 'hourly', 'visibility'] as const)('%s 将明确未完成的子任务移到今天，写后确认且重复执行不重写', async scope => {
    const info = vi.spyOn(console, 'info');
    const original = task('reopened', { title: 'transformer', parentId: 'parent', tags: ['always-today', '班'],
      dueDate: '2026-11-02T00:00:00+0800', completedTime: '2026-09-17T04:14:43.000+0000', content: '(1.5h)', priority: 3 });
    m.tasks = [structuredClone(original)];
    const result = await runRuleReplan({ scope, visibilityKind: 'all' });
    expect(status(result, 'always-today')).toMatchObject({ status: 'success', updated: 1 });
    expect(m.tasks[0]).toEqual({ ...original, dueDate: `${day}T00:00:00+0800` });
    expect(info).toHaveBeenCalledWith('[ticktick-reopened-date]', JSON.stringify({
      titleHash: createHash('sha256').update(original.title).digest('hex').slice(0, 16), date: day, scope, verified: true,
    }));
    expect(m.write).toHaveBeenCalledOnce();
    info.mockRestore();
    await runRuleReplan({ scope, visibilityKind: 'all' });
    expect(m.write).toHaveBeenCalledOnce();
  });
  it('同日放弃保护仍覆盖带旧完成时间的重复系列', async () => {
    const original = task('reopened', { tags: ['always-today'], repeatFlag: 'RRULE:FREQ=DAILY',
      completedTime: '2026-09-17T04:14:43Z', dueDate: '2026-11-04T00:00:00+0800' });
    m.tasks = [structuredClone(original)];
    m.abandoned = [{ ...original, id: 'old', status: -1, completedTime: `${day}T08:00:00+08:00` }];
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0]).toEqual(original); expect(m.write).not.toHaveBeenCalled();
  });
});

describe('日期优先级与失败传播', () => {
  it.each([false, true])('洗衣与固定今日冲突使用真实拖动顺序（洗衣优先 %s），合并后只写一次', async laundryFirst => {
    m.tasks = [task('wash', { title: '洗衣服', tags: ['always-today'], dueDate: '2026-11-09T00:00:00+0800' })];
    config(laundryFirst ? ['laundry', 'always-today'] : ['always-today', 'laundry']);
    m.laundry.mockImplementation(async (api: any) => { await api.updateTask('wash', { dueDate: '2026-11-08T00:00:00+0800' }); return { managedTaskIds: new Set(['wash']) }; });
    const result = await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].dueDate).toBe(`${laundryFirst ? '2026-11-08' : day}T00:00:00+0800`); expect(m.write).toHaveBeenCalledOnce();
    const loser = status(result, laundryFirst ? 'always-today' : 'laundry'); expect(loser.conflicts[0].winner).toBe(laundryFirst ? 'laundry' : 'always-today');
  });
  it('前序计算失败跳过依赖链，独立阅读继续，低优先级不替代失败日期', async () => {
    config(['laundry', 'always-today'], { exercise: ['laundry'], 'daily-plan': ['exercise'] });
    m.tasks = [task('wash', { title: '洗衣服', tags: ['always-today'], dueDate: '2026-11-09T00:00:00+0800' }), task('r', { title: '阅读', tags: ['routine', 'hidden'] })];
    m.laundry.mockRejectedValue(new Error('private provider body'));
    const result = await runRuleReplan({ scope: 'full' });
    expect(status(result, 'laundry').status).toBe('failed'); expect(status(result, 'daily-plan').status).toBe('skipped'); expect(status(result, 'exercise').status).toBe('skipped'); expect(status(result, 'exercise-rollover').status).toBe('success');
    expect(m.tasks[0].dueDate).toBe('2026-11-09T00:00:00+0800'); expect(m.tasks[1].tags).toEqual(['routine']); expect(JSON.stringify(result)).not.toContain('private provider');
  });
  it('小时入口不拿旧的范围外前序结果绕过绑定', async () => {
    config([], { 'daily-plan': ['laundry'] }); m.tasks = [task('large', { content: '(1h)' })];
    const result = await replanRemainingToday(); expect(status(result, 'daily-plan').status).toBe('skipped'); expect(m.write).not.toHaveBeenCalled();
  });
  it('前序写入失败后不执行依赖 Outlook 分支，独立分支继续', async () => {
    config([], { 'outlook-hair': ['always-today'] }); m.tasks = [task('hair', { title: '洗头', tags: ['always-today'], dueDate: '2026-11-08T00:00:00+0800' })];
    m.write.mockRejectedValue(new Error('network')); const result = await runRuleReplan({ scope: 'full' });
    expect(status(result, 'always-today').status).toBe('failed'); expect(status(result, 'outlook-hair').status).toBe('skipped');
    expect(m.hairOutlook).not.toHaveBeenCalled(); expect(m.chargingOutlook).toHaveBeenCalledOnce();
  });
  it('Outlook 读取本轮已确认日期，读取完成历史后才安排月经提醒', async () => {
    m.tasks = [task('hair', { title: '洗头', tags: ['always-today'], dueDate: '2026-11-08T00:00:00+0800' })];
    m.history = [task('old', { title: '月经提醒', status: 2, completedTime: '2026-11-02T09:00:00+0800' })];
    await runRuleReplan({ scope: 'full' });
    expect(m.hairOutlook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tasks: [expect.objectContaining({ dueDate: `${day}T00:00:00+0800` })] }));
    expect(m.period).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ completedTasks: expect.arrayContaining([expect.objectContaining({ id: 'old' })]) }));
  });
  it.each(['completed', 'edited'])('并发 %s 被写前校验拒绝，保留原任务及旧计划', async kind => {
    m.tasks = [task('large', { content: '(1h)' })]; m.get.mockResolvedValueOnce({ ...m.tasks[0], ...(kind === 'completed' ? { status: 2 } : { content: 'changed' }) });
    const result = await replanRemainingToday(); expect(status(result, 'daily-plan').status).toBe('failed'); expect(m.write).not.toHaveBeenCalled(); expect(result.dailyPlan).toBeUndefined();
  });
  it('历史失败保留旧计划和日期，独立显隐仍完成', async () => {
    const summary = { date: '2026-11-02', todayCount: 8 };
    m.data.set(DAILY_PLAN_KEY, { connectionId: hash, history: [], deadlines: {}, summary });
    m.tasks = [task('large', { content: '(1h)' }), task('r', { title: '阅读', tags: ['routine', 'hidden'] })];
    m.historyRead.mockRejectedValue(new Error('private history'));
    const result = await replanRemainingToday(); expect(result.dailyPlan).toEqual(summary); expect(status(result, 'daily-plan').status).toBe('failed');
    expect(m.tasks[0].dueDate).toContain(day); expect(m.tasks[1].tags).toEqual(['routine']); expect(m.data.get(DAILY_PLAN_KEY).summary).toEqual(summary);
  });
  it('只有 Outlook 连接时仍刷新订阅', async () => {
    m.data.delete('ticktick:connection:v1'); await runRuleReplan({ scope: 'full', allowDisconnected: true }); expect(m.fullOutlook).toHaveBeenCalledOnce();
  });
  it.each([false, true])('日历版本在待办写入前确认，过期快照不产生任务写入：%s', async stale => {
    m.tasks = [task('large', { content: '(1h)' })];
    m.fullOutlook.mockResolvedValue({ connected: true, connection: { id: 'calendar' }, policy: 'manual', requestedAt: Date.now(),
      snapshot: { startDate: day, endDate: '2026-12-03', tags: {} },
      availability: { startDate: day, endDate: '2026-12-03', events: [] } });
    m.saveOutlook.mockImplementation(async () => {
      expect(m.write).not.toHaveBeenCalled();
      if (stale) throw new Error('日历已更新，请重新同步');
    });
    if (stale) {
      await expect(runRuleReplan({ scope: 'full' })).rejects.toThrow('日历已更新');
      expect(m.write).not.toHaveBeenCalled(); expect(m.tasks[0].dueDate).toContain(day);
    } else {
      const result = await runRuleReplan({ scope: 'full' });
      expect(status(result, 'daily-plan').status).toBe('success');
      expect(m.saveOutlook).toHaveBeenCalledOnce(); expect(m.tasks[0].dueDate).toContain('2026-11-04');
      expect(result.details!.date).toBe(day);
    }
  });
  it('独立待办生成失败不丢弃已确认的今日预算结果，仍报告该规则失败', async () => {
    m.data.set(DAILY_PLAN_KEY, { connectionId: hash, history: [], deadlines: {}, summary: { date: '2026-11-02', todayCount: 8 } });
    m.tasks = [task('a-selected'), task('b-deferred')];
    m.period.mockRejectedValue(new Error('unavailable'));
    const result = await runRuleReplan({ scope: 'full' });
    expect(status(result, 'period-reminder').status).toBe('failed'); expect(result.rulesComplete).toBe(false);
    expect(status(result, 'daily-plan').status).toBe('success');
    expect(m.tasks[1].dueDate).toContain('2026-11-04');
    expect(m.data.get(DAILY_PLAN_KEY).summary).toMatchObject({ date: day, todayCount: 1, plannedMinutes: 15 });
    expect(result.details!.rules!.results.find(rule => rule.id === 'period-reminder')!.status).toBe('failed');
  });
});

describe('小时轮换保留原业务边界', () => {
  it.each([['daily-plan', 'scene-date'], ['scene-date', 'daily-plan']] as const)(
    '%s 在 %s 之前：场景合适但未排入预算的任务隐藏，重新入选时恢复', async (first, second) => {
      config([first, second]);
      vi.setSystemTime(new Date(day + 'T09:00:00+08:00'));
      m.data.set(DAILY_PLAN_SETTINGS_KEY, { budgetMinutes: 40 });
      const future = '2026-11-04T00:00:00+0800';
      m.tasks = [task('书衣', { tags: ['居', '玩'], content: '(2h)', dueDate: future }),
        task('已手动隐藏', { tags: ['hidden'] }), task('未来普通项', { dueDate: future, content: '(2h)' })];
      const firstRun = await runRuleReplan({ scope: 'full' });
      expect(firstRun.details?.selected).toEqual([]);
      expect(m.tasks[0].dueDate?.slice(0, 10)).toBe(first === 'daily-plan' ? '2026-11-04' : day);
      expect(m.tasks[0].tags).toEqual(['居', '玩', 'hidden']);
      expect(m.tasks[2].tags).toBeUndefined();
      await runRuleReplan({ scope: 'visibility', visibilityKind: 'daily' });
      expect(m.tasks[0].tags).toContain('hidden');
      await runRuleReplan({ scope: 'hourly' });
      expect(m.tasks[0].tags).toContain('hidden');
      vi.setSystemTime(new Date(day + 'T09:30:00+08:00'));
      m.data.set(DAILY_PLAN_SETTINGS_KEY, { budgetMinutes: 240 });
      const expanded = await runRuleReplan({ scope: 'hourly' });
      expect(expanded.details?.selected.some(item => item.id === '书衣')).toBe(true);
      expect(m.tasks[0].tags).toEqual(['居', '玩']);
      expect(m.tasks[1].tags).toEqual(['hidden']);
    });
  it('预算隐藏恢复时继续服从其他隐藏原因', async () => {
    m.tasks = [task('书衣', { tags: ['居', '北京'], content: '(2h)' })];
    await runRuleReplan({ scope: 'hourly' });
    expect(m.tasks[0].tags).toContain('hidden');
    m.city = '广州';
    vi.setSystemTime(new Date(day + 'T09:00:00+08:00'));
    const result = await runRuleReplan({ scope: 'hourly' });
    expect(result.details?.selected).toEqual([]);
    expect(m.tasks[0].tags).toEqual(['居', '北京', 'hidden']);
  });
  it('滴答已加标签但回包丢失时，下轮仍能恢复预算隐藏', async () => {
    m.tasks = [task('书衣', { tags: ['居'], content: '(2h)' })];
    m.write.mockImplementationOnce(async (_id, payload) => {
      Object.assign(m.tasks[0], payload);
      throw new Error('connection lost');
    });
    const failed = await runRuleReplan({ scope: 'hourly' });
    expect(status(failed, 'daily-plan').status).toBe('failed');
    expect(m.tasks[0].tags).toContain('hidden');
    vi.setSystemTime(new Date('2026-11-04T09:00:00+08:00'));
    const next = await runRuleReplan({ scope: 'hourly' });
    expect(next.details?.selected.map(item => item.id)).toContain('书衣');
    expect(m.tasks[0].tags).toEqual(['居']);
  });
  it.each(['full', 'hourly'] as const)('%s 不把缺少状态但带完成时间的记录交给普通轮换，其他未完成任务仍按剩余时间延期', async scope => {
    const completed = task('a-completed', { status: undefined, completedTime: '2026-11-02T10:00:00+0800', content: '(1h)' });
    m.tasks = [structuredClone(completed), task('b-selected'), task('c-deferred')];
    const result = await runRuleReplan({ scope });
    expect(status(result, 'daily-plan').status).toBe('success');
    expect(m.tasks[0]).toEqual(completed);
    expect(m.tasks[1].dueDate).toContain(day);
    expect(m.tasks[2].dueDate).toContain('2026-11-04');
    expect(result.dailyPlan).toMatchObject({ todayCount: 1, plannedMinutes: 15 });
    expect(m.write.mock.calls.map(([id]) => id)).toEqual(['c-deferred']);
  });
  it.each(['00:30', '01:01', '04:59', '05:00'])('%s 自动入口休息，连写锁也不获取', async time => {
    vi.setSystemTime(new Date(`${day}T${time}:00+0800`)); expect(await replanRemainingToday({ scheduled: true })).toEqual({ busy: false, skipped: 'rest-window' }); expect(m.acquire).not.toHaveBeenCalled();
  });
  it('最久未完成者先选，较新完成者延期，引用同轮规则版本', async () => {
    m.tasks = [task('older'), task('newer')]; m.history = [task('older', { status: 2, completedTime: '2026-10-01T12:00:00+0800' }), task('newer', { status: 2, completedTime: '2026-10-28T12:00:00+0800' })];
    const result = await replanRemainingToday(); expect(result.dailyPlan).toMatchObject({ todayCount: 1, plannedMinutes: 15 });
    expect(m.tasks[0].dueDate).toContain(day); expect(m.tasks[1].dueDate).toContain('2026-11-04'); expect(result.details!.rules!.version).toBe(0);
  });
  it('高优先级、未来未选中、routine、训练及洗衣均不被普通轮换改期', async () => {
    m.tasks = [task('important', { priority: 5, dueDate: '2026-11-05T00:00:00+0800' }), task('future', { content: '(1h)', dueDate: '2026-11-05T00:00:00+0800' }),
      task('routine', { tags: ['routine'] }), task('training', { title: '游泳' }), task('wash', { title: '洗衣服' })];
    const before = structuredClone(m.tasks); await replanRemainingToday(); expect(m.tasks).toEqual(before);
  });
  it('当日已完成的唯一重复系列保留下一次日期', async () => {
    m.tasks = [task('next', { title: '固定今日', tags: ['always-today'], repeatFlag: 'RRULE:FREQ=DAILY', dueDate: '2026-11-04T00:00:00+0800' })];
    m.history = [task('previous', { title: '固定今日', status: 2, completedTime: `${day}T09:00:00+0800` })];
    await replanRemainingToday(); expect(m.tasks[0].dueDate).toContain('2026-11-04'); expect(m.write).not.toHaveBeenCalled();
  });
  it('普通轮换保留其他标签、提醒、重复设置和原 checklist 日期', async () => {
    m.tasks = [task('large', { content: '(1h)', tags: ['活'], reminders: ['TRIGGER:PT0S'], repeatFlag: 'RRULE:FREQ=DAILY',
      items: [{ id: 'item', title: 'child', status: 0, startDate: `${day}T00:00:00+0800` }] })];
    const before = structuredClone(m.tasks[0]); await replanRemainingToday();
    expect(m.tasks[0]).toEqual({ ...before, tags: ['活', 'hidden'], dueDate: '2026-11-04T00:00:00+0800' });
  });
});

describe('远端新增专项接入同一裁决', () => {
  const eyeDrop = (hour: string) => task(hour, { title: '眼药水', priority: 5, isAllDay: false,
    dueDate: `2026-11-02T${hour}:00:00+0800`, repeatFlag: 'RRULE:FREQ=DAILY', repeatFrom: '1', tags: ['always-today'] });

  it('五条定时待办按各自的实际到期时刻逐条替换', async () => {
    const times = ['08:17', '11:32', '14:06', '18:41', '22:23'];
    m.tasks = times.map(time => ({ ...eyeDrop(time), dueDate: `2026-11-02T${time}:00+0800` }));
    for (const [index, time] of times.entries()) {
      vi.setSystemTime(new Date(`${day}T${time}:00+08:00`));
      await runRuleReplan({ scope: 'hourly' });
      expect(m.tasks.filter(task => !task.tags?.includes('hidden')).map(task => task.id)).toEqual([time]);
      for (const [slot, task] of m.tasks.entries()) {
        const date = slot < index ? '2026-11-04' : day;
        expect(Date.parse(task.dueDate!)).toBe(Date.parse(`${date}T${times[slot]}:00+08:00`));
      }
    }
  });

  it('12 点只有 10 点到期，13 点才把 10 点移到明天并隐藏', async () => {
    m.tasks = [eyeDrop('10'), eyeDrop('13')];
    vi.setSystemTime(new Date(`${day}T12:00:00+08:00`));
    await runRuleReplan({ scope: 'hourly' });
    expect(m.tasks.map(t => [t.dueDate, t.tags])).toEqual([
      [`${day}T10:00:00+0800`, ['always-today']], [`${day}T13:00:00+0800`, ['always-today', 'hidden']],
    ]);
    m.write.mockClear();
    await runRuleReplan({ scope: 'full' });
    expect(m.write).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(`${day}T13:00:00+08:00`));
    await runRuleReplan({ scope: 'hourly' });
    expect(m.tasks.map(t => [Date.parse(t.dueDate!), t.tags])).toEqual([
      [Date.parse('2026-11-04T10:00:00+08:00'), ['always-today', 'hidden']],
      [Date.parse(`${day}T13:00:00+08:00`), ['always-today']],
    ]);
    m.write.mockClear();
    await runRuleReplan({ scope: 'full' });
    expect(m.write).not.toHaveBeenCalled();
  });

  it.each([['eye-drops', 'always-today'], ['always-today', 'eye-drops']] as const)(
    '%s、%s 同轮处理多条昨日积压时，每条只写一次', async (first, second) => {
      config([first, second]);
      m.tasks = [eyeDrop('10'), eyeDrop('13')];
      const run = await runRuleReplan({ scope: 'full' });
      expect(status(run, 'eye-drops')).toMatchObject({ status: 'success', conflicts: [] });
      expect(Date.parse(m.tasks[0].dueDate!)).toBe(Date.parse('2026-11-04T10:00:00+08:00'));
      expect(m.tasks[0].tags).toContain('hidden');
      expect(m.tasks[1]).toMatchObject({ dueDate: `${day}T13:00:00+0800`, tags: ['always-today'] });
      expect(m.write.mock.calls.map(([id]) => id).sort()).toEqual(['10', '13']);
    });

  it('眼药水推进后重新计算具体时刻显隐，每个任务只写一次', async () => {
    m.tasks = [task('old-eye', { title: '眼药水', priority: 5, isAllDay: false, dueDate: '2026-11-01T10:00:00+0800', repeatFlag: 'RRULE:FREQ=DAILY', repeatFrom: '1', tags: ['always-today'] }),
      task('recent-eye', { title: '眼药水', priority: 5, isAllDay: false, dueDate: '2026-11-03T15:00:00+0800', repeatFlag: 'RRULE:FREQ=DAILY', repeatFrom: '1', tags: ['always-today'] })];
    const run = await runRuleReplan({ scope: 'hourly' });
    expect(status(run, 'eye-drops').status).toBe('success');
    expect(Date.parse(m.tasks[0].dueDate!)).toBe(Date.parse('2026-11-04T10:00:00+0800'));
    expect(m.tasks[0].tags).toContain('hidden'); expect(m.tasks[1].dueDate).toBe('2026-11-03T15:00:00+0800');
    expect(m.write).toHaveBeenCalledOnce();
  });
  it('模板内容与搬家日期合并后一次写入，完成项保留完成时的内容和日期', async () => {
    const make = (id: string, title: string, parentId?: string) => task(id, { title, parentId, tags: ['routine'], content: 'same', items: [{ id: `${id}-item`, title: '牙刷', status: 1 }] });
    const titles = ['🪥漱', '🧴护', '💄妆', '🛀浴', '📷相机', '🧥', '随身背包', '⚪️小袋子', '⚫️小袋子', '【⚪️】'];
    m.tasks = [make('template','出门todo模板'),make('moving','搬家模板'),make('a','出门前一天','template'),make('b','出门前三天','moving'),
      ...titles.flatMap((title,i)=>[make(`a${i}`,`🧳${title}`,'a'),make(`b${i}`,i===9?'📦':`📦${title}`,'b')]),
      make('jg','搬家-京广-11.10'),make('stage','出门前三天','jg'),make('brush','🎒🪥漱','stage'),
      {...make('done-box','📦','stage'), status:2, completedTime:'2026-11-02T10:00:00Z',content:'old'}];
    m.tasks.find(task=>task.id==='a0')!.content='new contents';
    const run = await runRuleReplan({scope:'hourly'});
    expect(status(run,'template-content').status).toBe('success'); expect(status(run,'moving-date').status).toBe('success');
    expect(m.tasks.find(task=>task.id==='brush')).toMatchObject({content:'new contents',dueDate:'2026-11-07T00:00:00+0800',tags:['routine']});
    expect(m.tasks.find(task=>task.id==='done-box')).toMatchObject({content:'old',status:2,completedTime:'2026-11-02T10:00:00Z',dueDate:'2026-11-03T00:00:00+0800'});
    expect(m.write.mock.calls.filter(([id])=>id==='brush')).toHaveLength(1);
    const state=m.data.get(`ticktick:template-pairs:v1:${hash}:template`);
    expect(Object.keys(state.pairs)).toHaveLength(10);expect(state.departureDates.jg.date).toBe('2026-11-10');
  });
  it('接车按充电最终日期创建，Outlook 只收到已验证的正式任务 ID', async () => {
    m.tasks=[task('charge',{title:'电动车充电',tags:['always-today'],priority:5,dueDate:'2026-11-08T00:00:00+0800'})];
    const result=await runRuleReplan({scope:'full'});
    expect(status(result,'vehicle-pickup').status).toBe('success'); expect(status(result,'outlook-pickup').status).toBe('success');
    const pickup=m.tasks.find(task=>task.title==='接电动车')!;
    expect(pickup).toMatchObject({startDate:'2026-11-04T07:20:00+0800',dueDate:'2026-11-04T07:40:00+0800',tags:['当天','hidden']});
    expect(m.tasks.find(task=>task.id==='charge')?.tags).toContain('当天');
    expect(m.write.mock.calls.filter(([id])=>id==='charge')).toHaveLength(1);
    expect(m.pickupOutlook).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({tasks:[expect.objectContaining({id:pickup.id,dueDate:pickup.dueDate})]}),expect.anything());
    expect(JSON.stringify(m.pickupOutlook.mock.calls)).not.toContain('draft-');
  });
  it('写入日历未连接时不标记今日专项成功', async () => {
    m.data.delete('outlook:laundry-write:v1');m.tasks=[task('hair',{title:'洗头',tags:['routine']})];
    const result=await runRuleReplan({scope:'full'});expect(status(result,'outlook-hair').status).toBe('failed');
    expect(m.data.get('ticktick:daily-special-success:v1')).toBeNull();
  });
  it('接车保留场景标签但日期仍跟随充电次日', async () => {
    m.tasks = [task('charge', { title: '电动车充电', priority: 5 }), task('pickup', {
      title: '接电动车', priority: 5, tags: ['居', '北京'], isAllDay: false,
      content: '(20m)\nBonBills charging pickup: life/charge/initial',
      startDate: '2026-11-03T07:20:00+0800', dueDate: '2026-11-03T07:40:00+0800',
    })];
    const result = await runRuleReplan({ scope: 'full' });
    expect(status(result, 'vehicle-pickup').status).toBe('success');
    expect(m.tasks.find(t => t.id === 'pickup')).toMatchObject({ startDate: '2026-11-04T07:20:00+0800', tags: ['居', '北京', '当天'] });
  });
});


describe('每日场景任务完成后从明天选日', () => {
  it.each([
    ['old-occurrence', '2026-11-03T01:00:00Z'],
    ['nuts', '2026-11-02T23:58:00Z'],
    ['old-occurrence', '2026-11-02T23:58:00Z'],
  ])('按上海完成日和重复系列修复当天待办 (%s, %s)', async (completedId, completedTime) => {
    const atEight = day + 'T08:00:00+0800';
    const tomorrow = '2026-11-04T08:00:00+0800';
    const nuts = task('nuts', { title: '吃坚果', priority: 5, tags: ['当天', '居', '活'], isAllDay: false,
      startDate: atEight, dueDate: atEight, repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', repeatFrom: '1',
      reminders: ['TRIGGER:PT0S'] });
    m.tasks = [structuredClone(nuts)];
    m.history = [task(completedId, { title: nuts.title, status: 2, completedTime })];
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0]).toMatchObject({ startDate: tomorrow, dueDate: tomorrow, repeatFlag: nuts.repeatFlag,
      repeatFrom: nuts.repeatFrom, reminders: nuts.reminders, status: 0 });
    m.write.mockClear();
    await runRuleReplan({ scope: 'full' });
    expect(m.write).not.toHaveBeenCalled();
  });
});

describe('当天放弃的重复任务不重新安排', () => {
  it.each(['full', 'hourly', 'visibility'] as const)('%s 保留场景任务、普通任务和固定今日的下一次日期', async scope => {
    const future = '2026-11-04T08:00:00+0800';
    m.tasks = [task('nuts', { title: '吃坚果', priority: 5, tags: ['居', '当天'], isAllDay: false,
      dueDate: future, startDate: future, repeatFlag: 'RRULE:FREQ=DAILY' }),
      task('normal', { title: '普通循环', dueDate: future, repeatFlag: 'RRULE:FREQ=DAILY' }),
      task('always', { title: '固定今日循环', tags: ['always-today'], dueDate: future, repeatFlag: 'RRULE:FREQ=DAILY' })];
    const originals = structuredClone(m.tasks);
    m.abandoned = m.tasks.map(t => ({ ...t, id: `old-${t.id}`, status: -1, completedTime: `${day}T08:00:00+08:00` }));
    const result = await runRuleReplan({ scope, visibilityKind: 'daily' });
    expect(result.rulesComplete).toBe(true);
    for (const original of originals) {
      const saved = m.tasks.find(t => t.id === original.id)!;
      expect(saved.dueDate).toBe(future); expect(saved.repeatFlag).toBe(original.repeatFlag);
      expect(saved.startDate).toBe(original.startDate);
    }
    const state = m.data.get(DAILY_PLAN_KEY);
    expect(state.history).toEqual([]);
    expect(state.briefing?.selected ?? []).toEqual([]);
  });
  it('放弃历史读取失败不写入任何任务', async () => {
    m.tasks = [task('nuts', { title: '吃坚果', tags: ['居'], dueDate: '2026-11-04T08:00:00+0800', repeatFlag: 'RRULE:FREQ=DAILY' })];
    m.abandonedRead.mockImplementation(async (_projects, statuses) => {
      if (statuses.includes(-1)) throw new Error('unavailable');
      return structuredClone(m.tasks);
    });
    await expect(runRuleReplan({ scope: 'full' })).rejects.toThrow('unavailable');
    expect(m.write).not.toHaveBeenCalled();
  });
  it('场景规则换优先级仍不能覆盖放弃决定，次日恢复安排', async () => {
    config(['scene-date', 'always-today', 'daily-plan']);
    const future = '2026-11-04T08:00:00+0800';
    m.tasks = [task('nuts', { title: '吃坚果', priority: 5, tags: ['居'], dueDate: future, repeatFlag: 'RRULE:FREQ=DAILY' })];
    m.abandoned = [task('old', { title: '吃坚果', status: -1, completedTime: `${day}T08:00:00+08:00` })];
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].dueDate).toBe(future);
    vi.setSystemTime(new Date('2026-11-04T09:00:00+08:00'));
    m.tasks[0].dueDate = '2026-11-06T08:00:00+0800';
    await runRuleReplan({ scope: 'full' });
    expect(m.tasks[0].dueDate?.slice(0, 10)).toBe('2026-11-04');
  });
});
