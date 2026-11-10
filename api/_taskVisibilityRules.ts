import { kv } from './_accountKv.js';
import { readCalendarLocations } from './_calendarWeather.js';
import { normalizedCityName } from '../src/utils/calendarPresentation.js';
import { tripDestinationQueries } from '../src/utils/tripDestinations.js';
import { sleepWindow, inSleepFilterScope, sleepTagStateKey, type SleepTagJournal } from './_ticktickSleepTags.js';
import { hairWashHidden, readingHidden, nightRoutineHidden, timedTaskHidden, hasHiddenTag } from './_ticktickNightRoutine.js';
import type { TickTickTask } from './_ticktickTrips.js';
import { isPendingTickTickTask } from './_ticktickTaskState.js';
import type { SchedulingRuleId } from '../src/utils/schedulingRules.js';
import { hasTaskLocation, taskLocationAllowed } from './_ticktickLocation.js';

export interface LocationVisibility { names: string[]; today: string[]; unknown: boolean; calendarState?: unknown; date?: string }
export async function readLocationVisibility(today: string, calendarState?: unknown): Promise<LocationVisibility> {
  const [days, config, calendar, trips, contexts, plans] = await Promise.all([
    readCalendarLocations(today, today, calendarState), kv.get('app-config'), kv.get('calendar-tags'), kv.get('trip-tags'),
    kv.hgetall('bonclothes:contexts:v1'), kv.hgetall('bonclothes:trip-plans:v1'),
  ]);
  if (days[today]?.error) throw new Error('地点读取失败');
  const names = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.name === 'string' && typeof object.latitude === 'number' && typeof object.longitude === 'number') names.add(normalizedCityName(object.name));
    for (const item of Object.values(object)) walk(item);
  };
  [config, calendarState ?? calendar, contexts, plans].forEach(walk);
  const tripTitles = (trips as { tripTags?: Record<string, string> } | null)?.tripTags ?? {};
  const outlookTitles = (calendar as { outlookTravelTitles?: Record<string, string> } | null)?.outlookTravelTitles ?? {};
  for (const title of [...Object.values(tripTitles), ...Object.values(outlookTitles)]) for (const name of tripDestinationQueries(title)) names.add(normalizedCityName(name));
  const locations = days[today]?.locations ?? [];
  locations.forEach(city => names.add(normalizedCityName(city.name)));
  // A multi-stop trip without an explicit per-day location cannot prove where
  // the user is today; it must not reveal todos for every stop at once.
  const unknown = locations.length !== 1 || Boolean(days[today]?.unresolved?.length);
  const state = (calendarState ?? calendar ?? {}) as { cityMap?: Record<string, unknown>; dayOverrides?: Record<string, unknown> };
  return { names: [...names], today: !unknown ? locations.map(c => normalizedCityName(c.name)) : [], unknown, date: today,
    calendarState: { ...state, cityMap: { ...state.cityMap, [today]: unknown ? null : locations[0] },
      dayOverrides: { ...state.dayOverrides, [today]: {} } } };
}
export function locationTaskHidden(task: TickTickTask, locations: LocationVisibility): boolean | null {
  if (locations.calendarState && locations.date) return hasTaskLocation(task, locations.calendarState)
    ? !taskLocationAllowed(task, locations.calendarState, locations.date) : null;
  const tags = (task.tags ?? []).map(normalizedCityName).filter(tag => locations.names.includes(tag));
  return tags.length ? !tags.some(tag => locations.today.includes(tag)) : null;
}
export const visibilityRules: SchedulingRuleId[] = ['visibility-location', 'visibility-sleep', 'visibility-reading', 'visibility-hair', 'visibility-night', 'visibility-timed'];
export async function visibilityInputs(projectId: string, today: string, calendarState?: unknown) {
  const [journal, locations] = await Promise.all([
    kv.get<SleepTagJournal>(sleepTagStateKey(projectId)), readLocationVisibility(today, calendarState).catch(() => null),
  ]);
  return { journal: journal ?? {}, locations };
}
export function visibilityDecision(id: SchedulingRuleId, task: TickTickTask, input: {
  now: Date; timeZone: string; journal: SleepTagJournal; locations: LocationVisibility | null;
}): boolean | null {
  if (!isPendingTickTickTask(task)) return null;
  if (id === 'visibility-location') return input.locations ? locationTaskHidden(task, input.locations) : null;
  if (id === 'visibility-reading') return readingHidden(task, input.now);
  if (id === 'visibility-hair') return hairWashHidden(task, input.now);
  if (id === 'visibility-night') return nightRoutineHidden(task, input.now, input.timeZone);
  if (id === 'visibility-timed') return timedTaskHidden(task, input.now, input.timeZone);
  if (id === 'visibility-sleep') {
    const window = sleepWindow(input.now);
    if (window.hidden) return inSleepFilterScope(task, window.day) || Boolean(input.journal[task.id]) ? true : null;
    return input.journal[task.id] && hasHiddenTag(task) ? false : null;
  }
  return null;
}
