import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planRainReminder, rainReminderKey } from './_ticktickRainReminder';
import { RuleTaskDraft } from './_ruleTaskDraft';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';

const m = vi.hoisted(() => ({ store: new Map<string, unknown>(), locations: vi.fn(), weather: vi.fn(), hourly: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: { get: async (key: string) => m.store.get(key),
  set: async (key: string, value: unknown) => m.store.set(key, value) } }));
vi.mock('./_calendarWeather.js', () => ({ readCalendarLocations: m.locations }));
vi.mock('./_dailyWeather.js', () => ({ readDailyWeather: m.weather }));
vi.mock('./_rainReminderNotes.js', async original => ({ ...await original<typeof import('./_rainReminderNotes')>(), readHourlyRain: m.hourly }));
const day = '2026-11-12', key = rainReminderKey('connection');
const city = { name: '广州', latitude: 23.13, longitude: 113.26 };
const forecast = (code = 61, precipitation = 2) => ({ stale: false, days: { [day]: { code, precipitation } } });
const options = () => ({ connectionId: 'connection', projectId: 'life', tasks: [] as TickTickTask[], completedTasks: [] as TickTickTask[], abandonedTasks: [] as TickTickTask[],
  calendarState: { tagMap: { [day]: 'home' } }, now: new Date(`${day}T05:01:00+08:00`), deferState: vi.fn(), verifyReminder: vi.fn().mockResolvedValue(true) });
const reminder = (status = 0): TickTickTask => ({ id: 'existing', projectId: 'life', title: '关窗', status,
  tags: ['活', '当天'], startDate: `${day}T08:00:00+0800` });
beforeEach(() => { vi.resetAllMocks(); m.store.clear();
  m.hourly.mockResolvedValue({ hours: Array.from({ length: 24 }, (_, i) => i === 8 ? 1.2 : 0), fetchedAt: `${day}T00:55:00Z` });
  m.locations.mockResolvedValue({ [day]: { locations: [city], travel: false } }); m.weather.mockResolvedValue(forecast()); });

