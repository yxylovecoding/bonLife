import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureOrcheJournal, ORCHE_JOURNAL_TITLE, parseOrcheJournalEvents, readOrcheJournal, type OrcheJournalEvent } from './_orcheJournal';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';

const store = vi.hoisted(() => new Map<string, any>());
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => store.get(key),
  mget: async (...keys: string[]) => keys.map(key => store.get(key) ?? null),
  hgetall: async (key: string) => store.get(key) ?? null,
  hset: async (key: string, data: object) => store.set(key, { ...store.get(key), ...data }),
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => {
    if (options?.nx && store.has(key)) return null;
    store.set(key, value); return 'OK';
  },
  del: async (key: string) => store.delete(key),
} }));

const projectId = 'inbox';
const report = (status: OrcheJournalEvent['status'], id: string, attempt = 0): OrcheJournalEvent =>
  ({ id: `manual-${id}`, at: Date.now(), source: 'manual', status, attempt });

function fixture(existing?: TickTickTask) {
  let task = existing;
  const mock = {
    getProjectData: vi.fn(async () => ({ tasks: task ? [task] : [] })),
    listCompletedTasks: vi.fn().mockResolvedValue([]),
    filterTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(async (payload: Partial<TickTickTask>) => (task = { id: 'created', status: 0, ...payload } as TickTickTask)),
    updateTask: vi.fn(async (id: string, payload: Partial<TickTickTask>) => (task = { ...task, ...payload, id } as TickTickTask)),
    getTask: vi.fn(async () => task),
  };
  return { mock, task: () => task!, run: (...entries: OrcheJournalEvent[]) => ensureOrcheJournal(mock as unknown as TickTickApi, projectId, 'test', entries) };
}

describe('Orche TickTick communication window', () => {
  beforeEach(() => { store.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-18T23:30:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('adopts the previous failure task, retains manual notes and appends each outcome on the same ID across days', async () => {
    const f = fixture({ id: 'legacy', projectId, title: 'Orche 排期未完成', status: 0,
      content: '(1m) 查看 BonLog 排期状态：https://log.bonbills.cn/?orche=1\n我的备注', tags: ['活'] });
    const failure = report('failed', '001');
    expect(await f.run(failure)).toMatchObject({ sent: true });
    expect(f.task()).toMatchObject({ id: 'legacy', title: ORCHE_JOURNAL_TITLE, priority: 5, isAllDay: true, tags: ['活'] });
    expect(f.task().content).toContain('我的备注');
    vi.setSystemTime(new Date('2026-11-19T23:30:00Z'));
    const partial = report('partial', '002');
    const success = report('success', '003', 1);
    expect(await f.run(failure, partial, success)).toMatchObject({ sent: true });
    expect(f.task().dueDate).toBe('2026-11-20T00:00:00.000+0800');
    const body = f.task().content!;
    expect(body.match(/· 失败/g)).toHaveLength(1);
    expect(body).toContain('· 部分完成');
    expect(body).toContain('补跑 1 · 成功');
    expect(await f.run(failure, partial, success)).toMatchObject({ duplicate: true });
    expect(f.mock.createTask).not.toHaveBeenCalled();
    expect(f.mock.updateTask).toHaveBeenCalledTimes(2);
  });

  it('finds a created task after a lost response and preserves its completed state', async () => {
    const f = fixture();
    const create = f.mock.createTask.getMockImplementation()!;
    f.mock.createTask.mockImplementationOnce(async payload => { await create(payload); throw new Error('connection closed'); });
    const success = report('success', '001');
    await expect(f.run(success)).rejects.toThrow();
    expect(await f.run(success)).toMatchObject({ sent: true, duplicate: true });
    f.task().status = 2;
    const previousDate = f.task().dueDate;
    vi.setSystemTime(new Date('2026-11-19T23:30:00Z'));
    expect(await f.run(report('failed', '002'))).toMatchObject({ sent: true });
    expect(f.task()).toMatchObject({ id: 'created', status: 2, dueDate: previousDate });
    expect(f.mock.createTask).toHaveBeenCalledTimes(1);
  });

  it('keeps older results in the monthly archive when the active notes reach 60 lines', async () => {
    const f = fixture();
    const history = Array.from({ length: 61 }, (_, i) => ({ ...report('success', `log-${i}`), at: Date.now() - i * 1000 }));
    await f.run(...history.slice(0, 30));
    await f.run(...history.slice(30, 60));
    await f.run(...history.slice(60));
    expect(f.task().content!.match(/· 成功/g)).toHaveLength(60);
    expect((await readOrcheJournal('2026-11')).match(/· 成功/g)).toHaveLength(61);
  });

  it('validates event count and strips unknown reasons and caller text', () => {
    const event = report('failed', 'test');
    expect(parseOrcheJournalEvents({ events: [{ ...event, reason: 'PRIVATE', text: 'PRIVATE' }] })).toEqual([event]);
    expect(parseOrcheJournalEvents({ events: [{ ...event, status: 'constructor' }] })).toBeNull();
  });
});
