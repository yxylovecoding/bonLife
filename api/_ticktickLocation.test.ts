import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BEIJING, DEFAULT_INTERNSHIP_RULES, GUANGZHOU, resolveCalendarState } from '../src/utils/internship';
import { nextTaskLocationDate, taskLocationAllowed } from './_ticktickLocation';
import { LOCATION_HIDDEN_KEY, syncTickTickLocationVisibility } from './_ticktickLocationVisibility';
import { planTickTickDay } from './_ticktickDailyPlan';
import { exerciseTarget } from './_ticktickExercise';
import { chooseLaundryDay } from './_ticktickLaundry';
import { routineTaskDate, separateTickTickSprays, syncTickTickAlwaysToday, syncTickTickRoutines,
  type TickTickApi, type TickTickTask } from './_ticktickTrips';

const { data } = vi.hoisted(() => ({ data: new Map<string, unknown>() }));
vi.mock('@vercel/kv', () => ({ kv: {
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); return 'OK'; },
} }));
const today = '2026-10-28', tomorrow = '2026-10-29', later = '2026-10-30';
const now = new Date(`${today}T12:00:00+08:00`);
const config = { config: { schoolCity: BEIJING, homeCity: GUANGZHOU } };
const calendarState = resolveCalendarState(config, { tagMap: { [today]: 'home', [tomorrow]: 'school', [later]: 'school' } });
const task = (id: string, fields: Partial<TickTickTask> = {}): TickTickTask => ({ id, projectId: 'life', title: id,
  status: 0, isAllDay: true, tags: ['北京'], dueDate: `${today}T00:00:00+0800`, ...fields });
