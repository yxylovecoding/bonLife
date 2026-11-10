import { isEyeDrops } from './_ticktickEyeDrops.js';
import { isPendingTickTickTask as pending } from './_ticktickTaskState.js';
import { hasHiddenTag } from './_ticktickHiddenTag.js';
import { precedes, ruleEnabled } from './_rulePolicy.js';
import ICAL from 'ical.js';
import type { OutlookAvailability } from '../src/utils/outlookCalendar.js';
import type { TickTickPlanDetails } from '../src/utils/tickTickPlanDetails.js';
import { dayAvailability, occupySlots, type AvailabilityProfile } from './_dailyAvailability.js';
import { collectCompleted } from './_lifeDone.js';
import { annotatedMinutes, describedMinutes } from './_taskDuration.js';
import { calendarDateInTimeZone, createRoutineSceneDateFinder, isAlwaysTodayTask, routineOccurrenceKey, routineRecurrence, separateTickTickSprays, sprayKind,
  routineScenes, routineTaskDate, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';

export const DAILY_PLAN_KEY = 'ticktick:daily-plan:v1';
export const DAILY_PLAN_SETTINGS_KEY = 'ticktick:daily-plan-settings:v1';
const DAY = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const tags = (task: TickTickTask) => (task.tags ?? []).map((tag) => tag.normalize('NFKC').trim().toLowerCase());
const ordinary = (task: TickTickTask) => !hasHiddenTag(task) && !tags(task).some((tag) => ['routine', '不关我事'].includes(tag)) && (task.priority ?? 0) < 5;
const identity = (task: TickTickTask) => JSON.stringify([task.projectId, task.id]);

export interface DailyPlanSummary {
  date: string;
  todayCount: number;
  plannedMinutes: number;
  availableMinutes: number;
  importantCount: number;
  deferredCount: number;
  cycleRiskCount: number;
  oversizedCount: number;
}
export interface DailyPlanState {
  connectionId: string;
  historyThrough?: string;
  history: TickTickTask[];
  // The original date is retained across deferrals; postponement is not completion.
  deadlines: Record<string, { date: string; completion?: string; repeatFlag?: string }>;
  summary?: DailyPlanSummary;
  briefing?: TickTickPlanDetails;
}
export const dailyBudget = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  ? Math.max(10, Math.min(240, Math.round(value))) : null;

export function estimateTaskMinutes(task: TickTickTask): number {
  return estimateTaskDuration(task).minutes;
}

export function estimateTaskDuration(task: TickTickTask): { minutes: number; durationBasis: string } {
  const described = describedMinutes(task);
  if (described !== null) return { minutes: described, durationBasis: '待办描述中的时长标注' };
  const annotated = annotatedMinutes(`${task.title} ${(task.tags ?? []).join(' ')}`);
  if (annotated !== null) return { minutes: annotated, durationBasis: '标题或标签中的时长标注' };
  const explicit = `${task.title} ${(task.tags ?? []).join(' ')}`.match(/(?:^|[^\d])([1-9]\d{0,2})\s*(?:分钟|minutes?|mins?|m)(?![a-z0-9])/i);
  if (explicit) return { minutes: Math.min(480, Number(explicit[1])), durationBasis: '标题或标签中的分钟数' };
  if (task.isAllDay === false && task.startDate && task.dueDate) {
    const duration = (Date.parse(task.dueDate) - Date.parse(task.startDate)) / 60_000;
    if (duration > 0 && Number.isFinite(duration)) return { minutes: Math.min(480, Math.ceil(duration)), durationBasis: '待办起止时间' };
  }
  const minutes = task.title.normalize('NFKC').trim() === '洗衣服' ? 50
    : /喷雾|浇水|倒垃圾|换枕套|剪指甲|补剂|签到|红包|价保|预约|check\b/i.test(task.title) ? 5
    : /徒步|出去玩|音乐剧|讲座|电影|ktv/i.test(task.title) ? 90
    : /运动|力训|游泳|力扣/.test(task.title) ? 45 : 15;
  return { minutes, durationBasis: '未标注时长，采用任务默认估时' };
}

// The next interval starts at the last actual completion, never at a date we moved.
export function cycleEnd(task: TickTickTask, lastDay: string): string | null {
  if (routineRecurrence(task.repeatFlag) === 'unknown' || !task.repeatFlag) return null;
  try {
    const rule = ICAL.Recur.fromString(task.repeatFlag.replace(/^RRULE:/i, ''));
    const iterator = rule.iterator(ICAL.Time.fromDateString(lastDay));
    for (let i = 0; i < 370; i++) {
      const next = iterator.next();
      if (!next) return null;
      const day = next.toString().slice(0, 10);
      if (day > lastDay) return day;
    }
  } catch { /* Unsupported recurrence keeps its existing date. */ }
  return null;
}

export async function refreshDailyHistory(api: TickTickApi, tasks: TickTickTask[], state: DailyPlanState, now = new Date()) {
  const through = state.historyThrough ? Date.parse(state.historyThrough) : NaN;
  const start = Number.isFinite(through) ? Math.max(now.getTime() - 60 * DAY, through - DAY) : now.getTime() - 60 * DAY;
  const projectIds = [...new Set(tasks.map((task) => task.projectId))];
  const deadline = Date.now() + 55_000;
  const count = now.getTime() - start > 14 * DAY ? 4 : 1;
  const windows = Array.from({ length: count }, (_, i) => ({
    from: Math.floor(start + (now.getTime() - start + 1) * i / count),
    until: Math.floor(start + (now.getTime() - start + 1) * (i + 1) / count) - 1,
  }));
  const rows = (await Promise.all(windows.map(({ from, until }) => collectCompleted(api, projectIds, from, until, deadline)))).flat();
  const records = new Map<string, TickTickTask>();
  const sourceById = new Map(tasks.map(task => [identity(task), task]));
  const sourceByFamily = new Map<string, TickTickTask | undefined>();
  for (const task of tasks) {
    const family = routineOccurrenceKey(task);
    sourceByFamily.set(family, sourceByFamily.has(family) ? undefined : task);
  }
  for (const task of [...state.history, ...rows]) {
    if ((task.status ?? 2) !== 2) continue;
    if (!task.id || !task.projectId || !task.title || !task.completedTime || !Number.isFinite(Date.parse(task.completedTime))) {
      throw new Error('TickTick 完成记录无效，未调整每日安排');
    }
    if (Date.parse(task.completedTime) > now.getTime()) continue;
    const { id, projectId, parentId, title, content, desc, completedTime, priority, tags, isAllDay, startDate, dueDate, repeatFlag, repeatFrom, timeZone, reminders } = task;
    const key = JSON.stringify([projectId, id, completedTime]), previous = records.get(key);
    const source = sourceById.get(identity(task)) ?? sourceByFamily.get(routineOccurrenceKey(task));
    records.set(key, { id, projectId, parentId, title, content: content ?? previous?.content, desc: desc ?? previous?.desc,
      completedTime, priority: priority ?? previous?.priority ?? source?.priority, tags: tags ?? previous?.tags ?? source?.tags,
      isAllDay: isAllDay ?? previous?.isAllDay, startDate: startDate ?? previous?.startDate, dueDate: dueDate ?? previous?.dueDate, status: 2,
      repeatFlag: repeatFlag ?? previous?.repeatFlag ?? source?.repeatFlag, repeatFrom: repeatFrom ?? previous?.repeatFrom ?? source?.repeatFrom,
      timeZone: timeZone ?? previous?.timeZone ?? source?.timeZone, reminders: reminders ?? previous?.reminders ?? source?.reminders });
  }
  // Retain every recent occurrence for capacity learning, and the last completion
  // of each task ID and recurring series even after it leaves the provider window.
  const latest = new Map<string, TickTickTask>();
  for (const task of [...records.values()].sort((a, b) => Date.parse(a.completedTime!) - Date.parse(b.completedTime!))) {
    latest.set(identity(task), task);
    latest.set(routineOccurrenceKey(task), task);
  }
  state.history = [...new Set([...latest.values(), ...[...records.values()].filter((task) => Date.parse(task.completedTime!) >= now.getTime() - 30 * DAY)])];
  state.historyThrough = now.toISOString();
}

interface Candidate {
  task: TickTickTask;
  members: TickTickTask[];
  minutes: number;
  last?: string;
  deadline: string;
  notBefore: string | null;
  next: string | null;
  cycleDays: number;
}

export function planTickTickDay(options: {
  tasks: TickTickTask[];
  calendarState: unknown;
  today: string;
  state: DailyPlanState;
  budgetMinutes?: number | null;
  availability?: OutlookAvailability;
  availabilityProfile?: AvailabilityProfile;
  timezone?: string;
  now?: Date;
  excludedTaskIds?: ReadonlySet<string>;
  movableTaskIds?: ReadonlySet<string>;
}): { dates: Map<string, string>; summary: DailyPlanSummary; overBudget: Set<string> } {
  const { tasks, calendarState, today, state, excludedTaskIds = new Set<string>() } = options;
  const timezone = options.timezone ?? 'Asia/Shanghai';
  const now = options.now ?? new Date();
  const tomorrow = addDays(today, 1);
  const horizon = addDays(today, 30);
  const dates = new Map<string, string>();
  const overBudget = new Set<string>();
  const open = tasks.filter(pending);
  const byId = new Map(open.map((task) => [task.id, task]));
  const familyCounts = new Map<string, number>();
  for (const task of open) familyCounts.set(routineOccurrenceKey(task), (familyCounts.get(routineOccurrenceKey(task)) ?? 0) + 1);
  const lastById = new Map<string, string>(), lastByFamily = new Map<string, string>();
  for (const task of state.history) {
    const completed = task.completedTime;
    if (!completed || !Number.isFinite(Date.parse(completed)) || (calendarDateInTimeZone(completed) ?? '') > today) continue;
    for (const [index, key] of [[lastById, identity(task)], [lastByFamily, routineOccurrenceKey(task)]] as const) {
      if (!index.has(key) || Date.parse(completed) > Date.parse(index.get(key)!)) index.set(key, completed);
    }
  }
  const lastCompletion = (task: TickTickTask) => {
    const exact = lastById.get(identity(task));
    const series = familyCounts.get(routineOccurrenceKey(task)) === 1 ? lastByFamily.get(routineOccurrenceKey(task)) : undefined;
    return [exact, series].filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  };
  const sceneDate = createRoutineSceneDateFinder(calendarState);
  const excluded = (task: TickTickTask) => {
    const seen = new Set<string>();
    let current: TickTickTask | undefined = task;
    while (current && !seen.has(current.id)) {
      if (excludedTaskIds.has(current.id) || Boolean(current.parentId && excludedTaskIds.has(current.parentId))) return true;
      seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };
  const protectedTask = (task: TickTickTask) => isEyeDrops(task) || excluded(task)
    || isAlwaysTodayTask(task)
    || Boolean(options.movableTaskIds && !options.movableTaskIds.has(task.id))
    || !ordinary(task) || task.isAllDay === false || routineRecurrence(task.repeatFlag) === 'unknown'
    || precedes('hair-follow', 'daily-plan') && (tags(task).includes('洗头') || task.title.normalize('NFKC').trim() === '洗头');
  const candidates: Candidate[] = [];
  for (const task of open) {
    const members = [task];
    if (members.some(protectedTask)) continue;
    const date = routineTaskDate(task);
    if (date && date > horizon) continue;
    const fromBacklog = !date || date > today;
    const last = lastCompletion(task);
    const lastDay = calendarDateInTimeZone(last);
    const saved = state.deadlines[task.id];
    const end = lastDay ? cycleEnd(task, lastDay) : null;
    const savedDeadline = saved && saved.completion === last && saved.repeatFlag === task.repeatFlag ? saved.date : null;
    // TickTick advances a recurring task's due date when an occurrence is completed.
    // Prefer that provider-updated date for a newly observed completion; deriving the
    // next occurrence from completedTime can be wrong when the series repeats from due date.
    const repeatsFromDueDate = String(task.repeatFrom ?? '') === '0';
    const providerNextDue = repeatsFromDueDate && lastDay && date && date > lastDay ? date : null;
    const deadline = savedDeadline ?? providerNextDue ?? end ?? date ?? addDays(today, 7);
    const notBefore = precedes('minimum-interval', 'daily-plan') && tags(task).includes('at-least') ? deadline : null;
    const minutes = members.reduce((sum, member) => sum + estimateTaskMinutes(member), 0);
    const cycleDays = lastDay ? Math.max(1, daysBetween(lastDay, deadline)) : task.repeatFlag
      ? Math.max(1, daysBetween(today, cycleEnd(task, today) ?? addDays(today, 7))) : 14;
    // When at-least enforces a minimum interval, deferring just one day forward
    // would only inch the task across the cycle. Start searching for the next
    // scene day from notBefore so a single run reaches the honored interval.
    const earliestNext = notBefore && notBefore > tomorrow ? notBefore : tomorrow;
    const nextDates = members.map((member) => sceneDate(member, earliestNext));
    // Scene constraints apply to each task independently, as in the existing scheduler.
    let next: string | null = nextDates.some((day) => !day) ? null : nextDates.sort().at(-1)!;
    for (let i = 0; next && i < 740; i++) {
      const allowed = members.map((member) => sceneDate(member, next!));
      if (allowed.every((day) => day === next)) break;
      next = allowed.some((day) => !day) ? null : allowed.sort().at(-1)!;
      if (i === 739) next = null;
    }
    const allowedToday = members.every((member) => sceneDate(member, today) === today);
    if (!allowedToday) {
      // Scene rules win even for long-cycle, overdue or undated backlog items.
      if (next && !fromBacklog) for (const member of members) dates.set(member.id, next);
      continue;
    }
    // The user's 明日事 filter includes undated tasks and the next 30 days.
    // Protected/timed tasks are excluded above; only selected backlog moves.
    state.deadlines[task.id] = { date: deadline, completion: last, repeatFlag: task.repeatFlag };
    if (lastDay === today) {
      if (next && !fromBacklog) for (const member of members) dates.set(member.id, next);
      continue;
    }
    candidates.push({ task, members, minutes, last, deadline, notBefore, next, cycleDays });
  }
  const candidateIds = new Set(candidates.flatMap((candidate) => candidate.members.map((task) => task.id)));
  const important = open.filter((task) => ruleEnabled('important') && (task.priority ?? 0) >= 5
    && !hasHiddenTag(task) && !tags(task).includes('routine')
    && Boolean(routineTaskDate(task) && routineTaskDate(task)! <= today));
  const fixed = open.filter((task) => ordinary(task) && !candidateIds.has(task.id) && !dates.has(task.id) && routineTaskDate(task) === today && sceneDate(task, today) === today);
  const fixedMinutes = fixed.reduce((sum, task) => sum + estimateTaskMinutes(task), 0);
  const completedToday: TickTickTask[] = [];
  const seenHistory = new Set<string>();
  for (const task of state.history) {
    const day = calendarDateInTimeZone(task.completedTime);
    if (day !== today || !ordinary(task)) continue;
    const key = JSON.stringify([identity(task), task.completedTime]);
    if (seenHistory.has(key)) continue;
    seenHistory.add(key);
    completedToday.push(task);
  }
  const base = dailyBudget(options.budgetMinutes);
  if (!options.availability && base === null) throw new Error('请连接 Outlook 后自动安排每日待办');
  const alreadyDone = completedToday.reduce((sum, task) => sum + estimateTaskMinutes(task), 0);
  // A manually chosen daily cap still cannot make elapsed hours usable.
  const availability = options.availability ?? { startDate: today, endDate: addDays(horizon, 1), events: [] };
  const calendarDays = new Map<string, ReturnType<typeof dayAvailability>>();
  const getDay = (day: string) => {
    if (!calendarDays.has(day)) calendarDays.set(day, dayAvailability({ calendar: availability, day, today,
      timezone, now, profile: options.availabilityProfile, tasks: open,
      fixed: day === today ? fixed : [], completed: day === today ? completedToday : [], estimate: estimateTaskMinutes }));
    return calendarDays.get(day)!;
  };
  const calendarDay = getDay(today);
  // The day's ceiling only guards against unlimited refill after completions.
  // Each run's capacity and allocation start with the actual remaining slots.
  const dailyCeiling = options.availability
    ? Math.min((base ?? Infinity) - calendarDay.unmatchedEventMinutes, calendarDay.totalMinutes + fixedMinutes)
    : base!;
  const available = Math.max(0, Math.min(calendarDay.remainingMinutes,
    dailyCeiling - fixedMinutes - (options.availability ? calendarDay.completedMinutes : alreadyDone),
    (base ?? Infinity) - fixedMinutes - alreadyDone - (options.availability ? calendarDay.unmatchedEventMinutes : 0)));
  const capacity = Math.min(dailyCeiling, available + fixedMinutes);
  const remainingSlots = calendarDay.slots.map(([start, end]) => [start, end] as [number, number]);
  const demand = candidates.reduce((sum, candidate) => {
    const remaining = Math.max(1, Math.min(candidate.cycleDays, daysBetween(today, candidate.deadline) + 1));
    // Count only usable scene dates remaining in the cycle.
    let usable = 0, usableMinutes = 0;
    for (let i = 0; i < Math.min(remaining, 30); i++) {
      const day = addDays(today, i);
      if (!candidate.members.every((task) => sceneDate(task, day) === day)) continue;
      const free = getDay(day);
      if (!free.slots.some(([start, end]) => end - start >= candidate.minutes * 60_000)) continue;
      usable++;
      usableMinutes += i === 0 ? available : Math.min(base ?? Infinity, free.totalMinutes);
    }
    // Busy future days get less of the cycle's work; a free day can take more.
    return sum + candidate.minutes * (options.availability ? available / Math.max(1, usableMinutes) : 1 / Math.max(1, usable));
  }, 0);
  // Cycle demand is an advisory figure, not a cap on usable time.
  const cycleTarget = Math.min(available, Math.ceil(demand));
  candidates.sort((a, b) => {
    const urgent = (candidate: Candidate) => candidate.deadline <= today || !candidate.next || candidate.next > candidate.deadline;
    // Actual completion age owns the rotation. A moved date or a short repeat
    // interval must never promote recently completed work above older work.
    // Unknown history is kept explicit, not replaced by a creation timestamp.
    const age = ruleEnabled('oldest') ? Number(Boolean(a.last)) - Number(Boolean(b.last)) || (a.last ? Date.parse(a.last) : 0) - (b.last ? Date.parse(b.last) : 0) : 0;
    const urgency = ruleEnabled('urgency') ? Number(urgent(b)) - Number(urgent(a)) : 0;
    return (precedes('oldest', 'urgency') ? age || urgency : urgency || age)
      || (ruleEnabled('urgency') ? a.deadline.localeCompare(b.deadline) : 0)
      || (Date.parse(a.task.createdTime ?? '') || 0) - (Date.parse(b.task.createdTime ?? '') || 0)
      || a.task.id.localeCompare(b.task.id);
  });
  let used = 0, deferred = 0, oversizedCount = 0;
  let oldestWaiting: number | undefined;
  const cycleRisks = new Set<string>();
  const selectedDetails: NonNullable<DailyPlanState['briefing']>['selected'] = fixed.map((task) => ({
    id: task.id, projectId: task.projectId, title: task.title, ...estimateTaskDuration(task),
    reasons: [task.isAllDay === false ? '保留原定时间' : '保留原有安排，本次未参与动态挑选'],
  }));
  const selectedSprays = new Set(state.history.filter(task => !excluded(task) && !tags(task).includes('不关我事')
    && calendarDateInTimeZone(task.completedTime) === today && Date.parse(task.completedTime!) <= now.getTime())
    .map(sprayKind).filter((kind): kind is 'fragrance' | 'mite' => kind !== null));
  for (const task of open) {
    const kind = sprayKind(task), date = dates.get(task.id) ?? routineTaskDate(task);
    if (kind && !excluded(task) && !tags(task).includes('不关我事') && !candidateIds.has(task.id) && date && date <= today) selectedSprays.add(kind);
  }
  for (const candidate of candidates) {
    // A task larger than the remaining budget is reported instead of silently overbooking.
    const fits = remainingSlots.some(([start, end]) => end - start >= candidate.minutes * 60_000);
    const kind = sprayKind(candidate.task);
    const sprayConflict = precedes('sprays', 'daily-plan') && kind !== null && [...selectedSprays].some(other => other !== kind);
    const originalDate = routineTaskDate(candidate.task);
    const fromBacklog = !originalDate || originalDate > today;
    const mustRetain = !candidate.next && !fromBacklog;
    const lastDay = calendarDateInTimeZone(candidate.last);
    const completionTime = candidate.last ? Date.parse(candidate.last) : -Infinity;
    // Leaving a small gap is preferable to repeating yesterday's work while
    // older eligible work is still waiting for a large enough slot.
    const recentRefill = precedes('oldest', 'daily-plan') && lastDay === addDays(today, -1) && oldestWaiting !== undefined && oldestWaiting < completionTime;
    const reachedMinimumInterval = !candidate.notBefore || today >= candidate.notBefore;
    const choose = reachedMinimumInterval && !sprayConflict
      && (mustRetain || (!recentRefill && used + candidate.minutes <= available && fits));
    if (choose) {
      const reasons = [lastDay ? '按上次实际完成时间排序，最久没做的优先' : '尚无匹配的完成记录，优先补齐轮换'];
      if (fromBacklog) reasons.push('从明日事补入');
      if (lastDay) reasons.push(`上次完成 ${lastDay}`);
      if (!candidate.next) reasons.push('后续没有适用场景日，保留在今天');
      else if (candidate.deadline <= today) reasons.push(`周期或原定日期已到（${candidate.deadline}）`);
      else if (candidate.next > candidate.deadline) reasons.push('下次适用场景日晚于周期截止');
      if (routineScenes(candidate.task).length) reasons.push('今天符合任务的场景标签');
      reasons.push(fits && used + candidate.minutes <= available ? `预计 ${candidate.minutes} 分钟，可放入剩余空档`
        : '当前空档不足，仍保留；需要手动协调时间');
      selectedDetails.push({ id: candidate.task.id, projectId: candidate.task.projectId, title: candidate.task.title,
        ...estimateTaskDuration(candidate.task), minutes: candidate.minutes, reasons });
      occupySlots(remainingSlots, candidate.minutes);
      if (kind) selectedSprays.add(kind);
      used += candidate.minutes;
      for (const member of candidate.members) dates.set(member.id, today);
    } else {
      if (reachedMinimumInterval && !sprayConflict && (!fits || used + candidate.minutes > available)) {
        overBudget.add(candidate.task.id);
      }
      if (reachedMinimumInterval && !sprayConflict) oldestWaiting = Math.min(oldestWaiting ?? Infinity, completionTime);
      // Unselected future tasks retain their date; refill is not permission to
      // postpone the rest of tomorrow's list.
      if (candidate.next && !fromBacklog) {
        for (const member of candidate.members) dates.set(member.id, candidate.next);
        deferred += candidate.members.length;
      }
      if (candidate.task.repeatFlag && (!candidate.next || candidate.next > candidate.deadline)) cycleRisks.add(candidate.task.id);
      if (candidate.minutes > capacity || !fits) oversizedCount++;
    }
  }
  const sprayMovable = new Set(open.filter(task => (!options.movableTaskIds || options.movableTaskIds.has(task.id))
    && (Boolean(routineTaskDate(task) && routineTaskDate(task)! <= today) || dates.get(task.id) === today)).map(task => task.id));
  if (precedes('sprays', 'daily-plan')) separateTickTickSprays({ tasks, dates, history: state.history, calendarState, today, now, excludedTaskIds,
    movableTaskIds: sprayMovable });
  const finalSelected = selectedDetails.filter(task => !dates.has(task.id) || dates.get(task.id) === today);
  deferred += selectedDetails.length - finalSelected.length;
  for (const candidate of candidates) {
    const date = dates.get(candidate.task.id);
    if (candidate.task.repeatFlag && date && date > today && date > candidate.deadline) cycleRisks.add(candidate.task.id);
  }
  for (const id of Object.keys(state.deadlines)) if (!byId.has(id)) delete state.deadlines[id];
  const summary: DailyPlanSummary = { date: today, todayCount: finalSelected.length, plannedMinutes: finalSelected.reduce((sum, task) => sum + task.minutes, 0),
    availableMinutes: capacity, importantCount: important.filter(task => !dates.has(task.id) || dates.get(task.id)! <= today).length,
    deferredCount: deferred, cycleRiskCount: cycleRisks.size, oversizedCount };
  state.summary = summary;
  const { importantReservations, remainingWindows, ...breakdown } = calendarDay.breakdown;
  state.briefing = { date: today, generatedAt: now.toISOString(), selected: finalSelected, breakdown: {
    ...breakdown,
    remainingWindows: remainingWindows.map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() })),
    important: importantReservations.map(({ task, additionalMinutes }) => ({ id: task.id, projectId: task.projectId,
      title: task.title, ...estimateTaskDuration(task), additionalMinutes })),
    afterBufferMinutes: calendarDay.remainingMinutes, dailyLimitMinutes: base, completedTodayMinutes: alreadyDone,
    dailyLimitReductionMinutes: calendarDay.remainingMinutes - available, newTaskCapacityMinutes: available, cycleTargetMinutes: cycleTarget,
    selectionMode: 'remaining-time',
    unallocatedMinutes: Math.max(0, available - finalSelected.filter(task => candidateIds.has(task.id)).reduce((sum, task) => sum + task.minutes, 0)),
  } };
  return { dates, summary, overBudget };
}
