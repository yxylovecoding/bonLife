import { routineTaskDate, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';
import { localEventTime } from './_outlookTaskEvents.js';
import { syncRecurringTaskOutlook, type RecurringTaskEventOptions } from './_outlookRecurringTaskEvents.js';
import { isPendingTickTickTask as pending } from './_ticktickTaskState.js';

export const CHARGING_EVENT_PROPERTY = 'String {d9d1e730-7742-4a9c-91af-bab2a9a45f69} Name BonBillsCharging';
const isCharging = (task: TickTickTask) => task.title.normalize('NFKC').trim() === '电动车充电'
  && !(task.tags ?? []).some(tag => tag.normalize('NFKC').trim() === '不关我事');

export function chargingEventPlan(task: TickTickTask, today: string) {
  const day = routineTaskDate(task);
  if (!isCharging(task) || !pending(task) || !day || day < today) return null;
  const start = Date.parse(task.startDate ?? ''), end = Date.parse(task.dueDate ?? '');
  if (task.isAllDay !== false || !Number.isFinite(start) || !(end > start)) return null;
  return { subject: '电动车充电', start: localEventTime(start), end: localEventTime(end) };
}

export function syncChargingOutlook(api: TickTickApi, options: RecurringTaskEventOptions) {
  return syncRecurringTaskOutlook(api, options, {
    timeSource: 'task',
    subject: '电动车充电', propertyId: CHARGING_EVENT_PROPERTY, statePrefix: 'outlook:charging-events:v1',
    cyclesKey: 'ticktick:charging-cycles:v1', plan: task => chargingEventPlan(task, options.today),
  });
}
