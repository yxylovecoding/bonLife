import { createHash } from 'node:crypto';
import { kv } from './_accountKv.js';
import { runAccountRequest, authorizeAccountScope } from './_accountScope.js';
import { acquireTickTickLock, releaseTickTickLock } from './_ticktickLock.js';
import { sleepWindow } from './_ticktickSleepTags.js';
import { TickTickOpenApiClient, decryptTickTickToken, readAllTickTickTasks, type TickTickConnection, type TickTickTask } from './_ticktickTrips.js';
import { DAILY_PLAN_KEY, refreshDailyHistory, type DailyPlanState } from './_ticktickDailyPlan.js';
import { readAbandonedTaskRecords, abandonedTodayTaskIds } from './_ticktickAbandoned.js';
import { readSchedulingRules, executeRuleGraph, schedulingRuleFailureReason } from './_schedulingRules.js';
import { RuleTaskDraft, ruleTaskFailureReason } from './_ruleTaskDraft.js';
import { planRainReminder, readRainReminderForecast, isRainReminderOnDay, rainReminderKey } from './_ticktickRainReminder.js';

interface ReplayRequest { date: string; projectId: string; requestId: string; mode: 'inspect' | 'run'; accountId: 'legacy' }
export function parseRainReplay(raw: string, now = new Date()): ReplayRequest {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['date', 'projectId', 'requestId', 'mode', 'accountId'].includes(key))
    || value.date !== sleepWindow(now).day || value.accountId !== 'legacy'
    || !['inspect', 'run'].includes(value.mode) || typeof value.projectId !== 'string' || !/^(?:[a-f0-9]{24}|inbox\d{1,20})$/.test(value.projectId)
    || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value.requestId)) {
    throw new Error('补跑参数无效或日期已过期');
  }
  return value;
}
const taskEvidence = ({ id, projectId, title, status, startDate, dueDate, timeZone, isAllDay, tags, reminders }: TickTickTask) =>
  ({ id, projectId, title, status, startDate, dueDate, timeZone, isAllDay, tags, reminders });

