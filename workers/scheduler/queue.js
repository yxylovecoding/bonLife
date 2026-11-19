import { automaticRestWindow } from '../../src/utils/schedulerTime.ts';
import { actionTimeout, callAction } from './result.js';
import { day } from './schedule.js';
import { pushEndpoint, pushKeys, sendPush } from './push.js';

const pending = job => ['queued', 'running', 'retrying'].includes(job.status);
const orche = job => ['full', 'hourly'].includes(job.kind);
const due = job => job.inFlightUntil || job.nextAt || 0;
const stale = (job, now) => now - job.scheduledAt > 45 * 60_000 || day(now) !== day(job.scheduledAt);
const freshAttempt = () => ({ busy: 0, retries: 0, batches: 0, warmups: 0 });
function journalTime(alert, now) {
  if (!alert) return Infinity;
  const next = Math.max(now, alert.nextAt);
  return automaticRestWindow(new Date(next)) ? Date.parse(`${day(next)}T05:01:00+08:00`) : next;
}
function recordJournal(state, job, now) {
  if (!orche(job)) return;
  const attempt = job.retryRound || 0;
  const id = `${job.id}-${attempt}`;
  const outbox = state.journal ||= { entries: [], attempts: 0, nextAt: now };
  if (!outbox.entries.some(event => event.id === id)) outbox.entries.push({
    id, at: now, status: job.status, attempt,
    source: job.id.startsWith('manual-') ? 'manual' : job.kind,
    ...(job.reason ? { reason: job.reason } : {}),
  });
}
function migrateTaskAlert(state) {
  if (!state.taskAlert) return;
  const at = state.taskAlert.createdAt;
  const job = state.jobs.filter(job => orche(job) && job.scheduledAt <= at
    && (['partial', 'failed', 'retrying'].includes(job.status)
      || job.retryRound > 0 && job.startedAt <= at && job.finishedAt >= at)).at(-1);
  // The previous outbox did not retain the attempt number. Keep this ID
  // separate from all live attempts, including the recovery already queued.
  if (job) recordJournal(state, { ...job, id: `${job.id}-legacy`, retryRound: 0,
    status: job.status === 'partial' || job.results.some(result => result.outcome === 'partial') ? 'partial' : 'failed' }, at);
  delete state.taskAlert;
  delete state.lastTaskAlertDay;
}
function nextJob({ jobs }) {
  // Preserve serial writes even when an alarm is restored after a restart.
  return jobs.find(job => pending(job) && job.inFlightUntil)
    ?? jobs.reduce((next, job) => pending(job) && (!next || due(job) < due(next)) ? job : next, null);
}

function canRetry(result) {
  return ['origin-not-ready', 'busy', 'read-unavailable'].includes(result.reason)
    || result.reason === 'period-import' && ![401, 403].includes(result.http)
    || result.reconcile === true;
}

function incomplete(job, now) {
  const problem = job.results.find(result => ['failed', 'partial'].includes(result.outcome));
  job.status = job.results.some(result => result.outcome === 'partial') ? 'partial' : 'failed';
  job.reason ||= problem?.reason;
  job.finishedAt = now;
}

