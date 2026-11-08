import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers';
import { defaultRuleConfig, readRuleConfig, updateRuleGroups, removeSchedulingRule } from '../src/utils/schedulingRules';
import { executeRuleGraph, saveSchedulingRules, RULE_CONFIG_KEY } from './_schedulingRules';
import { RuleTaskDraft } from './_ruleTaskDraft';
import { locationTaskHidden, visibilityDecision } from './_taskVisibilityRules';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';

const { data } = vi.hoisted(() => ({ data: new Map<string, unknown>() }));
vi.mock('./_accountKv.js', () => ({ kv: {
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  set: async (key: string, value: unknown, options?: { nx?: boolean }) => { if (options?.nx && data.has(key)) return null; data.set(key, structuredClone(value)); return 'OK'; },
  eval: async (_script: string, [key]: string[]) => { data.delete(key); return 1; },
} }));
beforeEach(() => data.clear());

it('两个计算规则之间让出事件循环，待处理的健康检查有机会执行', async () => {
  const order: string[] = [];
  await executeRuleGraph(defaultRuleConfig(), 'hourly', {
    'calendar-travel': async () => {
      order.push('first');
      setImmediate(() => order.push('request'));
    },
    'calendar-manual': async () => { order.push('second'); },
  }, { save: false });
  expect(order).toEqual(['first', 'request', 'second']);
});

it.each(['full', 'hourly', 'visibility'] as const)('%s 使用同一分组顺序、保存自定义名称并跳过已删除规则', async scope => {
  const config = readRuleConfig(defaultRuleConfig());
  config.names = { 'visibility-reading': '晚间阅读' };
  const removed = removeSchedulingRule(config, 'visibility-reading');
  const saved = await saveSchedulingRules(removed), called = vi.fn();
  expect(saved.names!['visibility-reading']).toBe('晚间阅读'); expect(saved.groups).toEqual(removed.groups);
  const run = await executeRuleGraph(saved, scope, { 'visibility-reading': called }, { save: false });
  expect(called).not.toHaveBeenCalled(); expect(run.names).toEqual(saved.names);
  expect(run.results.find(rule => rule.id === 'visibility-reading')).toMatchObject({ status: 'skipped', reason: '已删除，不执行' });
});

it('分组环和非法删除在服务端拒绝，原配置与版本保持不变', async () => {
  const saved = await saveSchedulingRules(defaultRuleConfig());
  await expect(saveSchedulingRules({ ...saved, removed: ['vehicle-pickup'] })).rejects.toThrow('前序');
  const bad = { ...saved, groups: [
    { id: 'a', name: 'A组', rules: ['always-today', 'sprays'] }, { id: 'b', name: 'B组', rules: ['laundry'] },
    { id: 'rest', name: '其余', rules: saved.order.filter(id => !['always-today', 'sprays', 'laundry'].includes(id)) },
  ], predecessors: { laundry: ['always-today'], sprays: ['laundry'] } };
  await expect(saveSchedulingRules(bad)).rejects.toThrow('分组循环依赖');
  expect(data.get(RULE_CONFIG_KEY)).toEqual(saved);
});

it('保存配置检查版本，拒绝覆盖其他页面的新配置', async () => {
  const initial = defaultRuleConfig();
  const saved = await saveSchedulingRules(initial);
  expect(saved.version).toBe(1); expect(data.get(RULE_CONFIG_KEY)).toEqual(saved);
  await expect(saveSchedulingRules(initial)).rejects.toThrow('其他页面');
});
it('前序失败跳过传递依赖链，独立分支继续；不执行范围外的依赖', async () => {
  const config = readRuleConfig({ ...defaultRuleConfig(), predecessors: { laundry: ['exercise'], 'daily-plan': ['laundry'] } });
  const ran: string[] = [];
  const run = await executeRuleGraph(config, 'full', {
    exercise: async () => { throw new Error('private upstream body'); },
    laundry: async () => { ran.push('laundry'); }, 'daily-plan': async () => { ran.push('daily'); },
    'visibility-reading': async () => { ran.push('reading'); },
  }, { save: false });
  expect(ran).toEqual(['reading']);
  expect(run.results.find(r => r.id === 'daily-plan')?.status).toBe('skipped');
  expect(JSON.stringify(run)).not.toContain('private upstream');
  const hourly = await executeRuleGraph(config, 'hourly', { 'daily-plan': async () => { ran.push('wrong'); } }, { save: false });
  expect(hourly.results.find(r => r.id === 'daily-plan')?.reason).toContain('前序');
});

