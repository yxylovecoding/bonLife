import { OUTLOOK_WRITE_KEY } from './_outlookWrite.js';
import { automaticRestWindow } from '../src/utils/schedulerTime.js';
import { cloudSchedulerAuthOk } from './_cloudSchedulerAuth.js';
import { schedulerResponse } from './_schedulerResponse.js';
import { privateCache, privateJson } from './_privateCache.js';
import { withAccountScope } from './_accountRoute.js';
import { authorizeAccountScope, isOwnerScope } from './_accountScope.js';
import { createHash } from 'node:crypto';
import { DAILY_PLAN_KEY, DAILY_PLAN_SETTINGS_KEY, dailyBudget, type DailyPlanState } from './_ticktickDailyPlan.js';
import { authOk } from './_auth.js';
import { kv } from './_accountKv.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { TickTickConnection, TickTickTripSyncState } from './_ticktickTrips.js';
import { availabilityProfile } from './_dailyAvailability.js';
import { schedulingFailure } from './_schedulingFailure.js';
import { isFinalTrainingRound, syncCalendarTraining } from './_lifeCalendarTraining.js';

const CONNECTION_KEY = 'ticktick:connection:v1';
const DAILY_SPECIAL_KEY = 'ticktick:daily-special-success:v1';
const SYNC_STATE_KEY = 'ticktick:trip-sync:v1';

function getSyncSecret() {
  return (process.env.SYNC_SECRET || '').trim();
}

function cronAuthOk(req: VercelRequest) {
  const secret = (process.env.CRON_SECRET || '').trim();
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function runSync(allowDisconnected = false) {
  const { runRuleReplan } = await import('./_ruleReplan.js');
  return runRuleReplan({ scope: 'full', allowDisconnected });
}

async function runRoutineVisibilitySync(kind: 'night' | 'daily' | 'all' | 'hair' | 'reading' | 'timed') {
  const { runRuleReplan } = await import('./_ruleReplan.js');
  return runRuleReplan({ scope: 'visibility', visibilityKind: kind, allowDisconnected: true });
}

function parseToken(req: VercelRequest): string {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token || token.length > 4096) throw new Error('请输入有效的 API Token');
    return token;
  } catch (error) {
    if (error instanceof Error && error.message === '请输入有效的 API Token') throw error;
    throw new Error('请输入有效的 API Token');
  }
}

