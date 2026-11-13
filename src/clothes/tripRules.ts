import { bonCalTrips } from '../boncal/trips.js';
import { deviceDate, emptyContext, inferActivities } from './rules.js';
import type { ClothesDayContext, ClothesEvent, ClothesTrip, ClothesTripPlan } from './types.js';

export function addTripDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function tripDates(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end && dates.length < 366; date = addTripDays(date, 1)) dates.push(date);
  return dates;
}
export function tripEventsOnDate(events: ClothesEvent[], date: string, timezone: string) {
  return events.filter((event) => event.allDay ? event.startDate <= date && event.endDate > date
    : deviceDate(new Date(event.startDate), timezone) <= date && deviceDate(new Date(Date.parse(event.endDate) - 1), timezone) >= date);
}
export function buildClothesTrips(calendar: Record<string, unknown>, settings: Record<string, unknown>, events: ClothesEvent[], today: string, timezone: string): ClothesTrip[] {
  return bonCalTrips(calendar, settings).filter((trip) => trip.endDate >= today && trip.startDate <= addTripDays(today, 180))
    .map((trip) => {
      const dates = trip.dates.slice(0, 366);
      const matches = events.filter((event) => dates.some((date) => tripEventsOnDate([event], date, timezone).length));
      const title = trip.title || '出游';
      return { id: `trip:${trip.startDate}`, title,
        startDate: trip.startDate, endDate: trip.endDate, dates, destinations: trip.destinations, events: matches };
    });
}
export function newTripPlan(trip: ClothesTrip): ClothesTripPlan {
  return { tripId: trip.id, revision: '', title: trip.title, startDate: trip.startDate, endDate: trip.endDate, location: trip.locations?.length === 1 && !trip.unresolvedDestinations?.length ? trip.locations[0] : null, days: {} };
}
export function tripDayContext(trip: ClothesTrip, plan: ClothesTripPlan, date: string, timezone: string): ClothesDayContext {
  const inferred = inferActivities(tripEventsOnDate(trip.events, date, timezone));
  const day = plan.days[date];
  return { ...emptyContext(date, plan.location?.timezone ?? timezone), location: plan.location,
    purpose: day?.purpose ?? null, scene: day?.scene ?? inferred.scene, active: day?.purpose === '运动' ? true : day?.active ?? inferred.active };
}
