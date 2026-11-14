import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CRONS, manualJob, scheduledJobs } from './schedule.js';
import { classify, callAction } from './result.js';
import { SchedulerQueue } from './queue.js';
import { schedulerResponse } from '../../api/_schedulerResponse';
import worker from './index.js';
const attempt = { retries: 0, busy: 0, batches: 0 };
const good = () => Response.json({ ok: true, dailyPlan: {} });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T04:01:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('cloud schedule', () => {
  it('runs one morning sequence at 05:01 with no automatic triggers during rest', () => {
    for (let hour = 0; hour < 24; hour++) {
      const base = Date.UTC(2026, 9, 24, hour);
      expect(scheduledJobs(base + 60_000).map(j => j.kind)).toEqual(hour === 21 ? ['full'] : (hour <= 16 || hour >= 22) ? ['hourly'] : []);
      expect(scheduledJobs(base + 7 * 60_000)).toEqual([]);
      expect(scheduledJobs(base).some(j => j.kind === 'full')).toBe([4, 9, 12].includes(hour));
    }
    expect(scheduledJobs(Date.parse('2026-10-24T21:00Z'))).toEqual([]);
    expect(scheduledJobs(Date.parse('2026-10-24T21:01Z')).map(j => j.steps)).toEqual([
      ['routine-visibility', 'life-periods', 'full'],
    ]);
    expect(scheduledJobs(Date.parse('2026-10-24T12:00Z'))[0].steps).toEqual(['hair-wash', 'life-periods', 'full']);
    expect(scheduledJobs(Date.parse('2026-10-24T16:00Z'))[0].steps).toEqual(['daily-routine']);
    expect(scheduledJobs(Date.parse('2026-10-24T14:00Z'))[0].steps).toEqual(['night-routine']);
    expect(JSON.parse(readFileSync('workers/scheduler/wrangler.jsonc', 'utf8')).triggers.crons).toEqual(CRONS);
    expect(scheduledJobs(Date.parse('2026-10-24T23:01Z')).map(j => j.steps)).toEqual([['reading-visibility', 'hourly-replan']]);
    expect(manualJob('full', 'x', Date.now()).steps).toEqual(['routine-visibility', 'life-periods', 'full']);
  });
});
describe('response and retry boundary', () => {
  it('distinguishes a gateway page from an application rule failure without logging private values', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response('<html>PRIVATE gateway body</html>', { status: 502, headers: {
          'content-type': 'text/html', 'cf-cache-status': 'HIT', 'cf-ray': '0123456789abcdef-SIN' } }))
        .mockResolvedValueOnce(Response.json({ ok: false, error: 'PRIVATE task error', rulesComplete: false }, { status: 502,
          headers: { 'x-render-origin-server': 'Render', 'x-private': 'PRIVATE header', 'cf-ray': 'PRIVATE header', 'cf-cache-status': 'PRIVATE header' } })));
      const env = { ORIGIN: 'https://backend.example', SCHEDULER_RUN_SECRET: 'PRIVATE credential' };
      expect(await callAction('hourly-replan', env, attempt)).toMatchObject({ outcome: 'failed', http: 502 });
      expect(await callAction('hourly-replan', env, attempt)).toMatchObject({ outcome: 'failed', http: 502 });
      const records = log.mock.calls.map(call => JSON.parse(call[1]));
      expect(records[0]).toMatchObject({ phase: 'business', http: 502, responseKind: 'html', renderOrigin: false,
        edgeCache: 'HIT', edgeRequest: '0123456789abcdef-SIN' });
      expect(records[1]).toMatchObject({ phase: 'business', http: 502, responseKind: 'application-json', renderOrigin: true,
        applicationError: true, rulesComplete: false });
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
      expect(JSON.stringify(log.mock.calls)).not.toContain('backend.example');
    } finally { log.mockRestore(); }
  });
  it('records readiness timeout separately from business requests', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('PRIVATE timeout detail', 'TimeoutError')));
      expect(await callAction('hourly-replan', { ORIGIN: 'https://bonbills.onrender.com', SCHEDULER_RUN_SECRET: 'PRIVATE' }, attempt))
        .toMatchObject({ outcome: 'retry', counter: 'warmups' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({ phase: 'readiness', http: 0, responseKind: 'none', networkError: 'TimeoutError' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
    } finally { log.mockRestore(); }
  });
  it('waits through Render cold-start failures before sending one business request', async () => {
    const env = { ORIGIN: 'https://bonbills.onrender.com', SCHEDULER_RUN_SECRET: 'PRIVATE' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockRejectedValueOnce(new Error('read timeout'))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(good());
    vi.stubGlobal('fetch', fetcher);
    expect(await callAction('hourly-replan', env, attempt)).toMatchObject({ outcome: 'retry', counter: 'warmups', http: 502 });
    expect(await callAction('hourly-replan', env, { ...attempt, warmups: 1 })).toMatchObject({ outcome: 'retry', counter: 'warmups', http: 0 });
    expect(await callAction('hourly-replan', env, { ...attempt, warmups: 2 })).toEqual({ outcome: 'success' });
    expect(fetcher.mock.calls.slice(0, 3).map(([url]) => new URL(String(url)).pathname)).toEqual(['/healthz', '/', '/healthz']);
    for (const [url, options] of fetcher.mock.calls.slice(0, 3)) {
      expect(new URL(String(url)).searchParams.get('_scheduler_probe')).toBe(String(Date.now()));
      expect(options.headers['User-Agent']).toBe('bonbills-scheduler/1.0');
      expect(options.headers['Cache-Control']).toBe('no-cache');
      expect(options.headers.Authorization).toBeUndefined(); expect(options.redirect).toBe('manual');
    }
    expect(new URL(String(fetcher.mock.calls[3][0])).searchParams.get('action')).toBe('hourly-replan');
    expect(fetcher.mock.calls[3][1].headers.Authorization).toBe('Bearer PRIVATE');
  });
  it.each([Response.json({ ok: true }), new Response('<html>loading</html>', { headers: { 'content-type': 'text/html' } })])
    ('always rechecks health after a successful wake request', async response => {
      const fetcher = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetcher);
      expect(await callAction('hourly-replan', { ORIGIN: 'https://bonbills.onrender.com', SCHEDULER_RUN_SECRET: 'PRIVATE' },
        { ...attempt, warmups: 1 })).toMatchObject({ outcome: 'retry', counter: 'warmups', http: 200 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe('/');
      expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });
  it('bounds readiness retries and rejects a loading page without running a task', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<html>loading</html>', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await callAction('full', { ORIGIN: 'https://bonbills.onrender.com', SCHEDULER_RUN_SECRET: 'secret' },
      { ...attempt, warmups: 12 })).toEqual({ outcome: 'failed', reason: 'origin-not-ready', http: 200 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry uncertain business writes after readiness succeeds', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true }))
      .mockRejectedValueOnce(new Error('write response lost'));
    vi.stubGlobal('fetch', fetcher);
    expect(await callAction('full', { ORIGIN: 'https://bonbills.onrender.com', SCHEDULER_RUN_SECRET: 'secret' }, attempt))
      .toEqual({ outcome: 'failed', reason: 'response-unknown', http: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('runs monthly backup only at Shanghai month start with the explicit flag', () => {
    const due = Date.parse('2026-12-01T00:10:00Z');
    expect(scheduledJobs(due)).toEqual([]);
    expect(scheduledJobs(due, { monthlyBackup: true }).map(job => job.steps)).toEqual([['monthly-backup']]);
    expect(scheduledJobs(due + 86400_000, { monthlyBackup: true })).toEqual([]);
    expect(scheduledJobs(due - 60_000, { monthlyBackup: true })).toEqual([]);
    expect(() => manualJob('monthly-backup', 'x', due)).toThrow('Invalid job kind');
  });
  it('uses the separate backup credential and requires a completed snapshot', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, date: '2026-12-01', storedKeys: 12 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await callAction('monthly-backup', {
      ORIGIN: 'https://backend.example', SCHEDULER_RUN_SECRET: 'scheduler', BACKUP_RUN_SECRET: 'backup',
    }, attempt)).toEqual({ outcome: 'success' });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://backend.example/api/sync-monthly-backup');
    expect(options.headers.Authorization).toBe('Bearer backup');
    expect(options.redirect).toBe('manual');
    for (const body of [{ ok: true }, { ok: true, date: '2026-12-01', storedKeys: 0 }]) {
      expect(classify('monthly-backup', 200, body, attempt).outcome).toBe('failed');
    }
  });
  it('does not send a backup without its credential or replay an unknown response', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('connection lost'));
    vi.stubGlobal('fetch', fetcher);
    expect(await callAction('monthly-backup', {
      ORIGIN: 'https://backend.example', SCHEDULER_RUN_SECRET: 'scheduler',
    }, attempt)).toMatchObject({ outcome: 'failed', reason: 'missing-run-secret' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await callAction('monthly-backup', {
      ORIGIN: 'https://backend.example', BACKUP_RUN_SECRET: 'backup',
    }, attempt)).toMatchObject({ outcome: 'failed', reason: 'response-unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['outlook-refresh', 'tasks-read', 'completion-history', 'template-read'])('retries only explicitly safe %s failures', stage => {
    const body = { failure: { stage, retryable: true }, error: 'PRIVATE' };
    expect(classify('hourly-replan', 502, body, attempt)).toMatchObject({ outcome: 'retry', delay: 30_000 });
    expect(classify('full', 502, body, { ...attempt, retries: 1 })).toMatchObject({ outcome: 'retry', delay: 60_000 });
    expect(classify('full', 502, body, { ...attempt, retries: 2 }).outcome).toBe('failed');
  });
  it.each(['planning', 'finalize', 'timed-visibility', 'PRIVATE'])('does not replay a %s write or unknown failure', stage => {
    expect(classify('full', 502, { error: 'PRIVATE', failure: { stage, retryable: true } }, attempt).outcome).toBe('failed');
  });
  it('treats deferred hourly as a lock wait, never successful completion', () => {
    expect(classify('hourly-replan', 200, { ok: true, deferred: true, dailyPlan: {} }, attempt)).toMatchObject({ outcome: 'retry', counter: 'busy' });
    expect(classify('full', 202, { busy: true }, { ...attempt, busy: 12 }).outcome).toBe('failed');
  });
  it.each(['sleep-window', 'restore-pending', 'disconnected'])('accepts deliberate %s hourly skip', skipped => {
    expect(classify('hourly-replan', 200, { ok: true, skipped }, attempt).outcome).toBe('success');
  });
  it('confirms the separate 07:01 reading visibility step before marking it successful', () => {
    expect(classify('reading-visibility', 200, { ok: true, reading: { updated: 1 } }, attempt).outcome).toBe('success');
    expect(classify('reading-visibility', 200, { ok: true }, attempt).outcome).toBe('failed');
  });
  it('continues only persisted tag batches and checks all required results', () => {
    expect(classify('full', 202, { sleepTags: { complete: false } }, attempt)).toMatchObject({ outcome: 'retry', counter: 'batches' });
    expect(classify('routine-visibility', 200, { ok: true, sleepTags: { complete: false } }, attempt).outcome).toBe('retry');
    for (const body of [{ ok: true }, { ok: true, dailyPlan: {}, laundry: { outlook: { error: 'PRIVATE' } } },
      { ok: true, dailyPlan: {}, charging: { outlook: { error: 'PRIVATE' } } }, { ok: true, dailyPlan: {}, hairWash: { outlook: { error: 'PRIVATE' } } }])
      expect(classify('full', 200, body, attempt).outcome).toBe('failed');
    expect(classify('routine-visibility', 200, { ok: true, sleepTags: { complete: true } }, attempt).outcome).toBe('failed');
  });
  it('never follows an upstream redirect with the cron credential', async () => {
    const fn = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } }));
    vi.stubGlobal('fetch', fn);
    expect(await callAction('full', { ORIGIN: 'https://www.bonbills.cn', SCHEDULER_RUN_SECRET: 'secret' }, attempt)).toMatchObject({ outcome: 'failed', http: 302 });
    expect(fn.mock.calls[0][1].redirect).toBe('manual');
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('does not log or persist credentials, private bodies, or ambiguous network writes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE request')));
    const result = await callAction('full', { ORIGIN: 'https://www.bonbills.cn', SCHEDULER_RUN_SECRET: 'PRIVATE secret' }, attempt);
    expect(result).toEqual({ outcome: 'failed', reason: 'response-unknown', http: 0 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await callAction('life-periods', { ORIGIN: 'https://www.bonbills.cn', SCHEDULER_RUN_SECRET: 'secret' }, attempt)).toMatchObject({ outcome: 'retry' });
  });
});

