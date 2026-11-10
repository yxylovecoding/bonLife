import { describe, expect, it, vi } from 'vitest';
import { cycleEnd, estimateTaskMinutes, planTickTickDay, refreshDailyHistory, type DailyPlanState } from './_ticktickDailyPlan';
import { TickTickOpenApiClient, syncTickTickRoutines, type TickTickApi, type TickTickTask } from './_ticktickTrips';
import { withRulePolicy } from './_rulePolicy';
import { defaultRuleConfig, removeSchedulingRule } from '../src/utils/schedulingRules';
const today = '2026-10-04';
const task = (id: string, fields: Partial<TickTickTask> = {}): TickTickTask => ({ id, projectId: 'inbox-real', title: id,
  status: 0, isAllDay: true, startDate: `${today}T00:00:00+0800`, dueDate: `${today}T00:00:00+0800`, ...fields });
const done = (source: TickTickTask, day: string, id = source.id): TickTickTask => ({ ...source, id, status: 2, completedTime: `${day}T09:00:00+0800` });
const state = (history: TickTickTask[] = []): DailyPlanState => ({ connectionId: 'same', history, deadlines: {} });
const run = (tasks: TickTickTask[], other: Partial<Parameters<typeof planTickTickDay>[0]> = {}) => planTickTickDay({
  tasks, state: state(), today, timezone: 'Asia/Shanghai', now: new Date(`${today}T05:00:00+08:00`), calendarState: {}, budgetMinutes: 60, ...other,
});
const apply = (tasks: TickTickTask[], dates: Map<string, string>) => tasks.map((t) => dates.has(t.id)
  ? { ...t, startDate: `${dates.get(t.id)}T00:00:00+0800`, dueDate: `${dates.get(t.id)}T00:00:00+0800` } : t);

