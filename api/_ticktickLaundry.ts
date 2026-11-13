import { kv } from './_accountKv.js';
import { hasHiddenTag } from './_ticktickHiddenTag.js';
import { taskLocationAllowed } from './_ticktickLocation.js';
import { upstream } from './_bonClothes.js';
import type { SceneCity } from '../src/models/types.js';
import { readSceneCity } from '../src/utils/sceneCities.js';
import { normalizeDayOverrides, resolveDailyContext, resolveCalendarState } from '../src/utils/internship.js';
import type { AppConfig, TagKind } from '../src/models/types.js';
import type { OutlookAvailability } from '../src/utils/outlookCalendar.js';
import { dayAvailability, type AvailabilityProfile } from './_dailyAvailability.js';
import { cycleEnd, estimateTaskMinutes } from './_ticktickDailyPlan.js';
import { calendarDateInTimeZone, nextRoutineSceneDate, isAlwaysTodayTask, routineOccurrenceKey, routineTaskDate, shiftTickTickDate,
  type TickTickApi, type TickTickTask, type TickTickTripSource } from './_ticktickTrips.js';

export const LAUNDRY_STATE_KEY = 'ticktick:laundry-weather:v1';
export const LAUNDRY_CALENDAR_MINUTES = 50;
const DAY = 86_400_000;
const WEATHER_DAY_OFFSETS = [-1, 0, 1, 2] as const;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const normalize = (text: string) => text.normalize('NFKC').trim();
const pending = (task: TickTickTask) => (task.status ?? 0) === 0 && !task.completedTime;
export const isLaundryTask = (task: TickTickTask) => normalize(task.title) === '洗衣服'
  && !(task.tags ?? []).some(tag => normalize(tag) === '不关我事');


export interface LaundryWeather { rain: number; probability: number; sunshine: number; code: number }
export interface LaundryForecast { fetchedAt: string; days: Record<string, LaundryWeather> }
interface Anchor { projectId: string; repeatFlag: string; completion?: string; target: string }
export interface LaundryState { connectionId: string; anchors: Record<string, Anchor> }
export interface LaundryDecision { id: string; target?: string; date?: string; reason: string; location?: string }

export function laundryLocation(configState: unknown, date?: string, calendarState?: unknown): SceneCity | null {
  const config = (configState as { config?: AppConfig } | null)?.config;
  if (!date) return readSceneCity(config?.schoolCity);
  const calendar = calendarState as { tagMap?: Record<string, TagKind>; dayOverrides?: unknown; cityMap?: Record<string, SceneCity | null> } | null;
  if (calendar?.cityMap && Object.hasOwn(calendar.cityMap, date)) return readSceneCity(calendar.cityMap[date]);
  return resolveDailyContext(date, calendar?.tagMap?.[date], { config: config ?? {}, dayOverrides: normalizeDayOverrides(calendar?.dayOverrides) }).city;
}

export async function readLaundryForecast(location: SceneCity, today: string, now = new Date()): Promise<LaundryForecast> {
  const latitude = Number(location.latitude.toFixed(3)), longitude = Number(location.longitude.toFixed(3));
  const key = `ticktick:laundry-forecast:v1:${latitude}:${longitude}:${today}`;
  const saved = await kv.get<LaundryForecast>(key);
  if (saved && now.getTime() - Date.parse(saved.fetchedAt) >= 0 && now.getTime() - Date.parse(saved.fetchedAt) < 3 * 3600_000) return saved;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), timezone: 'Asia/Shanghai',
    daily: 'precipitation_sum,precipitation_probability_max,sunshine_duration,weather_code',
    forecast_days: '16', past_days: '1' }).toString();
  const data = await upstream(url), daily = data.daily;
  const days: Record<string, LaundryWeather> = {};
  for (let offset = -1; offset < 16; offset++) {
    const date = addDays(today, offset), index = daily?.time?.indexOf(date) ?? -1;
    const fields = ['precipitation_sum', 'precipitation_probability_max', 'sunshine_duration', 'weather_code'].map(key => daily?.[key]?.[index]);
    // A distant model horizon may be missing even while the nearby laundry
    // window is complete. Keep unknown days absent; chooseLaundryDay requires
    // complete weather for each eligible washing day and its drying day.
    if (index < 0 || !fields.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) continue;
    const [rain, probability, sunshine, code] = fields;
    if (probability > 100 || sunshine > 86400) continue;
    days[date] = { rain, probability, sunshine, code };
  }
  if (!Object.keys(days).some(date => date >= today)) throw new Error('洗衣天气预报不完整');
  const result = { fetchedAt: now.toISOString(), days };
  await kv.set(key, result, { ex: 86400 });
  return result;
}

