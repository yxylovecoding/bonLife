import { calendarDateInTimeZone, routineOccurrenceKey, routineTaskDate, routineTaskPayload, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';
import { syncRecurringTaskOutlook, type RecurringTaskEventOptions } from './_outlookRecurringTaskEvents.js';
import { localEventTime } from './_outlookTaskEvents.js';
import { isPendingTickTickTask as pending } from './_ticktickTaskState.js';
import { isChargingTask, restoreMissingChargingTask, vehicleNewTags, vehicleTaskTimes } from './_electricVehicleCharging.js';

const title = '接电动车';
const prefix = 'BonBills charging pickup: ';
const mergedPrefix = 'BonBills pickup merged: ';
const lines = (content?: string) => (content ?? '').split(/\r?\n|\\n/);
export const isElectricVehiclePickup = (task: TickTickTask) => [title, '借电动车'].includes(task.title.normalize('NFKC').trim());
export const isElectricVehicleTask = (task: TickTickTask) => isChargingTask(task) || isElectricVehiclePickup(task);
const notes = (task: TickTickTask) => lines(task.content).filter(line => !line.startsWith(prefix) && !line.startsWith(mergedPrefix)).join('\n');
const plainDuplicate = (task: TickTickTask) => pending(task) && isElectricVehiclePickup(task) && task.content?.includes(prefix) && notes(task).trim() === '(20m)'
  && !(task.tags ?? []).some(tag => !['当天', '活', 'hidden', 'bon-hidden'].includes(tag)) && !task.reminders?.length
  && task.priority === 5 && task.isAllDay === false
  && !task.repeatFlag && !task.parentId && !task.items?.length && !task.desc;
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

export async function syncElectricVehiclePickup(api: TickTickApi, options: RecurringTaskEventOptions & {
  mode?: 'tasks' | 'outlook'; calendarState?: unknown; canCreate?: (task: TickTickTask) => Promise<boolean>;
}) {
  const excluded = (task: TickTickTask) => {
    const seen = new Set<string>();
    let current: TickTickTask | undefined = task;
    while (current && !seen.has(current.id)) {
      if (options.excludedTaskIds.has(current.id) || (current.parentId && options.excludedTaskIds.has(current.parentId))) return true;
      seen.add(current.id); current = options.tasks.find(t => t.id === current!.parentId);
    }
    return false;
  };
  const tasks = [...options.tasks];
  let created = 0, updated = 0, deleted = 0;
  if (options.mode !== 'outlook') {
    const restored = await restoreMissingChargingTask(api, { ...options, tasks, excluded });
    if (restored) { tasks.push(restored); created++; }
    for (const candidate of tasks.filter(t => pending(t) && isChargingTask(t) && !excluded(t) && !t.tags?.includes('不关我事'))) {
      const fresh = await api.getTask(candidate.projectId, candidate.id), times = vehicleTaskTimes(fresh, 'charging');
      if (!pending(fresh) || !isChargingTask(fresh) || !times) continue;
      if (fresh.isAllDay === false && Date.parse(fresh.startDate ?? '') === Date.parse(times.startDate)
        && Date.parse(fresh.dueDate ?? '') === Date.parse(times.dueDate)) continue;
      await api.updateTask(fresh.id, { ...fresh, ...times });
      const verified = await api.getTask(fresh.projectId, fresh.id);
      if (!pending(verified) || Date.parse(verified.startDate ?? '') !== Date.parse(times.startDate)
        || Date.parse(verified.dueDate ?? '') !== Date.parse(times.dueDate)) throw new Error('充电时段保存未通过核对');
      tasks[tasks.findIndex(t => t.id === fresh.id)] = verified; updated++;
    }
  }
  const sources = tasks.filter(t => pending(t) && isChargingTask(t)
    && !excluded(t) && !t.tags?.includes('不关我事'));
  const now = options.now?.getTime() ?? Date.now();
  const completed = options.history.filter(t => !pending(t) && t.title.normalize('NFKC').trim() === '电动车充电'
    && !excluded(t) && !t.tags?.includes('不关我事') && t.completedTime && Date.parse(t.completedTime) <= now);
  const completedDay = (task: TickTickTask) => calendarDateInTimeZone(task.completedTime, 'Asia/Shanghai');
  const recentCompleted = completed.filter(t => completedDay(t) && dayAfter(completedDay(t)!) >= options.today)
    .sort((a, b) => Date.parse(b.completedTime!) - Date.parse(a.completedTime!));
  const assigned = new Set<string>();
  for (const source of options.mode === 'outlook' ? [] : [...recentCompleted, ...sources]) {
    const historical = !pending(source);
    const fresh = historical ? source : await api.getTask(source.projectId, source.id);
    const day = historical ? completedDay(fresh) : routineTaskDate(fresh);
    if ((!historical && !pending(fresh)) || !day || dayAfter(day) < options.today) continue;
    const target = dayAfter(day);
    const family = routineOccurrenceKey(source);
    const activeFamily = sources.filter(t => routineOccurrenceKey(t) === family);
    const unique = activeFamily.length === 1;
    const familyHistory = completed.filter(t => t.projectId === source.projectId
      && (t.id === source.id || unique && routineOccurrenceKey(t) === family));
    const sourceIds = new Set([source.id, ...unique ? [activeFamily[0].id, ...familyHistory.map(t => t.id)] : []]);
    const completion = familyHistory.filter(t => !historical || Date.parse(t.completedTime!) < Date.parse(source.completedTime!))
      .map(t => t.completedTime!).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? 'initial';
    const marker = `${prefix}${source.projectId}/${unique ? activeFamily[0].id : source.id}/${completion}`;
    const linked = (task: TickTickTask) => lines(task.content).some(line => {
      if (!line.startsWith(prefix)) return false;
      const [project, id, cycle] = line.slice(prefix.length).split('/');
      return project === source.projectId && sourceIds.has(id)
        && (cycle === completion || Number.isFinite(Date.parse(cycle)) && Date.parse(cycle) === Date.parse(completion));
    });
    const available = tasks.filter(t => pending(t) && isElectricVehiclePickup(t) && !excluded(t) && !t.tags?.includes('不关我事'));
    // One pending pickup is reused before preparing any later charging cycle.
    if (available.some(t => assigned.has(t.id))) continue;
    const matches = available;
    const customized = matches.filter(t => !plainDuplicate(t));
    if (matches.length > 1 && (customized.length > 1 || matches.some(t => plainDuplicate(t) && !linked(t)))) throw new Error('接电动车存在多个待办，请核对');
    if (options.history.some(t => t.projectId === source.projectId && isElectricVehiclePickup(t) && !pending(t)
      && routineTaskDate(t) === target)) continue;
    const keeper = customized[0] ?? matches[0];
    if (!keeper && tasks.some(t => pending(t) && isElectricVehiclePickup(t) && excluded(t))) continue;
    const duplicates = matches.filter(t => t.id !== keeper?.id);
    const existing = keeper ? await api.getTask(keeper.projectId, keeper.id) : undefined;
    if (existing && (!pending(existing) || !isElectricVehiclePickup(existing))) continue;
    if (existing && keeper && linked(keeper) && !linked(existing)) throw new Error('接电动车关联已变化');
    const shifted = existing ? { ...existing, ...routineTaskPayload(existing, target, true) } : { id: '', projectId: source.projectId, title, dueDate: `${target}T00:00:00+0800`, isAllDay: true };
    const times = vehicleTaskTimes(shifted, 'pickup');
    if (!times) continue;
    const { startDate, dueDate } = times;
    const aliases = [...new Set([...lines(existing?.content).filter(line => line.startsWith(mergedPrefix)),
      ...duplicates.flatMap(t => [`${mergedPrefix}${t.projectId}/${t.id}`, ...lines(t.content).filter(line => line.startsWith(mergedPrefix))])])];
    const content = [existing ? notes(existing) : '(20m)', marker, ...aliases].join('\n');
    let saved: TickTickTask;
    if (existing) {
      if (Date.parse(existing.startDate ?? '') === Date.parse(startDate) && Date.parse(existing.dueDate ?? '') === Date.parse(dueDate)
        && existing.isAllDay === false && existing.content === content) saved = existing;
      else {
        saved = await api.updateTask(existing.id, { ...existing, startDate, dueDate, isAllDay: false, content });
        updated++;
      }
    } else {
      if (options.canCreate && !await options.canCreate(shifted)) continue;
      saved = await api.createTask({ projectId: source.projectId, title, content, startDate, dueDate,
        isAllDay: false, timeZone: 'Asia/Shanghai', priority: 5, tags: vehicleNewTags(), reminders: [] });
      created++;
    }
    const verified = await api.getTask(saved.projectId, saved.id);
    if (verified.title !== (existing?.title ?? title) || !pending(verified) || Date.parse(verified.startDate ?? '') !== Date.parse(startDate)
      || Date.parse(verified.dueDate ?? '') !== Date.parse(dueDate) || verified.content !== content) throw new Error('接电动车待办保存未通过核对');
    assigned.add(verified.id);
    const index = tasks.findIndex(t => t.id === verified.id && t.projectId === verified.projectId);
    if (index >= 0) tasks[index] = verified; else tasks.push(verified);
    for (const duplicate of duplicates) {
      const current = await api.getTask(duplicate.projectId, duplicate.id);
      if (!current || current.id !== duplicate.id || current.projectId !== duplicate.projectId || !plainDuplicate(current) || !linked(current))
        throw new Error('重复接车待办已变化，未清理');
      await api.deleteTask(current.projectId, current.id);
      tasks.splice(tasks.findIndex(t => t.id === current.id), 1); deleted++;
    }
  }
  // Keep both sides of the charging cycle in the user's due-day list. This
  // label is unrelated to always-today and must never change task dates.
  if (options.mode !== 'outlook') for (const candidate of tasks.filter(task => pending(task)
    && isElectricVehicleTask(task) && !excluded(task) && !task.tags?.includes('当天'))) {
    const fresh = await api.getTask(candidate.projectId, candidate.id);
    if (!pending(fresh) || !isElectricVehicleTask(fresh) || fresh.tags?.includes('当天')) continue;
    const tags = [...(fresh.tags ?? []), '当天'];
    await api.updateTask(fresh.id, { ...fresh, tags });
    const verified = await api.getTask(fresh.projectId, fresh.id);
    if (verified.id !== fresh.id || verified.projectId !== fresh.projectId || !pending(verified)
      || verified.title !== fresh.title || JSON.stringify([...(verified.tags ?? [])].sort()) !== JSON.stringify([...tags].sort())) {
      throw new Error('电动车当天标签保存未通过核对');
    }
    tasks[tasks.findIndex(task => task.id === fresh.id && task.projectId === fresh.projectId)] = verified;
    updated++;
  }
  const outlook = options.mode === 'tasks' ? undefined : await syncRecurringTaskOutlook(api, { ...options, tasks: tasks.filter(isElectricVehiclePickup) }, {
    timeSource: 'task',
    subject: title, propertyId: 'String {d9d1e730-7742-4a9c-91af-bab2a9a45f69} Name BonBillsPickup',
    statePrefix: 'outlook:pickup-events:v1', cyclesKey: 'ticktick:pickup-cycles:v1',
    mergedTasks: task => lines(task.content).filter(line => line.startsWith(mergedPrefix)).map(line => {
      const [projectId, id] = line.slice(mergedPrefix.length).split('/');
      return { projectId, id };
    }).filter(t => t.projectId === task.projectId && Boolean(t.id)),
    plan: task => {
      const date = routineTaskDate(task);
      if (!pending(task) || task.tags?.includes('不关我事') || !date || date < options.today || excluded(task)) return null;
      const start = Date.parse(task.startDate ?? ''), end = Date.parse(task.dueDate ?? '');
      if (task.isAllDay !== false || !Number.isFinite(start) || !(end > start)) return null;
      return { subject: title, start: localEventTime(start), end: localEventTime(end) };
    },
  });
  return { created, updated, deleted, outlook };
}
