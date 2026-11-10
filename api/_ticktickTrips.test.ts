import { describe, expect, it, vi } from 'vitest';
import { RuleTaskDraft } from './_ruleTaskDraft';
import { applyOutlookSnapshotToState, buildOutlookSnapshot, DEFAULT_OUTLOOK_RULES } from '../src/utils/outlookCalendar';
import {
  buildTripSourcesFromSyncState,
  buildWishPreparationSourcesFromSyncState,
  decryptTickTickToken,
  discoverTickTickTemplate,
  encryptTickTickToken,
  getTickTickRoutineExcludedTaskIds,
  getTickTickRoutineTargetDates,
  nextChineseNewYear,
  readConnectedTickTickTemplate,
  reconcileTickTickTrips,
  reconcileTickTickWishPreparations,
  shiftTickTickDate,
  syncTickTickRoutines,
  TickTickOpenApiClient,
  type TickTickApi,
  type TickTickProjectData,
  type TickTickTask,
  type TickTickTripSyncState,
} from './_ticktickTrips';

describe('TickTick 网络读取恢复', () => {
  it.each(['get', 'filter', 'completed'] as const)('%s 网络失败只重试当前读取', async operation => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(new Response('[]'));
      const api = new TickTickOpenApiClient('secret', 'https://ticktick.test', fetcher);
      const result = operation === 'get' ? api.listProjects() : operation === 'filter' ? api.filterTasks(undefined, [0]) : api.listCompletedTasks(['project'], 'from', 'through');
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it.each(['create', 'update', 'delete'] as const)('%s 网络结果未知时不重放写入', async operation => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('PRIVATE fetch failed'));
    const api = new TickTickOpenApiClient('secret', 'https://ticktick.test', fetcher);
    const result = operation === 'create' ? api.createTask({ title: 'task' }) : operation === 'update'
      ? api.updateTask('task', { title: 'task' }) : api.deleteTask('project', 'task');
    await expect(result).rejects.toThrow('TickTick 写入请求失败');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('持续读取故障在两次重试后停止，错误正文不暴露令牌和请求内容', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('PRIVATE network data'));
      const api = new TickTickOpenApiClient('PRIVATE token', 'https://ticktick.test', fetcher);
      const result = expect(api.getTask('PRIVATE-project', 'PRIVATE-task')).rejects.toThrow('TickTick 读取请求失败（GET /project/:id/task/:id）');
      await vi.runAllTimersAsync(); await result;
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

describe('TickTick 写入协议', () => {
  it.each(['create', 'update'] as const)('%s 清单项只发送数字 0/1，不改变任务状态或原始数据', async (operation) => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      // 模拟远端的实际约束；不能像普通内存 fake 一样接受任意状态。
      if (payload.items.some((item: { status: unknown }) => item.status !== 0 && item.status !== 1)) {
        return new Response('checklist item status is invalid', { status: 500 });
      }
      return new Response(JSON.stringify({ ...payload, id: 'saved' }), { status: 200 });
    });
    const api = new TickTickOpenApiClient('test-token', 'https://ticktick.test', fetcher);
    const payload = {
      id: 'task', projectId: 'project', title: '保留完成记录', status: 2,
      items: [
        { id: 'open', title: '未完成', status: 0, startDate: '2026-09-04T00:00:00+0800' },
        { id: 'done', title: '已完成', status: 1, completedTime: '2026-09-03T01:00:00Z' },
        { id: 'task-code', title: '任务式状态', status: 2, completedTime: '2026-09-03T02:00:00Z' },
        { id: 'string-open', title: '文本未完成', status: '0' },
        { id: 'string-done', title: '文本已完成', status: '1' },
        { id: 'string-task-code', title: '文本任务式状态', status: '2' },
        { id: 'null-open', title: '空状态', status: null },
        { id: 'missing-open', title: '缺少状态' },
        { id: 'missing-done', title: '有完成时间', completedTime: '2026-09-03T03:00:00Z' },
        { id: 'reopened', title: '已重新打开', status: 0, completedTime: '2026-09-03T04:00:00Z' },
      ],
    };
    const original = structuredClone(payload);
    const result = operation === 'create' ? await api.createTask(payload) : await api.updateTask('task', payload);
    expect(result.items?.map((item) => item.status)).toEqual([0, 1, 1, 0, 1, 1, 0, 0, 1, 0]);
    expect(result.status).toBe(2);
    expect(result.items?.map((item) => item.id)).toEqual(payload.items.map((item) => item.id));
    expect(result.items?.[2].completedTime).toBe('2026-09-03T02:00:00Z');
    expect(result.items?.[0].startDate).toBe('2026-09-04T00:00:00+0800');
    expect(payload).toEqual(original);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 3, 'unknown', false])('未知清单状态 %s 不猜测完成情况，且不向远端写入', async (status) => {
    const fetcher = vi.fn<typeof fetch>();
    const api = new TickTickOpenApiClient('test-token', 'https://ticktick.test', fetcher);
    await expect(api.updateTask('task', { title: '任务', items: [{ title: '需要确认的项目', status }] }))
      .rejects.toThrow('无法安全同步清单项“需要确认的项目”');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

class FakeTickTickApi implements TickTickApi {
  readonly tasks = new Map<string, TickTickTask>();
  createCalls = 0;
  updateCalls = 0;
  deleteCalls = 0;
  readonly updatePayloads = new Map<string, Record<string, unknown>>();
  private sequence = 0;

  constructor() {
    this.tasks.set('template-root', {
      id: 'template-root', projectId: 'play', title: '出门todo', content: '模板说明', tags: ['玩'], status: 0,
    });
    this.tasks.set('template-month', {
      id: 'template-month', projectId: 'play', parentId: 'template-root', title: '出门前一个月',
      startDate: '2026-10-20T00:00:00+0800', dueDate: '2026-10-20T00:00:00+0800', isAllDay: true, status: 2,
    });
    this.tasks.set('template-before', {
      id: 'template-before', projectId: 'play', parentId: 'template-root', title: '出门前一天',
      startDate: '2026-11-19T00:00:00+0800', dueDate: '2026-11-19T00:00:00+0800', isAllDay: true,
      items: [{ id: 'template-pack', title: '随身包', status: 1, sortOrder: 10 }],
    });
    this.tasks.set('template-day', {
      id: 'template-day', projectId: 'play', parentId: 'template-root', title: '出门当天',
      startDate: '2026-11-20T00:00:00+0800', dueDate: '2026-11-20T00:00:00+0800', isAllDay: true,
    });
  }

  async listProjects() {
    return [{ id: 'play', name: '玩' }];
  }

  async getPreference() {
    return { timeZone: 'Asia/Shanghai' };
  }

  async getProjectData(projectId: string): Promise<TickTickProjectData> {
    return { project: { id: projectId, name: '玩' }, tasks: [...this.tasks.values()].filter((task) => task.projectId === projectId) };
  }

  async filterTasks(projectIds: string | string[] | undefined, statuses: number[]) {
    const includedProjects = new Set(Array.isArray(projectIds) ? projectIds : [projectIds]);
    return [...this.tasks.values()].filter(
      (task) => (projectIds === undefined || includedProjects.has(task.projectId)) && statuses.includes(task.status ?? 0),
    );
  }

  async listCompletedTasks(projectIds: string[], startDate: string, endDate: string) {
    return [...this.tasks.values()].filter((task) => projectIds.includes(task.projectId)
      && task.status === 2 && task.completedTime
      && Date.parse(task.completedTime) >= Date.parse(startDate)
      && Date.parse(task.completedTime) <= Date.parse(endDate));
  }

  async getTask(projectId: string, taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task || task.projectId !== projectId) throw new Error('TickTick 404');
    return task;
  }

  async createTask(payload: Record<string, unknown>) {
    this.createCalls += 1;
    const id = `generated-${++this.sequence}`;
    const items = ((payload.items ?? []) as TickTickTask['items'])?.map((item, index) => ({
      ...item,
      id: `${id}-item-${index + 1}`,
    }));
    const task = { ...payload, id, items, status: 0 } as unknown as TickTickTask;
    this.tasks.set(id, task);
    return task;
  }

  async updateTask(taskId: string, payload: Record<string, unknown>) {
    this.updateCalls += 1;
    this.updatePayloads.set(taskId, payload);
    const current = this.tasks.get(taskId);
    if (!current) throw new Error('TickTick 404');
    const items = ((payload.items ?? current.items ?? []) as TickTickTask['items'])?.map((item, index) => ({
      ...item,
      id: item.id || `${taskId}-new-item-${index + 1}`,
    }));
    const updated = { ...current, ...payload, id: taskId, items } as TickTickTask;
    this.tasks.set(taskId, updated);
    return updated;
  }

  async deleteTask(projectId: string, taskId: string) {
    this.deleteCalls += 1;
    if (this.tasks.get(taskId)?.projectId !== projectId) throw new Error('TickTick 404');
    if (!this.tasks.delete(taskId)) throw new Error('TickTick 404');
  }
}

class FakeRoutineTickTickApi extends FakeTickTickApi {
  constructor() {
    super();
    this.tasks.set('home-root', {
      id: 'home-root', projectId: 'life', title: '在家 routine', status: 0,
    });
    this.tasks.set('home-dated', {
      id: 'home-dated', projectId: 'life', parentId: 'home-root', title: '整理房间', status: 0, tags: ['寄'],
      startDate: '2026-08-31T09:00:00+0800', dueDate: '2026-09-01T18:00:00+0800',
      timeZone: 'Asia/Shanghai', reminders: ['TRIGGER:P0DT9H0M0S'],
    });
    this.tasks.set('home-no-date', {
      id: 'home-no-date', projectId: 'life', parentId: 'home-root', title: '想起来再做', status: 0, tags: ['寄'],
    });
    this.tasks.set('home-completed', {
      id: 'home-completed', projectId: 'life', parentId: 'home-root', title: '已完成', status: 2, tags: ['寄'],
      dueDate: '2026-09-01T00:00:00+0800',
    });
    this.tasks.set('school-root', {
      id: 'school-root', projectId: 'life', title: '在校 ROUTINE', status: 0,
    });
    this.tasks.set('school-dated', {
      id: 'school-dated', projectId: 'life', parentId: 'school-root', title: '校园卡充值', status: 0, tags: ['居'],
      startDate: '2026-09-15T00:00:00+0800', dueDate: '2026-09-15T00:00:00+0800',
      items: [
        { id: 'school-item', title: '查余额', status: 0, startDate: '2026-09-15T07:30:00+0800' },
        { id: 'school-item-done', title: '已处理', status: 1, startDate: '2026-09-15T08:00:00+0800' },
      ],
    });
    this.tasks.set('school-start-only', {
      id: 'school-start-only', projectId: 'life', parentId: 'school-root', title: '只有开始日期', status: 0, tags: ['居'],
      startDate: '2026-09-15T08:30:00+0800',
    });
    this.tasks.set('unrelated-dated', {
      id: 'unrelated-dated', projectId: 'life', title: '清单内其他任务', status: 0,
      startDate: '2026-09-15T00:00:00+0800', dueDate: '2026-09-15T00:00:00+0800',
    });
  }

  async listProjects() {
    // The built-in Inbox ("life" here) is absent from /project.
    return [{ id: 'play', name: '玩' }];
  }

  async getProjectData(projectId: string): Promise<TickTickProjectData> {
    const project = (await this.listProjects()).find((candidate) => candidate.id === projectId);
    return {
      project,
      tasks: [...this.tasks.values()].filter((task) => task.projectId === projectId),
    };
  }

  async filterTasks(projectIds: string | string[] | undefined, statuses: number[]) {
    return (await super.filterTasks(projectIds, statuses)).map((task) => task.projectId === 'life'
      ? {
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        status: task.status,
      }
      : task);
  }

  async updateTask(taskId: string, payload: Record<string, unknown>) {
    const updated = await super.updateTask(taskId, payload);
    return {
      id: updated.id,
      projectId: updated.projectId,
      title: updated.title,
      status: updated.status,
    };
  }
}

const futureTrip = {
  key: '2027-01-10',
  startDate: '2027-01-10',
  endDate: '2027-01-12',
  dates: ['2027-01-10', '2027-01-11', '2027-01-12'],
  name: '东京',
  note: '带护照',
};

function addWishPreparationTemplate(api: FakeTickTickApi) {
  api.tasks.set('template-seven-months', {
    id: 'template-seven-months', projectId: 'play', parentId: 'template-root', title: '出门前七个月',
    startDate: '2026-04-20T00:00:00+0800', dueDate: '2026-04-20T00:00:00+0800',
    items: [{ id: 'template-visa-check', title: '查签证', status: 1, startDate: '2026-04-21T09:00:00+0800' }],
    status: 2,
  });
  api.tasks.set('template-visa', {
    id: 'template-visa', projectId: 'play', parentId: 'template-seven-months', title: '办签证',
    startDate: '2026-04-21T08:00:00+0800', dueDate: '2026-04-22T18:00:00+0800', isAllDay: false,
  });
  api.tasks.set('template-photo', {
    id: 'template-photo', projectId: 'play', parentId: 'template-visa', title: '准备证件照',
  });
}

const futureWish = { id: 'wish-tokyo', name: '东京', isActive: true, deadline: '2027-09-30', linkedTripStartDate: null };

describe('洗头标签日期跟随', () => {
  const source: TickTickTask = { id: 'wash', projectId: 'play', title: '洗头', status: 0,
    startDate: '2026-09-08T09:00:00+0800', dueDate: '2026-09-08T09:00:00+0800', timeZone: 'Asia/Shanghai' };
  const follower: TickTickTask = { id: 'follow', projectId: 'life', title: '更换枕套', status: 0,
    tags: ['洗头'], dueDate: '2026-09-01T21:00:00+0800', timeZone: 'Asia/Shanghai', isAllDay: false };
  const setup = (...tasks: TickTickTask[]) => {
    const api = new FakeTickTickApi();
    api.tasks.clear();
    for (const task of tasks) api.tasks.set(task.id, structuredClone(task));
    return api;
  };
  const sync = (api: TickTickApi) => syncTickTickRoutines({ api, calendarState: {}, today: '2026-09-04' });

  it('跨清单跟随日期并保留各自时刻，来源和无关任务不改动，重复同步零更新', async () => {
    const other = { ...follower, id: 'other', tags: ['洗头用品'] };
    const child = { ...follower, id: 'child', parentId: follower.id, tags: [] };
    const done = { ...follower, id: 'done', status: 2, completedTime: '2026-09-01T12:00:00Z' };
    const api = setup(follower, source, other, child, done);
    expect(await sync(api)).toMatchObject({ updatedRoutineTasks: 1 });
    expect(api.tasks.get(follower.id)).toMatchObject({ ...follower, dueDate: '2026-09-08T21:00:00+0800' });
    expect(api.tasks.get(source.id)).toEqual(source);
    for (const unchanged of [other, child, done]) expect(api.tasks.get(unchanged.id)).toEqual(unchanged);
    expect(await sync(api)).toMatchObject({ updatedRoutineTasks: 0 });
    expect(api.updateCalls).toBe(1);
  });

  it('无日期跟随项补全天，空白标签和来源名称可识别，来源不会自我跟随', async () => {
    const api = setup({ ...source, title: ' 洗头 ', tags: ['洗头'] }, { ...follower, dueDate: undefined, tags: [' 洗头 '] });
    await sync(api);
    expect(api.tasks.get(follower.id)).toMatchObject({ startDate: '2026-09-08T00:00:00+0800',
      dueDate: '2026-09-08T00:00:00+0800', timeZone: 'Asia/Shanghai', isAllDay: true });
    expect(api.updatePayloads.has(source.id)).toBe(false);
  });

  it('以来源本轮场景排期后的日期为准，无论来源在列表中的先后顺序', async () => {
    const api = setup({ ...follower, tags: ['洗头', '寄'] }, { ...source, tags: ['居'] });
    const options = { api, calendarState: { tagMap: { '2026-09-05': 'school', '2026-09-09': 'home' } }, today: '2026-09-04' };
    expect(await syncTickTickRoutines(options)).toMatchObject({ updatedRoutineTasks: 2 });
    expect(api.tasks.get(source.id)?.dueDate).toBe('2026-09-05T09:00:00+0800');
    expect(api.tasks.get(follower.id)?.dueDate).toBe('2026-09-09T21:00:00+0800');
    expect([...api.updatePayloads.keys()]).toEqual([source.id, follower.id]);
    expect(await syncTickTickRoutines(options)).toMatchObject({ updatedRoutineTasks: 0 });
  });

  it.each(['RRULE:FREQ=DAILY', 'RRULE:FREQ=DAILY;INTERVAL=7', 'RRULE:FREQ=WEEKLY', 'RRULE:FREQ=MONTHLY', 'CUSTOM:UNKNOWN'])
   ('跟随优先于自身循环 %s，但必须满足自身地点', async (repeatFlag) => {
      const recurring = { ...follower, repeatFlag, tags: ['洗头', '居'] };
      const api = setup(source, recurring, { ...recurring, id: 'history', status: 2, completedTime: '2026-09-04T03:00:00Z' });
      const completed = vi.spyOn(api, 'listCompletedTasks');
      await syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'school', '2026-09-08': 'travel', '2026-09-10': 'school' } }, today: '2026-09-04' });
      expect(api.tasks.get(follower.id)).toMatchObject({ repeatFlag, dueDate: '2026-09-10T21:00:00+0800', status: 0 });
      expect(completed).not.toHaveBeenCalled();
    });

  it('来源的长周期保持原下一次日期，完成后跟随新生成的未完成来源', async () => {
    const recurringSource = { ...source, tags: ['居'], repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=3' };
    const api = setup(recurringSource, follower);
    const options = { api, calendarState: { tagMap: { '2026-09-04': 'school' } }, today: '2026-09-04' };
    await syncTickTickRoutines(options);
    expect(api.tasks.get(source.id)).toEqual(recurringSource);
    api.tasks.set(source.id, { ...recurringSource, status: 2, completedTime: '2026-09-04T03:00:00Z' });
    api.tasks.set('next-wash', { ...recurringSource, id: 'next-wash',
      startDate: '2026-09-11T09:00:00+0800', dueDate: '2026-09-11T09:00:00+0800' });
    expect(await syncTickTickRoutines(options)).toMatchObject({ updatedRoutineTasks: 1 });
    expect(api.tasks.get(follower.id)?.dueDate).toBe('2026-09-11T21:00:00+0800');
    expect(api.tasks.get(source.id)?.status).toBe(2);
    expect(await syncTickTickRoutines(options)).toMatchObject({ updatedRoutineTasks: 0 });
  });

  it.each(['missing', 'completed', 'undated', 'invalid', 'similar'] as const)
   ('%s 来源不猜日期，也不回退到跟随项的场景日期', async (kind) => {
      const unavailable = { ...source };
      if (kind === 'completed') unavailable.status = 2;
      if (kind === 'undated') { delete unavailable.dueDate; delete unavailable.startDate; }
      if (kind === 'invalid') { unavailable.dueDate = 'invalid'; delete unavailable.startDate; }
      if (kind === 'similar') unavailable.title = '今晚洗头';
      const value = { ...follower, tags: ['洗头', '居'] };
      const api = setup(value, ...(kind === 'missing' ? [] : [unavailable]));
      expect(await syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'school' } }, today: '2026-09-04' }))
        .toMatchObject({ updatedRoutineTasks: 0 });
      expect(api.tasks.get(follower.id)).toEqual(value);
    });

  it('多个未完成同名来源明确报错，修改前停止；完成历史不造成重名', async () => {
    const api = setup(source, follower, { ...source, id: 'second', projectId: 'life' });
    await expect(sync(api)).rejects.toThrow('找到 2 个未完成的“洗头”待办');
    expect(api.updateCalls).toBe(0);
    api.tasks.get('second')!.status = 2;
    expect(await sync(api)).toMatchObject({ updatedRoutineTasks: 1 });
  });

  it.each(['startDate', 'dueDate'] as const)('来源只有 %s 且 UTC 表示上海全天日期时正确对齐', async (field) => {
    const api = setup({ ...source, startDate: undefined, dueDate: undefined, [field]: '2026-09-07T16:00:00.000+0000', isAllDay: true },
      { ...follower, startDate: '2026-08-31T22:00:00+0800', items: [
        { id: 'open', title: '未完成', status: 0, startDate: '2026-09-01T08:30:00+0800' },
        { id: 'done', title: '已完成', status: 1, startDate: '2026-09-01T09:30:00+0800' },
        { id: 'undated', title: '无日期', status: 0 },
      ] });
    await sync(api);
    expect(api.tasks.get(follower.id)).toMatchObject({ startDate: '2026-09-07T22:00:00+0800',
      dueDate: '2026-09-08T21:00:00+0800', timeZone: 'Asia/Shanghai', isAllDay: false,
      items: [
        { id: 'open', status: 0, startDate: '2026-09-08T08:30:00+0800' },
        { id: 'done', status: 1, startDate: '2026-09-01T09:30:00+0800' },
        { id: 'undated', status: 0 },
      ] });
    expect(await sync(api)).toMatchObject({ updatedRoutineTasks: 0 });
  });

  it('全局筛选漏掉收集箱时仍找到来源，按任务真实 projectId 写入跟随项', async () => {
    const api = setup({ ...source, projectId: 'inbox-user' }, { ...follower, projectId: 'inbox-user' });
    vi.spyOn(api, 'filterTasks').mockResolvedValue([]);
    vi.spyOn(api, 'getProjectData').mockImplementation(async (id) => ({ tasks: id === 'inbox' ? [...api.tasks.values()] : [] }));
    await sync(api);
    expect(api.updatePayloads.get(follower.id)).toMatchObject({ projectId: 'inbox-user', dueDate: '2026-09-08T21:00:00+0800' });
  });

  it('明确的洗头标签也作用于被排除场景规则的模板或生成待办', async () => {
    const api = setup(source, follower);
    await syncTickTickRoutines({ api, calendarState: {}, today: '2026-09-04', excludedTaskIds: new Set([follower.id]) });
    expect(api.tasks.get(follower.id)?.dueDate).toBe('2026-09-08T21:00:00+0800');
  });

  it.each(['date', 'repeat'] as const)('远端未正确保存 %s 时不能报告成功', async (field) => {
    const api = setup(source, { ...follower, repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=2' });
    const update = api.updateTask.bind(api);
    vi.spyOn(api, 'updateTask').mockImplementation(async (id, payload) => {
      const result = await update(id, payload);
      if (field === 'date') result.dueDate = follower.dueDate;
      else result.repeatFlag = 'RRULE:FREQ=DAILY';
      return result;
    });
    await expect(sync(api)).rejects.toThrow(field === 'date' ? '未正确更新' : '未正确保留');
  });
});

