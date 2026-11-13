import { kv } from './_accountKv.js';
import { DEFAULT_CYCLE, type CycleSettings } from '../src/utils/bonLife.js';
import { afterMenstrualPeriod, cycleDay } from '../src/utils/lifeCycle.js';
import { isCalendarDate } from '../src/utils/outlookCalendar.js';
import { isHairWashTitle, swimmingHairWashDates, type HairWashSchedule } from '../src/utils/lifeSwimming.js';
import { isTrainingTitle } from '../src/utils/lifeTraining.js';
import { LIFE_CONNECTION_KEY, LIFE_SETTINGS_KEY, readPeriodDays, syncLifePeriods, type LifeConnection } from './_bonLife.js';
import { acquireTickTickLock, releaseTickTickLock } from './_ticktickLock.js';
import { decryptTickTickToken, isAlwaysTodayTask, readAllTickTickTasks, routineRecurrence, shiftTickTickDate, TICKTICK_CONNECTION_KEY,
  TickTickOpenApiClient, type TickTickApi, type TickTickConnection, type TickTickTask } from './_ticktickTrips.js';

const DAY = 86_400_000;
const shanghaiToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export function swimmingTaskDate(value: string | undefined, timeZone = 'Asia/Shanghai'): string | null {
  if (!value) return null;
  const date = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date(value)) : value.slice(0, 10);
  if (!isCalendarDate(date)) throw new Error('游泳待办日期无效');
  return date;
}

export async function readSwimmingCycle(years: number[]) {
  const [settings, periods] = await Promise.all([
    kv.hgetall<{ cycle: CycleSettings }>(LIFE_SETTINGS_KEY),
    Promise.all([...new Set(years)].map(readPeriodDays)),
  ]);
  return { cycle: settings?.cycle ?? DEFAULT_CYCLE, periods: [...new Set(periods.flat())].sort() };
}

function pendingSwim(task: TickTickTask) {
  return task.title.includes('游泳') && !isAlwaysTodayTask(task) && (task.status ?? 0) === 0 && !task.completedTime;
}

export function readHairWashSchedule(tasks: TickTickTask[]): HairWashSchedule | null {
  const anchors = tasks.filter(task => isHairWashTitle(task.title) && (task.status ?? 0) === 0 && !task.completedTime);
  if (anchors.length > 1) throw new Error('找到多个洗头待办，请保留一个日期来源');
  const task = anchors[0];
  if (!task) return null;
  if (routineRecurrence(task.repeatFlag) === 'unknown') throw new Error('洗头重复规则暂不支持');
  return { scheduledDate: swimmingTaskDate(task.startDate || task.dueDate, task.timeZone) ?? undefined,
    repeatFlag: task.repeatFlag, repeatFrom: task.repeatFrom };
}

export function followsSwimmingHairWash(task: TickTickTask) {
  return task.title.includes('游泳') && (isTrainingTitle(task.title) || /^游泳(?:\s*[-—–:：]|\s*$)/.test(task.title.trim())
    || (task.tags ?? []).some(tag => isHairWashTitle(tag)));
}

export function swimmingTarget(task: TickTickTask, today: string, cycle: CycleSettings, periods: string[], hairWash?: HairWashSchedule | null) {
  if (!pendingSwim(task)) return null;
  const start = swimmingTaskDate(task.startDate || task.dueDate, task.timeZone);
  if (!start) return null;
  const due = swimmingTaskDate(task.dueDate, task.timeZone) || start;
  const duration = Math.max(0, Math.round((Date.parse(due) - Date.parse(start)) / DAY));
  // Overdue tasks are still pending today; never move an old task to another past date.
  let target = start < today ? today : start;
  if (duration > 90) throw new Error('游泳待办跨度过长，请检查日期');
  if (followsSwimmingHairWash(task)) {
    const next = swimmingHairWashDates(hairWash, target, addDays(target, 730), cycle, periods, duration)[0];
    return next && next !== start ? next : null;
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    let conflict: string | null = null;
    for (let offset = 0; offset <= duration; offset++) {
      const date = addDays(target, offset);
      if (cycleDay(date, cycle, periods)?.phase === 'menstrual') { conflict = date; break; }
    }
    if (!conflict) return target === start || (start < today && target === today) ? null : target;
    target = afterMenstrualPeriod(conflict, cycle, periods);
  }
  throw new Error('游泳待办无法避开经期，请检查日期');
}

