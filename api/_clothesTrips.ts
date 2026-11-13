import { readBonCalContext } from './_bonCal/service.js';
import { isNonTravelCalendarTitle } from '../src/boncal/events.js';
import { kv } from './_accountKv.js';
import { addTripDays, tripEventsOnDate, tripDates } from '../src/clothes/tripRules.js';
import { deviceDate } from '../src/clothes/rules.js';
import { CATEGORIES, MAX_OUTFIT_ITEMS, PURPOSES, SCENES, categoryLabel, type ClothesLocation, type ClothesTripPlan, type ClothesTripsData, type TripForecast } from '../src/clothes/types.js';
import { dateInput, id, locationInput, requireInput } from './_clothesValidation.js';
import { readDailyWeather } from './_dailyWeather.js';

export const TRIP_PLANS_KEY = 'bonclothes:trip-plans:v1';
export async function readClothesTrips(today: string, timezone: string): Promise<ClothesTripsData> {
  const [context, saved] = await Promise.all([
    readBonCalContext(addTripDays(today, -30), addTripDays(today, 181), { refresh: true, repair: true }),
    kv.hgetall<Record<string, ClothesTripPlan>>(TRIP_PLANS_KEY),
  ]);
  const trips = context.trips.filter(trip => trip.endDate >= today && trip.startDate <= addTripDays(today, 180)).map(trip => {
    const days = trip.dates.map(date => context.days[date]).filter(Boolean);
    return { ...trip, events: context.events.filter(event => trip.dates.some(date => tripEventsOnDate([event], date, timezone).length)),
      locations: [...new Map(days.flatMap(day => day.locations).map(city => [`${city.latitude}:${city.longitude}`, city])).values()],
      unresolvedDestinations: [...new Set(days.flatMap(day => day.unresolved ?? []))] };
  }) as import('../src/clothes/types.js').ClothesTrip[];
  const plans = Object.values(saved ?? {}).filter(plan => plan.endDate >= today);
  for (const plan of plans) if (!trips.some(trip => trip.id === plan.tripId) && !isNonTravelCalendarTitle(plan.title)) {
    trips.push({ id: plan.tripId, title: plan.title, startDate: plan.startDate, endDate: plan.endDate,
      dates: tripDates(plan.startDate, plan.endDate), destinations: [], events: [], archived: true });
  }
  return { trips: trips.sort((a, b) => a.startDate.localeCompare(b.startDate)), plans, connected: context.status.connected, calendarError: context.status.error };
}

export async function readTripForecast(location: ClothesLocation, start: string, end: string, timezone: string): Promise<TripForecast> {
  requireInput(start <= end && Date.parse(end) - Date.parse(start) < 366 * 86400000, '行程日期无效');
  const today = deviceDate(new Date(), timezone);
  return readDailyWeather(location, start > today ? start : today, end, timezone);
}

export function tripPlanInput(value: unknown): ClothesTripPlan {
  const v = value as ClothesTripPlan;
  requireInput(v && typeof v.tripId === 'string' && /^trip:\d{4}-\d{2}-\d{2}$/.test(v.tripId), '行程标识无效');
  const startDate = dateInput(v.startDate), endDate = dateInput(v.endDate);
  requireInput(v.tripId === `trip:${startDate}` && startDate <= endDate && Date.parse(endDate) - Date.parse(startDate) < 366 * 86400000, '行程日期无效');
  requireInput(typeof v.title === 'string' && v.title.trim().length > 0 && v.title.length <= 500, '行程名称无效');
  requireInput(v.days && typeof v.days === 'object' && !Array.isArray(v.days) && Object.keys(v.days).length <= 366, '计划无效');
  const days: ClothesTripPlan['days'] = {};
  for (const [date, day] of Object.entries(v.days)) {
    dateInput(date);
    requireInput(date >= startDate && date <= endDate && day && (day.scene === null || SCENES.includes(day.scene))
      && (day.active === null || typeof day.active === 'boolean')
      && (day.purpose == null || PURPOSES.includes(day.purpose)), '每日条件无效');
    requireInput(day.itemIds === null || (Array.isArray(day.itemIds) && day.itemIds.length <= MAX_OUTFIT_ITEMS && new Set(day.itemIds).size === day.itemIds.length), '搭配无效');
    requireInput(day.itemCategories === undefined || (day.itemCategories && typeof day.itemCategories === 'object' && !Array.isArray(day.itemCategories)
      && Object.entries(day.itemCategories).every(([id, role]) => day.itemIds?.includes(id) && CATEGORIES.includes(categoryLabel(role)))), '穿着位置无效');
    days[date] = { ...(day.itemCategories ? { itemCategories: day.itemCategories } : {}), ...(day.purpose ? { purpose: day.purpose } : {}), scene: day.scene, active: day.active, itemIds: day.itemIds?.map((value) => id(value)) ?? null };
  }
  return { tripId: v.tripId, revision: id(v.revision, true), title: v.title.trim(), startDate, endDate, location: locationInput(v.location), days };
}
