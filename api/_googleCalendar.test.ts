import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { connectGoogleCalendar, disconnectGoogleCalendar, googleCalendarStatus, readGoogleCalendarSources,
  GOOGLE_CALENDAR_KEY, validateGoogleRelayUrl } from './_googleCalendar';
import { readOutlookSnapshot, type OutlookSource } from './_outlookCalendar';
import { DEFAULT_OUTLOOK_RULES } from '../src/utils/outlookCalendar';
import { readPeriodCalendar } from './_bonLife';
import { encryptOutlookConnection } from './_outlookCalendar';

const { data } = vi.hoisted(() => ({ data: new Map<string, any>() }));
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  set: async (key: string, value: unknown) => data.set(key, structuredClone(value)),
  del: async (...keys: string[]) => keys.forEach(key => data.delete(key)),
} }));
const url = 'https://script.google.com/macros/s/abcdefghijklmnopqrstuvwx/exec';
const secret = 'test-calendar-secret-0123456789abcdef';
const sources: OutlookSource[] = [{ name: '玩', kind: 'play', url: 'https://outlook.live.com/owa/calendar/play/calendar.ics' },
  { name: '课', kind: 'class', url: 'https://outlook.live.com/owa/calendar/class/calendar.ics' }];
const event = { id: 'event', uid: 'ical-id', title: '实习', start: '2026-11-13', end: '2026-11-14', allDay: true };
const calendars = () => sources.map(source => ({ id: `google-${source.name}`, name: source.name,
  events: source.name === '课' ? [event] : [{ ...event, id: 'timed', title: '会议', allDay: false,
    start: '2026-11-13T14:00:00+08:00', end: '2026-11-13T15:00:00+08:00' }] }));