describe('每日待办动态安排', () => {
  it('删除完成时间优先规则后，普通轮换不再隐式按该规则排序', () => {
    const older = task('z-older', { content: '(25m)' }), newer = task('a-newer', { content: '(25m)' });
    const evaluate = () => {
      const saved = state([done(older, '2026-09-20'), done(newer, '2026-10-02')]);
      run([newer, older], { state: saved, budgetMinutes: 25 });
      return saved.briefing!.selected[0].id;
    };
    expect(evaluate()).toBe(older.id);
    expect(withRulePolicy(removeSchedulingRule(defaultRuleConfig(), 'oldest'), evaluate)).toBe(newer.id);
  });
  it('记录入选原因和估时，未选中项不冒充今日事', () => {
    const s = state();
    const p = run([task('a', { title: '学习 25分钟' }), task('b', { title: '学习 25分钟' })], { state: s, budgetMinutes: 25 });
    const chosen = s.briefing!.selected;
    expect(chosen).toHaveLength(1);
    expect(chosen[0].minutes).toBe(25);
    expect(chosen[0].reasons.join('')).toContain('可放入剩余空档');
    expect(p.dates.get(chosen[0].id)).toBe(today);
    expect(s.briefing!.date).toBe(today);
  });
  it('同周期按实际最近完成排序，识别重复任务新 ID，重要事项保留原安排', () => {
    const newer = task('mite', { title: '除螨喷雾', repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const older = task('fragrance', { title: '香香喷雾', repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const p = run([newer, older, task('important', { priority: 5, title: '重要事项 45分钟' })], { budgetMinutes: 50,
      state: state([done(newer, '2026-09-27', 'old-id1'), done(older, '2026-09-20', 'old-id2')]) });
    expect(p.dates.get(older.id)).toBe(today);
    expect(p.dates.get(newer.id)).toBe('2026-10-05');
    expect(p.dates.has('important')).toBe(false);
    expect(p.summary).toMatchObject({ todayCount: 1, plannedMinutes: 5, importantCount: 1 });
  });
  it('寄居旅始终优先，多标签取最近可用日，明天不匹配就顺延', () => {
    const p = run([task('home', { tags: ['寄'] }), task('school', { tags: ['居'] }), task('both', { tags: ['寄', '居'] }), task('travel', { tags: ['旅'] })], {
      budgetMinutes: 10, calendarState: { tagMap: { [today]: 'school', '2026-10-05': 'travel', '2026-10-06': 'home', '2026-10-07': 'intern' } },
    });
    expect(p.dates.get('home')).toBe('2026-10-06');
    expect(p.dates.get('school')).toBe('2026-10-07');
    expect(p.dates.get('both')).toBe('2026-10-06');
    expect(p.dates.get('travel')).toBe('2026-10-05');
  });
  it('未来场景任务不能因很久没完成而被提前拉回今日', () => {
    const p = run([task('school', { tags: ['居'], dueDate: '2026-10-07T00:00:00+0800', repeatFlag: 'RRULE:FREQ=WEEKLY' })], {
      calendarState: { tagMap: { [today]: 'home', '2026-10-07': 'school' } },
    });
    expect(p.dates.size).toBe(0);
  });
  it('无下一适用场景时保留今日日期并如实计入负担', () => {
    const p = run([task('last-day', { tags: ['旅'], title: '任务 60分钟' })], {
      budgetMinutes: 10, calendarState: { tagMap: { [today]: 'travel' } },
    });
    expect(p.dates.get('last-day')).toBe(today);
    expect(p.summary.plannedMinutes).toBe(60);
  });
  it('排除标签按自身判断，普通子任务独立轮换，模板后代不动', () => {
    const p = run([task('folder', { tags: ['routine'] }), task('child', { parentId: 'folder' }),
      task('template'), task('stage', { parentId: 'template' }), task('leaf', { parentId: 'stage' }),
      task('ignored', { tags: ['不关我事'] }), task('timed', { isAllDay: false }),
      task('wash', { title: '洗头' }), task('follow', { tags: ['洗头'] }),
      task('unknown', { repeatFlag: 'LUNAR:FREQ=YEARLY' })], { excludedTaskIds: new Set(['template']), budgetMinutes: 240 });
    expect([...p.dates.keys()]).toEqual(['child']);
  });
  it('routine 与 hidden 标签忽略大小写和空白；定时 routine 到点后仍不会进入今日事', () => {
    const s = state();
    const p = run([
      task('morning', { title: '晨间routine', tags: [' Routine '], isAllDay: false, startDate: `${today}T04:00:00+0800`, dueDate: `${today}T04:50:00+0800` }),
      task('lunch', { title: '🏫吃午饭了', tags: ['ROUTINE'], isAllDay: false, startDate: `${today}T12:00:00+0800`, dueDate: `${today}T12:30:00+0800` }),
      task('system-hidden', { tags: [' HIDDEN '] }),
      task('legacy-hidden', { tags: [' BON-HIDDEN '] }),
      task('ordinary', { title: '今天应该安排的普通任务 30分钟' }),
    ], { state: s, budgetMinutes: 30 });
    expect(s.briefing!.selected.map((item) => item.id)).toEqual(['ordinary']);
    expect(p.summary).toMatchObject({ todayCount: 1, plannedMinutes: 30 });
  });
  it('重要事项先占剩余时间，实际完成仍计入手动上限', () => {
    const pool = Array.from({ length: 8 }, (_, i) => task(String(i)));
    const quiet = run(pool).summary;
    const busy = run([...pool, task('important', { priority: 5 })], { now: new Date(`${today}T21:00:00+08:00`) }).summary;
    const completed = run(pool, { state: state([done(task('finished'), today)]) }).summary;
    expect(busy.todayCount).toBe(3);
    expect(busy.todayCount).toBeLessThan(quiet.todayCount);
    expect(completed.todayCount).toBeLessThan(quiet.todayCount);
    expect(busy.plannedMinutes).toBeLessThanOrEqual(busy.availableMinutes);
  });
  it('周期未到也能利用剩余空档，最久未完成优先且不突破每日用时', () => {
    const pool = Array.from({ length: 10 }, (_, i) => task(String(i), { repeatFlag: 'RRULE:FREQ=WEEKLY' }));
    const near = run(pool, { state: state(pool.map((t) => done(t, '2026-09-27'))) });
    const far = run(pool, { state: state(pool.map((t) => done(t, '2026-10-03'))) });
    expect(near.summary.todayCount).toBe(4);
    expect(far.summary.todayCount).toBe(4);
    expect(near.summary.plannedMinutes).toBeLessThanOrEqual(60);
    const urgent = task('urgent', { repeatFlag: 'RRULE:FREQ=DAILY', content: '(1h)' });
    expect(run([pool[0], urgent], { state: state([done(pool[0], '2026-10-03'), done(urgent, '2026-10-02')]) }).dates.get('urgent')).toBe(today);
  });
  it('at-least 标签要求距上次完成至少经过一个重复周期', () => {
    const early = task('early', { tags: [' At-Least '], repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const reached = task('reached', { tags: ['at-least'], repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const ordinary = task('ordinary', { repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const p = run([early, reached, ordinary], { budgetMinutes: 60, state: state([
      done(early, '2026-09-28', 'early-old'),
      done(reached, '2026-09-27', 'reached-old'),
      done(ordinary, '2026-09-28', 'ordinary-old'),
    ]) });
    expect(p.dates.get(early.id)).toBe('2026-10-05');
    expect(p.dates.get(reached.id)).toBe(today);
    expect(p.dates.get(ordinary.id)).toBe(today);
  });
  it('上次完成早于昨天的任务优先，昨天完成的任务即使周期到期也不能插队', () => {
    const older = task('older', { content: '(30m)', repeatFlag: 'RRULE:FREQ=MONTHLY', dueDate: '2026-10-10T00:00:00+0800' });
    const recent = task('recent', { content: '(30m)', repeatFlag: 'RRULE:FREQ=DAILY' });
    const s = state([done(older, '2026-09-20', 'old-occurrence'), done(recent, '2026-10-03', 'recent-occurrence')]);
    const p = run([recent, older], { state: s, budgetMinutes: 30 });
    expect(p.dates.get(older.id)).toBe(today);
    expect(p.dates.get(recent.id)).toBe('2026-10-05');
    expect(s.briefing!.selected[0].reasons).toContain('按上次实际完成时间排序，最久没做的优先');
  });
  it('无完成记录的任务不能把创建时间当完成时间，母任务与子任务各自参与轮换', () => {
    const parent = task('parent', { content: '(15m)', createdTime: `${today}T00:00:00+0800` });
    const child = task('child', { parentId: parent.id, content: '(15m)', createdTime: `${today}T00:00:00+0800` });
    const recent = task('recent', { content: '(1m)' });
    const s = state([done(recent, '2026-10-03')]);
    const p = run([recent, child, parent], { state: s, budgetMinutes: 30 });
    expect(s.briefing!.selected.map(t => t.id).sort()).toEqual(['child', 'parent']);
    expect(p.dates.get(recent.id)).toBe('2026-10-05');
  });
  it('更久没做的任务装不下时宁可留空，不用昨天刚完成的短任务填空', () => {
    const first = task('first', { content: '(25m)' });
    const waiting = task('waiting', { content: '(10m)' });
    const recent = task('recent', { content: '(1m)', repeatFlag: 'RRULE:FREQ=DAILY' });
    const s = state([done(first, '2026-09-01'), done(waiting, '2026-09-20'), done(recent, '2026-10-03')]);
    const p = run([recent, waiting, first], { state: s, budgetMinutes: 30 });
    expect(s.briefing!.selected.map(t => t.id)).toEqual(['first']);
    expect(p.dates.get(waiting.id)).toBe('2026-10-05');
    expect(p.dates.get(recent.id)).toBe('2026-10-05');
    expect(s.briefing!.breakdown?.unallocatedMinutes).toBe(5);
  });
  it('其他任务均已安排时仍可安排昨天完成的事项，场景互斥不造成虚假的积压', () => {
    const first = task('first', { content: '(25m)' });
    const recent = task('recent', { content: '(1m)' });
    const s = state([done(first, '2026-09-01'), done(recent, '2026-10-03')]);
    run([recent, first], { state: s, budgetMinutes: 30 });
    expect(s.briefing!.selected.map(t => t.id)).toEqual(['first', 'recent']);
    const mite = task('mite', { title: '除螨喷雾', content: '(1m)' });
    const fragrance = task('fragrance', { title: '香香喷雾', content: '(1m)' });
    const sprays = state([done(mite, '2026-09-01'), done(fragrance, '2026-09-20'), done(recent, '2026-10-03')]);
    run([recent, fragrance, mite], { state: sprays, budgetMinutes: 10 });
    expect(sprays.briefing!.selected.map(t => t.id)).toEqual(['mite', 'recent']);
  });
  it('当天不因完成任务无限补入，也不会把刚完成的重复任务拉回', () => {
    const t = task('repeat', { repeatFlag: 'RRULE:FREQ=DAILY' });
    const p = run([t, task('other')], { budgetMinutes: 30, state: state([done(t, today), done(task('another'), today)]) });
    expect(p.summary.todayCount).toBe(0);
    expect(p.dates.get(t.id)).toBe('2026-10-05');
  });
  it('同日重复规划稳定，延期不会重置原周期截止日', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task(String(i)));
    const s = state();
    const first = run(tasks, { state: s });
    const arranged = apply(tasks, first.dates);
    const second = run(arranged, { state: s });
    expect(apply(arranged, second.dates)).toEqual(arranged);
    expect(second.summary.plannedMinutes).toBe(first.summary.plannedMinutes);
    expect(s.deadlines['6'].date).toBe(today);
    run(apply(tasks, first.dates), { state: s, today: '2026-10-05' });
    expect(s.deadlines['6'].date).toBe(today);
  });
  it('同名不同清单或父任务不会混用完成历史，同系列取最新记录', () => {
    const t = task('a', { title: '喷雾', parentId: 'parent', repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const other = task('b', { title: '喷雾', projectId: 'other', repeatFlag: 'RRULE:FREQ=WEEKLY' });
    const s = state([done({ ...t, parentId: 'wrong' }, today, 'unrelated'), done(t, '2026-09-20', 'old'), done(t, '2026-09-27', 'new')]);
    const p = run([t, other], { state: s });
    expect(s.deadlines.a.date).toBe(today);
    expect(p.dates.get(t.id)).toBe(today);
  });
  it('明日事范围内的普通任务和无日期积压可以补入，超过30天的安排保留原日期', () => {
    const p = run([task('future', { dueDate: '2026-11-05T00:00:00+0800' }),
      task('tomorrow', { dueDate: '2026-10-05T00:00:00+0800' }), task('undated', { startDate: undefined, dueDate: undefined })]);
    expect(p.dates.has('future')).toBe(false);
    expect(p.dates.get('tomorrow')).toBe(today);
    expect(p.dates.get('undated')).toBe(today);
  });
  it('重复任务完成后使用 TickTick 更新的下一截止日，而不是从完成时间推算', () => {
    const eyeWash = task('eye-wash', { title: '洗眼睛', tags: ['at-least'], repeatFlag: 'RRULE:FREQ=DAILY', repeatFrom: '0',
      startDate: '2026-10-19T00:00:00+0800', dueDate: '2026-10-19T00:00:00+0800' });
    const s = state([done(eyeWash, '2026-10-05', 'completed-occurrence')]);
    const result = run([eyeWash], { state: s, today: '2026-10-09', now: new Date('2026-10-09T05:00:00+08:00') });
    expect(s.deadlines[eyeWash.id].date).toBe('2026-10-19');
    expect(result.dates.has(eyeWash.id)).toBe(false);
    expect(s.briefing!.selected).toEqual([]);
  });
  it('at-least 阻止入选时，不把过期任务只推进一天，而是直接推到最小间隔外', () => {
    // 任务上一次完成在 09-27，重复周期 7 天：最早可做日是 10-04，而当前日期 10-04
    // 其实已经到期。但为了模拟 at-least 还没到：把 today 提前到 10-03。
    const past = '2026-10-03';
    const eye = task('eye', { tags: ['at-least'], repeatFlag: 'RRULE:FREQ=WEEKLY',
      startDate: `${past}T00:00:00+0800`, dueDate: `${past}T00:00:00+0800` });
    const s = state([done(eye, '2026-09-30', 'cycle-1')]);
    const p = planTickTickDay({ tasks: [eye], state: s, today: past, timezone: 'Asia/Shanghai',
      now: new Date(`${past}T05:00:00+08:00`), calendarState: {}, budgetMinutes: 60 });
    // notBefore = 2026-10-07（上次完成 + 7 天）。原逻辑会推到 2026-10-04，这里应直接跳到 2026-10-07。
    expect(p.dates.get(eye.id)).toBe('2026-10-07');
    expect(s.briefing!.selected).toEqual([]);
  });
  it('at-least 任务已有的未来日期不会被重新规划往前拉', () => {
    // 回放用户“洗眼睛”场景：10-05 完成后 TickTick 已把下一截止日推到 10-19，
    // 10-06 的任何一次重新规划都不应把它拉回今天或明天。
    const eye = task('eye-wash', { title: '洗眼睛', tags: ['at-least'],
      repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=14', repeatFrom: '0',
      startDate: '2026-10-19T00:00:00+0800', dueDate: '2026-10-19T00:00:00+0800' });
    const s = state([done(eye, '2026-10-05', 'cycle-oct-5')]);
    const first = planTickTickDay({ tasks: [eye], state: s, today: '2026-10-06',
      timezone: 'Asia/Shanghai', now: new Date('2026-10-06T01:37:00+08:00'),
      calendarState: {}, budgetMinutes: 60 });
    expect(first.dates.has(eye.id)).toBe(false);
    expect(s.deadlines[eye.id].date).toBe('2026-10-19');
    const second = planTickTickDay({ tasks: [eye], state: s, today: '2026-10-06',
      timezone: 'Asia/Shanghai', now: new Date('2026-10-06T10:15:00+08:00'),
      calendarState: {}, budgetMinutes: 60 });
    expect(second.dates.has(eye.id)).toBe(false);
    expect(s.deadlines[eye.id].date).toBe('2026-10-19');
  });
  it('周期计算覆盖自然月和每周指定日，用时优先取显式信息', () => {
    expect(cycleEnd(task('x', { repeatFlag: 'RRULE:FREQ=WEEKLY' }), '2026-09-27')).toBe(today);
    expect(cycleEnd(task('x', { repeatFlag: 'RRULE:FREQ=MONTHLY' }), '2026-09-04')).toBe(today);
    expect(cycleEnd(task('x', { repeatFlag: 'LUNAR:FREQ=YEARLY' }), today)).toBeNull();
    expect(estimateTaskMinutes(task('x', { title: '学习 25分钟' }))).toBe(25);
    expect(estimateTaskMinutes(task('x', { title: '看剧📺15m', priority: 5 }))).toBe(15);
    expect(estimateTaskMinutes(task('x', { title: '签到', priority: 5 }))).toBe(5);
    expect(estimateTaskMinutes(task('x', { priority: 5 }))).toBe(15);
    expect(estimateTaskMinutes(task('x', { title: '洗衣服' }))).toBe(50);
    expect(estimateTaskMinutes(task('x', { title: '洗衣服', content: '（1h1m）' }))).toBe(61);
  });
  it('完成记录读取失败时不推进检查点，成功后保留过去已知最后完成', async () => {
    const s = state([done(task('old'), '2020-01-01')]);
    const api = { listCompletedTasks: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as TickTickApi;
    await expect(refreshDailyHistory(api, [task('recent')], s, new Date('2026-10-04T10:00:00Z'))).rejects.toThrow('offline');
    expect(s.historyThrough).toBeUndefined();
    vi.mocked(api.listCompletedTasks).mockResolvedValue([done(task('recent'), today)]);
    await refreshDailyHistory(api, [task('recent')], s, new Date('2026-10-04T10:00:00Z'));
    expect(s.history.map((t) => t.id)).toContain('old');
    expect(s.historyThrough).toBe('2026-10-04T10:00:00.000Z');
  });
  it('完成快照保留充电周期和地点，后续缺失字段不抹去已知配置', async () => {
    const active = task('charge', { title: '电动车充电', tags: ['北京'], repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=6', repeatFrom: '1', timeZone: 'Asia/Shanghai', reminders: ['TRIGGER:PT0S'] });
    const row = { ...done(active, today, 'completed-charge'), repeatFlag: undefined, repeatFrom: undefined, timeZone: undefined, reminders: undefined, tags: undefined };
    const api = { listCompletedTasks: vi.fn().mockResolvedValue([row]) } as unknown as TickTickApi;
    const s = state();
    await refreshDailyHistory(api, [active], s, new Date('2026-10-04T10:00:00Z'));
    await refreshDailyHistory(api, [], s, new Date('2026-10-04T11:00:00Z'));
    expect(s.history[0]).toMatchObject({ id: 'completed-charge', repeatFlag: active.repeatFlag, repeatFrom: '1', tags: ['北京'], timeZone: 'Asia/Shanghai', reminders: ['TRIGGER:PT0S'] });
  });
  it('与场景排期整合后只写最终日期，二次同步不往返改期', async () => {
    const original = task('scene', { tags: ['居'], title: '任务 15分钟', dueDate: '2026-10-05T00:00:00+0800', startDate: '2026-10-05T00:00:00+0800' });
    const api = { listProjects: async () => [], filterTasks: async () => [original], getProjectData: async () => ({ tasks: [original] }),
      listCompletedTasks: async () => [], updateTask: vi.fn(), getTask: async () => original } as unknown as TickTickApi;
    const s = state();
    for (let i = 0; i < 2; i++) await syncTickTickRoutines({ api, today, calendarState: { tagMap: { [today]: 'school', '2026-10-05': 'school' } },
      planDay: async (tasks) => run(tasks, { state: s, budgetMinutes: 10, calendarState: { tagMap: { [today]: 'school', '2026-10-05': 'school' } } }).dates });
    expect(api.updateTask).not.toHaveBeenCalled();
  });
});

describe('TickTick 明确限流', () => {
  it('等待后重试明确的查询限流，普通错误不重放', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{"errorCode":"exceed_query_limit"}', { status: 500 }))
        .mockResolvedValueOnce(new Response('[]'));
      const api = new TickTickOpenApiClient('token', 'https://ticktick.test', fetcher);
      const pending = api.listProjects();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      fetcher.mockResolvedValueOnce(new Response('internal error', { status: 500 }));
      await expect(api.listProjects()).rejects.toThrow('TickTick 500');
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