const task = (fields: Partial<TickTickTask> = {}): TickTickTask => ({ id: 'one', projectId: 'p', title: '洗衣服', status: 0, dueDate: '2026-11-05T00:00:00+0800',
  tags: ['活', 'routine', '广州'], repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=5', reminders: ['TRIGGER:PT0S'], ...fields });
function client(original = task()) {
  const tasks = new Map([[original.id, original]]);
  const api = { getTask: vi.fn(async (_project: string, id: string) => structuredClone(tasks.get(id)!)),
    updateTask: vi.fn(async (id: string, payload: Record<string, unknown>) => { tasks.set(id, { ...tasks.get(id)!, ...payload } as TickTickTask); return tasks.get(id)!; }) };
  return { api: api as unknown as TickTickApi, tasks, write: api.updateTask };
}
describe('最终任务改动裁决', () => {
  it.each([false, true])('移动整组确实改变冲突胜者，后执行规则不覆盖且只写一次：%s', async reverse => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]), initial = defaultRuleConfig();
    initial.predecessors = {};
    const groups = [{ id: 'today', name: '今日', rules: ['always-today'] as const }, { id: 'wash', name: '洗衣', rules: ['laundry'] as const }];
    const config = updateRuleGroups(initial, [...(reverse ? groups.reverse() : groups).map(group => ({ ...group, rules: [...group.rules] })),
      { id: 'rest', name: '其他', rules: initial.order.filter(id => !['always-today', 'laundry'].includes(id)) }]);
    const handler = (id: 'always-today' | 'laundry', date: string) => async () => {
      const branch = draft.branch(id); await branch.api.updateTask('one', { dueDate: date }); return branch.accept();
    };
    const run = await executeRuleGraph(config, 'full', {
      'always-today': handler('always-today', '2026-11-03T00:00:00+0800'), laundry: handler('laundry', '2026-11-08T00:00:00+0800'),
    }, { save: false });
    await draft.commit();
    expect(c.write).toHaveBeenCalledOnce();
    expect(c.tasks.get('one')!.dueDate).toBe(reverse ? '2026-11-08T00:00:00+0800' : '2026-11-03T00:00:00+0800');
    expect(run.results.find(rule => rule.id === (reverse ? 'always-today' : 'laundry'))!.conflicts![0].winner).toBe(reverse ? 'laundry' : 'always-today');
  });
  it.each([['always-today', 'laundry'], ['laundry', 'always-today']] as const)('较高的 %s 决定日期，只写一次并保留其他字段', async (first, second) => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    const high = draft.branch(first), low = () => draft.branch(second);
    await high.api.updateTask('one', { dueDate: '2026-11-03T00:00:00+0800' }); high.accept();
    const branch = low(); await branch.api.updateTask('one', { dueDate: '2026-11-08T00:00:00+0800' });
    expect(branch.accept().conflicts[0].winner).toBe(first);
    expect(c.write).not.toHaveBeenCalled(); await draft.commit();
    expect(c.write).toHaveBeenCalledOnce();
    expect(c.tasks.get('one')).toEqual({ ...task(), dueDate: '2026-11-03T00:00:00+0800' });
  });
  it('不改期也能保留高优先级日期，失败分支不接受候选', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    const high = draft.branch('laundry'); high.claimDates(['one']); high.accept();
    const low = draft.branch('daily-plan'); await low.api.updateTask('one', { dueDate: '2026-11-03T00:00:00+0800' }); low.accept();
    const failed = draft.branch('exercise'); await failed.api.updateTask('one', { title: '错误改动' });
    await draft.commit(); expect(c.write).not.toHaveBeenCalled();
  });
  it('写前发现并发完成，不重新打开任务', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    const branch = draft.branch('laundry'); await branch.api.updateTask('one', { dueDate: '2026-11-08T00:00:00+0800' }); branch.accept();
    c.tasks.get('one')!.status = 2;
    await expect(draft.commit()).rejects.toThrow('已变化'); expect(c.write).not.toHaveBeenCalled();
  });
  it('服务端回读改用 UTC 格式时，确认同一最终日期并允许后序使用', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    c.write.mockImplementation(async (id, payload) => {
      c.tasks.set(id, { ...c.tasks.get(id)!, ...payload, dueDate: new Date(payload.dueDate as string).toISOString() });
      return c.tasks.get(id)!;
    });
    const branch = draft.branch('laundry'); await branch.api.updateTask('one', { dueDate: '2026-11-08T00:00:00+0800' }); branch.accept();
    await draft.commit(); expect(draft.datesConfirmed('one')).toBe(true);
  });
  it('列表与详情使用不同格式表示同一时刻时不误判并发修改', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    c.tasks.get('one')!.dueDate = new Date(task().dueDate!).toISOString();
    const branch = draft.branch('always-today');
    await branch.api.updateTask('one', { dueDate: '2026-11-03T00:00:00+0800' }); branch.accept();
    await draft.commit(); expect(c.write).toHaveBeenCalledOnce();
  });
  it('真实并发编辑不写入，明确指出失败字段而不泄露内容', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    const branch = draft.branch('always-today');
    await branch.api.updateTask('one', { dueDate: '2026-11-03T00:00:00+0800' }); branch.accept();
    c.tasks.get('one')!.content = 'private user edit';
    await expect(draft.commit()).rejects.toThrow('待办已变化，未写入（content）');
    expect(c.write).not.toHaveBeenCalled();
  });
  it.each(['before', 'after'] as const)('残留旧完成时间可写，但 %s 新增完成时间仍停止确认', async phase => {
    const original = task({ status: 0, completedTime: '2026-09-17T04:14:43Z' });
    const c = client(); c.tasks.set('one', structuredClone(original));
    const draft = new RuleTaskDraft(c.api, [original]);
    const branch = draft.branch('always-today');
    await branch.api.updateTask('one', { dueDate: '2026-11-03T00:00:00+0800' }); branch.accept();
    if (phase === 'before') c.tasks.get('one')!.completedTime = '2026-11-03T04:00:00Z';
    else c.write.mockImplementation(async (id, payload) => {
      c.tasks.set(id, { ...c.tasks.get(id)!, ...payload, completedTime: '2026-11-03T04:00:00Z' }); return c.tasks.get(id)!;
    });
    await expect(draft.commit()).rejects.toThrow(phase === 'before' ? '待办已变化' : '写后回读不一致');
    expect(c.write).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
    expect(draft.datesConfirmed('one')).toBe(false);
  });
  it('标签在详情和写后回读中重排时仍确认显隐，不改其他标签', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    c.tasks.get('one')!.tags!.reverse();
    c.write.mockImplementation(async (id, payload) => {
      c.tasks.set(id, { ...c.tasks.get(id)!, ...payload, tags: [...payload.tags as string[]].sort() });
      return c.tasks.get(id)!;
    });
    const branch = draft.branch('visibility-timed');
    await branch.api.updateTask('one', { tags: [...task().tags!, 'hidden'] }); branch.accept();
    await draft.commit();
    expect(c.write).toHaveBeenCalledOnce();
    expect(draft.committedValues()[0].tags).toEqual([...task().tags!, 'hidden'].sort());
  });
  it.each(['before', 'after'] as const)('标签真实丢失仍在 %s 阶段停止，不用忽略顺序掩盖差异', async phase => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    const branch = draft.branch('visibility-timed');
    await branch.api.updateTask('one', { tags: [...task().tags!, 'hidden'] }); branch.accept();
    if (phase === 'before') c.tasks.get('one')!.tags = ['活', '广州'];
    else c.write.mockImplementation(async (id, payload) => {
      c.tasks.set(id, { ...c.tasks.get(id)!, ...payload, tags: ['活', '广州', 'hidden'] }); return c.tasks.get(id)!;
    });
    await expect(draft.commit()).rejects.toThrow(phase === 'before' ? '待办已变化，未写入（tags）' : '写后回读不一致（tags）');
    expect(c.write).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
  });
  it('生成任务清理前再次检查完成状态，并验证删除结果', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    c.api.deleteTask = vi.fn(async (_project, id) => { c.tasks.delete(id); });
    const branch = draft.branch('trips'); await branch.api.deleteTask('p', 'one'); branch.accept();
    await draft.commit(); expect(c.api.deleteTask).toHaveBeenCalledOnce(); expect(draft.committedValues()).toEqual([]);
    const raced = client(), protectedDraft = new RuleTaskDraft(raced.api, [task()]);
    raced.api.deleteTask = vi.fn();
    vi.mocked(raced.api.getTask).mockResolvedValueOnce(task()).mockResolvedValueOnce(task({status:2}));
    const removal = protectedDraft.branch('trips'); await removal.api.deleteTask('p','one'); removal.accept();
    await expect(protectedDraft.commit()).rejects.toThrow('已变化'); expect(raced.api.deleteTask).not.toHaveBeenCalled();
  });
  it('已删除副本仍可按 ID 回读时，以两个当前任务查询共同确认移除', async () => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    c.api.deleteTask = vi.fn(async () => {});
    c.api.getProjectData = vi.fn(async () => ({ project: { id: 'p', name: '生活' }, tasks: [] }));
    c.api.filterTasks = vi.fn(async () => []);
    const branch = draft.branch('vehicle-pickup'); await branch.api.deleteTask('p', 'one'); branch.accept();
    expect(await draft.commit()).toBe(1);
    expect(draft.committedValues()).toEqual([]);
    expect(c.api.deleteTask).toHaveBeenCalledTimes(1);
    expect(c.api.getProjectData).toHaveBeenCalledWith('p');
    expect(c.api.filterTasks).toHaveBeenCalledWith(undefined, [0]);
  });
  it.each(['project', 'global', 'read-error', 'invalid-response', 'wrong-project'])('删除核对遇到 %s 时不宣告成功且不重复删除', async mode => {
    const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
    c.api.deleteTask = vi.fn(async () => {});
    c.api.getProjectData = vi.fn(async () => {
      if (mode === 'read-error') throw new Error('读取失败');
      return { project: { id: mode === 'wrong-project' ? 'other' : 'p', name: '生活' }, tasks: mode === 'project' ? [task()] : [] };
    });
    c.api.filterTasks = vi.fn(async () => mode === 'invalid-response' ? undefined as unknown as TickTickTask[] : mode === 'global' ? [task({ projectId: 'moved' })] : []);
    const branch = draft.branch('vehicle-pickup'); await branch.api.deleteTask('p', 'one'); branch.accept();
    await expect(draft.commit()).rejects.toThrow(mode === 'read-error' ? '读取失败' : '删除结果未确认');
    expect(draft.committedValues()).toEqual([task()]);
    expect(c.api.deleteTask).toHaveBeenCalledTimes(1);
  });
});
it('模板检查事项回读对象字段顺序变化及空备注补齐不阻止保存同步基准', async () => {
  const original = task({ items: [{ id: 'wash', title: '洗衣服', status: 0 }] });
  const c = client(original), draft = new RuleTaskDraft(c.api, [original]);
  c.write.mockImplementation(async (id, payload) => {
    c.tasks.set(id, { ...c.tasks.get(id)!, ...payload, content: '', desc: '',
      items: (payload.items as NonNullable<TickTickTask['items']>).map(item => ({ status: item.status, title: item.title, id: item.id })) });
    return c.tasks.get(id)!;
  });
  const branch = draft.branch('template-content');
  await branch.api.updateTask('one', { items: [...original.items!, { id: 'tablet', title: '平板电影×4 电视剧×1 (5m)', status: 0 }] });
  branch.accept(); const save = vi.fn(); draft.saveAfterCommit('template-content', save);
  await draft.commit();
  expect(save).toHaveBeenCalledOnce();
  expect(draft.committedValues()[0].items!.map(item => item.title)).toContain('平板电影×4 电视剧×1 (5m)');
});
it('检查事项确实丢失时仍拒绝确认且不保存同步基准', async () => {
  const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
  c.write.mockImplementation(async (id, payload) => {
    c.tasks.set(id, { ...c.tasks.get(id)!, ...payload, items: [] }); return c.tasks.get(id)!;
  });
  const branch = draft.branch('template-content');
  await branch.api.updateTask('one', { items: [{ id: 'phone', title: '手机电视剧×1 (5m)', status: 0 }] });
  branch.accept(); const save = vi.fn(); draft.saveAfterCommit('template-content', save);
  await expect(draft.commit()).rejects.toThrow('写后回读不一致（items）');
  expect(save).not.toHaveBeenCalled();
});
it.each([false, true])('新搬家任务保存服务端检查项 ID、默认字段和 UTC 日期，但拒绝进度变化：%s', async changedProgress => {
  const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
  c.api.createTask = vi.fn(async payload => {
    const saved = { ...payload, id: 'new-moving', status: 0,
      items: (payload.items as NonNullable<TickTickTask['items']>).map(item => ({ ...item,
        id: `server-${item.id}`, status: changedProgress ? 1 : 0, isAllDay: true, timeZone: 'Asia/Shanghai',
        startDate: new Date(item.startDate!).toISOString(), completedTime: null,
      })) } as unknown as TickTickTask;
    c.tasks.set(saved.id, saved); return saved;
  });
  const branch = draft.branch('template-content');
  await branch.api.createTask({ projectId: 'p', title: '搬家-京广-11.5 · 出门前一天',
    items: [{ id: 'movie', title: '平板电影×4 电视剧×1 (5m)', status: 0, sortOrder: 0, startDate: '2026-11-04T00:00:00+0800' }] });
  branch.accept(); const save = vi.fn(); draft.saveAfterCommit('template-content', save);
  if (changedProgress) {
    await expect(draft.commit()).rejects.toThrow('写后回读不一致（items）');
    expect(save).not.toHaveBeenCalled();
  } else {
    await draft.commit(); expect(save).toHaveBeenCalled();
    expect(draft.committedValues().find(task => task.id === 'new-moving')?.items?.[0].status).toBe(0);
    expect(draft.resolveIds({ checklist: { source: 'movie' } })).toEqual({ checklist: { source: 'server-movie' } });
  }
});
it('已有任务检查项 ID 改变时拒绝确认，不以新建时的 ID 分配规则放行', async () => {
  const original = task({ items: [{ id: 'known', title: '平板电影', status: 0 }] });
  const c = client(original), draft = new RuleTaskDraft(c.api, [original]);
  c.write.mockImplementation(async (id, payload) => {
    c.tasks.set(id, { ...c.tasks.get(id)!, ...payload, items: [{ id: 'unexpected', title: '平板电影', status: 0 }] });
    return c.tasks.get(id)!;
  });
  const branch = draft.branch('template-content'); await branch.api.updateTask('one', { title: '搬家-京广-11.5 · 出门前一天' });
  branch.accept(); await expect(draft.commit()).rejects.toThrow('写后回读不一致（items）');
});
it('已有任务新增检查项接纳服务端 ID，保留原条目 ID 和进度并保存新增关联', async () => {
  const original = task({ items: [{ id: 'known', title: '已有物品', status: 1 }] });
  const c = client(original), draft = new RuleTaskDraft(c.api, [original]);
  c.write.mockImplementation(async (id, payload) => {
    c.tasks.set(id, { ...c.tasks.get(id)!, ...payload,
      items: (payload.items as NonNullable<TickTickTask['items']>).map(item => item.id === 'new-requested' ? { ...item, id: 'new-server' } : item) });
    return c.tasks.get(id)!;
  });
  const branch = draft.branch('template-content');
  await branch.api.updateTask('one', { items: [{ id: 'new-requested', title: '手机电视剧×1 (5m)', status: 0 }, ...original.items!] });
  branch.accept(); let state: unknown;
  draft.saveAfterCommit('template-content', async () => { state = draft.resolveIds({ source: 'new-requested' }); });
  await draft.commit();
  expect(state).toEqual({ source: 'new-server' });
  expect(draft.committedValues()[0].items).toEqual([{ id: 'new-server', title: '手机电视剧×1 (5m)', status: 0 }, { id: 'known', title: '已有物品', status: 1 }]);
});
it('计划形成后母任务被完成，提交时不再补建下级', async () => {
  const c = client(), draft = new RuleTaskDraft(c.api, [task()]); c.api.createTask = vi.fn();
  const branch = draft.branch('template-content');
  await branch.api.createTask({ projectId: 'p', parentId: 'one', title: '搬家-京广-11.5 · 新子任务' }); branch.accept();
  Object.assign(c.tasks.get('one')!, { status: 2, completedTime: '2026-11-04T05:00:00Z' });
  await expect(draft.commit()).rejects.toThrow('母任务已完成');
  expect(c.api.createTask).not.toHaveBeenCalled();
});
it('清理已完成事件的自动重复项优先于该重复项的显隐标签更新', async () => {
  const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
  c.api.deleteTask = vi.fn(async (_project, id) => { c.tasks.delete(id); });
  const visible = draft.branch('visibility-location');
  await visible.api.updateTask('one', { tags: [...task().tags!, 'hidden'] }); visible.accept();
  const cleanup = draft.branch('template-content'); await cleanup.api.deleteTask('p', 'one');
  expect(cleanup.accept().conflicts).toEqual([]);
  await draft.commit();
  expect(c.api.deleteTask).toHaveBeenCalledOnce(); expect(c.write).not.toHaveBeenCalled();
});
describe('地点显隐', () => {
  const locations = { names: ['北京', '广州', '清迈'], today: ['北京'], unknown: false };
  it('城市标签按任一匹配；无城市标签不处理；未知当天地点不误显示', () => {
    expect(locationTaskHidden(task(), locations)).toBe(true);
    expect(locationTaskHidden(task({ tags: ['北京市', '广州'] }), locations)).toBe(false);
    expect(locationTaskHidden(task({ tags: ['活'] }), locations)).toBeNull();
    expect(locationTaskHidden(task({ tags: ['北京'] }), { ...locations, today: [], unknown: true })).toBe(true);
  });
  it('地点与阅读规则分别产生候选，由优先级统一裁决', () => {
    const input = { now: new Date('2026-11-03T20:00:00+0800'), timeZone: 'Asia/Shanghai', locations, journal: {} };
    const reading = task({ title: '阅读' });
    expect(visibilityDecision('visibility-location', reading, input)).toBe(true);
    expect(visibilityDecision('visibility-reading', reading, input)).toBe(false);
  });
});

it('验证前序的写入后才执行后序效果，失败阻断后序但不阻断其他分支', async () => {
  const c = client(), draft = new RuleTaskDraft(c.api, [task()]);
  const branch = draft.branch('always-today'); await branch.api.updateTask('one', { dueDate: '2026-11-03T00:00:00+0800' }); branch.accept();
  const effects: string[] = [], failed = new Set<string>();
  c.write.mockRejectedValueOnce(new Error('unconfirmed'));
  await draft.commit({ order: ['always-today', 'outlook-hair', 'outlook-charging'], allowed: id => !failed.has(id),
    failed: ids => { ids.forEach(id => failed.add(id)); failed.add('outlook-hair'); },
    afterRule: async id => { if (!failed.has(id)) effects.push(id); } });
  expect(effects).toEqual(['outlook-charging']); expect(draft.committedValues()).toEqual([task()]);
});
