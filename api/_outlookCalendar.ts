import { currentRulePolicy, hasRulePolicy } from './_rulePolicy.js';
import { activeRuleOrder } from '../src/utils/schedulingRules.js';
import ICAL from 'ical.js';
import { wallTimeInstant } from './_calendarTimezone.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { buildOutlookSnapshot, isCalendarDate, type OutlookCalendarKind, type OutlookConflictPolicy, type OutlookDayEvent, type OutlookRules } from '../src/utils/outlookCalendar.js';

export interface OutlookSource {
  name: string;
  url: string;
  kind: OutlookCalendarKind;
}

export interface OutlookConnectionInput {
  playUrl: string;
  classUrl: string;
  sources: OutlookSource[];
  policy: OutlookConflictPolicy;
  rules: OutlookRules;
}

export function validateOutlookUrl(value: string): string {
  try {
    const url = new URL(value.trim().replace(/^webcal:/i, 'https:'));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !['outlook.live.com', 'outlook.office.com', 'outlook.office365.com'].includes(url.hostname)
      || !/^\/(?:owa\/calendar|calendar\/published)\/.+\.ics$/i.test(url.pathname)) throw new Error();
    return url.href;
  } catch {
    throw new Error('请输入 Outlook 发布的 ICS 订阅链接');
  }
}

export function parseOutlookInput(body: unknown): OutlookConnectionInput {
  const input = body as Partial<OutlookConnectionInput> | null;
  if (!input || typeof input !== 'object') throw new Error('连接信息无效');
  const readUrl = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('订阅链接无效');
    return value.trim() ? validateOutlookUrl(value) : '';
  };
  const playUrl = readUrl(input.playUrl);
  const classUrl = readUrl(input.classUrl);
  const rawSources = Array.isArray(input.sources) ? input.sources : [];
  const sources: OutlookSource[] = [];
  const add = (name: string, url: string, kind: OutlookCalendarKind) => {
    if (!url) return;
    if (sources.some((s) => s.url === url)) throw new Error('订阅链接不能重复');
    if (sources.some((s) => s.name === name)) throw new Error(`日历名称「${name}」重复`);
    sources.push({ name, url, kind });
  };
  add('玩', playUrl, 'play');
  add('课', classUrl, 'class');
  for (const s of rawSources) {
    const url = readUrl(s?.url);
    const name = String(s?.name || '').trim();
    if (!url) continue;
    if (!name) throw new Error('日历名称无效');
    const kind = s?.kind === 'class' || s?.kind === 'work' ? s.kind : 'play';
    const existing = sources.find(source => source.url === url);
    if (existing && existing.name === name && existing.kind === kind) continue;
    add(name, url, kind);
  }
  if (!sources.length) throw new Error('请至少填写一个日历链接');
  if (input.policy !== 'manual' && input.policy !== 'outlook') throw new Error('同步优先级无效');
  const titles = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || item.length > 200)) {
      throw new Error('日程标题无效');
    }
    return [...new Set(value.map((item: string) => item.trim()).filter(Boolean))];
  };
  const canonicalPlayUrl = playUrl || sources.find(source => source.name === '玩' && source.kind === 'play')?.url || '';
  const canonicalClassUrl = classUrl || sources.find(source => source.name === '课' && source.kind === 'class')?.url || '';
  return { playUrl: canonicalPlayUrl, classUrl: canonicalClassUrl, sources, policy: input.policy, rules: {
    homeTitles: titles(input.rules?.homeTitles), ignoredPlayTitles: titles(input.rules?.ignoredPlayTitles),
  } };
}

export function parseOutlookRange(start: unknown, end: unknown) {
  if (typeof start !== 'string' || typeof end !== 'string' || !isCalendarDate(start) || !isCalendarDate(end)
    || start >= end || Date.parse(end) - Date.parse(start) > 740 * 86_400_000) throw new Error('日历同步日期无效');
  return { startDate: start, endDate: end };
}