let alter: (value: any) => void;
let googleCalls: number;
function mockFetch() {
  return vi.fn(async (target: string, init: RequestInit) => {
    if (target.startsWith('https://outlook.')) return new Response('private-upstream-error', { status: 404 });
    googleCalls++;
    const input = JSON.parse(init.body as string);
    const value = { ...input, secret: undefined, complete: true, fetchedAt: new Date().toISOString(), calendars: calendars() };
    alter(value);
    return new Response(JSON.stringify(value));
  });
}
beforeEach(() => { data.clear(); alter = () => {}; googleCalls = 0; vi.stubEnv('SYNC_SECRET', 'test-encryption'); vi.stubGlobal('fetch', mockFetch()); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('只接受正式 Google 脚本入口，不接受其他主机、查询凭据或测试部署', () => {
  expect(validateGoogleRelayUrl(url)).toBe(url);
  for (const value of [url + '?key=secret', url + '#hash', url.replace('/exec', '/dev'),
    url.replace('script.google.com', 'evil.test'), url.replace('https:', 'http:'), url.replace('https://', 'https://user:pass@')])
    expect(() => validateGoogleRelayUrl(value)).toThrow('地址无效');
});
it('连接必须覆盖全部原日历，凭据加密，状态和断开均不泄露凭据', async () => {
  alter = value => { value.calendars.pop(); };
  await expect(connectGoogleCalendar(url, secret, sources)).rejects.toThrow('缺少');
  expect(data.has(GOOGLE_CALENDAR_KEY)).toBe(false);
  alter = () => {};
  expect(await connectGoogleCalendar(url, secret, sources)).toMatchObject({ connected: true, sources: ['玩', '课'] });
  expect(JSON.stringify(data.get(GOOGLE_CALENDAR_KEY))).not.toContain(secret);
  expect(JSON.stringify(await googleCalendarStatus())).not.toMatch(/script.google|encrypted|test-calendar/);
  await disconnectGoogleCalendar(); expect(await googleCalendarStatus()).toMatchObject({ connected: false });
});
it('Outlook 失败才读取 Google，保留全天场景和实际时间边界', async () => {
  await connectGoogleCalendar(url, secret, sources); googleCalls = 0;
  const snapshot = await readOutlookSnapshot({ sources, playUrl: '', classUrl: '', policy: 'manual', rules: DEFAULT_OUTLOOK_RULES },
    '2026-11-13', '2026-11-14', { startDate: '2026-11-13', endDate: '2026-11-14' });
  expect(snapshot.provider).toBe('google'); expect(snapshot.tags['2026-11-13']).toBe('intern');
  expect(snapshot.availability?.events).toEqual([{ title: '会议', start: '2026-11-13T06:00:00.000Z', end: '2026-11-13T07:00:00.000Z' }]);
  expect(googleCalls).toBe(1);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n')));
  await readOutlookSnapshot({ sources, playUrl: '', classUrl: '', policy: 'manual', rules: DEFAULT_OUTLOOK_RULES }, '2026-11-13', '2026-11-14');
  expect(googleCalls).toBe(1);
});
it('Google 经期备用按北京时间覆盖跨日，结束在午夜不多算一天', async () => {
  const source: OutlookSource = { ...sources[0], name: '日历', kind: 'calendar' };
  alter = value => { value.calendars = [{ id: 'google-period', name: '日历', events: [
    { ...event, title: '预计月经', allDay: false, start: '2026-11-12T15:00:00Z', end: '2026-11-13T16:00:00Z' },
  ] }]; };
  await connectGoogleCalendar(url, secret, [source]);
  const result = await readPeriodCalendar({ id: 'life', encrypted: encryptOutlookConnection({ sources: [],
    playUrl: source.url, classUrl: '', policy: 'manual', rules: DEFAULT_OUTLOOK_RULES }, 'test-encryption') }, 2026);
  expect(result.events).toEqual([{ uid: 'ical-id', startDate: '2026-11-12', endDate: '2026-11-14' }]);
});
it.each(['missing', 'truncated', 'stale', 'request', 'range', 'bad-date', 'wrong-id', 'duplicate'])('%s 备用结果不能当作空日程发布', async kind => {
  await connectGoogleCalendar(url, secret, sources);
  alter = value => {
    if (kind === 'missing') value.calendars.pop();
    if (kind === 'truncated') value.complete = false;
    if (kind === 'stale') value.fetchedAt = '2020-01-01T00:00:00Z';
    if (kind === 'request') value.requestId = 'other';
    if (kind === 'range') value.endDate = '2026-11-13';
    if (kind === 'bad-date') value.calendars[0].events[0].end = 'bad';
    if (kind === 'wrong-id') value.calendars[0].id = 'other-calendar';
    if (kind === 'duplicate') value.calendars.push(value.calendars[0]);
  };
  await expect(readGoogleCalendarSources(sources, '2026-11-13', '2026-11-14')).rejects.toThrow('备用日历读取失败');
  expect(await googleCalendarStatus()).toMatchObject({ error: 'Google 备用日历读取失败' });
});
it('原订阅变更时不能沿用旧映射；读取期间断开不会返回结果', async () => {
  await connectGoogleCalendar(url, secret, sources);
  await expect(readGoogleCalendarSources([{ ...sources[0], url: sources[0].url + '?changed' }], '2026-11-13', '2026-11-14')).rejects.toThrow();
  alter = () => { data.delete(GOOGLE_CALENDAR_KEY); };
  await expect(readGoogleCalendarSources(sources, '2026-11-13', '2026-11-14')).rejects.toThrow();
});
it('仅跟随 Google 内容跳转，后续 GET 不转发密钥或 POST 正文', async () => {
  await connectGoogleCalendar(url, secret, sources);
  let request: any;
  const fetch = vi.fn(async (target: string, init: RequestInit) => {
    if (target === url) { request = JSON.parse(init.body as string); return new Response('', { status: 302,
      headers: { location: 'https://script.googleusercontent.com/macros/echo?user_content_key=opaque' } }); }
    expect(init.body).toBeUndefined(); expect(init.headers).toBeUndefined();
    return new Response(JSON.stringify({ ...request, secret: undefined, complete: true, fetchedAt: new Date().toISOString(), calendars: calendars() }));
  });
  vi.stubGlobal('fetch', fetch);
  expect(await readGoogleCalendarSources(sources, '2026-11-13', '2026-11-14')).toHaveLength(2);
  fetch.mockImplementation(async () => new Response('', { status: 302, headers: { location: 'https://evil.test/steal' } }));
  await expect(readGoogleCalendarSources(sources, '2026-11-13', '2026-11-14')).rejects.toThrow();
});
it('Google 脚本必须读完分页，未授权或分页失败不返回部分日程', () => {
  const list = vi.fn().mockReturnValueOnce({ items: [{ id: 'id', iCalUID: 'uid', summary: '测试',
    start: { date: '2026-11-13' }, end: { date: '2026-11-14' } }], nextPageToken: 'next' }).mockReturnValueOnce({ items: [] });
  const context: any = { PropertiesService: { getScriptProperties: () => ({ getProperty: (key: string) => key === 'BON_CALENDAR_SECRET'
    ? secret : JSON.stringify({ 玩: 'google-play' }) }) }, Calendar: { Events: { list } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ setMimeType: () => JSON.parse(text) }) } };
  vm.runInNewContext(readFileSync(new URL('../integrations/google-calendar/Code.gs', import.meta.url), 'utf8'), context);
  const input = { protocol: 'bonlife-google-calendar-v1', secret, requestId: '00000000-0000-0000-0000-000000000000', startDate: '2026-11-13', endDate: '2026-11-14' };
  const run = (body: unknown) => context.doPost({ postData: { contents: JSON.stringify(body) } });
  expect(run({ ...input, secret: 'wrong' }).complete).toBe(false); expect(list).not.toHaveBeenCalled();
  expect(run(input)).toMatchObject({ complete: true, calendars: [{ events: [{ uid: 'uid', allDay: true }] }] });
  expect(list.mock.calls[1][1].pageToken).toBe('next');
  list.mockReturnValueOnce({ items: [], nextPageToken: 'next' }).mockImplementationOnce(() => { throw new Error('private-token'); });
  const failure = run(input); expect(failure.complete).toBe(false); expect(JSON.stringify(failure)).not.toContain('private-token');
});
