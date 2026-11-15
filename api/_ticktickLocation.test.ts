import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BEIJING, DEFAULT_INTERNSHIP_RULES, GUANGZHOU, resolveCalendarState } from '../src/utils/internship';
import { nextTaskLocationDate, taskCityTags, taskLocationAllowed, taskLocationUnavailable, taskSceneTags } from './_ticktickLocation';
import { LOCATION_HIDDEN_KEY, syncTickTickLocationVisibility } from './_ticktickLocationVisibility';
import { planTickTickDay } from './_ticktickDailyPlan';
import { exerciseTarget } from './_ticktickExercise';
import { chooseLaundryDay } from './_ticktickLaundry';
import { routineTaskDate, separateTickTickSprays, syncTickTickAlwaysToday, syncTickTickRoutines,
  type TickTickApi, type TickTickTask } from './_ticktickTrips';

const { data } = vi.hoisted(() => ({ data: new Map<string, unknown>() }));
vi.mock('@vercel/kv', () => ({ kv: {
  mget: async (...keys: string[]) => keys.map(key => structuredClone(data.get(key) ?? null)),
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  hgetall: async (key: string) => structuredClone(data.get(key) ?? null),
  eval: async (_script: string, [key]: string[]) => { data.delete(key); return 1; },
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
it('旧地点显隐入口也保留当天地点读取失败的任务，不能把失败当作异地并隐藏', async () => {
  const source = task('held', { tags: ['广州'] });
  const { api, stored, update } = fixture([source]);
  await expect(syncTickTickLocationVisibility(api, { tasks: [source], now,
    calendarState: { ...calendarState, bonCalLocations: { [today]: { error: '地点读取失败' } } },
  })).rejects.toThrow('地点读取失败，保留当前显隐');
  expect(update).not.toHaveBeenCalled(); expect(stored.get(source.id)).toEqual(source);
});
afterEach(() => vi.useRealTimers());

describe('地点匹配与日期规则分离', () => {
  const workCalendar = (calendar: Record<string, unknown> = {}) => ({ ...resolveCalendarState({ config: { schoolCity: BEIJING,
    internshipPeriods: [{ id: 'work', profileId: 'p', profileName: '公司', revision: 1,
      startDate: '2026-11-13', endDate: '2026-11-18', city: GUANGZHOU, schoolCity: BEIJING,
      rules: { ...DEFAULT_INTERNSHIP_RULES, salary: 100 } }] } }, calendar), locationTags: ['广州', '北京', '寄', '居', '旅', '休', '班'] });
  it('班对应工作日，城市与场景取交集，不继承父任务标签', () => {
    const state = workCalendar(), work = task('work', { tags: ['always-today', '班', '广州'] });
    expect(state.tagMap['2026-11-14']).toBe('intern');
    expect(state.workingMap['2026-11-14']).toBe(false);
    expect(taskLocationAllowed(work, state, '2026-11-14')).toBe(false);
    expect(nextTaskLocationDate(work, state, '2026-11-14')).toBe('2026-11-16');
    expect(taskLocationAllowed({ ...work, tags: ['班', '北京'] }, state, '2026-11-16')).toBe(false);
    expect(taskLocationAllowed({ ...work, tags: ['班'] }, state, '2026-11-14')).toBe(false);
    expect(taskLocationAllowed({ ...work, tags: ['广州', '居'], parentId: 'work' }, state, '2026-11-14')).toBe(true);
  });
  it('旅居寄休班以外的日子子标签全部是城市，父标签与目录外班不限制', () => {
    const state = { ...workCalendar(), locationTags: ['旅', '居', '寄', '休', '班', '常州', '寓'] };
    const candidate = task('all', { tags: [...state.locationTags, '日子', 'routine'] });
    expect(taskSceneTags(candidate, state)).toEqual(['旅', '居', '寄', '休', '班']);
    expect(taskCityTags(candidate, state)).toEqual(['常州', '寓']);
    expect(taskLocationAllowed(task('parent', { tags: ['日子'] }), state, today)).toBe(true);
    expect(taskLocationAllowed(task('outside', { tags: ['班'] }), { ...state, locationTags: [] }, today)).toBe(true);
  });
  it('休仅对应 boncal 的休，休班及其他场景取并集后与城市取交集', () => {
    const state = workCalendar({ tagMap: { '2026-11-18': 'home', '2026-11-19': 'travel', '2026-11-20': 'school' } });
    const rest = task('rest', { tags: ['休', '广州'] });
    expect(state.livingKindMap['2026-11-14']).toBe('rest');
    expect(taskLocationAllowed(rest, state, '2026-11-14')).toBe(true);
    expect(taskLocationAllowed(rest, state, '2026-11-16')).toBe(false);
    expect(['2026-11-18', '2026-11-19', '2026-11-20'].map(date =>
      taskLocationAllowed({ ...rest, tags: ['休'] }, state, date))).toEqual([false, false, false]);
    for (const tags of [['休', '班', '广州'], ['居', '班', '广州']]) {
      expect(['2026-11-14', '2026-11-16'].map(date => taskLocationAllowed({ ...rest, tags }, state, date))).toEqual([true, true]);
      expect(taskLocationAllowed({ ...rest, tags: [...tags.filter(tag => tag !== '广州'), '北京'] }, state, '2026-11-14')).toBe(false);
    }
    expect(taskLocationAllowed({ ...rest, tags: ['寄', '班'] }, state, '2026-11-18')).toBe(true);
  });
  it('休沿用 boncal 的调休和出勤覆盖，工休未知保留日期，已知其他场景仍可匹配', () => {
    const state = workCalendar({ holidayDataByYear: { 2026: { '2026-11-14': { isOffDay: false }, '2026-11-16': { isOffDay: true } } },
      dayOverrides: { '2026-11-15': { attendance: 'work' }, '2026-11-17': { attendance: 'rest' } } });
    const rest = task('rest', { tags: ['休'] });
    expect(['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'].map(date => taskLocationAllowed(rest, state, date)))
      .toEqual([false, false, true, true]);
    const unknown = { ...state, livingKindMap: { ...state.livingKindMap, '2026-11-14': undefined } };
    expect(taskLocationUnavailable(rest, unknown, '2026-11-14')).toBe(true);
    expect(nextTaskLocationDate(rest, unknown, '2026-11-14')).toBeNull();
    expect(taskLocationAllowed({ ...rest, tags: ['休', '居'] }, unknown, '2026-11-14')).toBe(true);
    expect(taskLocationUnavailable({ ...rest, tags: ['休', '居'] }, unknown, '2026-11-14')).toBe(false);
  });
  it('普通轮换按休班并集挑选，固定今日休任务顺延，显隐遵守休场景及具体时刻', async () => {
    const state = workCalendar(), workday = '2026-11-13', restday = '2026-11-14';
    const plan = planTickTickDay({ tasks: [task('either', { tags: ['休', '班', '广州'], priority: 3, dueDate: `${restday}T00:00:00+0800` })],
      today: restday, now: new Date(`${restday}T10:00:00+08:00`), calendarState: state,
      state: { connectionId: 'test', history: [], deadlines: {} }, budgetMinutes: 240 });
    expect(plan.dates.get('either')).toBe(restday);
    const original = task('rest', { tags: ['休', '广州', 'always-today', 'routine'], isAllDay: false,
      startDate: `${workday}T10:00:00+0800`, dueDate: `${workday}T10:30:00+0800`,
      priority: 3, reminders: ['TRIGGER:-PT0S'], repeatFlag: 'RRULE:FREQ=DAILY' });
    const f = fixture([original]);
    await syncTickTickAlwaysToday(f.api, { calendarState: state, today: workday });
    const expected = { ...original, startDate: `${restday}T10:00:00+0800`, dueDate: `${restday}T10:30:00+0800` };
    expect(f.stored.get('rest')).toEqual(expected);
    for (const datetime of [`${workday}T18:00`, `${restday}T09:00`]) {
      await syncTickTickLocationVisibility(f.api, { calendarState: state, now: new Date(`${datetime}:00+08:00`) });
      expect(f.stored.get('rest')).toEqual({ ...expected, tags: [...original.tags!, 'hidden'] });
    }
    await syncTickTickLocationVisibility(f.api, { calendarState: state, now: new Date(`${restday}T10:01:00+08:00`) });
    expect(f.stored.get('rest')).toEqual(expected);
  });
  it('班沿用 boncal 调休及手动出勤，不以周一到周五或 intern 标签替代', () => {
    const work = task('work', { tags: ['班'] });
    const state = workCalendar({ holidayDataByYear: { 2026: { '2026-11-14': { isOffDay: false }, '2026-11-16': { isOffDay: true } } },
      dayOverrides: { '2026-11-15': { attendance: 'work' }, '2026-11-17': { attendance: 'rest' } }, tagMap: { '2026-11-18': 'home' } });
    expect(['2026-11-14', '2026-11-15'].map(date => taskLocationAllowed(work, state, date))).toEqual([true, true]);
    expect(['2026-11-16', '2026-11-17', '2026-11-18'].map(date => taskLocationAllowed(work, state, date))).toEqual([false, false, false]);
    const unknown = { ...state, workingMap: { ...state.workingMap, '2026-11-14': undefined } };
    expect(taskLocationUnavailable(work, unknown, '2026-11-14')).toBe(true);
    expect(nextTaskLocationDate(work, unknown, '2026-11-14')).toBeNull();
  });
  it('普通轮换不会在休息日挑选班任务', () => {
    const rest = '2026-11-14', state = workCalendar();
    const candidates = [task('work', { tags: ['班', '广州'], priority: 3, dueDate: `${rest}T00:00:00+0800` }),
      task('ordinary', { tags: [], priority: 3, dueDate: `${rest}T00:00:00+0800` })];
    const plan = planTickTickDay({ tasks: candidates, today: rest, now: new Date(`${rest}T10:00:00+08:00`), calendarState: state,
      state: { connectionId: 'test', history: [], deadlines: {} }, budgetMinutes: 240 });
    expect(plan.dates.get('work')).toBe('2026-11-16');
    expect(plan.dates.get('ordinary')).toBe(rest);
  });
  it('固定今日的班任务移到下一工作日并隐藏，工作日到点恢复，保留其他字段', async () => {
    const state = workCalendar(), rest = '2026-11-14';
    const original = task('work', { title: '考勤签到', tags: ['always-today', '当天', '班', '广州', 'routine'],
      isAllDay: false, startDate: `${rest}T10:00:00+0800`, dueDate: `${rest}T10:00:00+0800`,
      reminders: ['TRIGGER:-PT0S'], priority: 5, repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1' });
    const f = fixture([original]);
    await syncTickTickAlwaysToday(f.api, { calendarState: state, today: rest });
    const expected = { ...original, startDate: '2026-11-16T10:00:00+0800', dueDate: '2026-11-16T10:00:00+0800' };
    expect(f.stored.get('work')).toEqual(expected);
    for (const date of [`${rest}T18:00`, '2026-11-16T09:00']) {
      await syncTickTickLocationVisibility(f.api, { calendarState: state, now: new Date(`${date}:00+08:00`) });
      expect(f.stored.get('work')).toEqual({ ...expected, tags: [...original.tags!, 'hidden'] });
    }
    await syncTickTickLocationVisibility(f.api, { calendarState: state, now: new Date('2026-11-16T10:01:00+08:00') });
    expect(f.stored.get('work')).toEqual(expected);
  });
  it('以地点目录为完整范围，新增未知子标签不误当无约束，父标签只分组', () => {
    const state = { ...calendarState, locationTags: ['寄', '居', '旅', '北京', '外地住所'] };
    expect(taskLocationAllowed(task('unknown', { tags: ['外地住所'] }), state, today)).toBe(false);
    expect(nextTaskLocationDate(task('unknown', { tags: ['外地住所'] }), state, today)).toBeNull();
    expect(taskLocationAllowed(task('group', { tags: ['地点'] }), state, today)).toBe(true);
    expect(taskLocationAllowed(task('outside', { tags: ['广州'] }), state, tomorrow)).toBe(true);
    expect(taskLocationAllowed(task('all', { tags: ['北京', '居'] }), state, tomorrow)).toBe(true);
    expect(taskLocationAllowed(task('all', { tags: ['北京', '寄'] }), state, tomorrow)).toBe(false);
    expect(taskLocationAllowed(task('empty', { tags: ['北京', '居'] }), { ...state, locationTags: [] }, today)).toBe(true);
    expect(taskLocationAllowed(task('outside-alias', { tags: ['北京市', '寓', '北京·办公室'] }), state, today)).toBe(true);
    expect(taskLocationAllowed(task('new-place', { tags: ['北京·办公室'] }),
      { ...state, locationTags: [...state.locationTags, '北京·办公室'] }, tomorrow)).toBe(false);
  });
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
  it.each([['洗头'], ['routine'], []].map(tags => ({ tags })))('$tags 旧版入口同样满足地点并保留其它字段', async ({ tags }) => {
    const original = task('city', { tags: [...tags, '北京'], isAllDay: false, dueDate: `${today}T20:00:00+0800`,
      reminders: ['TRIGGER:PT0S'], priority: 5, repeatFlag: 'RRULE:FREQ=DAILY' });
    const f = fixture([original, task('wash', { title: '洗头', tags: [] })]);
    await syncTickTickRoutines({ api: f.api, calendarState, today });
    expect(f.stored.get('city')).toEqual({ ...original, dueDate: `${tomorrow}T20:00:00+0800` });
    await syncTickTickRoutines({ api: f.api, calendarState, today });
    expect(f.update).toHaveBeenCalledOnce();
  });
  it('未来长周期日期不符合地点时移到下一适用日', async () => {
    const state = resolveCalendarState(config, { tagMap: { [today]: 'school', [tomorrow]: 'home', [later]: 'school' } });
    const original = task('weekly', { tags: ['北京', '居'], repeatFlag: 'RRULE:FREQ=WEEKLY', dueDate: `${tomorrow}T00:00:00+0800` });
    const f = fixture([original]);
    await syncTickTickRoutines({ api: f.api, calendarState: state, today });
    expect(routineTaskDate(f.stored.get('weekly')!)).toBe(later);
  });
  it('训练或普通规划给出的日期仍须满足地点', async () => {
    const f = fixture([task('city')]);
    await syncTickTickRoutines({ api: f.api, calendarState, today, fixedTaskDates: new Map([['city', today]]),
      planDay: async () => new Map([['city', today]]) });
    expect(routineTaskDate(f.stored.get('city')!)).toBe(tomorrow);
  });
  it('普通轮换同时检查城市，只挑选今天地点适用的任务', () => {
    const plan = planTickTickDay({ tasks: [task('city'), task('ordinary', { tags: [] })], today, now, calendarState,
      state: { connectionId: 'test', history: [], deadlines: {} }, budgetMinutes: 240 });
    expect(plan.dates.get('city')).toBe(tomorrow);
    expect(plan.dates.get('ordinary')).toBe(today);
    expect(plan.summary.todayCount).toBe(1);
  });
  it('喷雾错日与训练顺延必须共同符合城市', () => {
    const state = resolveCalendarState(config, { tagMap: { [today]: 'school', [tomorrow]: 'home', [later]: 'school' } });
    const dates = new Map<string, string>();
    separateTickTickSprays({ tasks: [task('a', { title: '除螨喷雾' }), task('b', { title: '香香喷雾' })],
      dates, history: [], calendarState: state, today, now });
    expect(dates.get('b')).toBe(later);
    expect(exerciseTarget(task('run', { title: '跑步', dueDate: '2026-10-27T00:00:00+0800' }),
      { now, calendarState })).toBe(tomorrow);
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
