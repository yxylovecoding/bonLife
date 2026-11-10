import type { CycleSettings } from '../src/utils/bonLife.js';
import { hairWashDates, type HairWashSchedule } from '../src/utils/lifeSwimming.js';
import { cycleDay } from '../src/utils/lifeCycle.js';
import { taskLocationAllowed } from './_ticktickLocation.js';
import { calendarDateInTimeZone, routineTaskDate, type TickTickTask } from './_ticktickTrips.js';

// A washing day and a location are compatible constraints, not competing dates.
export function hairWashLocationDate(task: TickTickTask, schedule: HairWashSchedule | null, from: string,
  calendarState: unknown, swimming?: { cycle: CycleSettings; periods: string[] }): string | null {
  if (!schedule?.scheduledDate) return null;
  const start = calendarDateInTimeZone(task.startDate || task.dueDate, task.timeZone);
  const due = routineTaskDate(task);
  const duration = start && due ? Math.max(0, Math.round((Date.parse(due) - Date.parse(start)) / 86400000)) : 0;
  if (duration > 90) throw new Error('洗头跟随待办跨度过长');
  const through = new Date(Date.parse(`${from}T00:00:00Z`) + 730 * 86400000).toISOString().slice(0, 10);
  const dates = hairWashDates(schedule, from, through);
  // routineTaskPayload aligns the due date; validate the whole shifted span.
  return dates.find(date => Array.from({ length: duration + 1 }, (_, offset) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + (offset - duration) * 86400000).toISOString().slice(0, 10))
    .every(day => taskLocationAllowed(task, calendarState, day)
      && (!swimming || cycleDay(day, swimming.cycle, swimming.periods)?.phase !== 'menstrual'))) ?? null;
}
