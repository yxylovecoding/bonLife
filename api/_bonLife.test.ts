import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from './outlook-calendar';
import { entriesKey, LIFE_CONNECTION_KEY, LIFE_SETTINGS_KEY, LIFE_TRAINING_ENTRIES_KEY, LIFE_SYMPTOM_ENTRIES_KEY, parsePeriodCalendar, periodsKey, readPeriodDays, syncLifePeriods } from './_bonLife';
import { DEFAULT_CYCLE } from '../src/utils/bonLife';
import { DEFAULT_SKIN_SETTINGS, type SkinSettings } from '../src/utils/lifeSkin';
import { estimateCycle } from '../src/utils/lifeCycle';
import { encryptOutlookConnection } from './_outlookCalendar';
import { DEFAULT_OUTLOOK_RULES } from '../src/utils/outlookCalendar';
import { encryptTickTickToken, TICKTICK_CONNECTION_KEY } from './_ticktickTrips';

const { data, auth, origin, evalMock, getHash, set } = vi.hoisted(() => ({
  data: new Map<string, unknown>(), auth: vi.fn(), origin: vi.fn(), evalMock: vi.fn(), getHash: vi.fn(), set: vi.fn(),
}));
vi.mock('./_auth.js', () => ({ authOk: auth, sameOrigin: origin }));
vi.mock('@vercel/kv', () => ({ kv: {
  get: async (key: string) => data.get(key) ?? null, hgetall: getHash, eval: evalMock,
  set, del: async (key: string) => data.delete(key),
} }));
const calendar = (events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const event = (uid: string, title: string, start = '20260929', end = '20261003', extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${start}\r\nDTEND;VALUE=DATE:${end}\r\nSUMMARY:${title}\r\n${extra}END:VEVENT`;
const url = 'https://outlook.live.com/owa/calendar/private/published/calendar.ics';
function connection() {
  return { id: 'connection-1', encrypted: encryptOutlookConnection({ playUrl: url, classUrl: '', policy: 'manual', rules: DEFAULT_OUTLOOK_RULES }, 'secret') };
}
async function call(method: string, body?: unknown, year = '2026') {
  const result = { status: 200, body: {} as Record<string, any>, headers: {} as Record<string, string> };
  const res = { setHeader: (key: string, value: string) => { result.headers[key] = value; },
    status: (status: number) => { result.status = status; return res; },
    json: (value: Record<string, unknown>) => { result.body = value; return res; } };
  await handler({ method, body, query: { year, app: 'bonlife' }, headers: {} } as VercelRequest, res as unknown as VercelResponse);
  return result;
}
beforeEach(() => {
  data.clear(); vi.clearAllMocks(); auth.mockResolvedValue(true); origin.mockReturnValue(true);
  getHash.mockResolvedValue(null); evalMock.mockResolvedValue(1);
  set.mockImplementation(async (key: string, value: unknown) => { data.set(key, value); return 'OK'; });
  vi.stubEnv('SYNC_SECRET', 'secret');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(calendar([event('period', '月经')]))));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('经期 Outlook 解析', () => {
  it('上游故障保留经期历史，提示临时故障并保留原错误分类', async () => {
    const saved = { events: [{ uid: 'previous', startDate: '2026-09-01', endDate: '2026-09-05' }] };
    data.set(periodsKey(2026), saved);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('PRIVATE upstream', { status: 503 })));
    await expect(syncLifePeriods(connection(), 2026)).rejects.toThrow('Outlook 日历读取失败，Outlook 服务暂不可用，请稍后重试');
    expect(data.get(periodsKey(2026))).toEqual(saved);
    expect(data.get('bonlife:period-read-status:v1')).toEqual({ connectionId: 'connection-1',
      error: 'Outlook 日历读取失败，Outlook 服务暂不可用，请稍后重试' });
  });
  it('读取按日期共享的化妆状态，保留皮肤和眼睛各自的记录', async () => {
    const makeup = { face: true, eyes: false, revision: 'shared' };
    getHash.mockImplementation(async (key) => key === entriesKey(2026) ? {
      'skin:2026-10-06': { text: '皮肤备注', revision: 'skin-rev', skin: { status: 'healthy' } },
      'makeup:2026-10-06': { text: '', revision: 'shared', makeup },
    } : null);
    const result = await call('GET');
    expect(result.status).toBe(200);
    expect(result.body.entries['skin:2026-10-06']).toMatchObject({ text: '皮肤备注', revision: 'skin-rev', makeup });
    expect(result.body.entries['eyes:2026-10-06']).toEqual({ text: '', revision: '', makeup });
    expect(result.body.entries).not.toHaveProperty('makeup:2026-10-06');
  });
  it('皮肤与眼睛写入同一天的共享字段，版本冲突返回最新化妆状态', async () => {
    const makeup = { face: false, eyes: true, revision: 'shared-old' };
    for (const kind of ['skin', 'eyes']) {
      const current = { text: '原有备注', revision: 'current', makeup: { ...makeup, revision: 'shared-new' } };
      evalMock.mockResolvedValueOnce([0, JSON.stringify(current)]);
      const result = await call('POST', { action: 'save', kind, date: '2026-10-06', text: '', revision: '', mutationId: 'makeup-mutation-123', makeup });
      expect(result.status).toBe(409);
      expect(result.body.current).toEqual(current);
      const args = evalMock.mock.calls.at(-1)![2];
      expect(args[5]).toBe('makeup:2026-10-06');
      expect(JSON.parse(args[3]).makeup).toEqual(makeup);
    }
  });
  it('标题含月经或血滴均计入，不额外排除预计、预测或预估', () => {
    const parsed = parsePeriodCalendar(calendar([
      event('actual', '月经'), event('predicted', '预计月经'), event('forecast', '🩸 预测'), event('estimate', '预估月经'),
    ]), 2026);
    expect(parsed.events.map((value) => value.uid)).toEqual(['actual', 'predicted', 'forecast', 'estimate']);
    expect(parsed.seenUids).toEqual(['actual', 'predicted', 'forecast', 'estimate']);
  });
  it.each(['经期', '例假', '大姨妈', '其他日程'])('标题仅为 %s 时不作为经期，保留 UID 供同步移除旧标记', (title) => {
    const parsed = parsePeriodCalendar(calendar([event('other', title)]), 2026);
    expect(parsed.events).toEqual([]);
    expect(parsed.seenUids).toEqual(['other']);
  });
  it('浏览远期年份也带上当前记录，日历和服务端能采用同一估算', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-10T00:00:00+08:00'));
      data.set(periodsKey(2026), { events: [
        { uid: 'one', startDate: '2026-07-01', endDate: '2026-07-05' },
        { uid: 'two', startDate: '2026-08-01', endDate: '2026-08-05' },
      ] });
      const current = await readPeriodDays(2026);
      expect(await readPeriodDays(2030)).toEqual(current);
      expect(estimateCycle(DEFAULT_CYCLE, current)).toMatchObject({ cycleLength: 31, periodLength: 4 });
    } finally { vi.useRealTimers(); }
  });
  it('标题包含月经或血滴的全天和定时事件都计入，同时识别被取消或更名的 UID', () => {
    const parsed = parsePeriodCalendar(calendar([
      event('a', '月经第1天'), event('b', '🩸 经期'), event('renamed', '其他日程'), event('cancel', '月经', undefined, undefined, 'STATUS:CANCELLED\r\n'),
      'BEGIN:VEVENT\r\nUID:timed\r\nDTSTART:20261001T100000Z\r\nDTEND:20261001T110000Z\r\nSUMMARY:月经\r\nEND:VEVENT',
    ]), 2026);
    expect(parsed.events.map((value) => value.uid)).toEqual(['a', 'b', 'timed']);
    expect(parsed.seenUids).toEqual(['a', 'b', 'renamed', 'cancel', 'timed']);
    expect(parsed.events[0]).toMatchObject({ startDate: '2026-09-29', endDate: '2026-10-03' });
    expect(parsed.events[2]).toEqual({ uid: 'timed', startDate: '2026-10-01', endDate: '2026-10-02' });
  });
  it.each([
    ['20261001T153000Z', '20261001T163000Z', '2026-10-01', '2026-10-03'],
    ['20261001T153000Z', '20261001T160000Z', '2026-10-01', '2026-10-02'],
    ['20261001T230000Z', '20261002T000000Z', '2026-10-02', '2026-10-03'],
    ['20261001T233000', '20261002T003000', '2026-10-01', '2026-10-03'],
  ])('定时经期 %s 至 %s 按上海日期覆盖，保留结束边界且不受空闲状态影响', (start, end, startDate, endDate) => {
    const parsed = parsePeriodCalendar(calendar([
      `BEGIN:VEVENT\r\nUID:timed\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:🩸\r\nTRANSP:TRANSPARENT\r\nX-MICROSOFT-CDO-BUSYSTATUS:FREE\r\nEND:VEVENT`,
    ]), 2026);
    expect(parsed.events).toEqual([{ uid: 'timed', startDate, endDate }]);
  });
  it('重复日程保留 EXDATE 与改期，跨年仍能查询往年', () => {
    const parsed = parsePeriodCalendar(calendar([
      event('recurring', '🩸', '20231229', '20240102', 'RRULE:FREQ=MONTHLY;COUNT=3\r\nEXDATE;VALUE=DATE:20240129\r\n'),
    ]), 2024);
    expect(parsed.events).toEqual([{ uid: 'recurring', startDate: '2023-12-29', endDate: '2024-01-02' },
      { uid: 'recurring', startDate: '2024-02-29', endDate: '2024-03-04' }]);
  });
  it('读取失败不写快照，也不泄露订阅地址', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(url); }));
    await expect(syncLifePeriods(connection(), 2026)).rejects.toThrow('Outlook 日历读取失败');
    expect(evalMock).not.toHaveBeenCalled();
  });
  it('同步完整经期范围，保存历史快照且不改财务日历', async () => {
    const saved = { events: [{ uid: 'old', startDate: '2026-01-01', endDate: '2026-01-03' }] };
    data.set(periodsKey(2026), saved);
    const result = await syncLifePeriods(connection(), 2026);
    expect(result.periodDays).toEqual(['2026-01-01', '2026-01-02', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(evalMock.mock.calls[0][1]).toEqual([LIFE_CONNECTION_KEY, periodsKey(2026)]);
    expect(set).toHaveBeenCalledWith('bonlife:period-read-status:v1', { connectionId: 'connection-1' });
  });
  it('连接变更或较新的同步先完成时拒绝旧结果', async () => {
    for (const result of [0, -1]) {
      evalMock.mockResolvedValueOnce(result);
      await expect(syncLifePeriods(connection(), 2026)).rejects.toThrow('日历连接或内容已更新');
    }
  });
  it('三个月后订阅不再包含已补入的经期，重新同步仍保留原始日期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2027-01-04T00:00:00+08:00'));
      data.set(periodsKey(2026), { events: [
        { uid: 'archived', startDate: '2026-09-01', endDate: '2026-09-04' },
      ], requestedAt: 1 });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(calendar([]))));
      const result = await syncLifePeriods(connection(), 2026);
      expect(result.periodDays).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
      expect(JSON.parse(evalMock.mock.calls[0][2][2]).events).toEqual([
        { uid: 'archived', startDate: '2026-09-01', endDate: '2026-09-04' },
      ]);
    } finally { vi.useRealTimers(); }
  });
});

describe('BonLife 接口', () => {
  it('护肤品手选分类写入设置，保存响应和重新读取保持一致', async () => {
    const settings = structuredClone(DEFAULT_SKIN_SETTINGS);
    settings.products.find((item) => item.id === 'curel-cream')!.skincareGroup = '精华';
    settings.products.find((item) => item.id === 'olive-essence')!.skincareGroup = '水乳霜';
    evalMock.mockImplementationOnce(async (_script, _keys, args: string[]) => {
      const stored = JSON.parse(args[3]) as SkinSettings;
      data.set(LIFE_SETTINGS_KEY, { skin: stored });
      return [1, JSON.stringify(stored)];
    });
    const saved = await call('POST', { year: 2026, action: 'save-skin-settings', settings, mutationId: 'skin-category-12345678' });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.products.find((item: { id: string }) => item.id === 'curel-cream').skincareGroup).toBe('精华');
    expect(saved.body.settings.products.find((item: { id: string }) => item.id === 'olive-essence').skincareGroup).toBe('水乳霜');
    getHash.mockImplementation(async (key: string) => key === LIFE_SETTINGS_KEY ? data.get(key) : null);
    const loaded = await call('GET');
    expect(loaded.status).toBe(200);
    expect(loaded.body.skinSettings).toEqual(saved.body.settings);
  });

  it('症状历史合并跨年索引及旧记录，当年清空覆盖旧索引', async () => {
    const old = { text: '', revision: 'old', eyes: { leftEye: '红血丝' } };
    const cleared = { text: '', revision: 'cleared', eyes: { symptoms: {} } };
    getHash.mockImplementation(async (key: string) => key === LIFE_SYMPTOM_ENTRIES_KEY ? {
      'eyes:2024-10-01': old, 'eyes:2026-10-01': old,
    } : key === entriesKey(2025) ? { 'eyes:2025-12-31': old, 'mood:2025-12-31': old }
      : key === entriesKey(2026) ? { 'eyes:2026-10-01': cleared } : null);
    const result = await call('GET');
    expect(result.body.symptomHistory).toEqual({ 'eyes:2024-10-01': old, 'eyes:2025-12-31': old, 'eyes:2026-10-01': cleared });
  });
  it.each(['eyes', 'discomfort'])('%s 保存和清空与跨年索引原子更新，保留冲突检查', async (kind) => {
    const area = kind === 'eyes' ? 'eye' : 'lowerBack';
    const record = { symptoms: { [`${area}:酸胀`]: { area, name: '酸胀', status: 'ongoing', note: '' } } };
    const input = { action: 'save', kind, date: '2026-10-05', text: '', revision: '', mutationId: 'symptom-check-123456', [kind]: record };
    const saved = { text: '', revision: input.mutationId, [kind]: record };
    evalMock.mockResolvedValueOnce([1, saved]);
    expect((await call('POST', input)).body.entry).toEqual(saved);
    expect(evalMock.mock.calls[0][1]).toEqual([entriesKey(2026), LIFE_SYMPTOM_ENTRIES_KEY]);
    expect(JSON.parse(evalMock.mock.calls[0][2][3])).toEqual(saved);
    evalMock.mockResolvedValueOnce([0, saved]);
    expect((await call('POST', input)).status).toBe(409);
    evalMock.mockResolvedValueOnce([1, { ...saved, [kind]: { symptoms: {} } }]);
    expect((await call('POST', { ...input, revision: saved.revision, mutationId: 'symptom-clear-123456', [kind]: { symptoms: {} } })).status).toBe(200);
    expect(JSON.parse(evalMock.mock.calls[2][2][3])[kind]).toEqual({ symptoms: {} });
  });
  it('补入上一年皮肤记录供年初接续，不混入其他状态记录', async () => {
    const old = { text: '', revision: 'yesterday', skin: { status: 'acne', medication: '炉甘石' } };
    getHash.mockImplementation(async (key: string) => key === entriesKey(2025) ? {
      'skin:2025-12-31': old, 'mood:2025-12-31': { text: '心情', revision: 'mood' },
    } : null);
    const result = await call('GET');
    expect(result.status).toBe(200);
    expect(result.body.entries).toEqual({});
    expect(result.body.skinHistory).toEqual({ 'skin:2025-12-31': old });
    expect(getHash).toHaveBeenCalledWith(entriesKey(2025));
  });

  it('保存早晚字段和体围，旧文字不丢失，禁止类型交叉', async () => {
    for (const details of [{ kind: 'skin', skin: { morningMedication: '药 A', eveningProducts: '面霜' } }, { kind: 'body', body: { waist: 66.5, weight: 56.35, bmi: 21.47, bodyFat: 24.6 } },
      { kind: 'skin', skin: { status: 'healthy', acneMarks: true, localMedication: '积雪苷', morningProducts: '原有面霜' } },
      { kind: 'skin', skin: { status: 'damaged', acneMarks: false, localMedication: '' } },
      { kind: 'training', training: { plan: '快走', effort: 'easy', completed: true } },
      { kind: 'training', training: { plan: '上半身 · 轻量', effort: 'normal', completed: false, mode: 'auto' } },
      { kind: 'training', training: { plan: '瑜伽', effort: 'normal', completed: false, mode: 'manual' } }]) {
      const input = { action: 'save', date: '2026-10-04', text: '备注', revision: '', mutationId: 'mutation-123456789', ...details };
      evalMock.mockResolvedValueOnce([1, { text: input.text, revision: input.mutationId, ...details }]);
      expect((await call('POST', input)).status).toBe(200);
      expect(JSON.parse(evalMock.mock.calls.at(-1)![2][3])).toMatchObject({ text: '备注', [details.kind]: details[details.kind as keyof typeof details] });
      expect(evalMock.mock.calls.at(-1)![1]).toEqual([entriesKey(2026), ...(details.kind === 'training' ? [LIFE_TRAINING_ENTRIES_KEY] : [])]);
    }
    expect((await call('POST', { action: 'save', date: '2026-10-04', kind: 'mood', text: '', revision: '', mutationId: 'mutation-123456789', body: { waist: 60 } })).status).toBe(400);
  });
  it('经期设置保留过去开始日期，版本冲突不覆盖', async () => {
    getHash.mockResolvedValue({ cycle: { ...DEFAULT_CYCLE, lastPeriodStart: '2026-09-01', revision: 'old' } });
    const cycle = { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-01', trainingDays: [], revision: 'old' };
    evalMock.mockResolvedValueOnce([1, { ...cycle, revision: 'mutation-123456789' }]);
    expect((await call('POST', { year: 2026, action: 'save-cycle', cycle, mutationId: 'mutation-123456789' })).status).toBe(200);
    expect(evalMock.mock.calls[0][1]).toEqual([LIFE_SETTINGS_KEY]);
    expect(JSON.parse(evalMock.mock.calls[0][2][3])).toMatchObject({ trainingDays: [], automatic: true, periodStarts: ['2026-09-01', '2026-10-01'] });
    evalMock.mockResolvedValueOnce([0, { ...cycle, revision: 'newer' }]);
    expect((await call('POST', { year: 2026, action: 'save-cycle', cycle, mutationId: 'mutation-123456789' })).status).toBe(409);
    expect((await call('POST', { year: 2026, action: 'sync-done', month: 13 })).status).toBe(400);
  });
  it('经期保存成功后触发游泳顺延；TickTick 失败保留设置并返回可重试状态', async () => {
    data.set(TICKTICK_CONNECTION_KEY, { encryptedToken: encryptTickTickToken('test-token', 'secret') });
    const cycle = { ...DEFAULT_CYCLE, lastPeriodStart: '2026-10-07' };
    evalMock.mockResolvedValueOnce([1, { ...cycle, revision: 'mutation-123456789' }]);
    vi.mocked(fetch).mockRejectedValue(new Error('test-token'));
    const result = await call('POST', { year: 2026, action: 'save-cycle', cycle, mutationId: 'mutation-123456789' });
    expect(result.status).toBe(200);
    expect(result.body.cycle.lastPeriodStart).toBe('2026-10-07');
    expect(result.body.swimmingError).toBe('TickTick 游泳待办顺延失败，请重新同步');
    expect(fetch).toHaveBeenCalled();
    vi.mocked(fetch).mockClear();
    evalMock.mockResolvedValueOnce([0, cycle]);
    expect((await call('POST', { year: 2026, action: 'save-cycle', cycle, mutationId: 'mutation-123456789' })).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('未登录 %s 不读写状态记录', async (method) => {
    auth.mockResolvedValue(false);
    expect((await call(method)).status).toBe(401);
    expect(getHash).not.toHaveBeenCalled(); expect(evalMock).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
  it('拒绝跨来源和无效年份', async () => {
    origin.mockReturnValue(false); expect((await call('GET')).status).toBe(403);
    origin.mockReturnValue(true); expect((await call('GET', undefined, '2026x')).status).toBe(400);
    expect(getHash).not.toHaveBeenCalled();
  });
  it('往年读取两个独立状态，返回私有缓存头，不读取账本键', async () => {
    getHash.mockResolvedValue({ 'skin:2020-02-29': { text: '皮肤', revision: 'a' }, 'mood:2020-02-29': { text: '心情', revision: 'b' } });
    const result = await call('GET', undefined, '2020');
    expect(result.body.year).toBe(2020); expect(Object.keys(result.body.entries)).toHaveLength(2);
    expect(getHash).toHaveBeenCalledWith(entriesKey(2020));
    expect(result.headers['Cache-Control']).toBe('private, max-age=30, must-revalidate');
    expect(result.headers['Vary']).toContain('Cookie');
    expect(result.headers['Vary']).toContain('X-BonBills-Account');
    expect(result.headers['Vary']).toContain('X-BonBills-Cache');
  });
  it('正确处理 Redis SDK 已解码的写入结果，逐日提交不覆盖整年', async () => {
    const entry = { text: '今天很好', revision: 'mutation-123456789' };
    evalMock.mockResolvedValueOnce([1, entry]);
    const result = await call('POST', { action: 'save', kind: 'mood', date: '2026-10-01', text: entry.text, revision: '', mutationId: entry.revision });
    expect(result.body.entry).toEqual(entry);
    expect(evalMock.mock.calls[0][1]).toEqual([entriesKey(2026)]);
    expect(evalMock.mock.calls[0][2].slice(0, 3)).toEqual(['mood:2026-10-01', '', entry.revision]);
  });
  it('返回冲突的云端文字，非法日期与过长内容不进入存储', async () => {
    const edit = { action: 'save', kind: 'skin', date: '2026-10-01', text: 'draft', revision: 'old', mutationId: 'mutation-123456789' };
    evalMock.mockResolvedValueOnce([0, { text: '另一处的记录', revision: 'new' }]);
    const result = await call('POST', edit);
    expect(result.status).toBe(409); expect(result.body.current.text).toBe('另一处的记录');
    expect((await call('POST', { ...edit, date: '2026-02-30' })).status).toBe(400);
    expect((await call('POST', { ...edit, text: 'a'.repeat(2001) })).status).toBe(400);
    expect(evalMock).toHaveBeenCalledTimes(1);
  });
  it('单独加密经期订阅，不替换 BonBills 的订阅；断开不删除历史', async () => {
    data.set('outlook:calendar-connection:v1', { id: 'bills' });
    data.set(periodsKey(2026), { events: [] });
    const result = await call('PUT', { year: 2026, url });
    expect(result.body.connected).toBe(true);
    expect(JSON.stringify(data.get(LIFE_CONNECTION_KEY))).not.toContain(url);
    expect(data.get('outlook:calendar-connection:v1')).toEqual({ id: 'bills' });
    expect((await call('DELETE')).body.connected).toBe(false);
    expect(data.has(periodsKey(2026))).toBe(true);
  });
  it('新连接读取失败时保留原连接，不透露私密地址', async () => {
    data.set(LIFE_CONNECTION_KEY, { id: 'old' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(url); }));
    const result = await call('PUT', { year: 2026, url });
    expect(result.status).toBe(502); expect(JSON.stringify(result.body)).not.toContain(url);
    expect(data.get(LIFE_CONNECTION_KEY)).toEqual({ id: 'old' });
  });
});

vi.mock('./_accountRoute.js', () => ({ withAccountScope: (handler: unknown) => handler }));
