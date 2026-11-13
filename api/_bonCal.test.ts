import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BonCalConflict, readBonCalInputs, repairBonCalStorage, saveBonCalUpload, saveOutlookSnapshot } from './_bonCal/repository';
import { readBonCalContext, readBonCalSchedulingState } from './_bonCal/service';
import { readOutlookSnapshot } from './_bonCal/provider';
import { DEFAULT_OUTLOOK_RULES } from '../src/boncal/events';
const { data, google } = vi.hoisted(() => ({ data: new Map<string, any>(), google: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: {
  mget: async (...keys: string[]) => keys.map(key => structuredClone(data.get(key) ?? null)),
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  hgetall: async (key: string) => structuredClone(data.get(key) ?? {}),
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => { if (options?.nx && data.has(key)) return null; data.set(key, structuredClone(value)); return 'OK'; },
  mset: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); },
  del: async (...keys: string[]) => keys.forEach(key => data.delete(key)),
  eval: async (_script: string, [key]: string[], [token]: string[]) => { if (data.get(key) === token) data.delete(key); },
} }));
vi.mock('./_bonCal/google.js', () => ({ readGoogleCalendarSources: google }));
beforeEach(() => { data.clear(); google.mockReset(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T02:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const input = { playUrl: 'https://outlook.live.com/owa/calendar/play/calendar.ics', classUrl: '', policy: 'manual' as const,
  sources: [{ name: '玩', kind: 'play' as const, url: 'https://outlook.live.com/owa/calendar/play/calendar.ics' }], rules: DEFAULT_OUTLOOK_RULES };

it('旧客户端整包不能覆盖公共日历，但仍能保存账单确认字段', async () => {
  data.set('calendar-tags', { tagMap: { '2026-11-13': 'home' } });
  await saveBonCalUpload({ 'calendar-tags': { tagMap: { '2026-11-13': 'travel' }, outlookTravelTitles: { '2026-11-13': '生日' }, confirmedExpenses: { kept: true } } });
  expect(data.get('calendar-tags')).toMatchObject({ tagMap: { '2026-11-13': 'home' }, confirmedExpenses: { kept: true } });
  expect(data.get('calendar-tags').outlookTravelTitles).toEqual({});
});
it('公共编辑使用版本校验，来源变化后拒绝覆盖', async () => {
  const first = await readBonCalInputs();
  const saved = await saveBonCalUpload({ 'calendar-tags': { tagMap: { '2026-11-13': 'home' } } }, first.revision);
  expect(saved.revision).not.toBe(first.revision);
  await expect(saveBonCalUpload({ 'calendar-tags': { tagMap: { '2026-11-13': 'travel' } } }, first.revision)).rejects.toBeInstanceOf(BonCalConflict);
  expect(data.get('calendar-tags').tagMap['2026-11-13']).toBe('home');
});
it('修复保存备份并可重复运行，服务端上下文和原存储一致', async () => {
  data.set('calendar-tags', { tagMap: { '2026-11-13': 'travel' }, outlookApplied: { '2026-11-13': { tag: 'travel', previousTag: 'home' } }, outlookTravelTitles: { '2026-11-13': '生日🎂' } });
  data.set('app-config', { config: { homeCity: { name: '广州', latitude: 23.1, longitude: 113.3 }, birthDate: '2002-12-29' } });
  await repairBonCalStorage(); const backup = structuredClone(data.get('boncal:repair:reminders:v1'));
  await repairBonCalStorage(); expect(data.get('boncal:repair:reminders:v1')).toEqual(backup);
  const context = await readBonCalContext('2026-11-13', '2026-11-14');
  expect(context.days['2026-11-13']).toMatchObject({ tag: 'home', travel: false, locations: [{ name: '广州' }] });
  expect(context.trips).toEqual([]); expect(context.calendar.tagMap).toEqual(data.get('calendar-tags').tagMap);
  expect(data.get('app-config').config.birthDate).toBe('2002-12-29');
});
it('Outlook 故障按同一来源切换 Google，生日排除与定时占用独立', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-url-must-not-leak')));
  google.mockResolvedValue([{name: '玩', events: [{ calendar: 'play', title: '生日', uid: 'birthday', startDate: '2026-11-13', endDate: '2026-11-14', allDay: true },
    { calendar: 'play', title: '生日晚餐', uid: 'dinner', startDate: '2026-11-13T10:00:00Z', endDate: '2026-11-13T11:00:00Z', allDay: false }] }]);
  const result = await readOutlookSnapshot(input, '2026-11-13', '2026-11-14', { startDate: '2026-11-13', endDate: '2026-11-14' });
  expect(result.tags).toEqual({}); expect(result.availability?.events).toHaveLength(1);
  expect(result.sources?.[0].provider).toBe('google'); expect(result.events).toHaveLength(2);
  google.mockRejectedValue(new Error('backup-private-url'));
  await expect(readOutlookSnapshot(input, '2026-11-13', '2026-11-14')).rejects.toThrow('「玩」日历读取失败');
});

it('账单上下文、排程与衣橱在同版本使用同一地点优先级和行程', async () => {
  const { readClothesTrips } = await import('./_clothesTrips');
  data.set('calendar-tags', { tagMap: { '2026-11-13': 'travel' }, outlookTravelTitles: { '2026-11-13': '北京' },
    dayOverrides: { '2026-11-13': { city: { name: '广州', latitude: 23, longitude: 113 } } } });
  data.set('bonclothes:contexts:v1', { '2026-11-13': { location: { source: 'manual', name: '南京', latitude: 32, longitude: 119 } } });
  const context = await readBonCalContext('2026-11-13', '2026-11-14', { repair: true });
  const scheduling = await readBonCalSchedulingState(undefined, undefined, '2026-11-13');
  const clothes = await readClothesTrips('2026-11-13', 'Asia/Shanghai');
  expect(scheduling.bonCalRevision).toBe(context.revision);
  expect(context.days['2026-11-13'].location?.name).toBe('南京');
  expect(scheduling.cityMap['2026-11-13']).toEqual(context.days['2026-11-13'].location);
  expect(clothes.trips.map(trip => [trip.id, trip.title, trip.dates])).toEqual(context.trips.map(trip => [trip.id, trip.title, trip.dates]));
  expect(clothes.trips[0].locations?.map(city => city.name)).toEqual(['南京']);
});
it('多目的地没有每日明确位置时，公共上下文与排程都返回未知', async () => {
  data.set('calendar-tags', { tagMap: { '2026-11-13': 'travel' }, outlookTravelTitles: { '2026-11-13': '北京、广州' } });
  for (const [name, latitude, longitude] of [['北京', 40, 116], ['广州', 23, 113]]) data.set(`weather:destination:v2:${name}`, { city: { name, latitude, longitude, source: 'calendar' } });
  const context = await readBonCalContext('2026-11-13', '2026-11-14');
  const scheduling = await readBonCalSchedulingState(undefined, undefined, '2026-11-13');
  expect(context.days['2026-11-13'].location).toBeNull(); expect(scheduling.cityMap['2026-11-13']).toBeNull();
});
it('历史快照的明确生日证据能修复缺少标题的日期，保留同日回家候选', async () => {
  data.set('calendar-tags', { tagMap: { '2026-01-01': 'travel' }, outlookApplied: { '2026-01-01': { tag: 'travel', previousTag: 'school' } } });
  data.set('outlook:calendar-snapshots:v1', { connectionId: 'old', snapshots: [{ startDate: '2026-01-01', endDate: '2026-01-02',
    tags: { '2026-01-01': 'travel' }, travelTitles: { '2026-01-01': 'Birthday' }, ruleCandidates: { '2026-01-01': ['calendar-travel', 'calendar-home'] } }] });
  await repairBonCalStorage(); expect(data.get('calendar-tags').tagMap['2026-01-01']).toBe('home');
  await repairBonCalStorage(); expect(data.get('calendar-tags').tagMap['2026-01-01']).toBe('home');
});
it('只改定时占用也改变版本，且北京时间凌晨的日程进入上下文', async () => {
  data.set('outlook:calendar-connection:v1', { id: 'source' });
  const before = await readBonCalInputs();
  await saveOutlookSnapshot({ id: 'source', encrypted: '' }, { startDate: '2026-11-13', endDate: '2026-11-14', tags: {},
    events: [{ calendar: 'play', uid: 'dinner', title: '生日活动', allDay: false, startDate: '2026-11-12T16:00:00Z', endDate: '2026-11-12T17:00:00Z' }] }, 'manual', Date.now());
  const context = await readBonCalContext('2026-11-13', '2026-11-14');
  expect(context.revision).not.toBe(before.revision); expect(context.events).toHaveLength(1); expect(context.trips).toEqual([]);
});
