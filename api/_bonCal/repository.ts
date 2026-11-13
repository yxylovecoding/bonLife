import { createHash, randomUUID } from 'node:crypto';
import { kv } from '../_accountKv.js';
import { applyOutlookSnapshotToState, calendarEventOverlaps, repairCalendarState, sanitizeOutlookSnapshot, cleanTravelTitle, normalizeOutlookWishEvents, isCalendarDate, type OutlookConflictPolicy, type OutlookSnapshot } from '../../src/boncal/events.js';
import { BONCAL_CALENDAR_FIELDS, BONCAL_CONFIG_FIELDS, BONCAL_EDIT_FIELDS, BONCAL_TRIP_FIELDS, calendarConfig, pickFields } from '../../src/boncal/state.js';
import { normalizeDayOverrides } from '../../src/boncal/daily.js';
import { repairReminderWishes } from '../../src/boncal/repair.js';
import type { WishItem } from '../../src/models/types.js';
import { decryptOutlookConnection, readOutlookSnapshot } from '../_outlookCalendar.js';

export const OUTLOOK_CONNECTION_KEY = 'outlook:calendar-connection:v1';
export const OUTLOOK_READ_STATUS_KEY = 'outlook:calendar-read-status:v1';
const SNAPSHOTS_KEY = 'outlook:calendar-snapshots:v1';
const CALENDAR_KEY = 'calendar-tags';
const WRITE_LOCK_KEY = 'outlook:calendar-write:lock';
export interface OutlookConnection { id: string; encrypted: string }
interface SavedSnapshots {
  connectionId: string;
  requestedAt: number;
  policy: OutlookConflictPolicy;
  snapshots: OutlookSnapshot[];
}

