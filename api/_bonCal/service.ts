import { kv } from '../_accountKv.js';
import { resolveCalendarState, resolveDailyContext, shiftDay } from '../../src/boncal/daily.js';
import { bonCalTrips } from '../../src/boncal/trips.js';
import { BONCAL_CALENDAR_FIELDS, pickFields, type BonCalContext } from '../../src/boncal/state.js';
import { calendarEventOverlaps, type OutlookSnapshot } from '../../src/boncal/events.js';
import { readBonCalView, markBonCalReadFailure, repairBonCalStorage, OUTLOOK_CONNECTION_KEY, saveOutlookSnapshot, type OutlookConnection } from './repository.js';
import { decryptOutlookConnection, parseOutlookRange, readOutlookSnapshot, readBonCalSourcesEvents } from './provider.js';
import { readCalendarLocations } from './locations.js';
import { hasRulePolicy, withRulePolicy } from '../_rulePolicy.js';
import { readSchedulingRules } from '../_schedulingRules.js';

export async function readBonCalContext(startDate: string, endDate: string, options: { refresh?: boolean; repair?: boolean } = {}): Promise<BonCalContext> {
  if (!hasRulePolicy()) return withRulePolicy(await readSchedulingRules(), () => readBonCalContext(startDate, endDate, options));
  parseOutlookRange(startDate, endDate);
  const connection = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
  let snapshot: OutlookSnapshot | undefined, error: string | undefined;
  if (connection && options.refresh) {
    const requestedAt = Date.now();
    try {
      const input = decryptOutlookConnection(connection.encrypted, (process.env.SYNC_SECRET || '').trim());
      snapshot = await readOutlookSnapshot(input, startDate, endDate, { startDate, endDate }, 'Asia/Shanghai');
      await saveOutlookSnapshot(connection, snapshot, input.policy, requestedAt);
    } catch (cause) { error = '日历更新失败，保留已有结果'; await markBonCalReadFailure(connection, cause); }
  }
  if (options.repair) await repairBonCalStorage();
  const input = await readBonCalView();
  const calendar = resolveCalendarState({ config: input.config }, input.calendar);
  const locations = await readCalendarLocations(startDate, shiftDay(endDate, -1), calendar, input);
  const { status, snapshots: saved } = input;
  const snapshots = saved?.connectionId === input.connection?.id ? saved?.snapshots.filter(s => s.startDate < endDate && s.endDate > startDate) ?? [] : [];
  error ??= status?.connectionId === input.connection?.id ? status?.error : undefined;
  return {
    revision: input.revision, startDate, endDate, calendar: { ...pickFields(input.calendar, BONCAL_CALENDAR_FIELDS), tagMap: input.calendar.tagMap }, config: input.config, tripSettings: input.tripSettings,
    days: Object.fromEntries(Object.entries(locations).map(([date, day]) => [date, { ...day, location: day.locations.length === 1 && !day.unresolved?.length ? day.locations[0] : null,
      tag: resolveDailyContext(date, calendar.tagMap[date], { config: input.config, dayOverrides: calendar.dayOverrides, holidayDataByYear: calendar.holidayDataByYear }).tag }])),
    trips: bonCalTrips(calendar, input.tripSettings).filter(trip => trip.startDate < endDate && trip.endDate >= startDate), events: [...new Map(snapshots.flatMap(s => s.events ?? []).filter(event => calendarEventOverlaps(event, startDate, endDate))
      .map(event => [JSON.stringify([event.sourceName, event.uid, event.recurrenceId, event.startDate, event.endDate]), event])).values()],
    availability: snapshots.some(s => s.availability) ? { startDate, endDate, events: [...new Map(snapshots.flatMap(s => s.availability?.events ?? [])
      .filter(event => Date.parse(event.start) < Date.parse(`${endDate}T00:00:00+08:00`) && Date.parse(event.end) > Date.parse(`${startDate}T00:00:00+08:00`))
      .map(event => [JSON.stringify(event), event])).values()] } : undefined,
    sources: [...new Map(snapshots.flatMap(s => s.sources ?? []).map(source => [source.name, source])).values()],
    status: { connected: Boolean(input.connection), stale: Boolean(error), ...(error ? { error } : {}),
      ...(status?.connectionId === input.connection?.id ? { syncedAt: status?.syncedAt } : {}) },
  };
}

/** Raw visible events still pass through the same provider selection as the calendar facts. */
export async function readBonCalEvents(startDate: string, endDate: string, timezone = 'Asia/Shanghai', names?: string[]) {
  const connection = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
  if (!connection) return { connected: false, events: [], fetchedAt: new Date().toISOString() };
  const input = decryptOutlookConnection(connection.encrypted, (process.env.SYNC_SECRET || '').trim());
  const sources = names ? input.sources.filter(source => names.includes(source.name)) : input.sources;
  const results = await readBonCalSourcesEvents(sources, startDate, endDate, { timezone });
  return { connected: true, events: results.flatMap(result => result.events), fetchedAt: new Date().toISOString() };
}

export async function readBonCalSchedulingState(calendarOverride?: unknown, configOverride?: unknown, from?: string, view?: Awaited<ReturnType<typeof readBonCalView>>) {
  const inputs = view ?? await readBonCalView();
  const calendar = resolveCalendarState(configOverride ?? { config: inputs.config }, calendarOverride ?? inputs.calendar);
  const today = from ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const dates = Object.keys(calendar.tagMap).filter(date => date >= today).sort();
  const end = dates.at(-1) ?? today;
  const locations = await readCalendarLocations(today, end, calendar, inputs);
  const cityMap = { ...calendar.cityMap };
  const dayOverrides = { ...calendar.dayOverrides };
  for (const [date, day] of Object.entries(locations)) {
    // A gap in the saved/derived calendar is not evidence for a new schedulable date.
    if (!Object.hasOwn(calendar.tagMap, date) && !Object.hasOwn(dayOverrides, date)) continue;
    if (day.error) throw new Error('地点读取失败，保留原安排');
    cityMap[date] = day.locations.length === 1 && !day.unresolved?.length ? day.locations[0] : null;
    // The resolved city already incorporates all explicit overrides, in the shared order.
    if (dayOverrides[date]?.city) { const { city: _city, ...rest } = dayOverrides[date]; dayOverrides[date] = rest; }
  }
  return { ...calendar, cityMap, dayOverrides, bonCalRevision: inputs.revision, bonCalLocations: locations };
}
