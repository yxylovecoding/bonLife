import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from './outlook-calendar';
import { DEFAULT_OUTLOOK_RULES } from '../src/utils/outlookCalendar';

const { data, authenticated, sameOrigin } = vi.hoisted(() => ({ data: new Map<string, unknown>(), authenticated: vi.fn(), sameOrigin: vi.fn() }));
vi.mock('./_auth.js', () => ({ authOk: authenticated, sameOrigin }));
vi.mock('@vercel/kv', () => ({ kv: {
  get: async (key: string) => data.get(key) ?? null,
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => {
    if (options?.nx && data.has(key)) return null;
    data.set(key, value); return 'OK';
  },
  mset: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, value); return 'OK'; },
  del: async (...keys: string[]) => keys.forEach((key) => data.delete(key)),
  eval: async (_script: string, [key]: string[], [token]: string[]) => { if (data.get(key) === token) data.delete(key); },
} }));
const key = 'outlook:calendar-connection:v1';
const range = { startDate: '2026-09-01', endDate: '2026-10-01' };
const input = { ...range, playUrl: 'https://outlook.live.com/owa/calendar/private/published/calendar.ics', classUrl: '', policy: 'manual', rules: DEFAULT_OUTLOOK_RULES };
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:trip\r\nDTSTART;VALUE=DATE:20260922\r\nDTEND;VALUE=DATE:20260924\r\nSUMMARY:出游\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
async function call(method: string, body?: unknown, query = {}) {
  const result = { status: 200, body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
  const res = {
    setHeader: (name: string, value: string) => { result.headers[name] = value; },
    status: (status: number) => { result.status = status; return res; },
    json: (value: Record<string, unknown>) => { result.body = value; return res; },
  };
  await handler({ method, body, headers: {}, query } as VercelRequest, res as unknown as VercelResponse);
  return result;
}
beforeEach(() => {
  data.clear(); authenticated.mockResolvedValue(true); sameOrigin.mockReturnValue(true);
  vi.stubEnv('SYNC_SECRET', 'test-secret');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(ics)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Outlook 连接接口', () => {
  it('诊断只允许所有者，拒绝时不读取连接或请求上游', async () => {
    authenticated.mockImplementation(async (_req, options) => !options?.ownerOnly);
    expect((await call('GET', undefined, { action: 'diagnostics' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled(); expect(data.size).toBe(0);
  });
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('未授权 %s 不读取或修改连接', async (method) => {
    authenticated.mockResolvedValue(false);
    expect((await call(method, input)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled(); expect(data.size).toBe(0);
  });
  it('拒绝跨站和无效日期', async () => {
    sameOrigin.mockReturnValue(false);
    expect((await call('PUT', input)).status).toBe(403);
    sameOrigin.mockReturnValue(true);
    expect((await call('POST', { startDate: '2026-02-30', endDate: '2026-03-01' })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('预览不保存；返回日程标题但不暴露订阅链接', async () => {
    const preview = await call('POST', { ...input, action: 'preview' });
    expect(preview.status).toBe(200); expect(data.size).toBe(0);
    expect(preview.body.snapshot).toEqual({ ...range, ruleOrder: expect.arrayContaining(['calendar-travel', 'calendar-manual']), ruleCandidates: expect.any(Object), tags: { '2026-09-22': 'travel', '2026-09-23': 'travel' }, travelTitles: { '2026-09-22': '出游', '2026-09-23': '出游' }, wishEvents: [{ calendar: 'play', uid: 'trip', key: JSON.stringify(['play', 'trip', '']), recurrenceId: undefined, title: '出游', startDate: '2026-09-22', endDate: '2026-09-24' }] });
    const connected = await call('PUT', input);
    expect(connected.body.connected).toBe(true);
    expect(JSON.stringify(data.get(key))).not.toContain('https://');
    const status = await call('GET');
    expect(status.body.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain(input.playUrl);
    expect(status.headers['Cache-Control']).toBe('private, max-age=30, must-revalidate');
    const calendar = data.get('calendar-tags');
    expect(calendar.outlookWishEvents).toEqual(preview.body.snapshot.wishEvents);
    expect((await call('DELETE')).body.connected).toBe(false);
    expect(data.size).toBe(1);
    expect(data.get('calendar-tags')).toEqual(calendar);
  });
  it('读取失败保留已有连接，错误不包含私密订阅地址', async () => {
    await call('PUT', input);
    const existing = data.get(key);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(input.playUrl); }));
    const result = await call('PUT', input);
    expect(result.status).toBe(502); expect(data.get(key)).toEqual(existing);
    expect(JSON.stringify(result)).not.toContain(input.playUrl);
  });
  it('更新连接时可保留未回显的已有订阅链接', async () => {
    await call('PUT', input);
    const addedUrl = 'https://outlook.live.com/owa/calendar/added/published/calendar.ics';
    const result = await call('PUT', { ...range, playUrl: '', classUrl: '', policy: 'manual', rules: DEFAULT_OUTLOOK_RULES, sources: [
      { name: '玩', kind: 'play', url: '', hasUrl: true },
      { name: '日历', kind: 'calendar', url: addedUrl },
    ] });
    expect(result.status).toBe(200);
    const status = await call('GET');
    expect(status.body.sources).toEqual([
      { name: '玩', kind: 'play', hasUrl: true },
      { name: '日历', kind: 'play', hasUrl: true },
    ]);
    expect(fetch).toHaveBeenCalledWith(input.playUrl, expect.anything());
    expect(fetch).toHaveBeenCalledWith(addedUrl, expect.anything());
  });
  it('读取期间连接被断开，拒绝返回旧快照', async () => {
    await call('PUT', input);
    vi.stubGlobal('fetch', vi.fn(async () => { data.delete(key); return new Response(ics); }));
    const result = await call('POST', range);
    expect(result.status).toBe(409); expect(result.body.snapshot).toBeUndefined();
  });
});

vi.mock('./_accountRoute.js', () => ({ withAccountScope: (handler: unknown) => handler }));
