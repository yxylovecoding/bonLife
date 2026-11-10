import { kv } from './_accountKv.js';
import ICAL from 'ical.js';
import { cycleDay } from '../src/utils/lifeCycle.js';
import type { CycleSettings } from '../src/utils/bonLife.js';
import { swimmingHairWashDates, type HairWashSchedule } from '../src/utils/lifeSwimming.js';
import { isTrainingTitle, recordedTrainingProjects, rollingTrainingPlan, trainingIdentity, trainingLibrary,
  trainingName, trainingProjectKey, type TrainingSource, type TrainingTask } from '../src/utils/lifeTraining.js';
import { readHairWashSchedule, readSwimmingCycle } from './_lifeSwimming.js';
import { hasTaskLocation } from './_ticktickLocation.js';
import { calendarDateInTimeZone, getTickTickRoutineTargetDates, isAlwaysTodayTask, readAllTickTickTasks, routineRecurrence,
  routineSceneMatchesDate, readRoutineCalendarState, shiftTickTickDate, TICKTICK_SYNC_STATE_KEY,
  type TickTickApi, type TickTickTask, type TickTickTripSyncState } from './_ticktickTrips.js';

export const EXERCISE_STATE_KEY = 'ticktick:exercise-rollover:v1';
const DAY = 86_400_000;
const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY).toISOString().slice(0, 10);
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();

// Match actual training titles, not equipment, preparation, events or consultations.
export function isExerciseTask(task: TickTickTask): boolean {
  if ((task.tags ?? []).some(tag => normalize(tag) === '不关我事')) return false;
  const title = normalize(task.title);
  return isTrainingTitle(task.title) || /^(?:全身力训|臀腿|hiit|上半身|有氧|游泳|力量训练|跑步|骑行)(?:\s*[-—–:：]|$)/.test(title)
    || title === '运动💪🏻是生活的第一个锚点🪝';
}

function taskDay(task: TickTickTask) {
  return calendarDateInTimeZone(task.dueDate || task.startDate, task.timeZone);
}

function localDay(now: Date, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, late: Number(parts.hour) >= 22 };
}

interface TargetOptions {
  now: Date;
  calendarState: unknown;
  cycle?: CycleSettings;
  periods?: string[];
  notBefore?: string;
  hairWash?: HairWashSchedule | null;
}

export function exerciseTarget(task: TickTickTask, options: TargetOptions): string | null {
  if (!isExerciseTask(task) || isAlwaysTodayTask(task) || (task.status ?? 0) !== 0 || task.completedTime) return null;
  const scheduled = taskDay(task);
  if (!scheduled) return null; // In particular, leave the undated training parent alone.
  let current: ReturnType<typeof localDay>;
  try { current = localDay(options.now, task.timeZone); } catch { return null; }
  const missed = scheduled < current.day || (scheduled === current.day && current.late);
  if (!missed && (!options.notBefore || scheduled >= options.notBefore)) return null;
  const from = [current.late ? addDays(current.day, 1) : current.day, options.notBefore ?? ''].sort().at(-1)!;
  const allowed = (day: string) => {
    if (!routineSceneMatchesDate(task, options.calendarState, day)) return false;
    return !task.title.includes('游泳') || (options.cycle !== undefined
      && cycleDay(day, options.cycle, options.periods ?? [])?.phase !== 'menstrual');
  };
  if (task.title.includes('游泳')) {
    if (!options.cycle) return null;
    return swimmingHairWashDates(options.hairWash, from, addDays(from, 730), options.cycle, options.periods ?? [])
      .find(day => day > scheduled && allowed(day)) ?? null;
  }
  if (!task.repeatFlag) {
    for (let offset = 0; offset < 730; offset++) {
      const day = addDays(from, offset);
      if (day > scheduled && allowed(day)) return day;
    }
    return null;
  }
  // Moving a finite rule's start could reset COUNT/UNTIL semantics. Leave it
  // unchanged, as well as unsupported or sub-day repeat rules.
  if (routineRecurrence(task.repeatFlag) === 'unknown' || /(?:COUNT|UNTIL|BYHOUR|BYMINUTE|BYSECOND)=/i.test(task.repeatFlag)) return null;
  try {
    const rule = ICAL.Recur.fromString(task.repeatFlag.replace(/^RRULE:/i, ''));
    const iterator = rule.iterator(ICAL.Time.fromDateString(scheduled));
    for (let i = 0; i < 5000; i++) {
      const next = iterator.next();
      if (!next) break;
      const day = next.toString().slice(0, 10);
      if (day > addDays(current.day, 730)) break;
      if (day > scheduled && day >= from && allowed(day)) return day;
    }
  } catch { /* An unrecognized recurrence must not become a daily repeat. */ }
  return null;
}

interface Deferral { projectId: string; repeatFlag: string; notBefore: string }
interface ExerciseState { connectionId: string; deferrals: Record<string, Deferral> }

