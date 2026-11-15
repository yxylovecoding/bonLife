import { estimateCycle } from '../src/utils/lifeCycle.js';
import { readSwimmingCycle } from './_lifeSwimming.js';
import { calendarDateInTimeZone, type TickTickApi, type TickTickTask, type TickTickConnection } from './_ticktickTrips.js';

const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export const PERIOD_PREDICTION_TITLE = '月经提醒';

export async function syncPeriodPredictionTask(api: TickTickApi, options: {
  connection: TickTickConnection,
  tasks: TickTickTask[],
  completedTasks: TickTickTask[],
  today: string,
}) {
  const { connection, tasks, completedTasks, today } = options;
  const year = Number(today.slice(0, 4));
  // January still needs the previous year's cycle anchor.
  const { cycle, periods } = await readSwimmingCycle([year - 1, year, year + 1]);

  const prediction = estimateCycle(cycle, periods, today);
  if (!prediction.nextPeriodStart) return { updated: 0, created: 0 };

  const targetDate = addDays(prediction.nextPeriodStart, -2);
  const isReminder = (task: TickTickTask) => task.title === PERIOD_PREDICTION_TITLE && task.projectId === connection.projectId;
  const pending = (task: TickTickTask) => (task.status ?? 0) === 0 && !task.completedTime;
  const reminderDate = (task: TickTickTask) => calendarDateInTimeZone(task.startDate || task.dueDate);
  // Use the recorded period start, not the changing prediction, as the cycle
  // boundary. Prefer the reminder's scheduled date so a late completion from
  // the previous cycle cannot suppress the next cycle's reminder.
  const completed = [...completedTasks, ...tasks].filter(task => isReminder(task)
    && (task.status === 2 || Boolean(task.completedTime))
    && (reminderDate(task) ?? calendarDateInTimeZone(task.completedTime) ?? '') >= prediction.lastPeriodStart);
  if (completed.length) {
    const duplicateDates = new Set([targetDate, ...completed.map(reminderDate).filter((date): date is string => Boolean(date))]);
    const isDuplicate = (task: TickTickTask) => isReminder(task) && pending(task)
      && task.isAllDay === true && task.priority === 5 && task.tags?.includes('当天')
      && !task.repeatFlag && !task.parentId && !task.content && !task.desc && !task.items?.length
      && duplicateDates.has(reminderDate(task) ?? '')
      && calendarDateInTimeZone(task.startDate) === calendarDateInTimeZone(task.dueDate);
    let deleted = 0;
    for (const candidate of tasks.filter(isDuplicate)) {
      const current = await api.getTask(candidate.projectId, candidate.id);
      if (!current || current.id !== candidate.id || current.projectId !== candidate.projectId) {
        throw new Error('月经提醒读取失败，未清理重复待办');
      }
      if (!isDuplicate(current)) continue;
      await api.deleteTask(current.projectId, current.id);
      deleted++;
    }
    return { updated: 0, created: 0, deleted };
  }
  const existing = tasks.find(task => isReminder(task) && pending(task));

  const priority = 5;
  const tags = [...new Set([...(existing?.tags ?? []).filter(tag => tag !== '活'), '当天'])];
  const startDate = `${targetDate}T00:00:00+0800`;
  const dueDate = `${targetDate}T00:00:00+0800`;
  const isAllDay = true;

  if (existing) {
    const currentStartDate = calendarDateInTimeZone(existing.startDate);
    const currentDueDate = calendarDateInTimeZone(existing.dueDate);

    const needsUpdate = currentStartDate !== targetDate
      || currentDueDate !== targetDate
      || existing.priority !== priority
      || existing.isAllDay !== isAllDay
      || JSON.stringify([...(existing.tags ?? [])].sort()) !== JSON.stringify([...tags].sort());

    if (needsUpdate) {
      await api.updateTask(existing.id, {
        id: existing.id,
        projectId: existing.projectId,
        title: PERIOD_PREDICTION_TITLE,
        startDate,
        dueDate,
        isAllDay,
        priority,
        tags,
      });
      return { updated: 1, created: 0 };
    }
    return { updated: 0, created: 0 };
  } else {
    // Only create if the prediction is in the future.
    // If overdue (nextPeriodStart <= today), we don't create a new reminder.
    if (prediction.nextPeriodStart > today) {
       await api.createTask({
         projectId: connection.projectId,
         title: PERIOD_PREDICTION_TITLE,
         startDate,
         dueDate,
         isAllDay,
         priority,
         tags,
       });
       return { updated: 0, created: 1 };
    }
  }
  return { updated: 0, created: 0 };
}