// No public HTTP route. Only an explicitly configured operator request runs at
// startup, in the same owner scope and lock as the existing cloud scheduler.
export async function runRainReminderReplay(raw: string | undefined, report: (value: unknown) => void) {
  if (!raw?.trim()) return;
  let request: ReplayRequest;
  try { request = parseRainReplay(raw); }
  catch { report({ phase: 'rejected', reason: '补跑参数无效或日期已过期' }); return; }
  return runAccountRequest(async () => {
    authorizeAccountScope(request.accountId);
    const context = { requestId: request.requestId, mode: request.mode, date: request.date };
    const emit = (value: Record<string, unknown>) => report({ ...context, ...value });
    const lock = await acquireTickTickLock();
    if (!lock) { emit({ phase: 'busy', reason: 'Orche 正在执行，未补跑' }); return; }
    const key = `ticktick:rain-replay:v1:${request.requestId}:${request.mode}`;
    let started = false;
    try {
      if (await kv.get(key)) { emit({ phase: 'already-attempted', reason: '该请求已执行或结果未确认，不自动重试' }); return; }
      const connection = await kv.get<TickTickConnection>('ticktick:connection:v1');
      if (!connection || connection.projectId !== request.projectId) {
        emit({ phase: 'rejected', reason: 'TickTick 目标清单未确认', configuredProjectId: connection?.projectId }); return;
      }
      // Persist before any external writes. An interrupted attempt needs an
      // operator to inspect provider state; a restart never blindly retries it.
      if (!await kv.set(key, { ...context, phase: 'started', at: new Date().toISOString() }, { nx: true })) return;
      started = true;
      const token = decryptTickTickToken(connection.encryptedToken, (process.env.SYNC_SECRET || '').trim());
      const connectionId = createHash('sha256').update(token).digest('hex');
      const api = new TickTickOpenApiClient(token, (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
      const [tasks, calendar, saved, config] = await Promise.all([readAllTickTickTasks(api, [0, 2]), kv.get('calendar-tags'),
        kv.get<DailyPlanState>(DAILY_PLAN_KEY), readSchedulingRules()]);
      const now = new Date();
      const history: DailyPlanState = saved?.connectionId === connectionId ? structuredClone(saved) : { connectionId, history: [], deadlines: {} };
      const abandoned = await readAbandonedTaskRecords(api, [...tasks.map(task => task.projectId), request.projectId]);
      const protectedIds = abandonedTodayTaskIds(tasks, abandoned, request.date, now);
      const abandonedTasks = abandoned.filter(task => Date.parse(task.completedTime!) <= now.getTime());
      await refreshDailyHistory(api, tasks, history, now, [request.projectId]);
      const sameDay = (task: TickTickTask) => isRainReminderOnDay(task, request.date);
      const existing = [...tasks, ...history.history, ...abandonedTasks].filter(sameDay);
      let forecast: Awaited<ReturnType<typeof readRainReminderForecast>> | undefined, forecastError: string | undefined;
      try { forecast = await readRainReminderForecast(request.date, calendar ?? {}, value => emit({ phase: 'source', ...value })); }
      catch (error) { forecastError = schedulingRuleFailureReason(error); }
      emit({ phase: 'preflight', checkedDay: await kv.get(rainReminderKey(connectionId)),
        city: forecast?.city.name, latitude: forecast?.city.latitude, longitude: forecast?.city.longitude,
        forecast: forecast ? { code: forecast.weather.code, precipitation: forecast.weather.precipitation, fetchedAt: forecast.fetchedAt, rainy: forecast.rainy } : { error: forecastError },
        tasks: [...new Map(existing.map(task => [`${task.projectId}:${task.id}`, taskEvidence(task)])).values()] });
      if (request.mode === 'inspect') {
        await kv.set(key, { ...context, phase: 'inspected', at: new Date().toISOString() });
        emit({ phase: 'inspected' }); return;
      }
      // Never invent a past clock or change cron's normal morning gate.
      if (sleepWindow(new Date()).day !== request.date) throw new Error('补跑日期必须是北京时间今天');
      const draft = new RuleTaskDraft(api, tasks, protectedIds);
      const run = await executeRuleGraph(config, 'hourly', { 'rain-reminder': async () => {
        const branch = draft.branch('rain-reminder');
        try {
          const outcome = await planRainReminder(branch.api, { connectionId, projectId: request.projectId, tasks: draft.values(),
            completedTasks: history.history, abandonedTasks, calendarState: calendar ?? {}, now: new Date(), manualDate: request.date,
            verifyReminder: async () => {
              if ([...history.history, ...abandonedTasks].some(sameDay)) return true;
              const candidates = draft.committedValues().filter(sameDay);
              const verified = await Promise.all(candidates.map(async task => {
                const current = await api.getTask(task.projectId, task.id);
                return current?.id === task.id && current.projectId === task.projectId && sameDay(current);
              }));
              return verified.some(Boolean);
            }, deferState: save => draft.saveAfterCommit('rain-reminder', save, { afterAllWrites: true }) });
          branch.accept(); return outcome;
        } catch (error) { branch.reject(); throw error; }
      } }, { save: false });
      const rule = run.results.find(result => result.id === 'rain-reminder')!;
      const updated = await draft.commit({ order: config.order, createOnly: true, allowed: id => id === 'rain-reminder' && rule.status === 'success',
        afterRule: async () => {}, failed: (_ids, error) => { rule.status = 'failed'; rule.reason = ruleTaskFailureReason(error); } });
      rule.updated = updated;
      const result = { ...context, phase: 'finished', rule, checkedDay: await kv.get(rainReminderKey(connectionId)),
        tasks: rule.status === 'success' ? draft.committedValues().filter(sameDay).map(taskEvidence) : [], at: new Date().toISOString() };
      await kv.set(key, result); emit(result);
    } catch (error) {
      const result = { ...context, phase: 'failed', reason: schedulingRuleFailureReason(error), at: new Date().toISOString() };
      if (started) await kv.set(key, result);
      emit(result);
    } finally { await releaseTickTickLock(lock); }
  });
}
