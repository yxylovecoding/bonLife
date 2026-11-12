import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarTrainingCompletions, CALENDAR_TRAINING_KEY, isFinalTrainingRound, readCalendarTrainingCompletions, syncCalendarTraining } from './_lifeCalendarTraining';
import { encryptOutlookConnection } from './_outlookCalendar';
import { OUTLOOK_CONNECTION_KEY } from './_outlookSync';
import { readTrainingSource } from './_lifeTraining';
import { rollingTrainingPlan } from '../src/utils/lifeTraining';
import { DEFAULT_CYCLE } from '../src/utils/bonLife';
import type { OutlookDayEvent } from '../src/utils/outlookCalendar';

const { data } = vi.hoisted(() => ({ data: new Map<string, any>() }));
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  hgetall: async (key: string) => structuredClone(data.get(key) ?? null),
  eval: async (_script: string, keys: string[], args: any[]) => {
    if (data.get(keys[0])?.id !== args[0]) return 0;
    if ((data.get(keys[1])?.requestedAt ?? 0) !== args[3]) return -1;
    data.set(keys[1], JSON.parse(args[2])); return 1;
  },
} }));
const now = new Date('2026-11-12T23:01:00+08:00');
const event = (title: string, overrides: Partial<OutlookDayEvent> = {}): OutlookDayEvent => ({
  calendar: 'work', title, startDate: '2026-11-12T12:00:00Z', endDate: '2026-11-12T13:00:00Z', allDay: false, ...overrides,
});
const url = 'https://outlook.office365.com/owa/calendar/private/published/calendar.ics';
const feed = (title = '爬坡 #运动', extra = '') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:climb',
  'DTSTART:20261112T120000Z', 'DTEND:20261112T130000Z', `SUMMARY:${title}`, extra, 'END:VEVENT', 'END:VCALENDAR', ''].filter(Boolean).join('\r\n');
