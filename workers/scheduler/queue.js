import { automaticRestWindow } from '../../src/utils/schedulerTime.ts';
import { actionTimeout, callAction } from './result.js';
import { day } from './schedule.js';
const pending = job => job.status === 'queued' || job.status === 'running';
const freshAttempt = () => ({ busy: 0, retries: 0, batches: 0, warmups: 0 });
// SQLite-backed Durable Object. Every transition is stored before the next HTTP request.
// One alarm performs one bounded backend call, so a multi-step job can exceed 15 minutes.
export class SchedulerQueue {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.running = false; }
  async state() { return await this.ctx.storage.get('state') || { jobs: [], lastCronAt: null }; }
  async change(fn) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.state();
      const result = await fn(state);
      await this.ctx.storage.put('state', state);
      return result;
    });
  }
  async arm(state) {
    const next = state.jobs.find(pending);
    if (next) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next.inFlightUntil || next.nextAt || 0));
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status') return Response.json(await this.state());
    if (path !== '/enqueue' || request.method !== 'POST') return new Response(null, { status: 404 });
    const { jobs, cronAt, coalesce } = await request.json();
    return this.change(async state => {
      if (cronAt) state.lastCronAt = Math.max(state.lastCronAt || 0, cronAt);
      const accepted = [];
      for (const definition of jobs) {
        let existing = state.jobs.find(job => job.id === definition.id);
        if (coalesce) existing ||= state.jobs.find(job => pending(job) && job.kind === definition.kind);
        if (!existing) {
          existing = { ...definition, status: 'queued', index: 0, attempt: freshAttempt(), results: [], nextAt: Date.now() };
          state.jobs.push(existing);
        }
        accepted.push({ id: existing.id, status: existing.status });
      }
      // Retain bounded operational history; no application records are stored here.
      const cutoff = Date.now() - 3 * 86400_000;
      state.jobs = state.jobs.filter(job => pending(job) || job.scheduledAt > cutoff).slice(-200);
      await this.arm(state);
      return Response.json({ ok: true, jobs: accepted }, { status: 202 });
    });
  }
  async alarm() {
    if (this.running) return;
    this.running = true;
    try {
      const claimed = await this.change(async state => {
        const job = state.jobs.find(pending);
        if (!job) return null;
        const now = Date.now(), action = job.steps[job.index];
        if ((job.inFlightUntil || job.nextAt || 0) > now) { await this.arm(state); return null; }
        // A process restart after a write has an unknown outcome. Do not send it again.
        if (job.inFlightUntil) {
          job.status = 'failed'; job.reason = 'interrupted-response-unknown'; job.finishedAt = now;
          await this.arm(state); return null;
        }
        if (automaticRestWindow(new Date(now))) {
          job.status = 'skipped'; job.reason = 'rest-window'; job.finishedAt = now;
          await this.arm(state); return null;
        }
        if (now - job.scheduledAt > 45 * 60_000 || day(now) !== day(job.scheduledAt)) {
          job.status = 'failed'; job.reason = 'expired'; job.finishedAt = now;
          await this.arm(state); return null;
        }
        job.status = 'running'; job.startedAt ||= now;
        job.inFlightUntil = now + actionTimeout(action) + 15_000;
        await this.arm(state);
        return structuredClone(job);
      });
      if (!claimed) return;
      const action = claimed.steps[claimed.index];
      const result = await callAction(action, this.env, claimed.attempt);
      await this.change(async state => {
        const job = state.jobs.find(item => item.id === claimed.id);
        if (!job || job.inFlightUntil !== claimed.inFlightUntil) return;
        delete job.inFlightUntil;
        if (result.outcome === 'retry' && (result.counter !== 'batches' || job.attempt.batches < 39)) {
          job.attempt[result.counter] = (job.attempt[result.counter] || 0) + 1;
          job.nextAt = Date.now() + result.delay;
        } else {
          const final = result.outcome === 'retry' ? { outcome: 'failed', reason: 'batch-limit' } : result;
          job.results.push({ action, ...final });
          // Archive/hair failures do not prevent the independent full plan.
          if (final.outcome === 'skipped') {
            job.status = 'skipped'; job.reason = final.reason;
          } else if (final.outcome === 'failed' && !['life-periods', 'hair-wash'].includes(action)) {
            job.status = 'failed'; job.reason = final.reason;
          } else if (++job.index === job.steps.length) {
            job.status = job.results.some(item => item.outcome === 'failed')
              ? job.results.some(item => item.outcome === 'partial') ? 'partial' : 'failed'
              : job.results.some(item => item.outcome === 'partial') ? 'partial' : 'success';
          } else { job.attempt = freshAttempt(); job.nextAt = Date.now() + 1000; }
          if (!pending(job)) job.finishedAt = Date.now();
        }
        await this.arm(state);
      });
    } finally { this.running = false; }
  }
}
