import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureOrcheFailureTask, ORCHE_FAILURE_TITLE } from './_orcheFailureTask';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => {
    if (options?.nx && store.has(key)) return null;
    store.set(key, value); return 'OK';
  },
  del: async (key: string) => store.delete(key),
} }));

const task: TickTickTask = { id: 'notice', projectId: 'inbox', title: ORCHE_FAILURE_TITLE, priority: 5, isAllDay: true,
  dueDate: '2026-11-19T00:00:00.000+0800', startDate: '2026-11-19T00:00:00.000+0800' };
function fixture() {
  const mock = {
    getProjectData: vi.fn().mockResolvedValue({ tasks: [] }),
    listCompletedTasks: vi.fn().mockResolvedValue([]),
    filterTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue(task),
    getTask: vi.fn().mockResolvedValue(task),
  };
  const api = mock as unknown as TickTickApi;
  return { mock, run: () => ensureOrcheFailureTask(api, 'inbox', 'test-connection') };
}

describe('Orche failure task', () => {
  beforeEach(() => { store.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-18T23:30:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('creates and reads back one high-priority all-day task on the Shanghai date', async () => {
    const { mock, run } = fixture();
    expect(await run()).toMatchObject({ ok: true, sent: true, duplicate: false });
    expect(mock.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: ORCHE_FAILURE_TITLE, priority: 5, isAllDay: true, dueDate: task.dueDate, timeZone: 'Asia/Shanghai',
    }));
    expect(mock.getTask).toHaveBeenCalledWith('inbox', 'notice');
    expect(await run()).toMatchObject({ ok: true, sent: true, duplicate: true });
    expect(mock.createTask).toHaveBeenCalledTimes(1);
  });

  it('recovers a creation with a lost response after the user abandons the task', async () => {
    const { mock, run } = fixture();
    mock.createTask.mockRejectedValueOnce(new Error('connection closed'));
    await expect(run()).rejects.toThrow();
    expect(await run()).toMatchObject({ sent: false });
    mock.filterTasks.mockResolvedValueOnce([{ ...task, status: -1 }]);
    expect(await run()).toMatchObject({ sent: true, duplicate: true });
    expect(mock.createTask).toHaveBeenCalledTimes(1);
  });

  it('uses the returned task ID when confirmation fails, without making another task', async () => {
    const { mock, run } = fixture();
    mock.getTask.mockRejectedValueOnce(new Error('read timed out'));
    await expect(run()).rejects.toThrow();
    expect(await run()).toMatchObject({ sent: true, duplicate: true });
    expect(mock.createTask).toHaveBeenCalledTimes(1);
  });
});