// Network fetches happen before this short lock. All calendar writers share it.
export async function withCalendarWriteLock<T>(write: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await kv.set(WRITE_LOCK_KEY, token, { nx: true, ex: 30 })) {
      try { return await write(); }
      finally {
        await kv.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", [WRITE_LOCK_KEY], [token]);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('日历正在同步，请稍后重试');
}

function asCalendarState(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sliceSnapshot(snapshot: OutlookSnapshot, startDate: string, endDate: string): OutlookSnapshot {
  const inRange = ([day]: [string, unknown]) => day >= startDate && day < endDate;
  return { ...snapshot, startDate, endDate, ruleCandidates: Object.fromEntries(Object.entries(snapshot.ruleCandidates ?? {}).filter(inRange)), tags: Object.fromEntries(Object.entries(snapshot.tags).filter(inRange)),
    travelTitles: Object.fromEntries(Object.entries(snapshot.travelTitles ?? {}).filter(inRange)),
    wishEvents: snapshot.wishEvents?.filter(event => event.startDate < endDate && event.endDate > startDate),
    events: snapshot.events?.filter(event => calendarEventOverlaps(event, startDate, endDate)) };
}

// Keep non-overlapping windows: a fresh monthly read also replaces that month in a daily snapshot.
function replaceSnapshotWindow(previous: OutlookSnapshot[], next: OutlookSnapshot): OutlookSnapshot[] {
  const snapshots: OutlookSnapshot[] = [];
  for (const snapshot of previous) {
    if (snapshot.endDate <= next.startDate || snapshot.startDate >= next.endDate) snapshots.push(snapshot);
    else {
      if (snapshot.startDate < next.startDate) snapshots.push(sliceSnapshot(snapshot, snapshot.startDate, next.startDate));
      if (snapshot.endDate > next.endDate) snapshots.push(sliceSnapshot(snapshot, next.endDate, snapshot.endDate));
    }
  }
  const merged: OutlookSnapshot[] = [];
  for (const snapshot of [...snapshots, next].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const last = merged.at(-1);
    if (last && JSON.stringify(last.ruleOrder) === JSON.stringify(snapshot.ruleOrder) && last.endDate === snapshot.startDate && Date.parse(snapshot.endDate) - Date.parse(last.startDate) <= 740 * 86_400_000) {
      merged[merged.length - 1] = { startDate: last.startDate, endDate: snapshot.endDate,
        ruleOrder: snapshot.ruleOrder, ruleCandidates: { ...last.ruleCandidates, ...snapshot.ruleCandidates }, tags: { ...last.tags, ...snapshot.tags }, travelTitles: { ...last.travelTitles, ...snapshot.travelTitles },
        wishEvents: [...last.wishEvents ?? [], ...snapshot.wishEvents ?? []], events: [...last.events ?? [], ...snapshot.events ?? []],
        sources: [...new Map([...last.sources ?? [], ...snapshot.sources ?? []].map(source => [source.name, source])).values()],
        availability: snapshot.availability ?? last.availability };
    } else merged.push(snapshot);
  }
  return merged;
}

export async function saveOutlookSnapshot(connection: OutlookConnection, snapshot: OutlookSnapshot, policy: OutlookConflictPolicy, requestedAt: number, replaceConnection = false) {
  return withCalendarWriteLock(async () => {
    const [latest, saved, current] = await Promise.all([
      kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY), kv.get<SavedSnapshots>(SNAPSHOTS_KEY), kv.get(CALENDAR_KEY),
    ]);
    if (!replaceConnection && latest?.id !== connection.id) throw new Error('连接已变更，请重新同步');
    const previous = saved?.connectionId === connection.id ? saved : null;
    if (previous && requestedAt < previous.requestedAt) throw new Error('日历已更新，请重新同步');
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const calendar = applyOutlookSnapshotToState(asCalendarState(current), snapshot, policy, today);
    // Include retained history in the replay cache, so an old browser upload cannot erase it.
    const archived: OutlookSnapshot = { ...snapshot, tags: { ...snapshot.tags }, travelTitles: { ...snapshot.travelTitles } };
    for (const [day, applied] of Object.entries(calendar.outlookApplied)) {
      if (day < today && day >= snapshot.startDate && day < snapshot.endDate
        && !snapshot.tags[day] && calendar.tagMap[day] === applied.tag) {
        archived.tags[day] = applied.tag;
        if (calendar.outlookTravelTitles[day]) archived.travelTitles![day] = calendar.outlookTravelTitles[day];
      }
    }
    const snapshots: SavedSnapshots = { connectionId: connection.id, requestedAt, policy,
      snapshots: replaceSnapshotWindow(previous?.snapshots ?? [], archived) };
    // Publish the calendar and cache together; uploads can never see only half of this update.
    await kv.mset({ [CALENDAR_KEY]: calendar, [SNAPSHOTS_KEY]: snapshots, 'boncal:source-version:v1': randomUUID(),
      [OUTLOOK_READ_STATUS_KEY]: { connectionId: connection.id, syncedAt: new Date(requestedAt).toISOString(), sources: snapshot.sources, ...(snapshot.provider ? { provider: snapshot.provider } : {}) },
      ...(replaceConnection ? { [OUTLOOK_CONNECTION_KEY]: connection } : {}) });
    return calendar;
  });
}

export async function disconnectOutlookCalendar() {
  return withCalendarWriteLock(() => kv.del(OUTLOOK_CONNECTION_KEY, SNAPSHOTS_KEY, OUTLOOK_READ_STATUS_KEY));
}

export async function markBonCalReadFailure(connection: OutlookConnection, error: unknown) {
  await withCalendarWriteLock(async () => {
    if ((await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY))?.id !== connection.id) return;
    await kv.set(OUTLOOK_READ_STATUS_KEY, { connectionId: connection.id, error: outlookSyncError(error) });
  });
}

/** Legacy adapter: an unversioned upload can only update business fields. */
export async function saveUploadedCalendarState(value: unknown) {
  return (await saveBonCalUpload({ 'calendar-tags': value })).calendar;
}

export async function readBonCalInputs() {
  const [rawCalendar, rawConfig, rawTrips, locationVersion, sourceVersion] = await Promise.all([
    kv.get<Record<string, unknown>>(CALENDAR_KEY), kv.get<{ config?: Record<string, unknown> }>('app-config'),
    kv.get<Record<string, unknown>>('trip-tags'), kv.get('boncal:location-version:v1'), kv.get('boncal:source-version:v1'),
  ]);
  const calendar = repairCalendarState(rawCalendar ?? {});
  const config = calendarConfig(rawConfig?.config ?? {}), tripSettings = pickFields(rawTrips, BONCAL_TRIP_FIELDS);
  const revision = createHash('sha256').update(JSON.stringify([pickFields(calendar, BONCAL_CALENDAR_FIELDS), config, tripSettings, locationVersion, sourceVersion])).digest('hex');
  return { calendar, config, tripSettings, revision, rawConfig: rawConfig ?? {}, rawCalendar: rawCalendar ?? {}, rawTrips: rawTrips ?? {} };
}

