import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncPeriodPredictionTask, PERIOD_PREDICTION_TITLE } from './_ticktickPeriodPrediction';
import { DEFAULT_CYCLE } from '../src/utils/bonLife';
import type { TickTickTask } from './_ticktickTrips';

vi.mock('./_lifeSwimming.js', () => ({
  readSwimmingCycle: vi.fn(),
}));

describe('syncPeriodPredictionTask', () => {
  const api = {
    createTask: vi.fn(),
    updateTask: vi.fn(),
    getTask: vi.fn(),
    deleteTask: vi.fn(),
  };
  const connection = { projectId: 'p1' } as any;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  const reminder = (overrides: Partial<TickTickTask> = {}): TickTickTask => ({
    id: 'reminder', projectId: 'p1', title: PERIOD_PREDICTION_TITLE, status: 0,
    startDate: '2026-10-27T00:00:00+0800', dueDate: '2026-10-27T00:00:00+0800',
    isAllDay: true, priority: 5, tags: ['当天', '活'], ...overrides,
  });
  const completed = (overrides: Partial<TickTickTask> = {}) => reminder({
    id: 'completed', status: 2, completedTime: '2026-10-27T09:00:00+0800', ...overrides,
  });
  const predict = async (lastPeriodStart = '2026-10-01', cycleLength = 28) => {
    vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle.mockResolvedValue({
      cycle: { ...DEFAULT_CYCLE, lastPeriodStart, cycleLength, automatic: false }, periods: [lastPeriodStart],
    });
  };

  it('本周期已完成后，多次同步不再创建提醒', async () => {
    await predict();
    for (const today of ['2026-10-27', '2026-10-28']) {
      await syncPeriodPredictionTask(api as any, { connection, tasks: [], completedTasks: [completed()], today });
    }
    expect(api.createTask).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('提前完成后预测日期改变，仍只提醒一次', async () => {
    await predict('2026-10-01', 26);
    await syncPeriodPredictionTask(api as any, { connection, tasks: [],
      completedTasks: [completed({ completedTime: '2026-10-08T09:00:00+0800' })], today: '2026-10-08' });
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('任务快照中的已完成提醒同样阻止补建', async () => {
    await predict();
    await syncPeriodPredictionTask(api as any, { connection, tasks: [completed()], completedTasks: [], today: '2026-10-27' });
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('下一次经期记录出现后创建下一轮，上一轮迟完成不阻挡', async () => {
    await predict('2026-10-29');
    await syncPeriodPredictionTask(api as any, { connection, tasks: [],
      completedTasks: [completed({ completedTime: '2026-10-30T09:00:00+0800' })], today: '2026-10-30' });
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-11-24T00:00:00+0800' }));
  });

  it('其他清单同名记录不阻止本清单提醒', async () => {
    await predict();
    await syncPeriodPredictionTask(api as any, { connection, tasks: [],
      completedTasks: [completed({ projectId: 'other' })], today: '2026-10-27' });
    expect(api.createTask).toHaveBeenCalledTimes(1);
  });

  it('UTC 日期按北京时间识别所属周期，历史无日期时使用完成日期', async () => {
    await predict();
    for (const row of [completed({ startDate: '2026-09-30T16:00:00Z', dueDate: undefined, completedTime: '2026-10-08T09:00:00+0800' }),
      completed({ startDate: undefined, dueDate: undefined, completedTime: '2026-09-30T16:00:00Z' })]) {
      await syncPeriodPredictionTask(api as any, { connection, tasks: [], completedTasks: [row], today: '2026-10-08' });
    }
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it.each([['当天'], ['当天', '活']])('本周期完成后兼容新旧标签清理重复待办 %j', async (...tags) => {
    await predict();
    const duplicate = reminder({ tags });
    api.getTask.mockResolvedValueOnce(duplicate);
    expect(await syncPeriodPredictionTask(api as any, { connection, tasks: [duplicate],
      completedTasks: [completed()], today: '2026-10-27' })).toMatchObject({ created: 0, updated: 0, deleted: 1 });
    expect(api.deleteTask).toHaveBeenCalledExactlyOnceWith('p1', duplicate.id);
    expect(api.createTask).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it.each([
    { status: 2, completedTime: '2026-10-27T10:00:00+0800' },
    { content: '保留我的备注' },
    { title: '其他任务' },
    { repeatFlag: 'RRULE:FREQ=MONTHLY' },
    { startDate: '2026-11-24T00:00:00+0800', dueDate: '2026-11-24T00:00:00+0800' },
  ])('清理前回读，保留已完成或被用户修改的任务 %j', async overrides => {
    await predict();
    api.getTask.mockResolvedValueOnce(reminder(overrides));
    await syncPeriodPredictionTask(api as any, { connection, tasks: [reminder()],
      completedTasks: [completed()], today: '2026-10-27' });
    expect(api.deleteTask).not.toHaveBeenCalled();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('重复待办回读失败时停止，不补建或删除', async () => {
    await predict();
    api.getTask.mockRejectedValueOnce(new Error('unavailable'));
    await expect(syncPeriodPredictionTask(api as any, { connection, tasks: [reminder()],
      completedTasks: [completed()], today: '2026-10-27' })).rejects.toThrow('unavailable');
    expect(api.deleteTask).not.toHaveBeenCalled();
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('跨年仍读取上一年的周期记录', async () => {
    await predict('2026-12-15');
    await syncPeriodPredictionTask(api as any, { connection, tasks: [], completedTasks: [], today: '2027-01-01' });
    expect(vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle).toHaveBeenCalledWith([2026, 2027, 2028]);
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2027-01-10T00:00:00+0800' }));
  });

  it('如果没有预测日期，则不执行操作', async () => {
    vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle.mockResolvedValue({
      cycle: DEFAULT_CYCLE,
      periods: [],
    });
    const result = await syncPeriodPredictionTask(api as any, { connection, completedTasks: [], tasks: [], today: '2026-10-08' });
    expect(result).toEqual({ updated: 0, created: 0 });
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('如果预测日期存在且没有任务，则在预测日前两天创建任务', async () => {
    // lastPeriodStart: 10-01, cycle: 28 days -> next: 10-29. target: 10-27
    vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle.mockResolvedValue({
      cycle: { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-01', cycleLength: 28, periodLength: 5, automatic: false },
      periods: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'],
    });
    const result = await syncPeriodPredictionTask(api as any, { connection, completedTasks: [], tasks: [], today: '2026-10-08' });
    expect(result).toEqual({ updated: 0, created: 1 });
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: PERIOD_PREDICTION_TITLE,
      startDate: '2026-10-27T00:00:00+0800',
      priority: 5,
      tags: ['当天'],
    }));
  });

  it('如果已存在任务且日期一致，则不更新', async () => {
    vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle.mockResolvedValue({
      cycle: { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-01', cycleLength: 28, periodLength: 5, automatic: false },
      periods: ['2026-10-01'],
    });
    const existingTask = {
      id: 't1',
      projectId: 'p1',
      title: PERIOD_PREDICTION_TITLE,
      status: 0,
      startDate: '2026-10-27T00:00:00+0800',
      dueDate: '2026-10-27T00:00:00+0800',
      isAllDay: true,
      priority: 5,
      tags: ['当天'],
    };
    const result = await syncPeriodPredictionTask(api as any, { connection, completedTasks: [], tasks: [existingTask as any], today: '2026-10-08' });
    expect(result).toEqual({ updated: 0, created: 0 });
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('如果预测日期变化，则更新现有任务', async () => {
    vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle.mockResolvedValue({
      cycle: { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-01', cycleLength: 30, periodLength: 5, automatic: false }, // Changed from 28
      periods: ['2026-10-01'],
    });
    const existingTask = {
      id: 't1',
      projectId: 'p1',
      title: PERIOD_PREDICTION_TITLE,
      status: 0,
      startDate: '2026-10-27T00:00:00+0800', // Old target
      priority: 5,
      tags: ['当天', '活'],
    };
    // new next: 10-31, new target: 10-29
    const result = await syncPeriodPredictionTask(api as any, { connection, completedTasks: [], tasks: [existingTask as any], today: '2026-10-08' });
    expect(result).toEqual({ updated: 1, created: 0 });
    expect(api.updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({
      startDate: '2026-10-29T00:00:00+0800',
    }));
  });
  it.each([['routine', '个人标签'], ['个人标签']])('更新提醒保留现有标签 %j，不添加或移除 routine', async (...tags) => {
    vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle.mockResolvedValue({
      cycle: { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-01', cycleLength: 30, periodLength: 5, automatic: false },
      periods: ['2026-10-01'],
    });
    await syncPeriodPredictionTask(api as any, { connection, completedTasks: [], today: '2026-10-08', tasks: [{
      id: 't1', projectId: 'p1', title: PERIOD_PREDICTION_TITLE, status: 0, tags,
    } as any] });
    expect(api.updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ tags: [...tags, '当天'] }));
  });
  it('日期与必要标签一致时，不因用户的额外标签重复写入', async () => {
    vi.mocked(await import('./_lifeSwimming.js')).readSwimmingCycle.mockResolvedValue({
      cycle: { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-01', cycleLength: 28, periodLength: 5, automatic: false },
      periods: ['2026-10-01'],
    });
    expect(await syncPeriodPredictionTask(api as any, { connection, completedTasks: [], today: '2026-10-08', tasks: [{
      id: 't1', projectId: 'p1', title: PERIOD_PREDICTION_TITLE, status: 0, isAllDay: true, priority: 5,
      startDate: '2026-10-27T00:00:00+0800', dueDate: '2026-10-27T00:00:00+0800', tags: ['routine', '当天'],
    } as any] })).toEqual({ updated: 0, created: 0 });
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('已有提醒仅移除活，保留其他标签，后续同步不补回', async () => {
    await predict();
    const existing = reminder({ tags: ['routine', '活', '当天', '个人标签'] });
    expect(await syncPeriodPredictionTask(api as any, { connection, completedTasks: [],
      tasks: [existing], today: '2026-10-08' })).toEqual({ updated: 1, created: 0 });
    const patch = api.updateTask.mock.calls[0][1];
    expect(patch).toMatchObject({ tags: ['routine', '当天', '个人标签'],
      startDate: existing.startDate, dueDate: existing.dueDate, priority: existing.priority });
    api.updateTask.mockClear();
    expect(await syncPeriodPredictionTask(api as any, { connection, completedTasks: [],
      tasks: [{ ...existing, ...patch }], today: '2026-10-08' })).toEqual({ updated: 0, created: 0 });
    expect(api.updateTask).not.toHaveBeenCalled();
  });
});
