import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { DEFAULT_OUTLOOK_RULES, type OutlookSnapshot } from '../src/utils/outlookCalendar';
import { DEFAULT_CYCLE } from '../src/utils/bonLife';
import { encryptOutlookConnection } from './_outlookCalendar';
import { OUTLOOK_CONNECTION_KEY, saveOutlookSnapshot, saveUploadedCalendarState, syncOutlookCalendar } from './_outlookSync';
import ticktickHandler from './ticktick-trips';
import syncHandler from './sync';

const { data, routineSync, tripSync, wishSync, templateRead, auth, events, doneSync, swimmingSync } = vi.hoisted(() => ({
  data: new Map<string, unknown>(), routineSync: vi.fn(), tripSync: vi.fn(), wishSync: vi.fn(), templateRead: vi.fn(), auth: vi.fn(), events: [] as string[], doneSync: vi.fn(), swimmingSync: vi.fn(),
}));
vi.mock('./_lifeSwimming.js', () => ({ syncSwimmingSchedule: swimmingSync,
  readSwimmingCycle: async () => ({ cycle: DEFAULT_CYCLE, periods: [] }) }));
vi.mock('./_lifeTraining.js', () => ({ syncTrainingSource: vi.fn(async () => undefined) }));
vi.mock('./_lifeDone.js', () => ({ syncRecentLifeDone: doneSync, collectCompleted: async () => [] }));
vi.mock('./_auth.js', () => ({ authOk: auth }));
vi.mock('@vercel/kv', () => ({ kv: {
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => {
    if (options?.nx && data.has(key)) return null;
    data.set(key, structuredClone(value)); return 'OK';
  },
  mset: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); return 'OK'; },
  del: async (...keys: string[]) => keys.forEach((key) => data.delete(key)),
  eval: async (_script: string, [key]: string[], [token]: string[]) => { if (data.get(key) === token) data.delete(key); },
} }));
vi.mock('./_ticktickTrips.js', async importOriginal => ({
  ...await importOriginal<typeof import('./_ticktickTrips')>(),
  decryptTickTickToken: () => 'token',
  TickTickOpenApiClient: class {},
  readConnectedTickTickTemplate: templateRead,
  readAllTickTickTasks: async () => [],
  getTickTickRoutineExcludedTaskIds: () => new Set(['template']),
  syncTickTickRoutines: routineSync,
  buildTripSourcesFromSyncState: (calendar: unknown) => calendar,
  reconcileTickTickTrips: tripSync,
  reconcileTickTickWishPreparations: wishSync,
}));