// A subscription URL grants access to its calendar; keep it encrypted and out of browser persistence.
export function encryptOutlookConnection(input: OutlookConnectionInput, secret: string): string {
  if (!secret) throw new Error('服务端连接配置缺失');
  const key = new Uint8Array(createHash('sha256').update(`outlook-calendar:v1:${secret}`).digest());
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = new Uint8Array([...cipher.update(JSON.stringify(input), 'utf8'), ...cipher.final()]);
  return [iv, Uint8Array.from(cipher.getAuthTag()), data].map((part) => Buffer.from(part).toString('base64')).join('.');
}

export function decryptOutlookConnection(value: string, secret: string): OutlookConnectionInput {
  if (!secret) throw new Error('服务端连接配置缺失');
  const [iv, tag, data] = value.split('.').map((part) => new Uint8Array(Buffer.from(part, 'base64')));
  const key = new Uint8Array(createHash('sha256').update(`outlook-calendar:v1:${secret}`).digest());
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return parseOutlookInput(JSON.parse(Buffer.from(new Uint8Array([...decipher.update(data), ...decipher.final()])).toString('utf8')));
}

class CalendarReadError extends Error {
  constructor(readonly reason: string, readonly http?: number) { super('订阅链接暂不可用'); }
}

// Fixed categories only: upstream errors and subscription URLs contain secrets.
export function calendarReadFailure(error: unknown) {
  if (error instanceof CalendarReadError) return { reason: error.reason, ...(error.http ? { http: error.http } : {}) };
  if (error instanceof Error) {
    if (['AbortError', 'TimeoutError'].includes(error.name)) return { reason: 'timeout' };
    if (error instanceof TypeError) {
      const safeCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
        'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
      const cause = error.cause as { code?: string; message?: string; errors?: { code?: string }[] } | undefined;
      if (cause?.message === 'unexpected redirect') return { reason: 'redirect' };
      const codes = [cause?.code, ...cause?.errors?.map(item => item.code) ?? []]
        .filter((code): code is string => Boolean(code && safeCodes.has(code)));
      return { reason: 'network', ...(codes.length ? { codes: [...new Set(codes)] } : {}) };
    }
    const reasons: Record<string, string> = {
      '日历内容过大': 'size-limit', '订阅内容不是完整日历': 'invalid-calendar',
      '日历日程过多': 'event-limit', '日历含暂不支持的后续日程变更': 'future-exception',
      '日程时段无效': 'invalid-duration', '日程日期缺失': 'missing-date', '日程时区缺失': 'missing-timezone',
      '全天日程的重复频率无效': 'recurrence-frequency', '日历重复日程过多，请缩小订阅范围': 'recurrence-limit',
    };
    if (reasons[error.message]) return { reason: reasons[error.message] };
  }
  return { reason: 'parse' };
}

export async function fetchCalendar(url: string): Promise<string> {
  const response = await fetch(validateOutlookUrl(url), {
    redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'text/calendar' },
  });
  if (!response.ok || !response.body) throw new CalendarReadError('http', response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4_000_000) throw new Error('日历内容过大');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;