/** Capture public inputs and location adapters together; release before geocoding/network I/O. */
export async function readBonCalView() {
  const seed = await readBonCalInputs();
  const years = new Set<number>();
  for (const period of seed.config.internshipPeriods ?? []) {
    if (period.rules?.workweek !== 'statutory') continue;
    const start = Number(period.startDate?.slice(0, 4)), end = Number(period.endDate?.slice(0, 4));
    if (start >= 2000 && end <= 2100 && end - start <= 10) for (let year = start; year <= end; year++) years.add(year);
  }
  if (years.size) {
    const { readHolidayYear } = await import('./holidays.js');
    const fetched = await Promise.all([...years].map(async year => [year, await readHolidayYear(year).catch(() => null)] as const));
    await withCalendarWriteLock(async () => {
      const current = await readBonCalInputs();
      const holidayDataByYear = { ...current.calendar.holidayDataByYear as Record<string, unknown> };
      for (const [year, data] of fetched) if (data) holidayDataByYear[year] = data;
      if (JSON.stringify(holidayDataByYear) !== JSON.stringify(current.calendar.holidayDataByYear ?? {})) {
        await kv.set(CALENDAR_KEY, { ...current.calendar, holidayDataByYear });
      }
    });
  }
  return withCalendarWriteLock(async () => {
    const [inputs, contexts, plans, connection, snapshots, status] = await Promise.all([
      readBonCalInputs(), kv.hgetall<Record<string, import('../../src/clothes/types.js').ClothesDayContext>>('bonclothes:contexts:v1'),
      kv.hgetall<Record<string, import('../../src/clothes/types.js').ClothesTripPlan>>('bonclothes:trip-plans:v1'),
      kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY), kv.get<SavedSnapshots>(SNAPSHOTS_KEY),
      kv.get<{ connectionId: string; syncedAt?: string; error?: string }>(OUTLOOK_READ_STATUS_KEY),
    ]);
    return { ...inputs, contexts, plans, connection, snapshots, status };
  });
}

/** Existing clothes record revisions still guard edits; bonCal owns their shared location fields. */
export async function saveBonCalLocationRecord<T extends [number, unknown]>(write: () => Promise<T>) {
  return withCalendarWriteLock(async () => {
    const result = await write();
    if (result[0] === 1) await kv.set('boncal:location-version:v1', randomUUID());
    return result;
  });
}

export class BonCalConflict extends Error { constructor() { super('日历已更新，请刷新后保存'); } }

/** Called by both the calendar command API and the legacy sync adapter, under one lock. */
export async function saveBonCalUpload(body: Record<string, unknown>, revision?: string) {
  return withCalendarWriteLock(async () => {
    const current = await readBonCalInputs();
    const changesCalendar = Object.entries(pickFields(body['calendar-tags'], BONCAL_EDIT_FIELDS))
      .some(([key, value]) => JSON.stringify(value) !== JSON.stringify((current.calendar as Record<string, unknown>)[key]));
    const changesTrips = body['trip-tags'] && JSON.stringify(pickFields(body['trip-tags'], BONCAL_TRIP_FIELDS)) !== JSON.stringify(current.tripSettings);
    const uploadedConfig = (body['app-config'] as { config?: Record<string, unknown> } | undefined)?.config;
    const changesConfig = uploadedConfig && JSON.stringify(calendarConfig(uploadedConfig)) !== JSON.stringify(current.config);
    if (revision && revision !== current.revision && (changesCalendar || changesTrips || changesConfig)) throw new BonCalConflict();
    const writes: Record<string, unknown> = {};
    if (body['calendar-tags']) {
      const incoming = asCalendarState(body['calendar-tags']);
      const business = pickFields(incoming, ['confirmedExpenses']);
      let calendar = { ...current.calendar, ...business };
      if (revision) {
        const edits = pickFields(incoming, BONCAL_EDIT_FIELDS);
        const tags = asCalendarState(edits.tagMap);
        if (Object.entries(tags).some(([date, tag]) => !isCalendarDate(date) || !['school', 'intern', 'home', 'travel'].includes(String(tag)))) throw new Error('日历标记无效');
        calendar = repairCalendarState({ ...calendar, ...edits,
          ...(Object.hasOwn(edits, 'dayOverrides') ? { dayOverrides: normalizeDayOverrides(edits.dayOverrides) } : {}) });
      }
      writes[CALENDAR_KEY] = calendar;
    }
    if (body['trip-tags'] && revision) writes['trip-tags'] = pickFields(body['trip-tags'], BONCAL_TRIP_FIELDS);
    if (uploadedConfig) {
      const publicFields = revision ? calendarConfig(uploadedConfig) : current.config;
      const business = Object.fromEntries(Object.entries(uploadedConfig).filter(([key]) => !BONCAL_CONFIG_FIELDS.includes(key as never)));
      if (Array.isArray(business.wishes)) business.wishes = repairReminderWishes(business.wishes as WishItem[]);
      writes['app-config'] = { ...current.rawConfig, ...(body['app-config'] as object), config: { ...business, ...publicFields } };
    }
    if (Object.keys(writes).length) await kv.mset(writes);
    return readBonCalInputs();
  });
}

