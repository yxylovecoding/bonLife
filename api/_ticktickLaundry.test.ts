import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseLaundryDay, isLaundryTask, laundryAnchor, laundryBeforeTrip, laundryLocation, readLaundryForecast, syncLaundrySchedule,
  LAUNDRY_STATE_KEY, type LaundryForecast, type LaundryState, type LaundryWeather } from './_ticktickLaundry';
import { buildTripSourcesFromSyncState, type TickTickApi, type TickTickTask } from './_ticktickTrips';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';
const { data, upstream } = vi.hoisted(() => ({ data: new Map<string, any>(), upstream: vi.fn() }));
vi.mock('@vercel/kv', () => ({ kv: { get: async (key: string) => structuredClone(data.get(key) ?? null),
  hgetall: async (key: string) => structuredClone(data.get(key) ?? null),
  set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); } } }));
vi.mock('./_bonClothes.js', () => ({ CONTEXTS_KEY: 'contexts', upstream }));

const now = new Date('2026-10-05T16:00:00+08:00');
const task = (fields: Partial<TickTickTask> = {}): TickTickTask => ({ id: 'wash', projectId: 'life', title: '洗衣服', status: 0,
  startDate: '2026-10-10T00:00:00Z', dueDate: '2026-10-10T00:00:00Z', timeZone: 'Asia/Shanghai',
  isAllDay: false, tags: ['居', '活'], priority: 5, repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=5', repeatFrom: '1', ...fields });
const history = [task({ id: 'history', status: 2, completedTime: '2026-10-05T03:56:45Z' })];
const state = (): LaundryState => ({ connectionId: 'connection', anchors: {} });
const sunny: LaundryWeather = { rain: 0, probability: 5, sunshine: 7 * 3600, code: 0 };
const wet: LaundryWeather = { rain: 3, probability: 80, sunshine: 3600, code: 61 };
const dates = Array.from({ length: 26 }, (_, i) => `2026-10-${String(i + 5).padStart(2, '0')}`);
const forecast = (weather = wet): LaundryForecast => ({ fetchedAt: now.toISOString(), days: Object.fromEntries(dates.map(date => [date, { ...weather }])) });
const city = { name: '北京', latitude: 40, longitude: 116.3 };
const options = (fields: Record<string, any> = {}) => ({ tasks: [task()], history,
  configState: { config: { schoolCity: city } },
  calendarState: { tagMap: Object.fromEntries(dates.map(date => [date, 'school'])) },
  availability: { startDate: '2026-10-05', endDate: '2026-11-01', events: [] }, today: '2026-10-05', now, ...fields });
function mockWeather(f = forecast()) {
  const response = { daily: { time: dates, precipitation_sum: dates.map(d => f.days[d].rain) as (number | null)[],
    precipitation_probability_max: dates.map(d => f.days[d].probability), sunshine_duration: dates.map(d => f.days[d].sunshine),
    weather_code: dates.map(d => f.days[d].code) } };
  upstream.mockResolvedValue(response);
  return response;
}
function client(original = task()) {
  let current = structuredClone(original);
  const api = { getTask: vi.fn(async () => structuredClone(current)), updateTask: vi.fn(async (_id, payload) => {
    current = { ...current, ...structuredClone(payload) }; return current;
  }) } as unknown as TickTickApi;
  return { api, current: () => current, change: (fields: Partial<TickTickTask>) => { current = { ...current, ...fields }; } };
}
beforeEach(() => { data.clear(); upstream.mockReset(); mockWeather(); });
afterEach(() => vi.restoreAllMocks());

describe('洗衣周期和地点', () => {
  it('Outlook 手动洗衣记录开启下一周期，历史滚出窗口后仍保留该完成锚点', () => {
    const saved = state(), current = task(), later = new Date('2026-10-13T09:00:00+08:00');
    const records = [{ title: '洗衣服', start: '2026-10-09T02:58:56Z', end: '2026-10-09T03:48:56Z' }];
    expect(laundryAnchor(current, [current], history, saved, later, records)).toMatchObject({
      completion: '2026-10-09T03:48:56Z', target: '2026-10-14',
    });
    expect(laundryAnchor(current, [current], history, saved, later, [])?.target).toBe('2026-10-14');
    expect(laundryAnchor(current, [current], [...history, task({ id: 'new-done', status: 2,
      completedTime: '2026-10-12T01:00:00Z' })], saved, later, records)?.target).toBe('2026-10-17');
  });
  it('自动预约、未结束日程、无效时段和同名任务歧义都不能冒充实际洗衣完成', () => {
    const current = task(), later = new Date('2026-10-13T09:00:00+08:00');
    const record = { title: '洗衣服', start: '2026-10-09T02:58:56Z', end: '2026-10-09T03:48:56Z' };
    for (const records of [
      [{ ...record, taskLink: { taskId: current.id, projectId: current.projectId } }],
      [{ ...record, end: '2026-10-14T00:00:00Z' }],
      [{ ...record, start: record.end }],
      [{ ...record, title: '买洗衣服用的洗衣液' }],
    ]) expect(laundryAnchor(current, [current], history, state(), later, records)?.target).toBe('2026-10-10');
    expect(laundryAnchor(current, [current, task({ id: 'another', projectId: 'other' })], history, state(), later, [record])?.target)
      .toBe('2026-10-10');
  });
  it('完成后五天为目标，反复提前/推后不会移动窗口；新完成记录才开启下一周期', () => {
    const saved = state(), first = task();
    expect(laundryAnchor(first, [first], history, saved, now)?.target).toBe('2026-10-10');
    const early = task({ startDate: '2026-10-08T00:00:00Z', dueDate: '2026-10-08T00:00:00Z' });
    expect(laundryAnchor(early, [early], history, saved, now)?.target).toBe('2026-10-10');
    const next = task({ id: 'next', startDate: '2026-10-13T00:00:00Z', dueDate: '2026-10-13T00:00:00Z' });
    expect(laundryAnchor(next, [next], [...history, task({ id: 'early-done', status: 2, completedTime: '2026-10-08T01:00:00Z' })], saved,
      new Date('2026-10-08T12:00:00+08:00'))?.target).toBe('2026-10-13');
    const noHistory = state();
    expect(laundryAnchor(first, [first], [], noHistory, now)?.target).toBe('2026-10-10');
    expect(laundryAnchor(early, [early], [], noHistory, now)?.target).toBe('2026-10-10');
  });
  it('使用真实周期，拒绝有限/未知/无日期规则及同名历史歧义', () => {
    expect(laundryAnchor(task({ repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=7' }), [task()], history, state(), now)?.target).toBe('2026-10-12');
    for (const repeatFlag of ['', 'RRULE:FREQ=HOURLY', 'RRULE:FREQ=DAILY;COUNT=5'])
      expect(laundryAnchor(task({ repeatFlag }), [task()], history, state(), now)).toBeNull();
    expect(laundryAnchor(task({ startDate: undefined, dueDate: undefined }), [task()], history, state(), now)).toBeNull();
    const ambiguous = task({ dueDate: '2026-10-15T00:00:00Z' });
    expect(laundryAnchor(ambiguous, [ambiguous, task({ id: 'same-name' })], history, state(), now)?.target).toBe('2026-10-15');
    expect(isLaundryTask(task({ title: '买洗衣凝珠' }))).toBe(false);
    expect(isLaundryTask(task({ tags: ['不关我事'] }))).toBe(false);
  });
  it('洗衣按上学阶段解析候选日期城市，不混用南京和北京天气所在地', async () => {
    const { NANJING } = await import('../src/utils/schoolPeriods');
    const config = { schoolCity: city, schoolPeriods: [
      { id: 'nj', city: NANJING, startMonth: '2021-09', endMonth: '2025-06' },
      { id: 'bj', city, startMonth: '2025-09', endMonth: '2028-06' },
    ] };
    expect(laundryLocation({ config }, '2025-06-30', { tagMap: { '2025-06-30': 'school' } })).toEqual(NANJING);
    expect(laundryLocation({ config }, '2025-09-01', { tagMap: { '2025-09-01': 'school' } })).toEqual(city);
    expect(laundryLocation({ config }, '2025-06-30', { tagMap: { '2025-06-30': 'travel' } })).toBeNull();
  });
  it('固定读取设置中的居城市，缺失或非法坐标时不猜寄城市或定位', () => {
    expect(laundryLocation({ config: { schoolCity: city, homeCity: { ...city, name: '杭州' } } })).toEqual(city);
    expect(laundryLocation({ config: { homeCity: city } })).toBeNull();
    for (const invalid of [null, { ...city, latitude: 100 }, { ...city, longitude: NaN }, { ...city, name: '' }])
      expect(laundryLocation({ config: { schoolCity: invalid } })).toBeNull();
  });
});

describe('天气与日程选日', () => {
  it.each([{ tags: ['北京'] }, { tags: ['居', '北京'] }])('天气和空档合适也必须符合城市地点规则：$tags', ({ tags }) => {
    const current = task({ tags });
    const calendarState = { locationTags: ['居', '北京', '广州'],
      tagMap: Object.fromEntries(dates.map(date => [date, 'school'])),
      cityMap: Object.fromEntries(dates.map(date => [date, date === '2026-10-12' ? BEIJING : GUANGZHOU])) };
    expect(chooseLaundryDay(current, '2026-10-10', options({ calendarState }), () => forecast(sunny))).toBe('2026-10-12');
    expect(chooseLaundryDay(current, '2026-10-10', options({ calendarState: {
      ...calendarState, cityMap: Object.fromEntries(dates.map(date => [date, GUANGZHOU])),
    } }), () => forecast(sunny))).toBeNull();
  });
  it('待办标注15分钟时仍按50分钟避让后半段会议，恰好08:50开始则不冲突', () => {
    const current = task({ content: '(15m)' });
    const event = { title: '会议', start: '2026-10-10T08:30:00+08:00', end: '2026-10-10T09:00:00+08:00' };
    const o = options({ tasks: [current], availability: { startDate: '2026-10-05', endDate: '2026-11-01', events: [event] } });
    expect(chooseLaundryDay(current, '2026-10-10', o, () => forecast(sunny))).toBe('2026-10-09');
    event.start = '2026-10-10T08:50:00+08:00';
    expect(chooseLaundryDay(current, '2026-10-10', o, () => forecast(sunny))).toBe('2026-10-10');
  });
  it('当前待办的 Outlook 预约不占用自身空档，手动同名和其他任务仍避开', () => {
    const current = task(), f = forecast(sunny);
    const event = { title: '洗衣服', start: '2026-10-10T00:00:00Z', end: '2026-10-10T01:00:00Z',
      taskLink: { taskId: current.id, projectId: current.projectId } };
    const o = options({ availability: { startDate: '2026-10-05', endDate: '2026-11-01', events: [event] } });
    expect(chooseLaundryDay(current, '2026-10-10', o, () => f)).toBe('2026-10-10');
    for (const conflict of [{ ...event, taskLink: undefined },
      { ...event, taskLink: { taskId: 'other', projectId: 'life' } },
      { ...event, taskLink: { taskId: 'wash', projectId: 'other' } }]) {
      expect(chooseLaundryDay(current, '2026-10-10', { ...o, availability: { ...o.availability, events: [event, conflict] } }, () => f))
        .toBe('2026-10-09');
    }
  });
  it('全天洗衣待办仍核对将写入 Outlook 的08点时段，不能占用会议时间', () => {
    const current = task({ isAllDay: true });
    const o = options({ tasks: [current], availability: { startDate: '2026-10-05', endDate: '2026-11-01',
      events: [{ title: '会议', start: '2026-10-10T00:00:00Z', end: '2026-10-10T01:00:00Z' }] } });
    expect(chooseLaundryDay(current, '2026-10-10', o, () => forecast(sunny))).toBe('2026-10-09');
  });
  it('最早提前一天、最晚推后两天；即使提前两天天气更好也不入选', () => {
    const f = forecast();
    for (const date of ['2026-10-07', '2026-10-08', '2026-10-09']) f.days[date] = sunny;
    expect(chooseLaundryDay(task(), '2026-10-10', options(), () => f)).toBe('2026-10-09');
    const later = forecast();
    for (const date of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) later.days[date] = sunny;
    expect(chooseLaundryDay(task(), '2026-10-10', options(), () => later)).toBe('2026-10-12');
    expect(chooseLaundryDay(task(), '2026-10-10', options(), () => forecast(sunny))).toBe('2026-10-10');
  });
  it('寄居旅优先：有晴天但旅行不选；固定08点会议冲突也不选', () => {
    const f = forecast(), o = options();
    for (const date of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']) f.days[date] = sunny;
    o.calendarState.tagMap['2026-10-11'] = 'travel'; o.calendarState.tagMap['2026-10-12'] = 'travel';
    o.availability.events.push({ start: '2026-10-10T07:00:00+08:00', end: '2026-10-10T09:00:00+08:00', title: '会议' });
    const selected = chooseLaundryDay(task(), '2026-10-10', o, () => f);
    expect(selected).toBe('2026-10-09');
  });
  it('具体区间占满当天或重要事项用完额度时，选择其他可用日期', () => {
    const f = forecast(sunny), o = options();
    o.availability.events.push({ start: '2026-10-10T00:00:00+08:00', end: '2026-10-11T00:00:00+08:00', title: '全天外出' });
    expect(chooseLaundryDay(task(), '2026-10-10', o, () => f)).not.toBe('2026-10-10');
    const busy = task({ id: 'important', title: '重要事项 480分钟', isAllDay: true, repeatFlag: undefined });
    expect(chooseLaundryDay(task(), '2026-10-10', options({ tasks: [task(), busy, { ...busy, id: 'important-2' }] }), () => f)).toBe('2026-10-09');
  });
  it('固定洗衣时间不能跨入餐休时段，08点原定时间继续可用', () => {
    for (const hour of ['10:30', '11:00', '13:30', '17:30', '18:00', '19:30']) {
      const laundry = task({ startDate: `2026-10-10T${hour}:00+08:00`, dueDate: `2026-10-10T${hour}:00+08:00` });
      expect(chooseLaundryDay(laundry, '2026-10-10', options({ tasks: [laundry] }), () => forecast(sunny))).toBeNull();
    }
    expect(chooseLaundryDay(task(), '2026-10-10', options(), () => forecast(sunny))).toBe('2026-10-10');
  });
  it('实习日期标记不占用洗衣时段，具体时刻冲突仍避开', () => {
    const laundry = task({ startDate: '2026-10-10T14:00:00+08:00', dueDate: '2026-10-10T14:00:00+08:00' });
    const o = options({ tasks: [laundry], calendarState: { tagMap: Object.fromEntries(dates.map(date => [date, 'intern'])) } });
    expect(chooseLaundryDay(laundry, '2026-10-10', o, () => forecast(sunny))).toBe('2026-10-10');
    o.availability.events.push({ title: '会议', start: '2026-10-10T14:00:00+08:00', end: '2026-10-10T15:00:00+08:00' });
    expect(chooseLaundryDay(laundry, '2026-10-10', o, () => forecast(sunny))).not.toBe('2026-10-10');
  });
  it('只考虑剩余时间；过了08点不把定时待办排回今天；窗口过期不无限滚动', () => {
    expect(chooseLaundryDay(task(), '2026-10-05', options(), () => forecast(sunny))).toBe('2026-10-06');
    expect(chooseLaundryDay(task(), '2026-10-01', options(), () => forecast(sunny))).toBeNull();
  });
  it('天气缺失、过期或没有日程时保留原排期；阴雨不会被当晴天', () => {
    const f = forecast(); delete f.days['2026-10-09'];
    expect(chooseLaundryDay(task(), '2026-10-10', options(), () => f)).toBeNull();
    expect(chooseLaundryDay(task(), '2026-10-10', options(), () => ({ ...forecast(), fetchedAt: '2026-10-04T00:00:00Z' }))).toBeNull();
    expect(chooseLaundryDay(task(), '2026-10-10', options({ availability: undefined }), () => forecast())).toBeNull();
    const rainy = forecast(); rainy.days['2026-10-09'] = { ...wet, rain: 0.5, probability: 50 };
    rainy.days['2026-10-10'] = { ...wet, rain: 0.5, probability: 50 };
    expect(chooseLaundryDay(task(), '2026-10-10', options(), () => rainy)).toBe('2026-10-09');
  });
});

describe('洗衣同步与天气故障', () => {
  it.each(['2026-10-05T16:00:00+08:00', '2026-10-10T17:00:00+08:00'])(
    '同日手动改时保留日期，不被天气或原时段冲突重新排走（%s）', async currentTime => {
      const c = client();
      const moved = { title: '洗衣服', start: '2026-10-10T14:00:00+08:00', end: '2026-10-10T14:50:00+08:00',
        taskLink: { projectId: 'life', taskId: 'wash' } };
      const o = options({ now: new Date(currentTime), today: currentTime.slice(0, 10),
        availability: { startDate: '2026-10-05', endDate: '2026-11-01', events: [moved,
          { title: '会议', start: '2026-10-10T08:00:00+08:00', end: '2026-10-10T09:00:00+08:00' }] } });
      expect(await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection' })).toMatchObject({ updated: 1,
        decisions: [{ date: '2026-10-10', reason: expect.stringContaining('当日调整') }] });
      expect(c.current().startDate).toBe(o.tasks[0].startDate);
      expect(c.current().content).toContain('本轮未按天气重选日期');
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it('手动改时的旧预约不能阻止实际完成后的下一周期', async () => {
    const current = task({ repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=4' }), c = client(current);
    const o = options({ tasks: [current], now: new Date('2026-10-10T17:00:00+08:00'), today: '2026-10-10',
      history: [{ ...current, status: 2, completedTime: '2026-10-10T15:00:00+08:00' }],
      availability: { startDate: '2026-10-05', endDate: '2026-11-01', events: [
        { title: '洗衣服', start: '2026-10-10T14:00:00+08:00', end: '2026-10-10T14:50:00+08:00',
          taskLink: { projectId: 'life', taskId: 'wash' } },
      ] } });
    expect(await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection' })).toMatchObject({ updated: 1,
      decisions: [{ date: '2026-10-14' }] });
  });
  it('次日重新读取天气并改期，新日程冲突再次改期，但完成周期始终不漂移', async () => {
    const c = client(); mockWeather(forecast(sunny));
    expect((await syncLaundrySchedule(c.api, { ...options(), connectionId: 'connection' })).decisions[0].date).toBe('2026-10-10');
    const tomorrow = new Date('2026-10-06T05:00:00+08:00'), f = { ...forecast(), fetchedAt: tomorrow.toISOString() };
    for (const day of ['2026-10-11', '2026-10-12', '2026-10-13']) f.days[day] = sunny;
    mockWeather(f);
    const o = options({ tasks: [c.current()], today: '2026-10-06', now: tomorrow });
    expect((await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection' })).decisions[0])
      .toMatchObject({ target: '2026-10-10', date: '2026-10-12' });
    expect(upstream).toHaveBeenCalledTimes(2);
    o.availability.events.push({ title: '会议', start: '2026-10-12T00:00:00Z', end: '2026-10-12T01:00:00Z' });
    const changed = await syncLaundrySchedule(c.api, { ...o, tasks: [c.current()], connectionId: 'connection' });
    expect(changed.decisions[0]).toMatchObject({ target: '2026-10-10', date: '2026-10-11' });
    expect(c.current().dueDate).toBe('2026-10-11T00:00:00Z');
  });
  it('完整同步用 Outlook 新完成记录重排待办并保存新周期', async () => {
    const c = client(), o = options();
    o.availability.events.push({ title: '洗衣服', start: '2026-10-05T04:00:00Z', end: '2026-10-05T04:50:00Z' });
    await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection' });
    expect(data.get(LAUNDRY_STATE_KEY).anchors.wash.completion).toBe('2026-10-05T04:50:00Z');
  });
  it('四天周期从实际完成日计算目标，再避开雨天，反复同步不把晴天排期拉回目标日', async () => {
    const original = task({
      startDate: '2026-10-12T00:00:00Z', dueDate: '2026-10-12T00:00:00Z',
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=4',
    });
    const f = forecast();
    for (const day of ['2026-10-10', '2026-10-11']) f.days[day] = sunny;
    mockWeather(f);
    const c = client(original);
    const result = await syncLaundrySchedule(c.api, {
      ...options({ tasks: [original] }), connectionId: 'connection',
    });
    expect(result.updated).toBe(1);
    expect(result.decisions[0]).toMatchObject({ target: '2026-10-09', date: '2026-10-10', location: '北京' });
    expect(c.current()).toMatchObject({
      startDate: '2026-10-10T00:00:00Z', dueDate: '2026-10-10T00:00:00Z',
      repeatFlag: original.repeatFlag, repeatFrom: original.repeatFrom, tags: original.tags, priority: original.priority,
    });
    expect(upstream).toHaveBeenCalledOnce();
    expect(await syncLaundrySchedule(c.api, { ...options({ tasks: [c.current()] }), connectionId: 'connection' }))
      .toMatchObject({ updated: 0, decisions: [{ target: '2026-10-09', date: '2026-10-10' }] });
    expect(data.get(LAUNDRY_STATE_KEY).anchors.wash.target).toBe('2026-10-09');
  });
  it.each(['weather', 'availability'])('四天周期缺少 %s 时保留原排期，不强制写回周期目标日', async missing => {
    const original = task({ repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=4' }), c = client(original);
    if (missing === 'weather') upstream.mockRejectedValue(new Error('offline'));
    const o = options({ tasks: [original], ...(missing === 'availability' ? { availability: undefined } : {}) });
    expect(await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection' })).toMatchObject({ updated: 0,
      decisions: [{ target: '2026-10-09', reason: expect.stringContaining('保留原排期') }] });
    expect(c.api.updateTask).not.toHaveBeenCalled();
  });
  it('四天周期仍避开目标日固定时段的冲突', async () => {
    const original = task({ repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=4' }), c = client(original);
    mockWeather(forecast(sunny));
    const o = options({ tasks: [original] });
    o.availability.events.push({ title: '会议', start: '2026-10-09T08:00:00+08:00', end: '2026-10-09T09:00:00+08:00' });
    expect((await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection' })).decisions[0])
      .toMatchObject({ target: '2026-10-09', date: '2026-10-10' });
  });
  it('纠正旧窗口内提前两天的排期，保留时刻/重复/标签/清单和周期，再次执行幂等', async () => {
    const original = task({ startDate: '2026-10-08T00:00:00Z', dueDate: '2026-10-08T00:00:00Z',
      items: [{ id: 'pending', title: '晾衣', status: 0, startDate: '2026-10-08T02:00:00Z' },
      { id: 'done', title: '洗衣液', status: 1, startDate: '2026-10-01T00:00:00Z', completedTime: '2026-10-01T01:00:00Z' }] });
    const f = forecast(); for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) f.days[day] = sunny; mockWeather(f);
    const c = client(original);
    const result = await syncLaundrySchedule(c.api, { ...options({ tasks: [original] }), connectionId: 'connection' });
    expect(result.updated).toBe(1); expect(result.managedTaskIds.has('wash')).toBe(true);
    expect(c.current()).toMatchObject({ startDate: '2026-10-09T00:00:00Z', dueDate: '2026-10-09T00:00:00Z',
      repeatFlag: original.repeatFlag, repeatFrom: original.repeatFrom, priority: 5, tags: original.tags, status: 0,
      items: [{ startDate: '2026-10-09T02:00:00Z' }, original.items![1]] });
    expect(data.get(LAUNDRY_STATE_KEY).anchors.wash.target).toBe('2026-10-10');
    expect(c.api.updateTask).toHaveBeenCalledWith('wash', expect.not.objectContaining({ status: expect.anything() }));
    const again = await syncLaundrySchedule(c.api, { ...options({ tasks: [c.current()] }), connectionId: 'connection' });
    expect(again.updated).toBe(0); expect(upstream).toHaveBeenCalledOnce();
  });
  it('天气服务失败、无地点时仍保护洗衣日期，不影响其他任务；模板和完成任务不写', async () => {
    const c = client(); upstream.mockRejectedValue(new Error('weather unavailable'));
    expect((await syncLaundrySchedule(c.api, { ...options(), connectionId: 'connection' })).updated).toBe(0);
    expect(c.api.updateTask).not.toHaveBeenCalled(); expect(upstream).toHaveBeenCalledOnce();
    const missing = await syncLaundrySchedule(c.api, { ...options({ configState: {} }), connectionId: 'connection' });
    expect(missing.managedTaskIds.has('wash')).toBe(true);
    expect(missing.decisions[0].reason).toContain('尚未设置居的城市');
    expect(upstream).toHaveBeenCalledOnce();
    expect((await syncLaundrySchedule(c.api, { ...options(), connectionId: 'connection', excludedTaskIds: new Set(['wash']) })).managedTaskIds.size).toBe(0);
    expect((await syncLaundrySchedule(c.api, { ...options({ tasks: [task({ status: 2 })] }), connectionId: 'connection' })).updated).toBe(0);
  });
  it('用户在查天气期间完成/改期时不覆盖，也不误报已安排新日期', async () => {
    const c = client(); c.change({ status: 2, completedTime: now.toISOString() });
    const result = await syncLaundrySchedule(c.api, { ...options(), connectionId: 'connection' });
    expect(result.updated).toBe(0); expect(result.decisions[0].date).toBeUndefined();
    expect(c.api.updateTask).not.toHaveBeenCalled();
  });
  it('写入失败保留原周期；回读发现重复规则丢失则报错，不宣称同步成功', async () => {
    const f = forecast(); for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) f.days[day] = sunny; mockWeather(f);
    const c = client(); vi.mocked(c.api.updateTask).mockRejectedValueOnce(new Error('write failed'));
    await expect(syncLaundrySchedule(c.api, { ...options(), connectionId: 'connection' })).rejects.toThrow('write failed');
    expect(data.get(LAUNDRY_STATE_KEY).anchors.wash.target).toBe('2026-10-10');
    vi.mocked(c.api.updateTask).mockImplementationOnce(async () => {
      c.change({ startDate: '2026-10-08T00:00:00Z', dueDate: '2026-10-08T00:00:00Z', repeatFlag: undefined }); return c.current();
    });
    await expect(syncLaundrySchedule(c.api, { ...options(), connectionId: 'connection' })).rejects.toThrow('未正确保存');
  });
  it('不拿过期缓存改期，不把不完整返回的 null 当0毫米降水', async () => {
    const loc = city;
    await readLaundryForecast(loc, '2026-10-05', now);
    upstream.mockRejectedValueOnce(new Error('offline'));
    await expect(readLaundryForecast(loc, '2026-10-05', new Date(now.getTime() + 4 * 3600_000))).rejects.toThrow('offline');
    data.clear(); upstream.mockResolvedValue({ daily: { time: dates, precipitation_sum: dates.map(() => null) } });
    await expect(readLaundryForecast(loc, '2026-10-05', now)).rejects.toThrow('不完整');
  });
  it('北京时间跨午夜使用预报天数请求，远期缺测不阻止五天周期在近期避雨', async () => {
    const f = forecast();
    for (const day of ['2026-10-11', '2026-10-12']) f.days[day] = sunny;
    const response = mockWeather(f);
    const last = dates.indexOf('2026-10-20');
    response.daily.precipitation_sum[last] = null;
    const c = client();
    const midnight = new Date('2026-10-05T00:05:00+08:00');
    const result = await syncLaundrySchedule(c.api, { ...options({ now: midnight, history: [task({
      id: 'history', status: 2, completedTime: '2026-10-04T23:00:00+08:00',
    })] }), connectionId: 'connection' });
    expect(result.decisions[0]).toMatchObject({ target: '2026-10-09', date: '2026-10-11' });
    expect(c.current().repeatFlag).toBe('RRULE:FREQ=DAILY;INTERVAL=5');
    const url = upstream.mock.calls[0][0] as URL;
    expect(url.searchParams.get('forecast_days')).toBe('16');
    expect(url.searchParams.has('end_date')).toBe(false);
    expect((await readLaundryForecast(city, '2026-10-05', midnight)).days['2026-10-20']).toBeUndefined();
  });
  it('五天周期候选窗口内缺测仍保留原日期，不将缺测日当晴天', async () => {
    const response = mockWeather(forecast(sunny));
    response.daily.precipitation_sum[dates.indexOf('2026-10-11')] = null;
    const c = client();
    expect(await syncLaundrySchedule(c.api, { ...options(), connectionId: 'connection' })).toMatchObject({ updated: 0,
      decisions: [{ target: '2026-10-10', reason: expect.stringContaining('暂无完整天气') }] });
    expect(c.api.updateTask).not.toHaveBeenCalled();
  });
});


describe('出行前洗衣', () => {
  const tripOptions = (travelDays: string[], extra = {}) => {
    const o = options(extra);
    for (const day of travelDays) o.calendarState.tagMap[day] = 'travel';
    return { ...o, connectionId: 'connection', trips: buildTripSourcesFromSyncState(o.calendarState, {}) };
  };
  it.each([{ tags: ['北京'] }, { tags: ['居', '北京'] }])('出行前固定日也须匹配城市，不匹配或未知则保留：$tags', async ({ tags }) => {
    for (const beforeCity of [GUANGZHOU, undefined]) {
      const original = task({ tags }), c = client(original);
      const calendarState = { locationTags: ['居', '北京', '广州'],
        tagMap: Object.fromEntries(dates.map(date => [date, 'school'])),
        cityMap: { '2026-10-08': BEIJING, ...(beforeCity ? { '2026-10-09': beforeCity } : {}) } };
      const result = await syncLaundrySchedule(c.api, { ...tripOptions(['2026-10-10'], {
        tasks: [original], calendarState, availability: undefined, configState: {},
      }), mode: 'travel' });
      expect(result.managedTaskIds.has(original.id)).toBe(true);
      expect(result.decisions[0]).toMatchObject({ target: '2026-10-10', reason: expect.stringContaining('不符合地点规则或地点未知') });
      expect(c.api.updateTask).not.toHaveBeenCalled();
      expect(c.current()).toEqual(original);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('四天周期的目标日在出行期间也提前到出行前一天', async () => {
    const original = task({ repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=4' }), c = client(original);
    const result = await syncLaundrySchedule(c.api, tripOptions(['2026-10-09', '2026-10-10'], {
      tasks: [original], availability: undefined, configState: {},
    }));
    expect(result.decisions[0]).toMatchObject({ target: '2026-10-09', date: '2026-10-08' });
    expect(c.current().dueDate).toBe('2026-10-08T00:00:00Z');
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([
    [['2026-10-10'], '2026-10-09'],
    [['2026-10-09', '2026-10-10', '2026-10-11'], '2026-10-08'],
    [['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], '2026-10-06'],
  ])('周期日落在出行首日/中间/末日时固定到前一天：%s', async (travelDays, expected) => {
    const original = task();
    const actual = client(original);
    const result = await syncLaundrySchedule(actual.api, tripOptions(travelDays as string[], {
      tasks: [original], availability: undefined, configState: {},
    }));
    expect(result.decisions[0]).toMatchObject({ target: '2026-10-10', date: expected });
    expect(result.updated).toBe(1); expect(upstream).not.toHaveBeenCalled();
    expect(actual.current().dueDate).toBe(`${expected}T00:00:00Z`);
  });
  it('固定日前移可以超出天气窗口；反复同步不漂移，忽略当天日程冲突', async () => {
    const c = client(), o = tripOptions(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
    o.availability.events.push({ start: '2026-10-06T00:00:00+08:00', end: '2026-10-07T00:00:00+08:00', title: '全天安排' });
    const first = await syncLaundrySchedule(c.api, o);
    expect(first.decisions[0].date).toBe('2026-10-06');
    const again = await syncLaundrySchedule(c.api, { ...o, tasks: [c.current()] });
    expect(again.updated).toBe(0); expect(again.decisions[0].target).toBe('2026-10-10');
    expect(c.current()).toMatchObject({ repeatFlag: task().repeatFlag, tags: task().tags, priority: 5 });
  });
  it('只有周期目标日落在出行中才提前，天气选日碰到出行不会触发出行前规则', async () => {
    const c = client(), f = forecast();
    for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) f.days[day] = sunny;
    mockWeather(f);
    const result = await syncLaundrySchedule(c.api, tripOptions(['2026-10-11', '2026-10-12']));
    expect(result.decisions[0]).toMatchObject({ date: '2026-10-09', location: '北京' });
    expect(upstream).toHaveBeenCalledOnce();
    const url = upstream.mock.calls[0][0] as URL;
    expect(url.searchParams.get('latitude')).toBe('40');
    expect(url.searchParams.get('longitude')).toBe('116.3');
  });
  it('取消出行后仍沿原周期选天气；在前一天已经洗过不会再安排同一天', async () => {
    const c = client(), o = tripOptions(['2026-10-09', '2026-10-10']);
    expect((await syncLaundrySchedule(c.api, o)).decisions[0].date).toBe('2026-10-08');
    mockWeather(forecast(sunny));
    const canceled = await syncLaundrySchedule(c.api, { ...options({ tasks: [c.current()] }), connectionId: 'connection', trips: [] });
    expect(canceled.decisions[0].date).toBe('2026-10-10');
    const longTrip = tripOptions(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
    expect(laundryBeforeTrip('2026-10-13', longTrip.trips, '2026-10-08')).toBeNull();
  });
  it('尊重相邻出行的手动拆分；错过出行前一天不会把未来任务写到过去', async () => {
    const o = tripOptions(['2026-10-08', '2026-10-09', '2026-10-10']);
    const split = buildTripSourcesFromSyncState(o.calendarState, { tripSplits: { '2026-10-10': true } });
    expect(laundryBeforeTrip('2026-10-10', split)).toBe('2026-10-09');
    const c = client();
    const result = await syncLaundrySchedule(c.api, { ...o, today: '2026-10-09', now: new Date('2026-10-09T12:00:00+08:00') });
    expect(result.updated).toBe(0); expect(result.decisions[0].reason).toContain('出行前一天已过');
    expect(c.api.updateTask).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });
});

describe('异地实习按候选日期取天气', () => {
  it('跨城窗口分别查询北京与广州，地点跟随最终日期', async () => {
    const { BEIJING, GUANGZHOU, DEFAULT_INTERNSHIP_RULES } = await import('../src/utils/internship');
    const c = client();
    const configState = { config: { schoolCity: BEIJING, internshipPeriods: [{ id: 'gz', profileId: 'company', profileName: '公司', revision: 1,
      rules: { ...DEFAULT_INTERNSHIP_RULES, salary: 100 }, startDate: '2026-10-10', endDate: '2026-10-30', city: GUANGZHOU, schoolCity: BEIJING }] } };
    const result = await syncLaundrySchedule(c.api, { ...options({ configState }), connectionId: 'connection' });
    const latitudes = upstream.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('latitude'));
    expect(new Set(latitudes)).toEqual(new Set(['39.904', '23.129']));
    expect(result.decisions[0].location).toBe('广州');
    expect(laundryLocation(configState, '2026-10-11', options().calendarState)?.name).toBe('广州');
    expect(laundryLocation(configState, '2026-10-11', { tagMap: {}, dayOverrides: { '2026-10-11': { city: BEIJING } } })?.name).toBe('北京');
  });
});

it('手动时段、出行前和天气三个节点只声明各自适用任务', async () => {
  const c = client(), o = options();
  expect((await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection', mode: 'appointment' })).managedTaskIds.size).toBe(0);
  expect((await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection', mode: 'travel' })).managedTaskIds.size).toBe(0);
  expect(c.api.updateTask).not.toHaveBeenCalled();
  const appointment = { title: '洗衣服', start: '2026-10-10T09:00:00+08:00', end: '2026-10-10T09:50:00+08:00', taskLink: { projectId: 'life', taskId: 'wash' } };
  const matched = await syncLaundrySchedule(c.api, { ...o, connectionId: 'connection', mode: 'appointment', availability: { ...o.availability, events: [appointment] } });
  expect([...matched.managedTaskIds]).toEqual(['wash']); expect(matched.decisions[0].date).toBe('2026-10-10');
});
