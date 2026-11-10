import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizeAccountScope } from './_accountScope';
import handler from './ticktick-trips';
const m = vi.hoisted(() => ({ account: null as string | null, read: vi.fn() }));
vi.mock('./_auth.js', () => ({ authOk: async () => {
  if (!m.account) return false;
  authorizeAccountScope(m.account); return true;
} }));
vi.mock('./_cloudScheduler.js', () => ({ readCloudSchedulerStatus: m.read }));
async function request(method = 'GET') {
  const result = { status: 200, body: null as unknown, headers: {} as Record<string, string> };
  const res = { setHeader: (key: string, value: string) => { result.headers[key] = value; },
    status: (status: number) => { result.status = status; return res; },
    json: (body: unknown) => { result.body = body; return res; } };
  await handler({ method, query: { action: 'scheduler-status' }, headers: {} } as VercelRequest,
    res as unknown as VercelResponse);
  return result;
}
beforeEach(() => { m.account = null; m.read.mockReset().mockResolvedValue({ jobs: [] }); });
afterEach(() => vi.unstubAllEnvs());
it('does not read the owner queue for unauthenticated or other-account requests', async () => {
  expect((await request()).status).toBe(401);
  m.account = 'a'.repeat(32);
  expect((await request()).status).toBe(403);
  expect(m.read).not.toHaveBeenCalled();
});
it('allows an owner read without caching and rejects mutations', async () => {
  m.account = 'legacy';
  expect(await request()).toMatchObject({ status: 200, body: { jobs: [] },
    headers: { 'Cache-Control': 'private, no-store' } });
  expect((await request('POST')).status).toBe(405);
  expect(m.read).toHaveBeenCalledTimes(1);
});