function dayOf(time: IcalTime): string {
  return `${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}
function isCancelled(event: IcalEvent) {
  return String(event.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED';
}
function isAllDay(event: IcalEvent) {
  return event.startDate?.isDate || String(event.component.getFirstPropertyValue('x-microsoft-cdo-alldayevent')).toUpperCase() === 'TRUE';
}

type ParseOptions = { includeLocation?: boolean; timezone?: string; includeFree?: boolean; includeTaskLink?: boolean };

function prepareOutlookCalendar(text: string) {
  if (!/^\s*BEGIN:VCALENDAR\r?\n/i.test(text) || !/END:VCALENDAR\s*$/i.test(text)) throw new Error('订阅内容不是完整日历');
  const root = new ICAL.Component(ICAL.parse(text));
  const components = root.getAllSubcomponents('vevent');
  if (components.length > 10_000) throw new Error('日历日程过多');
  const events = components.map((component) => new ICAL.Event(component, { exceptions: [] }));
  const exceptions = new Map<string, Map<string, IcalEvent>>();
  for (const event of events) {
    if (!event.isRecurrenceException()) continue;
    if (event.modifiesFuture()) throw new Error('日历含暂不支持的后续日程变更');
    const map = exceptions.get(event.uid) ?? new Map<string, IcalEvent>();
    map.set(event.recurrenceId.toString(), event);
    exceptions.set(event.uid, map);
  }
  const cancelledSeries = new Set(events.filter((event) => !event.isRecurrenceException() && isCancelled(event)).map((event) => event.uid));
  return { events, exceptions, cancelledSeries };
}

export function parseOutlookCalendar(text: string, calendar: OutlookCalendarKind, startDate: string, endDate: string, includeUid = false, includeTimed = false,
  options?: ParseOptions): OutlookDayEvent[] {
  return expandOutlookCalendar(prepareOutlookCalendar(text), calendar, startDate, endDate, includeUid, includeTimed, options);
}

function expandOutlookCalendar(parsed: ReturnType<typeof prepareOutlookCalendar>, calendar: OutlookCalendarKind,
  startDate: string, endDate: string, includeUid: boolean, includeTimed: boolean, options?: ParseOptions): OutlookDayEvent[] {
  const { events, exceptions, cancelledSeries } = parsed;
  const result: OutlookDayEvent[] = [];
  let rangeStart: string | undefined, rangeEnd: string | undefined;
  const instant = (time: IcalTime, event: IcalEvent, property: string) => {
    const zone = event.component.getFirstProperty(property)?.getParameter('tzid')
      ?? event.component.getFirstProperty('dtstart')?.getParameter('tzid');
    const aliases: Record<string, string> = { 'China Standard Time': 'Asia/Shanghai', 'Pacific Standard Time': 'America/Los_Angeles',
      'Eastern Standard Time': 'America/New_York', 'GMT Standard Time': 'Europe/London' };
    if (zone && aliases[String(zone)]) return wallTimeInstant(time.toString(), aliases[String(zone)]);
    if (time.zone.tzid !== 'floating') return time.toJSDate().toISOString();
    if (options?.timezone) {
      const timezone = zone ? aliases[String(zone)] ?? String(zone) : options.timezone;
      return wallTimeInstant(time.toString(), timezone);
    }
    // Unqualified local times use the account's Shanghai planning timezone.
    // Outlook normally includes VTIMEZONE; never silently interpret an unknown TZID as UTC.
    if (zone && !['China Standard Time', 'Asia/Shanghai', 'Asia/Chongqing'].includes(String(zone))) {
      throw new Error('日程时区缺失');
    }
    return new Date(`${time.toString()}+08:00`).toISOString();
  };
  const append = (event: IcalEvent, start: IcalTime, end: IcalTime, recurrenceId?: string) => {
    if (isCancelled(event)) return;
    const location = options?.includeLocation ? { location: String(event.component.getFirstPropertyValue('location') || '').slice(0, 500) } : {};
    const link = options?.includeTaskLink ? `${event.component.getFirstPropertyValue('description') || ''} ${event.component.getFirstPropertyValue('url') || ''}`
      .match(/https:\/\/(?:www\.)?(?:ticktick\.com|dida365\.com)\/webapp\/#p\/([\w-]+)\/tasks\/([\w-]+)/i) : null;
    const taskLink = link ? { taskLink: { projectId: link[1], taskId: link[2] } } : {};
    if (!isAllDay(event)) {
      if (!includeTimed || (!options?.includeFree && (String(event.component.getFirstPropertyValue('transp')).toUpperCase() === 'TRANSPARENT'
        || String(event.component.getFirstPropertyValue('x-microsoft-cdo-busystatus')).toUpperCase() === 'FREE'))) return;
      const from = instant(start, event, 'dtstart'), to = instant(end, event, 'dtend');
      if (to <= from) throw new Error('日程时段无效');
      rangeStart ??= options?.timezone ? wallTimeInstant(`${startDate}T00:00:00`, options.timezone) : new Date(`${startDate}T00:00:00+08:00`).toISOString();
      rangeEnd ??= options?.timezone ? wallTimeInstant(`${endDate}T00:00:00`, options.timezone) : new Date(`${endDate}T00:00:00+08:00`).toISOString();
      if (from < rangeEnd && to > rangeStart) {
        result.push({ calendar, title: event.summary || '', startDate: from, endDate: to, allDay: false,
          ...location, ...taskLink, ...(includeUid ? { uid: event.uid, ...((recurrenceId || event.isRecurrenceException()) ? { recurrenceId: recurrenceId || event.recurrenceId.toString() } : {}) } : {}) });
      }
      return;
    }
    const from = dayOf(start);
    const to = dayOf(end);
    if (from < endDate && to > startDate) result.push({ calendar, title: event.summary || '', startDate: from, endDate: to, allDay: true,
      ...location, ...(includeUid ? { uid: event.uid, ...((recurrenceId || event.isRecurrenceException()) ? { recurrenceId: recurrenceId || event.recurrenceId.toString() } : {}) } : {}) });
  };
  let iterations = 0;
  const deadline = Date.now() + 2500;
  for (const event of events) {
    if (cancelledSeries.has(event.uid) || isCancelled(event) || (!includeTimed && !isAllDay(event))) continue;
    if (!event.startDate || !event.endDate) throw new Error('日程日期缺失');
    if (!event.isRecurring() || event.isRecurrenceException()) {
      append(event, event.startDate, event.endDate);
      continue;
    }
    if (Object.keys(event.getRecurrenceTypes()).some((key) => ['SECONDLY', 'MINUTELY', 'HOURLY'].includes(key))) {
      throw new Error('全天日程的重复频率无效');
    }
    const iterator = event.iterator();
    const duration = event.duration;
    for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
      if (++iterations > 30_000 || Date.now() > deadline) throw new Error('日历重复日程过多，请缩小订阅范围');
      // UTC/foreign-zone occurrences can cross a Shanghai date boundary.
      if (dayOf(occurrence) > endDate) break;
      // Detached exceptions are included separately, including ones moved into this window.
      if (exceptions.get(event.uid)?.has(occurrence.toString())) continue;
      const end = occurrence.clone();
      end.addDuration(duration);
      append(event, occurrence, end, occurrence.toString());
    }
  }
  return result;
}

export async function readOutlookSnapshot(input: OutlookConnectionInput, startDate: string, endDate: string,
  availabilityRange?: { startDate: string; endDate: string }, timezone?: string) {
  const sources = input.sources?.length ? input.sources : [
    { name: '玩', url: input.playUrl, kind: 'play' as const },
    { name: '课', url: input.classUrl, kind: 'class' as const },
  ].filter((s) => s.url);
  const events = await Promise.all(sources.map(async ({ name, kind, url }) => {
    try {
      const text = await fetchCalendar(url);
      // Both windows use the same fetched document. Share parsing only within
      // this read; recurrence iterators and range results remain independent.
      const parsed = prepareOutlookCalendar(text);
      return { name, days: expandOutlookCalendar(parsed, kind, startDate, endDate, true, false, { timezone }), timed: availabilityRange
        ? expandOutlookCalendar(parsed, kind, availabilityRange.startDate, availabilityRange.endDate, false, true,
          { timezone, includeFree: true, includeTaskLink: true }).filter((event) => !event.allDay) : [] };
    } catch (error) {
      console.warn('[outlook-calendar-read-failure]', JSON.stringify(calendarReadFailure(error)));
      // Never forward upstream errors: they can contain the private subscription URL.
      throw new Error(`「${name}」日历读取失败，请检查订阅链接与共享范围`);
    }
  }));
  const snapshot = buildOutlookSnapshot(events
    .filter((source) => source.name === '玩' || source.name === '课')
    .flatMap((source) => source.days), startDate, endDate, input.rules, hasRulePolicy() ? activeRuleOrder(currentRulePolicy()) : undefined);
  if (availabilityRange) snapshot.availability = { ...availabilityRange, events: events.flatMap((source) => source.timed)
    .map((event) => ({ title: event.title, start: event.startDate, end: event.endDate,
      ...(event.taskLink ? { taskLink: event.taskLink } : {}) })) };
  return snapshot;
}
