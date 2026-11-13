import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readOrchestrateProgress } from './_orchestrateProgress';
const m = vi.hoisted(() => ({ run: null as any, plan: null as any, owner: true, queue: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: { get: async (key: string) => key.includes('last-plan-run') ? m.plan : m.run } }));
vi.mock('./_accountScope.js', () => ({ isOwnerScope: () => m.owner }));
vi.mock('./_cloudScheduler.js', () => ({ readCloudSchedulerStatus: m.queue }));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T03:00:00Z'));
  m.run = null; m.plan = null; m.owner = true; m.queue.mockReset();
});
afterEach(() => vi.useRealTimers());
it('没有今日快照时仍显示当日日历读取失败，昨天的失败不冒充今天', async () => {
  m.run = { generatedAt: '2026-11-13T00:01:00Z', results: [{ id: 'calendar-travel', status: 'failed', reason: 'PRIVATE URL' }] };
  expect(await readOrchestrateProgress()).toMatchObject({ state: 'failed', message: 'Orchestrate 未完成：Outlook 日历读取失败' });
  expect(m.queue).not.toHaveBeenCalled();
  m.run.generatedAt = '2026-11-12T12:00:00Z';
  expect(await readOrchestrateProgress()).toBeNull();
});
it('跟踪本次提交而非旧轮次，排队和执行都不能报告成功', async () => {
  m.run = { generatedAt: '2026-11-13T00:01:00Z', results: [{ id: 'daily-plan', status: 'failed' }] };
  for (const state of ['queued', 'running', 'success', 'failed']) {
    m.queue.mockResolvedValue({ jobs: [{ id: 'old', status: 'success' }, { id: 'manual-one', status: state }] });
    expect(await readOrchestrateProgress('manual-one')).toMatchObject({ state });
  }
});
it('读取失败和队列记录缺失保持未确认，不返回成功或原始错误', async () => {
  m.queue.mockRejectedValueOnce(new Error('PRIVATE credential'));
  expect(await readOrchestrateProgress('manual-one')).toMatchObject({ state: 'unknown' });
  m.queue.mockResolvedValue({ jobs: [] });
  expect(await readOrchestrateProgress('manual-one')).toMatchObject({ state: 'unknown' });
});
it('其他账号不能读取所有者的云端队列', async () => {
  m.owner = false;
  expect(await readOrchestrateProgress('manual-one')).toBeNull();
  expect(m.queue).not.toHaveBeenCalled();
});
it('部分完成列出独立执行、暂缓与失败，后续显隐不抹掉完整排程结果', async () => {
  m.plan = { scope: 'full', generatedAt: '2026-11-13T00:01:00Z', calendar: { state: 'unavailable' }, results: [
    { id: 'always-today', status: 'success', matched: 2, updated: 1, deferred: 1 },
    { id: 'daily-plan', status: 'skipped', reason: '日历不可用，保留原安排' },
    { id: 'rain-reminder', status: 'failed', reason: 'PRIVATE URL' },
    { id: 'exercise', status: 'skipped', reason: '已删除，不执行' },
  ] };
  m.run = { scope: 'visibility', generatedAt: '2026-11-13T01:00:00Z', results: [{ id: 'visibility-reading', status: 'success', updated: 1 }] };
  expect(await readOrchestrateProgress()).toMatchObject({ state: 'partial', completed: ['固定今日'],
    deferred: ['固定今日', '普通今日事轮换'], failed: ['雨天关窗'], generatedAt: m.plan.generatedAt });
  expect(JSON.stringify(await readOrchestrateProgress())).not.toContain('PRIVATE');
});
it('队列只关联本次时间范围；不会把旧轮次的部分完成贴到新失败上', async () => {
  m.run = { scope: 'full', generatedAt: '2026-11-13T00:01:00Z', results: [
    { id: 'always-today', status: 'success', matched: 1 }, { id: 'daily-plan', status: 'skipped' },
  ] };
  m.queue.mockResolvedValue({ jobs: [{ id: 'one', status: 'failed', startedAt: Date.parse('2026-11-13T00:00:00Z'), finishedAt: Date.parse('2026-11-13T00:02:00Z') }] });
  expect(await readOrchestrateProgress('one')).toMatchObject({ state: 'partial', completed: ['固定今日'] });
  m.queue.mockResolvedValue({ jobs: [{ id: 'one', status: 'failed', startedAt: Date.parse('2026-11-13T02:00:00Z'), finishedAt: Date.parse('2026-11-13T02:02:00Z') }] });
  const next = await readOrchestrateProgress('one');
  expect(next?.state).toBe('failed'); expect(next?.completed).toBeUndefined();
});
