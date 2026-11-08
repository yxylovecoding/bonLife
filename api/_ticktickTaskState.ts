import type { TickTickTask } from './_ticktickTrips.js';

// TickTick can retain an old completedTime on an explicitly reopened task.
// Status is authoritative; only use the timestamp when status is absent.
export const isPendingTickTickTask = (task: TickTickTask) => task.status === 0
  || task.status == null && !task.completedTime;

// Still stop a write when a completion appeared after its planning snapshot.
export function hasNewTaskCompletion(task: TickTickTask, previous: TickTickTask) {
  return Boolean(task.completedTime && task.completedTime !== previous.completedTime
    && (!previous.completedTime || !Number.isFinite(Date.parse(task.completedTime))
      || Date.parse(task.completedTime) !== Date.parse(previous.completedTime)));
}
