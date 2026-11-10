import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BEIJING, GUANGZHOU, DEFAULT_INTERNSHIP_RULES } from '../src/utils/internship';
import { laundryEventPlan, LAUNDRY_EVENT_PROPERTY, syncLaundryOutlook } from './_outlookLaundry';
import { chargingEventPlan, syncChargingOutlook } from './_outlookCharging';
import { hairWashEventPlan, syncHairWashOutlook } from './_outlookHairWash';
import { syncElectricVehiclePickup } from './_electricVehiclePickup';
import { OUTLOOK_WRITE_KEY, sealOutlookWrite } from './_outlookWrite';
import { LAUNDRY_STATE_KEY } from './_ticktickLaundry';
import type { TickTickApi, TickTickTask } from './_ticktickTrips';
const { data } = vi.hoisted(() => ({ data: new Map<string, any>() }));
vi.mock('@vercel/kv', () => ({ kv: {
  get: async (key: string) => structuredClone(data.get(key) ?? null),
  set: async (key: string, value: any, options?: { nx?: boolean }) => { if (options?.nx && data.has(key)) return null; data.set(key, structuredClone(value)); return 'OK'; },
  eval: async (script: string, keys: string[], args: string[]) => { if (script.includes('zcard')) return 1; if (data.get(keys[0]) !== args[0]) return 0; if (script.includes("'del'")) data.delete(keys[0]); return 1; },
} }));
let task: TickTickTask;
let events: Map<string, any>;
let writes: { method: string; body: any; headers: any }[];
let loseCreateResponse: boolean;
let rejectPatch: boolean;
const api = { getTask: vi.fn(async () => structuredClone(task)) } as unknown as TickTickApi;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const options = () => ({ tasks: [task], managedTaskIds: new Set(['wash']), ticktickConnectionId: 'tick', today: '2026-10-05',
  now: new Date('2026-10-05T04:00:00Z'),
  configState: { config: { schoolCity: { name: '北京', latitude: 39.9, longitude: 116.4 } } }, plannedDates: { wash: task.startDate!.slice(0, 10) } });