beforeEach(() => {
  data.clear(); vi.stubEnv('SYNC_SECRET', 'secret'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  data.set(OUTLOOK_CONNECTION_KEY, { id: 'outlook', encrypted: encryptOutlookConnection({ playUrl: '', classUrl: '',
    sources: [{ name: '日历', kind: 'play', url }], policy: 'manual', rules: { homeTitles: [], ignoredPlayTitles: [] } }, 'secret') });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(feed())));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('每日最后一轮导入运动日程', () => {
  it.each([['00:01', false], ['05:01', false], ['20:00', false], ['22:01', false], ['23:00', false], ['23:01', true], ['23:45', true]])('上海时间 %s 是否最后一轮', (time, expected) => {
    expect(isFinalTrainingRound(new Date(`2026-11-12T${time}:00+08:00`))).toBe(expected);
  });
  it('只识别标题中的标记，保留项目名，忽略未来、未结束、取消和无效时段', () => {
    expect(calendarTrainingCompletions([
      event('爬坡 #运动'), event('爬坡 #运动'), event('跑步'), event('爬坡训练'), event('游泳'), event('#运动 羽毛球'),
      event('取消 #运动', { cancelled: true }), event('稍后 #运动', { endDate: '2026-11-12T16:00:00Z' }),
      event('坏日期 #运动', { startDate: 'bad' }), event('反向 #运动', { endDate: '2026-11-12T11:00:00Z' }),
    ], '2026-11-01', now)).toEqual([{ project: '爬坡', date: '2026-11-12' }, { project: '羽毛球', date: '2026-11-12' }]);
  });
  it('全天按覆盖日期展开且结束日不计入，定时按上海开始日记账', () => {
    expect(calendarTrainingCompletions([
      event('游泳 #运动', { allDay: true, startDate: '2026-11-10', endDate: '2026-11-12' }),
      event('爬坡 #运动', { startDate: '2026-11-11T17:00:00Z', endDate: '2026-11-11T18:00:00Z' }),
      event('今日 #运动', { allDay: true, startDate: '2026-11-12', endDate: '2026-11-13' }),
    ], '2026-11-11', now)).toEqual([
      { project: '游泳', date: '2026-11-11' }, { project: '爬坡', date: '2026-11-12' }, { project: '今日', date: '2026-11-12' },
    ]);
  });
  it('任意订阅可导入，无 TickTick 也显示具体运动；重复执行不重复记录', async () => {
    await syncCalendarTraining(now); await syncCalendarTraining(now);
    expect(await readCalendarTrainingCompletions()).toEqual([{ project: '爬坡', date: '2026-11-12' }]);
    const source = await readTrainingSource(2026);
    expect(rollingTrainingPlan(2026, 11, '2026-11-12', source, DEFAULT_CYCLE, [], {}).plans.get('2026-11-12'))
      .toMatchObject({ plan: '爬坡', completed: true });
    vi.mocked(fetch).mockResolvedValue(new Response(feed('羽毛球 #运动')));
    await syncCalendarTraining(now);
    const updated = await readTrainingSource(2026);
    expect(updated.tasks).toContainEqual(expect.objectContaining({ name: '羽毛球', rotation: false }));
    expect(rollingTrainingPlan(2026, 11, '2026-11-12', updated, DEFAULT_CYCLE, [], {}).plans.get('2026-11-12'))
      .toMatchObject({ plan: '羽毛球', completed: true });
  });
  it('读取失败保留历史且不泄露订阅；取消或移除标记会纠正近期记录', async () => {
    await syncCalendarTraining(now);
    const saved = structuredClone(data.get(CALENDAR_TRAINING_KEY));
    vi.mocked(fetch).mockRejectedValue(new Error(url));
    await expect(syncCalendarTraining(now)).rejects.toThrow('运动日程同步失败，已保留历史，请重试');
    expect(data.get(CALENDAR_TRAINING_KEY)).toEqual(saved);
    vi.mocked(fetch).mockImplementation(async () => new Response(feed('爬坡 #运动', 'STATUS:CANCELLED')));
    await syncCalendarTraining(now); expect(await readCalendarTrainingCompletions()).toEqual([]);
    vi.mocked(fetch).mockImplementation(async () => new Response(feed('爬坡')));
    await syncCalendarTraining(now); expect(await readCalendarTrainingCompletions()).toEqual([]);
  });
  it('断开后保留历史，连接切换或并发新快照阻止旧请求发布', async () => {
    await syncCalendarTraining(now);
    const connection = data.get(OUTLOOK_CONNECTION_KEY);
    data.delete(OUTLOOK_CONNECTION_KEY);
    expect(await syncCalendarTraining(now)).toEqual({ connected: false });
    expect(await readCalendarTrainingCompletions()).toHaveLength(1);
    data.set(OUTLOOK_CONNECTION_KEY, { ...connection, id: 'new' });
    expect(await readCalendarTrainingCompletions()).toEqual([]);
    vi.mocked(fetch).mockImplementation(async () => { data.delete(OUTLOOK_CONNECTION_KEY); return new Response(feed()); });
    await expect(syncCalendarTraining(now)).rejects.toThrow('已保留历史');
    data.set(OUTLOOK_CONNECTION_KEY, connection);
    vi.mocked(fetch).mockImplementation(async () => {
      data.set(CALENDAR_TRAINING_KEY, { ...data.get(CALENDAR_TRAINING_KEY), requestedAt: Date.now() + 1 });
      return new Response(feed());
    });
    await expect(syncCalendarTraining(now)).rejects.toThrow('已保留历史');
  });
  it('保留窗口外历史，近期跨年记录正常合并', async () => {
    data.set(CALENDAR_TRAINING_KEY, { connectionId: 'outlook', requestedAt: 1, syncedAt: '', completions: [{ project: '游泳', date: '2025-12-31' }] });
    await syncCalendarTraining(now);
    expect(await readCalendarTrainingCompletions()).toEqual([{ project: '游泳', date: '2025-12-31' }, { project: '爬坡', date: '2026-11-12' }]);
  });
});