function fixture(source: TickTickTask[]) {
  const stored = new Map(source.map(task => [task.id, structuredClone(task)]));
  const list = async () => structuredClone([...stored.values()]);
  const update = vi.fn(async (id: string, payload: Record<string, unknown>) => {
    const saved = { ...stored.get(id)!, ...structuredClone(payload) }; stored.set(id, saved); return saved;
  });
  const api = { listProjects: async () => [], getProjectData: async () => ({ tasks: await list() }), filterTasks: list,
    getTask: async (_project: string, id: string) => structuredClone(stored.get(id)!), updateTask: update,
    listCompletedTasks: async () => [] } as unknown as TickTickApi;
  return { api, stored, update };
}
beforeEach(() => { data.clear(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe('地点匹配与日期规则分离', () => {
  it('北京只在北京日可做，居与城市取交集，多个城市和多个场景分别取并集', () => {
    expect(taskLocationAllowed(task('city'), calendarState, today)).toBe(false);
    expect(nextTaskLocationDate(task('city'), calendarState, today)).toBe(tomorrow);
    expect(taskLocationAllowed(task('both', { tags: ['寄', '居', ' 北京市 '] }), calendarState, today)).toBe(false);
    expect(taskLocationAllowed(task('both', { tags: ['寄', '居', '北京', '广州'] }), calendarState, today)).toBe(true);
    expect(nextTaskLocationDate(task('conflict', { tags: ['寄', '北京'] }), calendarState, today)).toBeNull();
    expect(taskLocationAllowed(task('plain', { tags: ['游', '北京烤鸭'], parentId: 'city' }), calendarState, today)).toBe(true);
  });
  it('单日覆盖优先；城市不明的旅行日不能冒充北京', () => {
    const state = resolveCalendarState(config, { tagMap: { [today]: 'travel', [tomorrow]: 'travel', [later]: 'school' },
      dayOverrides: { [tomorrow]: { city: { ...BEIJING, name: '北京市 · 北京 · 中国' } }, [later]: { city: GUANGZHOU } } });
    expect(taskLocationAllowed(task('city'), state, today)).toBe(false);
    expect(taskLocationAllowed(task('city'), state, tomorrow)).toBe(true);
    expect(taskLocationAllowed(task('city'), state, later)).toBe(false);
    expect(taskLocationAllowed(task('travel', { tags: ['旅', '北京'] }), state, tomorrow)).toBe(true);
    expect(taskLocationAllowed(task('home', { tags: ['居', '北京'] }), state, tomorrow)).toBe(false);
  });
  it('实习城市和上学月份沿用日历解析，配置过的其他城市同样可限制任务', () => {
    const nanjing = { name: '南京', latitude: 32.06, longitude: 118.79 };
    const state = resolveCalendarState({ config: { schoolCity: BEIJING,
      internshipPeriods: [{ id: 'intern', profileId: 'p', profileName: '公司', revision: 1,
        startDate: today, endDate: tomorrow, city: nanjing, schoolCity: BEIJING,
        rules: { ...DEFAULT_INTERNSHIP_RULES, salary: 100 } }] } }, { tagMap: { [later]: 'school' } });
    expect(taskLocationAllowed(task('city'), state, today)).toBe(false);
    expect(taskLocationAllowed(task('南京', { tags: ['居', '南京'] }), state, today)).toBe(true);
    expect(nextTaskLocationDate(task('city'), state, today)).toBe(later);
  });
  it.each([['洗头'], ['routine'], []].map(tags => ({ tags })))('$tags 旧版场景同步保留独立专项日期和任务字段', async ({ tags }) => {
    const original = task('city', { tags: [...tags, '北京'], isAllDay: false, dueDate: `${today}T20:00:00+0800`,
      reminders: ['TRIGGER:PT0S'], priority: 5, repeatFlag: 'RRULE:FREQ=DAILY' });
    const f = fixture([original, task('wash', { title: '洗头', tags: [] })]);
    await syncTickTickRoutines({ api: f.api, calendarState, today });
    expect(f.stored.get('city')).toEqual(original);
    await syncTickTickRoutines({ api: f.api, calendarState, today });
    expect(f.update).not.toHaveBeenCalled();
  });
  it('城市标签不会改写长周期原日期', async () => {
    const state = resolveCalendarState(config, { tagMap: { [today]: 'school', [tomorrow]: 'home', [later]: 'school' } });
    const original = task('weekly', { tags: ['北京', '居'], repeatFlag: 'RRULE:FREQ=WEEKLY', dueDate: `${tomorrow}T00:00:00+0800` });
    const f = fixture([original]);
    await syncTickTickRoutines({ api: f.api, calendarState: state, today });
    expect(routineTaskDate(f.stored.get('weekly')!)).toBe(tomorrow);
  });
  it('城市标签不会改写固定训练或普通规划给出的日期', async () => {
    const f = fixture([task('city')]);
    await syncTickTickRoutines({ api: f.api, calendarState, today, fixedTaskDates: new Map([['city', today]]),
      planDay: async () => new Map([['city', today]]) });
    expect(routineTaskDate(f.stored.get('city')!)).toBe(today);
  });
  it('普通轮换不读取城市标签，地点显隐由统一执行器另外裁决', () => {
    const plan = planTickTickDay({ tasks: [task('city'), task('ordinary', { tags: [] })], today, now, calendarState,
      state: { connectionId: 'test', history: [], deadlines: {} }, budgetMinutes: 240 });
    expect(plan.dates.get('city')).toBe(today);
    expect(plan.dates.get('ordinary')).toBe(today);
    expect(plan.summary.todayCount).toBe(2);
  });
  it('喷雾错日与训练顺延不因城市标签改变其日期规则', () => {
    const state = resolveCalendarState(config, { tagMap: { [today]: 'school', [tomorrow]: 'home', [later]: 'school' } });
    const dates = new Map<string, string>();
    separateTickTickSprays({ tasks: [task('a', { title: '除螨喷雾' }), task('b', { title: '香香喷雾' })],
      dates, history: [], calendarState: state, today, now });
    expect(dates.get('b')).toBe(tomorrow);
    expect(exerciseTarget(task('run', { title: '跑步', dueDate: '2026-10-27T00:00:00+0800' }),
      { now, calendarState })).toBe(today);
  });
  it('洗衣只在合适地点比较天气，不使用异地的晴天', () => {
    const sunny = { rain: 0, probability: 0, sunshine: 30000, code: 0 };
    const options = { tasks: [], history: [], calendarState, today, now,
      availability: { startDate: today, endDate: '2026-11-02', events: [] } };
    const forecast = { fetchedAt: now.toISOString(), days: { [today]: sunny, [tomorrow]: sunny, [later]: sunny, '2026-10-31': sunny } };
    expect(chooseLaundryDay(task('wash'), today, options, () => forecast)).toBe(tomorrow);
  });
  it('轻量 fixed-today 读取日历并按城市改到最近适用日，保留时刻与重复设置', async () => {
    data.set('app-config', config); data.set('calendar-tags', { tagMap: calendarState.tagMap });
    const original = task('city', { tags: ['always-today', '北京'], isAllDay: false,
      dueDate: `${today}T20:00:00+0800`, reminders: ['TRIGGER:PT0S'], priority: 5, repeatFlag: 'RRULE:FREQ=DAILY' });
    const f = fixture([original]);
    await syncTickTickAlwaysToday(f.api);
    expect(f.stored.get('city')).toEqual({ ...original, dueDate: `${tomorrow}T20:00:00+0800` });
    await syncTickTickRoutines({ api: f.api, calendarState, today });
    expect(f.update).toHaveBeenCalledOnce();
  });
});

describe('地点不匹配时隐藏，匹配后恢复', () => {
  it('无未来适用日也隐藏；恢复只移除自己添加的 hidden，日期和 routine 保持原状', async () => {
    const original = task('city', { tags: ['北京', 'routine'], priority: 5, repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const manual = task('manual', { tags: ['北京', 'hidden'] });
    const f = fixture([original, manual]);
    await syncTickTickLocationVisibility(f.api, { calendarState, now });
    expect(f.stored.get('city')).toEqual({ ...original, tags: ['北京', 'routine', 'hidden'] });
    await syncTickTickLocationVisibility(f.api, { calendarState, now });
    expect(f.update).toHaveBeenCalledTimes(1);
    await syncTickTickLocationVisibility(f.api, { calendarState, now: new Date(`${tomorrow}T12:00:00+08:00`) });
    expect(f.stored.get('city')).toEqual(original);
    expect(f.stored.get('manual')).toEqual(manual);
    expect(data.get(LOCATION_HIDDEN_KEY)).toEqual({});
  });
  it('到北京后仍遵守洗头时间和凌晨隐藏，移除地点标签也会恢复', async () => {
    const f = fixture([task('city', { title: '洗头' })]);
    await syncTickTickLocationVisibility(f.api, { calendarState, now });
    for (const time of ['00:01', '19:59']) {
      await syncTickTickLocationVisibility(f.api, { calendarState, now: new Date(`${tomorrow}T${time}:00+08:00`) });
      expect(f.stored.get('city')?.tags).toContain('hidden');
    }
    f.stored.get('city')!.tags = ['hidden'];
    await syncTickTickLocationVisibility(f.api, { calendarState, now: new Date(`${tomorrow}T20:00:00+08:00`) });
    expect(f.stored.get('city')?.tags).toEqual([]);
  });
  it('地点未知时隐藏；用户并发完成和普通标签不被改写', async () => {
    const f = fixture([task('city'), task('done', { status: 2, completedTime: now.toISOString() }), task('plain', { tags: ['游'] })]);
    await syncTickTickLocationVisibility(f.api, { calendarState: {}, now });
    expect(f.stored.get('city')?.tags).toContain('hidden');
    expect(f.stored.get('done')?.tags).toEqual(['北京']);
    expect(f.stored.get('plain')?.tags).toEqual(['游']);
  });
  it('写入响应丢失保留所有权，下次可安全恢复', async () => {
    const f = fixture([task('city')]);
    f.update.mockImplementationOnce(async (id, payload) => {
      Object.assign(f.stored.get(id)!, payload); throw new Error('lost response');
    });
    await expect(syncTickTickLocationVisibility(f.api, { calendarState, now })).rejects.toThrow('lost response');
    expect(Object.keys(data.get(LOCATION_HIDDEN_KEY) as object)).toHaveLength(1);
    await syncTickTickLocationVisibility(f.api, { calendarState, now: new Date(`${tomorrow}T12:00:00+08:00`) });
    expect(f.stored.get('city')?.tags).toEqual(['北京']);
  });
});