function cycle(completion = '2026-10-05T03:56:00Z') {
  data.set(LAUNDRY_STATE_KEY, { connectionId: 'tick', anchors: { wash: { projectId: 'life', repeatFlag: task.repeatFlag, completion, target: '2026-10-10' } } });
}
beforeEach(() => {
  vi.stubEnv('SYNC_SECRET', 'test'); data.clear(); events = new Map(); writes = []; loseCreateResponse = false; rejectPatch = false;
  task = { id: 'wash', projectId: 'life', title: '洗衣服', status: 0, startDate: '2026-10-08T00:00:00Z', dueDate: '2026-10-08T01:00:00Z',
    isAllDay: false, timeZone: 'Asia/Shanghai', repeatFlag: 'RRULE:FREQ=DAILY;INTERVAL=5', content: '（1h1m）' };
  vi.mocked(api.getTask).mockReset().mockImplementation(async () => structuredClone(task)); cycle();
  data.set(OUTLOOK_WRITE_KEY, { id: 'outlook', clientId: 'app', calendarId: 'calendar', calendarName: '日历',
    encrypted: sealOutlookWrite({ access_token: 'ACCESS', refresh_token: 'REFRESH', expiresAt: Date.now() + 3600000 }) });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? 'GET';
    expect(url.origin).toBe('https://graph.microsoft.com');
    if (method === 'POST') {
      const body = JSON.parse(init.body as string), id = `event-${events.size + 1}`;
      const event = { ...body, id, type: 'singleInstance', '@odata.etag': 'v1' }; events.set(id, event); writes.push({ method, body, headers: init.headers });
      if (loseCreateResponse) { loseCreateResponse = false; throw new TypeError('connection lost after write'); }
      return json(event, 201);
    }
    const id = url.pathname.split('/').at(-1)!;
    if (method === 'DELETE') {
      writes.push({ method, body: { id }, headers: init.headers });
      if (rejectPatch) return json({}, 412);
      events.delete(id); return new Response(null, { status: 204 });
    }
    if (method === 'PATCH') {
      writes.push({ method, body: JSON.parse(init.body as string), headers: init.headers });
      if (rejectPatch) return json({}, 412);
      const event = { ...events.get(id), ...JSON.parse(init.body as string), '@odata.etag': 'v2' }; events.set(id, event); return json(event);
    }
    if (id === 'events') {
      const subject = url.searchParams.get('$filter')?.match(/^subject eq '(.+)'$/)?.[1];
      return json({ value: [...events.values()].filter(event => event.subject === subject) });
    }
    return events.has(id) ? json(events.get(id)) : json({}, 404);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function makeRelay() {
  const upstream = globalThis.fetch;
  const relay = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string);
    const response = await upstream(`https://graph.microsoft.com${input.path}`, { method: input.method, body: input.body || undefined,
      headers: Object.fromEntries(input.headers.map((header: { key: string; value: string }) => [header.key, header.value])) });
    return json({ protocol: 'bonbills-outlook-v1', status: response.status, body: response.status === 204 ? undefined : await response.json() });
  });
  vi.stubGlobal('fetch', relay);
  data.set(OUTLOOK_WRITE_KEY, { ...data.get(OUTLOOK_WRITE_KEY), provider: 'make',
    encrypted: sealOutlookWrite({ webhookUrl: 'https://hook.eu1.make.com/0123456789abcdef0123456789abcdef' }) });
  return relay;
}
it('合并接车待办时清理关联的未来预约副本，重复同步不调用 Outlook', async () => {
  task = { ...task, title: '接电动车', repeatFlag: undefined, content: '(20m)\nBonBills charging pickup: life/charge/initial' };
  const sync = () => syncElectricVehiclePickup(api, { ...options(), history: [], excludedTaskIds: new Set(), mode: 'outlook' });
  await sync();
  task.id = 'duplicate';
  await sync();
  expect(events.size).toBe(2);
  task.id = 'wash'; task.content += '\nBonBills pickup merged: life/duplicate';
  expect((await sync()).outlook).toMatchObject({ deleted: 1, created: 0 });
  expect(events.size).toBe(1);
  expect(events.has('event-1')).toBe(true);
  vi.mocked(fetch).mockClear();
  await sync();
  expect(fetch).not.toHaveBeenCalled();
});
it('采用 TickTick 具体时刻和固定50分钟；首轮创建、重复同步无重复、改期更新同一条', async () => {
  expect(laundryEventPlan(task, '2026-10-05', '北京')).toMatchObject({ start: { dateTime: '2026-10-08T08:00:00' }, end: { dateTime: '2026-10-08T08:50:00' } });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 1, updated: 0 });
  expect(writes[0].body).toMatchObject({ subject: '洗衣服', attendees: [], isReminderOn: false, location: { displayName: '北京' } });
  expect(writes[0].body).not.toHaveProperty('recurrence');
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 0 }); expect(writes).toHaveLength(1);
  task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 1 });
  expect(events.size).toBe(1); expect(writes[1].headers['If-Match']).toBe('v1');
});
it('创建请求响应丢失后通过稳定标识找回，下一实际完成周期才创建新日程', async () => {
  loseCreateResponse = true;
  expect(await syncLaundryOutlook(api, options())).toHaveProperty('error'); expect(events.size).toBe(1);
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 0 }); expect(writes).toHaveLength(1);
  cycle('2026-10-08T03:00:00Z'); task.startDate = task.dueDate = '2026-10-13T00:00:00Z';
  expect(await syncLaundryOutlook(api, { ...options(), today: '2026-10-08', now: new Date('2026-10-08T04:00:00Z') }))
    .toMatchObject({ created: 1 }); expect(events.size).toBe(2);
});
it('普通同名日程不被认领，待办改期才恢复缺失预约并使用新的幂等标识', async () => {
  events.set('manual', { id: 'manual', subject: '洗衣服', start: {}, end: {} });
  await syncLaundryOutlook(api, options()); expect(events.has('manual')).toBe(true); expect(events.size).toBe(2);
  events.delete('event-2');
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, skipped: 1 });
  task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 1 });
  await syncLaundryOutlook(api, options()); expect(writes).toHaveLength(2);
  expect(writes[1].body.transactionId).not.toBe(writes[0].body.transactionId);
  expect(events.size).toBe(2); expect(events.get('manual').start).toEqual({});
});
it('旧的已删除标记也可恢复；恢复响应丢失后找回，避免重复创建', async () => {
  await syncLaundryOutlook(api, options());
  const state = [...data.entries()].find(([key]) => key.startsWith('outlook:laundry-events:v1:'))![1];
  Object.values<any>(state.entries)[0].deleted = true;
  events.clear(); loseCreateResponse = true;
  expect(await syncLaundryOutlook(api, options())).toHaveProperty('error');
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0 });
  expect(events.size).toBe(1); expect(writes).toHaveLength(2);
});
it('旧ID失效但通过归属找到日程时更新原日程，不额外创建', async () => {
  await syncLaundryOutlook(api, options());
  const existing = events.get('event-1'); events.delete('event-1');
  events.set('moved', { ...existing, id: 'moved' });
  task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 1 });
  expect(events.size).toBe(1); expect(events.get('moved').start.dateTime).toBe('2026-10-09T08:00:00');
});
it('接管明确关联的已有洗衣事件，保留正文并转换为稳定归属，不重复创建', async () => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const key = hash('tick:life:wash:2026-10-05T03:56:00Z'), url = 'https://ticktick.com/webapp/#p/life/tasks/wash';
  const stateKey = `outlook:laundry-events:v1:${hash('calendar')}`;
  data.set(stateKey, { entries: { [key]: { eventId: 'from-connector', transactionId: key, adoptTaskUrl: url } } });
  const body = { content: `<${url}>\n\n` };
  events.set('from-connector', { id: 'from-connector', subject: '洗衣服', type: 'singleInstance', '@odata.etag': 'v1', attendees: [], body,
    start: { dateTime: '2026-10-08T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-08T00:15:00.0000000', timeZone: 'UTC' } });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 1 });
  expect(writes).toHaveLength(1); expect(writes[0].method).toBe('PATCH');
  expect(writes[0].body.singleValueExtendedProperties).toEqual([{ id: LAUNDRY_EVENT_PROPERTY, value: key }]);
  expect(events.get('from-connector').body).toEqual(body);
  expect(data.get(stateKey).entries[key]).not.toHaveProperty('adoptTaskUrl');
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 0 });
  expect(writes).toHaveLength(1);
});
it('参与人、错误归属及日程并发改动时不覆盖或发出邀请', async () => {
  await syncLaundryOutlook(api, options()); const event = events.get('event-1');
  event.attendees = [{ emailAddress: { address: 'someone@example.com' } }]; task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('参与人') }); expect(writes).toHaveLength(1);
  event.attendees = []; event.singleValueExtendedProperties = [{ id: LAUNDRY_EVENT_PROPERTY, value: 'someone-else' }];
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('修改') }); expect(writes).toHaveLength(1);
});
it('乐观锁失败保留事件，不自动重放写入', async () => {
  await syncLaundryOutlook(api, options()); rejectPatch = true; task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('412') });
  expect(writes).toHaveLength(2); expect(events.get('event-1').start.dateTime).toBe('2026-10-08T08:00:00');
});
it('写入前任务已完成或已改期则不写；未连接和无周期数据不写', async () => {
  const original = options(); task.startDate = task.dueDate = '2026-10-13T00:00:00Z';
  await syncLaundryOutlook(api, original); expect(writes).toHaveLength(0);
  vi.mocked(api.getTask).mockResolvedValueOnce(structuredClone(task)).mockResolvedValueOnce({ ...task, status: 2, completedTime: '2026-10-05T03:00:00Z' });
  await syncLaundryOutlook(api, options()); expect(writes).toHaveLength(0);
  data.delete(LAUNDRY_STATE_KEY); await syncLaundryOutlook(api, options()); expect(writes).toHaveLength(0);
  data.delete(OUTLOOK_WRITE_KEY); expect(await syncLaundryOutlook(api, options())).toMatchObject({ enabled: false });
});
it('只同步管理范围内未完成的洗衣；固定50分钟并拒绝历史日期', () => {
  expect(laundryEventPlan({ ...task, content: undefined }, '2026-10-05')?.end.dateTime).toBe('2026-10-08T08:50:00');
  expect(laundryEventPlan(task, '2026-10-09')).toBeNull();
  expect(laundryEventPlan({ ...task, title: '除螨喷雾' }, '2026-10-05')).toBeNull();
  expect(laundryEventPlan({ ...task, tags: ['不关我事'] }, '2026-10-05')).toBeNull();
});
it.each([
  { content: '(15m)' },
  { content: '(1h1m)' },
  { content: undefined, desc: '(15m)' },
  { content: undefined, tags: ['(15m)'] },
  { content: undefined, dueDate: '2026-10-08T00:15:00Z' },
  { content: '(15m)', isAllDay: true },
])('待办估时或起止区间不改变 Outlook 的50分钟：%j', fields => {
  expect(laundryEventPlan({ ...task, ...fields }, '2026-10-05')).toMatchObject({
    start: { dateTime: '2026-10-08T08:00:00' }, end: { dateTime: '2026-10-08T08:50:00' },
  });
});
it('Make 已验证的旧15分钟预约在同日修正为50分钟，保留原日程和待办估时', async () => {
  task.content = '(15m)';
  await syncLaundryOutlook(api, options());
  const existing = events.get('event-1');
  existing.end.dateTime = '2026-10-08T08:15:00';
  const state = [...data.entries()].find(([key]) => key.startsWith('outlook:laundry-events:v1:'))![1];
  const oldPlan = { ...laundryEventPlan(task, '2026-10-05', '北京'), end: existing.end };
  Object.values<any>(state.entries)[0].verifiedPlan = createHash('sha256').update(JSON.stringify(oldPlan)).digest('hex');
  const connection = data.get(OUTLOOK_WRITE_KEY);
  data.set(OUTLOOK_WRITE_KEY, { ...connection, provider: 'make',
    encrypted: sealOutlookWrite({ webhookUrl: 'https://hook.eu1.make.com/0123456789abcdef0123456789abcdef' }) });
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string);
    const response = await upstream(`https://graph.microsoft.com${input.path}`, { method: input.method, body: input.body || undefined,
      headers: Object.fromEntries(input.headers.map((header: { key: string; value: string }) => [header.key, header.value])) });
    return json({ protocol: 'bonbills-outlook-v1', status: response.status, body: await response.json() });
  });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 1 });
  expect(events.size).toBe(1);
  expect(events.get('event-1')).toMatchObject({ start: existing.start, end: { dateTime: '2026-10-08T08:50:00' }, body: existing.body });
  expect(task.content).toBe('(15m)');
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 0 });
  expect(writes).toHaveLength(2);
});
it('Make 跨日同排期复用验证；变更核对归属并更新同一事件', async () => {
  const upstream = globalThis.fetch;
  const relay = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string);
    const response = await upstream(`https://graph.microsoft.com${input.path}`, { method: input.method, body: input.body || undefined,
      headers: Object.fromEntries(input.headers.map((header: { key: string; value: string }) => [header.key, header.value])) });
    return json({ protocol: 'bonbills-outlook-v1', status: response.status, body: await response.json() });
  });
  vi.stubGlobal('fetch', relay);
  data.set(OUTLOOK_WRITE_KEY, { id: 'outlook', clientId: '', provider: 'make', calendarId: 'calendar', calendarName: '日历',
    encrypted: sealOutlookWrite({ webhookUrl: 'https://hook.eu1.make.com/0123456789abcdef0123456789abcdef' }) });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 1 });
  const count = relay.mock.calls.length, syncedAt = data.get(OUTLOOK_WRITE_KEY).lastSyncAt;
  expect(count).toBe(3);
  await syncLaundryOutlook(api, options());
  expect(relay).toHaveBeenCalledTimes(count); expect(data.get(OUTLOOK_WRITE_KEY).lastSyncAt).toBe(syncedAt);
  events.get('event-1').start.dateTime = '2026-10-08T09:00:00';
  events.get('event-1').end.dateTime = '2026-10-08T09:50:00';
  expect(await syncLaundryOutlook(api, { ...options(), today: '2026-10-06' })).toMatchObject({ updated: 0 });
  expect(relay).toHaveBeenCalledTimes(count);
  expect(events.get('event-1').start.dateTime).toBe('2026-10-08T09:00:00');
  task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ updated: 1 });
  expect(events.size).toBe(1); expect(writes[1].headers['If-Match']).toBe('v1');
  events.get('event-1').attendees = [{}]; task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('参与人') }); expect(writes).toHaveLength(2);
});

