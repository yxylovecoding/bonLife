import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schedulingFailure } from './_schedulingFailure';
import { planTickTickDay } from './_ticktickDailyPlan';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';
import { routineTaskDate, syncTickTickAlwaysToday, syncTickTickRoutines, type TickTickApi, type TickTickTask } from './_ticktickTrips';

vi.mock('@vercel/kv', () => ({ kv: { mget: async (...keys: string[]) => keys.map(() => null), get: async () => null, hgetall: async () => null, set: async () => 'OK', eval: async () => 1 } }));

const day = '2026-10-21';
const makeTask = (id: string, extra: Partial<TickTickTask> = {}): TickTickTask => ({
  id, projectId: 'life', title: id, status: 0, isAllDay: true, timeZone: 'Asia/Shanghai',
  tags: ['always-today'], dueDate: '2026-10-20T00:00:00+0800', ...extra,
});
function fixture(tasks: TickTickTask[]) {
  const saved = new Map(tasks.map(task => [task.id, structuredClone(task)]));
  const getTask = vi.fn(async (_project: string, id: string) => structuredClone(saved.get(id)!));
  const updateTask = vi.fn(async (id: string, payload: Record<string, unknown>) => {
    saved.set(id, { ...saved.get(id)!, ...structuredClone(payload) });
    return saved.get(id)!;
  });
  const completed = vi.fn(async (): Promise<TickTickTask[]> => []);
  const api = { getTask, updateTask,
    listProjects: async () => [{ id: 'life', name: '生活' }],
    getProjectData: async () => ({ tasks: structuredClone([...saved.values()]) }),
    filterTasks: async () => structuredClone([...saved.values()]),
    listCompletedTasks: completed,
  } as unknown as TickTickApi;
  return { api, saved, getTask, updateTask, completed };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${day}T00:00:01+08:00`)); });
afterEach(() => vi.useRealTimers());

describe('always-today 截止日期', () => {
  it('北京居任务跨年排到二月，重复同步不拉回今天，到达后才恢复固定今日', async () => {
    const today = '2026-11-10', arrival = '2027-02-12';
    vi.setSystemTime(new Date(`${today}T10:00:00+08:00`));
    const original = makeTask('bedtime', { title: '下班洗洗睡觉!', tags: ['hidden', 'always-today', '当天', 'routine', '居', '北京', '活'],
      startDate: `${today}T21:50:00+0800`, dueDate: `${today}T22:20:00+0800`, isAllDay: false,
      priority: 5, repeatFlag: 'RRULE:FREQ=DAILY', repeatFrom: '1', reminders: ['TRIGGER:PT0S'], content: '(30m)' });
    const f = fixture([original]);
    const calendarState = { tagMap: { [today]: 'intern', [arrival]: 'school', '2027-02-13': 'school' },
      cityMap: { [today]: GUANGZHOU, [arrival]: BEIJING, '2027-02-13': BEIJING } };
    await syncTickTickAlwaysToday(f.api, { calendarState });
    expect(f.saved.get(original.id)).toEqual({ ...original, startDate: `${arrival}T21:50:00+0800`, dueDate: `${arrival}T22:20:00+0800` });
    expect((await syncTickTickAlwaysToday(f.api, { calendarState })).updated).toBe(0);
    vi.setSystemTime(new Date('2027-02-13T10:00:00+08:00'));
    await syncTickTickAlwaysToday(f.api, { calendarState });
    expect(f.saved.get(original.id)).toEqual({ ...original, startDate: '2027-02-13T21:50:00+0800', dueDate: '2027-02-13T22:20:00+0800' });
  });
  it('城市与寄居旅分别取并集、两类取交集，只有城市也必须检查', async () => {
    const next = '2026-10-22';
    const tasks = [makeTask('city-only', { tags: ['always-today', '北京'] }),
      makeTask('either-city', { tags: ['always-today', '北京', '广州', '居', '寄'] }),
      makeTask('wrong-scene', { tags: ['always-today', '广州', '旅'] }),
      makeTask('configured-city', { tags: ['always-today', '自定义城市'] })];
    const f = fixture(tasks);
    await syncTickTickAlwaysToday(f.api, { calendarState: { tagMap: { [day]: 'intern', [next]: 'school' },
      cityMap: { [day]: GUANGZHOU, [next]: BEIJING }, locationCities: [{ ...BEIJING, name: '自定义城市' }] } });
    expect(routineTaskDate(f.saved.get('city-only')!)).toBe(next);
    expect(routineTaskDate(f.saved.get('either-city')!)).toBe(day);
    expect(f.saved.get('wrong-scene')).toEqual(tasks[2]);
    expect(f.saved.get('configured-city')).toEqual(tasks[3]);
  });
  it('城市不明确或没有共同适用日时保留原日期', async () => {
    const original = makeTask('unknown-city', { tags: ['always-today', '北京', '居'] });
    const f = fixture([original]);
    await syncTickTickAlwaysToday(f.api, { calendarState: { tagMap: { [day]: 'school' } } });
    expect(f.saved.get(original.id)).toEqual(original); expect(f.updateTask).not.toHaveBeenCalled();
  });
  it('异地固定今日仍保留当天完成及放弃的下一次日期', async () => {
    const originals = [makeTask('done', { title: '已做', tags: ['always-today', '北京'], repeatFlag: 'RRULE:FREQ=DAILY' }),
      makeTask('abandoned', { tags: ['always-today', '北京'] })];
    const f = fixture(originals);
    f.completed.mockResolvedValue([{ ...originals[0], status: 2, completedTime: `${day}T00:00:00+08:00` }]);
    await syncTickTickAlwaysToday(f.api, { calendarState: { cityMap: { [day]: GUANGZHOU, '2027-02-12': BEIJING } },
      protectedTaskIds: new Set(['abandoned']) });
    expect([...f.saved.values()]).toEqual(originals); expect(f.updateTask).not.toHaveBeenCalled();
  });
  it('游日的居寄固定今日任务移到最近适用日，回到居日恢复今天且保留提醒', async () => {
    const task = makeTask('eggs', { tags: ['always-today', '当天', '居', '寄'], priority: 5,
      dueDate: `${day}T08:30:00+0800`, isAllDay: false, repeatFlag: 'RRULE:FREQ=DAILY', reminders: ['TRIGGER:PT0S'] });
    const f = fixture([task]);
    const calendarState = { tagMap: { [day]: 'travel', '2026-10-22': 'school', '2026-10-23': 'home' } };
    await syncTickTickAlwaysToday(f.api, { calendarState });
    expect(f.saved.get('eggs')).toEqual({ ...task, dueDate: '2026-10-22T08:30:00+0800' });
    expect((await syncTickTickAlwaysToday(f.api, { calendarState })).updated).toBe(0);
    await syncTickTickAlwaysToday(f.api, { calendarState: { tagMap: { [day]: 'home' } } });
    expect(f.saved.get('eggs')).toEqual(task);
  });
  it('没有可用场景日时保留日期，无场景标签仍固定今日', async () => {
    const task = makeTask('school', { tags: ['always-today', '居'] });
    const f = fixture([task, makeTask('anywhere')]);
    await syncTickTickAlwaysToday(f.api, { calendarState: {} });
    expect(f.saved.get('school')).toEqual(task);
    expect(routineTaskDate(f.saved.get('anywhere')!)).toBe(day);
  });
  it('北京时间跨天滚动，重复同步不重复写；不按 UTC 日期判断今天', async () => {
    const f = fixture([makeTask('today')]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 1 });
    expect(routineTaskDate(f.saved.get('today')!)).toBe(day);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 0 });
    vi.setSystemTime(new Date('2026-10-21T16:00:01Z'));
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 1 });
    expect(routineTaskDate(f.saved.get('today')!)).toBe('2026-10-22');
    expect(f.updateTask).toHaveBeenCalledTimes(2);
  });

  it('未来、无日期、仅开始日期和高优先级隐藏任务都补今天的截止日期', async () => {
    const tasks = [makeTask('future', { dueDate: '2027-01-01T00:00:00+0800' }),
      makeTask('undated', { dueDate: undefined, isAllDay: undefined }),
      makeTask('start-only', { dueDate: undefined, startDate: `${day}T09:00:00+0800`, isAllDay: false }),
      makeTask('important', { priority: 5, tags: ['routine', 'hidden', '旅', 'always-today'] })];
    const f = fixture(tasks);
    expect(await syncTickTickAlwaysToday(f.api, { calendarState: { tagMap: { [day]: 'travel' } } })).toEqual({ matched: 4, updated: 4 });
    for (const task of f.saved.values()) { expect(task.dueDate).toBeTruthy(); expect(routineTaskDate(task)).toBe(day); }
    expect(f.saved.get('undated')?.isAllDay).toBe(true);
    expect(f.saved.get('start-only')?.dueDate).toBe(`${day}T09:00:00+0800`);
    expect(f.saved.get('important')?.tags).toEqual(tasks[3].tags);
  });

  it('保留时刻、跨日起止间隔、循环、提醒与其他字段，兼容 UTC 返回日期', async () => {
    const task = makeTask('timed', { startDate: '2026-10-18T15:00:00Z', dueDate: '2026-10-19T01:00:00Z',
      isAllDay: false, content: '(30m)', desc: '备注', priority: 5, parentId: 'parent', sortOrder: 17,
      repeatFlag: 'RRULE:FREQ=WEEKLY', repeatFrom: 1, reminders: ['TRIGGER:PT0S'],
      tags: [' ALWAYS-TODAY ', 'routine', '居'], items: [
        { id: 'open', title: '未完成', status: 0, startDate: '2026-10-18T16:00:00Z' },
        { id: 'done', title: '已完成', status: 1, startDate: '2026-10-18T16:00:00Z' },
        { id: 'undated', title: '无日期', status: 0 },
      ] });
    const f = fixture([task]);
    await syncTickTickAlwaysToday(f.api, { calendarState: { tagMap: { [day]: 'school' } } });
    expect(f.saved.get(task.id)).toEqual({ ...task, startDate: '2026-10-20T15:00:00Z', dueDate: '2026-10-21T01:00:00Z',
      items: [{ ...task.items![0], startDate: '2026-10-20T16:00:00Z' }, ...task.items!.slice(1)] });
  });

  it('已完成、不带标签和刚移除标签的任务均不修改，不向子任务继承标签', async () => {
    const tasks = [makeTask('done', { status: 2 }), makeTask('completed', { status: undefined, completedTime: '2026-10-20T01:00:00Z' }),
      makeTask('other', { tags: ['always-today-other'] }), makeTask('child', { tags: [], parentId: 'done' }), makeTask('removed')];
    const f = fixture(tasks);
    f.saved.get('removed')!.tags = ['routine'];
    await syncTickTickAlwaysToday(f.api, { tasks });
    expect(f.updateTask).not.toHaveBeenCalled();
  });

  it('今天完成过的重复系列保留下一次日期，次日才重新固定今日', async () => {
    vi.setSystemTime(new Date(`${day}T21:00:00+08:00`));
    const next = makeTask('next-id', { title: '重复任务', repeatFlag: 'RRULE:FREQ=WEEKLY', dueDate: '2026-10-28T00:00:00+0800' });
    const f = fixture([next]);
    f.completed.mockResolvedValue([makeTask('history-id', { title: next.title, status: 2, completedTime: `${day}T09:00:00+08:00` })]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 0 });
    expect(f.saved.get(next.id)).toEqual(next);
    expect(f.completed).toHaveBeenCalledWith(['life'], '2026-10-20T16:00:00.000Z', '2026-10-21T15:59:59.999Z');
    vi.setSystemTime(new Date('2026-10-22T00:01:00+08:00'));
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 1 });
    expect(routineTaskDate(f.saved.get(next.id)!)).toBe('2026-10-22');
    expect(f.saved.get(next.id)?.repeatFlag).toBe(next.repeatFlag);
  });

  it('明确未完成但残留旧完成时间的子任务仍固定今天，保留原字段', async () => {
    const original = makeTask('reopened', { title: 'transformer', parentId: 'parent', tags: ['always-today', '班'],
      completedTime: '2026-09-17T04:14:43.000+0000', content: '(1.5h)', priority: 3 });
    const f = fixture([original]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 1 });
    expect(f.saved.get(original.id)).toEqual({ ...original, dueDate: `${day}T00:00:00+0800` });
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 0 });
  });

  it('残留完成时间的未完成系列仍遵守当天完成保护', async () => {
    const original = makeTask('next', { title: 'fixed', repeatFlag: 'RRULE:FREQ=DAILY', completedTime: '2026-09-17T04:14:43Z' });
    const f = fixture([original]);
    f.completed.mockResolvedValue([{ ...original, id: 'old', status: 2, completedTime: `${day}T00:00:00+08:00` }]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 0 });
    expect(f.updateTask).not.toHaveBeenCalled();
  });

  it('历史读取后出现新的完成时间，即使状态仍为零也不覆盖', async () => {
    const original = makeTask('reread', { completedTime: '2026-09-17T04:14:43Z' });
    const f = fixture([original]);
    f.getTask.mockResolvedValueOnce({ ...original, completedTime: `${day}T00:00:00+08:00` });
    await syncTickTickAlwaysToday(f.api, { tasks: [original] });
    expect(f.updateTask).not.toHaveBeenCalled();
  });

  it('按上海日期识别 UTC 完成时间，确切任务 ID 匹配不依赖名称或重复标签', async () => {
    const f = fixture([makeTask('same-id', { title: '已改名', dueDate: '2026-10-29T00:00:00+0800' })]);
    f.completed.mockResolvedValue([makeTask('same-id', { title: '旧名字', status: 2, tags: [], completedTime: '2026-10-20T16:00:00Z' })]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 0 });
    expect(f.updateTask).not.toHaveBeenCalled();
  });

  it('改变 ID 的系列只匹配同清单、同父任务且唯一的重复任务', async () => {
    const f = fixture([
      makeTask('matching', { title: '同名', repeatFlag: 'RRULE:FREQ=DAILY', parentId: 'parent-a' }),
      makeTask('other-parent', { title: '同名', repeatFlag: 'RRULE:FREQ=DAILY', parentId: 'parent-b' }),
      makeTask('other-project', { title: '同名', repeatFlag: 'RRULE:FREQ=DAILY', parentId: 'parent-a', projectId: 'elsewhere' }),
      makeTask('not-recurring', { title: '另一个同名' }),
    ]);
    f.completed.mockResolvedValue([
      makeTask('old', { title: '同名', parentId: 'parent-a', status: 2, completedTime: `${day}T00:00:00+08:00` }),
      makeTask('old-single', { title: '另一个同名', status: 2, completedTime: `${day}T00:00:00+08:00` }),
    ]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 4, updated: 3 });
    expect(routineTaskDate(f.saved.get('matching')!)).toBe('2026-10-20');
    for (const id of ['other-parent', 'other-project', 'not-recurring']) expect(routineTaskDate(f.saved.get(id)!)).toBe(day);
  });

  it('同名有歧义时不猜系列归属；准确 ID 仍可识别', async () => {
    const f = fixture(['one', 'two'].map(id => makeTask(id, { title: '同名', repeatFlag: 'RRULE:FREQ=DAILY' })));
    f.completed.mockResolvedValue([makeTask('one', { title: '同名', status: 2, completedTime: `${day}T00:00:00+08:00` })]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 2, updated: 1 });
    expect(f.updateTask.mock.calls[0][0]).toBe('two');
  });

  it('不把昨天、未来时刻或未完成记录算作今天已完成', async () => {
    const f = fixture([makeTask('fixed', { repeatFlag: 'RRULE:FREQ=DAILY' })]);
    f.completed.mockResolvedValue([
      makeTask('fixed', { status: 2, completedTime: '2026-10-20T15:59:59Z' }),
      makeTask('fixed', { status: 2, completedTime: '2026-10-21T00:00:00Z' }),
      makeTask('fixed', { status: 0, completedTime: `${day}T00:00:00+08:00` }),
    ]);
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 1 });
  });

  it.each(['read-error', 'invalid-time', 'missing-id'])('完成记录 %s 时停止改期，不能当作今天未完成', async mode => {
    const f = fixture([makeTask('fixed')]);
    if (mode === 'read-error') f.completed.mockRejectedValue(new Error('private upstream error'));
    else f.completed.mockResolvedValue([makeTask(mode === 'missing-id' ? '' : 'fixed', { status: 2,
      completedTime: mode === 'invalid-time' ? 'invalid' : `${day}T00:00:00+08:00` })]);
    const error = await syncTickTickAlwaysToday(f.api).catch(error => error);
    expect(schedulingFailure(error)).toEqual({ stage: 'completion-history', retryable: true });
    expect(f.updateTask).not.toHaveBeenCalled();
  });

  it('读取达到接口上限时拆分时间窗，不能漏掉当天完成记录', async () => {
    vi.setSystemTime(new Date(`${day}T21:00:00+08:00`));
    const f = fixture([makeTask('fixed', { title: 'fixed', repeatFlag: 'RRULE:FREQ=DAILY' })]);
    const records = Array.from({ length: 50 }, (_, i) => makeTask(`old-${i}`, { status: 2,
      title: i === 49 ? 'fixed' : `other-${i}`, completedTime: new Date(Date.parse(`${day}T00:00:00+08:00`) + i * 20 * 60_000).toISOString() }));
    f.completed.mockImplementation(async (_projects, start, end) => records.filter(task => Date.parse(task.completedTime!) >= Date.parse(start) && Date.parse(task.completedTime!) <= Date.parse(end)).slice(0, 50));
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 0 });
    expect(f.completed.mock.calls.length).toBeGreaterThan(1);
  });

  it('读取历史后循环任务刚生成下一次日期时留待下轮核对，不覆盖并发完成', async () => {
    const f = fixture([makeTask('fixed', { repeatFlag: 'RRULE:FREQ=DAILY' })]);
    f.getTask.mockImplementationOnce(async () => ({ ...f.saved.get('fixed')!, dueDate: '2026-10-22T00:00:00+0800' }));
    expect(await syncTickTickAlwaysToday(f.api)).toEqual({ matched: 1, updated: 0 });
    expect(f.updateTask).not.toHaveBeenCalled();
  });

  it('写后日期未保存或标签丢失时报告失败', async () => {
    const f = fixture([makeTask('failed')]);
    f.updateTask.mockImplementationOnce(async id => f.saved.get(id)!);
    await expect(syncTickTickAlwaysToday(f.api)).rejects.toThrow('日期');
    f.updateTask.mockImplementationOnce(async (id, payload) => {
      f.saved.set(id, { ...f.saved.get(id)!, ...payload, tags: [] });
      return f.saved.get(id)!;
    });
    await expect(syncTickTickAlwaysToday(f.api)).rejects.toThrow('更新结果未确认');
  });

  it('完整同步先遵守场景，适用日优先于洗头跟随、重复周期和普通轮换', async () => {
    const f = fixture([makeTask('fixed', { tags: ['always-today', '旅', '洗头', 'at-least'], content: '(30m)',
      repeatFlag: 'RRULE:FREQ=WEEKLY', dueDate: '2026-11-05T00:00:00+0800' }),
    makeTask('wash', { title: '洗头', tags: [], dueDate: '2026-10-25T00:00:00+0800' }),
    makeTask('ordinary', { tags: [], content: '(30m)', dueDate: `${day}T00:00:00+0800` })]);
    vi.setSystemTime(new Date(`${day}T21:30:00+08:00`));
    let fixedMinutes = 0;
    await syncTickTickRoutines({ api: f.api, today: day, calendarState: { tagMap: { [day]: 'travel', '2026-10-25': 'school' } },
      planDay: async tasks => {
        const state = { connectionId: 'test', history: [], deadlines: {} };
        const plan = planTickTickDay({ tasks, today: day, calendarState: { tagMap: { [day]: 'travel', '2026-10-25': 'school' } }, state, budgetMinutes: 30 });
        fixedMinutes = plan.summary.plannedMinutes;
        return plan.dates;
      } });
    expect(routineTaskDate(f.saved.get('fixed')!)).toBe(day);
    expect(routineTaskDate(f.saved.get('ordinary')!)).toBe('2026-10-22');
    expect(fixedMinutes).toBe(30);
  });
});
