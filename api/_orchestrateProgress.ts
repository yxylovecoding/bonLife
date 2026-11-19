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
    message: partial ? `Orchestrate 部分完成${calendarUnavailable ? '：日程订阅不可用，相关安排暂缓' : ''}`
      : `Orchestrate 未完成：${calendarUnavailable ? 'Outlook／Google 订阅读取失败' : '部分排期规则未完成，请查看 Orchestrator'}`,
    generatedAt: run.generatedAt,
    completed: completed.filter(result => result.matched > 0 || result.updated > 0).map(title),
    deferred: deferred.map(title), failed: failed.map(title),
  };
}

const reasonText: Record<string, string> = {
  'origin-not-ready': '排期服务暂不可用',
  'read-unavailable': '排期数据暂不可读',
  busy: '排期服务仍在处理其他任务',
  expired: '本轮排期已过期',
  'rest-window': '当前为凌晨暂停时段',
  'completion-archive': '完成记录同步未确认',
  'response-unknown': '写入结果待核对',
  'interrupted-response-unknown': '写入结果待核对',
};

export async function readOrchestrateProgress(jobId?: string, includeLatest = false): Promise<OrchestrateProgress | null> {
  const [latest, plan, queue] = await Promise.all([kv.get<SchedulingRun>(RULE_RUN_KEY), kv.get<SchedulingRun>(PLAN_RUN_KEY),
    (jobId || includeLatest) && isOwnerScope() ? readCloudSchedulerStatus().catch(() => null) : null]);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  const today = (date: number | string) => Number.isFinite(new Date(date).getTime()) && day.format(new Date(date)) === day.format(new Date());
  const runs = [latest, plan].filter((run): run is SchedulingRun => Boolean(run && today(run.generatedAt)));
  const current = runs.find(run => run.scope !== 'visibility') ?? runs[0];

  const job = jobId ? queue?.jobs.find(item => item.id === jobId) : includeLatest ? queue?.jobs
    .filter(item => (item.kind === 'full' || item.kind === 'hourly') && item.scheduledAt != null && today(item.scheduledAt))
    .sort((a, b) => (b.scheduledAt ?? 0) - (a.scheduledAt ?? 0))[0] : undefined;
  if (jobId && isOwnerScope() && !job) return { state: 'unknown', message: '本次执行状态暂未确认，请稍后查看' };
  if (!job) return current ? summarize(current) : null;
  if (job.status === 'queued') return { state: 'queued', message: 'Orchestrate 排队中…' };
  const related = runs.find(run => job.startedAt != null && Date.parse(run.generatedAt) >= job.startedAt
    && Date.parse(run.generatedAt) <= (job.finishedAt ?? Date.now()));
  const summary = related && summarize(related);
  const reason = reasonText[job.reason ?? ''];
  if (job.status === 'retrying' || (job.status === 'running' && job.retryRound)) {
    return { ...summary, state: 'retrying', message: `Orchestrate 正在自动补跑${reason ? ` · ${reason}` : ''}` };
  }
  if (job.status === 'running') return { state: 'running', message: 'Orchestrate 排期中…' };
  if (job.status === 'success') return { state: 'success', message: 'Orchestrate 已完成' };
  if (job.status === 'unknown') return { state: 'unknown', message: '本次执行状态暂未确认，请稍后查看' };
  if (reason) return { ...summary, state: job.status === 'partial' ? 'partial' : 'failed', message: `Orchestrate 未完整完成 · ${reason}` };
  if (summary) return summary;
  return { state: job.status === 'partial' ? 'partial' : 'failed',
    message: job.status === 'partial' ? 'Orchestrate 部分完成，请查看 Orchestrator' : 'Orchestrate 未完成，请查看 Orchestrator' };
}
