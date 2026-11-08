import { collectCompleted } from './_ticktickCompleted.js';
import { readAbandonedTodayTaskIds } from './_ticktickAbandoned.js';
import { calendarDateInTimeZone, isAlwaysTodayTask, matchCompletedOccurrences, nextRoutineSceneDate,
  readAllTickTickTasks, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';

// Read-only inspection of a named task. Never return notes, checklist contents,
// connection credentials, or unrelated completion history.
function dateFields(task: TickTickTask) {
  return { id: task.id, projectId: task.projectId, title: task.title, parentId: task.parentId,
    status: task.status, completedTime: task.completedTime, tags: task.tags, priority: task.priority,
    startDate: task.startDate, dueDate: task.dueDate, isAllDay: task.isAllDay,
    timeZone: task.timeZone, repeatFlag: task.repeatFlag };
}

export async function inspectTickTickTaskDate(api: TickTickApi, title: string, calendarState: unknown, now = new Date()) {
  const today = calendarDateInTimeZone(now.toISOString(), 'Asia/Shanghai')!;
  const tasks = await readAllTickTickTasks(api, [0]);
  const matches = tasks.filter(task => task.title.normalize('NFKC').trim() === title.normalize('NFKC').trim());
  if (matches.length > 10) throw new Error('同名任务过多，无法核对');
  if (!matches.length) return { today, tasks: [] };
  const [current, completed, abandoned] = await Promise.all([
    Promise.all(matches.map(async task => {
      const current = await api.getTask(task.projectId, task.id);
      if (!current || current.id !== task.id || current.projectId !== task.projectId) throw new Error('任务详情未确认');
      return current;
    })),
    collectCompleted(api, [...new Set(matches.map(task => task.projectId))],
      Date.parse(`${today}T00:00:00+08:00`), Date.parse(`${today}T23:59:59.999+08:00`), Date.now() + 55_000),
    readAbandonedTodayTaskIds(api, tasks, today, now),
  ]);
  const wasCompleted = matchCompletedOccurrences(tasks, completed.filter(task => task.status === 2
    && task.completedTime && Date.parse(task.completedTime) <= now.getTime()
    && calendarDateInTimeZone(task.completedTime, 'Asia/Shanghai') === today));
  return { today, tasks: current.map((task, i) => ({ snapshot: dateFields(matches[i]), current: dateFields(task),
    alwaysToday: isAlwaysTodayTask(task), completedToday: wasCompleted(task), abandonedToday: abandoned.has(task.id),
    nextSceneDate: nextRoutineSceneDate(task, calendarState, today) })) };
}