// SQLite-backed Durable Object. Persist each claim before contacting Render.
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
    const job = nextJob(state);
    const alertAt = state.alerts?.reduce((next, alert) => Math.min(next, alert.nextAt), Infinity) ?? Infinity;
    const next = Math.min(job ? due(job) : Infinity, alertAt, journalTime(state.journal ?? state.taskAlert, Date.now()));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/status') {
      const { jobs, lastCronAt } = await this.state();
      return Response.json({ jobs, lastCronAt });
    }
    if (path === '/push') return this.pushSettings(request);
    if (path !== '/enqueue' || request.method !== 'POST') return new Response(null, { status: 404 });
    const { jobs, cronAt, coalesce } = await request.json();
    return this.change(async state => {
      migrateTaskAlert(state);
      if (cronAt) state.lastCronAt = Math.max(state.lastCronAt || 0, cronAt);
      const accepted = [];
      for (const definition of jobs) {
        let existing = state.jobs.find(job => job.id === definition.id);
        if (coalesce) existing ||= state.jobs.find(job => pending(job) && job.kind === definition.kind
          && definition.steps.every(step => job.steps.includes(step)));
        if (!existing) {
          existing = { ...definition, status: 'queued', index: 0, attempt: freshAttempt(), results: [], nextAt: Date.now() };
          state.jobs.push(existing);
        }
        accepted.push({ id: existing.id, status: existing.status });
      }
      const cutoff = Date.now() - 3 * 86400_000;
      state.jobs = state.jobs.filter(job => pending(job) || job.scheduledAt > cutoff);
      let overflow = Math.max(0, state.jobs.length - 200);
      state.jobs = state.jobs.filter(job => pending(job) || overflow-- <= 0);
      await this.arm(state);
      return Response.json({ ok: true, jobs: accepted }, { status: 202 });
    });
  }
  async pushSettings(request) {
    if (request.method === 'GET') {
      const { publicKey } = await this.ctx.blockConcurrencyWhile(() => pushKeys(this.ctx.storage));
      return Response.json({ publicKey });
    }
    const body = await request.json().catch(() => null);
    const endpoint = pushEndpoint(body?.endpoint);
    if (!endpoint || !['status', 'enable', 'disable'].includes(body.action)) return new Response(null, { status: 400 });
    return this.ctx.blockConcurrencyWhile(async () => {
      const subscriptions = await this.ctx.storage.get('push-subscriptions') || [];
      if (body.action === 'status') return Response.json({ enabled: subscriptions.includes(endpoint) });
      const updated = subscriptions.filter(value => value !== endpoint);
      if (body.action === 'enable') {
        if (updated.length >= 12) return new Response(null, { status: 409 });
        updated.push(endpoint);
      }
      await this.ctx.storage.put('push-subscriptions', updated);
      return Response.json({ enabled: body.action === 'enable' });
    });
  }
  async noteFailure(state, job, now) {
    if (!orche(job)) return;
    const reason = `${job.kind}:${job.reason || 'rules-incomplete'}`;
    const notices = state.notices ||= {};
    if (!job.id.startsWith('manual-') && (notices[reason] || 0) > now) return;
    if (job.notified) return;
    const endpoints = await this.ctx.storage.get('push-subscriptions') || [];
    if (!endpoints.length) return;
    job.notified = true;
    if (!job.id.startsWith('manual-')) notices[reason] = now + 6 * 3600_000;
    (state.alerts ||= []).push({ id: job.id, nextAt: now, attempts: 0, endpoints });
  }
  async deliver(alert) {
    const keys = await pushKeys(this.ctx.storage);
    const subscribed = await this.ctx.storage.get('push-subscriptions') || [];
    const results = await Promise.all(alert.endpoints.filter(endpoint => subscribed.includes(endpoint))
      .map(async endpoint => ({ endpoint, outcome: await sendPush(endpoint, keys) })));
    await this.change(async state => {
      const expired = new Set(results.filter(result => result.outcome === 'expired').map(result => result.endpoint));
      if (expired.size) {
        const endpoints = await this.ctx.storage.get('push-subscriptions') || [];
        await this.ctx.storage.put('push-subscriptions', endpoints.filter(endpoint => !expired.has(endpoint)));
      }
      const waiting = results.filter(result => result.outcome === 'retry').map(result => result.endpoint);
      state.alerts = state.alerts.filter(item => item.id !== alert.id);
      if (waiting.length && alert.attempts < 3) state.alerts.push({
        ...alert, endpoints: waiting, attempts: alert.attempts + 1, nextAt: Date.now() + 60_000 * 2 ** alert.attempts,
      });
      await this.arm(state);
    });
  }
  async deliverJournal(journal) {
    const entries = journal.entries.slice(0, 30);
    const result = await callAction('orche-journal', this.env, { ...freshAttempt(), warmups: journal.attempts }, entries);
    await this.change(async state => {
      const now = Date.now();
      if (result.outcome === 'success') {
        const sent = new Set(entries.map(entry => entry.id));
        const remaining = state.journal.entries.filter(entry => !sent.has(entry.id));
        if (remaining.length) state.journal = { entries: remaining, nextAt: now, attempts: 0 };
        else delete state.journal;
        console.info('[orche-journal]', 'confirmed', entries.length);
      } else {
        const attempts = journal.attempts + 1;
        state.journal.attempts = attempts;
        state.journal.nextAt = now + 30_000 * Math.min(2 ** (attempts - 1), 30);
      }
      await this.arm(state);
    });
  }
  async finish(state, job, now) {
    if (job.results.every(result => !['failed', 'partial'].includes(result.outcome))) {
      job.status = 'success'; job.finishedAt = now; delete job.reason;
      recordJournal(state, job, now);
      for (const reason of Object.keys(state.notices ?? {}))
        if (reason.startsWith(`${job.kind}:`)) delete state.notices[reason];
      return;
    }
    incomplete(job, now);
    recordJournal(state, job, now);
    await this.noteFailure(state, job, now);
    const retry = job.results.find(result => canRetry(result));
    const round = (job.retryRound || 0) + 1;
    const nextAt = now + 60_000 * Math.min(2 ** round, 10);
    if (!orche(job) || !retry || stale(job, nextAt) || automaticRestWindow(new Date(nextAt))) return;
    job.status = 'retrying'; job.retryRound = round; job.index = job.steps.indexOf(retry.action);
    job.nextAt = nextAt; job.attempt = freshAttempt(); delete job.finishedAt;
  }
  async alarm() {
    if (this.running) return;
    this.running = true;
    try {
      const state = await this.state();
      if (state.taskAlert) {
        await this.change(async state => { migrateTaskAlert(state); await this.arm(state); });
        return;
      }
      const now = Date.now();
      const next = nextJob(state);
      if ((!next || due(next) > now) && journalTime(state.journal, now) <= now) {
        await this.deliverJournal(state.journal); return;
      }
      const alert = state.alerts?.find(item => item.nextAt <= now);
      if (alert) { await this.deliver(alert); return; }
      const claimed = await this.change(async state => {
        const job = nextJob(state);
        if (!job) return null;
        const now = Date.now(), action = job.steps[job.index];
        if (due(job) > now) { await this.arm(state); return null; }
        if (job.inFlightUntil) {
          delete job.inFlightUntil;
          job.status = 'failed'; job.reason = 'interrupted-response-unknown'; job.finishedAt = now;
          recordJournal(state, job, now);
          await this.noteFailure(state, job, now);
          await this.arm(state); return null;
        }
        if (automaticRestWindow(new Date(now)) || stale(job, now)) {
          if (job.retryRound) incomplete(job, now);
          else if (automaticRestWindow(new Date(now))) {
            job.status = 'skipped'; job.reason = 'rest-window'; job.finishedAt = now;
          } else {
            job.status = 'failed'; job.reason = 'expired'; job.finishedAt = now;
            recordJournal(state, job, now);
            await this.noteFailure(state, job, now);
          }
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
          if (final.outcome === 'skipped' && job.retryRound) {
            incomplete(job, Date.now());
          } else {
            const previousIndex = job.results.findIndex(item => item.action === action);
            const record = { action, ...final };
            if (previousIndex === -1) job.results.push(record); else job.results[previousIndex] = record;
            const followed = final.outcome !== 'failed' || ['life-periods', 'hair-wash'].includes(action);
            if (final.outcome === 'skipped') {
              job.status = 'skipped'; job.reason = final.reason; job.finishedAt = Date.now();
            } else {
              const next = followed ? job.steps.findIndex((step, index) => {
                if (index <= job.index) return false;
                const previous = job.results.find(item => item.action === step);
                return !job.retryRound || !previous || canRetry(previous);
              }) : -1;
              if (next < 0) {
                if (followed) job.index = job.steps.length;
                delete job.reason;
                await this.finish(state, job, Date.now());
              } else {
                job.index = next; job.attempt = freshAttempt(); job.nextAt = Date.now() + 1000;
              }
            }
          }
        }
        await this.arm(state);
      });
    } finally { this.running = false; }
  }
}