it.each(['microsoft', 'make'].flatMap(provider => ['洗衣服', '电动车充电', '洗头', '接电动车'].map(title => ({ provider, title }))))
('$provider $title 连续32天每天四轮，首次成功后无变化零调用', async ({ provider, title }) => {
  task = { ...task, title, isAllDay: true, startDate: '2026-11-20T00:00:00+08:00', dueDate: '2026-11-20T00:00:00+08:00',
    ...(title === '接电动车' ? { content: 'BonBills charging pickup: life/charge/initial' } : {}) };
  if (title === '电动车充电' || title === '接电动车') Object.assign(task, {
    isAllDay: false, startDate: '2026-11-20T20:00:00+08:00', dueDate: `2026-11-20T${title === '电动车充电' ? '21:00' : '20:20'}:00+08:00`,
  });
  const fetcher = provider === 'make' ? makeRelay() : vi.mocked(globalThis.fetch);
  for (let day = 0; day < 32; day++) {
    const today = new Date(Date.parse('2026-10-05T00:00:00Z') + day * 86400000).toISOString().slice(0, 10);
    for (const time of ['05:01', '12:00', '17:00', '20:00']) {
      const input = { ...options(), today, now: new Date(`${today}T${time}:00+08:00`), history: [], excludedTaskIds: new Set<string>() };
      if (title === '洗衣服') await syncLaundryOutlook(api, input);
      else if (title === '电动车充电') await syncChargingOutlook(api, input);
      else if (title === '洗头') await syncHairWashOutlook(api, input);
      else await syncElectricVehiclePickup(api, { ...input, mode: 'outlook' });
    }
  }
  // Only the initial list + POST + readback; all 127 later runs make no calls.
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.map(([, init]) => provider === 'make' ? JSON.parse(String(init?.body)).method : init?.method ?? 'GET'))
    .toEqual(['GET', 'POST', 'GET']);
  expect(writes.map(write => write.method)).toEqual(['POST']);
  expect(data.get(OUTLOOK_WRITE_KEY).syncUsage[title]).toMatchObject({ reads: 0, creates: 0, updates: 0, deletes: 0, skipped: 1, failed: false });
});

