import { cycleEnd } from './_ticktickDailyPlan.js';
import { nextTaskLocationDate } from './_ticktickLocation.js';
import { isPendingTickTickTask as pending } from './_ticktickTaskState.js';
import { calendarDateInTimeZone, routineOccurrenceKey, routineTaskDate, routineTaskPayload, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';

export const isChargingTask = (task: TickTickTask) => task.title.normalize('NFKC').trim() === '电动车充电';
export const vehicleNewTags = (tags: string[] = []) => [...new Set([...tags.filter(tag => !['routine', 'bon-hidden'].includes(tag)), '当天', '活'])];

// Charging always lasts an hour. Pickup retains a valid task duration.
export function vehicleTaskTimes(task: TickTickTask, kind: 'charging' | 'pickup') {
  const day = routineTaskDate(task);
  if (!day) return null;
  const start = task.isAllDay === false ? Date.parse(task.startDate || task.dueDate || '')
    : Date.parse(`${day}T${kind === 'charging' ? '20:00' : '07:20'}:00+08:00`);
  if (!Number.isFinite(start)) return null;
  const due = Date.parse(task.dueDate ?? '');
  const end = kind === 'pickup' && task.isAllDay === false && due > start ? due : start + (kind === 'charging' ? 60 : 20) * 60000;
  const format = (time: number) => `${new Date(time + 8 * 3600000).toISOString().slice(0, 19)}+0800`;
  return { startDate: format(start), dueDate: format(end), isAllDay: false };
}

export async function restoreMissingChargingTask(api: TickTickApi, options: {
  tasks: TickTickTask[]; history: TickTickTask[]; today: string; calendarState?: unknown;
  excluded: (task: TickTickTask) => boolean; now?: Date; canCreate?: (task: TickTickTask) => Promise<boolean>;
}) {
  if (options.tasks.some(task => pending(task) && isChargingTask(task))) return null;
  const records = [...options.history, ...options.tasks].filter(task => task.status === 2 && isChargingTask(task)
    && !options.excluded(task) && !task.tags?.includes('不关我事') && task.completedTime
    && Date.parse(task.completedTime) <= (options.now?.getTime() ?? Date.now()));
  if (!records.length) return null;
  const latest = records.sort((a, b) => Date.parse(b.completedTime!) - Date.parse(a.completedTime!))[0];
  if (records.some(task => Date.parse(task.completedTime!) === Date.parse(latest.completedTime!)
    && routineOccurrenceKey(task) !== routineOccurrenceKey(latest))) throw new Error('最近充电历史存在多个系列，无法确认补建日期');
  // Older history snapshots omitted recurrence; a same-occurrence task can supply it.
  const matching = options.tasks.find(task => task.id === latest.id && task.projectId === latest.projectId);
  const source = { ...matching, ...latest, repeatFlag: latest.repeatFlag ?? matching?.repeatFlag,
    repeatFrom: latest.repeatFrom ?? matching?.repeatFrom, timeZone: latest.timeZone ?? matching?.timeZone,
    reminders: latest.reminders ?? matching?.reminders };
  if (!source.repeatFlag || /(?:^|;)(COUNT|UNTIL)=/.test(source.repeatFlag) || source.items?.length) return null;
  const base = String(source.repeatFrom) === '0' ? routineTaskDate(source) : calendarDateInTimeZone(source.completedTime, 'Asia/Shanghai');
  const cycle = base && cycleEnd(source, base);
  if (!cycle || options.calendarState === undefined) return null;
  const date = nextTaskLocationDate(source, options.calendarState, cycle > options.today ? cycle : options.today);
  if (!date) return null;
  const current = api.filterTasks ? await api.filterTasks([], [0]) : options.tasks;
  if (current.some(task => pending(task) && isChargingTask(task))) return null;
  const { id: _id, sortOrder: _sortOrder, items: _items, ...shifted } = routineTaskPayload(source, date, true);
  const candidate = { ...source, ...shifted, status: 0, completedTime: undefined } as TickTickTask;
  const times = vehicleTaskTimes(candidate, 'charging');
  if (!times) return null;
  const payload = { ...shifted, ...times, title: '电动车充电', priority: source.priority ?? 5, tags: vehicleNewTags(source.tags) };
  if (options.canCreate && !await options.canCreate({ ...candidate, ...payload })) return null;
  const saved = await api.createTask(payload);
  const verified = await api.getTask(saved.projectId, saved.id);
  if (!verified || !pending(verified) || !isChargingTask(verified) || verified.projectId !== source.projectId
    || Date.parse(verified.startDate ?? '') !== Date.parse(times.startDate) || Date.parse(verified.dueDate ?? '') !== Date.parse(times.dueDate)
    || verified.repeatFlag !== source.repeatFlag || JSON.stringify([...(verified.tags ?? [])].sort()) !== JSON.stringify([...payload.tags].sort()))
    throw new Error('充电待办补建未通过核对');
  return verified;
}
