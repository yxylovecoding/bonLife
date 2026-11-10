import { readAbandonedTodayTaskIds } from './_ticktickAbandoned.js';
import { schedulingStage } from './_schedulingFailure.js';
import { createHash } from 'node:crypto';
import { kv } from './_accountKv.js';
import { automaticRestWindow } from '../src/utils/schedulerTime.js';
import { resolveCalendarState } from '../src/utils/internship.js';
import { SCHEDULING_RULES, type SchedulingRuleId, type SchedulingRuleResult, type SchedulingRuleConfig, type SchedulingRun } from '../src/utils/schedulingRules.js';
import { readSchedulingRules, executeRuleGraph, schedulingRuleFailureReason, RULE_RUN_KEY, type RuleHandler } from './_schedulingRules.js';
import { RuleTaskDraft, ruleTaskFailureReason } from './_ruleTaskDraft.js';
import { precedes, withRulePolicy, withActiveRule } from './_rulePolicy.js';
import { acquireTickTickLock, releaseTickTickLock } from './_ticktickLock.js';
import { visibilityInputs, visibilityRules, visibilityDecision } from './_taskVisibilityRules.js';
import { sleepWindow, sleepTagStateKey } from './_ticktickSleepTags.js';
import { hasHiddenTag } from './_ticktickNightRoutine.js';
import { withHiddenTag } from './_ticktickHiddenTag.js';
import { nextTaskLocationDate, taskCityTags, taskLocationAllowed } from './_ticktickLocation.js';
import { syncOutlookCalendar, saveOutlookSnapshot, OUTLOOK_CONNECTION_KEY, type OutlookConnection } from './_outlookSync.js';
import { decryptOutlookConnection, readOutlookSnapshot } from './_outlookCalendar.js';
import { applyOutlookSnapshotToState, type OutlookAvailability } from '../src/utils/outlookCalendar.js';
import { availabilityProfile } from './_dailyAvailability.js';
import { DAILY_PLAN_KEY, DAILY_PLAN_SETTINGS_KEY, dailyBudget, refreshDailyHistory, planTickTickDay, type DailyPlanState } from './_ticktickDailyPlan.js';
import { syncExerciseSchedule, isExerciseTask } from './_ticktickExercise.js';
import { syncLaundrySchedule, isLaundryTask } from './_ticktickLaundry.js';
import { postponeSwimmingTasks, readSwimmingCycle } from './_lifeSwimming.js';
import { syncPeriodPredictionTask } from './_ticktickPeriodPrediction.js';
import { syncLaundryOutlook } from './_outlookLaundry.js';
import { syncChargingOutlook } from './_outlookCharging.js';
import { syncHairWashOutlook } from './_outlookHairWash.js';
import { syncEyeDrops, isEyeDrops } from './_ticktickEyeDrops.js';
import { syncTickTickTemplates } from './_ticktickTemplateSync.js';
import { isElectricVehiclePickup, syncElectricVehiclePickup } from './_electricVehiclePickup.js';
import { OUTLOOK_WRITE_KEY } from './_outlookWrite.js';
import { TickTickOpenApiClient, decryptTickTickToken, readAllTickTickTasks, readConnectedTickTickTemplate,
  syncTickTickAlwaysToday, isAlwaysTodayTask, isPastEyeDrop, routineTaskDate, routineTaskPayload, routineScenes, routineRecurrence, followsHairWash,
  calendarDateInTimeZone, matchCompletedOccurrences,
  nextRoutineSceneDate, separateTickTickSprays, sprayKind, buildTripSourcesFromSyncState, reconcileTickTickTrips, reconcileTickTickWishPreparations,
  getTickTickRoutineExcludedTaskIds, getTickTickRoutineTargetDates, type TickTickTask, type TickTickTemplate, type TickTickConnection, type TickTickTripSyncState } from './_ticktickTrips.js';

import { isPendingTickTickTask as pending } from './_ticktickTaskState.js';
const plusDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