describe('寄居旅标签排期', () => {
  function apiWithTasks(tasks: TickTickTask[]) {
    const api = new FakeRoutineTickTickApi();
    api.tasks.clear();
    for (const task of tasks) api.tasks.set(task.id, task);
    return api;
  }

  function todo(tags: string[], fields: Partial<TickTickTask> = {}): TickTickTask {
    return { id: 'todo', projectId: 'life', title: '处理待办', status: 0, tags, ...fields };
  }

  const calendarState = { tagMap: {
    '2026-09-03': 'travel', '2026-09-06': 'intern', '2026-09-07': 'school',
    '2026-09-08': 'travel', '2026-09-09': 'travel', '2026-09-12': 'home',
  } };

  it.each([
    { tags: ['寄'], date: '2026-09-12' },
    { tags: ['居'], date: '2026-09-06' },
    { tags: ['旅'], date: '2026-09-08' },
    { tags: ['寓'], date: '2026-09-06' },
    { tags: ['寄', '居'], date: '2026-09-06' },
    { tags: ['寄', '旅'], date: '2026-09-08' },
    { tags: ['寄', '居', '旅'], date: '2026-09-06' },
    { tags: ['其他', ' 居 ', '寓', '居'], date: '2026-09-06' },
  ])('$tags 的无日期待办排到 $date，重复同步不再写入', async ({ tags, date }) => {
    const api = apiWithTasks([todo(tags)]);
    const options = { api, calendarState, today: '2026-09-04' };
    const result = await syncTickTickRoutines(options);
    expect(api.tasks.get('todo')).toMatchObject({
      tags, startDate: `${date}T00:00:00+0800`, dueDate: `${date}T00:00:00+0800`,
      isAllDay: true, timeZone: 'Asia/Shanghai',
    });
    expect(result.updatedRoutineTasks).toBe(1);
    expect(api.updateCalls).toBe(1);
    expect(result.routineTaskCounts.school).toBe(tags.some((tag) => ['居', '寓'].includes(tag.trim())) ? 1 : 0);
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({ updatedRoutineTasks: 0 });
    expect(api.updateCalls).toBe(1);
  });

  it('游是普通标签，正在出游时也不覆盖手动日期或给无日期待办补期', async () => {
    const dated = todo(['游', '玩'], {
      title: '音乐剧&演唱会check',
      startDate: '2026-09-28T10:00:00+0800', dueDate: '2026-09-28T12:00:00+0800',
      timeZone: 'Asia/Shanghai', isAllDay: false,
      items: [{ id: 'check', title: '查演出', status: 0, startDate: '2026-09-28T10:00:00+0800' }],
    });
    const api = apiWithTasks([dated, todo(['游'], { id: 'undated' })]);
    const original = structuredClone([...api.tasks.values()]);
    const options = { api, calendarState: { tagMap: { '2026-09-25': 'travel' } }, today: '2026-09-25' };
    for (let index = 0; index < 2; index++) {
      await expect(syncTickTickRoutines(options)).resolves.toMatchObject({
        updatedRoutineTasks: 0, routineTaskCounts: { home: 0, school: 0, travel: 0 },
      });
      expect([...api.tasks.values()]).toEqual(original);
    }
    expect(api.updateCalls).toBe(0);
  });

  it.each([
    { tags: ['游', '居'], date: '2026-09-28' },
    { tags: ['游', '旅'], date: '2026-09-25' },
  ])('游不提供排期候选，$tags 仍按正式场景标签排到 $date', async ({ tags, date }) => {
    const api = apiWithTasks([todo(tags)]);
    await syncTickTickRoutines({ api, today: '2026-09-25', calendarState: { tagMap: { '2026-09-25': 'travel', '2026-09-28': 'intern' } } });
    expect(api.tasks.get('todo')?.dueDate).toBe(`${date}T00:00:00+0800`);
    expect(api.updateCalls).toBe(1);
  });

  it('正在出游时取今天，出游结束后取下一次出游开始日', () => {
    const calendar = { tagMap: { ...calendarState.tagMap, '2026-10-01': 'travel' } };
    expect(getTickTickRoutineTargetDates(calendar, '2026-09-09').travel).toBe('2026-09-09');
    expect(getTickTickRoutineTargetDates(calendar, '2026-09-10').travel).toBe('2026-10-01');
    expect(getTickTickRoutineTargetDates(calendar, '2026-10-02').travel).toBeNull();
    expect(getTickTickRoutineTargetDates(calendar, '2026-09-07').school).toBe('2026-09-07');
  });

  it('春节不代表在寄，缺失或非法日历日期不参与', () => {
    expect(getTickTickRoutineTargetDates({ tagMap: { '2026-09-31': 'home', '2026-13-01': 'school' } }, '2026-09-25'))
      .toEqual({ home: null, school: null, travel: null });
    expect(getTickTickRoutineTargetDates({}, '2027-02-06').home).toBeNull();
    expect(getTickTickRoutineTargetDates({}, '2027-02-07').home).toBeNull();
  });

  it.each([['居'], ['旅'], ['居', '旅']])('%j 无候选日时保留日期及未排期待办', async (...tags) => {
    const dated = todo(tags, { dueDate: '2026-08-30T08:00:00+0800' });
    const undated = todo(tags, { id: 'undated' });
    const api = apiWithTasks([dated, undated]);
    const before = structuredClone([...api.tasks.values()]);
    await expect(syncTickTickRoutines({ api, calendarState: { tagMap: {} }, today: '2026-09-04' }))
      .resolves.toMatchObject({ updatedRoutineTasks: 0 });
    expect([...api.tasks.values()]).toEqual(before);
    expect(api.updateCalls).toBe(0);
  });

  it('多标签取已确认的适用日期，不把春节当作寄', async () => {
    const api = apiWithTasks([todo(['居', '旅']), todo(['居', '寄'], { id: 'fallback' })]);
    await syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-10': 'travel' } }, today: '2026-09-04' });
    expect(api.tasks.get('todo')?.dueDate).toBe('2026-09-10T00:00:00+0800');
    expect(api.tasks.get('fallback')?.dueDate).toBeUndefined();
  });

  it('只看自身标签，不继承父任务标签，也不根据旧清单或父任务名称排期', async () => {
    const api = apiWithTasks([
      todo(['寄'], { id: 'parent', title: '在校routine' }),
      todo(['居'], { id: 'child', parentId: 'parent' }),
      todo([], { id: 'untagged', parentId: 'parent', dueDate: '2026-08-30T00:00:00+0800' }),
      todo(['其他'], { id: 'old-root', title: '在家routine' }),
    ]);
    await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
    expect(api.tasks.get('parent')?.dueDate).toBe('2026-09-12T00:00:00+0800');
    expect(api.tasks.get('child')?.dueDate).toBe('2026-09-06T00:00:00+0800');
    expect(api.tasks.get('untagged')?.dueDate).toBe('2026-08-30T00:00:00+0800');
    expect(api.tasks.get('old-root')?.dueDate).toBeUndefined();
    expect(api.updateCalls).toBe(2);
  });

  it('无日期父待办补全天日期，清单项只平移已有日期的未完成项', async () => {
    const api = apiWithTasks([todo(['旅'], {
      content: '说明', desc: '备注', priority: 5, sortOrder: 123, kind: 'CHECKLIST', reminders: [],
      items: [
        { id: 'pending', title: '准备', status: 0, startDate: '2026-08-30T09:30:00+0800' },
        { id: 'undated', title: '备选', status: 0 },
        { id: 'done', title: '已处理', status: 1, startDate: '2026-08-29T00:00:00+0800', completedTime: '2026-08-29T01:00:00Z' },
      ],
    })]);
    await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
    expect(api.tasks.get('todo')).toMatchObject({
      dueDate: '2026-09-08T00:00:00+0800', content: '说明', desc: '备注', priority: 5, sortOrder: 123,
      kind: 'CHECKLIST', reminders: [],
      items: [
        { id: 'pending', status: 0, startDate: '2026-09-08T09:30:00+0800' },
        { id: 'undated', status: 0 },
        { id: 'done', status: 1, startDate: '2026-08-29T00:00:00+0800', completedTime: '2026-08-29T01:00:00Z' },
      ],
    });
    expect(api.tasks.get('todo')?.items?.[1].startDate).toBeUndefined();
  });

  it('旅标签保留已有任务的时刻、时区和跨日起止间隔', async () => {
    const api = apiWithTasks([todo(['旅'], {
      startDate: '2026-09-01T07:30:00+0900', dueDate: '2026-09-02T18:00:00+0900',
      isAllDay: false, timeZone: 'Asia/Tokyo', reminders: ['TRIGGER:PT0S'],
    })]);
    await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
    expect(api.tasks.get('todo')).toMatchObject({
      startDate: '2026-09-07T07:30:00+0900', dueDate: '2026-09-08T18:00:00+0900',
      isAllDay: false, timeZone: 'Asia/Tokyo', reminders: ['TRIGGER:PT0S'],
    });
  });

  it('今天完成后跨全部标签重选，连续出游可以排到明天', async () => {
    const task = todo(['寄', '居', '旅'], {
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', dueDate: '2026-09-04T00:00:00+0800',
    });
    const history = { ...task, id: 'done', status: 2, completedTime: '2026-09-04T00:30:00+0800' };
    const api = apiWithTasks([task, history]);
    const options = { api, today: '2026-09-04', calendarState: { tagMap: {
      '2026-09-04': 'travel', '2026-09-05': 'travel', '2026-09-07': 'intern', '2026-09-10': 'home',
    } } };
    await syncTickTickRoutines(options);
    expect(api.tasks.get('todo')?.dueDate).toBe('2026-09-05T00:00:00+0800');
    expect(api.tasks.get('done')).toEqual(history);
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({ updatedRoutineTasks: 0 });
  });

  it('今天完成的寄居任务可在明天由寄切换到居，春节完成后不排回今天', async () => {
    const task = todo(['寄', '居'], { repeatFlag: 'RRULE:FREQ=DAILY', dueDate: '2027-02-06T00:00:00+0800' });
    const api = apiWithTasks([task, { ...task, id: 'done', status: 2, completedTime: '2027-02-06T01:00:00+0800' }]);
    await syncTickTickRoutines({ api, today: '2027-02-06', calendarState: { tagMap: { '2027-02-07': 'school' } } });
    expect(api.tasks.get('todo')?.dueDate).toBe('2027-02-07T00:00:00+0800');
    api.tasks.get('todo')!.tags = ['寄'];
    await syncTickTickRoutines({ api, today: '2027-02-06', calendarState: {} });
    expect(api.tasks.get('todo')?.dueDate).toBe('2027-02-07T00:00:00+0800');
  });

  describe('居与旅的长周期任务', () => {
    const recurringTask = (tags: string[], fields: Partial<TickTickTask> = {}) => todo(tags, {
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=7',
      startDate: '2026-09-20T09:00:00+0800', dueDate: '2026-09-20T18:00:00+0800',
      timeZone: 'Asia/Shanghai', isAllDay: false, content: '保留备注', priority: 5,
      reminders: ['TRIGGER:PT0S'],
      items: [
        { id: 'pending', title: '待处理', status: 0, startDate: '2026-09-19T10:00:00+0800' },
        { id: 'done', title: '已处理', status: 1, startDate: '2026-09-19T10:00:00+0800' },
        { id: 'undated', title: '备选', status: 0 },
      ],
      ...fields,
    });
    const rules = [
      { repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=2', nextDate: '2026-09-08' },
      { repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=7', nextDate: '2026-09-13' },
      { repeatFlag: 'RRULE:FREQ=WEEKLY', nextDate: '2026-09-13' },
      { repeatFlag: 'RRULE:FREQ=WEEKLY;BYDAY=MO,FR', nextDate: '2026-09-07' },
      { repeatFlag: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=6', nextDate: '2026-10-06' },
      { repeatFlag: 'RRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=6', nextDate: '2027-09-06' },
      { repeatFlag: 'RRULE:FREQ=DAILY;BYDAY=MO,WE,FR', nextDate: '2026-09-07' },
      { repeatFlag: 'RRULE:FREQ=DAILY;BYMONTHDAY=15', nextDate: '2026-09-15' },
    ];
    const scenes = [
      { tag: '居', away: 'travel', current: 'school', following: 'intern' },
      { tag: '旅', away: 'home', current: 'travel', following: 'travel' },
    ];

    it.each(scenes.flatMap((scene) => rules.map((rule) => ({ ...scene, ...rule }))))(
      '$tag 的 $repeatFlag 离开时统一移到场景首日，进入并完成后恢复原周期',
      async ({ tag, away, current, following, repeatFlag, nextDate }) => {
        const task = recurringTask([tag], { repeatFlag });
        const api = apiWithTasks([task]);
        const calendarState = { tagMap: {
          '2026-09-04': away, '2026-09-05': away,
          '2026-09-06': current, '2026-09-07': following, '2026-09-08': following,
        } };
        await expect(syncTickTickRoutines({ api, calendarState, today: '2026-09-04' }))
          .resolves.toMatchObject({ updatedRoutineTasks: 1 });
        expect(api.tasks.get('todo')).toEqual({
          ...task, startDate: '2026-09-06T09:00:00+0800', dueDate: '2026-09-06T18:00:00+0800',
          items: [{ ...task.items![0], startDate: '2026-09-06T10:00:00+0800' }, ...task.items!.slice(1)],
        });
        for (const today of ['2026-09-04', '2026-09-05', '2026-09-06']) {
          await expect(syncTickTickRoutines({ api, calendarState, today }))
            .resolves.toMatchObject({ updatedRoutineTasks: 0 });
        }
        // 模拟滴答完成当前待办后保留历史记录并生成下一次日期。
        const completed = { ...api.tasks.get('todo')!, id: 'history', status: 2, completedTime: '2026-09-06T10:00:00+0800' };
        api.tasks.set(completed.id, completed);
        const next = { ...task, startDate: `${nextDate}T09:00:00+0800`, dueDate: `${nextDate}T18:00:00+0800` };
        api.tasks.set(next.id, next);
        for (const today of ['2026-09-06', '2026-09-06', '2026-09-07', '2026-09-08']) {
          await expect(syncTickTickRoutines({ api, calendarState, today }))
            .resolves.toMatchObject({ updatedRoutineTasks: 0 });
          expect(api.tasks.get('todo')).toEqual(next);
          expect(api.tasks.get('history')).toEqual(completed);
        }
        expect(api.updateCalls).toBe(1);
      },
    );

    it.each(scenes.flatMap((scene) => ['2026-09-01', '2026-09-06', '2026-09-20']
      .map((date) => ({ ...scene, date }))))('$tag 在适用场景内保留 $date 的原日期和未对齐的清单项', async ({ tag, current, date }) => {
      const task = recurringTask([tag], { startDate: undefined, dueDate: `${date}T18:00:00+0800` });
      const api = apiWithTasks([task]);
      const completed = vi.spyOn(api, 'listCompletedTasks').mockRejectedValue(new Error('完成记录不可用'));
      await expect(syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-06': current } }, today: '2026-09-06' }))
        .resolves.toMatchObject({ updatedRoutineTasks: 0 });
      expect(api.tasks.get('todo')).toEqual(task);
      expect(completed).not.toHaveBeenCalled();
    });

    it.each([
      { tags: ['寄', '居'], current: 'home' },
      { tags: ['寄', '旅'], current: 'home' },
      { tags: ['居', '旅'], current: 'school' },
      { tags: ['居', '旅'], current: 'travel' },
      { tags: ['寄', '居', '旅'], current: 'intern' },
      { tags: ['其他', ' 寓 '], current: 'intern' },
    ])('$tags 只要匹配当前 $current 场景就保留周期', async ({ tags, current }) => {
      const task = recurringTask(tags);
      const api = apiWithTasks([task]);
      await expect(syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-06': current } }, today: '2026-09-06' }))
        .resolves.toMatchObject({ updatedRoutineTasks: 0 });
      expect(api.tasks.get('todo')).toEqual(task);
    });

    it.each([
      { tags: ['居', '旅'], current: 'home', earlier: 'travel', later: 'school' },
      { tags: ['寄', '居'], current: 'travel', earlier: 'home', later: 'intern' },
    ])('$tags 离开所有适用场景后取最早的适用首日', async ({ tags, current, earlier, later }) => {
      const task = recurringTask(tags);
      const api = apiWithTasks([task]);
      const calendarState = { tagMap: { '2026-09-04': current, '2026-09-06': earlier, '2026-09-09': later } };
      await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
      expect(api.tasks.get('todo')?.dueDate).toBe('2026-09-06T18:00:00+0800');
      expect(api.tasks.get('todo')?.repeatFlag).toBe(task.repeatFlag);
    });

    it('旅任务在连续旅行期间不改期，旅行结束后移到下一次出游首日', async () => {
      const task = recurringTask(['旅']);
      const api = apiWithTasks([task]);
      const calendarState = { tagMap: {
        '2026-09-06': 'travel', '2026-09-07': 'travel', '2026-09-08': 'home',
        '2026-09-09': 'intern', '2026-09-12': 'travel', '2026-09-13': 'travel',
      } };
      for (const today of ['2026-09-06', '2026-09-07']) {
        await syncTickTickRoutines({ api, calendarState, today });
        expect(api.tasks.get('todo')).toEqual(task);
      }
      await syncTickTickRoutines({ api, calendarState, today: '2026-09-08' });
      expect(api.tasks.get('todo')?.dueDate).toBe('2026-09-12T18:00:00+0800');
      for (const today of ['2026-09-09', '2026-09-12', '2026-09-13']) {
        await expect(syncTickTickRoutines({ api, calendarState, today })).resolves.toMatchObject({ updatedRoutineTasks: 0 });
      }
      expect(api.updateCalls).toBe(1);
    });

    it.each(scenes.flatMap((scene) => [true, false].map((matching) => ({ ...scene, matching }))))(
      '$tag 无日期且当前场景匹配为 $matching 时补最近适用日期，后续不滚动',
      async ({ tag, current, away, matching }) => {
        const task = recurringTask([tag], { startDate: undefined, dueDate: undefined, items: [] });
        const api = apiWithTasks([task]);
        const calendarState = { tagMap: { '2026-09-04': matching ? current : away, '2026-09-06': current, '2026-09-07': current } };
        const targetDate = matching ? '2026-09-04' : '2026-09-06';
        await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
        expect(api.tasks.get('todo')).toMatchObject({
          startDate: `${targetDate}T00:00:00+0800`, dueDate: `${targetDate}T00:00:00+0800`,
          isAllDay: true, timeZone: 'Asia/Shanghai', repeatFlag: task.repeatFlag,
        });
        await expect(syncTickTickRoutines({ api, calendarState, today: '2026-09-07' })).resolves.toMatchObject({ updatedRoutineTasks: 0 });
      },
    );

    it.each([
      {}, { '2026-09-06': 'school', '2026-09-07': 'travel' },
      { '2026-09-04': 'unknown', '2026-09-06': 'school' }, { '2026-09-04': 'home' },
      { '2026-09-04': 'home', '2026-09-31': 'school', '2026-13-01': 'travel' },
    ])('今日场景缺失或无未来适用日时保留原有日期和无日期任务：%j', async (tagMap) => {
      const tasks = [recurringTask(['居']), recurringTask(['旅'], { id: 'travel', startDate: undefined, dueDate: undefined })];
      const api = apiWithTasks(tasks);
      await expect(syncTickTickRoutines({ api, calendarState: { tagMap }, today: '2026-09-04' })).resolves.toMatchObject({ updatedRoutineTasks: 0 });
      expect([...api.tasks.values()]).toEqual(tasks);
    });

    it('长周期多标签任务没有明确的适用日时不使用春节兜底', async () => {
      const task = recurringTask(['寄', '居']);
      const api = apiWithTasks([task]);
      await expect(syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'travel' } }, today: '2026-09-04' }))
        .resolves.toMatchObject({ updatedRoutineTasks: 0 });
      expect(api.tasks.get('todo')).toEqual(task);
    });

    it.each([
      'not-a-rule', 'RRULE:INTERVAL=7', 'RRULE:FREQ=LUNAR', 'RRULE:FREQ=DAILY;INTERVAL=0',
      'RRULE:FREQ=DAILY;INTERVAL=-1', 'RRULE:FREQ=DAILY;INTERVAL=1.5', 'RRULE:FREQ=DAILY;COUNT=0',
      'RRULE:FREQ=DAILY;INTERVAL=7;X-CUSTOM=1', 'RRULE:FREQ=WEEKLY;BYDAY=NOTADAY',
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=32', 'RRULE:FREQ=DAILY;FREQ=WEEKLY', 'RRULE:FREQ=DAILY;',
    ])('无法识别的规则 %s 在场景内外均不改期', async (repeatFlag) => {
      const tasks = [recurringTask(['居'], { repeatFlag }), recurringTask(['旅'], { id: 'travel', repeatFlag, startDate: undefined, dueDate: undefined })];
      const api = apiWithTasks(tasks);
      const calendarState = { tagMap: { '2026-09-04': 'home', '2026-09-06': 'school', '2026-09-07': 'travel' } };
      for (const today of ['2026-09-04', '2026-09-06', '2026-09-07']) {
        await expect(syncTickTickRoutines({ api, calendarState, today })).resolves.toMatchObject({ updatedRoutineTasks: 0 });
      }
      expect([...api.tasks.values()]).toEqual(tasks);
    });

    it('UTC 表示的全天长周期任务仅离开场景时改期，只有开始日期也能保护', async () => {
      const task = recurringTask(['居'], { startDate: '2026-09-19T16:00:00.000+0000', dueDate: undefined, isAllDay: true });
      const api = apiWithTasks([task]);
      const calendarState = { tagMap: { '2026-09-04': 'travel', '2026-09-06': 'intern', '2026-09-07': 'school' } };
      await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
      const moved = structuredClone(api.tasks.get('todo'));
      expect(moved).toMatchObject({ startDate: '2026-09-05T16:00:00.000+0000', dueDate: undefined, repeatFlag: task.repeatFlag });
      for (const today of ['2026-09-06', '2026-09-07']) {
        await syncTickTickRoutines({ api, calendarState, today });
        expect(api.tasks.get('todo')).toEqual(moved);
      }
    });

    it('改期后远端丢失重复规则时不能报告成功', async () => {
      const api = apiWithTasks([recurringTask(['旅'])]);
      const update = api.updateTask.bind(api);
      api.updateTask = async (id, payload) => {
        const result = await update(id, payload);
        delete api.tasks.get(id)!.repeatFlag;
        return result;
      };
      await expect(syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'home', '2026-09-06': 'travel' } }, today: '2026-09-04' }))
        .rejects.toThrow('未正确保留');
    });

    it.each([
      'RRULE:FREQ=DAILY', 'RRULE:FREQ=DAILY;INTERVAL=1',
      'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
    ])('每天重复的 %s 沿用当天执行、完成后排明天的规则', async (repeatFlag) => {
      const task = recurringTask(['居', '旅'], { repeatFlag });
      const api = apiWithTasks([task]);
      const calendarState = { tagMap: { '2026-09-04': 'school', '2026-09-05': 'travel' } };
      await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
      expect(api.tasks.get('todo')?.dueDate).toBe('2026-09-04T18:00:00+0800');
      api.tasks.set('history', { ...task, id: 'history', status: 2, completedTime: '2026-09-04T18:00:00+0800' });
      await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
      expect(api.tasks.get('todo')?.dueDate).toBe('2026-09-05T18:00:00+0800');
    });

    it('仅寄标签沿用原排期，普通游标签仍不参与场景同步', async () => {
      const tasks = [recurringTask(['寄']), recurringTask(['游'], { id: 'ordinary' })];
      const api = apiWithTasks(tasks);
      await syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'home' } }, today: '2026-09-04' });
      expect(api.tasks.get('todo')?.dueDate).toBe('2026-09-04T18:00:00+0800');
      expect(api.tasks.get('ordinary')).toEqual(tasks[1]);
    });
  });

  it('新补日期的待办远端未保存日期时不能报告成功', async () => {
    const api = apiWithTasks([todo(['寄'])]);
    api.getTask = async () => todo(['寄']);
    await expect(syncTickTickRoutines({ api, calendarState, today: '2026-09-04' })).rejects.toThrow('未正确更新');
  });

  it('模板及出行、心愿生成任务带场景标签时保持原排期，普通同名待办仍正常更新', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    for (const task of api.tasks.values()) task.tags = ['寄', '居', '旅'];
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const saveState = async () => undefined;
    await reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-04', saveState });
    await reconcileTickTickWishPreparations({
      api, template, state, configState: { config: { wishes: [futureWish] } }, today: '2026-09-04', saveState,
    });
    const rootId = state.instances[futureTrip.key].rootTaskId!;
    api.tasks.set('new-child', todo(['旅'], { id: 'new-child', projectId: 'play', parentId: rootId }));
    const protectedTasks = structuredClone([...api.tasks.values()]);
    api.tasks.set('ordinary', todo(['寄'], { id: 'ordinary', projectId: 'play', title: api.tasks.get(rootId)!.title }));
    const options = {
      api, calendarState, today: '2026-09-04', excludedTaskIds: getTickTickRoutineExcludedTaskIds(template, state),
    };
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({
      updatedRoutineTasks: 1, routineTaskCounts: { home: 1, school: 0, travel: 0 },
    });
    for (const task of protectedTasks) expect(api.tasks.get(task.id)).toEqual(task);
    expect(api.tasks.get('ordinary')?.dueDate).toBe('2026-09-12T00:00:00+0800');
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({ updatedRoutineTasks: 0 });
  });
});

