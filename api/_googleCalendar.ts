import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { kv } from './_accountKv.js';
import type { OutlookSource } from './_outlookCalendar.js';
import { isCalendarDate, type OutlookDayEvent } from '../src/utils/outlookCalendar.js';

export const GOOGLE_CALENDAR_KEY = 'google:calendar-fallback:v1';
export const GOOGLE_CALENDAR_STATUS_KEY = 'google:calendar-read-status:v1';
const PROTOCOL = 'bonlife-google-calendar-v1';
interface Credentials { url: string; secret: string }
interface Connection { id: string; encrypted: string; sources: Record<string, { name: string; calendarId: string }> }
interface GoogleEvent {
  id: string; uid: string; title: string; start: string; end: string; allDay: boolean;
  recurrenceId?: string; location?: string; taskLink?: { projectId: string; taskId: string };
}
interface Calendar { id: string; name: string; events: GoogleEvent[] }
const fingerprint = (url: string) => createHash('sha256').update(url).digest('hex');

export function validateGoogleRelayUrl(value: unknown) {
  try {
    if (typeof value !== 'string' || value.length > 500) throw new Error();
    const url = new URL(value.trim());
    if (url.origin !== 'https://script.google.com' || url.username || url.password || url.search || url.hash
      || !/^\/macros\/s\/[A-Za-z0-9_-]{20,200}\/exec$/.test(url.pathname)) throw new Error();
    return url.href;
  } catch { throw new Error('Google 连接地址无效'); }
}
function seal(input: Credentials) {
  const secret = process.env.SYNC_SECRET?.trim();
  if (!secret) throw new Error('服务端连接配置缺失');
  const key = createHash('sha256').update(`google-calendar:v1:${secret}`).digest();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(input)), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(value => value.toString('base64')).join('.');
}
function unseal(value: string): Credentials {
  const key = createHash('sha256').update(`google-calendar:v1:${process.env.SYNC_SECRET?.trim()}`).digest();
  const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
}
async function responseJson(response: Response) {
  if (!response.ok || !response.body) throw new Error('Google 备用日历读取失败');
  const reader = response.body.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 4_000_000) throw new Error('Google 日历内容过大');
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => undefined); }
}
async function readRelay(credentials: Credentials, startDate: string, endDate: string): Promise<Calendar[]> {
  const requestId = randomUUID(), signal = AbortSignal.timeout(45_000);
  let response = await fetch(validateGoogleRelayUrl(credentials.url), {
    method: 'POST', redirect: 'manual', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: PROTOCOL, secret: credentials.secret, requestId, startDate, endDate }),
  });
  // Apps Script ContentService returns a one-use Google-hosted document. Never
  // forward credentials, POST bodies or redirects to any other host.
  if ([302, 303].includes(response.status)) {
    const target = new URL(response.headers.get('location') || '');
    await response.body?.cancel();
    if (target.origin !== 'https://script.googleusercontent.com' || target.username || target.password
      || target.pathname !== '/macros/echo' || target.hash) throw new Error('Google 备用日历读取失败');
    response = await fetch(target.href, { redirect: 'error', signal });
  }
  const data = await responseJson(response);
  const age = Date.now() - Date.parse(data.fetchedAt);
  if (data.protocol !== PROTOCOL || data.requestId !== requestId || data.startDate !== startDate || data.endDate !== endDate
    || data.complete !== true || !Number.isFinite(age) || age < -60_000 || age > 120_000
    || !Array.isArray(data.calendars) || data.calendars.length < 1 || data.calendars.length > 20) throw new Error('Google 日历结果不完整');
  const names = new Set<string>(), ids = new Set<string>();
  for (const calendar of data.calendars) {
    if (!calendar || typeof calendar.id !== 'string' || !calendar.id || typeof calendar.name !== 'string'
      || !calendar.name || names.has(calendar.name) || ids.has(calendar.id) || !Array.isArray(calendar.events)
      || calendar.events.length > 10_000) throw new Error('Google 日历结果不完整');
    names.add(calendar.name); ids.add(calendar.id);
    for (const event of calendar.events) {
      const dateOk = event?.allDay === true ? isCalendarDate(event.start) && isCalendarDate(event.end)
        : event?.allDay === false && [event.start, event.end].every(value => typeof value === 'string'
          && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
      if (!dateOk || Date.parse(event.end) <= Date.parse(event.start) || typeof event.id !== 'string' || !event.id
        || typeof event.uid !== 'string' || !event.uid || typeof event.title !== 'string' || event.title.length > 2000)
        throw new Error('Google 日历结果不完整');
    }
  }
  return data.calendars;
}
export async function connectGoogleCalendar(url: unknown, secret: unknown, sources: OutlookSource[]) {
  if (!sources.length) throw new Error('请先连接 Outlook 订阅');
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,200}$/.test(secret)) throw new Error('Google 连接密钥无效');
  const credentials = { url: validateGoogleRelayUrl(url), secret };
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const end = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const calendars = await readRelay(credentials, today, end);
  const mapping: Connection['sources'] = {};
  for (const source of sources) {
    const calendar = calendars.find(item => item.name === source.name);
    if (!calendar) throw new Error(`Google 缺少「${source.name}」日历`);
    if (mapping[fingerprint(source.url)]) throw new Error('Google 原日历映射重复');
    mapping[fingerprint(source.url)] = { name: source.name, calendarId: calendar.id };
  }
  const connection: Connection = { id: randomUUID(), encrypted: seal(credentials), sources: mapping };
  await kv.set(GOOGLE_CALENDAR_KEY, connection);
  await kv.del(GOOGLE_CALENDAR_STATUS_KEY);
  return googleCalendarStatus();
}
export async function googleCalendarStatus() {
  const [connection, status] = await Promise.all([kv.get<Connection>(GOOGLE_CALENDAR_KEY),
    kv.get<{ connectionId: string; syncedAt?: string; error?: string }>(GOOGLE_CALENDAR_STATUS_KEY)]);
  return { connected: Boolean(connection), sources: Object.values(connection?.sources ?? {}).map(source => source.name),
    ...(connection && status?.connectionId === connection.id ? { syncedAt: status.syncedAt, error: status.error } : {}) };
}
export async function disconnectGoogleCalendar() {
  await kv.del(GOOGLE_CALENDAR_KEY, GOOGLE_CALENDAR_STATUS_KEY);
}
export async function readGoogleCalendarSources(sources: OutlookSource[], startDate: string, endDate: string) {
  const connection = await kv.get<Connection>(GOOGLE_CALENDAR_KEY);
  if (!connection) return null;
  try {
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate >= endDate
      || Date.parse(endDate) - Date.parse(startDate) > 1500 * 86400000) throw new Error();
    const mapping = sources.map(source => connection.sources[fingerprint(source.url)]);
    if (mapping.some((item, index) => !item || item.name !== sources[index].name)) throw new Error();
    const calendars = await readRelay(unseal(connection.encrypted), startDate, endDate);
    const result = sources.map((source, index) => {
      const calendar = calendars.find(item => item.id === mapping[index].calendarId && item.name === mapping[index].name);
      if (!calendar) throw new Error();
      return { name: source.name, events: calendar.events.map((event): OutlookDayEvent => ({
        calendar: source.kind, title: event.title, uid: event.uid, allDay: event.allDay,
        startDate: event.allDay ? event.start : new Date(event.start).toISOString(),
        endDate: event.allDay ? event.end : new Date(event.end).toISOString(),
        ...(typeof event.recurrenceId === 'string' && event.recurrenceId.length < 100 ? { recurrenceId: event.recurrenceId } : {}),
        ...(typeof event.location === 'string' ? { location: event.location.slice(0, 500) } : {}),
        ...(event.taskLink && /^[\w-]+$/.test(event.taskLink.projectId) && /^[\w-]+$/.test(event.taskLink.taskId)
          ? { taskLink: { projectId: event.taskLink.projectId, taskId: event.taskLink.taskId } } : {}),
      })) };
    });
    if ((await kv.get<Connection>(GOOGLE_CALENDAR_KEY))?.id !== connection.id) throw new Error();
    await kv.set(GOOGLE_CALENDAR_STATUS_KEY, { connectionId: connection.id, syncedAt: new Date().toISOString() });
    return result;
  } catch {
    await kv.set(GOOGLE_CALENDAR_STATUS_KEY, { connectionId: connection.id, error: 'Google 备用日历读取失败' });
    throw new Error('Google 备用日历读取失败');
  }
}