export async function postponeSwimmingTasks(api: TickTickApi, tasks: TickTickTask[], today: string, cycle: CycleSettings, periods: string[]) {
  let updated = 0;
  const hairWash = readHairWashSchedule(tasks);
  for (const candidate of tasks.filter(pendingSwim)) {
    if (!swimmingTarget(candidate, today, cycle, periods, hairWash)) continue;
    // Re-read immediately before writing so a just-completed or edited task is respected.
    const task = await api.getTask(candidate.projectId, candidate.id);
    if (!task || task.id !== candidate.id || task.projectId !== candidate.projectId) throw new Error('游泳待办读取失败');
    // Confirm the anchor again before writing: washing dates can move when the
    // completion-based recurring task is completed on another device.
    const anchorTask = tasks.find(task => isHairWashTitle(task.title) && (task.status ?? 0) === 0 && !task.completedTime);
    const latestWash = anchorTask ? await api.getTask(anchorTask.projectId, anchorTask.id) : null;
    if (anchorTask && (!latestWash || latestWash.id !== anchorTask.id || latestWash.projectId !== anchorTask.projectId)) throw new Error('洗头待办读取失败');
    const target = swimmingTarget(task, today, cycle, periods, latestWash ? readHairWashSchedule([latestWash]) : hairWash);
    if (!target) continue;
    const anchor = swimmingTaskDate(task.startDate || task.dueDate, task.timeZone)!;
    const shift = (date: string | undefined) => shiftTickTickDate(date, anchor, target);
    const payload = {
      id: task.id, projectId: task.projectId, title: task.title,
      content: task.content, desc: task.desc, isAllDay: task.isAllDay,
      startDate: shift(task.startDate), dueDate: shift(task.dueDate), timeZone: task.timeZone,
      reminders: task.reminders, tags: task.tags, repeatFlag: task.repeatFlag,
      ...(task.repeatFrom !== undefined ? { repeatFrom: task.repeatFrom } : {}),
      priority: task.priority, sortOrder: task.sortOrder, kind: task.kind, parentId: task.parentId,
      items: task.items?.map((item) => item.completedTime || Number(item.status ?? 0) !== 0
        ? item : { ...item, startDate: shift(item.startDate) }),
    };
    await api.updateTask(task.id, payload);
    const saved = await api.getTask(task.projectId, task.id);
    const sameDate = (a?: string, b?: string) => a === b || Boolean(a && b && Date.parse(a) === Date.parse(b));
    if (!saved || saved.id !== task.id || saved.projectId !== task.projectId
      || !sameDate(saved.startDate, payload.startDate) || !sameDate(saved.dueDate, payload.dueDate)
      || (saved.repeatFlag || '') !== (task.repeatFlag || '')
      || String(saved.repeatFrom ?? '') !== String(task.repeatFrom ?? '')
      || payload.items?.some((item) => item.id && item.startDate && !sameDate(saved.items?.find((value) => value.id === item.id)?.startDate, item.startDate))) {
      throw new Error('游泳待办顺延未确认，请重新同步');
    }
    updated++;
  }
  return updated;
}

export async function syncSwimmingSchedule(options: { lockHeld?: boolean; refreshPeriods?: boolean } = {}) {
  if (options.refreshPeriods) {
    const calendar = await kv.get<LifeConnection>(LIFE_CONNECTION_KEY);
    if (calendar) await syncLifePeriods(calendar, Number(shanghaiToday().slice(0, 4)));
  }
  const { runRuleReplan } = await import('./_ruleReplan.js');
  const result = await runRuleReplan({ scope: 'visibility', specialty: 'swimming', lockHeld: options.lockHeld, allowDisconnected: true })
    .catch(error => { throw new Error('TickTick 游泳待办顺延失败，请重新同步', { cause: error }); });
  if (result.busy) throw new Error('TickTick 正在同步，游泳待办稍后重试');
  const rule = result.rules?.results.find(item => item.id === 'swimming');
  if (rule && rule.status !== 'success') throw new Error('TickTick 游泳待办顺延失败，请查看规则前序与执行状态');
  return { updated: result.updated ?? 0 };
}

// Saving the cycle must remain successful even if the independent TickTick write fails.
export async function swimmingSyncWarning() {
  try { await syncSwimmingSchedule(); return ''; }
  catch (error) { return error instanceof Error ? error.message : 'TickTick 游泳待办顺延失败，请重新同步'; }
}