describe('出行模板改名', () => {
  it.each(['出门todo模版', '出门todo模板', '出行todo模板', '出行todo模版', '出行todo', '出门todo'])('首次连接识别 %s', async (title) => {
    const api = new FakeTickTickApi();
    api.tasks.get('template-root')!.title = title;
    expect((await discoverTickTickTemplate(api)).rootTask.id).toBe('template-root');
  });

  it('优先新名称，新名称重复时明确报错', async () => {
    const api = new FakeTickTickApi();
    api.tasks.set('new-template', { id: 'new-template', projectId: 'play', title: '出门todo模版' });
    expect((await discoverTickTickTemplate(api)).rootTask.id).toBe('new-template');
    api.tasks.set('duplicate', { id: 'duplicate', projectId: 'play', title: '出门todo模板' });
    await expect(discoverTickTickTemplate(api)).rejects.toThrow('找到 2 个同名“出门todo模版”模板');
  });

  it('只按名字查找，不受清单名称、任务标签、父任务或完成状态限制', async () => {
    const api = new FakeTickTickApi();
    vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'life', name: '活' }]);
    for (const task of api.tasks.values()) task.projectId = 'life';
    Object.assign(api.tasks.get('template-root')!, { title: ' 出门todo模板 ', tags: ['不关我事', '活'], status: 2, parentId: 'container' });
    const template = await discoverTickTickTemplate(api);
    expect(template.projectId).toBe('life');
    expect(template.tasks.map((task) => task.id)).toEqual(['template-root', 'template-month', 'template-before', 'template-day']);
  });

  it('收集箱不在清单列表中，也能按名字找到完整模板树', async () => {
    const api = new FakeRoutineTickTickApi();
    for (const task of api.tasks.values()) if (task.id.startsWith('template-')) task.projectId = 'life';
    api.tasks.get('template-root')!.title = '出门todo模板';
    const filter = vi.spyOn(api, 'filterTasks');
    const template = await readConnectedTickTickTemplate(api, { projectId: 'deleted-project', templateRootId: 'deleted-root' });
    expect(filter).toHaveBeenCalledWith(undefined, [0, 2]);
    expect(template.projectId).toBe('life');
    expect(template.tasks.map((task) => task.id)).toEqual(['template-root', 'template-month', 'template-before', 'template-day']);
    expect(template.tasks.find((task) => task.id === 'template-before')?.items).toHaveLength(1);
  });

  it('普通清单和全局筛选都漏掉收集箱时，通过 inbox 入口找到模板而非两个旧模板', async () => {
    const inboxTasks = [
      { id: 'root', projectId: 'inbox-user', title: '出门todo模板', tags: ['不关我事', '活'] },
      { id: 'before', projectId: 'inbox-user', parentId: 'root', title: '出门前一天', items: [{ id: 'pack', title: '随身包', status: 1 }] },
      { id: 'day', projectId: 'inbox-user', parentId: 'root', title: '出门当天', startDate: '2026-11-20T00:00:00+0800' },
    ];
    const oldTasks = ['old-1', 'old-2'].map((id) => ({ id, projectId: 'play', title: '出门todo', status: 2 }));
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      const responses: Record<string, unknown> = {
        '/project': [{ id: 'play', name: '玩' }],
        '/task/filter': oldTasks,
        '/project/play/data': { tasks: oldTasks },
        '/project/inbox/data': { tasks: inboxTasks },
      };
      if (!(path in responses)) throw new Error(`Unexpected request: ${path}`);
      return new Response(JSON.stringify(responses[path]));
    });
    const api = new TickTickOpenApiClient('test-token', 'https://ticktick.test', fetcher);
    const template = await readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'old-1' });
    expect(template.projectId).toBe('inbox-user');
    expect(template.rootTask.id).toBe('root');
    expect(template.tasks).toEqual(inboxTasks);
    expect(template.anchorDate).toBe('2026-11-20');
    expect(fetcher).toHaveBeenCalledWith('https://ticktick.test/project/inbox/data', expect.anything());
  });

  it('收集箱同时出现在筛选结果中时只计算一个模板，保留收集箱完整字段', async () => {
    const api = new FakeTickTickApi();
    for (const task of api.tasks.values()) task.projectId = 'inbox-user';
    api.tasks.get('template-root')!.title = '出门todo模板';
    const getData = vi.spyOn(api, 'getProjectData').mockImplementation(async (projectId) => {
      if (projectId === 'inbox-user') throw new Error('Should use already loaded inbox data');
      return { tasks: projectId === 'inbox' ? [...api.tasks.values()] : [] };
    });
    vi.spyOn(api, 'filterTasks').mockResolvedValue([{ id: 'template-root', projectId: 'inbox-user', title: '出门todo模板' }]);
    const template = await discoverTickTickTemplate(api);
    expect(template.tasks).toHaveLength(4);
    expect(template.rootTask.content).toBe('模板说明');
    expect(getData).not.toHaveBeenCalledWith('inbox-user');
  });

  it('旧 ID 对应任务仍存在但已改为其他名称时，选中新的同名模板', async () => {
    const api = new FakeTickTickApi();
    api.tasks.get('template-root')!.title = '其他任务';
    api.tasks.set('replacement', { id: 'replacement', projectId: 'play', title: '出门todo模板' });
    const template = await readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'template-root' });
    expect(template.rootTask.id).toBe('replacement');
  });

  it('跨清单同名模板不会用旧 ID 消除歧义，也不会把带行程前缀的副本当模板', async () => {
    const api = new FakeTickTickApi();
    api.tasks.get('template-root')!.title = '出门todo模板';
    api.tasks.set('duplicate', { id: 'duplicate', projectId: 'life', title: '出门todo模版' });
    await expect(readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'template-root' })).rejects.toThrow('找到 2 个同名');
    api.tasks.get('template-root')!.title = '东京 · 出门todo模板';
    api.tasks.get('duplicate')!.title = '清迈 · 出门todo模版';
    await expect(discoverTickTickTemplate(api)).rejects.toThrow('未找到');
  });

  it('模板移动并重建后，出行和心愿实例按名称重新关联，保留原清单、任务 ID、完成状态及手动日期', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    let template = await discoverTickTickTemplate(api);
    const originalTemplateTasks = structuredClone(template.tasks);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = async () => {
      await reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-04', legacyProjectId: 'play', saveState: async () => undefined });
      await reconcileTickTickWishPreparations({ api, template, state, configState: { config: { wishes: [futureWish] } }, today: '2026-09-04', legacyProjectId: 'play', saveState: async () => undefined });
    };
    await sync();
    const tripInstance = state.instances[futureTrip.key];
    const wishInstance = state.wishInstances![futureWish.id];
    const tripRoot = tripInstance.rootTaskId;
    const wishRoot = wishInstance.rootTaskId;
    const stageId = tripInstance.taskIdsByTemplateId['template-before'];
    Object.assign(api.tasks.get(stageId)!, { status: 2, startDate: '2026-10-01T09:00:00+0800', dueDate: '2026-10-01T10:00:00+0800' });
    api.tasks.get(stageId)!.items![0].status = 1;
    const previousStage = structuredClone(api.tasks.get(stageId)!);
    const created = api.createCalls;
    delete tripInstance.projectId;
    delete wishInstance.projectId;
    for (const task of originalTemplateTasks) {
      api.tasks.delete(task.id);
      api.tasks.set(`new-${task.id}`, { ...task, id: `new-${task.id}`, projectId: 'life',
        title: task.id === template.rootTask.id ? '出门todo模板' : task.title,
        parentId: task.parentId ? `new-${task.parentId}` : undefined });
    }
    vi.spyOn(api, 'listProjects').mockResolvedValue([{ id: 'play', name: '旧清单' }, { id: 'life', name: '活' }]);
    template = await readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'template-root' });
    expect(template.projectId).toBe('life');
    await sync();
    await sync();
    expect(api.createCalls).toBe(created);
    expect(api.deleteCalls).toBe(0);
    expect(tripInstance.rootTaskId).toBe(tripRoot);
    expect(wishInstance.rootTaskId).toBe(wishRoot);
    expect(tripInstance.taskIdsByTemplateId['new-template-before']).toBe(stageId);
    expect(api.tasks.get(stageId)).toEqual(previousStage);
    expect(tripInstance.projectId).toBe('play');
    expect(wishInstance.projectId).toBe('play');
    expect(api.tasks.get(tripRoot!)?.projectId).toBe('play');
  });

  it.each(['trip', 'wish'] as const)('%s 整树移到其他清单后使用当前清单，保留 ID、手动日期和进度', async kind => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    let template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = () => kind === 'trip'
      ? reconcileTickTickTrips({ api, template, state, trips: [futureTrip], sourceTasks: [...api.tasks.values()], today: '2026-09-04', saveState: async () => undefined })
      : reconcileTickTickWishPreparations({ api, template, state, configState: { config: { wishes: [futureWish] } }, sourceTasks: [...api.tasks.values()], today: '2026-09-04', saveState: async () => undefined });
    await sync();
    const instance = kind === 'trip' ? state.instances[futureTrip.key] : state.wishInstances![futureWish.id];
    const ids = { ...instance.taskIdsByTemplateId };
    const created = api.createCalls;
    for (const id of Object.values(ids)) api.tasks.get(id)!.projectId = 'moved-list';
    const root = api.tasks.get(instance.rootTaskId!)!;
    root.startDate = root.dueDate = '2026-12-03T09:00:00+0800';
    root.status = 2;
    const update = api.updateTask.bind(api);
    vi.spyOn(api, 'updateTask').mockImplementation(async (id, payload) => {
      if (api.tasks.get(id)?.projectId !== payload.projectId) throw new Error('TickTick 404: task not found');
      return update(id, payload);
    });
    const rootRead = vi.spyOn(api, 'getTask');
    await sync();
    expect(rootRead).toHaveBeenCalledWith('moved-list', root.id);
    expect(instance.projectId).toBe('moved-list');
    expect(instance.taskIdsByTemplateId).toEqual(ids);
    expect(api.createCalls).toBe(created);
    expect(api.tasks.get(root.id)).toMatchObject({ projectId: 'moved-list', status: 2, dueDate: '2026-12-03T09:00:00+0800' });
    const templateParent = kind === 'trip' ? template.rootTask.id : 'template-seven-months';
    api.tasks.set('new-template-child', { id: 'new-template-child', projectId: 'play', parentId: templateParent, title: '新增准备事项' });
    template = await discoverTickTickTemplate(api);
    await sync();
    expect(api.createCalls).toBe(created + 1);
    expect(api.tasks.get(instance.taskIdsByTemplateId['new-template-child'])).toMatchObject({ projectId: 'moved-list', parentId: root.id });
    expect(api.deleteCalls).toBe(0);
  });

  it('移动后的根任务补读失败时不猜清单、不复制或更新任务', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = () => reconcileTickTickTrips({ api, template, state, trips: [futureTrip], sourceTasks: [...api.tasks.values()], today: '2026-09-04', saveState: async () => undefined });
    await sync();
    const instance = state.instances[futureTrip.key];
    for (const id of Object.values(instance.taskIdsByTemplateId)) api.tasks.get(id)!.projectId = 'moved-list';
    vi.spyOn(api, 'getTask').mockRejectedValue(new Error('TickTick read unavailable'));
    const before = [api.createCalls, api.updateCalls, api.deleteCalls];
    await expect(sync()).rejects.toThrow('TickTick read unavailable');
    expect([api.createCalls, api.updateCalls, api.deleteCalls]).toEqual(before);
    expect(instance.projectId).toBe('play');
  });

  it('已连接模板改名沿用原任务 ID 和出行、心愿实例', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    let template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = async () => {
      await reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async () => undefined });
      await reconcileTickTickWishPreparations({
        api, template, state, configState: { config: { wishes: [futureWish] } }, today: '2026-09-04', saveState: async () => undefined,
      });
    };
    await sync();
    const tripRoot = state.instances[futureTrip.key].rootTaskId;
    const wishRoot = state.wishInstances![futureWish.id].rootTaskId;
    const created = api.createCalls;
    api.tasks.get('template-root')!.title = '出门todo模版';
    template = await readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'template-root' });
    await sync();
    expect(api.createCalls).toBe(created);
    expect(state.instances[futureTrip.key].rootTaskId).toBe(tripRoot);
    expect(state.wishInstances![futureWish.id].rootTaskId).toBe(wishRoot);
    expect(api.tasks.get(tripRoot!)?.title).toBe('东京 · 出门todo');
    expect(api.tasks.get(wishRoot!)?.title).toBe('东京 · 出门前七个月');
    expect(api.tasks.get('template-root')?.title).toBe('出门todo模版');
  });

  it.each(['出门todo模版', '出门todo模板', '出行todo模板', '出行todo模版'])('%s 生成的根任务统一叫出门todo，阶段和子任务保留原名', async (title) => {
    const api = new FakeTickTickApi();
    api.tasks.get('template-root')!.title = title;
    api.tasks.set('template-child', {
      id: 'template-child', projectId: 'play', parentId: 'template-day', title: '检查模版文件', status: 0,
    });
    const sourceTasks = structuredClone([...api.tasks.values()]);
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    await reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async () => undefined });
    const instance = state.instances[futureTrip.key];
    expect(api.tasks.get(instance.rootTaskId!)?.title).toBe('东京 · 出门todo');
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-day'])?.title).toBe('东京 · 出门当天');
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-child'])?.title).toBe('东京 · 检查模版文件');
    for (const task of sourceTasks) expect(api.tasks.get(task.id)).toEqual(task);
  });

  it.each(['出门todo模版', '出门todo模板', '出行todo模板'])('已生成的“行程 · %s”原地更名，保留完成状态、手动日期和任务 ID', async (oldTitle) => {
    const api = new FakeTickTickApi();
    api.tasks.get('template-root')!.title = '出门todo模板';
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = () => reconcileTickTickTrips({
      api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async () => undefined,
    });
    await sync();
    const instance = state.instances[futureTrip.key];
    const rootId = instance.rootTaskId!;
    const ids = { ...instance.taskIdsByTemplateId };
    Object.assign(api.tasks.get(rootId)!, {
      title: `东京 · ${oldTitle}`, status: 2,
      startDate: '2027-01-08T09:00:00+0800', dueDate: '2027-01-09T18:00:00+0800',
    });
    const before = structuredClone(api.tasks.get(rootId));
    const created = api.createCalls;
    await sync();
    expect(api.tasks.get(rootId)).toEqual({ ...before, title: '东京 · 出门todo' });
    expect(instance.rootTaskId).toBe(rootId);
    expect(instance.taskIdsByTemplateId).toEqual(ids);
    expect(api.createCalls).toBe(created);
    expect(api.deleteCalls).toBe(0);
    await sync();
    expect(api.tasks.get(rootId)).toEqual({ ...before, title: '东京 · 出门todo' });
    expect(api.createCalls).toBe(created);
  });
});