it('预约当天也不额外调用，Outlook 手动改时保持原状', async () => {
  const relay = makeRelay();
  await syncLaundryOutlook(api, options());
  events.get('event-1').start.dateTime = '2026-10-08T09:00:00';
  events.get('event-1').end.dateTime = '2026-10-08T09:50:00';
  const today = '2026-10-08', input = { ...options(), today, now: new Date(`${today}T05:01:00+08:00`) };
  expect(await syncLaundryOutlook(api, input)).toMatchObject({ created: 0, updated: 0, skipped: 1 });
  expect(relay).toHaveBeenCalledTimes(3);
  expect(data.get(OUTLOOK_WRITE_KEY).syncUsage['洗衣服']).toMatchObject({ reads: 0, creates: 0, updates: 0 });
  await syncLaundryOutlook(api, { ...input, now: new Date(`${today}T12:00:00+08:00`) });
  expect(relay).toHaveBeenCalledTimes(3); expect(writes).toHaveLength(1);
  expect(events.get('event-1').start.dateTime).toBe('2026-10-08T09:00:00');
});

it('改期只查一次列表、更新一次并回读，之后跨日不再调用', async () => {
  const relay = makeRelay();
  await syncLaundryOutlook(api, options());
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 1 });
  expect(relay.mock.calls.slice(3).map(([, init]) => JSON.parse(String(init.body)).method)).toEqual(['GET', 'PATCH', 'GET']);
  await syncLaundryOutlook(api, { ...options(), today: '2026-10-06', now: new Date('2026-10-06T04:00:00Z') });
  expect(relay).toHaveBeenCalledTimes(6); expect(events.size).toBe(1);
});

it('Outlook 预约被删除时不主动补建，对应待办改期后才查重恢复', async () => {
  const relay = makeRelay();
  await syncLaundryOutlook(api, options()); events.clear();
  const input = { ...options(), today: '2026-10-08', now: new Date('2026-10-08T05:01:00+08:00') };
  expect(await syncLaundryOutlook(api, input)).toMatchObject({ created: 0, skipped: 1 });
  expect(relay).toHaveBeenCalledTimes(3); expect(events.size).toBe(0);
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  input.plannedDates.wash = '2026-10-10';
  expect(await syncLaundryOutlook(api, input)).toMatchObject({ created: 1 });
  expect(relay).toHaveBeenCalledTimes(7); expect(events.size).toBe(1);
  await syncLaundryOutlook(api, input);
  expect(relay).toHaveBeenCalledTimes(7); expect(writes).toHaveLength(2);
});

it('相同日历重连不触发调用；待办改期读取失败保留成功记录，重试只更新一次', async () => {
  const relay = makeRelay();
  await syncLaundryOutlook(api, options());
  data.set(OUTLOOK_WRITE_KEY, { ...data.get(OUTLOOK_WRITE_KEY), id: 'new-connection' });
  await syncLaundryOutlook(api, options()); expect(relay).toHaveBeenCalledTimes(3);
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  const input = { ...options(), today: '2026-10-08', now: new Date('2026-10-08T05:01:00+08:00') };
  relay.mockResolvedValueOnce(json({ protocol: 'bonbills-outlook-v1', status: 503, body: {} }));
  expect(await syncLaundryOutlook(api, input)).toHaveProperty('error');
  const entry = Object.values<any>([...data.entries()].find(([key]) => key.startsWith('outlook:laundry-events:v1:'))![1].entries)[0];
  expect(entry.verifiedPlan).toBeDefined();
  expect(await syncLaundryOutlook(api, input)).toMatchObject({ updated: 1, verifiedCount: 1 });
  await syncLaundryOutlook(api, input);
  expect(relay).toHaveBeenCalledTimes(7); expect(writes.map(write => write.method)).toEqual(['POST', 'PATCH']);
});

it('同轮同类多个待办共用查重列表，后续待办能看到本轮新建结果', async () => {
  const relay = makeRelay();
  const second = { ...task, id: 'wash-2' };
  vi.mocked(api.getTask).mockImplementation(async (_project, id) => structuredClone(id === task.id ? task : second));
  data.get(LAUNDRY_STATE_KEY).anchors[second.id] = { ...data.get(LAUNDRY_STATE_KEY).anchors.wash };
  const input = { ...options(), tasks: [task, second], managedTaskIds: new Set([task.id, second.id]), plannedDates: { wash: '2026-10-08', 'wash-2': '2026-10-08' } };
  expect(await syncLaundryOutlook(api, input)).toMatchObject({ created: 2 });
  expect(relay).toHaveBeenCalledTimes(5); expect(events.size).toBe(2);
  await syncLaundryOutlook(api, input); expect(relay).toHaveBeenCalledTimes(5);
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  input.plannedDates.wash = '2026-10-10';
  const untouched = structuredClone(events.get('event-2'));
  expect(await syncLaundryOutlook(api, input)).toMatchObject({ updated: 1, skipped: 1 });
  expect(relay).toHaveBeenCalledTimes(8);
  expect(events.get('event-2')).toEqual(untouched);
  expect(writes.map(write => write.method)).toEqual(['POST', 'POST', 'PATCH']);
});

it('显隐、备注、优先级变化不触发 Outlook，已过期的微软令牌也不需要刷新', async () => {
  await syncLaundryOutlook(api, options());
  const fetcher = vi.mocked(globalThis.fetch), calls = fetcher.mock.calls.length;
  data.set(OUTLOOK_WRITE_KEY, { ...data.get(OUTLOOK_WRITE_KEY),
    encrypted: sealOutlookWrite({ access_token: 'ACCESS', refresh_token: 'REFRESH', expiresAt: 0 }) });
  task.tags = ['routine', 'hidden']; task.priority = 5; task.content = '(15m)\n新的洗衣安排原因';
  const original = structuredClone(task);
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ skipped: 1 });
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect(writes).toHaveLength(1); expect(task).toEqual(original);
});

