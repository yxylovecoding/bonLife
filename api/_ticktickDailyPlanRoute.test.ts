import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from './ticktick-trips';
import { defaultRuleConfig } from '../src/utils/schedulingRules';
import * as calendarTraining from './_lifeCalendarTraining';
import { RULE_CONFIG_KEY } from './_schedulingRules';
const m = vi.hoisted(() => ({ data: new Map<string, any>(), auth: true, engine: vi.fn(), hourly: vi.fn(), details: vi.fn(), dispatch: vi.fn(), archive: vi.fn() }));
vi.mock('./_accountRoute.js', () => ({ withAccountScope: (value: unknown) => value }));
vi.mock('./_auth.js', () => ({ authOk: async () => m.auth }));
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => structuredClone(m.data.get(key) ?? null),
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => { if (options?.nx && m.data.has(key)) return null; m.data.set(key, structuredClone(value)); return 'OK'; },
  eval: async (_: string, [key]: string[]) => { m.data.delete(key); return 1; },
} }));
vi.mock('./_ruleReplan.js', () => ({ runRuleReplan: m.engine }));
vi.mock('./_ticktickReplan.js', () => ({ replanRemainingToday: m.hourly }));
vi.mock('./_ticktickPlanDetails.js', () => ({ readTickTickPlanDetails: m.details }));
vi.mock('./_cloudScheduler.js', () => ({ dispatchFullReplan: m.dispatch }));
vi.mock('./_outlookConnections.js', () => ({ readOutlookConnections: async () => [{ id: 'read', name: '玩', connected: true, kind: 'subscription' }] }));
vi.mock('./_lifeDone.js', () => ({ syncRecentLifeDone: m.archive }));
async function request(method: string, action = '', body?: unknown, cron = false) {
  const result = { status: 200, body: {} as any };
  const res = { setHeader: vi.fn(), status: (code: number) => { result.status = code; return res; }, json: (value: unknown) => { result.body = value; return res; } };
  await handler({ method, query: { action }, headers: { ...(cron ? { authorization: 'Bearer cron-secret' } : {}) }, body } as VercelRequest, res as unknown as VercelResponse);
  return result;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T09:00:00+0800')); vi.resetAllMocks();
  m.data.clear(); m.auth = true; vi.stubEnv('CRON_SECRET', 'cron-secret');
  m.engine.mockResolvedValue({ busy: false, connected: true, rulesComplete: true }); m.hourly.mockResolvedValue({ busy: false });
  m.dispatch.mockResolvedValue({ dispatched: true }); m.archive.mockResolvedValue({});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('规则配置接口', () => {
  it('只读 GET 返回目录、连接状态与版本，不触发重排', async () => {
    const result = await request('GET', 'rules'); expect(result.status).toBe(200); expect(result.body.config.version).toBe(0);
    expect(result.body.outlook[0].name).toBe('玩'); expect(m.engine).not.toHaveBeenCalled(); expect(m.dispatch).not.toHaveBeenCalled();
  });
  it('保存后只投递一次完整重排，更新版本与前序顺序', async () => {
    const draft = defaultRuleConfig(); draft.predecessors.exercise = ['laundry'];
    const result = await request('PATCH', 'rules', draft);
    expect(result.body).toMatchObject({ triggered: true, config: { version: 1, predecessors: { exercise: ['laundry'] } } });
    expect(result.body.config.order.indexOf('laundry')).toBeLessThan(result.body.config.order.indexOf('exercise')); expect(m.dispatch).toHaveBeenCalledOnce();
  });
  it('并发旧版本返回 409，不覆盖、不再次投递', async () => {
    await request('PATCH', 'rules', defaultRuleConfig());
    expect((await request('PATCH', 'rules', defaultRuleConfig())).status).toBe(409); expect(m.data.get(RULE_CONFIG_KEY).version).toBe(1); expect(m.dispatch).toHaveBeenCalledOnce();
  });
  it.each(['self', 'unknown', 'cycle'])('%s 依赖无效，不保存、不触发重排', async kind => {
    const draft = defaultRuleConfig();
    draft.predecessors = kind === 'self' ? { laundry: ['laundry'] } : kind === 'cycle' ? { laundry: ['exercise'], exercise: ['laundry'] } : { laundry: ['missing' as any] };
    const result = await request('PATCH', 'rules', draft); expect(result.status).toBe(400);
    if (kind === 'cycle') expect(result.body.error).toMatch(/循环依赖：.*→/);
    expect(m.data.has(RULE_CONFIG_KEY)).toBe(false); expect(m.dispatch).not.toHaveBeenCalled();
  });
  it('投递失败仍保存配置，明确返回可重试状态；重试不保存第二版', async () => {
    m.dispatch.mockRejectedValueOnce(new Error('private queue response'));
    expect((await request('PATCH', 'rules', defaultRuleConfig())).body).toMatchObject({ triggered: false, error: '已保存，Orchestrate 未提交', config: { version: 1 } });
    expect((await request('POST', 'trigger-replan')).status).toBe(202); expect(m.data.get(RULE_CONFIG_KEY).version).toBe(1);
  });
  it('配置读写都要求登录，不支持的动词无副作用', async () => {
    m.auth = false;
    expect((await request('GET', 'rules')).status).toBe(401); expect((await request('PATCH', 'rules', defaultRuleConfig())).status).toBe(401);
    m.auth = true; expect((await request('DELETE', 'rules')).status).toBe(405); expect(m.dispatch).not.toHaveBeenCalled();
  });
});
describe('同步入口与保护', () => {
  it('排期详情只读，包含本轮规则状态', async () => {
    m.details.mockResolvedValue({ rules: { version: 3, results: [] } });
    expect((await request('GET', 'plan-details')).body.details.rules.version).toBe(3);
    expect((await request('POST', 'plan-details')).status).toBe(405); expect(m.engine).not.toHaveBeenCalled();
  });
  it('小时与完整同步入口保持分离', async () => {
    expect((await request('POST', 'replan-today')).status).toBe(200); expect(m.hourly).toHaveBeenCalledOnce(); expect(m.engine).not.toHaveBeenCalled();
    await request('POST'); expect(m.engine).toHaveBeenCalledWith({ scope: 'full', allowDisconnected: false });
  });
  it('23:01 小时 Orche 导入运动，白天和休息时段不读取', async () => {
    const sync = vi.spyOn(calendarTraining, 'syncCalendarTraining').mockResolvedValue({ connected: false });
    try {
      await request('GET', 'hourly-replan', undefined, true);
      expect(sync).not.toHaveBeenCalled();
      vi.setSystemTime(new Date('2026-11-03T23:01:00+0800'));
      expect((await request('GET', 'hourly-replan', undefined, true)).status).toBe(200);
      expect(sync).toHaveBeenCalledOnce();
      vi.setSystemTime(new Date('2026-11-04T04:00:00+0800'));
      await request('GET', 'hourly-replan', undefined, true);
      expect(sync).toHaveBeenCalledOnce();
    } finally { sync.mockRestore(); }
  });
  it('晚间运动导入失败仍运行独立排程，但不报告成功', async () => {
    const sync = vi.spyOn(calendarTraining, 'syncCalendarTraining').mockRejectedValue(new Error('private calendar'));
    try {
      vi.setSystemTime(new Date('2026-11-03T23:01:00+0800'));
      const result = await request('GET', 'hourly-replan', undefined, true);
      expect(result).toMatchObject({ status: 502, body: { ok: false, failure: { stage: 'completion-archive' } } });
      expect(m.hourly).toHaveBeenCalledWith({ scheduled: true });
      expect(JSON.stringify(result)).not.toContain('private calendar');
    } finally { sync.mockRestore(); }
  });
  it('后台归档失败仍完成独立排程，并报告归档失败', async () => {
    m.archive.mockRejectedValue(new Error('private archive')); const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await request('GET', '', undefined, true); expect(result.status).toBe(502); expect(result.body.failure.stage).toBe('completion-archive');
    expect(m.engine).toHaveBeenCalled(); expect(JSON.stringify(result.body)).not.toContain('private archive'); spy.mockRestore();
  });
  it('全部自动入口休息，手动编辑配置仍可进行', async () => {
    vi.setSystemTime(new Date('2026-11-03T04:00:00+0800'));
    for (const action of ['', 'hourly-replan', 'night-routine', 'routine-visibility', 'daily-routine', 'hair-wash', 'reading-visibility', 'timed-visibility']) {
      expect((await request('GET', action, undefined, true)).body.skipped).toBe('rest-window');
    }
    expect(m.engine).not.toHaveBeenCalled();
    expect((await request('PATCH', 'rules', defaultRuleConfig())).status).toBe(200);
  });
  it('已取消的邮件入口返回 410，既不发信也不触发排程', async () => {
    expect((await request('GET', 'daily-email', undefined, true)).status).toBe(410);
    expect((await request('POST', 'daily-email')).status).toBe(410);
    expect(m.engine).not.toHaveBeenCalled(); expect(m.hourly).not.toHaveBeenCalled();
  });
  it('预算保存只接受自动或合法分钟数', async () => {
    expect((await request('PATCH', '', { budgetMinutes: 5 })).status).toBe(400);
    expect((await request('PATCH', '', { budgetMinutes: 60, availabilityProfile: 'evening' })).status).toBe(200);
    expect(m.data.get('ticktick:daily-plan-settings:v1')).toMatchObject({ budgetMinutes: 60 });
  });
});
