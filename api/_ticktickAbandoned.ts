import { calendarDateInTimeZone, routineOccurrenceKey, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';

import { isPendingTickTickTask as pending } from './_ticktickTaskState.js';
const identity = (task: TickTickTask) => JSON.stringify([task.projectId, task.id]);

// Abandoning an occurrence advances the repeating task just like completion,
// but must never become completion history or consume the day's time budget.
export function abandonedTodayTaskIds(tasks: TickTickTask[], records: TickTickTask[], today: string, now = new Date()): Set<string> {
  const open = tasks.filter(pending), counts = new Map<string, number>();
  for (const task of open) {
    const family = routineOccurrenceKey(task);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const ids = new Set<string>(), families = new Set<string>();
  for (const record of records) {
    if (record.status !== -1) continue;
    if (!record.id || !record.projectId || !record.title || !record.completedTime
      || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(record.completedTime) || !Number.isFinite(Date.parse(record.completedTime))) {
      throw new Error('TickTick 放弃记录无效，保留当前排期');
    }
    if (Date.parse(record.completedTime) > now.getTime() || calendarDateInTimeZone(record.completedTime, 'Asia/Shanghai') !== today) continue;
    ids.add(identity(record)); families.add(routineOccurrenceKey(record));
  }
  return new Set(open.filter(task => ids.has(identity(task)) || Boolean(task.repeatFlag)
    && counts.get(routineOccurrenceKey(task)) === 1 && families.has(routineOccurrenceKey(task))).map(task => task.id));
}

export async function readAbandonedTaskRecords(api: TickTickApi, projectIds: string[]) {
  // Query each project separately: a global 200-row response could hide the
  // relevant occurrence. Fail closed at the provider limit; never assume empty.
  return (await Promise.all([...new Set(projectIds)].map(async projectId => {
    const rows = await api.filterTasks([projectId], [-1]);
    if (!Array.isArray(rows) || rows.length >= 200 || rows.some(row => row.projectId !== projectId || row.status !== -1)) {
      throw new Error('TickTick 放弃记录未完整读取，保留当前排期');
    }
    return rows;
  }))).flat();
}

export async function readAbandonedTodayTaskIds(api: TickTickApi, tasks: TickTickTask[], today: string, now = new Date()) {
  const records = await readAbandonedTaskRecords(api, tasks.filter(pending).map(task => task.projectId));
  return abandonedTodayTaskIds(tasks, records, today, now);
}
