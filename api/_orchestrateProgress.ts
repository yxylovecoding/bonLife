import { kv } from './_accountKv.js';
import { isOwnerScope } from './_accountScope.js';
import { readCloudSchedulerStatus } from './_cloudScheduler.js';
import { RULE_RUN_KEY, PLAN_RUN_KEY } from './_schedulingRules.js';
import { ruleTitle, type SchedulingRun } from '../src/utils/schedulingRules.js';
import type { OrchestrateProgress } from '../src/utils/orchestrateProgress.js';

function summarize(run: SchedulingRun): OrchestrateProgress | null {
  const active = run.results.filter(result => !['已删除，不执行', '不在本次执行范围'].includes(result.reason ?? ''));
  const completed = active.filter(result => result.status === 'success');
  const deferred = active.filter(result => result.status === 'skipped' || result.deferred);
  const failed = active.filter(result => result.status === 'failed');
  if (!deferred.length && !failed.length) return null;
  const partial = completed.length > 0;
  const calendarUnavailable = run.calendar?.state === 'unavailable' || active.some(result => result.id.startsWith('calendar-') && result.status !== 'success');
  const title = (result: typeof active[number]) => ruleTitle(result.id, run);
  return {
    state: partial ? 'partial' : 'failed',
    message: partial ? `Orchestrate 部分完成${calendarUnavailable ? '：日历不可用，相关安排暂缓' : ''}`
      : `Orchestrate 未完成：${calendarUnavailable ? 'Outlook 日历读取失败' : '部分排期规则未完成，请查看 Orchestrator'}`,
    generatedAt: run.generatedAt,
    completed: completed.filter(result => result.matched > 0 || result.updated > 0).map(title),
    deferred: deferred.map(title), failed: failed.map(title),
  };
}

export async function readOrchestrateProgress(jobId?: string): Promise<OrchestrateProgress | null> {
  const [latest, plan] = await Promise.all([kv.get<SchedulingRun>(RULE_RUN_KEY), kv.get<SchedulingRun>(PLAN_RUN_KEY)]);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  const today = (run: SchedulingRun | null) => Boolean(run && Number.isFinite(Date.parse(run.generatedAt))
    && day.format(new Date(run.generatedAt)) === day.format(new Date()));
  // A later visibility pass must not erase the day's partial plan.
  const runs = [latest, plan].filter((run): run is SchedulingRun => today(run));
  const current = runs.find(run => run.scope !== 'visibility') ?? runs[0];
  if (jobId && isOwnerScope()) {
    try {
      const { jobs } = await readCloudSchedulerStatus();
      const job = jobs.find(item => item.id === jobId);
      if (!job) return { state: 'unknown', message: '本次执行状态暂未确认，请稍后查看' };
      if (job.status === 'queued') return { state: 'queued', message: 'Orchestrate 排队中…' };
      if (job.status === 'running') return { state: 'running', message: 'Orchestrate 排期中…' };
      if (job.status === 'success') return { state: 'success', message: 'Orchestrate 已完成' };
      // Attach only this job's rule trace, never an earlier same-day run.
      const related = runs.find(run => job.startedAt != null && job.finishedAt != null
        && Date.parse(run.generatedAt) >= job.startedAt && Date.parse(run.generatedAt) <= job.finishedAt);
      const summary = related && summarize(related);
      if (summary) return summary;
      return { state: job.status === 'partial' ? 'partial' : 'failed',
        message: job.status === 'partial' ? 'Orchestrate 部分完成，请查看 Orchestrator' : 'Orchestrate 未完成，请查看 Orchestrator' };
    } catch { return { state: 'unknown', message: '本次执行状态暂未确认，请稍后查看' }; }
  }
  // A missing daily snapshot is not an empty successful plan. Surface today's
  // recorded failure without dispatching work or returning raw provider errors.
  return current ? summarize(current) : null;
}