/** An idempotent, account-scoped repair; original data is retained for recovery. */
export async function repairBonCalStorage() {
  return withCalendarWriteLock(async () => {
    const marker = 'boncal:repair:reminders:v1';
    const current = await readBonCalInputs();
    const saved = await kv.get<SavedSnapshots>(SNAPSHOTS_KEY);
    const config = current.rawConfig.config;
    const nextConfig = config && Array.isArray(config.wishes) ? { ...current.rawConfig, config: { ...config, wishes: repairReminderWishes(config.wishes as WishItem[]) } } : current.rawConfig;
    const snapshots = saved && { ...saved, snapshots: saved.snapshots.map(sanitizeOutlookSnapshot) };
    // Older calendar stores may lack titles although their archived snapshots
    // still positively identify the birthday contribution.
    const evidenceTitles = { ...current.calendar.outlookTravelTitles };
    for (const snapshot of saved?.snapshots ?? []) {
      const fixed = sanitizeOutlookSnapshot(snapshot);
      for (const [day, tag] of Object.entries(snapshot.tags)) {
        if (tag !== 'travel' || fixed.tags[day] === 'travel' || evidenceTitles[day]) continue;
        const title = snapshot.travelTitles?.[day] || snapshot.events?.filter(event => event.allDay
          && event.startDate <= day && event.endDate > day).map(event => event.title).join('、');
        if (title && !cleanTravelTitle(title)) evidenceTitles[day] = title;
      }
    }
    const calendar = repairCalendarState({ ...current.rawCalendar, outlookTravelTitles: { ...evidenceTitles,
      ...current.rawCalendar.outlookTravelTitles as Record<string, string> } });
    for (const snapshot of snapshots?.snapshots ?? []) for (const [day, tag] of Object.entries(snapshot.tags)) {
      if (!evidenceTitles[day] || cleanTravelTitle(evidenceTitles[day]) || current.calendar.manualTagDates[day]) continue;
      if (tag !== 'travel' && current.rawCalendar.tagMap && (current.rawCalendar.tagMap as Record<string, string>)[day] === 'travel') calendar.tagMap[day] = tag;
    }
    const changed = JSON.stringify(current.rawCalendar) !== JSON.stringify(calendar)
      || JSON.stringify(saved) !== JSON.stringify(snapshots) || JSON.stringify(current.rawConfig) !== JSON.stringify(nextConfig);
    if (changed) {
      if (!await kv.get(marker)) await kv.set(marker, { at: new Date().toISOString(), calendar: current.rawCalendar, snapshots: saved, config: current.rawConfig });
      await kv.mset({ [CALENDAR_KEY]: calendar, ...(snapshots ? { [SNAPSHOTS_KEY]: snapshots } : {}),
        ...(config ? { 'app-config': nextConfig } : {}) });
    }
    return changed ? readBonCalInputs() : current;
  });
}

export function outlookSyncError(error: unknown): string {
  return error instanceof Error && /^(「.+」日历读取失败|连接已变更，请重新同步|日历已更新，请重新同步|日历正在同步，请稍后重试)/.test(error.message)
    ? error.message : 'Outlook 暂不可用，请稍后重试';
}

export async function syncOutlookCalendar(today: string, secret: string, options: { persist?: boolean } = {}) {
  try {
    const connection = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
    if (!connection) return { connected: false as const };
    if (!isCalendarDate(today)) throw new Error('日期无效');
    const requestedAt = Date.now();
    const input = decryptOutlookConnection(connection.encrypted, secret);
    const date = Date.parse(`${today}T00:00:00Z`);
    const day = (offset: number) => new Date(date + offset * 86_400_000).toISOString().slice(0, 10);
    const snapshot = await readOutlookSnapshot(input, day(-30), day(700), { startDate: day(-14), endDate: day(31) });
    if (options.persist !== false) await saveOutlookSnapshot(connection, snapshot, input.policy, requestedAt);
    return { connected: true as const, availability: snapshot.availability, ...(snapshot.provider ? { provider: snapshot.provider } : {}), snapshot, connection, policy: input.policy, requestedAt };
  } catch (error) {
    const connection = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
    if (connection) await kv.set(OUTLOOK_READ_STATUS_KEY, { connectionId: connection.id, error: outlookSyncError(error) });
    throw new Error(outlookSyncError(error));
  }
}
