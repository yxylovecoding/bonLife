import { kv } from './_accountKv.js';
import { hasTaskLocation, taskLocationAllowed, taskLocationUnavailable } from './_ticktickLocation.js';
import { calendarDateInTimeZone, readAllTickTickTasks, readRoutineCalendarState,
  type TickTickApi, type TickTickTask } from './_ticktickTrips.js';
import { hairWashHidden, hasHiddenTag, nightRoutineHidden, readingHidden, timedTaskHidden, writeHiddenTag } from './_ticktickNightRoutine.js';
import { sleepWindow } from './_ticktickSleepTags.js';

export const LOCATION_HIDDEN_KEY = 'ticktick:location-hidden:v1';
type Journal = Record<string, { projectId: string; id: string }>;

// Own only tags we add. Keep the journal before writing so a lost response can
// be recovered; never remove an unrelated user-owned hidden/routine tag.
export async function syncTickTickLocationVisibility(api: TickTickApi, options: {
  tasks?: TickTickTask[]; calendarState?: unknown; now?: Date;
} = {}) {
  const now = options.now ?? new Date(), today = calendarDateInTimeZone(now.toISOString(), 'Asia/Shanghai')!;
  const [tasks, calendarState, saved] = await Promise.all([
    options.tasks ?? readAllTickTickTasks(api, [0]), options.calendarState ?? readRoutineCalendarState(api),
    kv.get<Journal>(LOCATION_HIDDEN_KEY),
  ]);
  const journal = saved ?? {}, result = { hidden: 0, restored: 0 };
  const persist = () => kv.set(LOCATION_HIDDEN_KEY, journal);
  const otherwiseHidden = (task: TickTickTask) => sleepWindow(now).hidden
    || [hairWashHidden(task, now), readingHidden(task, now), nightRoutineHidden(task, now), timedTaskHidden(task, now)]
      .some(hidden => hidden === true);
  for (const candidate of tasks) {
    if ((candidate.status ?? 0) !== 0 || candidate.completedTime) continue;
    const key = JSON.stringify([candidate.projectId, candidate.id]);
    if (!journal[key] && !hasTaskLocation(candidate, calendarState)) continue;
    if (taskLocationUnavailable(candidate, calendarState, today)) throw new Error('地点读取失败，保留当前显隐');
    const allowed = taskLocationAllowed(candidate, calendarState, today);
    if (allowed ? !journal[key] || otherwiseHidden(candidate) : hasHiddenTag(candidate)) continue;
    const task = await api.getTask(candidate.projectId, candidate.id);
    if (!task || task.id !== candidate.id || task.projectId !== candidate.projectId) throw new Error('地点标签待办读取失败');
    Object.assign(candidate, task);
    if ((task.status ?? 0) !== 0 || task.completedTime) continue;
    if (taskLocationUnavailable(task, calendarState, today)) throw new Error('地点读取失败，保留当前显隐');
    if (!taskLocationAllowed(task, calendarState, today)) {
      if (hasHiddenTag(task)) continue;
      journal[key] = { projectId: task.projectId, id: task.id };
      await persist();
      Object.assign(candidate, await writeHiddenTag(api, task, true));
      result.hidden++;
    } else if (journal[key]) {
      if (otherwiseHidden(task)) continue;
      if (hasHiddenTag(task)) {
        Object.assign(candidate, await writeHiddenTag(api, task, false));
        result.restored++;
      }
      delete journal[key];
      await persist();
    }
  }
  return result;
}
