import { calendarReadAdvice } from './_bonCal/provider.js';
import { kv } from './_accountKv.js';
import { readBonCalPeriods, parsePeriodCalendar } from './_bonCal/periods.js';
import { periodDays, reconcilePeriodEvents, type PeriodEvent } from '../src/utils/bonLife.js';

export const LIFE_CONNECTION_KEY = 'bonlife:outlook-connection:v1';
export interface LifeConnection { id: string; encrypted: string }
export interface PeriodSnapshot { connectionId: string; requestedAt: number; syncedAt: string; events: PeriodEvent[] }
export const entriesKey = (year: number) => `bonlife:entries:v1:${year}`;
export const periodsKey = (year: number) => `bonlife:periods:v1:${year}`;
export const LIFE_SETTINGS_KEY = 'bonlife:settings:v1';
export const LIFE_TRAINING_ENTRIES_KEY = 'bonlife:training-entries:v1';
export const LIFE_SYMPTOM_ENTRIES_KEY = 'bonlife:symptom-entries:v1';

export async function readPeriodDays(year: number) {
  const currentYear = Number(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()).slice(0, 4));
  const years = [...new Set([year - 1, year, year + 1, currentYear - 1, currentYear, currentYear + 1])]
    .filter((value) => value >= 1900 && value <= 2200);
  const snapshots = await Promise.all(years.map((value) => kv.get<PeriodSnapshot>(periodsKey(value))));
  const events = snapshots.flatMap((snapshot) => snapshot?.events ?? []);
  return [...new Set(years.flatMap((value) => periodDays(events, value)))].sort();
}

export { parsePeriodCalendar } from './_bonCal/periods.js';
export async function readPeriodCalendar(connection: LifeConnection, year: number) {
  try { return (await readBonCalPeriods(connection, [year]))[0]; }
  catch (error) {
    const message = `Outlook 日历读取失败，${calendarReadAdvice(error instanceof Error ? error.cause ?? error : error)}`;
    await kv.set('bonlife:period-read-status:v1', { connectionId: connection.id, error: message });
    throw new Error(message);
  }
}

export async function syncLifePeriods(connection: LifeConnection, year: number) {
  const requestedAt = Date.now();
  const [parsed, previous] = await Promise.all([
    readPeriodCalendar(connection, year), kv.get<PeriodSnapshot>(periodsKey(year)),
  ]);
  return saveLifePeriods(connection, year, parsed, previous, requestedAt);
}

async function saveLifePeriods(connection: LifeConnection, year: number, parsed: ReturnType<typeof parsePeriodCalendar> & { provider?: string },
  previous: PeriodSnapshot | null, requestedAt: number) {
  if (previous && previous.requestedAt > requestedAt) throw new Error('日历连接或内容已更新，请重新同步');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const snapshot: PeriodSnapshot = { connectionId: connection.id, requestedAt, syncedAt: new Date().toISOString(),
    events: parsed.provider === 'google' ? [...(previous?.events ?? []).filter(event => !parsed.seenUids.includes(event.uid)), ...parsed.events]
      : reconcilePeriodEvents(previous?.events ?? [], parsed.events, parsed.seenUids, today) };
  const result = await kv.eval<(string | number)[], number>(`
    local connection = redis.call('get', KEYS[1])
    if not connection or cjson.decode(connection).id ~= ARGV[1] then return 0 end
    local previous = redis.call('get', KEYS[2])
    if previous and cjson.decode(previous).requestedAt ~= tonumber(ARGV[4]) then return -1 end
    if not previous and tonumber(ARGV[4]) ~= 0 then return -1 end
    redis.call('set', KEYS[2], ARGV[3])
    return 1
  `, [LIFE_CONNECTION_KEY, periodsKey(year)], [connection.id, requestedAt, JSON.stringify(snapshot), previous?.requestedAt ?? 0]);
  if (result !== 1) throw new Error('日历连接或内容已更新，请重新同步');
  await kv.set('bonlife:period-read-status:v1', { connectionId: connection.id });
  return { periodDays: periodDays(snapshot.events, year), syncedAt: snapshot.syncedAt };
}

// Calendar archiving must work without a browser, TickTick connection, or task write lock.
export async function syncRecentLifePeriods(now = new Date()) {
  try {
    const connection = await kv.get<LifeConnection>(LIFE_CONNECTION_KEY);
    if (!connection) return { connected: false as const };
    const year = Number(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now).slice(0, 4));
    const years = [year - 1, year, year + 1].filter((value) => value >= 1900 && value <= 2200);
    const requestedAt = Date.now();
    const [parsed, previous] = await Promise.all([
      readBonCalPeriods(connection, years), Promise.all(years.map((value) => kv.get<PeriodSnapshot>(periodsKey(value)))),
    ]);
    // Fetch once and validate every window before writing any snapshots. Previous-year
    // storage preserves late edits in January; next-year storage covers December crossings.
    const settled = await Promise.allSettled(years.map((value, index) => saveLifePeriods(connection, value, parsed[index], previous[index], requestedAt)));
    const results = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    return { connected: true as const, syncedAt: results[years.indexOf(year)].syncedAt };
  } catch {
    throw new Error('Outlook 经期同步失败，已保留历史，请重试');
  }
}

export const SAVE_LIFE_ENTRY = `
  local raw = redis.call('hget', KEYS[1], ARGV[1])
  local current = raw and cjson.decode(raw) or {revision = '', text = ''}
  local makeupKey = ARGV[6]
  local makeup = nil
  if makeupKey and makeupKey ~= '' then
    local shared = redis.call('hget', KEYS[1], makeupKey)
    if shared then makeup = cjson.decode(shared).makeup end
  end
  local function decorated(value)
    if not makeup then return value end
    local entry = value and value ~= '' and cjson.decode(value) or {revision = '', text = ''}
    entry.makeup = makeup
    return cjson.encode(entry)
  end
  if current.revision == ARGV[3] then return {1, decorated(raw)} end
  if current.revision ~= ARGV[2] then return {0, decorated(raw or '')} end
  local encoded = ARGV[4]
  if ARGV[5] ~= 'cycle' and ARGV[5] ~= 'skin-settings' then
    local next = cjson.decode(ARGV[4])
    if next.makeup and makeupKey and makeupKey ~= '' then
      if next.makeup.revision ~= (makeup and makeup.revision or '') then return {0, decorated(raw or '')} end
      if not makeup or next.makeup.face ~= makeup.face or next.makeup.eyes ~= makeup.eyes then
        makeup = next.makeup
        makeup.revision = ARGV[3]
        redis.call('hset', KEYS[1], makeupKey, cjson.encode({text = '', revision = ARGV[3], makeup = makeup}))
      end
    end
    next.makeup = nil
    for _, field in ipairs({'skin', 'eyes', 'discomfort', 'body', 'training'}) do
      if next[field] == nil then next[field] = current[field] end
    end
    encoded = cjson.encode(next)
  end
  redis.call('hset', KEYS[1], ARGV[1], encoded)
  if KEYS[2] then redis.call('hset', KEYS[2], ARGV[1], encoded) end
  return {1, decorated(encoded)}
`;
