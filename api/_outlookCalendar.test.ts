import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarReadAdvice, calendarReadFailure, decryptOutlookConnection, encryptOutlookConnection, fetchCalendar, parseOutlookCalendar, parseOutlookInput, readOutlookSnapshot, validateOutlookUrl } from './_outlookCalendar';
import { DEFAULT_OUTLOOK_RULES } from '../src/utils/outlookCalendar';
import { planTickTickDay, type DailyPlanState } from './_ticktickDailyPlan';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const calendar = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\n${events}\r\nEND:VCALENDAR\r\n`;
const event = (properties: string) => `BEGIN:VEVENT\r\n${properties.replace(/\n/g, '\r\n')}\r\nEND:VEVENT`;
const parse = (ics: string) => parseOutlookCalendar(ics, 'class', '2026-09-01', '2026-10-01');
const playUrl = 'https://outlook.live.com/owa/calendar/private-play/published/calendar.ics';
const classUrl = 'https://outlook.office365.com/owa/calendar/private-class/published/calendar.ics';
const input = { playUrl, classUrl, policy: 'manual' as const, rules: DEFAULT_OUTLOOK_RULES };
afterEach(() => vi.unstubAllGlobals());

describe('Outlook ICS 解析', () => {
  it('native HTTPS 网络错误不误报解析失败或订阅失效，也不泄露 URL', () => {
    const error = Object.assign(new Error(playUrl), { code: 'ECONNRESET' });
    expect(calendarReadFailure(error)).toEqual({ reason: 'network', codes: ['ECONNRESET'] });
    expect(calendarReadAdvice(error)).toBe('Outlook 暂时无法连接，请稍后重试');
  });
  it.each([
    [503, 'Outlook 服务暂不可用，请稍后重试'],
    [429, 'Outlook 请求过于频繁，请稍后重试'],
    [404, '请检查订阅链接与共享范围'],
  ])('日历 HTTP %i 返回对应建议且不回显上游正文', async (status, advice) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`PRIVATE ${playUrl}`, { status: Number(status) })));
    await expect(readOutlookSnapshot({ ...input, classUrl: '' }, '2026-10-01', '2026-11-01'))
      .rejects.toThrow(`「玩」日历读取失败，${advice}`);
  });
  it.each(['connect', 'aggregate'])('%s 连接超时后尝试受限的 IPv4 读取，仍不跟随重定向', async kind => {
    const valid = calendar('');
    const cause = kind === 'connect' ? { code: 'UND_ERR_CONNECT_TIMEOUT' }
      : { errors: [{ code: 'ETIMEDOUT' }, { code: 'ENETUNREACH' }] };
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause }));
    vi.stubGlobal('fetch', fetch);
    const get = vi.spyOn(https, 'get').mockImplementation(((_url: string, options: any, callback: (response: any) => void) => {
      expect(options).toMatchObject({ family: 4, headers: { Accept: 'text/calendar' } });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const request = new EventEmitter();
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), { statusCode: 200 });
        callback(response); response.end(valid);
      });
      return request;
    }) as any);
    try {
      expect(await fetchCalendar(playUrl)).toBe(valid);
      expect(fetch).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
      get.mockImplementation(((_url: string, _options: any, callback: (response: any) => void) => {
        const request = new EventEmitter();
        queueMicrotask(() => callback(Object.assign(new PassThrough(), { statusCode: 302, headers: { location: 'https://private.invalid' } })));
        return request;
      }) as any);
      await expect(fetchCalendar(playUrl)).rejects.toThrow('订阅链接暂不可用');
      expect(get).toHaveBeenCalledTimes(2);
    } finally { get.mockRestore(); }
  });
  it('Outlook 短暂 500 后只读重试一次，永久失败仍中止且不泄露上游正文', async () => {
    const valid = calendar(event('UID:one\nDTSTART;VALUE=DATE:20261004\nDTEND;VALUE=DATE:20261005\nSUMMARY:活动'));
    const fetch = vi.fn().mockResolvedValueOnce(new Response('PRIVATE upstream', { status: 500 }))
      .mockResolvedValueOnce(new Response(valid));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchCalendar(playUrl)).toBe(valid);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockReset().mockImplementation(async () => new Response('PRIVATE', { status: 503 }));
    await expect(fetchCalendar(playUrl)).rejects.toThrow('订阅链接暂不可用');
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockReset().mockResolvedValue(new Response('PRIVATE', { status: 404 }));
    await expect(fetchCalendar(playUrl)).rejects.toThrow('订阅链接暂不可用');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('诊断区分 HTTP、超时和解析失败，日志不包含订阅地址或响应正文', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`private ${playUrl}`, { status: 429 })));
      await expect(readOutlookSnapshot({ ...input, classUrl: '' }, '2026-10-01', '2026-11-01')).rejects.toThrow('日历读取失败');
      expect(warn).toHaveBeenCalledWith('[outlook-calendar-read-failure]', JSON.stringify({ reason: 'http', http: 429 }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
      expect(calendarReadFailure(new DOMException('secret URL', 'TimeoutError'))).toEqual({ reason: 'timeout' });
      expect(calendarReadFailure(new Error('日程时段无效'))).toEqual({ reason: 'invalid-duration' });
      expect(calendarReadFailure(new Error(playUrl))).toEqual({ reason: 'parse' });
      expect(calendarReadFailure(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND', hostname: playUrl } })))
        .toEqual({ reason: 'network', codes: ['ENOTFOUND'] });
      expect(calendarReadFailure(new TypeError('fetch failed', { cause: { errors: [{ code: 'ECONNRESET' }, { code: 'PRIVATE' }] } })))
        .toEqual({ reason: 'network', codes: ['ECONNRESET'] });
      expect(calendarReadFailure(new TypeError('fetch failed', { cause: { message: 'unexpected redirect' } })))
        .toEqual({ reason: 'redirect' });
    } finally { warn.mockRestore(); }
  });
  it('共享解析仍分别展开窗口和改期例外，下次读取立即采用新内容', async () => {
    const makeCalendar = (title: string) => calendar([
      event('UID:trip\nDTSTART;VALUE=DATE:20261004\nDTEND;VALUE=DATE:20261005\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:出游'),
      event('UID:trip\nRECURRENCE-ID;VALUE=DATE:20261005\nDTSTART;VALUE=DATE:20261008\nDTEND;VALUE=DATE:20261009\nSUMMARY:出游'),
      event(`UID:timed\nDTSTART;TZID=China Standard Time:20261004T090000\nDTEND;TZID=China Standard Time:20261004T100000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:${title}`),
      event('UID:timed\nRECURRENCE-ID;TZID=China Standard Time:20261005T090000\nDTSTART;TZID=China Standard Time:20261005T110000\nDTEND;TZID=China Standard Time:20261005T120000\nSUMMARY:改期'),
    ].join('\r\n'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(makeCalendar('原日程')))
      .mockResolvedValueOnce(new Response(makeCalendar('新日程'))));
    const read = () => readOutlookSnapshot({ ...input, classUrl: '' }, '2026-10-01', '2026-11-01',
      { startDate: '2026-10-05', endDate: '2026-10-07' }, 'Asia/Shanghai');
    const first = await read(), second = await read();
    expect(first.tags).toEqual({ '2026-10-04': 'travel', '2026-10-06': 'travel', '2026-10-08': 'travel' });
    expect(first.availability?.events).toEqual([
      { title: '原日程', start: '2026-10-06T01:00:00.000Z', end: '2026-10-06T02:00:00.000Z' },
      { title: '改期', start: '2026-10-05T03:00:00.000Z', end: '2026-10-05T04:00:00.000Z' },
    ]);
    expect(second.tags).toEqual(first.tags);
    expect(second.availability?.events[0].title).toBe('新日程');
    expect(first.availability?.events[0].title).toBe('原日程');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('只在请求时提取 TickTick 关联标识，不把日程正文或私人链接返回前端', () => {
    const ics = calendar(event('UID:laundry\nDTSTART:20261004T010000Z\nDTEND:20261004T020000Z\nSUMMARY:洗衣服\nDESCRIPTION:private note https://ticktick.com/webapp/#p/life/tasks/laundry'));
    expect(parseOutlookCalendar(ics, 'work', '2026-10-01', '2026-11-01', true, true)[0]).not.toHaveProperty('taskLink');
    const linked = parseOutlookCalendar(ics, 'work', '2026-10-01', '2026-11-01', true, true, { includeTaskLink: true })[0];
    expect(linked.taskLink).toEqual({ projectId: 'life', taskId: 'laundry' });
    expect(JSON.stringify(linked)).not.toContain('private note');
    expect(JSON.stringify(linked)).not.toContain('https://');
  });
  it('忙闲读取保留具体时刻、上海跨日、循环例外；空闲和取消日程不占用', () => {
    const ics = calendar([
      event('UID:timed\nDTSTART:20261003T163000Z\nDTEND:20261003T173000Z\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20261004T163000Z\nSUMMARY:课程'),
      event('UID:timed\nRECURRENCE-ID:20261005T163000Z\nDTSTART:20261004T020000Z\nDTEND:20261004T030000Z\nSUMMARY:改期课程'),
      event('UID:free\nDTSTART:20261004T030000Z\nDTEND:20261004T040000Z\nTRANSP:TRANSPARENT\nSUMMARY:提醒'),
      event('UID:cancel\nDTSTART:20261004T030000Z\nDTEND:20261004T040000Z\nSTATUS:CANCELLED\nSUMMARY:取消'),
    ].join('\r\n'));
    const result = parseOutlookCalendar(ics, 'class', '2026-10-04', '2026-10-06', false, true);
    expect(result.map(({ title, startDate, endDate }) => [title, startDate, endDate])).toEqual([
      ['课程', '2026-10-03T16:30:00.000Z', '2026-10-03T17:30:00.000Z'],
      ['改期课程', '2026-10-04T02:00:00.000Z', '2026-10-04T03:00:00.000Z'],
    ]);
  });
  it('具体时刻读取 VTIMEZONE 的偏移，没有定义的未知时区不当作 UTC', () => {
    const zone = ['BEGIN:VTIMEZONE', 'TZID:China Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T000000',
      'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
    const timed = event('UID:class\nDTSTART;TZID=China Standard Time:20261004T090000\nDTEND;TZID=China Standard Time:20261004T100000\nSUMMARY:课');
    const result = parseOutlookCalendar(calendar(`${zone}\r\n${timed}`), 'class', '2026-10-04', '2026-10-05', false, true);
    expect(result[0].startDate).toBe('2026-10-04T01:00:00.000Z');
    expect(() => parseOutlookCalendar(calendar(timed.replaceAll('China Standard Time', 'Unknown/Zone')), 'class', '2026-10-04', '2026-10-05', false, true)).toThrow('时区缺失');
  });
  it('一次订阅读取同时提供全天场景和独立的忙闲窗口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(calendar([
      event('UID:trip\nDTSTART;VALUE=DATE:20261004\nDTEND;VALUE=DATE:20261005\nSUMMARY:出游'),
      event('UID:class\nDTSTART:20261004T010000Z\nDTEND:20261004T020000Z\nSUMMARY:课'),
      event('UID:far\nDTSTART:20261104T010000Z\nDTEND:20261104T020000Z\nSUMMARY:远期'),
    ].join('\r\n')))));
    const result = await readOutlookSnapshot({ ...input, classUrl: '' }, '2026-10-01', '2026-12-01', { startDate: '2026-10-04', endDate: '2026-10-05' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.tags).toEqual({ '2026-10-04': 'travel' });
    expect(result.availability?.events).toEqual([{ title: '课', start: '2026-10-04T01:00:00.000Z', end: '2026-10-04T02:00:00.000Z' }]);
  });
  it('忙闲快照保留标为 Free/Transparent 的个人日程，避免排期漏扣', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(calendar([
      event('UID:aosen\nDTSTART;TZID=China Standard Time:20261007T090000\nDTEND;TZID=China Standard Time:20261007T110000\nX-MICROSOFT-CDO-BUSYSTATUS:FREE\nSUMMARY:奥森'),
      event('UID:meal\nDTSTART;TZID=China Standard Time:20261007T120000\nDTEND;TZID=China Standard Time:20261007T130000\nTRANSP:TRANSPARENT\nSUMMARY:吃饭'),
      event('UID:panjiayuan\nDTSTART;TZID=China Standard Time:20261007T140000\nDTEND;TZID=China Standard Time:20261007T160000\nSUMMARY:潘家园'),
    ].join('\r\n')))));
    const result = await readOutlookSnapshot({ ...input, classUrl: '' }, '2026-10-01', '2026-11-01',
      { startDate: '2026-10-07', endDate: '2026-10-08' }, 'Asia/Shanghai');
    expect(result.availability?.events).toEqual([
      { title: '奥森', start: '2026-10-07T01:00:00.000Z', end: '2026-10-07T03:00:00.000Z' },
      { title: '吃饭', start: '2026-10-07T04:00:00.000Z', end: '2026-10-07T05:00:00.000Z' },
      { title: '潘家园', start: '2026-10-07T06:00:00.000Z', end: '2026-10-07T08:00:00.000Z' },
    ]);
  });
  it.each([
    'DTSTART;VALUE=DATE:20261010\nDTEND;VALUE=DATE:20261013',
    'DTSTART;TZID=China Standard Time:20261010T000000\nDTEND;TZID=China Standard Time:20261013T000000\nX-MICROSOFT-CDO-ALLDAYEVENT:TRUE',
  ])('跨日全天日程只保留场景，下午仍可安排普通任务：%s', async (allDayDates) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(calendar([
      event(`UID:trip\n${allDayDates}\nSUMMARY:出游`),
      event('UID:evening\nDTSTART:20261011T110000Z\nDTEND:20261011T140000Z\nSUMMARY:晚间约定'),
    ].join('\r\n')))));
    const snapshot = await readOutlookSnapshot({ ...input, classUrl: '' }, '2026-10-01', '2026-12-01',
      { startDate: '2026-10-11', endDate: '2026-11-12' }, 'Asia/Shanghai');
    expect(snapshot.tags['2026-10-11']).toBe('travel');
    expect(snapshot.availability!.events).toEqual([
      { title: '晚间约定', start: '2026-10-11T11:00:00.000Z', end: '2026-10-11T14:00:00.000Z' },
    ]);
    const state: DailyPlanState = { connectionId: 'test', deadlines: {}, history: [] };
    const result = planTickTickDay({ tasks: [{ id: 'ordinary', projectId: 'inbox', title: '普通任务', content: '(30m)',
      isAllDay: true, dueDate: '2026-10-11T00:00:00+08:00' }], state, today: '2026-10-11',
      now: new Date('2026-10-11T14:45:01+08:00'), calendarState: { tagMap: snapshot.tags }, availability: snapshot.availability });
    expect(result.summary).toMatchObject({ todayCount: 1, plannedMinutes: 30, availableMinutes: 194 });
    expect(result.dates.get('ordinary')).toBe('2026-10-11');
  });
  it('展开重复实习，排除 EXDATE、已取消单次日程，并应用改期与标题变更', () => {
    const ics = calendar([
      event('UID:intern\nDTSTART;VALUE=DATE:20260901\nDTEND;VALUE=DATE:20260902\nSUMMARY:实习\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE;VALUE=DATE:20260902'),
      event('UID:intern\nRECURRENCE-ID;VALUE=DATE:20260903\nSTATUS:CANCELLED'),
      event('UID:intern\nRECURRENCE-ID;VALUE=DATE:20260904\nDTSTART;VALUE=DATE:20260910\nDTEND;VALUE=DATE:20260911\nSUMMARY:实习'),
      event('UID:intern\nRECURRENCE-ID;VALUE=DATE:20260905\nDTSTART;VALUE=DATE:20260905\nDTEND;VALUE=DATE:20260906\nSUMMARY:请假'),
    ].join('\r\n'));
    expect(parse(ics).map(({ title, startDate }) => [title, startDate])).toEqual([
      ['实习', '2026-09-01'], ['实习', '2026-09-10'], ['请假', '2026-09-05'],
    ]);
  });
  it('保留全天的本地日期，支持 Windows 时区标记和无 DTEND 的单日', () => {
    const ics = calendar([
      event('UID:home\nDTSTART;TZID=China Standard Time:20260920T000000\nDTEND;TZID=China Standard Time:20260922T000000\nX-MICROSOFT-CDO-ALLDAYEVENT:TRUE\nSUMMARY:🏠'),
      event('UID:one\nDTSTART;VALUE=DATE:20260925\nSUMMARY:实习'),
      event('UID:timed\nDTSTART:20260925T090000Z\nDTEND:20260925T100000Z\nSUMMARY:实习'),
    ].join('\r\n'));
    expect(parse(ics).map(({ startDate, endDate }) => [startDate, endDate])).toEqual([
      ['2026-09-20', '2026-09-22'], ['2026-09-25', '2026-09-26'],
    ]);
  });
  it('取出从窗口外移入的例外，忽略移出和整组取消', () => {
    const ics = calendar([
      event('UID:moved\nDTSTART;VALUE=DATE:20260801\nDTEND;VALUE=DATE:20260802\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:实习'),
      event('UID:moved\nRECURRENCE-ID;VALUE=DATE:20260802\nDTSTART;VALUE=DATE:20260910\nDTEND;VALUE=DATE:20260911\nSUMMARY:实习'),
      event('UID:cancel\nDTSTART;VALUE=DATE:20260901\nDTEND;VALUE=DATE:20260902\nRRULE:FREQ=DAILY;COUNT=3\nSTATUS:CANCELLED\nSUMMARY:实习'),
    ].join('\r\n'));
    expect(parse(ics).map(({ startDate }) => startDate)).toEqual(['2026-09-10']);
  });
  it('拒绝截断或 HTML 响应，不当作空日历', () => {
    expect(() => parse('<html>Sign in</html>')).toThrow();
    expect(() => parse('BEGIN:VCALENDAR\r\n')).toThrow();
    expect(parse(calendar(''))).toEqual([]);
  });
});

describe('Outlook 订阅地址和加密', () => {
  it.each([
    'https://127.0.0.1/owa/calendar/a/calendar.ics',
    'https://outlook.live.com.evil.test/owa/calendar/a/calendar.ics',
    'https://outlook.live.com@evil.test/owa/calendar/a/calendar.ics',
    'http://outlook.live.com/owa/calendar/a/calendar.ics',
    'https://outlook.live.com:8080/owa/calendar/a/calendar.ics',
    'https://outlook.live.com/mail/',
  ])('拒绝非 Outlook 订阅地址 %s', (url) => expect(() => validateOutlookUrl(url)).toThrow());
  it('接受 webcal 并验证两个链接不重复', () => {
    expect(validateOutlookUrl(playUrl.replace('https:', 'webcal:'))).toBe(playUrl);
    expect(() => parseOutlookInput({ ...input, classUrl: playUrl })).toThrow();
  });
  it('加密内容不能直接读取链接，错误密钥或篡改后无法解密', () => {
    const encrypted = encryptOutlookConnection(input, 'secret');
    expect(encrypted).not.toContain('private-play');
    expect(decryptOutlookConnection(encrypted, 'secret')).toEqual({ ...input, sources: [
      { name: '玩', url: playUrl, kind: 'play' },
      { name: '课', url: classUrl, kind: 'class' },
    ] });
    expect(() => decryptOutlookConnection(encrypted, 'wrong')).toThrow();
    expect(() => decryptOutlookConnection(encrypted.slice(0, -5) + 'AAAAA', 'secret')).toThrow();
  });
  it('任一订阅读取失败则整次失败，不返回可误删日期的部分结果或泄露地址', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === classUrl) throw new Error(`failed: ${url}`);
      return new Response(calendar(event('UID:trip\nDTSTART;VALUE=DATE:20260922\nDTEND;VALUE=DATE:20260923\nSUMMARY:出游')));
    }));
    await expect(readOutlookSnapshot(input, '2026-09-01', '2026-10-01')).rejects.toThrow('「课」日历读取失败');
    expect(fetch).toHaveBeenCalledWith(playUrl, expect.objectContaining({ redirect: 'error' }));
  });
});

it('保留稳定 UID 与重复实例标识，移动例外不与系列其他实例混淆', () => {
  const ics = calendar([
    event('UID:stable\nDTSTART;VALUE=DATE:20261101\nDTEND;VALUE=DATE:20261102\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:原名'),
    event('UID:stable\nRECURRENCE-ID;VALUE=DATE:20261102\nDTSTART;VALUE=DATE:20261104\nDTEND;VALUE=DATE:20261105\nSUMMARY:改名'),
  ].join('\n'));
  const result = parseOutlookCalendar(ics, 'play', '2026-11-01', '2026-12-01', true);
  expect(result).toHaveLength(2);
  expect(result.every((item) => item.uid === 'stable')).toBe(true);
  expect(new Set(result.map((item) => item.recurrenceId)).size).toBe(2);
  expect(result.find((item) => item.title === '改名')?.recurrenceId).toBe('2026-11-02');
});
