import { kv } from './_accountKv.js';
import { OUTLOOK_CONNECTION_KEY, type OutlookConnection } from './_outlookSync.js';
import { decryptOutlookConnection, readBonCalSourcesEvents } from './_outlookCalendar.js';
import { nextCalendarDate, type OutlookDayEvent } from '../src/utils/outlookCalendar.js';
import { trainingProjectKey, type TrainingCompletion } from '../src/utils/lifeTraining.js';

export const CALENDAR_TRAINING_KEY = 'bonlife:calendar-training:v1';
interface CalendarTrainingSnapshot {
  connectionId: string;
  requestedAt: number;
  syncedAt: string;
  completions: TrainingCompletion[];
}
const day = (date: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);

export function isFinalTrainingRound(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600_000);
  return local.getUTCHours() === 23 && local.getUTCMinutes() >= 1;
}

export function calendarTrainingCompletions(events: OutlookDayEvent[], from: string, now: Date): TrainingCompletion[] {
  const today = day(now);
  const completions = new Map<string, TrainingCompletion>();
  for (const event of events) {
    if (event.cancelled || !event.title.includes('#运动')) continue;
    const project = event.title.replaceAll('#运动', '').trim() || '运动';
    const add = (date: string) => {
      if (date >= from && date <= today) completions.set(`${trainingProjectKey(project)}:${date}`, { project, date });
    };
    if (event.allDay) {
      // All-day records cover each marked day; ICS DTEND is exclusive.
      for (let date = event.startDate < from ? from : event.startDate; date < event.endDate && date <= today; date = nextCalendarDate(date)) add(date);
    } else {
      const start = Date.parse(event.startDate), end = Date.parse(event.endDate);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now.getTime()) continue;
      add(day(new Date(start)));
    }
  }
  return [...completions.values()];
}

export async function readCalendarTrainingCompletions(): Promise<TrainingCompletion[]> {
  const [connection, saved] = await Promise.all([
    kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY), kv.get<CalendarTrainingSnapshot>(CALENDAR_TRAINING_KEY),
  ]);
  return connection && saved?.connectionId !== connection.id ? [] : saved?.completions ?? [];
}

export async function syncCalendarTraining(now = new Date()) {
  const connection = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
  if (!connection) return { connected: false };
  const requestedAt = Date.now();
  try {
    const input = decryptOutlookConnection(connection.encrypted, (process.env.SYNC_SECRET || '').trim());
    const previous = await kv.get<CalendarTrainingSnapshot>(CALENDAR_TRAINING_KEY);
    if (previous && previous.requestedAt > requestedAt) throw new Error('日程已更新');
    const today = day(now);
    const from = day(new Date(now.getTime() - 60 * 86_400_000));
    // Refresh the recent window so edits/cancellations are reflected, while
    // retaining older history. Publish only after every subscription succeeds.
    const imported = (await readBonCalSourcesEvents(input.sources, from, nextCalendarDate(today)))
      .map(source => ({ provider: source.provider, completions: calendarTrainingCompletions(source.events, from, now) }));
    const older = previous?.connectionId === connection.id ? previous.completions.filter(item => item.date < from || imported.some(source => source.provider === 'google')) : [];
    const completions = [...new Map([...older, ...imported.flatMap(source => source.completions)].map(item => [`${trainingProjectKey(item.project)}:${item.date}`, item])).values()];
    const snapshot: CalendarTrainingSnapshot = { connectionId: connection.id, requestedAt, syncedAt: now.toISOString(), completions };
    // Reuse the supported save-periods transaction: connection + snapshot CAS.
    const stored = await kv.eval<(string | number)[], number>(`
    local connection = redis.call('get', KEYS[1])
    if not connection or cjson.decode(connection).id ~= ARGV[1] then return 0 end
    local previous = redis.call('get', KEYS[2])
    if previous and cjson.decode(previous).requestedAt ~= tonumber(ARGV[4]) then return -1 end
    if not previous and tonumber(ARGV[4]) ~= 0 then return -1 end
    redis.call('set', KEYS[2], ARGV[3])
    return 1
  `, [OUTLOOK_CONNECTION_KEY, CALENDAR_TRAINING_KEY], [connection.id, requestedAt, JSON.stringify(snapshot), previous?.requestedAt ?? 0]);
    if (stored !== 1) throw new Error('连接或记录已更新');
    return { connected: true, syncedAt: snapshot.syncedAt };
  } catch {
    throw new Error('运动日程同步失败，已保留历史，请重试');
  }
}
