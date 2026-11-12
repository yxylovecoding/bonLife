import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planRainReminder, rainReminderKey } from './_ticktickRainReminder';
import { RuleTaskDraft } from './_ruleTaskDraft';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';

const m = vi.hoisted(() => ({ store: new Map<string, unknown>(), locations: vi.fn(), weather: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: { get: async (key: string) => m.store.get(key),
  set: async (key: string, value: unknown) => m.store.set(key, value) } }));
vi.mock('./_calendarWeather.js', () => ({ readCalendarLocations: m.locations }));
vi.mock('./_dailyWeather.js', () => ({ readDailyWeather: m.weather }));
const day = '2026-11-12', key = rainReminderKey('connection');
const city = { name: '广州', latitude: 23.13, longitude: 113.26 };
const forecast = (code = 61, precipitation = 2) => ({ stale: false, days: { [day]: { code, precipitation } } });
const options = () => ({ connectionId: 'connection', projectId: 'life', tasks: [] as TickTickTask[], completedTasks: [] as TickTickTask[],
  calendarState: { tagMap: { [day]: 'home' } }, now: new Date(`${day}T05:01:00+08:00`), deferState: vi.fn() });
const reminder = (status = 0): TickTickTask => ({ id: 'existing', projectId: 'life', title: '关窗', status,
  tags: ['活', '当天'], startDate: `${day}T08:00:00+0800` });
beforeEach(() => { vi.resetAllMocks(); m.store.clear();
  m.locations.mockResolvedValue({ [day]: { locations: [city], travel: false } }); m.weather.mockResolvedValue(forecast()); });

describe('boncal 晨间雨天关窗', () => {
  it.each(['00:01', '04:59', '05:00', '12:00', '20:00'])('%s 不查天气或消耗当天机会', async time => {
    const o = options(); o.now = new Date(`${day}T${time}:00+08:00`);
    await planRainReminder({} as TickTickApi, o);
    expect(m.locations).not.toHaveBeenCalled(); expect(o.deferState).not.toHaveBeenCalled();
  });
  it('按本轮 boncal 城市创建 08:00 定时提醒，只有提交后才记录当天', async () => {
    const createTask = vi.fn().mockResolvedValue(reminder()), o = options();
    await planRainReminder({ createTask } as unknown as TickTickApi, o);
    expect(m.locations).toHaveBeenCalledWith(day, day, o.calendarState);
    expect(m.weather).toHaveBeenCalledWith(city, day, day, 'Asia/Shanghai');
    expect(createTask).toHaveBeenCalledWith({ projectId: 'life', title: '关窗', startDate: `${day}T08:00:00+0800`,
      dueDate: `${day}T08:00:00+0800`, timeZone: 'Asia/Shanghai', isAllDay: false, priority: 0,
      tags: ['活', '当天'], reminders: ['TRIGGER:PT0S'] });
    expect(m.store.has(key)).toBe(false);
    await o.deferState.mock.calls[0][0]();
    await planRainReminder({ createTask } as unknown as TickTickApi, o);
    expect(createTask).toHaveBeenCalledOnce(); expect(m.weather).toHaveBeenCalledOnce();
  });
  it.each([[0, 0, false], [51, 0, true], [95, 0, true], [undefined, 1, true], [75, 2, false]])('天气 %s / %s 判断雨天 %s', async (code, precipitation, rain) => {
    m.weather.mockResolvedValue({ stale: false, days: { [day]: { code, precipitation } } });
    const createTask = vi.fn(), o = options();
    await planRainReminder({ createTask } as unknown as TickTickApi, o);
    expect(createTask).toHaveBeenCalledTimes(rain ? 1 : 0); expect(o.deferState).toHaveBeenCalledOnce();
  });
  it.each([0, 2, -1])('同日已有状态 %s 的关窗任务不重复创建', async status => {
    const o = options(); o.completedTasks = [reminder(status)];
    await planRainReminder({} as TickTickApi, o);
    expect(m.weather).not.toHaveBeenCalled(); expect(o.deferState).toHaveBeenCalledOnce();
  });
  it.each([{ locations: [] }, { locations: [city, { ...city, name: '北京' }] }])('没有唯一城市时保留重试机会', async ({ locations }) => {
    m.locations.mockResolvedValue({ [day]: { locations } }); const o = options();
    await expect(planRainReminder({} as TickTickApi, o)).rejects.toThrow('城市未确认');
    expect(o.deferState).not.toHaveBeenCalled();
  });
  it.each([{ ...forecast(), stale: true }, { days: {}, stale: false }, { ...forecast(), error: '天气更新失败' }])('缺失或过期预报不当作晴天', async value => {
    m.weather.mockResolvedValue(value); const o = options();
    await expect(planRainReminder({} as TickTickApi, o)).rejects.toThrow('预报未确认');
    expect(o.deferState).not.toHaveBeenCalled();
  });
  it('前一天成功不阻止今天；晴天也只查一次', async () => {
    m.store.set(key, '2026-11-11'); m.weather.mockResolvedValue(forecast(0, 0)); const o = options();
    await planRainReminder({} as TickTickApi, o); await o.deferState.mock.calls[0][0]();
    await planRainReminder({} as TickTickApi, o); expect(m.weather).toHaveBeenCalledOnce();
  });
  it.each([true, false])('真实草稿提交回读成功=%s，成功才持久化，失败后按已创建任务恢复', async confirmed => {
    let saved: TickTickTask | undefined;
    const source = { createTask: vi.fn(async payload => saved = { ...payload, id: 'created', status: 0 }),
      getTask: vi.fn(async () => confirmed ? saved : undefined) } as unknown as TickTickApi;
    const draft = new RuleTaskDraft(source, [], new Set()), branch = draft.branch('rain-reminder');
    await planRainReminder(branch.api, { ...options(), deferState: save => draft.saveAfterCommit('rain-reminder', save) });
    branch.accept(); const failed = new Set<string>();
    await draft.commit({ order: ['rain-reminder'], allowed: id => !failed.has(id), failed: ids => ids.forEach(id => failed.add(id)), afterRule: async () => {} });
    expect(m.store.get(key)).toBe(confirmed ? day : undefined);
    expect(source.createTask).toHaveBeenCalledOnce();
    if (!confirmed) { const o = options(); o.tasks = [saved!]; await planRainReminder(source, o);
      await o.deferState.mock.calls[0][0](); expect(source.createTask).toHaveBeenCalledOnce(); }
  });
});
