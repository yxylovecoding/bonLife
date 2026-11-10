import { describe, expect, it, vi } from 'vitest';
import { inspectTickTickTaskDate } from './_ticktickTaskStatus';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';

vi.mock('@vercel/kv', () => ({ kv: { get: async () => null } }));
const now = new Date('2026-11-08T05:00:00Z');
const task: TickTickTask = { id: 't', projectId: 'p', parentId: 'parent', title: 'transformer', status: 0,
  tags: ['always-today', '班'], dueDate: '2026-11-07T00:00:00+0800', content: 'private notes', items: [{ title: 'private item' }] };
function fixture(completed: TickTickTask[] = [], abandoned: TickTickTask[] = []) {
  return { listProjects: vi.fn(async () => [{ id: 'p', name: '课' }]),
    getProjectData: vi.fn(async (id: string) => ({ tasks: id === 'inbox' ? [] : [task] })),
    filterTasks: vi.fn(async (_ids: string[], statuses: number[]) => statuses.includes(-1) ? abandoned : [task]),
    getTask: vi.fn(async () => ({ ...task, dueDate: '2026-11-08T00:00:00+0800' })),
    listCompletedTasks: vi.fn(async () => completed), updateTask: vi.fn(), createTask: vi.fn(), deleteTask: vi.fn() };
}
describe('任务日期只读核对', () => {
  it('固定今日目标同时核对城市和寄居旅，显示二月适用日期', async () => {
    const located = { ...task, tags: ['always-today', '北京', '居'] };
    const api = fixture();
    api.filterTasks.mockImplementation(async (_ids, statuses) => statuses.includes(-1) ? [] : [located]);
    api.getTask.mockResolvedValue(located);
    const result = await inspectTickTickTaskDate(api as unknown as TickTickApi, task.title,
      { tagMap: { '2026-11-08': 'intern', '2027-02-12': 'school' }, cityMap: { '2026-11-08': GUANGZHOU, '2027-02-12': BEIJING } }, now);
    expect(result.tasks[0].nextSceneDate).toBe('2027-02-12');
    expect(api.updateTask).not.toHaveBeenCalled();
  });
  it('区分列表和详情日期，保留子任务身份，不泄露备注且不写入', async () => {
    const api = fixture();
    const result = await inspectTickTickTaskDate(api as unknown as TickTickApi, 'transformer', {}, now);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ snapshot: { parentId: 'parent', dueDate: task.dueDate },
      current: { dueDate: '2026-11-08T00:00:00+0800' }, alwaysToday: true, completedToday: false, abandonedToday: false,
      nextSceneDate: '2026-11-08' });
    expect(JSON.stringify(result)).not.toContain('private');
    for (const write of [api.updateTask, api.createTask, api.deleteTask]) expect(write).not.toHaveBeenCalled();
  });
  it('展示同日完成和放弃保护，不返回历史正文', async () => {
    const completedTime = '2026-11-08T01:00:00Z';
    const api = fixture([{ ...task, status: 2, completedTime }], [{ ...task, status: -1, completedTime }]);
    const result = await inspectTickTickTaskDate(api as unknown as TickTickApi, task.title, {}, now);
    expect(result.tasks[0]).toMatchObject({ completedToday: true, abandonedToday: true });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('未匹配时不读取其他任务详情或历史', async () => {
    const api = fixture();
    expect(await inspectTickTickTaskDate(api as unknown as TickTickApi, 'absent', {}, now)).toEqual({ today: '2026-11-08', tasks: [] });
    expect(api.getTask).not.toHaveBeenCalled(); expect(api.listCompletedTasks).not.toHaveBeenCalled();
  });
});
