import { kv } from '../_accountKv.js';
import { upstream } from '../_weatherClient.js';
import { cityLabel, readSceneCity } from '../../src/utils/sceneCities.js';
import { dateRange, normalizeDayOverrides, resolveDailyContext } from '../../src/boncal/daily.js';
import { detectAllTrips } from '../../src/boncal/trips.js';
import { getTripDisplayTitle } from '../../src/boncal/events.js';
import { tripDestinationQueries } from '../../src/boncal/destinations.js';
import type { DayOverrides, TagKind } from '../../src/models/types.js';
import type { ClothesDayContext, ClothesLocation, ClothesTripPlan } from '../../src/clothes/types.js';
import type { CalendarLocationDay } from '../../src/utils/calendarWeather.js';
import { readBonCalInputs, readBonCalView } from './repository.js';

interface GeocodedCity { name: string; latitude: number; longitude: number; timezone?: string; population?: number; feature_code?: string; admin1?: string }
const normalizedName = (name: string) => name.trim().toLocaleLowerCase().replace(/市$/, '');
const normalizedRegion = (name: string) => name.replace(/(?:省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, '');
export function destinationParts(query: string) {
  const match = query.match(/^(?:中国)?(内蒙古|黑龙江|广西|宁夏|新疆|西藏|河北|山西|辽宁|吉林|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|北京|天津|上海|重庆|香港|澳门)(?:壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市)?\s*(.{2,})$/);
  return match ? { name: match[2].trim(), region: match[1] } : { name: query, region: null };
}
export function selectDestinationCity(query: string, cities: GeocodedCity[]): ClothesLocation | null {
  const { name, region } = destinationParts(query);
  const matches = cities.filter((city) => normalizedName(city.name) === normalizedName(name) && readSceneCity(city)
    && (!region || normalizedRegion(city.admin1 ?? '') === region));
  const unique = [...new Map(matches.map((city) => [`${city.latitude.toFixed(2)}:${city.longitude.toFixed(2)}`, city])).values()]
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  const first = unique[0];
  if (!first || (unique.length > 1 && ((first.population ?? 0) < 100000 || (first.population ?? 0) < (unique[1].population ?? 0) * 10))) return null;
  return { name: cityLabel(first), latitude: first.latitude, longitude: first.longitude, timezone: first.timezone, source: 'calendar' };
}
export async function resolveDestination(query: string): Promise<ClothesLocation | null> {
  if (!/^[\p{L}\s·.-]{2,40}$/u.test(query)) return null;
  const key = `weather:destination:v2:${query}`;
  const cached = await kv.get<{ city: ClothesLocation | null }>(key);
  if (cached) return cached.city;
  const { name } = destinationParts(query);
  const queries = /^[\u4e00-\u9fff]{2,8}$/.test(name) && !name.endsWith('市') ? [name, `${name}市`] : [name];
  const results = await Promise.all(queries.map(async (name) => {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '10', language: 'zh', format: 'json' }).toString();
    return (await upstream(url)).results ?? [];
  }));
  const city = selectDestinationCity(query, results.flat());
  await kv.set(key, { city }, { ex: city ? 30 * 86400 : 3600 });
  return city;
}

export async function readCalendarLocations(start: string, end: string, calendarOverride?: unknown, inputs?: Awaited<ReturnType<typeof readBonCalInputs>> & {
  contexts?: Record<string, ClothesDayContext> | null; plans?: Record<string, ClothesTripPlan> | null;
}): Promise<Record<string, CalendarLocationDay>> {
  const state = inputs ?? await readBonCalView();
  const contexts = state.contexts, plans = state.plans;
  const calendar = (calendarOverride ?? state.calendar) as { tagMap?: Record<string, TagKind>; dayOverrides?: DayOverrides; outlookTravelTitles?: Record<string, string>; holidayDataByYear?: import('../../src/utils/holidays.js').HolidayDataByYear };
  const settings = state.tripSettings as { tripTags?: Record<string, string>; tripSplits?: Record<string, true> };
  const config = state.config, dayOverrides = normalizeDayOverrides(calendar?.dayOverrides);
  const trips = detectAllTrips(calendar?.tagMap ?? {}, settings?.tripSplits);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const failedLocations = new Set<string>();
  const queries = new Map<string, Promise<ClothesLocation | null>>();
  const resolve = (query: string) => {
    if (!queries.has(query)) queries.set(query, resolveDestination(query).catch(() => { failedLocations.add(query); return null; }));
    return queries.get(query)!;
  };
  const rows = await Promise.all(dateRange(start, end).map(async (date) => {
    const daily = resolveDailyContext(date, calendar?.tagMap?.[date], { config, dayOverrides, holidayDataByYear: calendar.holidayDataByYear });
    const context = contexts?.[date], trip = trips.find((trip) => trip.dates.includes(date));
    const plan = trip && plans?.[`trip:${trip.startDate}`];
    const tripDay = plan?.days[date];
    const title = trip ? getTripDisplayTitle(settings?.tripTags?.[trip.startDate], trip.dates, calendar?.outlookTravelTitles ?? {}) : '';
    const plannedLocation = plan?.location?.source !== 'calendar' || plan.title === title ? readSceneCity(plan?.location) : null;
    const explicit = (context?.location?.source === 'manual' || (date <= today && context?.location?.source === 'geo') ? readSceneCity(context.location) : null)
      ?? readSceneCity(dayOverrides[date]?.city);
    const fixed = explicit ?? (daily.tag === 'travel' ? plannedLocation : daily.city);
    let locations: ClothesLocation[] = fixed ? [{ ...fixed, source: 'calendar' }] : [];
    let unresolved: string[] = [];
    if (!fixed && trip) {
      const names = tripDestinationQueries(title), cities = await Promise.all(names.map(resolve));
      locations = cities.filter((city): city is ClothesLocation => !!city);
      unresolved = names.filter((_, index) => !cities[index]);
    }
    return [date, { locations, ...(unresolved.length ? { unresolved } : {}), ...(unresolved.some(name => failedLocations.has(name)) ? { error: '地点读取失败' } : {}), travel: daily.tag === 'travel', scene: context?.scene ?? tripDay?.scene, active: context?.active ?? tripDay?.active }] as const;
  }));
  return Object.fromEntries(rows);
}
