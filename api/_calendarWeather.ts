import { readCalendarLocations } from './_bonCal/locations.js';
export { readCalendarLocations, destinationParts, selectDestinationCity, resolveDestination } from './_bonCal/locations.js';
import { readDailyWeather } from './_dailyWeather.js';
import type { ClothesLocation } from '../src/clothes/types.js';
import type { CalendarWeather } from '../src/utils/calendarWeather.js';

export async function readCalendarWeather(start: string, end: string): Promise<CalendarWeather> {
  const locations = await readCalendarLocations(start, end);
  const requests = new Map<string, ReturnType<typeof readDailyWeather>>();
  const key = (location: ClothesLocation) => `${location.latitude.toFixed(3)}:${location.longitude.toFixed(3)}:${location.timezone ?? 'Asia/Shanghai'}`;
  for (const day of Object.values(locations)) for (const city of day.locations) {
    if (!requests.has(key(city))) requests.set(key(city), readDailyWeather(city, start, end, city.timezone ?? 'Asia/Shanghai').catch(() => ({ days: {}, stale: true, error: '天气更新失败' })));
  }
  const results = new Map(await Promise.all([...requests].map(async ([key, request]) => [key, await request] as const)));
  return { locations, days: Object.fromEntries(Object.entries(locations).map(([date, day]) => [date, day.locations.map((location) => {
    const result = results.get(key(location))!;
    return { location, weather: result.days[date] ?? null, stale: result.stale };
  })])), ...(Array.from(results.values()).some((r) => r.error) ? { error: '天气更新失败' } : {}) };
}