it('充电待办改期不触发洗衣、洗头的 Outlook 调用', async () => {
  const relay = makeRelay();
  const charging = { ...task, id: 'charge', title: '电动车充电' }, hair = { ...task, id: 'hair', title: '洗头' };
  const tasks = [task, charging, hair];
  vi.mocked(api.getTask).mockImplementation(async (_project, id) => structuredClone(tasks.find(candidate => candidate.id === id)!));
  const sync = async () => {
    const input = { ...options(), tasks, history: [], excludedTaskIds: new Set<string>() };
    await syncLaundryOutlook(api, input);
    await syncChargingOutlook(api, input);
    await syncHairWashOutlook(api, input);
  };
  await sync(); expect(relay).toHaveBeenCalledTimes(9);
  const laundry = structuredClone(events.get('event-1')), hairEvent = structuredClone(events.get('event-3'));
  charging.startDate = '2026-10-10T00:00:00Z'; charging.dueDate = '2026-10-10T01:00:00Z';
  await sync(); expect(relay).toHaveBeenCalledTimes(12);
  expect(events.get('event-1')).toEqual(laundry); expect(events.get('event-3')).toEqual(hairEvent);
  expect(events.get('event-2').start.dateTime).toBe('2026-10-10T08:00:00');
  await sync(); expect(relay).toHaveBeenCalledTimes(12);
});

it.each(['洗衣服', '电动车充电'])('%s 无待办变化不调用 Outlook，跨日改期同步原预约', async title => {
  task.title = title;
  const sync = () => title === '洗衣服' ? syncLaundryOutlook(api, options()) : syncChargingOutlook(api, {
    ...options(), history: [], excludedTaskIds: new Set(),
  });
  expect(await sync()).toMatchObject({ created: 1 });
  const event = events.get('event-1');
  // UTC date is the preceding day, but the Shanghai date is still October 8.
  event.start = { dateTime: '2026-10-07T17:00:00.0000000', timeZone: 'UTC' };
  event.end = { dateTime: title === '洗衣服' ? '2026-10-07T17:50:00' : '2026-10-07T18:00:00', timeZone: 'UTC' };
  expect(await sync()).toMatchObject({ updated: 0 });
  expect(await sync()).toMatchObject({ updated: 0 });
  expect(events.get('event-1').start).toEqual(event.start);
  expect(writes).toHaveLength(1);
  task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  if (title === '电动车充电') task.dueDate = '2026-10-09T01:00:00Z';
  expect(await sync()).toMatchObject({ updated: 1, created: 0 });
  expect(events.get('event-1').start.dateTime).toBe('2026-10-09T08:00:00');
  expect(events.size).toBe(1);
});

it('充电按当前待办创建，丢失响应可恢复，完成后的下一周期保留历史日程', async () => {
  task.title = '电动车充电'; task.startDate = '2026-10-08T20:00:00+0800'; task.dueDate = '2026-10-08T21:00:00+0800';
  const history: TickTickTask[] = [];
  const sync = (overrides = {}) => syncChargingOutlook(api, { ...options(), history, excludedTaskIds: new Set(), ...overrides });
  expect(chargingEventPlan(task, options().today)).toMatchObject({
    start: { dateTime: '2026-10-08T20:00:00' }, end: { dateTime: '2026-10-08T21:00:00' },
  });
  const original = structuredClone(task);
  loseCreateResponse = true;
  expect(await sync()).toHaveProperty('error');
  expect(await sync()).toMatchObject({ created: 0 });
  expect(writes).toHaveLength(1);
  expect(task).toEqual(original);
  history.push({ ...task, status: 2, completedTime: '2026-10-08T13:00:00Z' });
  task.startDate = '2026-10-13T00:00:00Z'; task.dueDate = '2026-10-13T01:00:00Z';
  expect(await sync({ today: '2026-10-08', now: new Date('2026-10-08T14:00:00Z') })).toMatchObject({ created: 1 });
  expect(events.size).toBe(2);
  expect(events.get('event-1').start.dateTime).toBe('2026-10-08T20:00:00');
  // History falling outside the read window must not roll the cycle back.
  history.length = 0;
  expect(await sync({ today: '2026-10-09', now: new Date('2026-10-09T00:00:00Z') })).toMatchObject({ created: 0 });
  expect(events.size).toBe(2);
});

it.each(['电动车充电', '接电动车'])('%s 同日改时仍更新原 Outlook 日程，起止秒数与待办一致', async title => {
  task.title = title;
  task.startDate = '2026-10-08T20:00:55+0800';
  task.dueDate = `2026-10-08T${title === '电动车充电' ? '21:00' : '20:20'}:55+0800`;
  const sync = () => title === '电动车充电'
    ? syncChargingOutlook(api, { ...options(), history: [], excludedTaskIds: new Set() })
    : syncElectricVehiclePickup(api, { ...options(), history: [], excludedTaskIds: new Set(), mode: 'outlook' });
  await sync();
  task.startDate = '2026-10-08T22:00:55+0800';
  task.dueDate = `2026-10-08T${title === '电动车充电' ? '23:00' : '22:20'}:55+0800`;
  await sync();
  expect(events.size).toBe(1);
  expect(events.get('event-1')).toMatchObject({ start: { dateTime: '2026-10-08T22:00:55' },
    end: { dateTime: `2026-10-08T${title === '电动车充电' ? '23:00' : '22:20'}:55` } });
  vi.mocked(fetch).mockClear(); await sync(); expect(fetch).not.toHaveBeenCalled();
});

it('充电不处理模板后代、已完成、过去、无日期或不关我事的待办', async () => {
  task.title = '电动车充电';
  for (const fields of [{ status: 2 }, { isAllDay: true },
    { startDate: undefined, dueDate: undefined }, { dueDate: '2026-10-04T00:00:00Z' },
    { tags: ['不关我事'] }, { title: '买电动车充电器' }]) {
    expect(chargingEventPlan({ ...task, ...fields }, options().today)).toBeNull();
  }
  task.parentId = 'child';
  await syncChargingOutlook(api, { ...options(), tasks: [task, { ...task, id: 'child', parentId: 'template', title: '阶段' }],
    history: [], excludedTaskIds: new Set(['template']) });
  expect(writes).toHaveLength(0);
});

it('充电同步成功不能清除仍失败的洗衣状态，洗衣恢复后才清除', async () => {
  await syncLaundryOutlook(api, options());
  events.get('event-1').attendees = [{}];
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toHaveProperty('error');
  const original = structuredClone(task);
  task = { ...task, id: 'charge', title: '电动车充电', dueDate: '2026-10-10T01:00:00Z' };
  expect(await syncChargingOutlook(api, { ...options(), history: [], excludedTaskIds: new Set() })).toMatchObject({ created: 1 });
  expect(data.get(OUTLOOK_WRITE_KEY).lastError).toContain('参与人');
  task = original;
  events.get('event-1').attendees = [];
  expect(await syncLaundryOutlook(api, options())).not.toHaveProperty('error');
  expect(data.get(OUTLOOK_WRITE_KEY).lastError).toBeUndefined();
});

