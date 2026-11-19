import { expect, it, vi } from 'vitest';
import { movingInstanceRoots, syncMovingInstance, type MovingTreeState } from './_ticktickMovingInstances';
import { RuleTaskDraft } from './_ruleTaskDraft';
import type { TickTickTask, TickTickApi } from './_ticktickTrips';

const make = (id: string, title: string, parentId?: string): TickTickTask => ({ id, title, parentId, projectId: 'p', status: 0 });
function setup(extra: TickTickTask[] = []) {
  const root = make('copy', '搬家-京广-11.5'), templateRoot = make('template', '搬家模板');
  const tasks = [root, templateRoot, make('stage', '出门前三天📦', 'template'),
    { ...make('pack', '📦新整理箱📌', 'stage'), content: '(5m)', items: [{ id: 'source-item', title: '气泡膜📌', status: 1 }] }, ...extra];
  const remote = new Map(tasks.map(task => [task.id, structuredClone(task)]));
  let next = 0;
  const api = {
    getTask: vi.fn(async (_project: string, id: string) => structuredClone(remote.get(id)!)),
    updateTask: vi.fn(async (id: string, payload: any) => { const task = { ...remote.get(id)!, ...payload }; remote.set(id, task); return task; }),
    createTask: vi.fn(async (payload: any) => { const task = { ...payload, id: `new-${++next}`, status: 0, sortOrder: -next * 1000 }; remote.set(task.id, task); return task; }),
    deleteTask: vi.fn(async (_project: string, id: string) => { remote.delete(id); }),
  } as unknown as TickTickApi;
  const state: MovingTreeState = { name: root.title, taskIds: {}, itemIds: {} };
  const options = { api, tasks, root, templateRoot, state, departureDate: '2026-11-05', persist: vi.fn(async () => {}) };
  return { ...options, options, remote };
}

it('补齐新增阶段、任意深度子任务与专属检查事项，使用事件前缀和阶段日期且不复制完成状态', async () => {
  const s = setup([make('deep', '嵌套包装', 'pack')]);
  const result = await syncMovingInstance(s.options);
  expect(result.created).toBe(3);
  const copied = [...s.remote.values()].filter(task => task.id.startsWith('new-'));
  expect(copied.map(task => task.title)).toEqual(['搬家-京广-11.5 · 出门前三天📦', '搬家-京广-11.5 · 📦新整理箱📌', '搬家-京广-11.5 · 嵌套包装']);
  expect(copied.every(task => task.dueDate?.startsWith('2026-11-02'))).toBe(true);
  expect(copied[1].items).toMatchObject([{ title: '气泡膜📌', status: 0 }]);
  expect(copied[2].parentId).toBe(copied[1].id);
  vi.mocked(s.api.createTask).mockClear(); vi.mocked(s.api.updateTask).mockClear();
  await syncMovingInstance(s.options);
  expect(s.api.createTask).not.toHaveBeenCalled(); expect(s.api.updateTask).not.toHaveBeenCalled();
  expect(movingInstanceRoots([...s.remote.values()]).map(task => task.id)).toEqual(['copy']);
  const later = make('later', '新加的封箱检查', 'deep');
  s.tasks.push(later); s.remote.set(later.id, later);
  await syncMovingInstance(s.options);
  expect(s.api.createTask).toHaveBeenCalledOnce();
  expect(s.remote.get(s.state.taskIds.later)).toMatchObject({ title: '搬家-京广-11.5 · 新加的封箱检查', parentId: s.state.taskIds.deep });
});

it('接管已有复制项，更新标题备注和检查事项并保留容器前缀、日期、标签和完成进度', async () => {
  const s = setup([
    make('copy-stage', '出门前三天', 'copy'),
    { ...make('copy-pack', '🎒新整理箱📌', 'copy-stage'), dueDate: '2026-11-02',
      tags: ['个人标签'], items: [{ id: 'existing', title: '气泡膜📌', status: 1 }, { id: 'manual', title: '自己加的', status: 0 }] },
  ]);
  s.remote.get('pack')!.tags = ['当天', '模板标签'];
  await syncMovingInstance(s.options);
  expect(s.api.createTask).not.toHaveBeenCalled();
  expect(s.remote.get('copy-pack')).toMatchObject({ title: '搬家-京广-11.5 · 🎒新整理箱📌', content: '(5m)', status: 0, dueDate: '2026-11-02',
    tags: ['个人标签'], items: [{ id: 'existing', title: '气泡膜📌', status: 1 }, { id: 'manual', title: '自己加的', status: 0 }] });
  s.remote.get('pack')!.title = '📦重新命名📌';
  s.remote.get('pack')!.items![0].title = '气泡膜两卷📌';
  await syncMovingInstance(s.options);
  expect(s.remote.get('copy-pack')).toMatchObject({ title: '搬家-京广-11.5 · 🎒重新命名📌', tags: ['个人标签'],
    items: [{ id: 'existing', title: '气泡膜两卷📌', status: 1 }, { id: 'manual' }] });
});

it('阶段完成后从活动列表消失，仍按原 ID 识别完成，不补建整个阶段及新增下级', async () => {
  const s = setup(); await syncMovingInstance(s.options);
  const stageId = s.state.taskIds.stage, packId = s.state.taskIds.pack;
  Object.assign(s.remote.get(stageId)!, { status: 2, completedTime: '2026-11-04T05:00:00Z' });
  const later = make('later', '后来新增', 'pack'); s.remote.set(later.id, later);
  const active = [...s.remote.values()].filter(task => ![stageId, packId].includes(task.id));
  vi.mocked(s.api.createTask).mockClear(); vi.mocked(s.api.updateTask).mockClear();
  await syncMovingInstance({ ...s.options, tasks: active });
  expect(s.api.createTask).not.toHaveBeenCalled(); expect(s.api.updateTask).not.toHaveBeenCalled();
  expect(s.state.taskIds.stage).toBe(stageId);
  expect(s.state.taskIds.pack).toBe(packId);
});

