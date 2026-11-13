import { randomUUID } from 'node:crypto';
import { kv } from './_accountKv.js';
import { applyOutlookSnapshotToState, isCalendarDate, type OutlookConflictPolicy, type OutlookSnapshot } from '../src/utils/outlookCalendar.js';
import { decryptOutlookConnection, readOutlookSnapshot } from './_outlookCalendar.js';

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
async function withCalendarWriteLock<T>(write: () => Promise<T>): Promise<T> {
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
  return { startDate, endDate, ruleOrder: snapshot.ruleOrder, ruleCandidates: Object.fromEntries(Object.entries(snapshot.ruleCandidates ?? {}).filter(inRange)), tags: Object.fromEntries(Object.entries(snapshot.tags).filter(inRange)),
    travelTitles: Object.fromEntries(Object.entries(snapshot.travelTitles ?? {}).filter(inRange)) };
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
        ruleOrder: snapshot.ruleOrder, ruleCandidates: { ...last.ruleCandidates, ...snapshot.ruleCandidates }, tags: { ...last.tags, ...snapshot.tags }, travelTitles: { ...last.travelTitles, ...snapshot.travelTitles } };
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
    await kv.mset({ [CALENDAR_KEY]: calendar, [SNAPSHOTS_KEY]: snapshots,
      [OUTLOOK_READ_STATUS_KEY]: { connectionId: connection.id, syncedAt: new Date(requestedAt).toISOString(),
        ...(snapshot.provider ? { provider: snapshot.provider } : {}) },
      ...(replaceConnection ? { [OUTLOOK_CONNECTION_KEY]: connection } : {}) });
    return calendar;
  });
}

export async function disconnectOutlookCalendar() {
  return withCalendarWriteLock(() => kv.del(OUTLOOK_CONNECTION_KEY, SNAPSHOTS_KEY, OUTLOOK_READ_STATUS_KEY));
}

export async function saveUploadedCalendarState(value: unknown) {
  return withCalendarWriteLock(async () => {
    const [connection, saved] = await Promise.all([
      kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY), kv.get<SavedSnapshots>(SNAPSHOTS_KEY),
    ]);
    let calendar = value;
    if (connection && saved?.connectionId === connection.id) {
      calendar = saved.snapshots.reduce((state, snapshot) => applyOutlookSnapshotToState(state, snapshot, saved.policy), asCalendarState(value));
    }
    await kv.set(CALENDAR_KEY, calendar);
    return calendar;
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
    return { connected: true as const, availability: snapshot.availability, snapshot, connection, policy: input.policy, requestedAt };
  } catch (error) {
    const connection = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
    if (connection) await kv.set(OUTLOOK_READ_STATUS_KEY, { connectionId: connection.id, error: outlookSyncError(error) });
    throw new Error(outlookSyncError(error));
  }
}
