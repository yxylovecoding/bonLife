import { expect, it, vi } from 'vitest';
import { RuleTaskDraft } from './_ruleTaskDraft';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';

it('撤销日历日期保留同一任务已确认的独立模板内容和检查项文字', async () => {
  const original: TickTickTask = { id: 'one', projectId: 'life', title: 'prepare', status: 0,
    content: 'old', dueDate: '2026-11-14T00:00:00+0800', items: [{ id: 'item', title: 'old item', status: 0 }] };
  let saved = structuredClone(original);
  const api = { getTask: vi.fn(async () => structuredClone(saved)),
    updateTask: vi.fn(async (_id, payload) => { saved = { ...saved, ...payload }; return structuredClone(saved); }) } as unknown as TickTickApi;
  const draft = new RuleTaskDraft(api, [original]);
  const template = draft.branch('template-content');
  await template.api.updateTask('one', { content: 'new', items: [{ id: 'item', title: 'new item', status: 0 }] }); template.accept();
  const date = draft.branch('always-today');
  await date.api.updateTask('one', { dueDate: '2026-11-13T00:00:00+0800' }); date.accept();
  draft.preserveFields(['one'], 'date');
  await draft.commit({ order: ['template-content', 'always-today'], allowed: () => true, afterRule: async () => {}, failed: (_ids, error) => { throw error; } });
  expect(saved).toMatchObject({ content: 'new', dueDate: original.dueDate, items: [{ id: 'item', title: 'new item', status: 0 }] });
  expect(api.updateTask).toHaveBeenCalledOnce();
});

it('新建草稿没有可恢复原日期时暂缓创建，不提交未经确认的日历字段', async () => {
  const create = vi.fn();
  const draft = new RuleTaskDraft({ createTask: create } as unknown as TickTickApi, []);
  const branch = draft.branch('wishes');
  const task = await branch.api.createTask({ projectId: 'life', title: 'wish', dueDate: '2026-11-14T00:00:00+0800' });
  branch.accept(); draft.preserveFields([task.id], 'date');
  await draft.commit({ order: ['calendar-travel', 'wishes'], allowed: id => id !== 'calendar-travel', afterRule: async () => {}, failed: (_ids, error) => { throw error; } });
  expect(create).not.toHaveBeenCalled(); expect(draft.committedValues()).toEqual([]);
});