function lastCompletion(task: TickTickTask, tasks: TickTickTask[], history: TickTickTask[], now: Date) {
  const family = routineOccurrenceKey(task);
  const unique = tasks.filter(candidate => pending(candidate) && routineOccurrenceKey(candidate) === family).length === 1;
  return history.filter(record => record.projectId === task.projectId && (record.id === task.id
    || (unique && routineOccurrenceKey(record) === family)) && record.completedTime
    && Number.isFinite(Date.parse(record.completedTime)) && Date.parse(record.completedTime) <= now.getTime())
    .map(record => record.completedTime!).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export function laundryAnchor(task: TickTickTask, tasks: TickTickTask[], history: TickTickTask[], state: LaundryState, now: Date,
  outlookEvents: OutlookAvailability['events'] = []): Anchor | null {
  // Do not change finite rules or reinterpret an unknown cadence as five days.
  if (!routineTaskDate(task) || !task.repeatFlag || /(?:COUNT|UNTIL|BYHOUR|BYMINUTE|BYSECOND)=/i.test(task.repeatFlag)) return null;
  const saved = state.anchors[task.id];
  // DoneList treats ended personal calendar records as completed activity. A linked
  // automatic appointment is only a plan: its end time must not start a new cycle.
  // Without an explicit task link, only match a single active laundry task.
  const outlook = tasks.filter(candidate => pending(candidate) && isLaundryTask(candidate)).length === 1
    ? outlookEvents.filter(event => normalize(event.title) === '洗衣服' && !event.taskLink
      && Date.parse(event.start) < Date.parse(event.end) && Date.parse(event.end) <= now.getTime()).map(event => event.end) : [];
  const completion = [lastCompletion(task, tasks, history, now),
    ...(saved?.projectId === task.projectId && saved.repeatFlag === task.repeatFlag ? [saved.completion] : []), ...outlook]
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)) && Date.parse(value!) <= now.getTime())
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const lastDay = calendarDateInTimeZone(completion, task.timeZone);
  const fromCompletion = lastDay ? cycleEnd(task, lastDay) : null;
  if (!cycleEnd(task, lastDay ?? routineTaskDate(task) ?? '')) return null;
  const target = fromCompletion ?? (saved?.projectId === task.projectId && saved.repeatFlag === task.repeatFlag
    && saved.completion === completion ? saved.target : routineTaskDate(task));
  if (!target) return null;
  return state.anchors[task.id] = { projectId: task.projectId, repeatFlag: task.repeatFlag, completion, target };
}

interface PlanOptions {
  tasks: TickTickTask[]; history: TickTickTask[]; calendarState: unknown; availability?: OutlookAvailability;
  configState?: unknown; trips?: TickTickTripSource[];
  profile?: AvailabilityProfile; now: Date; today: string;
}

export function laundryBeforeTrip(target: string, trips: TickTickTripSource[], completedDay?: string | null): string | null {
  const trip = trips.find(trip => trip.startDate <= target && target <= trip.endDate);
  if (!trip) return null;
  const date = addDays(trip.startDate, -1);
  // Finishing the pre-trip wash starts a new cycle; never move that next
  // occurrence back to an already completed day during a long trip.
  return completedDay && completedDay >= date ? null : date;
}