it('洗头固定当天22点至22点半，隐藏标签不阻止同步', async () => {
  task.title = ' 洗头 '; task.tags = ['routine', 'hidden']; task.content = '(30m)';
  task.startDate = task.dueDate = '2026-10-08T14:10:00Z';
  expect(hairWashEventPlan(task, options().today)).toEqual({ subject: '洗头',
    start: { dateTime: '2026-10-08T22:00:00', timeZone: 'Asia/Shanghai' },
    end: { dateTime: '2026-10-08T22:30:00', timeZone: 'Asia/Shanghai' } });
  const original = structuredClone(task);
  expect(await syncHairWashOutlook(api, { ...options(), history: [], excludedTaskIds: new Set() })).toMatchObject({ created: 1 });
  expect(writes[0].body).toMatchObject({ subject: '洗头', attendees: [], isReminderOn: false, showAs: 'busy' });
  expect(writes[0].body).not.toHaveProperty('recurrence');
  expect(task).toEqual(original);
  expect(hairWashEventPlan({ ...task, isAllDay: true, content: '' }, options().today)).toMatchObject({
    start: { dateTime: '2026-10-08T22:00:00' }, end: { dateTime: '2026-10-08T22:30:00' } });
  expect(hairWashEventPlan({ ...task, content: '', dueDate: '2026-10-08T14:30:00Z' }, options().today))
    .toMatchObject({ end: { dateTime: '2026-10-08T22:30:00' } });
});

it('洗头创建响应丢失后找回，同周期改期更新原预约，同日手动改时保留', async () => {
  task.title = '洗头'; task.isAllDay = true; task.content = '(25m)';
  const sync = () => syncHairWashOutlook(api, { ...options(), history: [], excludedTaskIds: new Set() });
  loseCreateResponse = true;
  expect(await sync()).toHaveProperty('error');
  expect(await sync()).toMatchObject({ created: 0, updated: 0 });
  expect(writes).toHaveLength(1);
  const transactionId = writes[0].body.transactionId;
  task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await sync()).toMatchObject({ created: 0, updated: 1 });
  expect(events.size).toBe(1);
  expect(events.get('event-1').start.dateTime).toBe('2026-10-09T22:00:00');
  events.get('event-1').start.dateTime = '2026-10-09T21:00:00';
  events.get('event-1').end.dateTime = '2026-10-09T21:30:00';
  expect(await sync()).toMatchObject({ created: 0, updated: 0 });
  expect(events.get('event-1').start.dateTime).toBe('2026-10-09T21:00:00');
  events.clear();
  expect(await sync()).toMatchObject({ created: 0, skipped: 1 });
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await sync()).toMatchObject({ created: 1 });
  expect(writes.at(-1)!.body.transactionId).not.toBe(transactionId);
  expect(await sync()).toMatchObject({ created: 0, updated: 0 });
  expect(events.size).toBe(1);
});

it('洗头实际完成后新建下一周期，保留历史和手动同名日程', async () => {
  task.title = '洗头'; task.isAllDay = true;
  const history: TickTickTask[] = [];
  const sync = (overrides = {}) => syncHairWashOutlook(api, { ...options(), history, excludedTaskIds: new Set(), ...overrides });
  events.set('manual', { id: 'manual', subject: '洗头', start: {}, end: {} });
  await sync();
  history.push({ ...task, status: 2, completedTime: '2026-10-08T13:30:00Z' });
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await sync({ today: '2026-10-09', now: new Date('2026-10-09T00:00:00Z') })).toMatchObject({ created: 1 });
  expect(events.size).toBe(3);
  expect(events.get('event-2').start.dateTime).toBe('2026-10-08T22:00:00');
  expect(events.get('manual').start).toEqual({});
  history.length = 0;
  expect(await sync({ today: '2026-10-09', now: new Date('2026-10-09T00:00:00Z') })).toMatchObject({ created: 0, updated: 0 });
  expect(events.size).toBe(3);
});

it('洗头不处理跟随项、模板后代、已完成、过去、无日期或不关我事的待办', async () => {
  task.title = '洗头';
  for (const fields of [{ status: 2 }, { completedTime: '2026-10-04T01:00:00Z' },
    { startDate: undefined, dueDate: undefined }, { dueDate: '2026-10-04T00:00:00Z' },
    { tags: ['不关我事'] }, { title: '准备洗头', tags: ['洗头'] }]) {
    expect(hairWashEventPlan({ ...task, ...fields }, options().today)).toBeNull();
  }
  task.parentId = 'child';
  await syncHairWashOutlook(api, { ...options(), tasks: [task, { ...task, id: 'child', parentId: 'template', title: '阶段' }],
    history: [], excludedTaskIds: new Set(['template']) });
  expect(writes).toHaveLength(0);
});

it('洗头写入前刚完成或改期时不创建旧日程', async () => {
  task.title = '洗头';
  for (const fields of [{ status: 2, completedTime: '2026-10-05T03:00:00Z' },
    { dueDate: '2026-10-10T00:00:00Z', startDate: '2026-10-10T00:00:00Z' }]) {
    vi.mocked(api.getTask).mockResolvedValueOnce(structuredClone(task)).mockResolvedValueOnce({ ...task, ...fields });
    expect(await syncHairWashOutlook(api, { ...options(), history: [], excludedTaskIds: new Set() })).toMatchObject({ created: 0, updated: 0 });
  }
  expect(writes).toHaveLength(0);
});

it('洗头同步失败保持独立错误，充电成功不能掩盖', async () => {
  task.title = '洗头';
  const sync = () => syncHairWashOutlook(api, { ...options(), history: [], excludedTaskIds: new Set() });
  await sync();
  events.get('event-1').attendees = [{}];
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await sync()).toHaveProperty('error');
  const original = structuredClone(task);
  task = { ...task, id: 'charge', title: '电动车充电', dueDate: '2026-10-10T01:00:00Z' };
  expect(await syncChargingOutlook(api, { ...options(), history: [], excludedTaskIds: new Set() })).toMatchObject({ created: 1 });
  expect(data.get(OUTLOOK_WRITE_KEY).syncErrors['洗头']).toContain('参与人');
  expect(data.get(OUTLOOK_WRITE_KEY).lastError).toContain('参与人');
  task = original; events.get('event-1').attendees = [];
  expect(await sync()).not.toHaveProperty('error');
  expect(data.get(OUTLOOK_WRITE_KEY).lastError).toBeUndefined();
});