const today = '2026-09-25';
const secret = 'test-secret';
const playUrl = 'https://outlook.live.com/owa/calendar/private-play/published/calendar.ics';
const classUrl = 'https://outlook.office365.com/owa/calendar/private-class/published/calendar.ics';
const input = { playUrl, classUrl, rules: DEFAULT_OUTLOOK_RULES, policy: 'manual' as const };
const connection = () => ({ id: 'outlook-connection', encrypted: encryptOutlookConnection(input, secret) });
const calendar = () => data.get('calendar-tags') as { tagMap: Record<string, string>; outlookTravelTitles: Record<string, string>; confirmedExpenses: unknown };
const snapshot = (tags: OutlookSnapshot['tags'], startDate = '2026-09-01', endDate = '2026-10-01'): OutlookSnapshot => ({ startDate, endDate, tags });
const calendarIcs = (entries: [string, string, string][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...entries.flatMap(([start, end, title], index) => [
  'BEGIN:VEVENT', `UID:event-${index}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, `SUMMARY:${title}`, 'END:VEVENT',
]), 'END:VCALENDAR', ''].join('\r\n');

async function call(handler: typeof ticktickHandler, method: string, authorization?: string, body?: unknown) {
  const result = { status: 200, body: {} as Record<string, unknown> };
  const res = { setHeader: vi.fn(), status: (status: number) => { result.status = status; return res; },
    json: (body: Record<string, unknown>) => { result.body = body; return res; }, end: () => res };
  await handler({ method, headers: { authorization }, body, query: {} } as VercelRequest, res as unknown as VercelResponse);
  return result;
}
const cron = () => call(ticktickHandler, 'GET', 'Bearer cron-secret');

beforeEach(() => {
  data.clear(); events.length = 0; vi.clearAllMocks(); auth.mockResolvedValue(false);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-24T16:01:00Z'));
  vi.stubEnv('SYNC_SECRET', secret); vi.stubEnv('CRON_SECRET', 'cron-secret');
  data.set(OUTLOOK_CONNECTION_KEY, connection());
  data.set('calendar-tags', { tagMap: { '2026-09-25': 'school' }, confirmedExpenses: { '2026-09-25': { localIds: ['bill'], reviewed: true } }, initializedFromRecords: true });
  templateRead.mockImplementation(async () => { events.push('template'); return { id: 'template' }; });
  routineSync.mockResolvedValue({ routineUpdatedTaskCount: 0 }); tripSync.mockResolvedValue({ updatedTaskCount: 0 });
  wishSync.mockResolvedValue({});
  doneSync.mockResolvedValue(undefined);
  swimmingSync.mockResolvedValue({ updated: 0 });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    events.push('outlook');
    return new Response(url === playUrl
      ? calendarIcs([['20260825', '20260826', '窗口外'], ['20260826', '20260827', '窗口内'], ['20260925', '20260926', '🏠'], ['20260930', '20261002', '清迈']])
      : calendarIcs([['20261007', '20261008', '实习']]));
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('后台 Outlook 订阅快照', () => {
  it('未连接 TickTick 也按上海日期读取跨月日程，并保留账单字段', async () => {
    const result = await cron();
    expect(result.status).toBe(200); expect(result.body.connected).toBe(false);
    expect(calendar().tagMap['2026-09-25']).toBe('home'); expect(calendar().tagMap['2026-10-01']).toBe('travel');
    expect(calendar().confirmedExpenses).toEqual({ '2026-09-25': { localIds: ['bill'], reviewed: true } });
  });
  it('候选读取返回最新可用时间，未裁决前不发布场景', async () => {
    const before = structuredClone(calendar());
    const result = await syncOutlookCalendar(today, secret, { persist: false });
    expect(result.connected).toBe(true); expect(result.availability).toBeDefined(); expect(calendar()).toEqual(before);
    if (result.connected) await saveOutlookSnapshot(result.connection, result.snapshot, result.policy, result.requestedAt);
    expect(calendar().tagMap[today]).toBe('home');
  });
  it('后台归档失败仍独立更新订阅，错误不暴露内部响应', async () => {
    doneSync.mockRejectedValueOnce(new Error('private archive body'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await cron(); expect(result.status).toBe(502); expect(calendar().tagMap[today]).toBe('home');
    expect(JSON.stringify(result.body)).not.toContain('private archive'); spy.mockRestore();
  });
  it('任一订阅读取失败保留原快照，并保存可展示的失败状态', async () => {
    const before = structuredClone(calendar());
    vi.mocked(fetch).mockRejectedValue(new Error('private URL and token'));
    await expect(syncOutlookCalendar(today, secret)).rejects.toThrow('日历读取失败');
    expect(calendar()).toEqual(before);
    expect(JSON.stringify(data.get('outlook:calendar-read-status:v1'))).not.toContain('private URL');
    expect((data.get('outlook:calendar-read-status:v1') as any).error).toContain('日历读取失败');
  });
  it('未连接 Outlook 正常返回，普通状态查询不拉取订阅', async () => {
    auth.mockResolvedValue(true); await call(ticktickHandler, 'GET'); expect(fetch).not.toHaveBeenCalled();
    data.delete(OUTLOOK_CONNECTION_KEY); expect(await syncOutlookCalendar(today, secret)).toEqual({ connected: false });
  });
  it('读取过程中断开或替换连接时不写入旧结果', async () => {
    const before = structuredClone(calendar());
    vi.mocked(fetch).mockImplementation(async () => {
      data.set(OUTLOOK_CONNECTION_KEY, { ...connection(), id: 'replacement' });
      return new Response(calendarIcs([['20260925', '20260926', '清迈']]));
    });
    await expect(syncOutlookCalendar(today, secret)).rejects.toThrow('连接已变更');
    expect(calendar()).toEqual(before);
  });
  it('拉取期间的班标记不能覆盖 Outlook 出游，账单变更仍参与合并', async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      data.set('calendar-tags', { tagMap: { '2026-09-25': 'intern' }, manualTagDates: { '2026-09-25': true }, confirmedExpenses: { latest: true } });
      return new Response(calendarIcs([['20260925', '20260926', '清迈']]));
    });
    await syncOutlookCalendar(today, secret);
    expect(calendar().tagMap['2026-09-25']).toBe('travel');
    expect(calendar().confirmedExpenses).toEqual({ latest: true });
  });
});

describe('前后台快照与旧页面上传', () => {
  it('三个月后月度空订阅及旧页面上传都保留历史行程和名称', async () => {
    const stale = structuredClone(calendar());
    await saveOutlookSnapshot(connection(), { ...snapshot({ '2026-09-25': 'travel' }),
      travelTitles: { '2026-09-25': '历史旅行' } }, 'manual', 1);
    vi.setSystemTime(new Date('2027-01-04T00:00:00+08:00'));
    await saveOutlookSnapshot(connection(), snapshot({}), 'manual', 2);
    expect(calendar().tagMap['2026-09-25']).toBe('travel');
    expect(calendar().outlookTravelTitles['2026-09-25']).toBe('历史旅行');
    await saveUploadedCalendarState(stale);
    expect(calendar().tagMap['2026-09-25']).toBe('travel');
    expect(calendar().outlookTravelTitles['2026-09-25']).toBe('历史旅行');
    expect(calendar().confirmedExpenses).toEqual(stale.confirmedExpenses);
  });

  it('取消事件恢复原标记，旧页面上传不会复活已取消日程，也不会抹掉新增日程', async () => {
    const conn = connection();
    await saveOutlookSnapshot(conn, snapshot({ '2026-09-25': 'travel' }), 'manual', 1);
    const stale = structuredClone(calendar());
    await saveOutlookSnapshot(conn, snapshot({ '2026-09-26': 'home' }), 'manual', 2);
    auth.mockResolvedValue(true);
    expect((await call(syncHandler, 'PUT', undefined, { 'calendar-tags': stale })).status).toBe(200);
    expect(calendar().tagMap).toEqual({ '2026-09-25': 'school', '2026-09-26': 'home' });
    const first = structuredClone(calendar());
    await saveUploadedCalendarState(stale);
    expect(calendar()).toEqual(first);
  });
  it('新月份快照只替换对应范围，旧页面上传不能用手动班标记截断 Outlook 行程', async () => {
    const conn = connection();
    const stale = structuredClone(calendar());
    await saveOutlookSnapshot(conn, { ...snapshot({ '2026-08-30': 'travel', '2026-09-25': 'travel', '2026-10-02': 'home' }, '2026-08-01', '2026-11-01'),
      travelTitles: { '2026-08-30': '旧标题', '2026-09-25': '清迈' } }, 'manual', 1);
    await saveOutlookSnapshot(conn, snapshot({ '2026-09-26': 'travel' }), 'manual', 2);
    await saveUploadedCalendarState({ ...stale, tagMap: { ...stale.tagMap, '2026-09-26': 'intern' }, manualTagDates: { '2026-09-26': true } });
    expect(calendar().tagMap).toEqual({ '2026-08-30': 'travel', '2026-09-25': 'school', '2026-09-26': 'travel', '2026-10-02': 'home' });
    expect(calendar().outlookTravelTitles).toEqual({ '2026-08-30': '旧标题' });
  });
  it('新日程标题覆盖缓存中的旧标题，旧页面和更晚返回的旧请求都不能回退它', async () => {
    const conn = connection();
    await saveOutlookSnapshot(conn, { ...snapshot({ '2026-09-25': 'travel' }), travelTitles: { '2026-09-25': '旧名' } }, 'manual', 1);
    const stale = structuredClone(calendar());
    await saveOutlookSnapshot(conn, { ...snapshot({ '2026-09-25': 'travel' }), travelTitles: { '2026-09-25': '清迈' } }, 'manual', 3);
    await expect(saveOutlookSnapshot(conn, snapshot({}), 'manual', 2)).rejects.toThrow('日历已更新');
    await saveUploadedCalendarState(stale);
    expect(calendar().outlookTravelTitles['2026-09-25']).toBe('清迈');
  });
  it('Outlook 优先设置在后台和上传时保持一致', async () => {
    const stale = { tagMap: { '2026-09-25': 'intern' }, manualTagDates: { '2026-09-25': true } };
    data.set('calendar-tags', stale);
    await saveOutlookSnapshot(connection(), snapshot({ '2026-09-25': 'home' }), 'outlook', 1);
    await saveUploadedCalendarState(stale);
    expect(calendar().tagMap['2026-09-25']).toBe('home');
  });
  it('连接已断开或更换时不重放旧连接缓存', async () => {
    const stale = structuredClone(calendar());
    await saveOutlookSnapshot(connection(), snapshot({ '2026-09-25': 'travel' }), 'manual', 1);
    data.delete(OUTLOOK_CONNECTION_KEY);
    await saveUploadedCalendarState(stale);
    expect(calendar().tagMap['2026-09-25']).toBe('travel');
    data.set(OUTLOOK_CONNECTION_KEY, { ...connection(), id: 'new-connection' });
    await saveUploadedCalendarState(stale);
    expect(calendar().tagMap['2026-09-25']).toBe('travel');
  });
  it('同时保存快照和页面上传时按顺序合并，不丢失后台日程', async () => {
    const stale = structuredClone(calendar());
    await Promise.all([
      saveOutlookSnapshot(connection(), snapshot({ '2026-09-25': 'home' }), 'manual', 1),
      saveUploadedCalendarState(stale),
    ]);
    expect(calendar().tagMap['2026-09-25']).toBe('home');
    expect(data.has('outlook:calendar-write:lock')).toBe(false);
  });
});

vi.mock('./_accountRoute.js', () => ({ withAccountScope: (handler: unknown) => handler }));
