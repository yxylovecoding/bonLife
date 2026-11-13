import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from './ticktick-trips';
const m = vi.hoisted(() => ({ run: vi.fn(), auth: false }));
vi.mock('./_ruleReplan.js', () => ({ runRuleReplan: m.run }));
vi.mock('./_auth.js', () => ({ authOk: async () => m.auth }));
vi.mock('./_accountRoute.js', () => ({ withAccountScope: (value: unknown) => value }));
async function request(action: string, method: string, authorization?: string) {
  const result = { status: 200, body: {} as any };
  const res = { setHeader: vi.fn(), status: (status: number) => { result.status = status; return res; }, json: (body: unknown) => { result.body = body; return res; } };
  await handler({ method, query: { action }, headers: { authorization } } as VercelRequest, res as unknown as VercelResponse); return result;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T22:00:00+0800')); vi.stubEnv('CRON_SECRET', 'cron'); m.auth = false; m.run.mockReset().mockResolvedValue({ busy: false, rulesComplete: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it.each([['night-routine', 'night'], ['daily-routine', 'daily'], ['routine-visibility', 'all'], ['hair-wash', 'hair'], ['reading-visibility', 'reading'], ['timed-visibility', 'timed']])('%s 共享规则执行器，并传入原有范围', async (action, kind) => {
  expect((await request(action, 'GET', 'Bearer cron')).status).toBe(200);
  if (['routine-visibility', 'reading-visibility', 'hair-wash'].includes(action)) expect(m.run).not.toHaveBeenCalled();
  else expect(m.run).toHaveBeenCalledWith({ scope: 'visibility', visibilityKind: kind, allowDisconnected: true });
  expect((await request(action, 'GET')).status).toBe(401);
  m.auth = true; expect((await request(action, 'GET')).status).toBe(405); expect((await request(action, 'POST')).status).toBe(200);
  expect(m.run).toHaveBeenCalledWith({ scope: 'visibility', visibilityKind: kind, allowDisconnected: true });
});
it('繁忙返回 202；错误不会暴露 TickTick 令牌', async () => {
  m.run.mockResolvedValueOnce({ busy: true }); expect((await request('night-routine', 'GET', 'Bearer cron')).status).toBe(202);
});
