import { describe, it, expect, vi } from 'vitest';
import { syncEyeDrops } from './_ticktickEyeDrops';
import { syncTickTickAlwaysToday, syncTickTickRoutines, type TickTickApi, type TickTickTask } from './_ticktickTrips';
import { planTickTickDay } from './_ticktickDailyPlan';
vi.mock('@vercel/kv', () => ({ kv: { get: async () => null, hgetall: async () => null, set: async () => 'OK', eval: async () => 1 } }));
const now = new Date('2026-11-03T21:00:00+08:00');
const task = (id: string, hour: string, extra: Partial<TickTickTask> = {}): TickTickTask => ({
  id, projectId: 'life', title: '眼药水', priority: 5, status: 0, isAllDay: false, timeZone: 'Asia/Shanghai',
  startDate: `2026-11-03T${hour}:00:00+08:00`, dueDate: `2026-11-03T${hour}:05:00+08:00`,
  repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=1', repeatFrom: '0', tags: [], reminders: ['TRIGGER:PT0S'], ...extra });
function fixture(tasks: TickTickTask[]) {
  const saved = new Map(tasks.map(t => [t.id, structuredClone(t)]));
  const updateTask = vi.fn(async (id: string, payload: Record<string, unknown>) => {
    saved.set(id, { ...saved.get(id)!, ...structuredClone(payload) }); return saved.get(id)!;
  });
  const api = { getTask: vi.fn(async (_: string, id: string) => structuredClone(saved.get(id)!)), updateTask,
    listProjects: async () => [{ id: 'life', name: '生活' }],
    getProjectData: async () => ({ tasks: structuredClone([...saved.values()]) }),
    filterTasks: async () => structuredClone([...saved.values()]), listCompletedTasks: async () => [],
  } as unknown as TickTickApi;
  return { api, saved, updateTask };
}
describe('眼药水只保留最近一次', () => {
  it('固定今日按北京日对齐 UTC 时区的眼药水，保留凌晨原时刻', async () => {
    const tasks = [task('early', '00', { startDate: undefined, dueDate: '2026-11-02T16:05:00Z', timeZone: 'UTC', tags: ['always-today'] })];
    const f = fixture(tasks);
    await syncTickTickAlwaysToday(f.api, { tasks, today: '2026-11-03' });
    expect(f.updateTask).not.toHaveBeenCalled();
    await syncTickTickAlwaysToday(f.api, { tasks, today: '2026-11-04' });
    expect(f.saved.get('early')!.dueDate).toBe('2026-11-03T16:05:00Z');
  });
  it('只比较北京时间今天已到期的条目，只有一条时不写入', async () => {
    const tasks = [
      task('yesterday', '23', { startDate: undefined, dueDate: '2026-11-02T15:59:00Z' }),
      task('morning', '00', { startDate: undefined, dueDate: '2026-11-02T16:00:00Z' }),
      task('noon', '13', { dueDate: '2026-11-03T13:00:00+08:00' }),
    ];
    const f = fixture(tasks);
    expect(await syncEyeDrops(f.api, tasks, new Date('2026-11-03T12:00:00+08:00'))).toEqual({ skipped: 0 });
    expect(f.updateTask).not.toHaveBeenCalled();
    expect(await syncEyeDrops(f.api, tasks, new Date('2026-11-03T13:00:00+08:00'))).toEqual({ skipped: 1 });
    expect(f.updateTask.mock.calls.map(([id]) => id)).toEqual(['morning']);
    expect(f.saved.get('morning')!.dueDate).toBe('2026-11-03T16:00:00.000Z');
  });
  it('跳过较早的四项且连续执行不再推迟，保留提醒和重复规则', async () => {
    const tasks = ['10','13','15','17','20'].map(h => task(h,h)); const f = fixture(tasks);
    expect(await syncEyeDrops(f.api, tasks, now)).toEqual({ skipped: 4 });
    expect(f.saved.get('20')).toEqual(task('20','20'));
    expect(f.saved.get('10')).toEqual({ ...task('10','10'), startDate: '2026-11-04T02:00:00.000Z', dueDate: '2026-11-04T02:05:00.000Z' });
    expect(await syncEyeDrops(f.api, structuredClone([...f.saved.values()]), now)).toEqual({ skipped: 0 });
    expect(f.updateTask).toHaveBeenCalledTimes(4);
  });
  it('不改未来、已完成、隐藏、routine、低优先级、其他名称或非重复项', async () => {
    const tasks = [task('keep','20'), task('future','22'), task('done','10',{status:2}), task('hidden','10',{tags:['hidden']}),
      task('routine','10',{tags:['routine']}), task('low','10',{priority:3}), task('other','10',{title:'眼药水眼膏过期'}), task('once','10',{repeatFlag:undefined})];
    const f=fixture(tasks); expect(await syncEyeDrops(f.api,tasks,now)).toEqual({skipped:0}); expect(f.updateTask).not.toHaveBeenCalled();
  });
  it('保留项被用户修改时停止，不盲目推进其他任务', async () => {
    const tasks=[task('old','10'),task('keep','20')]; const f=fixture(tasks); f.saved.get('keep')!.status=2;
    await expect(syncEyeDrops(f.api,tasks,now)).rejects.toThrow('已变化'); expect(f.updateTask).not.toHaveBeenCalled();
  });
  it('有限次数和结束日期不猜测剩余次数', async () => {
    for (const extra of [{repeatFlag:'RRULE:FREQ=DAILY;COUNT=5'},{repeatFlag:'RRULE:FREQ=DAILY;UNTIL=20261110T000000Z'}]) {
      const tasks=[task('old','10',extra),task('keep','20')]; const f=fixture(tasks);
      await expect(syncEyeDrops(f.api,tasks,now)).rejects.toThrow('不支持'); expect(f.updateTask).not.toHaveBeenCalled();
    }
  });
  it('完成一天后重复的过期项可以跳过，保留重复基准且不写完成状态', async () => {
    const tasks = ['10','13','15','17','20'].map(h => task(h,h,{repeatFrom:'1',tags:['always-today','at-least','当天','活']}));
    const f=fixture(tasks);
    expect(await syncEyeDrops(f.api,tasks,now)).toEqual({skipped:4});
    expect(f.saved.get('20')).toEqual(task('20','20',{repeatFrom:'1',tags:['always-today','at-least','当天','活']}));
    expect(f.saved.get('15')!.dueDate).toBe('2026-11-04T07:05:00.000Z');
    for(const [id,payload] of f.updateTask.mock.calls) {
      expect(payload.repeatFrom).toBe('1'); expect(payload.repeatFlag).toBe(task(id,id).repeatFlag);
      expect(payload).not.toHaveProperty('status'); expect(payload).not.toHaveProperty('completedTime');
      expect(payload.tags).toEqual(['always-today','at-least','当天','活']);
    }
    expect(await syncEyeDrops(f.api,structuredClone([...f.saved.values()]),now)).toEqual({skipped:0});
    expect(f.updateTask).toHaveBeenCalledTimes(4);
  });
  it('跳过后固定今日、场景同步、普通补入均不能拉回，下一天自然到期', async () => {
    const tasks=[task('old','10',{tags:['always-today','居']}),task('keep','20')]; const f=fixture(tasks);
    await syncEyeDrops(f.api,tasks,now);
    const calendarState={tagMap:{'2026-11-03':'school','2026-11-04':'school'}};
    await syncTickTickAlwaysToday(f.api,{tasks:[...f.saved.values()],today:'2026-11-03',calendarState});
    await syncTickTickRoutines({api:f.api,calendarState,today:'2026-11-03'});
    expect(f.saved.get('old')!.dueDate).toBe('2026-11-04T02:05:00.000Z');
    const plan=planTickTickDay({tasks:[...f.saved.values()],calendarState,today:'2026-11-03',now,
      state:{history:[],deadlines:{}},budgetMinutes:240});
    expect(plan.dates.has('old')).toBe(false);
    expect(await syncEyeDrops(f.api,[...f.saved.values()],new Date('2026-11-04T11:00:00+08:00'))).toEqual({skipped:0});
    expect(f.saved.get('old')!.dueDate).toBe('2026-11-04T02:05:00.000Z');
  });
});
