import { createHash } from 'node:crypto';
import { kv } from './_accountKv.js';
import { OUTLOOK_CONNECTION_KEY, type OutlookConnection } from './_outlookSync.js';
import { decryptOutlookConnection, readBonCalSourcesEvents } from './_bonCal/provider.js';
import type { DoneItem } from '../src/utils/bonLife.js';
import { classifyDoneCategory } from '../src/utils/lifeDone.js';
import { nextCalendarDate, type OutlookDayEvent } from '../src/utils/outlookCalendar.js';

export const outlookDoneKey = (month: string) => `bonlife:done-outlook:v1:${month}`;
interface OutlookDoneSnapshot { connectionId: string; requestedAt: number; syncedAt: string; items: DoneItem[] }
const day = (time: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(time));

export function outlookDoneItems(events: OutlookDayEvent[], month: string, calendarName: string, connectionId: string, now = new Date()): DoneItem[] {
  const items = new Map<string, DoneItem>();
  const from = `${month}-01`;
  const [year, number] = month.split('-').map(Number);
  const until = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10);
  for (const event of events) {
    const start = Date.parse(event.startDate), end = Date.parse(event.endDate);
    if (event.allDay || event.cancelled || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now.getTime()) continue;
    const namedCategory = classifyDoneCategory([], calendarName);
    const category = namedCategory !== '未分类' ? namedCategory : event.calendar === 'class' ? '课' : event.calendar === 'play' ? '玩' : '活';
    for (let date = day(start) < from ? from : day(start); date < until && Date.parse(`${date}T00:00:00+08:00`) < end; date = nextCalendarDate(date)) {
      const segmentStart = Math.max(start, Date.parse(`${date}T00:00:00+08:00`));
      const segmentEnd = Math.min(end, Date.parse(`${nextCalendarDate(date)}T00:00:00+08:00`));
      if (segmentEnd <= segmentStart) continue;
      const id = `outlook:${createHash('sha256').update(JSON.stringify([connectionId, event.uid || event.title, event.startDate, date])).digest('hex')}`;
      items.set(id, { id, source: 'outlook', taskId: event.uid || id, projectId: 'outlook', projectName: calendarName,
        title: event.title || '无标题日程', category, date, startedAt: new Date(segmentStart).toISOString(), completedAt: new Date(segmentEnd).toISOString(),
        durationMinutes: (segmentEnd - segmentStart) / 60_000, durationBasis: 'outlook',
        ...(event.taskLink ? { linkedTaskId: event.taskLink.taskId, linkedProjectId: event.taskLink.projectId } : {}) });
    }
  }
  return [...items.values()];
}

export async function readOutlookDoneMonth(month: string) {
  const [connection, saved] = await Promise.all([
    kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY), kv.get<OutlookDoneSnapshot>(outlookDoneKey(month)),
  ]);
  const snapshot = connection && saved?.connectionId !== connection.id ? null : saved;
  return { items: snapshot?.items ?? [], outlookConnected: Boolean(connection), outlookSyncedAt: snapshot?.syncedAt ?? null };
}

export async function syncOutlookDoneMonth(month: string, now = new Date()) {
  if (month > day(now.getTime()).slice(0, 7)) return;
  const connection = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
  if (!connection) return;
  const requestedAt = Date.now();
  try {
    const input = decryptOutlookConnection(connection.encrypted, (process.env.SYNC_SECRET || '').trim());
    const [year, number] = month.split('-').map(Number);
    const from = `${month}-01`, until = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10);
    const sources = await readBonCalSourcesEvents(input.sources, from, until);
    const backup = sources.some(source => source.provider === 'google');
    const fresh = sources.flatMap(source => outlookDoneItems(source.events, month, source.name, connection.id, now));
    const previous = backup ? await kv.get<OutlookDoneSnapshot>(outlookDoneKey(month)) : null;
    const items = [...new Map([...(previous?.connectionId === connection.id ? previous.items : []), ...fresh].map(item => [item.id, item])).values()];
    const snapshot: OutlookDoneSnapshot = { connectionId: connection.id, requestedAt, syncedAt: now.toISOString(), items };
    // Replace a complete month only after every calendar succeeds, so edits and
    // cancellations are reflected without saving a partial response or stale connection.
    const stored = await kv.eval<string[], number>(`
      local connection = redis.call('get', KEYS[1])
      if not connection or cjson.decode(connection).id ~= ARGV[1] then return 0 end
      local previous = redis.call('get', KEYS[2])
      if previous and cjson.decode(previous).requestedAt > tonumber(ARGV[2]) then return 0 end
      redis.call('set', KEYS[2], ARGV[3])
      return 1
    `, [OUTLOOK_CONNECTION_KEY, outlookDoneKey(month)], [connection.id, String(requestedAt), JSON.stringify(snapshot)]);
    if (stored !== 1) throw new Error('连接或记录已更新');
  } catch {
    throw new Error('Outlook 日程同步失败，已保留历史，请重试');
  }
}