function hasTime(task: TickTickTask, date: string, options: PlanOptions) {
  const { availability, today, now, profile } = options;
  if (!availability || date < availability.startDate || date >= availability.endDate) return false;
  // Only exclude this task's own appointment. Another same-name/manual event
  // must continue to block its time slot.
  const calendar = { ...availability, events: availability.events.filter(event => !(event.taskLink?.taskId === task.id
    && event.taskLink.projectId === task.projectId && normalize(event.title) === '洗衣服')) };
  const others = options.tasks.filter(other => other.id !== task.id && pending(other));
  const minutes = LAUNDRY_CALENDAR_MINUTES;
  const free = dayAvailability({ calendar, day: date, today, now, profile,
    tasks: others,
    fixed: others.filter(other => routineTaskDate(other) === date && (other.priority ?? 0) < 5
      && !hasHiddenTag(other) && !(other.tags ?? []).some(tag => ['routine', '不关我事'].includes(normalize(tag).toLowerCase()))),
    completed: options.history.filter(record => calendarDateInTimeZone(record.completedTime) === date), estimate: estimateTaskMinutes });
  if (free.remainingMinutes < minutes || !free.slots.some(([start, end]) => end - start >= minutes * 60_000)) return false;
  // Preserve the existing time (including a morning 08:00 reminder), and reject
  // days when that time conflicts instead of silently moving an appointment.
  const start = task.isAllDay === false
    ? Date.parse(shiftTickTickDate(task.startDate ?? task.dueDate, routineTaskDate(task)!, date) ?? '')
    : Date.parse(`${date}T08:00:00+08:00`);
  const end = start + minutes * 60_000;
  const midnight = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(start) || start < now.getTime() || start < midnight + 8 * 3600_000 || end > midnight + 22 * 3600_000
    || (profile === 'evening' && start < midnight + 20 * 3600_000)) return false;
  if ([[11, 14], [18, 20]].some(([from, to]) => start < midnight + to * 3600_000 && end > midnight + from * 3600_000)) return false;
  const intervals = [...calendar.events.map(event => [Date.parse(event.start), Date.parse(event.end)]),
    ...others.filter(other => other.isAllDay === false).map(other => {
      const from = Date.parse(other.startDate ?? other.dueDate ?? '');
      return [from, Math.max(Date.parse(other.dueDate ?? '') || from, from + estimateTaskMinutes(other) * 60_000)];
    })];
  return !intervals.some(([from, to]) => start < to && end > from);
}

const dry = (weather: LaundryWeather) => weather.rain <= 0.2 && weather.probability <= 30 && weather.code <= 3;
const sunny = (weather: LaundryWeather) => dry(weather) && weather.code <= 2 && weather.sunshine >= 4 * 3600;
function weatherRank(date: string, forecast: LaundryForecast) {
  const current = forecast.days[date], next = forecast.days[addDays(date, 1)], previous = forecast.days[addDays(date, -1)];
  if (!current || !next) return null;
  // Consecutive sunny/dry drying days dominate small forecast differences.
  const tier = sunny(current) && sunny(next) ? 3 : dry(current) && dry(next) ? 2 : dry(current) ? 1 : 0;
  return [tier, previous && sunny(previous) && tier === 3 ? 1 : 0,
    -Math.round((current.rain + next.rain) * 2), -Math.round(Math.max(current.probability, next.probability) / 10),
    Math.round((current.sunshine + next.sunshine) / 3600)];
}

export function chooseLaundryDay(task: TickTickTask, target: string, options: PlanOptions,
  forecastFor: (day: string) => LaundryForecast | undefined): string | null {
  const choices: { date: string; rank: number[] }[] = [];
  for (const offset of WEATHER_DAY_OFFSETS) {
    const date = addDays(target, offset);
    if (date < options.today || nextRoutineSceneDate(task, options.calendarState, date) !== date) continue;
    if (!hasTime(task, date, options)) continue;
    const forecast = forecastFor(date);
    if (!forecast || options.now.getTime() - Date.parse(forecast.fetchedAt) < 0
      || options.now.getTime() - Date.parse(forecast.fetchedAt) >= 6 * 3600_000) return null;
    const rank = weatherRank(date, forecast);
    if (!rank) return null; // Missing weather is unknown, never implicitly sunny.
    choices.push({ date, rank: [...rank, -Math.abs(offset), date === routineTaskDate(task) ? 1 : 0, -offset] });
  }
  choices.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
    return 0;
  });
  return choices[0]?.date ?? null;
}