export function rollingExerciseDates(today: string, source: TrainingSource, cycle: CycleSettings, periods: string[], allowed?: (task: TrainingTask, date: string) => boolean) {
  const library = trainingLibrary(source.tasks, source.settings);
  const dates = new Map<string, string>();
  const months = new Map<string, ReturnType<typeof rollingTrainingPlan>>();
  // Look beyond this week when menstruation, recovery or recent completions
  // postpone a project. Every month still starts from the same actual history.
  for (let offset = 0; offset < 90; offset++) {
    const date = addDays(today, offset);
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, rollingTrainingPlan(Number(date.slice(0, 4)), Number(date.slice(5, 7)), today, source, cycle, periods, {}, allowed));
    const forecast = months.get(month)!;
    const record = forecast.plans.get(date);
    if (!record || record.completed) continue;
    for (const key of recordedTrainingProjects(record, library)) {
      const task = library.find(task => trainingIdentity(task) === key);
      if (task && allowed && !allowed(task, date)) continue;
      if (!dates.has(key) && !forecast.completedByDate.get(date)?.has(key)) dates.set(key, date);
    }
  }
  return dates;
}

function deferredDate(task: TickTickTask, state: ExerciseState) {
  const saved = state.deferrals[task.id];
  return saved?.projectId === task.projectId && saved.repeatFlag === (task.repeatFlag ?? '') ? saved.notBefore : undefined;
}

async function moveExercise(api: TickTickApi, task: TickTickTask, target: string) {
  const anchor = taskDay(task)!;
  const payload: Record<string, unknown> = { id: task.id, projectId: task.projectId, title: task.title };
  for (const key of ['content', 'desc', 'isAllDay', 'timeZone', 'reminders', 'tags', 'repeatFlag', 'repeatFrom',
    'priority', 'sortOrder', 'kind', 'parentId'] as const) {
    if (task[key] !== undefined) payload[key] = task[key];
  }
  for (const key of ['startDate', 'dueDate'] as const) {
    if (task[key]) payload[key] = shiftTickTickDate(task[key], anchor, target);
  }
  const items = task.items?.map(item => item.completedTime || Number(item.status ?? 0) !== 0
    ? item : { ...item, ...(item.startDate ? { startDate: shiftTickTickDate(item.startDate, anchor, target) } : {}) });
  if (items !== undefined) payload.items = items;
  // Changing the date is a skip, never a completion or a new history entry.
  await api.updateTask(task.id, payload);
  const saved = await api.getTask(task.projectId, task.id);
  const sameDate = (left: unknown, right: unknown) => left === right
    || (typeof left === 'string' && typeof right === 'string' && Date.parse(left) === Date.parse(right));
  if (saved?.id !== task.id || saved.projectId !== task.projectId || taskDay(saved) !== target
    || (saved.repeatFlag ?? '') !== (task.repeatFlag ?? '') || String(saved.repeatFrom ?? '') !== String(task.repeatFrom ?? '')
    || (['startDate', 'dueDate'] as const).some(key => !sameDate(saved[key], payload[key]))
    || items?.some(item => item.id && !sameDate(saved.items?.find(value => value.id === item.id)?.startDate, item.startDate))) {
    throw new Error('TickTick 运动待办跳过未确认，请重新同步');
  }
}