function fixture() {
  const records = new Map(); let alarmAt: number | null = null, gate = Promise.resolve();
  const ctx = {
    storage: {
      get: async key => structuredClone(records.get(key)),
      put: async (key, value) => { records.set(key, structuredClone(value)); },
      setAlarm: async value => { alarmAt = value; }, deleteAlarm: async () => { alarmAt = null; },
    },
    blockConcurrencyWhile(fn) { const next = gate.then(fn); gate = next.catch(() => {}); return next; },
  };
  const env = { ORIGIN: 'https://www.bonbills.cn', SCHEDULER_RUN_SECRET: 'secret' };
  const queue = new SchedulerQueue(ctx, env);
  const enqueue = (jobs, extra = {}) => queue.fetch(new Request('https://queue/enqueue', { method: 'POST', body: JSON.stringify({ jobs, ...extra }) }));
  const tick = async (target = queue) => { if (alarmAt !== null) vi.setSystemTime(alarmAt); await target.alarm(); };
  return { ctx, env, queue, enqueue, tick, state: () => ctx.storage.get('state') };
}
describe('durable serial execution', () => {
  it('部分显隐继续经期和完整排程，保留部分结果且不重放已确认步骤', async () => {
    const partial = { ok: true, partial: true, rulesComplete: false, error: 'some rules held',
      rules: { results: [{ id: 'visibility-reading', status: 'success' }, { id: 'visibility-location', status: 'skipped' }] } };
    const f = fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(schedulerResponse(partial)))
      .mockResolvedValueOnce(Response.json({ ok: true, connected: false }))
      .mockResolvedValueOnce(Response.json(schedulerResponse(partial), { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    await f.enqueue([manualJob('full', 'partial', Date.now())]);
    await f.tick(); await f.tick(); await f.tick(); await f.tick();
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'partial', index: 3,
      results: [{ action: 'routine-visibility', outcome: 'partial' }, { action: 'life-periods', outcome: 'success' }, { action: 'full', outcome: 'partial' }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(classify('full', 200, { ...partial, rules: { results: [] } }, attempt).outcome).toBe('failed');
  });
  it('重复的定时显隐由后续完整步骤执行，队列不会提前停止或重复写', async () => {
    const f = fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(schedulerResponse({ ok: true, rulesComplete: true, skipped: 'included-in-full' })))
      .mockResolvedValueOnce(Response.json({ ok: true, connected: false }))
      .mockResolvedValueOnce(Response.json({ ok: true, rulesComplete: true }));
    vi.stubGlobal('fetch', fetcher);
    await f.enqueue([manualJob('full', 'consolidated', Date.now())]);
    await f.tick(); await f.tick(); await f.tick();
    expect((await f.state()).jobs[0].status).toBe('success'); expect(fetcher).toHaveBeenCalledTimes(3);
    const safe = schedulerResponse({ ok: true, partial: true, rulesComplete: false, error: 'PRIVATE',
      rules: { results: [{ id: 'PRIVATE', status: 'success', reason: 'PRIVATE' }] } });
    expect(safe).toEqual({ ok: true, partial: true, rulesComplete: false, error: true, completedRules: 1 });
  });
  it('persists readiness retries across alarms without replaying the business action', async () => {
    const f = fixture(); f.env.ORIGIN = 'https://bonbills.onrender.com';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('<html>loading</html>'))
      .mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(good());
    vi.stubGlobal('fetch', fetcher);
    await f.enqueue([manualJob('hourly', 'wake', Date.now())]); await f.tick();
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'running', index: 0, attempt: { warmups: 1 } });
    await f.tick(new SchedulerQueue(f.ctx, f.env));
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'running', index: 0, attempt: { warmups: 2 } });
    expect(fetcher.mock.calls.some(([url]) => new URL(String(url)).pathname.startsWith('/api/'))).toBe(false);
    await f.tick(new SchedulerQueue(f.ctx, f.env));
    expect((await f.state()).jobs[0].status).toBe('success');
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/ticktick-trips')).toHaveLength(1);
  });
  it.each(['hourly', 'full', 'night', 'midnight', 'morning'])('skips delayed %s work that reaches the queue during the Shanghai rest window', async kind => {
    vi.setSystemTime(new Date('2026-10-24T16:01:00Z'));
    const f = fixture(); vi.stubGlobal('fetch', vi.fn());
    await f.enqueue([{ ...manualJob('full', kind, Date.now()), kind }]);
    vi.setSystemTime(new Date('2026-10-24T16:30:00Z'));
    await f.queue.alarm();
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'skipped', reason: 'rest-window' });
    expect(fetch).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-25T00:01:00Z'));
    vi.mocked(fetch).mockResolvedValue(good());
    await f.enqueue(scheduledJobs(Date.now())); await f.tick();
    expect((await f.state()).jobs[1].status).toBe('success');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops the remaining sequence, including email, when the API reports rest', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, skipped: 'rest-window' })));
    await f.enqueue([{ ...manualJob('full', 'rest-crossing', Date.now()), steps: ['full', 'daily-email'] }]);
    await f.tick(); await f.tick();
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'skipped', reason: 'rest-window' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('deduplicates cron delivery and overlapping manual dispatch, retaining completions', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(good()));
    const jobs = scheduledJobs(Date.now());
    await Promise.all([f.enqueue(jobs), f.enqueue(jobs)]);
    expect((await f.state()).jobs).toHaveLength(1);
    await f.tick(); expect((await f.state()).jobs[0].status).toBe('success');
    await f.enqueue(jobs); await f.tick(); expect(fetch).toHaveBeenCalledTimes(1);
    await f.enqueue([manualJob('full', 'a', Date.now())], { coalesce: true });
    await f.enqueue([manualJob('full', 'b', Date.now())], { coalesce: true });
    expect((await f.state()).jobs).toHaveLength(2);
  });
  it('serializes enqueue during a long request without losing the following job', async () => {
    const f = fixture(); let finish; let entered;
    const started = new Promise(resolve => { entered = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); }));
    await f.enqueue([manualJob('hourly', 'first', Date.now())]);
    const running = f.tick(); await started;
    await f.enqueue([manualJob('hourly', 'next', Date.now())]);
    expect((await f.state()).jobs[0].inFlightUntil).toBeGreaterThan(Date.now());
    finish(good()); await running;
    expect((await f.state()).jobs.map(j => j.status)).toEqual(['success', 'queued']);
  });
  it('never replays an uncertain request after a process restart', async () => {
    const f = fixture(); await f.enqueue([manualJob('full', 'restart', Date.now())]);
    const state = await f.state(); Object.assign(state.jobs[0], { status: 'running', index: 1, inFlightUntil: Date.now() - 1 });
    await f.ctx.storage.put('state', state); vi.stubGlobal('fetch', vi.fn());
    await f.tick(new SchedulerQueue(f.ctx, f.env));
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'failed', reason: 'interrupted-response-unknown' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('continues planning after archive failure and retains the failure', async () => {
    vi.setSystemTime(new Date('2026-10-24T21:01Z'));
    const f = fixture(); const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, sleepTags: { complete: true }, nightRoutine: {}, exercise: {} }))
      .mockResolvedValueOnce(Response.json({ error: 'PRIVATE' }, { status: 401 }))
      .mockResolvedValueOnce(good()); vi.stubGlobal('fetch', fetcher);
    await f.enqueue(scheduledJobs(Date.now()).filter(j => j.kind === 'full'));
    await f.tick(); await f.tick(); await f.tick(); await f.tick();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(await f.state())).not.toContain('PRIVATE');
  });
  it('completes the morning archive and plan without sending email', async () => {
    vi.setSystemTime(new Date('2026-10-24T21:01Z'));
    const f = fixture(); vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, sleepTags: { complete: true }, nightRoutine: {}, exercise: {} }))
      .mockResolvedValueOnce(Response.json({ ok: true, connected: false }))
      .mockResolvedValueOnce(good()));
    await f.enqueue(scheduledJobs(Date.now()).filter(j => j.kind === 'full'));
    await f.tick(); await f.tick(); await f.tick(); await f.tick();
    expect((await f.state()).jobs[0].status).toBe('success');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get('action') ?? 'full'))
      .toEqual(['routine-visibility', 'life-periods', 'full']);
  });
  it('skips an email step persisted by an older deployment without any HTTP request', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn());
    await f.enqueue([{ ...manualJob('full', 'legacy-email', Date.now()), steps: ['daily-email'] }]);
    await f.tick();
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'skipped', reason: 'email-cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('stops the morning sequence immediately if visibility restoration fails', async () => {
    vi.setSystemTime(new Date('2026-10-24T21:01Z'));
    const f = fixture(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: true }, { status: 502 })));
    await f.enqueue(scheduledJobs(Date.now())); await f.tick(); await f.tick();
    expect((await f.state()).jobs[0].status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('expires stale jobs and bounds restoration attempts', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json({ sleepTags: { complete: false } }, { status: 202 })));
    await f.enqueue([{ ...manualJob('full', 'batch', Date.now()), steps: ['full'] }]);
    for (let i = 0; i < 40; i++) await f.tick();
    expect((await f.state()).jobs[0]).toMatchObject({ status: 'failed', reason: 'batch-limit' });
    expect(fetch).toHaveBeenCalledTimes(40);
    await f.enqueue([manualJob('full', 'old', Date.now() - 46 * 60_000)]); await f.tick();
    expect((await f.state()).jobs[1]).toMatchObject({ status: 'failed', reason: 'expired' });
    expect(fetch).toHaveBeenCalledTimes(40);
  });
});
describe('dispatcher authentication', () => {
  it('rejects unauthorized access and disallows caller-selected URLs or email jobs', async () => {
    const env = { DISPATCH_SECRET: 'secret' };
    expect((await worker.fetch(new Request('https://worker/status'), env)).status).toBe(401);
    expect((await worker.fetch(new Request('https://worker/dispatch', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: JSON.stringify({ kind: 'daily-email', id: 'x' }) }), env)).status).toBe(400);
  });
});
