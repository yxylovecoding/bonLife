import { validDate } from '../src/utils/internship.js';
import { cityLabel, readSceneCity } from '../src/utils/sceneCities.js';
import type { LivingKind, SceneCity } from '../src/models/types.js';
import type { TickTickTask } from './_ticktickTrips.js';

const cityName = (name: string) => name.normalize('NFKC').trim().toLowerCase().split('·')[0].trim().replace(/市$/, '');
const tagName = (name: string) => name.normalize('NFKC').trim().toLowerCase();
const labels = (task: TickTickTask) => (task.tags ?? []).map(tag => tag.normalize('NFKC').trim());
interface LocationCalendar {
  tagMap?: Record<string, unknown>;
  workingMap?: Record<string, boolean>;
  livingKindMap?: Record<string, LivingKind>;
  cityMap?: Record<string, SceneCity | null>;
  locationCities?: SceneCity[];
  dayOverrides?: Record<string, { city?: SceneCity }>;
  locationTags?: string[];
  bonCalLocations?: Record<string, { error?: string }>;
}
const calendar = (state: unknown) => (state ?? {}) as LocationCalendar;
const sceneTags = new Set(['寄', '居', '旅', '休', '班']);
interface LocationDay { scene: unknown; city: string; working?: boolean; livingKind?: LivingKind; unavailable: boolean }
interface LocationIndex { members?: Set<string>; known: Set<string>; scenes: Set<string>; dates: string[]; days: Map<string, LocationDay> }
const indexes = new WeakMap<object, LocationIndex>();
function buildIndex(state: unknown): LocationIndex {
  const value = calendar(state);
  const explicit = value.locationTags?.map(tagName);
  const known = new Set(explicit ?? ['北京', '广州', '上海', '天津', '重庆', '香港', '澳门',
    ...(value.locationCities ?? []).map(cityLabel), ...Object.values(value.cityMap ?? {}).map(cityLabel),
    ...Object.values(value.dayOverrides ?? {}).map(day => cityLabel(day.city))].map(cityName));
  const scenes = new Set(explicit ? explicit.filter(tag => sceneTags.has(tag)) : [...sceneTags, '寓']);
  for (const tag of [...scenes, '地点', '日子']) known.delete(tag);
  const dates = [...new Set([...Object.keys(value.tagMap ?? {}), ...Object.keys(value.cityMap ?? {}),
    ...Object.keys(value.dayOverrides ?? {}), ...Object.keys(value.workingMap ?? {}), ...Object.keys(value.livingKindMap ?? {})])].filter(validDate).sort();
  const days = new Map(dates.map(date => {
    const city = readSceneCity(value.dayOverrides?.[date]?.city) ?? readSceneCity(value.cityMap?.[date]);
    return [date, { scene: value.tagMap?.[date], city: city ? cityName(cityLabel(city)) : '', working: value.workingMap?.[date],
      livingKind: value.livingKindMap?.[date], unavailable: Boolean(value.bonCalLocations?.[date]?.error) }];
  }));
  return { members: explicit ? new Set(explicit) : undefined, known, scenes, dates, days };
}
// Every run supplies an immutable calendar/tag snapshot. Cache only by that
// object's lifetime; no account data or previous run is used as a fallback.
function indexFor(state: unknown): LocationIndex {
  if (!state || typeof state !== 'object') return buildIndex(state);
  let index = indexes.get(state);
  if (!index) { index = buildIndex(state); indexes.set(state, index); }
  return index;
}
function constraints(task: TickTickTask, index: LocationIndex) {
  const tags = labels(task).map(index.members ? tagName : cityName).filter(tag => !index.members || index.members.has(tag));
  return { scenes: tags.filter(tag => index.scenes.has(tag)),
    cities: tags.filter(tag => index.known.has(tag)).map(tag => tag.replace(/市$/, '')) };
}

export function taskCityTags(task: TickTickTask, state: unknown): string[] {
  return constraints(task, indexFor(state)).cities;
}

export function taskSceneTags(task: TickTickTask, state: unknown): string[] {
  return constraints(task, indexFor(state)).scenes;
}

export function hasTaskLocation(task: TickTickTask, state: unknown): boolean {
  const { scenes, cities } = constraints(task, indexFor(state));
  return scenes.length > 0 || cities.length > 0;
}

export function taskLocationUnavailable(task: TickTickTask, state: unknown, date: string): boolean {
  const index = indexFor(state), { scenes } = constraints(task, index), day = index.days.get(date);
  return hasTaskLocation(task, state) && Boolean(day?.unavailable || matchesScene(day, scenes) === undefined);
}

// Scene alternatives are OR; city alternatives are OR; the two groups are AND.
// Unknown locations never count as being in the requested city.
export function taskLocationAllowed(task: TickTickTask, state: unknown, date: string): boolean {
  const index = indexFor(state), { scenes, cities } = constraints(task, index);
  return matchesLocation(index, date, scenes, cities);
}

function matchesScene(day: LocationDay | undefined, scenes: string[]): boolean | undefined {
  if (!scenes.length) return true;
  const matches = scenes.map(tag => {
    if (tag === '班') return day?.working;
    // 休 is the actual boncal rest scene, not every non-working day.
    if (tag === '休') return day?.livingKind === undefined ? undefined : day.livingKind === 'rest';
    return tag === '寄' ? day?.scene === 'home' : tag === '旅' ? day?.scene === 'travel'
      : day?.scene === 'school' || day?.scene === 'intern';
  });
  return matches.includes(true) ? true : matches.includes(undefined) ? undefined : false;
}
function matchesLocation(index: LocationIndex, date: string, scenes: string[], cities: string[]): boolean {
  if (!scenes.length && !cities.length) return true;
  if (!validDate(date)) return false;
  const day = index.days.get(date);
  if (day?.unavailable || matchesScene(day, scenes) !== true) return false;
  return !cities.length || Boolean(day?.city && cities.includes(day.city));
}

export function nextTaskLocationDate(task: TickTickTask, state: unknown, from: string): string | null {
  return findDate(task, indexFor(state), from);
}
function findDate(task: TickTickTask, index: LocationIndex, from: string): string | null {
  const { scenes, cities } = constraints(task, index);
  if (!scenes.length && !cities.length) return from;
  let low = 0, high = index.dates.length;
  while (low < high) { const middle = (low + high) >>> 1; if (index.dates[middle] < from) low = middle + 1; else high = middle; }
  for (let i = low; i < index.dates.length; i++) {
    const date = index.dates[i], day = index.days.get(date);
    // Do not move a task past an unconfirmed potentially eligible day. Known
    // incompatible scenes can still be skipped without needing their city.
    const scene = matchesScene(day, scenes);
    if (scene === false) continue;
    if (day?.unavailable || scene === undefined) return null;
    if (matchesLocation(index, date, scenes, cities)) return date;
  }
  return null;
}
export function createTaskLocationDateFinder(state: unknown) {
  const index = buildIndex(state);
  return (task: TickTickTask, from: string) => findDate(task, index, from);
}