describe('TickTick 出门模板子任务标签', () => {
  const setup = async (kind: string) => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    api.tasks.get('template-root')!.tags = ['不关我事', '玩'];
    api.tasks.get('template-seven-months')!.tags = ['不关我事', 'routine', '旅', '不关我事说明'];
    api.tasks.get('template-visa')!.tags = ['　不关我事　', '证件'];
    api.tasks.get('template-photo')!.tags = ['不关我事'];
    const sourceTasks = structuredClone([...api.tasks.values()]);
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const options = { api, template, state, today: '2026-09-04', saveState: async () => undefined };
    const sync = () => kind === '出游'
      ? reconcileTickTickTrips({ ...options, trips: [futureTrip] })
      : reconcileTickTickWishPreparations({ ...options, configState: { config: { wishes: [futureWish] } } });
    await sync();
    const instance = kind === '出游' ? state.instances[futureTrip.key] : state.wishInstances![futureWish.id];
    return { api, sourceTasks, instance, sync };
  };

  it.each(['出游', '心愿'])('%s 新副本的阶段及各级后代去掉不关我事，保留其他标签和原模板', async (kind) => {
    const { api, sourceTasks, instance } = await setup(kind);
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-seven-months'])?.tags)
      .toEqual(['routine', '旅', '不关我事说明', '当天']);
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-visa'])?.tags).toEqual(['证件', '当天']);
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-photo'])?.tags).toEqual(['当天']);
    if (kind === '出游') {
      expect(api.tasks.get(instance.rootTaskId!)?.tags).toEqual(['不关我事', '玩', '当天']);
      expect(api.tasks.get(instance.taskIdsByTemplateId['template-day'])?.tags).toEqual(['当天']);
    }
    for (const task of sourceTasks) expect(api.tasks.get(task.id)).toEqual(task);
  });

  it.each(['出游', '心愿'])('%s 旧副本同步清理标签，保留手动标签、日期、进度和任务 ID', async (kind) => {
    const { api, sourceTasks, instance, sync } = await setup(kind);
    const ids = { ...instance.taskIdsByTemplateId };
    const stage = api.tasks.get(ids['template-seven-months'])!;
    // Removing routine from an instance must not copy it back from the template.
    stage.tags = ['不关我事', '手动标签', 'hidden'];
    const visa = api.tasks.get(ids['template-visa'])!;
    Object.assign(visa, {
      tags: ['routine', '　不关我事　', '自己的标签'], status: 2,
      completedTime: '2026-09-05T01:00:00Z',
      startDate: '2026-09-05T09:00:00+0800', dueDate: '2026-09-05T10:00:00+0800', isAllDay: false,
    });
    api.tasks.get(ids['template-photo'])!.tags = ['不关我事'];
    const before = structuredClone(visa);
    const unrelated: TickTickTask = { id: 'manual-child', projectId: 'play', parentId: stage.id, title: '手动子任务', tags: ['不关我事'] };
    api.tasks.set(unrelated.id, structuredClone(unrelated));
    const created = api.createCalls;

    for (let run = 0; run < 2; run++) {
      await sync();
      expect(api.tasks.get(stage.id)?.tags).toEqual(['手动标签', 'hidden', '当天']);
      expect(api.tasks.get(visa.id)).toEqual({ ...before, tags: ['routine', '自己的标签', '当天'] });
      expect(api.tasks.get(ids['template-photo'])?.tags).toEqual(['当天']);
      expect(api.tasks.get(unrelated.id)).toEqual(unrelated);
      expect(instance.taskIdsByTemplateId).toEqual(ids);
      expect(api.createCalls).toBe(created);
      expect(api.deleteCalls).toBe(0);
      for (const task of sourceTasks) expect(api.tasks.get(task.id)).toEqual(task);
    }
  });
});

