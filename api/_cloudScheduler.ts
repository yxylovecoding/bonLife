import { randomUUID } from 'node:crypto';
function schedulerRequest(path: '/dispatch' | '/status') {
  const endpoint = process.env.CLOUD_SCHEDULER_URL?.trim();
  const secret = process.env.CLOUD_SCHEDULER_SECRET?.trim();
  if (!endpoint || !secret) throw new Error('云端调度尚未配置');
  const url = new URL(path, endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.workers.dev'))
    throw new Error('云端调度地址无效');
  return { url, secret };
}
export async function dispatchFullReplan() {
  const { url, secret } = schedulerRequest('/dispatch');
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'full', id: randomUUID() }),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => null);
  if (response.status !== 202 || result?.ok !== true || !result.jobs?.[0]?.id)
    throw new Error(`云端调度触发失败（HTTP ${response.status}）`);
  return { jobId: result.jobs[0].id };
}

// Operational metadata only. Never forward credentials, provider bodies or application records.
export async function readCloudSchedulerStatus() {
  const { url, secret } = schedulerRequest('/status');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => null);
  if (response.status !== 200 || !Array.isArray(result?.jobs))
    throw new Error(`云端调度状态读取失败（HTTP ${response.status}）`);
  const actions = new Set(['full', 'hourly-replan', 'life-periods', 'daily-routine', 'routine-visibility',
    'night-routine', 'reading-visibility', 'hair-wash', 'monthly-backup', 'daily-email']);
  const statuses = new Set(['queued', 'running', 'success', 'failed', 'skipped']);
  const reasons = new Set(['interrupted-response-unknown', 'rest-window', 'expired', 'batch-limit',
    'backup-incomplete', 'period-import', 'busy', 'incomplete', 'rules-incomplete', 'plan-incomplete',
    'visibility-incomplete', 'email-cancelled', 'missing-run-secret', 'response-unknown']);
  const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { lastCronAt: time(result.lastCronAt), jobs: result.jobs.slice(-200).map((job: any) => ({
    kind: ['full', 'hourly', 'night', 'midnight', 'monthly-backup'].includes(job.kind) ? job.kind : 'other',
    status: statuses.has(job.status) ? job.status : 'unknown',
    scheduledAt: time(job.scheduledAt), startedAt: time(job.startedAt), finishedAt: time(job.finishedAt),
    nextAt: time(job.nextAt), inFlightUntil: time(job.inFlightUntil),
    reason: reasons.has(job.reason) ? job.reason : undefined,
    steps: Array.isArray(job.steps) ? job.steps.filter((step: unknown) => actions.has(step as string)) : [],
    index: Number.isInteger(job.index) ? job.index : null,
    results: Array.isArray(job.results) ? job.results.map((item: any) => ({
      action: actions.has(item.action) ? item.action : 'unknown',
      outcome: statuses.has(item.outcome) ? item.outcome : 'unknown',
      reason: reasons.has(item.reason) ? item.reason : undefined,
      http: Number.isInteger(item.http) ? item.http : undefined,
    })) : [],
  })) };
}
