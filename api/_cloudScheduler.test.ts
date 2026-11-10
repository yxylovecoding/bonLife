import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchFullReplan, readCloudSchedulerStatus } from './_cloudScheduler';
import { schedulerResponse } from './_schedulerResponse';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('cloud manual dispatch', () => {
  it('reads queue state without dispatching or exposing extra fields', async () => {
    vi.stubEnv('CLOUD_SCHEDULER_URL', 'https://bonbills-scheduler.example.workers.dev');
    vi.stubEnv('CLOUD_SCHEDULER_SECRET', 'PRIVATE');
    const fn = vi.fn().mockResolvedValue(Response.json({ lastCronAt: 123, secret: 'PRIVATE', jobs: [{
      kind: 'hourly', status: 'failed', scheduledAt: 123, reason: 'response-unknown',
      steps: ['hourly-replan'], index: 0, private: 'PRIVATE',
      results: [{ action: 'hourly-replan', outcome: 'failed', http: 0, reason: 'response-unknown', body: 'PRIVATE' }],
    }] }));
    vi.stubGlobal('fetch', fn);
    const status = await readCloudSchedulerStatus();
    expect(status).toMatchObject({ lastCronAt: 123, jobs: [{ status: 'failed', reason: 'response-unknown',
      results: [{ action: 'hourly-replan', http: 0 }] }] });
    expect(JSON.stringify(status)).not.toContain('PRIVATE');
    expect(String(fn.mock.calls[0][0])).toBe('https://bonbills-scheduler.example.workers.dev/status');
    expect(fn.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(fn.mock.calls[0][1].method).toBeUndefined();
  });
  it('rejects invalid status responses without returning upstream contents', async () => {
    vi.stubEnv('CLOUD_SCHEDULER_URL', 'https://bonbills-scheduler.example.workers.dev');
    vi.stubEnv('CLOUD_SCHEDULER_SECRET', 'secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'PRIVATE' }, { status: 403 })));
    await expect(readCloudSchedulerStatus()).rejects.toThrow('HTTP 403');
  });
  it('dispatches a durable job without GitHub credentials or email', async () => {
    vi.stubEnv('CLOUD_SCHEDULER_URL', 'https://bonbills-scheduler.example.workers.dev');
    vi.stubEnv('CLOUD_SCHEDULER_SECRET', 'secret');
    const fn = vi.fn().mockResolvedValue(Response.json({ ok: true, jobs: [{ id: 'manual-test' }] }, { status: 202 }));
    vi.stubGlobal('fetch', fn);
    expect(await dispatchFullReplan()).toEqual({ jobId: 'manual-test' });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe('https://bonbills-scheduler.example.workers.dev/dispatch');
    expect(JSON.parse(init.body)).toMatchObject({ kind: 'full' });
    expect(init.redirect).toBe('error');
  });
  it('rejects unconfigured dispatch without silently falling back to GitHub', async () => {
    vi.stubEnv('CLOUD_SCHEDULER_URL', ''); vi.stubGlobal('fetch', vi.fn());
    await expect(dispatchFullReplan()).rejects.toThrow('尚未配置'); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expose errors or private contents to the dispatcher', () => {
    const body = schedulerResponse({ ok: false, dailyPlan: { tasks: ['PRIVATE'] }, error: 'PRIVATE URL',
      failure: { stage: 'PRIVATE', retryable: false }, laundry: { outlook: { error: 'PRIVATE' } },
      hairWash: { outlook: { error: 'PRIVATE' } },
      connection: 'PRIVATE', sleepTags: { complete: false, tasks: ['PRIVATE'] } });
    expect(body).toEqual({ ok: false, error: true, dailyPlan: {}, failure: { stage: 'unknown', retryable: false }, laundry: { outlook: { error: true } }, hairWash: { outlook: { error: true } }, sleepTags: { complete: false } });
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
  });
});