interface RuleReplanResult {
  busy: boolean; connected?: boolean; skipped?: string; updated?: number; rules?: SchedulingRun; rulesComplete?: boolean; error?: string;
  dailyPlan?: DailyPlanState['summary']; details?: DailyPlanState['briefing'];
  alwaysToday?: { matched: number; updated: number }; timedTasks?: { matched: number; updated: number };
}
export async function runRuleReplan(options: { scope: SchedulingRun['scope']; scheduled?: boolean; allowDisconnected?: boolean; lockHeld?: boolean; specialty?: 'swimming'; visibilityKind?: 'night' | 'daily' | 'all' | 'hair' | 'reading' | 'timed' }): Promise<RuleReplanResult> {
  if (options.scheduled && automaticRestWindow()) return { busy: false, skipped: 'rest-window' };
  const lock = options.lockHeld ? 'held' : await acquireTickTickLock();
  if (!lock) return { busy: true };
  let activeConfig: SchedulingRuleConfig | undefined, hasRunTrace = false;
  try {
    const config = await readSchedulingRules(); activeConfig = config;
    return await withRulePolicy(config, async () => {
      const connection = await kv.get<TickTickConnection>('ticktick:connection:v1');
      const secret = (process.env.SYNC_SECRET || '').trim();
      const now = new Date(), today = sleepWindow(now).day;
      if (!connection) {
        if (options.scope === 'full') {
          let outlook: Awaited<ReturnType<typeof syncOutlookCalendar>> | undefined, failure = false;
          try { outlook = await syncOutlookCalendar(today, secret, { persist: false }); } catch { failure = true; }
          const handlers = Object.fromEntries(SCHEDULING_RULES.filter(rule => rule[3] === 'calendar').map(([id]) => [id, async () => {
            if (failure) throw new Error('Outlook 订阅读取失败');
          }]));
          for (const id of config.removed ?? []) delete handlers[id];
          const run = await executeRuleGraph(config, options.scope, handlers, { save: false });
          const complete = run.results.filter(result => handlers[result.id]).every(result => result.status === 'success');
          if (outlook?.connected && complete) await saveOutlookSnapshot(outlook.connection, outlook.snapshot, outlook.policy, outlook.requestedAt);
          await kv.set(RULE_RUN_KEY, run); hasRunTrace = true;
          return { busy: false, connected: false, rules: run, rulesComplete: complete,
            ...(!complete ? { error: 'Outlook 规则未完成，请查看规则状态' } : {}) };
        }
        if (options.allowDisconnected || options.scheduled) return { busy: false, connected: false, skipped: 'disconnected' };
        throw new Error('TickTick 未连接');
      }
      const token = decryptTickTickToken(connection.encryptedToken, secret);
      const connectionId = createHash('sha256').update(token).digest('hex');
      const trainingRevealKey = `ticktick:training-visible-day:v1:${connectionId}`;
      const firstTrainingRun = options.scope === 'full' && !options.specialty && !sleepWindow(now).hidden
        && await kv.get<string>(trainingRevealKey) !== today;
      let trainingDates = new Map<string, string>();
      let trainingRevealIds: string[] | undefined;
      const api = new TickTickOpenApiClient(token, (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
      const [tasks, configState, storedCalendar, tripState, storedTrips, settings, saved] = await Promise.all([
        schedulingStage('tasks-read', true, () => readAllTickTickTasks(api, options.scope === 'visibility' ? [0] : [0, 2])), kv.get('app-config'), kv.get('calendar-tags'), kv.get('trip-tags'),
        kv.get<TickTickTripSyncState>('ticktick:trip-sync:v1'),
        kv.get<{ budgetMinutes?: number | null; availabilityProfile?: string }>(DAILY_PLAN_SETTINGS_KEY), kv.get<DailyPlanState>(DAILY_PLAN_KEY),
      ]);
      let calendarState = resolveCalendarState(configState, storedCalendar);
      let availability: OutlookAvailability | undefined, calendarError = false;
      let calendarEvidence: import('../src/utils/outlookCalendar.js').OutlookSnapshot | undefined;
      let outlookSnapshot: Awaited<ReturnType<typeof syncOutlookCalendar>> | undefined;
      if (options.scope !== 'visibility') {
        try {
          if (options.scope === 'hourly') {
            const outlook = await kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY);
            if (outlook) {
              const input = decryptOutlookConnection(outlook.encrypted, secret);
              const end = new Date(Date.parse(`${today}T00:00:00Z`) + 31 * 86400000).toISOString().slice(0, 10);
              const snapshot = await readOutlookSnapshot(input, today, end, { startDate: today, endDate: end }, connection.timeZone);
              calendarEvidence = snapshot; availability = snapshot.availability;
              calendarState = resolveCalendarState(configState, applyOutlookSnapshotToState((storedCalendar ?? {}) as Record<string, unknown>, snapshot, input.policy, today));
            }
          } else { outlookSnapshot = await syncOutlookCalendar(today, secret, { persist: false }); availability = outlookSnapshot?.availability; if (outlookSnapshot?.connected) calendarEvidence = outlookSnapshot.snapshot; }
          if (outlookSnapshot?.connected) calendarState = resolveCalendarState(configState, applyOutlookSnapshotToState((storedCalendar ?? {}) as Record<string, unknown>, outlookSnapshot.snapshot, outlookSnapshot.policy, today));
        } catch { calendarError = true; }
      }
      const maintainsDates = options.scope !== 'visibility' || ['daily', 'all', 'night'].includes(options.visibilityKind ?? '');
      const abandonedToday = maintainsDates
        ? await schedulingStage('completion-history', true, () => readAbandonedTodayTaskIds(api, tasks, today, now)) : new Set<string>();
      const state: DailyPlanState = saved?.connectionId === connectionId ? structuredClone(saved) : { connectionId, history: [], deadlines: {} };
      let historyError = false;
      if (maintainsDates) {
        try { await refreshDailyHistory(api, tasks, state); } catch { historyError = true; }
      }
      const tripSync: TickTickTripSyncState = { ...storedTrips, instances: storedTrips?.instances ?? {} };
      let periodError = false;
      if (options.scope === 'full') {
        try { await (await import('./_bonLife.js')).syncRecentLifePeriods(); } catch { periodError = true; }
      }
      let template: TickTickTemplate | undefined;
      try { if (options.scope !== 'visibility' || ['night', 'all'].includes(options.visibilityKind ?? '')) template = await readConnectedTickTickTemplate(api, connection); } catch { /* Only template-dependent rules need this input. */ }
      const excluded = template ? getTickTickRoutineExcludedTaskIds(template, tripSync) : new Set<string>();
      const movingTemplateIds = new Set(tasks.filter(task => /^搬家模[板版]$/.test(task.title.trim())).map(task => task.id));
      let added = true;
      while (added) { added = false; for (const task of tasks) if (task.parentId && movingTemplateIds.has(task.parentId) && !movingTemplateIds.has(task.id)) { movingTemplateIds.add(task.id); added = true; } }
      for (const id of movingTemplateIds) excluded.add(id);
      const trips = buildTripSourcesFromSyncState(calendarState, tripState);
      console.info('[scheduling-ready]', JSON.stringify({ scope: options.scope, phase: 'template' }));
      const draft = new RuleTaskDraft(api, tasks, abandonedToday);
      const visibility = options.specialty ? { journal: {}, locations: null } : await visibilityInputs(connection.projectId, today, calendarState);
      console.info('[scheduling-ready]', JSON.stringify({ scope: options.scope, phase: 'visibility' }));
      const journal = structuredClone(visibility.journal);
      const budgetHiddenKey = `ticktick:budget-hidden:v1:${connectionId}`;
      const budgetHidden = await kv.get<Record<string, string>>(budgetHiddenKey) ?? {};
      let overBudget: Set<string> | undefined;
      const sceneTodayOverBudget = new Set<string>();
      const managedVisibilityKey = `ticktick:visibility-owned:v1:${connectionId}`;
      const previousOwned = await kv.get<Record<string, SchedulingRuleId>>(managedVisibilityKey) ?? {};
      const legacyOwned = await kv.get<Record<string, { projectId: string; id: string }>>('ticktick:location-hidden:v1');
      for (const record of Object.values(legacyOwned ?? {})) if (tasks.some(task => task.id === record.id && task.projectId === record.projectId)) previousOwned[record.id] ??= 'visibility-location';
      const visibilityOwners: Record<string, SchedulingRuleId> = {};
      const visibilityReports: Partial<Record<SchedulingRuleId, Pick<SchedulingRuleResult, 'matched' | 'conflicts'>>> = {};
      const visibilityDecisions = new Map<string, boolean>();
      const handlers: Partial<Record<SchedulingRuleId, RuleHandler>> = {};
      const calendarDependent = new Set<SchedulingRuleId>();
      const plan = (id: SchedulingRuleId, callback: (branch: ReturnType<RuleTaskDraft['branch']>) => Promise<void>, needsHistory = true) => {
        if (needsHistory) calendarDependent.add(id);
        handlers[id] = async () => {
          if (needsHistory && (historyError || calendarError)) throw new Error('排期来源暂不可用');
          const branch = draft.branch(id);
          try { await callback(branch); return { ...branch.accept(), ...visibilityReports[id] }; } catch (error) { branch.reject(); throw error; }
        };
      };
      for (const id of options.specialty ? [] : visibilityRules) {
        plan(id, async branch => {
          if (!visibility.locations) throw new Error('地点读取失败，保留当前显隐');
          const report = visibilityReports[id] = { matched: 0, conflicts: [] as NonNullable<SchedulingRuleResult['conflicts']> };
          for (const task of draft.values().filter(pending)) {
            const hidden = visibilityDecision(id, task, { now, timeZone: connection.timeZone || 'Asia/Shanghai', ...visibility });
            if (hidden === null) continue;
            report.matched++;
            if (visibilityOwners[task.id]) {
              if (hidden !== visibilityDecisions.get(task.id)) report.conflicts.push({ taskId: task.id, winner: visibilityOwners[task.id], field: 'hidden' });
              continue;
            }
            visibilityOwners[task.id] = id; visibilityDecisions.set(task.id, hidden);
            if (hidden && id === 'visibility-sleep' && !hasHiddenTag(task)) journal[task.id] = { projectId: task.projectId, addedOn: today, phase: 'adding' };
            // A time/location becoming eligible cannot clear a separate budget hold.
            const budgetHold = budgetHidden[task.id] && !config.removed?.includes('daily-plan') && hasHiddenTag(task);
            const nextTags = withHiddenTag(task.tags, hidden || Boolean(budgetHold));
            if (JSON.stringify(task.tags ?? []) === JSON.stringify(nextTags)
              && (id !== 'visibility-night' || task.priority === 5)) continue;
            await branch.api.updateTask(task.id, { ...task, tags: nextTags,
              ...(id === 'visibility-night' ? { priority: 5 } : {}) });
          }
        }, false);
      }
      const sleeping = Boolean(options.scheduled && sleepWindow(now).hidden);
      if (options.scope !== 'visibility' && !sleeping) {
        handlers['eye-drops'] = async () => {
          // Leave stale slots open for always-today. Deduplicate once the dates and visibility are known.
          const eyes = draft.values().filter(task => pending(task) && isEyeDrops(task) && !abandonedToday.has(task.id));
          draft.protect('eye-drops', eyes.filter(task => !isPastEyeDrop(task, today)).map(task => task.id));
          return { matched: eyes.length };
        };
        for (const [id, mode] of [['template-content', 'content'], ['moving-date', 'dates']] as const) plan(id, async branch => {
          if (!draft.values().some(task => /^搬家模[板版]$/.test(task.title.trim()) || task.title.includes('搬家-'))) return;
          const result = await syncTickTickTemplates(branch.api, connection.templateRootId, connectionId, {
            mode, deferState: save => draft.saveAfterCommit(id, save), resolveIds: value => draft.resolveIds(value, true),
            completedTasks: historyError ? undefined : state.history, requireCompletionHistory: true,
          });
          branch.claimDates(result.managedTaskIds.filter(taskId => draft.values().some(task => task.id === taskId && pending(task))));
          for (const taskId of result.managedTaskIds) excluded.add(taskId);
        }, false);
      }
      if (options.scope !== 'visibility' || ['daily', 'all'].includes(options.visibilityKind ?? '')) {
        plan('always-today', async branch => {
          if (!visibility.locations && draft.values().some(task => pending(task) && isAlwaysTodayTask(task) && taskCityTags(task, calendarState).length))
            throw new Error('地点读取失败，保留当前排期');
          await syncTickTickAlwaysToday(branch.api, { tasks: draft.values(), today, calendarState, protectedTaskIds: abandonedToday });
          branch.claimDates(draft.values().filter(task => pending(task) && isAlwaysTodayTask(task) && !isEyeDrops(task)).map(t => t.id));
        });
      }
      if (options.scope !== 'visibility' && !sleeping) {
        for (const [id, , , category] of SCHEDULING_RULES) if (category === 'calendar' || category === 'selection' || id === 'scene-eligibility') {
          handlers[id] = async () => {
            if (calendarError || category === 'selection' && historyError) throw new Error('数据未刷新');
            if (category !== 'calendar' || !calendarEvidence) return;
            const raw = (storedCalendar ?? {}) as { tagMap?: Record<string, string>; manualTagDates?: Record<string, boolean>; outlookApplied?: Record<string, { tag: string }> };
            let matched = 0; const conflicts: NonNullable<SchedulingRuleResult['conflicts']> = [];
            for (const [date, tag] of Object.entries(calendarEvidence.tags)) {
              const candidates = [...calendarEvidence.ruleCandidates?.[date] ?? [tag === 'travel' ? 'calendar-travel' : tag === 'home' ? 'calendar-home' : 'calendar-intern']] as SchedulingRuleId[];
              const previous = raw.outlookApplied?.[date], current = raw.tagMap?.[date];
              if (raw.manualTagDates?.[date] || previous && current !== previous.tag || !previous && current && current !== 'school') candidates.push('calendar-manual');
              if (!candidates.includes(id)) continue;
              matched++;
              const winner = config.order.find(rule => candidates.includes(rule))!;
              if (winner !== id) conflicts.push({ taskId: date, winner, field: 'calendar' });
            }
            return { matched, conflicts };
          };
        }
        plan('daily-plan', async branch => {
          if (!template) throw new Error('模板范围未确认');
          if (!availability && dailyBudget(settings?.budgetMinutes) === null) { state.summary = undefined; state.briefing = undefined; return; }
          const values = draft.values(), protectedIds = new Set([...excluded, ...abandonedToday]);
          for (const task of values) if (isExerciseTask(task) && (options.scope === 'hourly' || precedes('exercise', 'daily-plan') || precedes('exercise-rollover', 'daily-plan'))
            || isLaundryTask(task) && (options.scope === 'hourly' || precedes('laundry', 'daily-plan') || precedes('laundry-appointment', 'daily-plan') || precedes('laundry-travel', 'daily-plan'))) protectedIds.add(task.id);
          const candidates = values.map(task => budgetHidden[task.id] && visibility.locations && !visibilityDecisions.get(task.id)
            ? { ...task, tags: withHiddenTag(task.tags, false) } : task);
          const result = planTickTickDay({ tasks: candidates, calendarState, today, now, state, timezone: connection.timeZone,
            budgetMinutes: settings?.budgetMinutes, availability, availabilityProfile: availabilityProfile(settings?.availabilityProfile), excludedTaskIds: protectedIds });
          for (const [id, date] of result.dates) {
            const task = values.find(t => t.id === id)!;
            await branch.api.updateTask(id, { ...routineTaskPayload(task, date), ...(options.scope === 'hourly' && task.items ? { items: task.items } : {}) });
          }
          branch.claimDates(result.dates.keys());
          overBudget = result.overBudget;
        });
      }
      if (options.scope !== 'visibility' && !sleeping) {
        // Spray separation constrains the final dates; it does not reserve an
        // unchanged date ahead of location, recurrence or ordinary rotation.
        plan('sprays', async () => {});
        plan('scene-date', async branch => {
          const tagMap = (calendarState as { tagMap?: Record<string, string> }).tagMap ?? {};
          const values = draft.values();
          const wasCompleted = matchCompletedOccurrences(values, state.history.filter(record =>
            calendarDateInTimeZone(record.completedTime, 'Asia/Shanghai') === today));
          for (const task of values.filter(t => pending(t) && !excluded.has(t.id) && !isAlwaysTodayTask(t) && !isEyeDrops(t) && !isElectricVehiclePickup(t))) {
            if (followsHairWash(task) && precedes('hair-follow', 'scene-date')) continue;
            const recurrence = routineRecurrence(task.repeatFlag), scenes = routineScenes(task);
            const cities = taskCityTags(task, calendarState);
            if (cities.length) {
              if (!visibility.locations) throw new Error('地点读取失败，保留当前排期');
              if (recurrence === 'unknown' || taskLocationAllowed(task, calendarState, today)) continue;
              const original = routineTaskDate(task);
              if (original && original > today && taskLocationAllowed(task, calendarState, original)) continue;
              // Keep a future deadline as the lower bound; overdue tasks can
              // move beyond the ordinary rotation's 30-day candidate window.
              const from = original && original > today ? original
                : recurrence === 'daily' && wasCompleted(task) ? plusDay(today) : today;
              const date = nextTaskLocationDate(task, calendarState, from);
              if (date) await branch.api.updateTask(task.id, routineTaskPayload(task, date));
              continue;
            }
            if (options.scope !== 'full') continue;
            if (!scenes.length || recurrence === 'unknown') continue;
            const scene = tagMap[today] === 'home' ? 'home' : tagMap[today] === 'travel' ? 'travel' : ['intern', 'school'].includes(tagMap[today]) ? 'school' : null;
            if (recurrence === 'long' && !scene) continue;
            const from = recurrence === 'daily' && wasCompleted(task) ? plusDay(today) : today;
            const date = nextRoutineSceneDate(task, calendarState, from);
            if (date === today && overBudget?.has(task.id)) {
              // An earlier rotation also owns a decision to keep a backlog date.
              draft.protect('daily-plan', [task.id]);
              sceneTodayOverBudget.add(task.id);
            }
            if (date) await branch.api.updateTask(task.id, routineTaskPayload(task, date));
          }
        });
      }
      if (options.scope === 'full' && !sleeping) {
        plan('repeat-date', async branch => {
          const targets = getTickTickRoutineTargetDates(calendarState, today);
          branch.claimDates(draft.values().filter(t => pending(t) && !excluded.has(t.id) && !isAlwaysTodayTask(t) && !isEyeDrops(t) && !isElectricVehiclePickup(t)
            && routineRecurrence(t.repeatFlag) === 'long' && routineTaskDate(t)
            && (!taskCityTags(t, calendarState).length || taskLocationAllowed(t, calendarState, today))
            && routineScenes(t).some(scene => scene !== 'home' && targets[scene] === today)).map(t => t.id));
        });
        plan('hair-follow', async branch => {
          const values = draft.values(), followers = values.filter(t => pending(t) && followsHairWash(t) && !isAlwaysTodayTask(t) && !isEyeDrops(t));
          const anchors = values.filter(t => pending(t) && t.title.normalize('NFKC').trim() === '洗头');
          if (followers.length && anchors.length > 1) throw new Error('存在多个洗头来源');
          const date = anchors[0] && routineTaskDate(anchors[0]);
          if (date) for (const task of followers) {
            const target = nextRoutineSceneDate(task, calendarState, date);
            if (target) await branch.api.updateTask(task.id, routineTaskPayload(task, target));
          }
          branch.claimDates(followers.map(t => t.id));
        });
        for (const [id, mode] of [['laundry-appointment', 'appointment'], ['laundry-travel', 'travel'], ['laundry', 'weather']] as const) plan(id, async branch => {
          const result = await syncLaundrySchedule(branch.api, { connectionId, tasks: draft.values(), history: state.history, calendarState,
            mode, deferState: save => draft.saveAfterCommit(id, save), configState, trips, availability, profile: availabilityProfile(settings?.availabilityProfile), today, now, excludedTaskIds: excluded });
          branch.claimDates(result.managedTaskIds);
        });
        for (const id of ['trips', 'wishes'] as const) plan(id, async branch => {
          if (!template) throw new Error('模板暂不可用');
          const localState = structuredClone(tripSync);
          const common = { api: branch.api, sourceTasks: draft.values(), template, state: localState, today, legacyProjectId: connection.projectId,
            saveState: async () => {} };
          if (id === 'trips') await reconcileTickTickTrips({ ...common, trips });
          else await reconcileTickTickWishPreparations({ ...common, configState });
          Object.assign(tripSync, localState);
          for (const taskId of getTickTickRoutineExcludedTaskIds(template, localState)) excluded.add(taskId);
          draft.saveAfterCommit(id, () => kv.set('ticktick:trip-sync:v1', draft.resolveIds(tripSync, true)));
        });
        plan('period-reminder', async branch => { if (periodError) throw new Error('经期来源暂不可用'); await syncPeriodPredictionTask(branch.api, { connection, tasks: draft.values(), completedTasks: state.history, today }); });
        plan('vehicle-pickup', async () => {});
      }
      if (!sleeping && (options.scope === 'full' || options.specialty === 'swimming' || ['night', 'all'].includes(options.visibilityKind ?? ''))) {
        if (!options.specialty) for (const id of (options.scope === 'full' ? ['exercise', 'exercise-rollover'] : ['exercise-rollover']) as SchedulingRuleId[]) plan(id, async branch => {
          if (periodError) throw new Error('经期来源暂不可用');
          const result = await syncExerciseSchedule(branch.api, { connectionId, tasks: draft.values(), calendarState, excludedTaskIds: excluded, rolling: id === 'exercise', rollingOnly: id === 'exercise', now, deferState: save => draft.saveAfterCommit(id, save),
            acceptsDate: (taskId, date) => routineTaskDate(draft.committedValues().find(t => t.id === taskId)!) === date });
          branch.claimDates(result.managedTaskIds);
          if (id === 'exercise') trainingDates = result.fixedDates;
        });
        plan('swimming', async branch => {
          if (periodError) throw new Error('经期来源暂不可用');
          const { cycle, periods } = await readSwimmingCycle([Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]);
          await postponeSwimmingTasks(branch.api, draft.values(), today, cycle, periods);
        });
      }
      // Outlook writers consume final, confirmed task dates. They are deferred
      // effects of their rule nodes, never interleaved with date proposals.
      const outlookPending: SchedulingRuleId[] = [];
      if (options.scope === 'full' && !sleeping) for (const id of ['outlook-laundry', 'outlook-charging', 'outlook-hair', 'outlook-pickup'] as const) {
        handlers[id] = async () => { if (calendarError || historyError) throw new Error('来源未确认'); outlookPending.push(id); };
      }
      for (const id of config.removed ?? []) delete handlers[id];
      const run = await executeRuleGraph(config, options.scope, handlers, { save: false, afterRule: async (id, success) => {
        if (id === 'exercise' && success && handlers[id] && firstTrainingRun) {
          const completedToday = matchCompletedOccurrences(tasks, state.history.filter(t => t.status === 2
            && calendarDateInTimeZone(t.completedTime, 'Asia/Shanghai') === today));
          trainingRevealIds = draft.values().filter(task => trainingDates.get(task.id) === today
            && routineTaskDate(task) === today && pending(task) && !excluded.has(task.id)
            && !abandonedToday.has(task.id) && !completedToday(task)).map(task => task.id);
          draft.revealPlannedTraining(trainingRevealIds);
          for (const taskId of trainingRevealIds) {
            visibilityOwners[taskId] = 'exercise'; visibilityDecisions.set(taskId, false);
          }
        }
        if (success || !handlers[id]) return;
        // A failed higher rule still owns its applicable field. Lower proposals
        // cannot silently stand in for an unavailable result.
        const candidates = draft.values().filter(pending);
        const applies = (task: TickTickTask) => id === 'exercise' || id === 'exercise-rollover' || id === 'swimming' ? isExerciseTask(task)
          : id === 'eye-drops' ? isEyeDrops(task)
          : id === 'vehicle-pickup' ? isElectricVehiclePickup(task) || task.title === '电动车充电'
          : id === 'moving-date' || id === 'template-content' ? Boolean(task.parentId) || task.title.includes('搬家-')
          : id.startsWith('laundry') ? isLaundryTask(task) : id === 'hair-follow' ? followsHairWash(task)
          : id === 'always-today' ? (task.tags ?? []).includes('always-today')
          : id === 'scene-date' || id === 'repeat-date' || id === 'scene-eligibility' ? routineScenes(task).length > 0 || taskCityTags(task, calendarState).length > 0
          : id === 'sprays' ? /香香喷雾|除螨喷雾/.test(task.title)
          : id === 'minimum-interval' ? (task.tags ?? []).includes('at-least')
          : ['daily-plan', 'oldest', 'urgency', 'important'].includes(id) ? (task.priority ?? 0) !== 5 && !(task.tags ?? []).some(t => ['routine', '不关我事'].includes(t))
          : false;
        if (visibilityRules.includes(id)) {
          draft.protect(id, candidates.filter(task => !visibility.locations || visibilityDecision(id, task, { now, timeZone: connection.timeZone || 'Asia/Shanghai', ...visibility }) !== null).map(t => t.id), 'hidden');
        } else draft.protect(id, candidates.filter(applies).map(t => t.id));
      } });
      if (options.scope !== 'visibility' && !sleeping && run.results.some(result => result.id.startsWith('calendar-') && handlers[result.id] && result.status !== 'success')) {
        for (const result of run.results) if (result.status === 'success' && (calendarDependent.has(result.id) || result.id.startsWith('outlook-'))) {
          result.status = 'skipped'; result.reason = '日历场景结果未确认，保留原排期';
        }
      }
      // Field dependencies are resolved against final proposals, before any write.
      // This refresh does not change precedence or accept an unsuccessful node.
      const eyeDrops = run.results.find(result => result.id === 'eye-drops');
      if (eyeDrops?.status === 'success' && eyeDrops.matched > 0) {
        const branch = draft.branch('eye-drops');
        try {
          const alignmentSucceeded = run.results.find(result => result.id === 'always-today')?.status === 'success';
          const candidates = draft.values().filter(task => isEyeDrops(task) && !abandonedToday.has(task.id)
            && (alignmentSucceeded || draft.datesConfirmed(task.id)));
          await syncEyeDrops(branch.api, candidates, now, connection.timeZone);
          eyeDrops.conflicts = branch.accept().conflicts;
        } catch (error) {
          branch.reject();
          eyeDrops.status = 'failed';
          eyeDrops.reason = schedulingRuleFailureReason(error);
        }
      }
      if (run.results.find(r => r.id === 'hair-follow')?.status === 'success') {
        try { await withActiveRule('hair-follow', handlers['hair-follow']!); }
        catch { const result = run.results.find(r => r.id === 'hair-follow')!; result.status = 'failed'; result.reason = '洗头来源日期未确认'; }
      }
      const propagate = () => {
        for (const id of config.order) {
          const result = run.results.find(r => r.id === id)!;
          if ((config.predecessors[id] ?? []).some(parent => run.results.find(r => r.id === parent)?.status !== 'success') && result.status === 'success') {
            result.status = 'skipped'; result.reason = '前序执行或写入未完成';
          }
        }
      };
      const allowed = (id: SchedulingRuleId) => run.results.find(r => r.id === id)?.status === 'success';
      propagate();
      const sprayResult = run.results.find(r => r.id === 'sprays');
      if (sprayResult && handlers.sprays && !config.removed?.includes('sprays')) {
        const values = draft.values(), sprays = values.filter(t => pending(t) && sprayKind(t) && !excluded.has(t.id));
        draft.requireRule('sprays', sprays.map(t => t.id));
        if (sprays.length && allowed('sprays')) {
          // These rules specify an eligible date/lower bound, not an exact-day
          // appointment. A later eligible spray day satisfies both constraints.
          const flexible = new Set<SchedulingRuleId>(['scene-date', 'repeat-date', 'daily-plan'].filter(id => allowed(id as SchedulingRuleId)) as SchedulingRuleId[]);
          const branch = draft.branch('sprays', flexible);
          try {
            if (!visibility.locations) throw new Error('地点读取失败，保留当前排期');
            const movable = new Set(sprays.filter(t => !abandonedToday.has(t.id)
              && !(t.tags ?? []).includes('always-today') && routineRecurrence(t.repeatFlag) !== 'unknown'
              && (!draft.dateOwner(t.id) || flexible.has(draft.dateOwner(t.id)!))).map(t => t.id));
            const dates = new Map<string, string>();
            const resolved = separateTickTickSprays({ tasks: values, dates, history: state.history, calendarState, today, now,
              excludedTaskIds: excluded, movableTaskIds: movable,
              nextEligibleDate: (task, from) => allowed('scene-date') || allowed('scene-eligibility')
                ? nextTaskLocationDate(task, calendarState, from) : from });
            for (const [id, date] of dates) await branch.api.updateTask(id, routineTaskPayload(values.find(t => t.id === id)!, date));
            const changes = branch.accept();
            Object.assign(sprayResult, changes, { matched: resolved.size });
          } catch (error) {
            branch.reject(); sprayResult.status = 'failed'; sprayResult.reason = schedulingRuleFailureReason(error);
            propagate();
          }
        }
      }
      // Vehicle duration and pickup consume the final charging date. Refinement
      // preserves that date and keeps its source rule as a write dependency.
      const vehicleResult = run.results.find(r => r.id === 'vehicle-pickup');
      if (vehicleResult && handlers['vehicle-pickup'] && allowed('vehicle-pickup')) {
        const vehicles = draft.values().filter(t => pending(t) && (isElectricVehiclePickup(t) || t.title === '电动车充电'));
        draft.requireRule('vehicle-pickup', vehicles.map(t => t.id));
        const branch = draft.branch('vehicle-pickup', new Set(config.order.filter(allowed)));
        try {
          if (!visibility.locations) throw new Error('地点读取失败，保留当前排期');
          if (vehicles.some(t => draft.dateOwner(t.id) && !allowed(draft.dateOwner(t.id)!))) throw new Error('充电日期未确认');
          await syncElectricVehiclePickup(branch.api, { tasks: draft.values(), history: state.history,
            excludedTaskIds: new Set([...excluded, ...abandonedToday]), ticktickConnectionId: connectionId, today, now, calendarState, mode: 'tasks',
            canCreate: async task => !(await readAbandonedTodayTaskIds(api,
              [{ ...task, status: 0, completedTime: undefined, repeatFlag: task.repeatFlag || 'RRULE:FREQ=DAILY' }], today, now)).has(task.id),
          });
          Object.assign(vehicleResult, branch.accept());
        } catch (error) {
          branch.reject(); vehicleResult.status = 'failed'; vehicleResult.reason = schedulingRuleFailureReason(error); propagate();
        }
      }
      for (const id of visibilityRules) if (run.results.find(r => r.id === id)?.status === 'success') {
        for (const taskId of Object.keys(visibilityOwners)) if (visibilityOwners[taskId] === id) delete visibilityOwners[taskId];
      }
      for (const id of config.order.filter(id => visibilityRules.includes(id))) if (run.results.find(r => r.id === id)?.status === 'success') {
        const refreshed = await withActiveRule(id, handlers[id]!);
        Object.assign(run.results.find(r => r.id === id)!, refreshed);
      }
      // Removing a city tag releases only a tag previously owned by this system.
      if (visibility.locations && run.results.find(r => r.id === 'visibility-location')?.status === 'success') {
        const cleanup = draft.branch('visibility-location');
        for (const task of draft.values()) if (previousOwned[task.id] === 'visibility-location' && !budgetHidden[task.id] && !visibilityOwners[task.id] && pending(task)) {
          await cleanup.api.updateTask(task.id, { ...task, tags: withHiddenTag(task.tags, false) });
        }
        cleanup.accept();
      }
      // Persist ownership before mutation so an interrupted tag write is recoverable.
      if (!options.specialty) await kv.set(sleepTagStateKey(connection.projectId), journal);
      // Check both dates: the rotation can defer an existing today task, while a
      // subsequent scene rule can bring an unselected backlog task into today.
      let nextBudgetHidden: Record<string, string> | undefined;
      if (overBudget && allowed('daily-plan') && visibility.locations) {
        const branch = draft.branch('daily-plan');
        const dueToday = new Set(tasks.filter(t => routineTaskDate(t) === today).map(t => t.id));
        nextBudgetHidden = {};
        for (const task of draft.values().filter(pending)) {
          const keep = overBudget.has(task.id) && (dueToday.has(task.id)
            || routineTaskDate(task) === today || sceneTodayOverBudget.has(task.id) || budgetHidden[task.id] === today);
          if (keep) nextBudgetHidden[task.id] = today;
          if (!keep && !budgetHidden[task.id]) continue;
          const hidden = keep || Boolean(visibilityDecisions.get(task.id));
          if (hidden !== hasHiddenTag(task)) await branch.api.updateTask(task.id, { tags: withHiddenTag(task.tags, hidden) });
        }
        const changes = branch.accept();
        const report = run.results.find(r => r.id === 'daily-plan')!;
        report.matched += changes.matched;
        report.conflicts = [...report.conflicts ?? [], ...changes.conflicts];
        for (const conflict of changes.conflicts) if (conflict.field === 'hidden') delete nextBudgetHidden[conflict.taskId];
      }
      // Validate/publish the calendar before committing tasks. A later subscription
      // refresh must not erase the trace of task writes already confirmed below.
      if (outlookSnapshot?.connected && ['calendar-travel', 'calendar-home', 'calendar-intern', 'calendar-manual'].every(id => allowed(id as SchedulingRuleId))) {
        await saveOutlookSnapshot(outlookSnapshot.connection, outlookSnapshot.snapshot, outlookSnapshot.policy, outlookSnapshot.requestedAt);
      }
      let updated: number;
      try {
        updated = await draft.commit({ order: config.order, allowed,
          beforeUpdate: async task => {
            if (!nextBudgetHidden?.[task.id] || budgetHidden[task.id] || !allowed('daily-plan') || !hasHiddenTag(task)) return;
            // Record ownership after the concurrency check and before the external
            // write so a partial run or an unknown response can be reconciled.
            budgetHidden[task.id] = today;
            await kv.set(budgetHiddenKey, budgetHidden);
          },
          failed: (ids, error) => {
            for (const id of ids) {
              const result = run.results.find(r => r.id === id)!;
              result.status = 'failed'; result.reason = ruleTaskFailureReason(error);
            }
            propagate();
          },
          afterRule: async id => {
            if (!outlookPending.includes(id) || !allowed(id)) return;
            const result = run.results.find(r => r.id === id)!;
            const relevant = draft.values().filter(t => pending(t) && !excluded.has(t.id) && (id === 'outlook-laundry' ? isLaundryTask(t)
              : id === 'outlook-pickup' ? isElectricVehiclePickup(t) : t.title.normalize('NFKC').trim() === (id === 'outlook-hair' ? '洗头' : '电动车充电')));
            if (relevant.some(t => !draft.datesConfirmed(t.id))) {
              result.status = 'skipped'; result.reason = '待办最终日期尚未确认，请将相应日期规则设为前序'; propagate(); return;
            }
            const confirmedTasks = draft.committedValues();
            const effectOptions = { tasks: confirmedTasks, history: state.history, excludedTaskIds: new Set([...excluded].map(taskId => draft.resolveIds(taskId))), ticktickConnectionId: connectionId, today };
            try {
              let effects: { created?: number; updated?: number };
              const writeConnection = await kv.get<{ calendarId?: string }>(OUTLOOK_WRITE_KEY);
              if (!writeConnection?.calendarId && relevant.some(task => !task.tags?.includes('不关我事') && (routineTaskDate(task) ?? '') >= today)) throw new Error('Outlook 写入日历未连接');
              if (id === 'outlook-charging') effects = await syncChargingOutlook(api, effectOptions);
              else if (id === 'outlook-hair') effects = await syncHairWashOutlook(api, effectOptions);
              else if (id === 'outlook-pickup') {
                const pickup = await syncElectricVehiclePickup(api, { ...effectOptions, mode: 'outlook' });
                effects = pickup.outlook ?? {};
              }
              else {
                const laundryTasks = confirmedTasks.filter(t => isLaundryTask(t) && !excluded.has(t.id));
                effects = await syncLaundryOutlook(api, { ...effectOptions, managedTaskIds: new Set(laundryTasks.map(t => t.id)), configState, calendarState,
                  plannedDates: Object.fromEntries(laundryTasks.map(t => [t.id, routineTaskDate(t)])) });
              }
              if ('error' in effects && effects.error) throw new Error('Outlook 写入未确认');
              result.updated = (effects.created ?? 0) + (effects.updated ?? 0);
            } catch { result.status = 'failed'; result.reason = 'Outlook 写入未确认'; propagate(); }
          },
        });
      } catch (error) {
        for (const result of run.results) if (result.status === 'success' && result.matched) {
          result.status = 'failed'; result.reason = '写入未确认，请刷新后再次运行 Orchestrate';
        }
        await kv.set(RULE_RUN_KEY, run); hasRunTrace = true; throw error;
      }
      for (const result of run.results) result.updated += draft.writeCounts.get(result.id) ?? 0;
      if (trainingRevealIds && allowed('exercise')) {
        const confirmed = new Map(draft.committedValues().map(task => [task.id, task]));
        if (trainingRevealIds.every(id => {
          const task = confirmed.get(id);
          return task && pending(task) && routineTaskDate(task) === today && !hasHiddenTag(task) && draft.datesConfirmed(id);
        })) {
          for (const id of trainingRevealIds) {
            delete previousOwned[id]; delete journal[id];
            if (nextBudgetHidden) delete nextBudgetHidden[id];
          }
          await kv.set(trainingRevealKey, today);
        }
      }
      // A compact, content-free confirmation for formerly skipped reopened tasks.
      // Report only changed dates that the shared writer has read back successfully.
      if (allowed('always-today')) {
        const confirmed = new Map(draft.committedValues().map(task => [task.id, task]));
        for (const original of tasks.filter(task => task.completedTime && task.status === 0 && isAlwaysTodayTask(task))) {
          const savedTask = confirmed.get(original.id);
          if (!savedTask || routineTaskDate(original) === routineTaskDate(savedTask) || !draft.datesConfirmed(savedTask.id)) continue;
          console.info('[ticktick-reopened-date]', JSON.stringify({
            titleHash: createHash('sha256').update(original.title).digest('hex').slice(0, 16),
            date: routineTaskDate(savedTask), scope: options.scope, verified: true,
          }));
        }
      }
      if (nextBudgetHidden && allowed('daily-plan') && JSON.stringify(nextBudgetHidden) !== JSON.stringify(budgetHidden)) {
        await kv.set(budgetHiddenKey, nextBudgetHidden);
      }
      for (const [id, owner] of Object.entries(visibilityOwners)) {
        if (!allowed(owner)) continue;
        if (!visibilityDecisions.get(id)) delete previousOwned[id]; else previousOwned[id] = owner;
      }
      await kv.set(managedVisibilityKey, previousOwned);
      if (legacyOwned && allowed('visibility-location')) await kv.set('ticktick:location-hidden:v1', {});
      if (!sleepWindow(now).hidden && allowed('visibility-sleep')) await kv.set(sleepTagStateKey(connection.projectId), {});
      if (allowed('daily-plan') && state.briefing && state.summary) {
        const actual = new Map(draft.committedValues().map(task => [task.id, task]));
        const selected = state.briefing.selected.filter(item => {
          const task = actual.get(item.id), date = task && routineTaskDate(task);
          return task && pending(task) && !hasHiddenTag(task) && date && date <= today;
        });
        state.briefing.selected = selected;
        state.summary = { ...state.summary, todayCount: selected.length, plannedMinutes: selected.reduce((sum, task) => sum + task.minutes, 0) };
      }
      if (!allowed('daily-plan')) {
        state.summary = saved?.connectionId === connectionId ? saved.summary : undefined;
        state.briefing = saved?.connectionId === connectionId ? saved.briefing : undefined;
      }
      if (state.briefing && !historyError) state.briefing.rules = run;
      if (!historyError && maintainsDates) await kv.set(DAILY_PLAN_KEY, state);
      await kv.set(RULE_RUN_KEY, run); hasRunTrace = true;
      if (options.scope === 'full' && !sleeping) await kv.set('ticktick:daily-special-success:v1',
        run.results.every(result => !handlers[result.id] || result.status === 'success') ? { date: today, connectionId } : null);
      if (options.scope === 'full' && draft.committedValues().some(t => isExerciseTask(t) || t.title.trim() === '洗头')) {
        await schedulingStage('finalize', false, async () => {
          const { syncTrainingSource } = await import('./_lifeTraining.js');
          await syncTrainingSource(Number(today.slice(0, 4)), { lockHeld: true, api });
        });
      }
      const aggregate = (id: SchedulingRuleId) => {
        const result = run.results.find(r => r.id === id)!;
        return { matched: result.matched, updated: result.updated };
      };
      return { busy: false, connected: true, updated, alwaysToday: aggregate('always-today'), timedTasks: aggregate('visibility-timed'), dailyPlan: state.summary, details: state.briefing, rules: run,
        ...(sleeping ? { skipped: 'sleep-window' } : {}),
        rulesComplete: run.results.every(result => !handlers[result.id] || result.status === 'success'),
        ...(run.results.some(r => handlers[r.id] && r.status !== 'success') ? { error: '部分规则未完成，请查看规则状态' } : {}) };
    });
  } catch (error) {
    if (activeConfig && !hasRunTrace) await kv.set(RULE_RUN_KEY, { version: activeConfig.version, scope: options.scope,
      generatedAt: new Date().toISOString(), order: activeConfig.order, groups: activeConfig.groups, names: activeConfig.names,
      results: activeConfig.order.map(id => ({ id, status: 'skipped', matched: 0, updated: 0, reason: '本轮数据读取未完成，未执行规则' })),
    }).catch(() => undefined);
    throw error;
  } finally { if (!options.lockHeld) await releaseTickTickLock(lock); }
}
