import { kv } from './_accountKv.js';
import { isOwnerScope } from './_accountScope.js';
import { readCloudSchedulerStatus } from './_cloudScheduler.js';
import { RULE_RUN_KEY } from './_schedulingRules.js';
import type { SchedulingRun } from '../src/utils/schedulingRules.js';
import type { OrchestrateProgress } from '../src/utils/orchestrateProgress.js';

export async function readOrchestrateProgress(jobId?: string): Promise<OrchestrateProgress | null> {
  const run = await kv.get<SchedulingRun>(RULE_RUN_KEY);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  const current = run && Number.isFinite(Date.parse(run.generatedAt))
    && day.format(new Date(run.generatedAt)) === day.format(new Date()) ? run : null;
  const failed = current?.results.filter(result => result.status === 'failed') ?? [];
  const reason = failed.some(result => result.id.startsWith('calendar-')) ? 'Outlook 日历读取失败'
    : failed.length ? '部分排期规则未完成，请查看 Orchestrator' : '本次执行失败，请查看 Orchestrator';
  if (jobId && isOwnerScope()) {
    try {
      const { jobs } = await readCloudSchedulerStatus();
      const job = jobs.find(item => item.id === jobId);
      if (!job) return { state: 'unknown', message: '本次执行状态暂未确认，请稍后查看' };
      if (job.status === 'queued') return { state: 'queued', message: 'Orchestrate 排队中…' };
      if (job.status === 'running') return { state: 'running', message: 'Orchestrate 排期中…' };
      if (job.status === 'success') return { state: 'success', message: 'Orchestrate 已完成' };
      return { state: 'failed', message: `Orchestrate 未完成：${reason}` };
    } catch { return { state: 'unknown', message: '本次执行状态暂未确认，请稍后查看' }; }
  }
  // A missing daily snapshot is not an empty successful plan. Surface today's
  // recorded failure without dispatching work or returning raw provider errors.
  return failed.length ? { state: 'failed', message: `Orchestrate 未完成：${reason}` } : null;
}