// Callers hold the shared TickTick write lock. Persist date floors so scene and
// hair-wash alignment cannot pull skipped workouts back into a missed day.
export async function syncExerciseSchedule(api: TickTickApi, options: {
  connectionId: string;
  templateRootId?: string;
  now?: Date;
  tasks?: TickTickTask[];
  calendarState?: unknown;
  excludedTaskIds?: ReadonlySet<string>;
  rolling?: boolean;
  rollingOnly?: boolean;
  acceptsDate?: (id: string, date: string) => boolean;
  deferState?: (save: () => Promise<unknown>) => void;
}) {
  const now = options.now ?? new Date();
  const [tasks, calendarState, previous, trips] = await Promise.all([
    options.tasks ?? readAllTickTickTasks(api, [0]),
    options.calendarState ?? readRoutineCalendarState(api),
    kv.get<ExerciseState>(EXERCISE_STATE_KEY),
    options.excludedTaskIds ? null : kv.get<TickTickTripSyncState>(TICKTICK_SYNC_STATE_KEY),
  ]);
  const excluded = new Set(options.excludedTaskIds);
  if (options.templateRootId) excluded.add(options.templateRootId);
  for (const instance of [...Object.values(trips?.instances ?? {}), ...Object.values(trips?.wishInstances ?? {})]) {
    if (instance.rootTaskId) excluded.add(instance.rootTaskId);
    for (const id of Object.values(instance.taskIdsByTemplateId)) excluded.add(id);
  }
  const byId = new Map(tasks.map(task => [task.id, task]));
  const eligible = (task: TickTickTask) => {
    if (!isExerciseTask(task) || isAlwaysTodayTask(task)) return false;
    const visited = new Set<string>();
    let current: TickTickTask | undefined = task;
    while (current && !visited.has(current.id)) {
      if (excluded.has(current.id) || (current.parentId && excluded.has(current.parentId))) return false;
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return true;
  };
  const candidates = tasks.filter(eligible);
  const managedTaskIds = new Set<string>();
  const fixedDates = new Map<string, string>();
  let updated = 0;
  if (options.rolling && candidates.some(task => isTrainingTitle(task.title))) {
    const current = localDay(now);
    // Nightly rollover must use the same cutoff as standalone workouts. Start
    // a fresh forecast tomorrow; today's missed plan is not a completion.
    const today = current.late ? addDays(current.day, 1) : current.day;
    const { syncTrainingSource } = await import('./_lifeTraining.js');
    const source = await syncTrainingSource(Number(today.slice(0, 4)), { lockHeld: true, api, publish: !options.deferState });
    // Template/trip tasks and ignored tasks cannot add projects to the rotation.
    const candidateById = new Map(candidates.map(task => [`${task.projectId}:${task.id}`, task]));
    source.tasks = source.tasks.filter(task => candidateById.has(task.id));
    const { cycle, periods } = await readSwimmingCycle([Number(today.slice(0, 4)), Number(addDays(today, 90).slice(0, 4))]);
    const dates = rollingExerciseDates(today, source, cycle, periods, (project, date) => {
      const task = candidateById.get(project.id);
      return !task || routineSceneMatchesDate(task, calendarState, date);
    });
    const library = trainingLibrary(source.tasks, source.settings);
    const keyFor = (task: TickTickTask) => {
      const raw = trainingProjectKey(trainingName(task.title));
      const project = library.find(project => project.id === `${task.projectId}:${task.id}` || trainingIdentity(project) === raw);
      return project ? trainingIdentity(project) : raw;
    };
    for (const candidate of candidates.filter(task => isTrainingTitle(task.title))) {
      const target = dates.get(keyFor(candidate));
      // Missing hair-wash or location eligibility must not fall back to standalone recurrence.
      if (!target && (candidate.title.includes('游泳') || hasTaskLocation(candidate, calendarState))) { managedTaskIds.add(candidate.id); continue; }
      if (!target || !taskDay(candidate)) continue;
      managedTaskIds.add(candidate.id);
      fixedDates.set(candidate.id, target);
      if (taskDay(candidate) === target) continue;
      const task = await api.getTask(candidate.projectId, candidate.id);
      if (task?.id !== candidate.id || task.projectId !== candidate.projectId) throw new Error('运动待办读取失败');
      if ((task.status ?? 0) !== 0 || task.completedTime) throw new Error('训练完成状态已变化，请再次运行 Orchestrate');
      if (!eligible(task) || keyFor(task) !== keyFor(candidate) || !routineSceneMatchesDate(task, calendarState, target)) throw new Error('训练项目已变化，请再次运行 Orchestrate');
      await moveExercise(api, task, target);
      updated++;
    }
  }
  const state: ExerciseState = { connectionId: options.connectionId, deferrals: {} };
  if (previous?.connectionId === options.connectionId) {
    for (const task of candidates) {
      if (!managedTaskIds.has(task.id) && deferredDate(task, previous)) state.deferrals[task.id] = previous.deferrals[task.id];
    }
  }
  const swimming = candidates.some(task => task.title.includes('游泳') && taskDay(task));
  const periodData = swimming ? await readSwimmingCycle([now.getUTCFullYear(), now.getUTCFullYear() + 1]) : {};
  for (const candidate of options.rollingOnly ? [] : candidates) {
    if (managedTaskIds.has(candidate.id)) continue;
    const targetOptions = { now, calendarState, ...periodData, hairWash: swimming ? readHairWashSchedule(tasks) : null, notBefore: deferredDate(candidate, state) };
    if (!exerciseTarget(candidate, targetOptions)) continue;
    const task = await api.getTask(candidate.projectId, candidate.id);
    if (task?.id !== candidate.id || task.projectId !== candidate.projectId) throw new Error('运动待办读取失败');
    if (!eligible(task)) continue;
    const target = exerciseTarget(task, { ...targetOptions, notBefore: deferredDate(task, state) });
    if (!target) continue;
    state.deferrals[task.id] = { projectId: task.projectId, repeatFlag: task.repeatFlag ?? '', notBefore: target };
    if (!options.deferState) await kv.set(EXERCISE_STATE_KEY, state);
    await moveExercise(api, task, target);
    updated++;
  }
  if (options.deferState) options.deferState(() => kv.set(EXERCISE_STATE_KEY, { ...state, deferrals: Object.fromEntries(Object.entries(state.deferrals)
    .filter(([id, value]) => !options.acceptsDate || options.acceptsDate(id, value.notBefore))) }));
  const minimumDates = new Map(Object.entries(state.deferrals).map(([id, saved]) => [id, saved.notBefore]));
  return { updated, minimumDates, managedTaskIds, fixedDates };
}
