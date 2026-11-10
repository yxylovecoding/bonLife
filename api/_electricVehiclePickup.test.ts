import { beforeEach, expect, it, vi } from 'vitest';
import { syncElectricVehiclePickup } from './_electricVehiclePickup';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';
import { BEIJING, GUANGZHOU, resolveCalendarState } from '../src/utils/internship';
import { restoreMissingChargingTask } from './_electricVehicleCharging';
const outlook = vi.hoisted(() => vi.fn().mockResolvedValue({ enabled: true, created: 0, updated: 0 }));
vi.mock('./_outlookRecurringTaskEvents.js', () => ({ syncRecurringTaskOutlook: outlook }));
let tasks: TickTickTask[], api: TickTickApi;
const charge = (): TickTickTask => ({ id: 'charge', projectId: 'life', title: '电动车充电', status: 0, isAllDay: true, dueDate: '2026-11-02T00:00:00+0800' });
beforeEach(() => {
 tasks = [charge()]; outlook.mockClear();
 api = { getTask: vi.fn(async (_p, id) => structuredClone(tasks.find(t => t.id === id)!)),
 createTask: vi.fn(async payload => { const t = { ...payload, id: `pickup-${tasks.length}` } as TickTickTask; tasks.push(t); return structuredClone(t); }),
 updateTask: vi.fn(async (id, payload) => { const t = tasks.find(t => t.id === id)!; Object.assign(t, payload); return structuredClone(t); }),
 deleteTask: vi.fn(async (_project, id) => { tasks = tasks.filter(t => t.id !== id); }),
 } as unknown as TickTickApi;
});
const sync = (history: TickTickTask[] = [], excludedTaskIds = new Set<string>()) => syncElectricVehiclePickup(api, {
 tasks: structuredClone(tasks), history, excludedTaskIds, today: '2026-11-02', ticktickConnectionId: 'connection',
});
it('创建次日接车并重复运行不复制，Outlook 使用同一待办', async () => {
 expect(await sync()).toMatchObject({ created: 1 });
 expect(tasks[1]).toMatchObject({ title: '接电动车', startDate: '2026-11-03T07:20:00+0800', dueDate: '2026-11-03T07:40:00+0800', tags: ['当天', '活'] });
 expect(tasks[0].tags).toEqual(['当天']);
 expect(await sync()).toMatchObject({ created: 0, updated: 0 });
 expect(api.createTask).toHaveBeenCalledTimes(1);
 const args = outlook.mock.calls.at(-1)!;
 expect(args[1].tasks[0].id).toBe(tasks[1].id);
 expect(args[2].plan(tasks[1])).toMatchObject({ start: { dateTime: '2026-11-03T07:20:00' }, end: { dateTime: '2026-11-03T07:40:00' } });
});
it('同周期改期更新原待办并保留标签', async () => {
 await sync(); tasks[1].tags = ['routine']; tasks[0].startDate = '2026-11-04T20:00:00+0800'; tasks[0].dueDate = '2026-11-04T21:00:00+0800';
 expect(await sync()).toMatchObject({ created: 0, updated: 2 });
 expect(tasks[1]).toMatchObject({ tags: ['routine', '当天'], startDate: '2026-11-05T07:20:00+0800' });
});
it('接车已完成不补建', async () => {
 const done = { id: 'done', projectId: 'life', title: '接电动车', status: 2, dueDate: '2026-11-03T07:40:00+0800' };
 expect(await sync([done])).toMatchObject({ created: 0 });
});
it('模板后代不创建接车', async () => {
 tasks[0].parentId = 'template'; await sync([], new Set(['template'])); expect(api.createTask).not.toHaveBeenCalled();
});
it('充电完成后新周期不覆盖上一周期待接车辆', async () => {
 await sync(); const old = structuredClone(tasks[1]);
 const history = [{ ...tasks[0], status: 2, completedTime: '2026-11-02T12:00:00Z' }];
 tasks[0].dueDate = '2026-11-07T00:00:00+0800';
 await sync(history); expect(tasks.find(t => t.id === old.id)?.startDate).toBe(old.startDate);
 expect(tasks.filter(t => t.title === '接电动车')).toHaveLength(1);
});
it('已完成充电仍补齐次日接车', async () => {
 tasks = [];
 expect(await sync([{ ...charge(), status: 2, completedTime: '2026-11-01T12:00:00Z' }])).toMatchObject({ created: 1 });
});
it('充电完成记录更换 ID 后沿用同周期接车，按实际完成日安排', async () => {
 const previous = { ...charge(), id: 'previous', status: 2, completedTime: '2026-10-26T14:27:13.000+0000' };
 tasks[0].dueDate = '2026-11-01T20:00:00+0800';
 await sync([previous]);
 const pickupId = tasks[1].id;
 tasks[1].content = tasks[1].content!.replace(/\\n/g, '\n');
 tasks[1].tags = ['居', '北京'];
 const completed = { ...tasks[0], id: 'completed-charge', status: 2, completedTime: '2026-11-02T05:27:36.000+0000' };
 tasks[0].dueDate = '2026-11-08T20:00:00+0800';
 await sync([previous, completed]);
 expect(tasks.find(t => t.id === pickupId)).toMatchObject({ startDate: '2026-11-03T07:20:00+0800', tags: ['居', '北京', '当天'] });
 expect(tasks.filter(t => t.title === '接电动车')).toHaveLength(1);
});
it('跨日延期仍更新同周期原接车而不遗留逾期待办', async () => {
 await sync(); const id = tasks[1].id;
 tasks[0].startDate = '2026-11-05T20:00:00+0800'; tasks[0].dueDate = '2026-11-05T21:00:00+0800';
 const result = await syncElectricVehiclePickup(api, { tasks: structuredClone(tasks), history: [], excludedTaskIds: new Set(), today: '2026-11-05', ticktickConnectionId: 'connection', mode: 'tasks' });
 expect(result).toMatchObject({ created: 0, updated: 1 });
 expect(tasks.find(t => t.id === id)?.startDate).toBe('2026-11-06T07:20:00+0800');
});
it('同次完成产生的两个自动接车合并，保留用户标签和备注', async () => {
 const previous = { ...charge(), id: 'previous', status: 2, completedTime: '2026-10-26T14:27:13.000+0000' };
 const completed = { ...charge(), id: 'completed-charge', status: 2, completedTime: '2026-11-02T05:27:36.000+0000' };
 tasks[0].dueDate = '2026-11-08T20:00:00+0800';
 tasks.push({ id: 'original', projectId: 'life', title: '接电动车', status: 0, tags: ['居', '北京'], content: '(20m)\n带钥匙\nBonBills charging pickup: life/charge/2026-10-26T14:27:13.000+0000', startDate: '2026-11-02T07:20:00+0800', dueDate: '2026-11-02T07:40:00+0800' });
 tasks.push({ id: 'duplicate', projectId: 'life', title: '接电动车', status: 0, priority: 5, isAllDay: false, tags: [], content: '(20m)\nBonBills charging pickup: life/completed-charge/2026-10-26T14:27:13.000+0000', startDate: '2026-11-03T07:20:00+0800', dueDate: '2026-11-03T07:40:00+0800' });
 await sync([previous, completed]);
 expect(tasks.find(t => t.id === 'original')).toMatchObject({ startDate: '2026-11-03T07:20:00+0800', tags: ['居', '北京', '当天'], content: expect.stringContaining('带钥匙') });
 expect(tasks.some(t => t.id === 'duplicate')).toBe(false);
 expect(tasks.filter(t => t.title === '接电动车')).toHaveLength(1);
 expect(await sync([previous, completed])).toMatchObject({ created: 0, updated: 0, deleted: 0 });
});
it('北京时间凌晨完成的延期充电按完成日次日接车', async () => {
 tasks = [];
 await sync([{ ...charge(), dueDate: '2026-11-01T20:00:00+0800', status: 2, completedTime: '2026-11-01T16:10:00Z' }]);
 expect(tasks[0].startDate).toBe('2026-11-03T07:20:00+0800');
});
it('用户编辑过的两个接车不会自动删除', async () => {
 await sync();
 tasks[1].tags = ['居'];
 tasks.push({ ...tasks[1], id: 'edited-copy', content: tasks[1].content + '\n自定义备注' });
 await expect(sync()).rejects.toThrow('接电动车存在多个待办');
 expect(api.deleteTask).not.toHaveBeenCalled();
});
it('现有充电与接车补当天但保留日期、重复规则和其他标签，完成记录和模板不改', async () => {
 tasks = [
   { ...charge(), dueDate: undefined, tags: ['居', 'routine'], repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=6' },
   { ...charge(), id: 'manual-pickup', title: '接电动车', tags: ['北京', 'hidden'], dueDate: '2027-02-02T07:40:00+0800', reminders: ['TRIGGER:PT0S'] },
   { ...charge(), id: 'done', status: 2, completedTime: '2026-11-02T01:00:00Z', tags: ['居'] },
   { ...charge(), id: 'template-child', parentId: 'template', tags: [] },
 ];
 const before = structuredClone(tasks);
 await sync([], new Set(['template']));
 expect(tasks).toEqual(before.map((task, i) => i < 2 ? { ...task, tags: [...task.tags!, '当天'] } : task));
 vi.mocked(api.updateTask).mockClear();
 expect(await sync([], new Set(['template']))).toMatchObject({ created: 0, updated: 0, deleted: 0 });
 expect(api.updateTask).not.toHaveBeenCalled();
});
it('自带当天标签的自动接车副本仍按同周期去重', async () => {
 await sync();
 tasks.push({ ...structuredClone(tasks[1]), id: 'copy', tags: ['当天', 'hidden'] });
 expect(await sync()).toMatchObject({ created: 0, deleted: 1 });
 expect(tasks.filter(task => task.title === '接电动车')).toHaveLength(1);
 expect(tasks[1].tags).toEqual(['当天', '活']);
});
it('Outlook 阶段只读待办，不补标签或改动任务', async () => {
 await sync(); tasks.forEach(task => { task.tags = []; });
 vi.mocked(api.updateTask).mockClear();
 await syncElectricVehiclePickup(api, { tasks, history: [], excludedTaskIds: new Set(), today: '2026-11-02', ticktickConnectionId: 'connection', mode: 'outlook' });
 expect(api.updateTask).not.toHaveBeenCalled();
 expect(tasks.every(task => !task.tags?.length)).toBe(true);
});

it.each(['接电动车', '借电动车'])('优先改已有的 %s，不要求关联标记、同清单或相同日期', async title => {
 tasks.push({ id: 'original', projectId: 'other', title, status: 0, isAllDay: false,
   startDate: '2026-10-28T08:10:05+0800', dueDate: '2026-10-28T08:35:05+0800',
   tags: ['北京', 'routine', '活'], content: '记得钥匙', reminders: ['TRIGGER:PT0S'],
   repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=6', repeatFrom: '1', priority: 5 });
 const original = structuredClone(tasks[1]);
 expect(await sync()).toMatchObject({ created: 0 });
 expect(tasks[1]).toMatchObject({ ...original, startDate: '2026-11-03T08:10:05+0800', dueDate: '2026-11-03T08:35:05+0800',
   tags: [...original.tags!, '当天'], content: expect.stringContaining('记得钥匙') });
 expect(api.createTask).not.toHaveBeenCalled();
 expect(await sync()).toMatchObject({ created: 0, updated: 0 });
});

it('现有充电保留开始秒数和地点，只把结束调为一小时，重复运行不再写入', async () => {
 tasks[0] = { ...charge(), isAllDay: false, startDate: '2027-02-12T20:00:55+0800', dueDate: '2027-02-12T20:30:55+0800',
   content: '(1h)', tags: ['北京', '当天', 'hidden', '活'], reminders: ['TRIGGER:-PT0S'], repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=6', repeatFrom: '1' };
 const original = structuredClone(tasks[0]);
 await sync();
 expect(tasks[0]).toEqual({ ...original, dueDate: '2027-02-12T21:00:55+0800' });
 expect(tasks[1].startDate).toBe('2027-02-13T07:20:00+0800');
 expect(await sync()).toMatchObject({ created: 0, updated: 0 });
});

const restore = (history: TickTickTask[], calendarState: unknown) => restoreMissingChargingTask(api, {
 tasks: structuredClone(tasks), history, calendarState, today: '2026-11-02', now: new Date('2026-11-02T12:00:00+08:00'), excluded: () => false,
});
const chargingHistory = (): TickTickTask[] => [{ ...charge(), status: 2, completedTime: '2026-10-26T14:00:00Z',
 isAllDay: false, startDate: '2026-10-26T20:00:55+0800', dueDate: '2026-10-26T20:30:55+0800',
 repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=6', repeatFrom: '1', tags: ['北京', '居', 'routine'], reminders: ['TRIGGER:PT0S'], content: '(1h)' }];
const vehicleCalendar = () => resolveCalendarState({ config: { schoolCity: BEIJING, homeCity: GUANGZHOU } }, {
 tagMap: { '2026-11-02': 'home', '2027-02-12': 'school' },
});
it('缺充电待办时沿用最近实际完成的六天周期和地点，补一小时且自带当天活', async () => {
 tasks = [];
 const restored = await restore(chargingHistory(), vehicleCalendar());
 expect(restored).toMatchObject({ title: '电动车充电', startDate: '2027-02-12T20:00:55+0800', dueDate: '2027-02-12T21:00:55+0800',
   repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=6', repeatFrom: '1', tags: ['北京', '居', '当天', '活'], reminders: ['TRIGGER:PT0S'] });
 expect(await restore(chargingHistory(), vehicleCalendar())).toBeNull();
 expect(api.createTask).toHaveBeenCalledTimes(1);
});
it('缺充电待办的周期尚未到期时不会提前到今天', async () => {
 tasks = []; const history = chargingHistory(); history[0].completedTime = '2026-10-30T14:00:00Z'; history[0].tags = [];
 expect(await restore(history, {})).toMatchObject({ startDate: '2026-11-05T20:00:55+0800', dueDate: '2026-11-05T21:00:55+0800' });
});
it('旧清单的充电记录不影响采用最近实际完成的周期', async () => {
 tasks = [];
 const latest = chargingHistory(); latest[0].tags = [];
 const older = { ...latest[0], id: 'older', projectId: 'old-list', completedTime: '2026-10-20T14:00:00Z', repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=3' };
 expect(await restore([...latest, older], {})).toMatchObject({ projectId: 'life', repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=6' });
});
it('没有可靠周期或地点来源不猜测补建，新出现的充电待办也优先复用', async () => {
 tasks = [];
 expect(await restore(chargingHistory(), undefined)).toBeNull();
 expect(await restore(chargingHistory().map(t => ({ ...t, repeatFlag: undefined })), vehicleCalendar())).toBeNull();
 api.filterTasks = vi.fn().mockResolvedValue([charge()]);
 expect(await restore(chargingHistory(), vehicleCalendar())).toBeNull();
 expect(api.createTask).not.toHaveBeenCalled();
});