describe('TickTick 心愿七个月准备', () => {
  it('只接收有日期、名称且启用的未关联心愿，按七个自然月回退并钳制月末', () => {
    const sources = buildWishPreparationSourcesFromSyncState({ config: { wishes: [
      futureWish,
      { ...futureWish, id: 'leap', deadline: '2028-09-30' },
      { ...futureWish, id: 'year-boundary', deadline: '2027-01-31' },
      { ...futureWish, id: 'inactive', isActive: false },
      { ...futureWish, id: 'linked', linkedTripStartDate: '2027-09-30' },
      { ...futureWish, id: 'wish_trip_2027-09-30', name: '退课截止' },
      { ...futureWish, id: 'undated', deadline: null },
      { ...futureWish, id: 'invalid', deadline: '2027-02-30' },
      { ...futureWish, id: 'unnamed', name: ' ' },
      { ...futureWish, id: '' },
      null,
    ] } });
    expect(sources.map(({ key, startDate, endDate }) => ({ key, startDate, endDate }))).toEqual([
      { key: 'wish-tokyo', startDate: '2027-02-28', endDate: '2027-09-30' },
      { key: 'leap', startDate: '2028-02-29', endDate: '2028-09-30' },
      { key: 'year-boundary', startDate: '2026-06-30', endDate: '2027-01-31' },
    ]);
    expect(buildWishPreparationSourcesFromSyncState(null)).toEqual([]);
  });

  it('只复制七个月阶段及所有后代，后代日期一致且每个任务带心愿名', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const result = await reconcileTickTickWishPreparations({
      api, template, state, configState: { config: { wishes: [futureWish] } }, today: '2026-09-04', saveState: async () => undefined,
    });
    expect(result).toMatchObject({ createdWishPreparations: 1, activeWishPreparations: 1 });
    expect(api.createCalls).toBe(3);
    expect(state.instances).toEqual({});
    const instance = state.wishInstances![futureWish.id];
    const root = api.tasks.get(instance.rootTaskId!)!;
    const visa = api.tasks.get(instance.taskIdsByTemplateId['template-visa'])!;
    const photo = api.tasks.get(instance.taskIdsByTemplateId['template-photo'])!;
    expect(root).toMatchObject({ title: '东京 · 出门前七个月', dueDate: '2027-02-28T00:00:00+0800', status: 0 });
    expect(root.parentId).toBeUndefined();
    expect(root.items?.[0]).toMatchObject({ title: '查签证', status: 0, startDate: '2027-03-01T09:00:00+0800' });
    expect(visa).toMatchObject({
      title: '东京 · 办签证', parentId: root.id, isAllDay: true,
      startDate: '2027-02-28T00:00:00+0800', dueDate: '2027-02-28T00:00:00+0800',
    });
    expect(photo).toMatchObject({ title: '东京 · 准备证件照', parentId: visa.id });
    expect(photo.dueDate).toBe('2027-02-28T00:00:00+0800');
    expect(instance.taskIdsByTemplateId['template-root']).toBeUndefined();
    expect(instance.taskIdsByTemplateId['template-month']).toBeUndefined();
    expect(api.tasks.get('template-seven-months')?.status).toBe(2);
  });

  it('重启后按心愿 ID 更新改名、改期，保留完成状态和手工清单项，不误合并同日心愿', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    const saveState = async () => undefined;
    const sync = (wishes: unknown[]) => reconcileTickTickWishPreparations({
      api, template, state, configState: { config: { wishes } }, today: '2026-09-04', saveState,
    });
    await sync([futureWish]);
    state = JSON.parse(JSON.stringify(state));
    const rootId = state.wishInstances![futureWish.id].rootTaskId!;
    const root = api.tasks.get(rootId)!;
    root.status = 2;
    root.items![0].status = 1;
    root.items!.push({ id: 'manual-check', title: '临时补充', status: 1 });
    const changed = { ...futureWish, name: '京都', deadline: '2027-10-31' };
    await sync([changed, { ...changed, id: 'another-wish' }]);
    await sync([changed, { ...changed, id: 'another-wish' }]);
    expect(api.createCalls).toBe(6);
    expect(state.wishInstances![futureWish.id].rootTaskId).toBe(rootId);
    expect(state.wishInstances!['another-wish'].rootTaskId).not.toBe(rootId);
    expect(api.tasks.get(rootId)).toMatchObject({ title: '京都 · 出门前七个月', status: 2, dueDate: '2027-03-31T00:00:00+0800' });
    expect(api.tasks.get(rootId)?.items?.map((item) => [item.title, item.status])).toEqual([['查签证', 1], ['临时补充', 1]]);
  });

  it('不同心愿不能按相同准备日期接管旧副本', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = (id: string) => reconcileTickTickWishPreparations({
      api, template, state, configState: { config: { wishes: [{ ...futureWish, id }] } }, today: '2026-09-04', saveState: async () => undefined,
    });
    await sync('first');
    const firstRoot = state.wishInstances!.first.rootTaskId!;
    await sync('second');
    expect(state.wishInstances!.first).toBeUndefined();
    expect(state.wishInstances!.second.rootTaskId).not.toBe(firstRoot);
    expect(api.tasks.has(firstRoot)).toBe(false);
  });

  it('准备日已过仍生成未到期心愿；到期后改期仍复用原副本', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = (deadline: string, today: string) => reconcileTickTickWishPreparations({
      api, template, state, configState: { config: { wishes: [{ ...futureWish, deadline }] } }, today, saveState: async () => undefined,
    });
    await sync('2027-01-10', '2026-09-04');
    const rootId = state.wishInstances![futureWish.id].rootTaskId!;
    expect(api.tasks.get(rootId)?.dueDate).toBe('2026-06-10T00:00:00+0800');
    await sync('2027-10-10', '2027-02-10');
    expect(state.wishInstances![futureWish.id].rootTaskId).toBe(rootId);
    expect(api.createCalls).toBe(3);
  });

  it('关联出游后清理心愿副本，完整日历任务保持独立', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const saveState = async () => undefined;
    const options = { api, template, state, today: '2026-09-04', saveState };
    await reconcileTickTickWishPreparations({ ...options, configState: { config: { wishes: [futureWish] } } });
    const wishTaskIds = Object.values(state.wishInstances![futureWish.id].taskIdsByTemplateId);
    await reconcileTickTickTrips({ ...options, trips: [futureTrip] });
    const fullRootId = state.instances[futureTrip.key].rootTaskId!;
    await reconcileTickTickWishPreparations({ ...options, configState: { config: { wishes: [{ ...futureWish, linkedTripStartDate: futureTrip.startDate }] } } });
    expect(state.wishInstances).toEqual({});
    expect(wishTaskIds.some((id) => api.tasks.has(id))).toBe(false);
    expect(api.tasks.has(fullRootId)).toBe(true);
    expect(Object.keys(state.instances[futureTrip.key].taskIdsByTemplateId)).toHaveLength(7);
  });

  it('七个月模板缺失或不唯一时明确报错，不退回六个月或复制整套任务', async () => {
    const api = new FakeTickTickApi();
    api.tasks.set('template-six', { id: 'template-six', projectId: 'play', parentId: 'template-root', title: '出门前六个月' });
    const state: TickTickTripSyncState = { instances: {} };
    const options = { api, state, today: '2026-09-04', configState: { config: { wishes: [futureWish] } }, saveState: async () => undefined };
    await expect(reconcileTickTickWishPreparations({ ...options, template: await discoverTickTickTemplate(api) })).rejects.toThrow('出门前七个月');
    addWishPreparationTemplate(api);
    api.tasks.set('duplicate-seven', { id: 'duplicate-seven', projectId: 'play', parentId: 'template-root', title: '出门前7个月' });
    await expect(reconcileTickTickWishPreparations({ ...options, template: await discoverTickTickTemplate(api) })).rejects.toThrow('唯一');
    expect(api.createCalls).toBe(0);
  });

  it.each(['deleted', 'inactive', 'undated'])('心愿 %s 后只清理独立副本，不再要求七个月模板', async (change) => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const options = { api, state, today: '2026-09-04', saveState: async () => undefined };
    await reconcileTickTickWishPreparations({
      ...options, template: await discoverTickTickTemplate(api), configState: { config: { wishes: [futureWish] } },
    });
    const wishIds = Object.values(state.wishInstances![futureWish.id].taskIdsByTemplateId);
    api.tasks.delete('template-seven-months');
    const wishes = change === 'deleted' ? [] : [{ ...futureWish, ...(change === 'inactive' ? { isActive: false } : { deadline: null }) }];
    const result = await reconcileTickTickWishPreparations({
      ...options, template: await discoverTickTickTemplate(api), configState: { config: { wishes } },
    });
    expect(result.deletedWishPreparations).toBe(1);
    expect(state.wishInstances).toEqual({});
    expect(wishIds.some((id) => api.tasks.has(id))).toBe(false);
    expect(api.tasks.has('template-root')).toBe(true);
  });

  it('无心愿或截止日已过时不生成，也不要求七个月模板', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const options = { api, template, state, today: '2026-09-04', saveState: async () => undefined };
    await reconcileTickTickWishPreparations({ ...options, configState: null });
    const result = await reconcileTickTickWishPreparations({ ...options, configState: { config: { wishes: [{ ...futureWish, deadline: '2026-09-03' }] } } });
    expect(result.activeWishPreparations).toBe(0);
    expect(api.createCalls).toBe(0);
    expect(api.updateCalls).toBe(0);
    expect(api.deleteCalls).toBe(0);
  });

  it('兼容数字七个月标题及无日期的阶段根任务', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const root = api.tasks.get('template-seven-months')!;
    root.title = '出门前 7 个月';
    delete root.startDate;
    delete root.dueDate;
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    await reconcileTickTickWishPreparations({ api, template, state, today: '2026-09-04', configState: { config: { wishes: [futureWish] } }, saveState: async () => undefined });
    const instance = state.wishInstances![futureWish.id];
    expect(api.tasks.get(instance.rootTaskId!)?.dueDate).toBe('2027-02-28T00:00:00+0800');
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-visa'])?.startDate).toBe('2027-02-28T00:00:00+0800');
  });
});