describe('boncal 晨间雨天关窗', () => {
  it('只有明确指定今天的手动补跑能越过晨间时段，日期及成功标记不变', async () => {
    const o = options(); o.now = new Date(`${day}T15:00:00+08:00`); const createTask = vi.fn();
    await expect(planRainReminder({ createTask } as unknown as TickTickApi, { ...o, manualDate: '2026-11-11' })).rejects.toThrow('补跑日期');
    expect(createTask).not.toHaveBeenCalled();
    await planRainReminder({ createTask } as unknown as TickTickApi, { ...o, manualDate: day });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ priority: 5, startDate: `${day}T08:00:00+0800`, reminders: ['TRIGGER:PT0S'] }));
    expect(m.store.has(key)).toBe(false);
  });
  it.each(['00:01', '04:59', '05:00', '12:00', '20:00'])('%s 不查天气或消耗当天机会', async time => {
    const o = options(); o.now = new Date(`${day}T${time}:00+08:00`);
    expect(await planRainReminder({} as TickTickApi, o)).toEqual({ reason: '不在晨间检查时段（05:01–11:59）' });
    expect(m.locations).not.toHaveBeenCalled(); expect(o.deferState).not.toHaveBeenCalled();
  });
  it('按本轮 boncal 城市创建最高优先级的 08:00 定时提醒，只有提交后才记录当天', async () => {
    const createTask = vi.fn().mockResolvedValue(reminder()), o = options();
    expect(await planRainReminder({ createTask } as unknown as TickTickApi, o)).toEqual({ reason: '有雨，已生成当天 08:00 关窗提醒' });
    expect(m.locations).toHaveBeenCalledWith(day, day, o.calendarState);
    expect(m.weather).toHaveBeenCalledWith(city, day, day, 'Asia/Shanghai');
    expect(createTask).toHaveBeenCalledWith({ projectId: 'life', title: '关窗', startDate: `${day}T08:00:00+0800`, content: expect.stringContaining('08:00–09:00：雨量 1.2 毫米'),
      dueDate: `${day}T08:00:00+0800`, timeZone: 'Asia/Shanghai', isAllDay: false, priority: 5,
      tags: ['活', '当天'], reminders: ['TRIGGER:PT0S'] });
    expect(m.store.has(key)).toBe(false);
    await o.deferState.mock.calls[0][0]();
    expect(await planRainReminder({ createTask } as unknown as TickTickApi, o)).toEqual({ reason: '当天已检查' });
    expect(createTask).toHaveBeenCalledOnce(); expect(m.weather).toHaveBeenCalledOnce();
    expect(m.hourly).toHaveBeenCalledOnce(); expect(m.hourly).toHaveBeenCalledWith(city, day);
  });
  it.each([[0, 0, false], [51, 0, true], [95, 0, true], [undefined, 1, true], [75, 2, false]])('天气 %s / %s 判断雨天 %s', async (code, precipitation, rain) => {
    m.weather.mockResolvedValue({ stale: false, days: { [day]: { code, precipitation } } });
    const createTask = vi.fn(), o = options();
    await planRainReminder({ createTask } as unknown as TickTickApi, o);
    expect(createTask).toHaveBeenCalledTimes(rain ? 1 : 0); expect(o.deferState).toHaveBeenCalledOnce();
  });
  it.each([[0, 0], [0, 5], [2, 0], [2, 5], [-1, 0], [-1, 5]])('同日已有状态 %s、优先级 %s 的关窗任务不重复创建', async (status, priority) => {
    const o = options();
    const existing = { ...reminder(status), priority };
    if (status === -1) o.abandonedTasks = [existing];
    else if (status === 2) o.completedTasks = [existing];
    else o.tasks = [existing];
    expect(await planRainReminder({} as TickTickApi, o)).toEqual({ reason: '已有同日关窗，不重复创建' });
    expect(m.weather).not.toHaveBeenCalled(); expect(o.deferState).toHaveBeenCalledOnce();
    expect(m.hourly).not.toHaveBeenCalled();
  });
  it('草稿候选未经最终确认不能记录当天成功', async () => {
    const o = options(); o.tasks = [reminder()]; o.verifyReminder.mockResolvedValue(false);
    await planRainReminder({} as TickTickApi, o);
    await expect(o.deferState.mock.calls[0][0]()).rejects.toThrow('当天关窗任务未确认');
    expect(m.store.has(key)).toBe(false);
  });
  it('无雨检查不要求存在任务，只有有雨及去重命中才验证任务', async () => {
    m.weather.mockResolvedValue(forecast(0, 0)); const o = options();
    await planRainReminder({} as TickTickApi, o); await o.deferState.mock.calls[0][0]();
    expect(o.verifyReminder).not.toHaveBeenCalled(); expect(m.store.get(key)).toBe(day);
    expect(m.hourly).not.toHaveBeenCalled();
  });
  it('逐时预报缺失仍创建日预报已确认的提醒，并如实备注缺测', async () => {
    m.hourly.mockResolvedValue(null); const createTask = vi.fn();
    await planRainReminder({ createTask } as unknown as TickTickApi, options());
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('预计降雨时段、雨量：逐时预报暂不可用') }));
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
    expect(await planRainReminder({} as TickTickApi, o)).toEqual({ reason: '当天预报无雨，无需关窗提醒' }); await o.deferState.mock.calls[0][0]();
    await planRainReminder({} as TickTickApi, o); expect(m.weather).toHaveBeenCalledOnce();
  });
  it.each([true, false])('真实草稿提交回读成功=%s，成功才持久化，失败后按已创建任务恢复', async confirmed => {
    let saved: TickTickTask | undefined;
    const source = { createTask: vi.fn(async payload => saved = { ...payload, id: 'created', status: 0 }),
      getTask: vi.fn(async () => confirmed ? saved : undefined) } as unknown as TickTickApi;
    const draft = new RuleTaskDraft(source, [], new Set()), branch = draft.branch('rain-reminder');
    const o = options();
    await planRainReminder(branch.api, { ...o, deferState: save => draft.saveAfterCommit('rain-reminder', save, { afterAllWrites: true }) });
    branch.accept(); const failed = new Set<string>();
    await draft.commit({ order: ['rain-reminder', 'outlook-hair'], allowed: id => !failed.has(id), failed: ids => ids.forEach(id => failed.add(id)), afterRule: async () => {
      expect(m.store.has(key)).toBe(false); expect(o.verifyReminder).not.toHaveBeenCalled();
    } });
    expect(m.store.get(key)).toBe(confirmed ? day : undefined);
    expect(source.createTask).toHaveBeenCalledOnce();
    if (!confirmed) { const o = options(); o.tasks = [saved!]; await planRainReminder(source, o);
      await o.deferState.mock.calls[0][0](); expect(source.createTask).toHaveBeenCalledOnce(); }
  });
});