async function connect(req: VercelRequest) {
  const {
    discoverTickTickTemplate,
    decryptTickTickToken,
    encryptTickTickToken,
    TickTickOpenApiClient,
  } = await import('./_ticktickTrips.js');
  const token = parseToken(req);
  const api = new TickTickOpenApiClient(token, (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
  const [template, preference] = await Promise.all([
    discoverTickTickTemplate(api),
    api.getPreference().catch(() => ({ timeZone: 'Asia/Shanghai' })),
  ]);
  const secret = getSyncSecret();
  const previousConnection = await kv.get<TickTickConnection>(CONNECTION_KEY);
  let sameToken = false;
  if (previousConnection) {
    try { sameToken = decryptTickTickToken(previousConnection.encryptedToken, secret) === token; }
    catch { /* A new valid connection can replace credentials encrypted with an old server key. */ }
  }
  const sameConnection = previousConnection && (
    previousConnection.templateRootId === template.rootTask.id
    || sameToken
  );
  if (sameConnection) {
    const state = await kv.get<TickTickTripSyncState>(SYNC_STATE_KEY);
    if (state) {
      for (const instance of [...Object.values(state.instances ?? {}), ...Object.values(state.wishInstances ?? {})]) {
        instance.projectId ??= previousConnection.projectId;
      }
      await kv.set(SYNC_STATE_KEY, state);
    }
  }
  const connection: TickTickConnection = {
    encryptedToken: encryptTickTickToken(token, secret),
    projectId: template.projectId,
    templateRootId: template.rootTask.id,
    timeZone: preference.timeZone || 'Asia/Shanghai',
    connectedAt: new Date().toISOString(),
  };
  await kv.set(CONNECTION_KEY, connection);
  if (!sameConnection) {
    await kv.set<TickTickTripSyncState>(SYNC_STATE_KEY, { instances: {} });
    await kv.set(DAILY_PLAN_KEY, null);
  }
  return { busy: false as const };
}

async function needsFirstDailySync() {
  const local = new Date(Date.now() + 8 * 3600_000);
  if (local.getUTCHours() * 60 + local.getUTCMinutes() < 301) return false;
  const connection = await kv.get<TickTickConnection>(CONNECTION_KEY);
  if (!connection) return false;
  const { decryptTickTickToken } = await import('./_ticktickTrips.js');
  const connectionId = createHash('sha256').update(decryptTickTickToken(connection.encryptedToken, getSyncSecret())).digest('hex');
  const saved = await kv.get<{ date: string; connectionId: string }>(DAILY_SPECIAL_KEY);
  return saved?.date !== shanghaiDate() || saved?.connectionId !== connectionId;
}

function specialSyncFailed(result: Record<string, any>) {
  return Boolean(result.error) || ['laundry', 'charging', 'hairWash', 'pickup'].some(key => result[key]?.outlook?.error);
}

async function status() {
  const [connection, state, plan, settings, templateSync] = await Promise.all([
    kv.get<TickTickConnection>(CONNECTION_KEY),
    kv.get<TickTickTripSyncState>(SYNC_STATE_KEY),
    kv.get<DailyPlanState>(DAILY_PLAN_KEY),
    kv.get<{ budgetMinutes?: number | null; availabilityProfile?: string }>(DAILY_PLAN_SETTINGS_KEY),
    kv.get<{ rootId: string }>('ticktick:template-sync-status:v1'),
  ]);
  return {
    connected: Boolean(connection),
    templateSync: connection && templateSync?.rootId === connection.templateRootId ? templateSync : undefined,
    dailyPlan: connection ? plan?.summary : undefined,
    budgetMinutes: dailyBudget(settings?.budgetMinutes),
    availabilityProfile: availabilityProfile(settings?.availabilityProfile),
    templateTitle: connection ? '出门todo模版' : undefined,
    lastSyncAt: state?.lastSyncAt,
    error: state?.lastError,
  };
}

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  const isCron = req.method === 'GET' && (cronAuthOk(req) || cloudSchedulerAuthOk(req));
  if (isCron) authorizeAccountScope('legacy');
  if (isCron && req.query?.scheduler === '1') {
    const json = res.json.bind(res);
    res.json = body => json(schedulerResponse(body));
  }
  if (!isCron && !await authOk(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    if (req.query?.action === 'scheduler-status') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
      if (!isOwnerScope()) return res.status(403).json({ error: 'owner authorization required' });
      const { readCloudSchedulerStatus } = await import('./_cloudScheduler.js');
      return res.status(200).json(await readCloudSchedulerStatus());
    }
    if (req.query?.action === 'rules') {
      const { readSchedulingRules, saveSchedulingRules, RuleConfigError, RULE_RUN_KEY } = await import('./_schedulingRules.js');
      if (req.method === 'GET') {
        const { readOutlookConnections } = await import('./_outlookConnections.js');
        const [config, lastRun, outlook] = await Promise.all([readSchedulingRules(), kv.get(RULE_RUN_KEY), readOutlookConnections()]);
        return privateJson(req, res, { config, lastRun, outlook });
      }
      if (req.method !== 'PATCH') return res.status(405).json({ error: 'method not allowed' });
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const config = await saveSchedulingRules(body);
        try {
          const { dispatchFullReplan } = await import('./_cloudScheduler.js');
          return res.status(200).json({ config, triggered: true, ...await dispatchFullReplan() });
        } catch { return res.status(200).json({ config, triggered: false, error: '已保存，Orchestrate 未提交' }); }
      } catch (error) {
        return res.status(error instanceof RuleConfigError ? error.status : 400).json({ error: error instanceof Error ? error.message : '规则配置无效' });
      }
    }
    if (req.query?.action === 'electric-vehicle-charge') {
      if (!isCron) return res.status(403).json({ error: 'cron authorization required' });
      // The October 9–10 setup has ended. Replaying it rewinds the next
      // recurring occurrence even after the user has completed the original.
      return res.status(410).json({ error: '该次电动车安排已结束，不再重放' });
    }
    if (req.query?.action === 'task-status') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
      const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
      if (!title || title.length > 200) return res.status(400).json({ error: '请提供要核对的任务标题' });
      const connection = await kv.get<TickTickConnection>(CONNECTION_KEY);
      if (!connection) return res.status(200).json({ connected: false, tasks: [] });
      const { decryptTickTickToken, TickTickOpenApiClient, readRoutineCalendarState } = await import('./_ticktickTrips.js');
      const { inspectTickTickTaskDate } = await import('./_ticktickTaskStatus.js');
      const token = decryptTickTickToken(connection.encryptedToken, getSyncSecret());
      const api = new TickTickOpenApiClient(token,
        (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
      const calendarState = await readRoutineCalendarState(api);
      const inspection = await inspectTickTickTaskDate(api, title, calendarState);
      const { inspectTickTickVisibility } = await import('./_ticktickVisibilityStatus.js');
      const visibility = await inspectTickTickVisibility(inspection.tasks.map(t => t.current), {
        connectionId: createHash('sha256').update(token).digest('hex'), projectId: connection.projectId,
        today: inspection.today, calendarState, timeZone: connection.timeZone,
      });
      return res.status(200).json({ connected: true, ...inspection,
        tasks: inspection.tasks.map((task, index) => ({ ...task, visibility: visibility[index] })) });
    }
    if (req.query?.action === 'pickup-status') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
      const connection = await kv.get<TickTickConnection>(CONNECTION_KEY);
      if (!connection) return res.status(200).json({ connected: false, tasks: [] });
      const { decryptTickTickToken, TickTickOpenApiClient, readAllTickTickTasks } = await import('./_ticktickTrips.js');
      const { isElectricVehicleTask } = await import('./_electricVehiclePickup.js');
      const api = new TickTickOpenApiClient(decryptTickTickToken(connection.encryptedToken, getSyncSecret()),
        (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
      const tasks = await readAllTickTickTasks(api, [0]);
      // Read-only confirmation of current rule-managed tasks; omit task notes
      // and credentials, and never trigger scheduling when viewing the result.
      return res.status(200).json({ connected: true, tasks: tasks.filter(task => isElectricVehicleTask(task)
        && (task.status ?? 0) === 0 && !task.completedTime).map(task => ({
        id: task.id, projectId: task.projectId, title: task.title, startDate: task.startDate, dueDate: task.dueDate, tags: task.tags,
      })) });
    }
    if (req.query?.action === 'daily-email') return res.status(410).json({ error: '每日邮件已取消' });
    if (isCron && automaticRestWindow()) return res.status(200).json({ ok: true, skipped: 'rest-window' });
    // These scheduled actions only occur before full/hourly-replan in the
    // existing queue. That following action already evaluates every visibility
    // rule with fresh sources. Avoid a redundant prelude stopping independent
    // planning on older Workers that do not yet understand partial results.
    // Explicit user POSTs and standalone night/midnight maintenance still run.
    if (isCron && ['routine-visibility', 'reading-visibility', 'hair-wash'].includes(String(req.query?.action)))
      return res.status(200).json({ ok: true, rulesComplete: true, skipped: 'included-in-full' });
    if (req.query?.action === 'plan-details') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
      const { readTickTickPlanDetails } = await import('./_ticktickPlanDetails.js');
      const { readOrchestrateProgress } = await import('./_orchestrateProgress.js');
      const jobId = typeof req.query.jobId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(req.query.jobId) ? req.query.jobId : undefined;
      // Snapshot reads must observe cloud updates and the Shanghai day boundary.
      res.setHeader('Cache-Control', 'no-store');
      const [details, progress] = await Promise.all([readTickTickPlanDetails(), readOrchestrateProgress(jobId)]);
      return res.status(200).json({ details, progress });
    }
    if (req.query?.action === 'trigger-replan') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
      const { dispatchFullReplan } = await import('./_cloudScheduler.js');
      return res.status(202).json({ ok: true, triggered: true, ...await dispatchFullReplan() });
    }
    if (req.query?.action === 'sync-templates') {
      if (req.method === 'GET') {
        const { inspectTickTickTemplateSync } = await import('./_ticktickTemplateRun.js');
        return res.status(200).json(await inspectTickTickTemplateSync());
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
      const { runTickTickTemplateSync } = await import('./_ticktickTemplateRun.js');
      const result = await runTickTickTemplateSync();
      return res.status(result.busy ? 202 : 200).json({ ok: !result.busy, ...result });
    }
    if (req.query?.action === 'replan-today') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
      if (await needsFirstDailySync()) {
        const result = await runSync(true);
        const failed = specialSyncFailed(result);
        return res.status(result.busy ? 202 : failed ? 502 : 200).json({ ok: !result.busy && !failed, ...result,
          ...(failed ? { error: '专项待办或 Outlook 日程同步失败' } : {}) });
      }
      const { replanRemainingToday } = await import('./_ticktickReplan.js');
      const result = await replanRemainingToday();
      return res.status(result.busy ? 202 : 200).json({ ok: !result.busy, ...result });
    }
    if (req.query?.action === 'hourly-replan') {
      if (!isCron) return res.status(403).json({ error: 'cron authorization required' });
      let trainingImportFailed = false;
      if (isFinalTrainingRound()) {
        try { await syncCalendarTraining(); } catch { trainingImportFailed = true; }
      }
      const respond = (status: number, result: Record<string, unknown>) => trainingImportFailed
        ? res.status(502).json({ ...result, ok: false, error: '运动日程同步失败，已保留历史',
          failure: { stage: 'completion-archive', retryable: false } })
        : res.status(status).json(result);
      if (await needsFirstDailySync()) {
        const result = await runSync(true);
        const failed = specialSyncFailed(result);
        return respond(result.busy ? 202 : failed ? 502 : 200, { ok: !result.busy && !failed, ...result,
          ...(failed ? { error: '专项待办或 Outlook 日程同步失败' } : {}) });
      }
      const { replanRemainingToday } = await import('./_ticktickReplan.js');
      const result = await replanRemainingToday({ scheduled: true });
      if (result.busy) return respond(200, { ok: true, busy: false, deferred: true, dailyPlan: { deferred: true } });
      return respond(200, { ok: true, ...result });
    }
    if (req.query?.action === 'briefing') {
      if (!['GET', 'POST'].includes(req.method ?? '')) return res.status(405).json({ error: 'method not allowed' });
      if (req.method === 'POST') {
        const result = await runSync();
        if (result.busy && req.query.format === 'json') return res.status(202).json({ busy: true });
        if (req.query.format !== 'json') return res.redirect(303, '/api/ticktick-trips?action=briefing');
      }
      const { readDailyBriefing, renderDailyBriefing } = await import('./_dailyBriefing.js');
      if (req.query.format === 'json') return privateJson(req, res, await readDailyBriefing());
      const html = renderDailyBriefing(await readDailyBriefing());
      if (req.method === 'GET') privateCache(res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
      return res.status(200).send(html);
    }
    if (req.query?.action === 'life-periods') {
      if (!isCron && req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
      const { syncRecentLifePeriods } = await import('./_bonLife.js');
      const periods = await syncRecentLifePeriods();
      return res.status(200).json({ ok: true, ...periods });
    }
    if (req.query?.action === 'night-routine' || req.query?.action === 'daily-routine'
      || req.query?.action === 'routine-visibility' || req.query?.action === 'hair-wash'
      || req.query?.action === 'reading-visibility' || req.query?.action === 'timed-visibility') {
      if (!isCron && req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
      const result = await runRoutineVisibilitySync(req.query.action === 'reading-visibility' ? 'reading'
        : req.query.action === 'timed-visibility' ? 'timed'
        : req.query.action === 'hair-wash' ? 'hair'
        : req.query.action === 'daily-routine' ? 'daily'
        : req.query.action === 'night-routine' ? 'night' : 'all');
      return res.status(result.busy ? 202 : 200).json({ ok: true, ...result });
    }
    if (isCron) {
      const { syncRecentLifeDone } = await import('./_lifeDone.js');
      // Archive completions even when Outlook or trip scheduling is unavailable.
      let doneError = false;
      try { await syncRecentLifeDone(); } catch { doneError = true; }
      const result = await runSync(true);
      if (doneError) {
        const failure = { stage: 'completion-archive', retryable: true };
        console.error('[ticktick-sync-failure]', JSON.stringify(failure));
        return res.status(502).json({ ...result, error: 'TickTick 完成记录同步失败，已保留历史', failure });
      }
      return res.status(result.busy ? 202 : 200).json({ ok: true, ...result });
    }
    if (req.method === 'GET') return privateJson(req, res, await status());
    if (req.method === 'PATCH') {
      let body;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
      catch { return res.status(400).json({ error: '日常用时格式无效' }); }
      if (body?.budgetMinutes !== null && (!Number.isInteger(body?.budgetMinutes) || body.budgetMinutes < 10 || body.budgetMinutes > 240)) {
        return res.status(400).json({ error: '每日上限须为自动或 10 至 240 分钟' });
      }
      if (body.availabilityProfile !== undefined && !['day', 'evening', 'calendar'].includes(body.availabilityProfile)) {
        return res.status(400).json({ error: '可用时段无效' });
      }
      const previous = await kv.get<Record<string, unknown>>(DAILY_PLAN_SETTINGS_KEY);
      await kv.set(DAILY_PLAN_SETTINGS_KEY, { ...previous, budgetMinutes: body.budgetMinutes,
        ...(body.availabilityProfile !== undefined ? { availabilityProfile: body.availabilityProfile } : {}) });
      return res.status(200).json({ ok: true, ...await status() });
    }
    if (req.method === 'PUT') {
      const result = await connect(req);
      return res.status(result.busy ? 202 : 200).json({
        ok: true,
        connected: true,
        ...result,
      });
    }
    if (req.method === 'POST') {
      const result = await runSync();
      return res.status(result.busy ? 202 : 200).json({ ok: true, connected: true, ...result });
    }
    if (req.method === 'DELETE') {
      await kv.del(CONNECTION_KEY);
      return res.status(200).json({ ok: true, connected: false });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = req.method === 'PUT' && !/^TickTick 5\d\d/.test(message) ? 400 : 502;
    const failure = schedulingFailure(error);
    if (isCron) console.error('[ticktick-sync-failure]', JSON.stringify(failure));
    return res.status(statusCode).json({ error: message, ...(isCron ? { failure } : {}) });
  }
}

export default withAccountScope(handler);