function laundryNote(task: TickTickTask, anchor: Anchor, date: string, options: PlanOptions,
  reason: string, forecast?: LaundryForecast) {
  const completion = calendarDateInTimeZone(anchor.completion, task.timeZone);
  const interval = /FREQ=DAILY(?:;|$)/i.test(anchor.repeatFlag)
    ? Number(/INTERVAL=(\d+)/i.exec(anchor.repeatFlag)?.[1] ?? 1) : null;
  const location = laundryLocation(options.configState, date, options.calendarState);
  const weather = (day: string) => {
    const value = forecast?.days[day];
    return value ? `${day}：降水 ${value.rain} mm，降水概率 ${value.probability}%，日照 ${(value.sunshine / 3600).toFixed(1)} 小时`
      : `${day}：未取得天气数据`;
  };
  const tags = (task.tags ?? []).filter(tag => ['寄', '居', '寓', '旅'].includes(normalize(tag)));
  return ['【洗衣安排原因】',
    `周期：${interval ? `每 ${interval} 天；` : ''}${completion ? `最近实际完成 ${completion}` : '缺少实际完成记录，沿用原周期锚点'}；周期目标 ${anchor.target}，安排 ${date}。`,
    `天气：${weather(date)}；${weather(addDays(date, 1))}。`,
    `场景：${tags.length ? `任务标签 ${tags.join('／')}；` : ''}当日所在地 ${location?.name ?? '城市未知'}。`,
    `安排依据：${reason}。`, '【洗衣安排原因结束】'].join('\n');
}

async function moveLaundry(api: TickTickApi, original: TickTickTask, date: string, note?: string) {
  const task = await api.getTask(original.projectId, original.id);
  // A user completion or edit during forecast loading takes precedence.
  if (!pending(task) || !isLaundryTask(task) || ['startDate', 'dueDate', 'repeatFlag', 'repeatFrom', 'isAllDay', 'timeZone', 'priority', 'tags']
    .some(key => JSON.stringify(task[key as keyof TickTickTask]) !== JSON.stringify(original[key as keyof TickTickTask]))) return undefined;
  const anchor = routineTaskDate(task)!;
  const noteField = task.kind === 'CHECKLIST' ? 'desc' : 'content';
  const oldNote = task[noteField] ?? '';
  const block = /【洗衣安排原因】[\s\S]*?【洗衣安排原因结束】/g;
  const newNote = note === undefined ? oldNote : block.test(oldNote)
    ? oldNote.replace(block, () => note) : `${oldNote}${oldNote ? '\n\n' : ''}${note}`;
  if (anchor === date && newNote === oldNote) return false;
  const payload: Record<string, unknown> = { id: task.id, projectId: task.projectId, title: task.title };
  for (const key of ['content', 'desc', 'isAllDay', 'timeZone', 'reminders', 'tags', 'repeatFlag', 'repeatFrom', 'priority', 'sortOrder', 'kind', 'parentId'] as const)
    if (task[key] !== undefined) payload[key] = task[key];
  if (note !== undefined) payload[noteField] = newNote;
  for (const key of ['startDate', 'dueDate'] as const) if (task[key]) payload[key] = shiftTickTickDate(task[key], anchor, date);
  if (task.items !== undefined) payload.items = task.items.map(item => item.completedTime || Number(item.status ?? 0) !== 0 ? item
    : { ...item, ...(item.startDate ? { startDate: shiftTickTickDate(item.startDate, anchor, date) } : {}) });
  await api.updateTask(task.id, payload);
  const saved = await api.getTask(task.projectId, task.id);
  const sameDate = (a: unknown, b: unknown) => a === b || (typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b));
  if (saved.id !== task.id || saved.projectId !== task.projectId || !pending(saved) || routineTaskDate(saved) !== date
    || (note !== undefined && saved[noteField] !== newNote)
    || ['startDate', 'dueDate'].some(key => payload[key] !== undefined && !sameDate(saved[key as keyof TickTickTask], payload[key]))
    || ['repeatFlag', 'repeatFrom', 'priority', 'isAllDay', 'timeZone', 'parentId'].some(key => String(saved[key as keyof TickTickTask] ?? '') !== String(task[key as keyof TickTickTask] ?? ''))
    || (Array.isArray(payload.items) && payload.items.some(item => {
      const found = saved.items?.find(candidate => candidate.id === item.id);
      return !found || !sameDate(found.startDate, item.startDate)
        || Boolean(found.completedTime || Number(found.status ?? 0)) !== Boolean(item.completedTime || Number(item.status ?? 0));
    }))
    || JSON.stringify([...(saved.tags ?? [])].sort()) !== JSON.stringify([...(task.tags ?? [])].sort())) throw new Error('TickTick 未正确保存洗衣排期');
  return true;
}

