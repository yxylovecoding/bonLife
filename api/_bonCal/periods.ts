import ICAL from 'ical.js';
import { parseOutlookCalendar, decryptOutlookConnection, readBonCalSourceEvents } from './provider.js';
import { isPeriodCalendarTitle, calendarEventOverlaps, type OutlookDayEvent } from '../../src/boncal/events.js';

export function parsePeriodCalendar(text: string, year: number) {
  const events = parseOutlookCalendar(text, 'calendar', `${year - 1}-11-01`, `${year + 1}-01-01`, true, true,
    { timezone: 'Asia/Shanghai', includeFree: true });
  const root = new ICAL.Component(ICAL.parse(text));
  const seenUids = root.getAllSubcomponents('vevent').map((event) => String(event.getFirstPropertyValue('uid') || '')).filter(Boolean);
  return periodProjection(events, seenUids);
}

export function periodProjection(events: OutlookDayEvent[], seenUids: string[]) {
  const localDay = (instant: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(instant));
  return { seenUids, events: events.filter((event) => isPeriodCalendarTitle(event.title)).map((event) => {
    if (!event.uid) throw new Error('日程标识缺失');
    if (event.allDay) return { uid: event.uid, startDate: event.startDate, endDate: event.endDate };
    // Store every Shanghai date touched by a timed event using the same
    // exclusive-end convention as all-day records. Midnight is not an extra day.
    const startDate = localDay(Date.parse(event.startDate));
    const lastDate = localDay(Date.parse(event.endDate) - 1);
    const endDate = new Date(Date.parse(`${lastDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return { uid: event.uid, startDate, endDate };
  }) };
}

export async function readBonCalPeriods(connection: { encrypted: string }, years: number[]) {
  const input = decryptOutlookConnection(connection.encrypted, (process.env.SYNC_SECRET || '').trim());
  const source = { name: '日历', url: input.playUrl, kind: 'calendar' as const };
  const from = `${Math.min(...years) - 1}-11-01`, until = `${Math.max(...years) + 1}-01-01`;
  const result = await readBonCalSourceEvents(source, from, until);
  return years.map(year => ({ ...periodProjection(result.events.filter(event => calendarEventOverlaps(event, `${year - 1}-11-01`, `${year + 1}-01-01`)), result.seenUids), provider: result.provider }));
}
