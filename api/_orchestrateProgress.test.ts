import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readOrchestrateProgress } from './_orchestrateProgress';
const m = vi.hoisted(() => ({ run: null as any, owner: true, queue: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: { get: async () => m.run } }));
vi.mock('./_accountScope.js', () => ({ isOwnerScope: () => m.owner }));
vi.mock('./_cloudScheduler.js', () => ({ readCloudSchedulerStatus: m.queue }));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T03:00:00Z'));
  m.run = null; m.owner = true; m.queue.mockReset();
});
afterEach(() => vi.useRealTimers());
it('没有今日快照时仍显示当日日历读取失败，昨天的失败不冒充今天', async () => {
  m.run = { generatedAt: '2026-11-13T00:01:00Z', results: [{ id: 'calendar-travel', status: 'failed', reason: 'PRIVATE URL' }] };
  expect(await readOrchestrateProgress()).toEqual({ state: 'failed', message: 'Orchestrate 未完成：Outlook 日历读取失败' });
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