export async function syncLaundrySchedule(api: TickTickApi, options: PlanOptions & { connectionId: string; excludedTaskIds?: ReadonlySet<string>; deferState?: (save: () => Promise<unknown>) => void; mode?: 'appointment' | 'travel' | 'weather' }) {
  if (!(options.calendarState as { bonCalRevision?: string } | undefined)?.bonCalRevision) {
    options = { ...options, calendarState: resolveCalendarState(options.configState, options.calendarState) };
  }
  const byId = new Map(options.tasks.map(task => [task.id, task]));
  const excluded = (task: TickTickTask) => {
    const seen = new Set<string>();
    let current: TickTickTask | undefined = task;
    while (current && !seen.has(current.id)) {
      if (options.excludedTaskIds?.has(current.id) || (current.parentId && options.excludedTaskIds?.has(current.parentId))) return true;
      seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };
  const tasks = options.tasks.filter(task => isLaundryTask(task) && pending(task) && !excluded(task) && !isAlwaysTodayTask(task));
  const managedTaskIds = new Set(options.mode && options.mode !== 'weather' ? [] : tasks.map(task => task.id)), decisions: LaundryDecision[] = [];
  if (!tasks.length) return { updated: 0, managedTaskIds, decisions };
  const saved = await kv.get<LaundryState>(LAUNDRY_STATE_KEY);
  const state: LaundryState = saved?.connectionId === options.connectionId ? saved : { connectionId: options.connectionId, anchors: {} };
  const forecasts = new Map<string, Promise<LaundryForecast>>();
  let updated = 0;
  for (const task of tasks) {
    const anchor = laundryAnchor(task, tasks, options.history, state, options.now, options.availability?.events);
    if (!anchor) { decisions.push({ id: task.id, reason: '周期或日期不可用，保留原排期' }); continue; }
    // Persist the original cycle before any write; failed/partial retries cannot drift the window.
    if (options.deferState) { const snapshot = structuredClone(state); options.deferState(() => kv.set(LAUNDRY_STATE_KEY, snapshot)); }
    else await kv.set(LAUNDRY_STATE_KEY, state);
    const day = routineTaskDate(task)!;
    const location = laundryLocation(options.configState, day, options.calendarState);
    const defaultStart = task.isAllDay === false ? Date.parse(task.startDate ?? task.dueDate ?? '') : Date.parse(`${day}T08:00:00+08:00`);
    const defaultDay = Number.isFinite(defaultStart) ? calendarDateInTimeZone(new Date(defaultStart).toISOString()) : null;
    const appointments = (options.availability?.events ?? []).filter(event => event.taskLink?.taskId === task.id
      && event.taskLink.projectId === task.projectId && normalize(event.title) === '洗衣服'
      && defaultDay !== null && calendarDateInTimeZone(event.start) === defaultDay
      && Date.parse(event.end) > Date.parse(event.start)
      && (!anchor.completion || Date.parse(event.start) > Date.parse(anchor.completion)));
    if ((!options.mode || options.mode === 'appointment') && day >= options.today && appointments.length === 1 && Date.parse(appointments[0].start) !== defaultStart) {
      managedTaskIds.add(task.id);
      // A same-day move is an explicit choice, even after the original slot has
      // passed or become busy. Do not let weather planning undo it indirectly.
      if (await moveLaundry(api, task, day, laundryNote(task, anchor, day, options,
        '保留 Outlook 当日调整后的洗衣时段；本轮未按天气重选日期'))) updated++;
      decisions.push({ id: task.id, target: anchor.target, date: day, location: location?.name,
        reason: '保留 Outlook 当日调整后的洗衣时段' });
      continue;
    }
    if (options.mode === 'appointment') continue;
    // The completion-based anchor defines the cycle target for every cadence,
    // including four days; travel, weather and availability still choose the date.
    const beforeTrip = laundryBeforeTrip(anchor.target, options.trips ?? [], calendarDateInTimeZone(anchor.completion, task.timeZone));
    if (beforeTrip && (!options.mode || options.mode === 'travel')) {
      managedTaskIds.add(task.id);
      if (beforeTrip < options.today) {
        decisions.push({ id: task.id, target: anchor.target, reason: '出行前一天已过，保留待办等待补做' });
        continue;
      }
      if (!taskLocationAllowed(task, options.calendarState, beforeTrip)) {
        decisions.push({ id: task.id, target: anchor.target, reason: '出行前一天不符合地点规则或地点未知，保留原排期' });
        continue;
      }
      const changed = await moveLaundry(api, task, beforeTrip, laundryNote(task, anchor, beforeTrip, options,
        '周期目标日位于出行期间，固定到出行前一天；此分支不按天气择日'));
      if (changed) updated++;
      decisions.push(changed === undefined
        ? { id: task.id, target: anchor.target, reason: '任务已由用户更新，保留最新状态' }
        : { id: task.id, target: anchor.target, date: beforeTrip, reason: '周期目标日位于出行期间，固定到出行前一天' });
      continue;
    }
    if (options.mode === 'travel') continue;
    if (!WEATHER_DAY_OFFSETS.some(offset => laundryLocation(options.configState, addDays(anchor.target, offset), options.calendarState))) {
      decisions.push({ id: task.id, target: anchor.target, reason: '尚未设置居的城市，保留原排期' }); continue;
    }
    if (!options.availability) { decisions.push({ id: task.id, target: anchor.target, reason: '日程不可用，保留原排期' }); continue; }
    const weatherByDay = new Map<string, LaundryForecast>(), names = new Map<string, string>();
    for (const offset of WEATHER_DAY_OFFSETS) {
      const date = addDays(anchor.target, offset);
      if (date < options.today || date > addDays(options.today, 14)) continue;
      const location = laundryLocation(options.configState, date, options.calendarState);
      if (!location) continue;
      const key = `${location.latitude.toFixed(3)}:${location.longitude.toFixed(3)}`;
      if (!forecasts.has(key)) forecasts.set(key, readLaundryForecast(location, options.today, options.now));
      try { weatherByDay.set(date, await forecasts.get(key)!); names.set(date, location.name); }
      catch { /* An outage never means dry weather and never blocks unrelated planning. */ }
    }
    const date = chooseLaundryDay(task, anchor.target, options, day => weatherByDay.get(day));
    if (!date) { decisions.push({ id: task.id, target: anchor.target, reason: '暂无完整天气或合适空闲，保留原排期' }); continue; }
    const changed = await moveLaundry(api, task, date, laundryNote(task, anchor, date, options,
      '周期前一天至后两天内优先连续晴天并避开日程冲突，已核对 50 分钟空档', weatherByDay.get(date)));
    if (changed === undefined) { decisions.push({ id: task.id, target: anchor.target, reason: '任务已由用户更新，保留最新状态' }); continue; }
    if (changed) updated++;
    decisions.push({ id: task.id, target: anchor.target, date, location: names.get(date), reason: '周期前一天至后两天内优先连续晴天并避开日程冲突' });
  }
  return { updated, managedTaskIds, decisions };
}
