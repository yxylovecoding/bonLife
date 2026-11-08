import { beforeEach, expect, it, vi } from 'vitest';
import { inspectTickTickVisibility } from './_ticktickVisibilityStatus';
const m = vi.hoisted(() => ({ get: vi.fn(), inputs: vi.fn(), rules: vi.fn() }));
vi.mock('./_accountKv', () => ({ kv: { get: m.get } }));
vi.mock('./_taskVisibilityRules', async original => ({ ...await original<typeof import('./_taskVisibilityRules')>(), visibilityInputs: m.inputs }));
vi.mock('./_schedulingRules', () => ({ readSchedulingRules: m.rules, RULE_RUN_KEY: 'last' }));
const task = { id: 'target', projectId: 'p', title: '燃脂操', status: 0, priority: 5, tags: ['hidden'], isAllDay: true };
const options = { connectionId: 'connection', projectId: 'p', today: '2026-11-08', calendarState: {}, now: new Date('2026-11-08T06:00:00Z') };
beforeEach(() => {
  vi.clearAllMocks();
  m.inputs.mockResolvedValue({ journal: {}, locations: { names: [], today: [], unknown: false } });
  m.rules.mockResolvedValue({ order: ['visibility-sleep', 'visibility-timed'], removed: [] });
  m.get.mockResolvedValue(null);
});
it('区分未登记的 hidden 与当前规则，不伪造隐藏来源', async () => {
  expect((await inspectTickTickVisibility([task], options))[0]).toMatchObject({ hidden: true,
    decisions: [], recordedOwner: null, budgetHiddenDate: null, sleepRecord: null });
});
it('只返回目标的隐藏记录与冲突，保留规则恢复决定', async () => {
  m.inputs.mockResolvedValue({ journal: { target: { projectId: 'p', addedOn: '2026-11-08', phase: 'added' }, private: { secret: true } },
    locations: { names: [], today: [], unknown: false } });
  m.get.mockImplementation(async key => key.includes('visibility-owned') ? { target: 'visibility-sleep', private: 'visibility-location' }
    : key.includes('budget-hidden') ? { target: '2026-11-07', private: '2026-11-08' }
    : { generatedAt: '2026-11-08T05:00:00Z', scope: 'full', results: [{ id: 'visibility-sleep', status: 'success',
      conflicts: [{ taskId: 'private', winner: 'visibility-location', field: 'hidden' }] }] });
  const result = await inspectTickTickVisibility([task], options);
  expect(result[0]).toMatchObject({ decisions: [{ rule: 'visibility-sleep', hidden: false }],
    recordedOwner: 'visibility-sleep', budgetHiddenDate: '2026-11-07', lastRun: { results: [{ conflicts: [] }] } });
  expect(JSON.stringify(result)).not.toContain('private');
});
it('地点来源失败时不报告确定的当前决定，未匹配时不额外读取', async () => {
  expect(await inspectTickTickVisibility([], options)).toEqual([]);
  expect(m.inputs).not.toHaveBeenCalled();
  m.inputs.mockResolvedValue({ journal: {}, locations: null });
  expect((await inspectTickTickVisibility([task], options))[0]).toMatchObject({ locationSourceAvailable: false, decisions: [] });
});