describe('TickTick 手动改期优先', () => {
  it.each(['wish', 'trip'].flatMap((source) => [false, true].flatMap((legacy) =>
    ['moved', 'cleared', 'time-only'].map((change) => ({ source, legacy, change })),
  )))('$source 子任务 $change 后独立保留日期，后代跟随且同级仍自动排期（旧记录：$legacy）', async ({ source, legacy, change }) => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    api.tasks.set('template-flight', {
      id: 'template-flight', projectId: 'play', parentId: 'template-seven-months', title: '查机票',
    });
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    const wish = { ...futureWish, deadline: '2027-02-21' };
    const trip = { ...futureTrip, key: '2027-02-21', startDate: '2027-02-21', endDate: '2027-02-23', dates: ['2027-02-21', '2027-02-22', '2027-02-23'] };
    const sync = () => source === 'wish'
      ? reconcileTickTickWishPreparations({ api, template, state, configState: { config: { wishes: [wish] } }, today: '2026-09-29', saveState: async () => undefined })
      : reconcileTickTickTrips({ api, template, state, trips: [trip], today: '2026-09-29', saveState: async () => undefined });
    const instance = () => source === 'wish' ? state.wishInstances![wish.id] : state.instances[trip.key];
    await sync();
    const ids = { ...instance().taskIdsByTemplateId };
    const childId = ids['template-visa'];
    const child = api.tasks.get(childId)!;
    expect(child.dueDate).toBe('2026-07-21T00:00:00+0800');
    if (legacy) delete instance().taskDateStates;
    if (change === 'cleared') {
      delete child.startDate;
      delete child.dueDate;
    } else {
      const day = change === 'moved' ? '2026-10-08' : '2026-07-21';
      Object.assign(child, { startDate: `${day}T09:00:00+0800`, dueDate: `${day}T10:00:00+0800`, isAllDay: false });
    }
    Object.assign(child, { status: 2, completedTime: '2026-09-28T01:00:00Z' });
    const expected = { startDate: child.startDate, dueDate: child.dueDate, isAllDay: child.isAllDay };
    await sync();
    for (const field of ['startDate', 'dueDate', 'isAllDay'] as const) {
      expect(api.tasks.get(childId)?.[field]).toBe(expected[field]);
    }
    state = JSON.parse(JSON.stringify(state));
    await sync();
    const parentDate = '2026-09-30T00:00:00+0800';
    Object.assign(api.tasks.get(ids['template-seven-months'])!, { startDate: parentDate, dueDate: parentDate });
    await sync();
    expect(api.tasks.get(childId)).toMatchObject({ status: 2, completedTime: child.completedTime });
    for (const field of ['startDate', 'dueDate', 'isAllDay'] as const) {
      expect(api.tasks.get(childId)?.[field]).toBe(expected[field]);
    }
    for (const field of ['startDate', 'dueDate', 'isAllDay', 'timeZone']) {
      expect(api.updatePayloads.get(childId)).not.toHaveProperty(field);
    }
    expect(api.tasks.get(ids['template-photo'])).toMatchObject({
      startDate: expected.startDate ?? null, dueDate: expected.dueDate ?? null, isAllDay: expected.isAllDay,
    });
    expect(api.tasks.get(ids['template-flight'])).toMatchObject({ startDate: parentDate, dueDate: parentDate });
    expect(instance().taskDateStates![childId].manual).toBe(true);
    expect(instance().taskDateStates![ids['template-photo']].manual).toBe(false);
    expect(instance().taskDateStates![ids['template-flight']].manual).toBe(false);
    expect(instance().taskIdsByTemplateId).toEqual(ids);
    expect(api.createCalls).toBe(Object.keys(ids).length);
  });

  it.each([false, true])('北海道七个月准备手动推到三个月前，多次同步和重启仍保留（旧记录：%s）', async (legacy) => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    const wish = { ...futureWish, name: '北海道', deadline: '2027-02-01' };
    const sync = (currentWish = wish) => reconcileTickTickWishPreparations({
      api, template, state, configState: { config: { wishes: [currentWish] } },
      today: '2026-09-04', saveState: async () => undefined,
    });
    await sync();
    const instance = state.wishInstances![wish.id];
    const rootId = instance.rootTaskId!;
    expect(api.tasks.get(rootId)?.dueDate).toBe('2026-07-01T00:00:00+0800');
    if (legacy) {
      delete instance.taskDateStates;
      delete instance.checklistDateStates;
    }
    Object.assign(api.tasks.get(rootId)!, {
      startDate: '2026-11-01T00:00:00+0800', dueDate: '2026-11-01T00:00:00+0800',
    });
    await sync();
    state = JSON.parse(JSON.stringify(state));
    await sync();
    await sync({ ...wish, name: '北海道冬游', deadline: '2027-03-01' });
    expect(api.tasks.get(rootId)).toMatchObject({
      title: '北海道冬游 · 出门前七个月',
      startDate: '2026-11-01T00:00:00+0800', dueDate: '2026-11-01T00:00:00+0800',
    });
    expect(api.updatePayloads.get(rootId)).not.toHaveProperty('dueDate');
    // 后代跟随母任务手动调整后的日期。
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-visa'])?.dueDate).toBe('2026-11-01T00:00:00+0800');
    expect(state.wishInstances![wish.id].taskDateStates?.[rootId].manual).toBe(true);
    expect(api.createCalls).toBe(3);
  });

  it.each([false, true])('日历出游保留手动改期和清空日期，未改任务仍跟随行程（旧记录：%s）', async (legacy) => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = (trip = futureTrip) => reconcileTickTickTrips({
      api, template, state, trips: [trip], today: '2026-09-04', saveState: async () => undefined,
    });
    await sync();
    const instance = state.instances[futureTrip.key];
    const beforeId = instance.taskIdsByTemplateId['template-before'];
    const monthId = instance.taskIdsByTemplateId['template-month'];
    if (legacy) {
      delete instance.taskDateStates;
      delete instance.checklistDateStates;
    }
    Object.assign(api.tasks.get(beforeId)!, {
      startDate: '2027-01-05T09:00:00+0800', dueDate: '2027-01-05T10:00:00+0800', isAllDay: false,
    });
    delete api.tasks.get(monthId)!.startDate;
    delete api.tasks.get(monthId)!.dueDate;
    const changed = { ...futureTrip, key: '2027-01-09', startDate: '2027-01-09', dates: ['2027-01-09', ...futureTrip.dates], name: '京都' };
    await sync(changed);
    await sync(changed);
    expect(api.tasks.get(beforeId)).toMatchObject({
      title: '京都 · 出门前一天', startDate: '2027-01-05T09:00:00+0800', dueDate: '2027-01-05T10:00:00+0800', isAllDay: false,
    });
    expect(api.tasks.get(monthId)?.startDate).toBeUndefined();
    expect(api.tasks.get(monthId)?.dueDate).toBeUndefined();
    expect(api.updatePayloads.get(monthId)).not.toHaveProperty('startDate');
    expect(api.updatePayloads.get(monthId)).not.toHaveProperty('dueDate');
    expect(api.tasks.get(instance.rootTaskId!)?.dueDate).toBe('2027-01-09T00:00:00+0800');
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-day'])?.dueDate).toBe('2027-01-09T00:00:00+0800');
    expect(instance.taskDateStates?.[instance.rootTaskId!].manual).toBe(false);
  });

  it.each(['moved', 'cleared', 'time-only'])('清单项 %s 后保持手动日期及完成记录，其他项照常平移', async (change) => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    api.tasks.get('template-seven-months')!.items!.push({
      id: 'template-auto-item', title: '自动项', startDate: '2026-04-22T09:00:00+0800', status: 0,
    });
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    const sync = (deadline = futureWish.deadline) => reconcileTickTickWishPreparations({
      api, template, state, configState: { config: { wishes: [{ ...futureWish, deadline }] } },
      today: '2026-09-04', saveState: async () => undefined,
    });
    await sync();
    const instance = state.wishInstances![futureWish.id];
    // 覆盖升级前已存在、没有日期快照的 checklist。
    delete instance.taskDateStates;
    delete instance.checklistDateStates;
    const rootId = instance.rootTaskId!;
    const item = api.tasks.get(rootId)!.items![0];
    item.status = 1;
    item.completedTime = '2026-09-04T01:00:00Z';
    if (change === 'cleared') delete item.startDate;
    else item.startDate = change === 'moved' ? '2027-07-01T09:00:00+0800' : '2027-03-01T15:00:00+0800';
    item.isAllDay = false;
    const manualDate = item.startDate;
    await sync('2027-10-31');
    state = JSON.parse(JSON.stringify(state));
    await sync('2027-10-31');
    const saved = api.tasks.get(rootId)!.items!;
    expect(saved[0]).toMatchObject({ id: item.id, status: 1, completedTime: item.completedTime, isAllDay: false });
    expect(saved[0].startDate).toBe(manualDate);
    expect(saved[1].startDate).toBe('2027-04-02T09:00:00+0800');
    expect(state.wishInstances![futureWish.id].checklistDateStates?.[rootId][item.id!].manual).toBe(true);
  });

  it('UTC 与 +0800 等价响应不会被误判为手动改期', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = (trip = futureTrip) => reconcileTickTickTrips({
      api, template, state, trips: [trip], today: '2026-09-04', saveState: async () => undefined,
    });
    await sync();
    const instance = state.instances[futureTrip.key];
    for (const taskId of Object.values(instance.taskIdsByTemplateId)) {
      const task = api.tasks.get(taskId)!;
      for (const key of ['startDate', 'dueDate'] as const) if (task[key]) task[key] = new Date(task[key]!).toISOString();
    }
    await sync({ ...futureTrip, key: '2027-01-09', startDate: '2027-01-09', dates: ['2027-01-09', ...futureTrip.dates] });
    expect(api.tasks.get(instance.rootTaskId!)?.dueDate).toBe('2027-01-09T00:00:00+0800');
    expect(Object.values(instance.taskDateStates!).every((entry) => !entry.manual)).toBe(true);
  });

  it('简略写入响应仍保存完整日期及清单 ID，不误锁定后续自动改期', async () => {
    const api = new FakeTickTickApi();
    const create = api.createTask.bind(api);
    const update = api.updateTask.bind(api);
    api.createTask = async (payload) => {
      const task = await create(payload);
      return { id: task.id, projectId: task.projectId, title: task.title, items: [] };
    };
    api.updateTask = async (id, payload) => {
      const task = await update(id, payload);
      return { id: task.id, projectId: task.projectId, title: task.title };
    };
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = (trip = futureTrip) => reconcileTickTickTrips({
      api, template, state, trips: [trip], today: '2026-09-04', saveState: async () => undefined,
    });
    await sync();
    const instance = state.instances[futureTrip.key];
    expect(instance.itemIdsByTemplateTaskId['template-before']['template-pack']).toBeTruthy();
    await sync();
    await sync({ ...futureTrip, key: '2027-01-09', startDate: '2027-01-09', dates: ['2027-01-09', ...futureTrip.dates] });
    expect(api.tasks.get(instance.rootTaskId!)?.dueDate).toBe('2027-01-09T00:00:00+0800');
    expect(Object.values(instance.taskDateStates!).every((entry) => !entry.manual)).toBe(true);
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-before'])?.items).toHaveLength(1);
  });

  it('任务删除后重建不继承旧 ID 的手动日期设置', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = () => reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async () => undefined });
    await sync();
    const instance = state.instances[futureTrip.key];
    const oldId = instance.taskIdsByTemplateId['template-before'];
    api.tasks.get(oldId)!.dueDate = '2027-01-03T00:00:00+0800';
    await sync();
    expect(instance.taskDateStates?.[oldId].manual).toBe(true);
    api.tasks.delete(oldId);
    await sync();
    const newId = instance.taskIdsByTemplateId['template-before'];
    expect(newId).not.toBe(oldId);
    expect(instance.taskDateStates?.[oldId]).toBeUndefined();
    expect(instance.checklistDateStates?.[oldId]).toBeUndefined();
    expect(instance.taskDateStates?.[newId].manual).toBe(false);
    expect(api.tasks.get(newId)?.dueDate).toBe('2027-01-09T00:00:00+0800');
  });

  it('简略创建响应后的补读失败，重启续传不重复生成任务或清单项', async () => {
    const api = new FakeTickTickApi();
    const create = api.createTask.bind(api);
    const get = api.getTask.bind(api);
    api.createTask = async (payload) => {
      const task = await create(payload);
      return { id: task.id, projectId: task.projectId, title: task.title };
    };
    api.getTask = async (projectId, taskId) => {
      if (taskId.startsWith('generated-')) throw new Error('临时网络错误');
      return get(projectId, taskId);
    };
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    let persisted = structuredClone(state);
    const sync = () => reconcileTickTickTrips({
      api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async (next) => { persisted = structuredClone(next); },
    });
    await expect(sync()).rejects.toThrow('临时网络错误');
    state = persisted;
    api.getTask = get;
    await sync();
    await sync();
    const instance = state.instances[futureTrip.key];
    expect(api.createCalls).toBe(4);
    expect(api.tasks.get(instance.taskIdsByTemplateId['template-before'])?.items).toHaveLength(1);
  });

  it('模板改名影响自动日期，模板日期不影响排期，移除清单项不变成手工新增项', async () => {
    const api = new FakeTickTickApi();
    let template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = () => reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async () => undefined });
    await sync();
    const instance = state.instances[futureTrip.key];
    const beforeId = instance.taskIdsByTemplateId['template-before'];
    api.tasks.get(beforeId)!.items!.push({ id: 'manual-extra', title: '手工新增', status: 0 });
    const beforeTemplate = api.tasks.get('template-before')!;
    beforeTemplate.startDate = '2026-11-18T00:00:00+0800';
    beforeTemplate.dueDate = beforeTemplate.startDate;
    beforeTemplate.items = [];
    template = await discoverTickTickTemplate(api);
    await sync();
    expect(api.tasks.get(beforeId)?.dueDate).toBe('2027-01-09T00:00:00+0800');
    beforeTemplate.title = '出门前两天';
    template = await discoverTickTickTemplate(api);
    await sync();
    expect(api.tasks.get(beforeId)?.dueDate).toBe('2027-01-08T00:00:00+0800');
    expect(api.tasks.get(beforeId)?.items?.map((item) => item.id)).toEqual(['manual-extra']);
    expect(instance.taskDateStates?.[beforeId].manual).toBe(false);
  });
});

describe('TickTick 清单状态续写', () => {
  it.each(['trip', 'wish'] as const)('%s 保留已有和手工清单项的完成情况，不再透传非 0/1 状态', async (scope) => {
    const api = new FakeTickTickApi();
    if (scope === 'wish') addWishPreparationTemplate(api);
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const options = { api, template, state, today: '2026-09-04', saveState: async () => undefined };
    const sync = () => scope === 'trip'
      ? reconcileTickTickTrips({ ...options, trips: [futureTrip] })
      : reconcileTickTickWishPreparations({ ...options, configState: { config: { wishes: [futureWish] } } });
    await sync();
    const instance = scope === 'trip' ? state.instances[futureTrip.key] : state.wishInstances![futureWish.id];
    const taskId = instance.taskIdsByTemplateId[scope === 'trip' ? 'template-before' : 'template-seven-months'];
    const task = api.tasks.get(taskId)!;
    task.items![0].status = 2;
    task.items![0].completedTime = '2026-09-03T01:00:00Z';
    task.items!.push(
      { id: 'manual-done', title: '手工已完成', status: '1', completedTime: '2026-09-03T02:00:00Z' },
      { id: 'manual-open', title: '手工未完成', status: null },
    );
    const ids = task.items!.map((item) => item.id);
    await sync();
    const updated = api.tasks.get(taskId)!;
    expect(updated.items?.map((item) => item.status)).toEqual([1, 1, 0]);
    expect(updated.items?.map((item) => item.id)).toEqual(ids);
    expect(updated.items?.map((item) => item.completedTime)).toEqual([
      '2026-09-03T01:00:00Z', '2026-09-03T02:00:00Z', undefined,
    ]);
  });
});

