import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import { cloudSchedulerAuthOk } from './_cloudSchedulerAuth';
afterEach(() => vi.unstubAllEnvs());
const req = (action?: unknown, method = 'GET', scheduler: unknown = '1', authorization = 'Bearer dedicated') => ({
  method, query: { action, scheduler }, headers: { authorization },
}) as VercelRequest;
describe('scoped cloud scheduler execution credential', () => {
  it.each([undefined, 'hourly-replan', 'life-periods', 'night-routine', 'daily-routine', 'routine-visibility', 'hair-wash', 'reading-visibility'])('allows the required %s step', action => {
    vi.stubEnv('CLOUD_SCHEDULER_RUN_SECRET', 'dedicated');
    expect(cloudSchedulerAuthOk(req(action))).toBe(true);
  });
  it('rejects other actions, writes, unfiltered responses and wrong credentials', () => {
    vi.stubEnv('CLOUD_SCHEDULER_RUN_SECRET', 'dedicated');
    for (const request of [req('daily-email'), req('briefing'), req('plan-details'), req('trigger-replan'), req(['hourly-replan']), req(undefined, 'POST'), req(undefined, 'DELETE'), req(undefined, 'GET', ''), req(undefined, 'GET', '1', 'Bearer wrong')])
      expect(cloudSchedulerAuthOk(request)).toBe(false);
  });
  it('admits only the dedicated fixed POST that delivers a failure notice', () => {
    vi.stubEnv('CLOUD_SCHEDULER_RUN_SECRET', 'dedicated');
    expect(cloudSchedulerAuthOk(req('orche-failure-task', 'POST'))).toBe(true);
    expect(cloudSchedulerAuthOk(req('orche-failure-task'))).toBe(false);
    expect(cloudSchedulerAuthOk(req('trigger-replan', 'POST'))).toBe(false);
  });
  it('fails closed when unconfigured', () => {
    vi.stubEnv('CLOUD_SCHEDULER_RUN_SECRET', ''); expect(cloudSchedulerAuthOk(req())).toBe(false);
  });
});