it.each(['missing', 'read-failed'])('已关联项缺失或读取失败时不据此重建：%s', async mode => {
  const s = setup(); s.state.taskIds.stage = 'old-stage';
  if (mode === 'read-failed') vi.mocked(s.api.getTask).mockImplementation(async (_project, id) => {
    if (id === 'old-stage') throw new Error('TickTick 503');
    return structuredClone(s.remote.get(id)!);
  });
  const run = syncMovingInstance(s.options);
  if (mode === 'read-failed') await expect(run).rejects.toThrow('503'); else await run;
  expect(s.api.createTask).not.toHaveBeenCalled(); expect(s.state.taskIds.stage).toBe('old-stage');
});

it('根任务已完成后不补建、不更新完成内容', async () => {
  const s = setup(); Object.assign(s.remote.get('copy')!, { status: 2, completedTime: '2026-11-04T05:00:00Z' });
  await syncMovingInstance(s.options);
  expect(s.api.createTask).not.toHaveBeenCalled(); expect(s.api.updateTask).not.toHaveBeenCalled();
});

it.each([false, true])('恢复历史完成关联，只清理无手动改动的自动重复分支：%s', async manualEdit => {
  const s = setup(); await syncMovingInstance(s.options);
  const oldStage = { ...make('old-stage', '搬家-京广-11.5 · 出门前三天📦', 'copy'), status: 2, completedTime: '2026-11-04T05:00:00Z' };
  s.remote.set(oldStage.id, oldStage);
  if (manualEdit) s.remote.get('new-2')!.items!.push({ id: 'manual', title: '自己加的物品', status: 0 });
  vi.mocked(s.api.createTask).mockClear(); vi.mocked(s.api.updateTask).mockClear();
  const active = [...s.remote.values()].filter(task => task.id !== oldStage.id);
  const draft = new RuleTaskDraft(s.api, active), branch = draft.branch('template-content');
  const result = await syncMovingInstance({ ...s.options, api: branch.api, tasks: active, completedTasks: [oldStage] });
  branch.accept();
  expect(s.api.deleteTask).not.toHaveBeenCalled();
  await draft.commit();
  expect(s.api.createTask).not.toHaveBeenCalled(); expect(s.api.updateTask).not.toHaveBeenCalled();
  expect(s.state.taskIds.stage).toBe('old-stage'); expect(s.remote.get('old-stage')!.status).toBe(2);
  if (manualEdit) { expect(result.retainedDuplicates).toHaveLength(1); expect(s.api.deleteTask).not.toHaveBeenCalled(); }
  else {
    expect(result.removed).toBe(2); expect(s.remote.has('new-1')).toBe(false); expect(s.remote.has('new-2')).toBe(false);
    expect(vi.mocked(s.api.deleteTask).mock.calls.map(call => call[1])).toEqual(['new-2', 'new-1']);
  }
  vi.mocked(s.api.deleteTask).mockClear();
  await syncMovingInstance({ ...s.options, tasks: [...s.remote.values()].filter(task => task.status !== 2), completedTasks: [] });
  expect(s.api.createTask).not.toHaveBeenCalled(); expect(s.api.deleteTask).not.toHaveBeenCalled();
});

it('事件改名更新全部前缀并复用原 ID；已有同名歧义先停止', async () => {
  const s = setup(); await syncMovingInstance(s.options);
  const ids = Object.values(s.state.taskIds);
  s.root.title = '搬家-广州-11.8'; s.remote.get('copy')!.title = s.root.title;
  await syncMovingInstance(s.options);
  expect(Object.values(s.state.taskIds)).toEqual(ids);
  expect([...s.remote.values()].filter(task => task.id.startsWith('new-')).every(task => task.title.startsWith('搬家-广州-11.8 · '))).toBe(true);
  const duplicate = setup([make('a', '出门前三天', 'copy'), make('b', '出门前三天📦', 'copy')]);
  await expect(syncMovingInstance(duplicate.options)).rejects.toThrow('多个匹配');
  expect(duplicate.api.createTask).not.toHaveBeenCalled(); expect(duplicate.api.updateTask).not.toHaveBeenCalled();
});

it('通过重排草稿创建时，接纳服务端新排序位置并保存实际 ID，后续同步不重复创建', async () => {
  const s = setup(), draft = new RuleTaskDraft(s.api, s.tasks), branch = draft.branch('template-content');
  const persist = vi.fn(async () => {});
  await syncMovingInstance({ ...s.options, api: branch.api, persist }); branch.accept();
  let saved: MovingTreeState | undefined;
  draft.saveAfterCommit('template-content', async () => { saved = draft.resolveIds(s.state, true); });
  expect(s.api.createTask).not.toHaveBeenCalled();
  await draft.commit();
  expect(Object.values(saved!.taskIds).some(id => id.startsWith('draft-'))).toBe(false);
  expect(Object.values(saved!.taskIds)).toEqual(expect.arrayContaining(['copy','new-1','new-2']));
  vi.mocked(s.api.createTask).mockClear();
  await syncMovingInstance({ ...s.options, tasks: [...s.remote.values()], state: saved! });
  expect(s.api.createTask).not.toHaveBeenCalled();
});