describe('TickTick 出游同步', () => {
  it('已完成阶段从列表消失后按原 ID 补读，同步经过草稿仍保留进度且不重复创建', async () => {
    const api = new FakeTickTickApi();
    api.tasks.get('template-month')!.items = [{ id: 'booking', title: '订票', status: 0 }];
    const template = await discoverTickTickTemplate(api), state: TickTickTripSyncState = { instances: {} };
    const saveState = async () => undefined;
    await reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-11-10', saveState });
    const id = state.instances[futureTrip.key].taskIdsByTemplateId['template-month'];
    const completed = api.tasks.get(id)!;
    completed.status = 2; completed.completedTime = '2026-09-04T01:30:51+0800'; completed.items![0].status = 1;
    const original = structuredClone(completed), ids = [...api.tasks.keys()];
    const draft = new RuleTaskDraft(api, [...api.tasks.values()].filter(task => task.id !== id));
    const branch = draft.branch('trips');
    await reconcileTickTickTrips({ api: branch.api, template, state, sourceTasks: draft.values(),
      trips: [{ ...futureTrip, name: '大阪' }], today: '2026-11-10', saveState });
    branch.accept();
    expect(api.tasks.get(id)).toEqual(original);
    await draft.commit();
    expect(api.tasks.get(id)).toMatchObject({ title: '大阪 · 出门前一个月', status: 2,
      completedTime: original.completedTime, startDate: original.startDate, dueDate: original.dueDate, items: original.items });
    expect([...api.tasks.keys()]).toEqual(ids); expect(api.createCalls).toBe(4);
  });

  it.each([false, true])('旧版模板日期偏移迁移到名称排期，保留完成状态（有快照：%s）', async (snapshots) => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    const trip = { ...futureTrip, startDate: '2027-03-10', endDate: '2027-03-11', dates: ['2027-03-10'] };
    const sync = () => reconcileTickTickTrips({ api, template, state, trips: [trip], today: '2026-09-09', saveState: async () => undefined });
    await sync();
    const instance = state.instances[trip.key];
    const id = instance.taskIdsByTemplateId['template-month'];
    // Old scheduling moved this template 31 days before departure.
    Object.assign(api.tasks.get(id)!, { startDate: '2027-02-07T00:00:00+0800', dueDate: '2027-02-07T00:00:00+0800', status: 2 });
    if (snapshots) {
      Object.assign(instance.taskDateStates![id].lastSynced, { startDate: '2027-02-07T00:00:00+0800', dueDate: '2027-02-07T00:00:00+0800' });
    } else delete instance.taskDateStates;
    state = JSON.parse(JSON.stringify(state));
    await sync();
    expect(api.tasks.get(id)).toMatchObject({ startDate: '2027-02-10T00:00:00+0800', dueDate: '2027-02-10T00:00:00+0800', status: 2 });
    expect(api.createCalls).toBe(4);
  });

  it('心愿模板全树不带日期、不包含出门当天，也能生成七个月准备及后代', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    api.tasks.delete('template-day');
    for (const task of api.tasks.values()) {
      delete task.startDate;
      delete task.dueDate;
      for (const item of task.items ?? []) delete item.startDate;
    }
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    await reconcileTickTickWishPreparations({ api, template, state, configState: { config: { wishes: [futureWish] } }, today: '2026-09-09', saveState: async () => undefined });
    for (const id of Object.values(state.wishInstances![futureWish.id].taskIdsByTemplateId)) {
      expect(api.tasks.get(id)).toMatchObject({ startDate: '2027-02-28T00:00:00+0800', dueDate: '2027-02-28T00:00:00+0800' });
    }
  });

  it.each([
    ['出门当天', '2028-03-31'],
    ['出门前一天', '2028-03-30'],
    ['出门前 ３ 天', '2028-03-28'],
    ['出门前两周', '2028-03-17'],
    ['出门前一个星期', '2028-03-24'],
    ['出门前一个月', '2028-02-29'],
    ['出门前七个月', '2027-08-31'],
    ['出门前十二个月', '2027-03-31'],
    ['出门前一年', '2027-03-31'],
    ['出门前半年', '2027-09-30'],
    ['出门前半个月', '2028-03-16'],
    ['出门后两天', '2028-04-02'],
  ])('无日期模板按一级名称 %s 排期，多层子任务同日', async (title, expected) => {
    const api = new FakeTickTickApi();
    for (const task of api.tasks.values()) {
      delete task.startDate;
      delete task.dueDate;
    }
    api.tasks.delete('template-day');
    api.tasks.get('template-month')!.title = title;
    api.tasks.set('child', {
      id: 'child', projectId: 'play', parentId: 'template-month', title: 'googleflight',
      startDate: '2025-01-01T08:00:00+0800', dueDate: '2025-01-02T09:00:00+0800', isAllDay: false,
    });
    api.tasks.set('grandchild', {
      id: 'grandchild', projectId: 'play', parentId: 'child', title: '出门前一天',
    });
    const originals = structuredClone([...api.tasks.values()]);
    const discovered = await discoverTickTickTemplate(api);
    expect(discovered.anchorDate).toBeUndefined();
    const template = await readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'template-root' });
    const state: TickTickTripSyncState = { instances: {} };
    const trip = { ...futureTrip, startDate: '2028-03-31', endDate: '2028-04-02', dates: ['2028-03-31'] };
    const sync = () => reconcileTickTickTrips({ api, template, state, trips: [trip], today: '2026-09-09', saveState: async () => undefined });
    await sync();
    await sync();
    for (const id of ['template-month', 'child', 'grandchild']) {
      const task = api.tasks.get(state.instances[trip.key].taskIdsByTemplateId[id]);
      expect(task).toMatchObject({ startDate: `${expected}T00:00:00+0800`, dueDate: `${expected}T00:00:00+0800`, isAllDay: true });
    }
    for (const original of originals) expect(api.tasks.get(original.id)).toEqual(original);
  });

  it('一级母任务手动改期或清空后，各层子任务同步跟随，重启后仍一致', async () => {
    const api = new FakeTickTickApi();
    api.tasks.set('child', { id: 'child', projectId: 'play', parentId: 'template-month', title: '机票' });
    api.tasks.set('grandchild', { id: 'grandchild', projectId: 'play', parentId: 'child', title: '比价' });
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    const sync = () => reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-09', saveState: async () => undefined });
    await sync();
    const ids = state.instances[futureTrip.key].taskIdsByTemplateId;
    const parent = api.tasks.get(ids['template-month'])!;
    Object.assign(parent, { startDate: '2026-12-05T08:00:00+0800', dueDate: '2026-12-06T18:00:00+0800', isAllDay: false });
    await sync();
    for (const id of ['child', 'grandchild']) {
      expect(api.tasks.get(ids[id])).toMatchObject({ startDate: parent.startDate, dueDate: parent.dueDate, isAllDay: false });
    }
    delete parent.startDate;
    delete parent.dueDate;
    state = JSON.parse(JSON.stringify(state));
    // The fake API replaces the saved object during update; clear the current record too.
    delete api.tasks.get(ids['template-month'])!.startDate;
    delete api.tasks.get(ids['template-month'])!.dueDate;
    await sync();
    for (const id of ['child', 'grandchild']) {
      expect(api.updatePayloads.get(ids[id])).toMatchObject({ startDate: null, dueDate: null });
    }
    state = JSON.parse(JSON.stringify(state));
    await sync();
    expect(api.tasks.get(ids.grandchild)?.dueDate).toBeNull();
  });

  it('无法识别的一级时间名称明确报错，不写入部分任务', async () => {
    const api = new FakeTickTickApi();
    api.tasks.get('template-month')!.title = '出门前若干天';
    const template = await discoverTickTickTemplate(api);
    await expect(reconcileTickTickTrips({ api, template, state: { instances: {} }, trips: [futureTrip], today: '2026-09-09', saveState: async () => undefined }))
      .rejects.toThrow('出门前若干天');
    expect(api.createCalls).toBe(0);
  });

  it.each(['wish', 'trip'])('七个月阶段子任务补齐旧自动日期，后续手动清空保持无日期（%s）', async (source) => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const stage = api.tasks.get('template-seven-months')!;
    delete stage.startDate;
    delete stage.dueDate;
    api.tasks.set('template-flight', {
      id: 'template-flight', projectId: 'play', parentId: stage.id, title: 'googleflight',
    });
    const template = await discoverTickTickTemplate(api);
    let state: TickTickTripSyncState = { instances: {} };
    const sync = () => source === 'wish'
      ? reconcileTickTickWishPreparations({ api, template, state, configState: { config: { wishes: [futureWish] } }, today: '2026-09-04', saveState: async () => undefined })
      : reconcileTickTickTrips({ api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async () => undefined });
    const instance = () => source === 'wish' ? state.wishInstances![futureWish.id] : state.instances[futureTrip.key];
    const expectedDate = source === 'wish' ? '2027-02-28T00:00:00+0800' : '2026-06-10T00:00:00+0800';
    await sync();
    const flightId = instance().taskIdsByTemplateId['template-flight'];
    const photoId = instance().taskIdsByTemplateId['template-photo'];
    expect(api.tasks.get(flightId)).toMatchObject({ startDate: expectedDate, dueDate: expectedDate });
    expect(api.tasks.get(photoId)?.dueDate).toBe(expectedDate);

    // Simulate old automatic records, both with and without persisted snapshots.
    for (const id of [flightId, photoId]) {
      delete api.tasks.get(id)!.startDate;
      delete api.tasks.get(id)!.dueDate;
    }
    instance().taskDateStates![flightId].lastSynced.startDate = null;
    instance().taskDateStates![flightId].lastSynced.dueDate = null;
    delete instance().taskDateStates![photoId];
    state = JSON.parse(JSON.stringify(state));
    await sync();
    expect(api.tasks.get(flightId)?.dueDate).toBe(expectedDate);
    expect(api.tasks.get(photoId)?.dueDate).toBe(expectedDate);

    delete api.tasks.get(flightId)!.startDate;
    delete api.tasks.get(flightId)!.dueDate;
    await sync();
    state = JSON.parse(JSON.stringify(state));
    await sync();
    expect(api.tasks.get(flightId)?.startDate).toBeUndefined();
    expect(api.tasks.get(flightId)?.dueDate).toBeUndefined();
    expect(api.updatePayloads.get(flightId)).not.toHaveProperty('startDate');
    expect(api.updatePayloads.get(flightId)).not.toHaveProperty('dueDate');
    expect(instance().taskDateStates![flightId].manual).toBe(true);
  });

  it('无日期的七个月阶段按出发日补齐截止日期，并修复旧实例', async () => {
    const api = new FakeTickTickApi();
    addWishPreparationTemplate(api);
    const sevenMonthTemplate = api.tasks.get('template-seven-months')!;
    delete sevenMonthTemplate.startDate;
    delete sevenMonthTemplate.dueDate;
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const sync = () => reconcileTickTickTrips({
      api, template, state, trips: [futureTrip], today: '2026-09-04', saveState: async () => undefined,
    });

    await sync();
    const instance = state.instances[futureTrip.key];
    const generatedId = instance.taskIdsByTemplateId['template-seven-months'];
    expect(api.tasks.get(generatedId)).toMatchObject({
      startDate: '2026-06-10T00:00:00+0800',
      dueDate: '2026-06-10T00:00:00+0800',
    });

    delete api.tasks.get(generatedId)!.startDate;
    delete api.tasks.get(generatedId)!.dueDate;
    delete instance.taskDateStates;
    await sync();
    expect(api.tasks.get(generatedId)?.dueDate).toBe('2026-06-10T00:00:00+0800');
  });

  it('在服务端独立生成连续、切分及命名后的行程', () => {
    expect(buildTripSourcesFromSyncState(
      { tagMap: {
        '2026-09-10': 'travel',
        '2026-09-11': 'travel',
        '2026-09-12': 'travel',
        '2026-09-13': 'home',
      } },
      {
        tripTags: { '2026-09-10': '26.9.10 东京', '2026-09-12': '' },
        tripNotes: { '2026-09-10': ' 带护照 ' },
        tripSplits: { '2026-09-12': true },
      },
    )).toEqual([
      {
        key: '2026-09-10', startDate: '2026-09-10', endDate: '2026-09-11',
        dates: ['2026-09-10', '2026-09-11'], name: '东京', note: '带护照',
      },
      {
        key: '2026-09-12', startDate: '2026-09-12', endDate: '2026-09-12',
        dates: ['2026-09-12'], name: '9月12日', note: '',
      },
    ]);
  });

  it('无账单标签时将 Outlook 日程名称同步到已有任务，选择账单标签后优先使用标签', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const calendar = { tagMap: { '2026-10-16': 'travel', '2026-10-17': 'travel', '2026-10-18': 'travel' }, outlookTravelTitles: {} as Record<string, string> };
    const tripState = { tripTags: {} as Record<string, string> };
    const sync = () => reconcileTickTickTrips({ api, template, state, trips: buildTripSourcesFromSyncState(calendar, tripState), today: '2026-09-22', saveState: async () => undefined });
    await sync();
    const rootId = state.instances['2026-10-16'].rootTaskId!;
    const created = api.createCalls;
    expect(api.tasks.get(rootId)?.title).toBe('10月16日–10月18日 · 出门todo');
    calendar.outlookTravelTitles = { '2026-10-16': '南京学术会议', '2026-10-17': '南京学术会议', '2026-10-18': '南京学术会议' };
    await sync();
    expect(api.tasks.get(rootId)?.title).toBe('南京学术会议 · 出门todo');
    tripState.tripTags['2026-10-16'] = '26.10南京出差';
    await sync();
    expect(api.tasks.get(rootId)?.title).toBe('南京出差 · 出门todo');
    expect(api.createCalls).toBe(created);
    expect(state.instances['2026-10-16'].rootTaskId).toBe(rootId);
  });

  it('当前场景对齐今天，非当前场景对齐下一段开始日', () => {
    const calendarState = { tagMap: {
      '2026-09-01': 'home',
      '2026-09-02': 'home',
      '2026-09-03': 'home',
      '2026-09-04': 'home',
      '2026-09-05': 'home',
      '2026-09-06': 'home',
      '2026-09-07': 'school',
      '2026-09-08': 'intern',
      '2026-09-15': 'intern',
      '2026-09-20': 'home',
    } };

    expect(getTickTickRoutineTargetDates(calendarState, '2026-09-05')).toEqual({
      home: '2026-09-05',
      school: '2026-09-07',
      travel: null,
    });
    expect(getTickTickRoutineTargetDates(calendarState, '2026-09-07')).toEqual({
      home: '2026-09-20',
      school: '2026-09-07',
      travel: null,
    });
    expect(getTickTickRoutineTargetDates(calendarState, '2026-09-08')).toEqual({
      home: '2026-09-20',
      school: '2026-09-08',
      travel: null,
    });
    expect(getTickTickRoutineTargetDates(calendarState, '2026-09-09')).toEqual({
      home: '2026-09-20',
      school: '2026-09-15',
      travel: null,
    });
  });

  it('没有下一场景时均不兜底春节', () => {
    expect(nextChineseNewYear('2026-09-21')).toBe('2027-02-06');
    expect(nextChineseNewYear('2027-02-05')).toBe('2027-02-06');
    expect(nextChineseNewYear('2027-02-06')).toBe('2028-01-26');
    expect(getTickTickRoutineTargetDates({ tagMap: {} }, '2026-09-21')).toEqual({
      home: null,
      school: null,
      travel: null,
    });
  });

  it('同步普通清单列表之外的收集箱 routine，并保留完整任务字段', async () => {
    const api = new FakeRoutineTickTickApi();
    const calendarState = { tagMap: {
      '2026-09-01': 'home',
      '2026-09-02': 'home',
      '2026-09-03': 'home',
      '2026-09-04': 'home',
      '2026-09-05': 'home',
      '2026-09-06': 'home',
      '2026-09-07': 'school',
      '2026-09-08': 'intern',
      '2026-09-20': 'home',
    } };

    await expect(syncTickTickRoutines({ api, calendarState, today: '2026-09-07' })).resolves.toEqual({
      updatedRoutineTasks: 4,
      routineTargets: { home: '2026-09-20', school: '2026-09-07', travel: null },
      routineTaskCounts: { home: 2, school: 2, travel: 0 },
    });
    expect(api.tasks.get('home-dated')).toMatchObject({
      startDate: '2026-09-19T09:00:00+0800',
      dueDate: '2026-09-20T18:00:00+0800',
      reminders: ['TRIGGER:P0DT9H0M0S'],
    });
    expect(api.tasks.get('school-dated')).toMatchObject({
      startDate: '2026-09-07T00:00:00+0800',
      dueDate: '2026-09-07T00:00:00+0800',
      items: [
        { id: 'school-item', title: '查余额', status: 0, startDate: '2026-09-07T07:30:00+0800' },
        { id: 'school-item-done', title: '已处理', status: 1, startDate: '2026-09-15T08:00:00+0800' },
      ],
    });
    expect([...api.updatePayloads.entries()].every(([taskId, payload]) => payload.id === taskId)).toBe(true);
    expect(api.tasks.get('school-start-only')?.startDate).toBe('2026-09-07T08:30:00+0800');
    expect(api.tasks.get('school-start-only')?.dueDate).toBeUndefined();
    expect(api.tasks.get('home-no-date')).toMatchObject({
      startDate: '2026-09-20T00:00:00+0800', dueDate: '2026-09-20T00:00:00+0800',
      isAllDay: true, timeZone: 'Asia/Shanghai',
    });
    expect(api.tasks.get('home-completed')?.dueDate).toBe('2026-09-01T00:00:00+0800');
    expect(api.tasks.get('unrelated-dated')?.dueDate).toBe('2026-09-15T00:00:00+0800');

    await expect(syncTickTickRoutines({ api, calendarState, today: '2026-09-07' }))
      .resolves.toMatchObject({ updatedRoutineTasks: 0 });
  });

  it('全局筛选漏掉收集箱时，自身标签仍排期且重复同步不再更新', async () => {
    const api = new FakeTickTickApi();
    const task: TickTickTask = { id: 'inbox-todo', projectId: 'inbox-user', title: '收集箱待办', tags: ['居'], status: 0 };
    api.tasks.set(task.id, task);
    const readProject = api.getProjectData.bind(api);
    vi.spyOn(api, 'getProjectData').mockImplementation(async (projectId) => projectId === 'inbox'
      ? { tasks: [api.tasks.get(task.id)!] }
      : readProject(projectId));
    vi.spyOn(api, 'filterTasks').mockResolvedValue([]);
    const options = { api, calendarState: { tagMap: { '2026-09-26': 'school' } }, today: '2026-09-25' };
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({ updatedRoutineTasks: 1, routineTaskCounts: { home: 0, school: 1, travel: 0 } });
    expect(api.tasks.get(task.id)).toMatchObject({ projectId: 'inbox-user', startDate: '2026-09-26T00:00:00+0800', isAllDay: true });
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({ updatedRoutineTasks: 0 });
  });

  it('按上海日期判断全天任务，今天未完成留在今天，今天完成后才排到明天', async () => {
    const calendarState = { tagMap: {
      '2026-09-04': 'home',
      '2026-09-05': 'home',
      '2026-09-10': 'school',
    } };
    const pendingApi = new FakeRoutineTickTickApi();
    const pending = pendingApi.tasks.get('home-dated')!;
    pending.repeatFlag = 'RRULE:FREQ=DAILY;INTERVAL=1';
    pending.isAllDay = true;
    // TickTick 用 UTC 表示上海全天任务：这里实际是 9 月 5 日零点。
    pending.startDate = '2026-09-04T16:00:00.000+0000';
    pending.dueDate = '2026-09-04T16:00:00.000+0000';

    await syncTickTickRoutines({ api: pendingApi, calendarState, today: '2026-09-04' });
    expect(pendingApi.tasks.get('home-dated')).toMatchObject({
      startDate: '2026-09-03T16:00:00.000+0000',
      dueDate: '2026-09-03T16:00:00.000+0000',
    });

    const completedApi = new FakeRoutineTickTickApi();
    const next = completedApi.tasks.get('home-dated')!;
    next.repeatFlag = 'RRULE:FREQ=DAILY;INTERVAL=1';
    next.isAllDay = true;
    next.startDate = '2026-09-04T16:00:00.000+0000';
    next.dueDate = '2026-09-04T16:00:00.000+0000';
    completedApi.tasks.set('home-dated-completed-today', {
      ...next,
      id: 'home-dated-completed-today',
      status: 2,
      completedTime: '2026-09-04T08:30:00.000+0000',
      startDate: '2026-09-03T16:00:00.000+0000',
      dueDate: '2026-09-03T16:00:00.000+0000',
    });

    const result = await syncTickTickRoutines({ api: completedApi, calendarState, today: '2026-09-04' });
    expect(completedApi.tasks.get('home-dated')).toMatchObject({
      startDate: '2026-09-04T16:00:00.000+0000',
      dueDate: '2026-09-04T16:00:00.000+0000',
    });
    expect(completedApi.updatePayloads.has('home-dated')).toBe(false);
    expect(result.routineTargets.home).toBe('2026-09-04');
  });

  it('凌晨的完成算今天，明天离家则等下次回家，不重排已完成记录', async () => {
    const api = new FakeRoutineTickTickApi();
    const task = api.tasks.get('home-dated')!;
    Object.assign(task, {
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', isAllDay: true,
      startDate: '2026-09-03T16:00:00.000+0000', dueDate: '2026-09-03T16:00:00.000+0000',
    });
    const completed = { ...task, id: 'home-history', status: 2, completedTime: '2026-09-03T16:05:00.000+0000' };
    api.tasks.set(completed.id, completed);
    const calendarState = { tagMap: { '2026-09-04': 'home', '2026-09-05': 'intern', '2026-10-01': 'home' } };
    const options = { api, calendarState, today: '2026-09-04' };
    await syncTickTickRoutines(options);
    expect(api.tasks.get(task.id)?.dueDate).toBe('2026-09-30T16:00:00.000+0000');
    expect(api.tasks.get(completed.id)).toEqual(completed);
    expect(api.updatePayloads.has(completed.id)).toBe(false);
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({ updatedRoutineTasks: 0 });
  });

  it('昨天完成不算今天完成，其他父任务的同名完成记录也不影响今天', async () => {
    const api = new FakeRoutineTickTickApi();
    const task = api.tasks.get('home-dated')!;
    Object.assign(task, {
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', isAllDay: true,
      startDate: '2026-09-04T16:00:00.000+0000', dueDate: '2026-09-04T16:00:00.000+0000',
    });
    api.tasks.set('yesterday-done', { ...task, id: 'yesterday-done', status: 2, completedTime: '2026-09-03T15:59:59.000+0000' });
    api.tasks.set('other-parent-done', {
      ...task, id: 'other-parent-done', parentId: 'other-parent', status: 2, completedTime: '2026-09-04T01:00:00.000+0000',
    });
    const options = { api, calendarState: { tagMap: { '2026-09-04': 'home', '2026-09-05': 'home' } }, today: '2026-09-04' };
    await syncTickTickRoutines(options);
    expect(api.tasks.get(task.id)?.dueDate).toBe('2026-09-03T16:00:00.000+0000');
    await expect(syncTickTickRoutines(options)).resolves.toMatchObject({ updatedRoutineTasks: 0 });
  });

  it('在校任务完成后次日实习也可执行，清单项按本地日期移动且保留完成状态', async () => {
    const api = new FakeRoutineTickTickApi();
    const task = api.tasks.get('school-dated')!;
    Object.assign(task, {
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', isAllDay: true, timeZone: 'Asia/Shanghai',
      startDate: '2026-09-03T16:00:00.000+0000', dueDate: '2026-09-03T16:00:00.000+0000',
      items: [
        { id: 'unchecked', title: '未完成清单项', status: 0, startDate: '2026-09-03T16:00:00.000+0000' },
        { id: 'checked', title: '已完成清单项', status: 1, startDate: '2026-09-03T16:00:00.000+0000' },
      ],
    });
    api.tasks.set('school-history', { ...task, id: 'school-history', status: 2, completedTime: '2026-09-04T01:00:00+0000' });
    const calendarState = { tagMap: { '2026-09-04': 'school', '2026-09-05': 'intern' } };
    await syncTickTickRoutines({ api, calendarState, today: '2026-09-04' });
    expect(api.tasks.get(task.id)).toMatchObject({
      dueDate: '2026-09-04T16:00:00.000+0000',
      items: [
        { id: 'unchecked', status: 0, startDate: '2026-09-04T16:00:00.000+0000' },
        { id: 'checked', status: 1, startDate: '2026-09-03T16:00:00.000+0000' },
      ],
    });
  });

  it('今天完成但没有下一场景时保留原日期，未设日期的任务安排在确认的今天', async () => {
    const api = new FakeRoutineTickTickApi();
    const task = api.tasks.get('home-dated')!;
    Object.assign(task, {
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', isAllDay: true,
      startDate: '2026-09-03T16:00:00.000+0000', dueDate: '2026-09-03T16:00:00.000+0000',
    });
    api.tasks.set('home-history', { ...task, id: 'home-history', status: 2, completedTime: '2026-09-04T01:00:00+0000' });
    await syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'home' } }, today: '2026-09-04' });
    expect(api.tasks.get(task.id)?.dueDate).toBe('2026-09-03T16:00:00.000+0000');
    expect(api.tasks.get('home-no-date')?.startDate).toBe('2026-09-04T00:00:00+0800');
    expect(api.tasks.get('home-no-date')?.dueDate).toBe('2026-09-04T00:00:00+0800');
  });

  it('没有标签待办时正常返回零项，不依赖旧父任务或查询完成记录', async () => {
    const api = new FakeRoutineTickTickApi();
    api.tasks.delete('home-root');
    api.tasks.delete('school-root');
    for (const task of api.tasks.values()) task.tags = [];
    const completed = vi.spyOn(api, 'listCompletedTasks');
    await expect(syncTickTickRoutines({ api, calendarState: { tagMap: {} }, today: '2026-09-04' }))
      .resolves.toMatchObject({ updatedRoutineTasks: 0, routineTaskCounts: { home: 0, school: 0, travel: 0 } });
    expect(api.updateCalls).toBe(0);
    expect(completed).not.toHaveBeenCalled();
  });

  it('写入后回读缺少日期不能报告同步成功', async () => {
    const api = new FakeRoutineTickTickApi();
    api.getTask = async (_projectId, taskId) => {
      const task = api.tasks.get(taskId)!;
      return { id: task.id, projectId: task.projectId, title: task.title, status: 0 };
    };
    await expect(syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'home' } }, today: '2026-09-04' }))
      .rejects.toThrow('未正确更新');
  });

  it('routine 的兼容完成状态和完成时间仍被识别为已完成，不平移它们的日期', async () => {
    const api = new FakeRoutineTickTickApi();
    const task = api.tasks.get('school-dated')!;
    task.items = [
      { id: 'done', title: '已完成', status: 2, completedTime: '2026-09-03T03:00:00Z', startDate: '2026-09-03T00:00:00+0800' },
      { id: 'missing-status-done', title: '已完成但无状态', completedTime: '2026-09-03T03:00:00Z', startDate: '2026-09-03T00:00:00+0800' },
      { id: 'open', title: '未完成', status: '0', startDate: '2026-09-03T00:00:00+0800' },
    ];
    await syncTickTickRoutines({ api, calendarState: { tagMap: { '2026-09-04': 'school' } }, today: '2026-09-04' });
    expect(api.tasks.get(task.id)?.items).toMatchObject([
      { id: 'done', status: 1, startDate: '2026-09-03T00:00:00+0800' },
      { id: 'missing-status-done', status: 1, startDate: '2026-09-03T00:00:00+0800' },
      { id: 'open', status: 0, startDate: '2026-09-04T00:00:00+0800' },
    ]);
  });

  it('除夕完成且没有下次场景时，不猜测春节所在地', async () => {
    const api = new FakeRoutineTickTickApi();
    const task = api.tasks.get('home-dated')!;
    Object.assign(task, {
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', isAllDay: true,
      startDate: '2027-02-04T16:00:00.000+0000', dueDate: '2027-02-04T16:00:00.000+0000',
    });
    api.tasks.set('home-history', { ...task, id: 'home-history', status: 2, completedTime: '2027-02-05T01:00:00+0000' });
    await syncTickTickRoutines({ api, calendarState: { tagMap: { '2027-02-05': 'home' } }, today: '2027-02-05' });
    expect(api.tasks.get(task.id)?.dueDate).toBe('2027-02-04T16:00:00.000+0000');
  });

  it('加密保存并还原个人 API Token', () => {
    const encrypted = encryptTickTickToken('personal-token', 'sync-secret');
    expect(encrypted.data).not.toContain('personal-token');
    expect(decryptTickTickToken(encrypted, 'sync-secret')).toBe('personal-token');
  });

  it('按出门当天平移模板日期', () => {
    expect(shiftTickTickDate('2026-11-19T08:30:00+0800', '2026-11-20', '2027-01-10'))
      .toBe('2027-01-09T08:30:00+0800');
  });

  it('验证清单、模板和唯一日期锚点', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    expect(template.projectId).toBe('play');
    expect(template.tasks.map((task) => task.id)).toEqual([
      'template-root', 'template-month', 'template-before', 'template-day',
    ]);
    expect(template.anchorDate).toBe('2026-11-20');
    await expect(readConnectedTickTickTemplate(api, {
      projectId: 'play', templateRootId: 'template-root',
    })).resolves.toMatchObject({ anchorDate: '2026-11-20' });
  });

  it('复制完整树、重置完成状态，并在边界变化时保留实例与进度', async () => {
    const api = new FakeTickTickApi();
    const state: TickTickTripSyncState = { instances: {} };
    const saveState = async () => undefined;
    let template = await discoverTickTickTemplate(api);

    const first = await reconcileTickTickTrips({
      api,
      template,
      trips: [
        { ...futureTrip, key: '2026-01-01', startDate: '2026-01-01', endDate: '2026-01-02', dates: ['2026-01-01', '2026-01-02'] },
        futureTrip,
      ],
      state,
      today: '2026-09-03',
      saveState,
    });

    expect(first).toMatchObject({ createdTrips: 1, activeTrips: 1 });
    expect(api.createCalls).toBe(4);
    const instance = state.instances['2027-01-10'];
    const root = api.tasks.get(instance.rootTaskId!);
    const before = api.tasks.get(instance.taskIdsByTemplateId['template-before'])!;
    const month = api.tasks.get(instance.taskIdsByTemplateId['template-month'])!;
    expect(root).toMatchObject({ title: '东京 · 出门todo', dueDate: '2027-01-10T00:00:00+0800', content: '模板说明\n\n带护照' });
    expect(before).toMatchObject({ title: '东京 · 出门前一天', dueDate: '2027-01-09T00:00:00+0800', parentId: root?.id });
    expect(month.title).toBe('东京 · 出门前一个月');
    expect(month.status).toBe(0);
    expect(before.items?.[0].status).toBe(0);

    before.status = 2;
    before.items![0].status = 1;
    before.items!.push({ id: 'manual-item', title: '临时增加', status: 1 });
    api.tasks.set(before.id, before);
    api.tasks.get('template-before')!.items!.push({ id: 'template-camera', title: '相机', status: 0 });
    template = await readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'template-root' });
    const expandedTrip = {
      ...futureTrip,
      key: '2027-01-09',
      startDate: '2027-01-09',
      dates: ['2027-01-09', ...futureTrip.dates],
    };
    await reconcileTickTickTrips({ api, template, trips: [expandedTrip], state, today: '2026-09-03', saveState });

    expect(api.createCalls).toBe(4);
    expect(state.instances['2027-01-10']).toBeUndefined();
    expect(state.instances['2027-01-09'].rootTaskId).toBe(root?.id);
    const updatedBefore = api.tasks.get(before.id)!;
    expect(updatedBefore.title).toBe('东京 · 出门前一天');
    expect(updatedBefore.status).toBe(2);
    expect(updatedBefore.items?.map((item) => item.title)).toEqual(['随身包', '相机', '临时增加']);
    expect(updatedBefore.items?.find((item) => item.title === '随身包')?.status).toBe(1);
  });

  it('Outlook 完整行程覆盖本地工作日后，TickTick 两个周末副本合为原来的一套', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const dates = Array.from({ length: 9 }, (_, index) => `2027-01-${23 + index}`);
    const oldCalendar = {
      tagMap: Object.fromEntries(dates.map((day, index) => [day, index < 2 || index > 6 ? 'travel' : 'intern'])),
      manualTagDates: Object.fromEntries(dates.map((day) => [day, true])),
      outlookTravelTitles: Object.fromEntries(dates.map((day) => [day, '北海道'])),
    };
    const options = { api, template, state, today: '2026-09-25', saveState: async () => undefined };
    await reconcileTickTickTrips({ ...options, trips: buildTripSourcesFromSyncState(oldCalendar, {}) });
    const keptIds = { ...state.instances['2027-01-23'].taskIdsByTemplateId };
    const removedIds = Object.values(state.instances['2027-01-30'].taskIdsByTemplateId);
    api.tasks.get(keptIds['template-before'])!.status = 2;
    api.tasks.get(keptIds['template-before'])!.items![0].status = 1;
    const snapshot = buildOutlookSnapshot([
      { calendar: 'play', title: '北海道', startDate: '2027-01-23', endDate: '2027-02-01', allDay: true },
    ], '2027-01-01', '2027-02-01', DEFAULT_OUTLOOK_RULES);
    const calendar = applyOutlookSnapshotToState(oldCalendar, snapshot, 'manual');
    const trips = buildTripSourcesFromSyncState(calendar, {});
    await expect(reconcileTickTickTrips({ ...options, trips })).resolves.toEqual({ createdTrips: 0, updatedTrips: 1, deletedTrips: 1, activeTrips: 1 });
    expect(Object.keys(state.instances)).toEqual(['2027-01-23']);
    expect(state.instances['2027-01-23']).toMatchObject({ dates, startDate: '2027-01-23', endDate: '2027-01-31', taskIdsByTemplateId: keptIds });
    expect(api.tasks.get(keptIds['template-before'])).toMatchObject({ status: 2, items: [{ status: 1 }] });
    for (const id of removedIds) expect(api.tasks.has(id)).toBe(false);
    expect(api.createCalls).toBe(8);
    await expect(reconcileTickTickTrips({ ...options, trips })).resolves.toMatchObject({ createdTrips: 0, deletedTrips: 0, activeTrips: 1 });
    expect(api.createCalls).toBe(8);
  });

  it('刷新寒假后清理两套已生成待办，具体旅行改名沿用进度，普通同名任务保持不动', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const dates = ['2027-01-23', '2027-01-30', '2027-02-06', '2027-02-13'];
    const oldCalendar = {
      tagMap: Object.fromEntries(dates.map((day) => [day, 'travel'])),
      outlookApplied: Object.fromEntries(dates.map((day) => [day, { tag: 'travel', previousTag: null }])),
      outlookTravelTitles: Object.fromEntries(dates.map((day, index) => [day, index < 2 ? '北海道、寒假' : '寒假'])),
    };
    const options = { api, template, state, today: '2026-09-25', saveState: async () => undefined };
    await reconcileTickTickTrips({ ...options, trips: buildTripSourcesFromSyncState(oldCalendar, {}) });
    const originalIds = Object.fromEntries(dates.map((day) => [day, { ...state.instances[day].taskIdsByTemplateId }]));
    const completedId = originalIds[dates[0]]['template-before'];
    api.tasks.get(completedId)!.status = 2;
    api.tasks.get(completedId)!.items![0].status = 1;
    api.tasks.set('manual', { id: 'manual', projectId: 'play', title: '寒假 · 出门todo', status: 0 });
    const snapshot = buildOutlookSnapshot([
      { calendar: 'class', title: '寒假', startDate: '2027-01-20', endDate: '2027-02-20', allDay: true },
      { calendar: 'play', title: '北海道', startDate: '2027-01-23', endDate: '2027-01-24', allDay: true },
      { calendar: 'play', title: '北海道', startDate: '2027-01-30', endDate: '2027-01-31', allDay: true },
    ], '2027-01-01', '2027-03-01', DEFAULT_OUTLOOK_RULES);
    const calendar = applyOutlookSnapshotToState(oldCalendar, snapshot, 'manual');
    const trips = buildTripSourcesFromSyncState(calendar, {});
    await expect(reconcileTickTickTrips({ ...options, trips })).resolves.toEqual({
      createdTrips: 0, updatedTrips: 2, deletedTrips: 2, activeTrips: 2,
    });
    for (const day of dates.slice(0, 2)) {
      expect(state.instances[day].taskIdsByTemplateId).toEqual(originalIds[day]);
      expect(api.tasks.get(state.instances[day].rootTaskId!)?.title).toBe('北海道 · 出门todo');
    }
    for (const day of dates.slice(2)) {
      expect(state.instances[day]).toBeUndefined();
      for (const id of Object.values(originalIds[day])) expect(api.tasks.has(id)).toBe(false);
    }
    expect(api.tasks.get(completedId)).toMatchObject({ status: 2, items: [{ status: 1 }] });
    expect(api.tasks.has('manual')).toBe(true);
    expect(api.tasks.has(template.rootTask.id)).toBe(true);
    expect(getTickTickRoutineTargetDates(calendar, '2027-02-01').travel).toBeNull();
    const writes = [api.createCalls, api.deleteCalls];
    await expect(reconcileTickTickTrips({ ...options, trips })).resolves.toMatchObject({ createdTrips: 0, deletedTrips: 0 });
    expect([api.createCalls, api.deleteCalls]).toEqual(writes);
  });

  it('取消尚未结束的行程时删除映射任务，历史实例保持不动', async () => {
    const api = new FakeTickTickApi();
    const template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const saveState = async () => undefined;
    await reconcileTickTickTrips({ api, template, trips: [futureTrip], state, today: '2026-09-03', saveState });
    await reconcileTickTickTrips({ api, template, trips: [], state, today: '2026-09-03', saveState });
    expect(state.instances).toEqual({});
    expect(api.deleteCalls).toBe(4);

    state.instances.history = {
      tripKey: 'history', startDate: '2026-01-01', endDate: '2026-01-02', dates: ['2026-01-01'], name: '历史',
      rootTaskId: 'past-root', taskIdsByTemplateId: { 'template-root': 'past-root' }, itemIdsByTemplateTaskId: {},
    };
    api.tasks.set('past-root', { id: 'past-root', projectId: 'play', title: '历史 · 出门todo' });
    await reconcileTickTickTrips({ api, template, trips: [], state, today: '2026-09-03', saveState });
    expect(state.instances.history).toBeDefined();
    expect(api.tasks.has('past-root')).toBe(true);
  });

  it('模板删除任务时保留实例中手工添加的任务', async () => {
    const api = new FakeTickTickApi();
    let template = await discoverTickTickTemplate(api);
    const state: TickTickTripSyncState = { instances: {} };
    const saveState = async () => undefined;
    await reconcileTickTickTrips({ api, template, trips: [futureTrip], state, today: '2026-09-03', saveState });
    const instance = state.instances[futureTrip.key];
    const removedGeneratedId = instance.taskIdsByTemplateId['template-before'];
    api.tasks.set('manual-child', {
      id: 'manual-child', projectId: 'play', parentId: removedGeneratedId, title: '临时证件', status: 0,
    });
    api.tasks.delete('template-before');
    template = await readConnectedTickTickTemplate(api, { projectId: 'play', templateRootId: 'template-root' });

    await reconcileTickTickTrips({ api, template, trips: [futureTrip], state, today: '2026-09-03', saveState });

    expect(api.tasks.has(removedGeneratedId)).toBe(false);
    expect(api.tasks.get('manual-child')?.parentId).toBe(instance.rootTaskId);
  });
});