function linkedAppointment(id: string, day = '2026-10-09', fields: Record<string, unknown> = {}) {
  return { id, subject: '洗衣服', type: 'singleInstance', '@odata.etag': 'v1', attendees: [],
    body: { content: '<https://ticktick.com/webapp/#p/life/tasks/wash>\n\n' },
    start: { dateTime: `${day}T08:00:00`, timeZone: 'Asia/Shanghai' },
    end: { dateTime: `${day}T08:50:00`, timeZone: 'Asia/Shanghai' }, ...fields };
}
it('旧周期未来预约和连接器副本合并为当前待办的一条预约，保留已结束记录', async () => {
  await syncLaundryOutlook(api, options());
  events.set('connector-copy', linkedAppointment('connector-copy', '2026-10-10'));
  events.set('history', linkedAppointment('history', '2026-10-05'));
  cycle('2026-10-05T04:00:00Z');
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 1, deleted: 1 });
  expect([...events.keys()].sort()).toEqual(['connector-copy', 'history']);
  expect(events.get('connector-copy').start.dateTime).toBe('2026-10-10T08:00:00');
  expect(writes.filter(write => write.method === 'POST')).toHaveLength(1);
  expect(writes.at(-1)).toMatchObject({ method: 'DELETE', body: { id: 'event-1' }, headers: { 'If-Match': 'v1' } });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 0, deleted: 0 });
});
it('当前周期重复副本超过两条也能找回并清理，响应丢失不再新建', async () => {
  loseCreateResponse = true;
  await syncLaundryOutlook(api, options());
  const original = events.get('event-1');
  for (const id of ['copy-2', 'copy-3']) events.set(id, { ...structuredClone(original), id });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 0, deleted: 2 });
  expect([...events.keys()]).toEqual(['event-1']);
});
it.each([
  { body: { content: '手动记录' } },
  { body: { content: 'https://ticktick.com/webapp/#p/life/tasks/wash-other' } },
  { body: { content: 'https://ticktick.com/webapp/#p/other/tasks/wash' } },
  { attendees: [{ emailAddress: { address: 'guest@example.com' } }] },
  { type: 'seriesMaster' },
  { isCancelled: true },
  { subject: '洗衣服和其他安排' },
  { singleValueExtendedProperties: [{ id: LAUNDRY_EVENT_PROPERTY, value: 'unknown-owner' }] },
])('不删除手动记录、其他待办或已改变用途的未来日程：%j', async fields => {
  await syncLaundryOutlook(api, options());
  const protectedEvent = linkedAppointment('protected', '2026-10-09', fields);
  events.set('protected', protectedEvent);
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ updated: 1, deleted: 0 });
  expect(events.get('protected')).toEqual(protectedEvent);
  expect(writes.map(write => write.method)).toEqual(['POST', 'PATCH']);
});
it('新排期更新失败时保留旧副本；成功回读后才删除', async () => {
  await syncLaundryOutlook(api, options());
  events.set('old-copy', linkedAppointment('old-copy'));
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z'; rejectPatch = true;
  expect(await syncLaundryOutlook(api, options())).toHaveProperty('error');
  expect(events.has('old-copy')).toBe(true);
  expect(writes.some(write => write.method === 'DELETE')).toBe(false);
  rejectPatch = false;
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ updated: 1, deleted: 1 });
  expect([...events.keys()]).toEqual(['event-1']);
});
it('删除遇到并发变更不缓存为成功，下次核对后继续清理', async () => {
  await syncLaundryOutlook(api, options());
  events.set('old-copy', linkedAppointment('old-copy'));
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => init?.method === 'DELETE' ? json({}, 412) : upstream(input, init));
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('412') });
  expect(events.size).toBe(2);
  const state = [...data.entries()].find(([key]) => key.startsWith('outlook:laundry-events:v1:'))![1];
  expect(Object.values<any>(state.entries)[0].verifiedPlan).toBeUndefined();
  vi.stubGlobal('fetch', upstream);
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, deleted: 1 });
  expect(events.size).toBe(1);
});
it('删除前再次读取，副本新增参与人或任务完成时保留日程', async () => {
  await syncLaundryOutlook(api, options());
  events.set('old-copy', linkedAppointment('old-copy'));
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (new URL(input).pathname.endsWith('/old-copy')) events.get('old-copy').attendees = [{}];
    return upstream(input, init);
  });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ deleted: 0 });
  events.get('old-copy').attendees = [];
  task.startDate = task.dueDate = '2026-10-11T00:00:00Z';
  vi.stubGlobal('fetch', upstream);
  vi.mocked(api.getTask).mockResolvedValueOnce(structuredClone(task)).mockResolvedValueOnce(structuredClone(task))
    .mockResolvedValueOnce({ ...task, status: 2 });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('待办已变化') });
  expect(writes.some(write => write.method === 'DELETE')).toBe(false);
  expect(events.size).toBe(2);
});
it('删除成功响应仍需确认日程确实不存在，保留失败供下次重试', async () => {
  await syncLaundryOutlook(api, options());
  events.set('old-copy', linkedAppointment('old-copy'));
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => init?.method === 'DELETE'
    ? new Response(null, { status: 204 }) : upstream(input, init));
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('删除未确认') });
  expect(events.size).toBe(2);
});
it('分页读取完整后才开始写入，不能跳过第二页的旧副本', async () => {
  await syncLaundryOutlook(api, options());
  events.set('old-copy', linkedAppointment('old-copy'));
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/events') && (!init?.method || init.method === 'GET')) return url.searchParams.has('$skiptoken')
      ? json({ value: [events.get('old-copy')] })
      : json({ value: [events.get('event-1')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/calendar/events?$skiptoken=next' });
    return upstream(input, init);
  });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ deleted: 1 });
  expect([...events.keys()]).toEqual(['event-1']);
});
it.each(['microsoft', 'make'] as const)('兼容 %s 返回的 OData 括号分页，保留完整游标并复用第二页预约', async provider => {
  const calendarId = 'calendar+id==';
  data.set(OUTLOOK_WRITE_KEY, { ...data.get(OUTLOOK_WRITE_KEY), calendarId, provider,
    ...(provider === 'make' ? { encrypted: sealOutlookWrite({ webhookUrl: 'https://hook.eu1.make.com/0123456789abcdef0123456789abcdef' }) } : {}) });
  events.set('existing', linkedAppointment('existing', '2026-10-08'));
  const history = Array.from({ length: 100 }, (_, index) => linkedAppointment(`history-${index}`, '2026-10-01', { body: { content: '手动记录' } }));
  const nextPath = `/v1.0/me/calendars('${calendarId}')/events?$filter=subject%20eq%20%27%E6%B4%97%E8%A1%A3%E6%9C%8D%27&$top=100&$skip=100&$skiptoken=a%2Bb%2F%3D`;
  const upstream = globalThis.fetch;
  const reads: string[] = [];
  const graph = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/events') && (!init?.method || init.method === 'GET')) {
      reads.push(url.pathname + url.search);
      expect(writes).toHaveLength(0);
      return json(url.searchParams.has('$skip') ? { value: [events.get('existing')] }
        : { value: history, '@odata.nextLink': `https://graph.microsoft.com${nextPath}` });
    }
    return upstream(input, init);
  };
  vi.stubGlobal('fetch', provider === 'microsoft' ? graph : async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string);
    // The deployed Make scenario accepts slash paths, not OData key syntax.
    expect(input.path).toMatch(/^\/v1\.0\/me\/calendars\/[^/]+\/events/);
    const response = await graph(`https://graph.microsoft.com${input.path}`, { method: input.method, body: input.body || undefined,
      headers: Object.fromEntries(input.headers.map((h: { key: string; value: string }) => [h.key, h.value])) });
    return json({ protocol: 'bonbills-outlook-v1', status: response.status, body: await response.json() });
  });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ created: 0, updated: 1, verifiedCount: 1 });
  expect(reads).toHaveLength(2);
  expect(reads[1]).toBe(provider === 'make'
    ? `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events${new URL(`https://graph.microsoft.com${nextPath}`).search}` : nextPath);
  expect([...events.keys()]).toEqual(['existing']);
  expect(writes.map(write => write.method)).toEqual(['PATCH']);
});
it.each([
  "https://graph.microsoft.com/v1.0/me/calendars('other')/events?$skip=100",
  "https://evil.test/v1.0/me/calendars('calendar')/events?$skip=100",
  "https://graph.microsoft.com/v1.0/me/calendars('calendar')/events/another?$skip=100",
  "https://graph.microsoft.com/v1.0/me/calendars('calendar')/events?$skip=100#fragment",
  "https://user:password@graph.microsoft.com/v1.0/me/calendars('calendar')/events?$skip=100",
  'not-a-url',
  "https://graph.microsoft.com/v1.0/me/calendars('%invalid')/events?$skip=100",
])('拒绝不属于当前日历的分页地址，查重未完成前不写入：%s', async nextLink => {
  const fetcher = vi.fn(async () => json({ value: [], '@odata.nextLink': nextLink }));
  vi.stubGlobal('fetch', fetcher);
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('分页地址无效') });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(writes).toHaveLength(0);
});
it('最新预约回读失败或分页不完整时不删除旧副本', async () => {
  await syncLaundryOutlook(api, options());
  events.set('old-copy', linkedAppointment('old-copy'));
  task.startDate = task.dueDate = '2026-10-10T00:00:00Z';
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (new URL(input).pathname.endsWith('/event-1') && (!init?.method || init.method === 'GET')) return json({}, 503);
    return upstream(input, init);
  });
  expect(await syncLaundryOutlook(api, options())).toHaveProperty('error');
  expect(writes.map(write => write.method)).toEqual(['POST', 'PATCH']);
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => new URL(input).pathname.endsWith('/events')
    ? json({ value: [...events.values()], '@odata.nextLink': 'https://example.com/me/calendars/calendar/events' }) : upstream(input, init));
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ error: expect.stringContaining('分页地址无效') });
  expect(events.size).toBe(2); expect(writes).toHaveLength(2);
});
it('Make 旧缓存升级后同日查重并删除旧预约，成功后才复用缓存', async () => {
  await syncLaundryOutlook(api, options());
  const state = [...data.entries()].find(([key]) => key.startsWith('outlook:laundry-events:v1:'))![1];
  delete Object.values<any>(state.entries)[0].duplicatesChecked;
  events.set('old-copy', linkedAppointment('old-copy'));
  const upstream = globalThis.fetch;
  const relay = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string);
    const response = await upstream(`https://graph.microsoft.com${input.path}`, { method: input.method,
      body: input.body || undefined, headers: Object.fromEntries(input.headers.map((h: { key: string; value: string }) => [h.key, h.value])) });
    return json({ protocol: 'bonbills-outlook-v1', status: response.status, body: response.status === 204 ? undefined : await response.json() });
  });
  vi.stubGlobal('fetch', relay);
  data.set(OUTLOOK_WRITE_KEY, { ...data.get(OUTLOOK_WRITE_KEY), provider: 'make',
    encrypted: sealOutlookWrite({ webhookUrl: 'https://hook.eu1.make.com/0123456789abcdef0123456789abcdef' }) });
  expect(await syncLaundryOutlook(api, options())).toMatchObject({ deleted: 1 });
  expect([...events.keys()]).toEqual(['event-1']);
  const calls = relay.mock.calls.length;
  await syncLaundryOutlook(api, options());
  expect(relay).toHaveBeenCalledTimes(calls);
});

it('跨实习城市改期时更新同一 Outlook 洗衣事件的地点，保留50分钟', async () => {
  const configState = { config: { schoolCity: BEIJING, internshipPeriods: [{ id: 'gz', profileId: 'company', profileName: '公司', revision: 1,
    city: GUANGZHOU, schoolCity: BEIJING, startDate: '2026-10-09', endDate: '2026-10-30', rules: { ...DEFAULT_INTERNSHIP_RULES, salary: 300 } }] } };
  expect(await syncLaundryOutlook(api, { ...options(), configState })).toMatchObject({ created: 1 });
  expect(writes[0].body.location).toEqual({ displayName: '北京' });
  task.startDate = task.dueDate = '2026-10-09T00:00:00Z';
  expect(await syncLaundryOutlook(api, { ...options(), configState })).toMatchObject({ created: 0, updated: 1 });
  expect(events.size).toBe(1);
  expect(writes[1].body).toMatchObject({ location: { displayName: '广州' }, end: { dateTime: '2026-10-09T08:50:00' } });
});
