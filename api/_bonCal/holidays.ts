import type { HolidayYearData } from '../../src/utils/holidays.js';

// Shared by the calendar service and the existing holiday API. No browser-only
// holiday cache is allowed to change the public calendar's work/rest facts.
const cache = new Map<number, { at: number; data: HolidayYearData }>();
const pending = new Map<number, Promise<HolidayYearData>>();
export async function readHolidayYear(year: number): Promise<HolidayYearData> {
  const saved = cache.get(year);
  if (saved && Date.now() - saved.at < 86400_000) return saved.data;
  const existing = pending.get(year);
  if (existing) return existing;
  const request = (async () => {
    const key = (process.env.JIEJIARI_API_KEY || '').trim();
    const response = await fetch(`https://api.jiejiariapi.com/v1/holidays/${year}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('节假日读取失败');
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.entries(value).some(([date, item]) => !date.startsWith(`${year}-`) || !item || typeof item !== 'object'
        || typeof (item as { isOffDay?: unknown }).isOffDay !== 'boolean')) throw new Error('节假日内容无效');
    cache.set(year, { at: Date.now(), data: value });
    return value as HolidayYearData;
  })();
  pending.set(year, request);
  try { return await request; } finally { pending.delete(year); }
}
