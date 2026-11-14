import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rainReminderNotes, readHourlyRain } from './_rainReminderNotes';

const m = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: { get: m.get, set: m.set } }));
const day = '2026-11-14', city = { name: '广州', latitude: 23.1291, longitude: 113.2644 };
const checkedAt = new Date(`${day}T05:01:17+08:00`);
const hour = (index: number) => `${day}T${String(index).padStart(2, '0')}:00`;
const payload = () => ({ hourly: {
  time: [...Array.from({ length: 24 }, (_, i) => hour(i)), '2026-11-15T00:00', '2026-11-15T01:00'],
  rain: Array.from({ length: 26 }, (_, i) => i === 0 ? 90 : i === 1 ? .2 : i === 24 ? 1.5 : i === 25 ? 80 : 0),
  showers: Array.from({ length: 26 }, (_, i) => i === 1 ? .1 : 0),
} });
let fetcher: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(checkedAt); vi.resetAllMocks();
  fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() }); vi.stubGlobal('fetch', fetcher);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); m.get.mockResolvedValue(null); m.set.mockResolvedValue('OK');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('关窗逐时雨情', () => {
  it('按北京时间前一小时累计覆盖全天，不混入昨天或明天；阵雨并入雨量', async () => {
    const forecast = await readHourlyRain(city, day);
    expect(forecast?.hours).toHaveLength(24);
    expect(forecast?.hours[0]).toBeCloseTo(.3); expect(forecast?.hours[23]).toBe(1.5);
    expect(forecast?.hours.slice(1, 23).every(value => value === 0)).toBe(true);
    const url = fetcher.mock.calls[0][0] as URL;
    expect(url.searchParams.get('timezone')).toBe('Asia/Shanghai');
    expect(url.searchParams.get('hourly')).toBe('rain,showers');
    expect(url.searchParams.get('start_date')).toBe(day); expect(url.searchParams.get('end_date')).toBe('2026-11-15');
    expect(m.set.mock.calls[0][0]).toBe(`weather:rain-hours:v1:23.129:113.264:Asia/Shanghai:${day}`);
  });
  it('30 分钟内复用原获取时间，过期后重取；城市与日期隔离', async () => {
    const first = await readHourlyRain(city, day); m.get.mockResolvedValue(first);
    vi.setSystemTime(new Date(checkedAt.getTime() + 29 * 60000));
    expect(await readHourlyRain(city, day)).toEqual(first); expect(fetcher).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date(checkedAt.getTime() + 30 * 60000));
    expect((await readHourlyRain(city, day))?.fetchedAt).not.toBe(first?.fetchedAt); expect(fetcher).toHaveBeenCalledTimes(2);
    m.get.mockResolvedValue(null);
    await readHourlyRain({ name: '北京', latitude: 39.9, longitude: 116.4 }, '2026-11-15');
    expect(m.get).toHaveBeenLastCalledWith('weather:rain-hours:v1:39.9:116.4:Asia/Shanghai:2026-11-15');
  });
  it.each(['missing-hour', 'null-rain', 'negative', 'duplicate', 'no-showers', 'wrong-date'] as const)('%s 不伪造完整预报或零雨量', async kind => {
    const data = payload();
    if (kind === 'missing-hour') data.hourly.time[24] = '2026-11-15T02:00';
    if (kind === 'null-rain') data.hourly.rain[12] = null as unknown as number;
    if (kind === 'negative') data.hourly.showers[12] = -1;
    if (kind === 'duplicate') data.hourly.time[0] = data.hourly.time[1];
    if (kind === 'no-showers') data.hourly.showers = [];
    if (kind === 'wrong-date') data.hourly.time = data.hourly.time.map(value => value.replace('2026-11-14', '2026-11-13'));
    fetcher.mockResolvedValue({ ok: true, json: async () => data });
    expect(await readHourlyRain(city, day)).toBeNull(); expect(m.set).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0][1])).toEqual({ stage: 'parse', kind: 'schema' });
  });
  it('过期缓存请求失败不能当作新预报，诊断不泄露原始错误', async () => {
    m.get.mockResolvedValue({ hours: Array(24).fill(8), fetchedAt: '2026-11-13T00:00:00Z' });
    fetcher.mockRejectedValue(Object.assign(new Error('private URL and credentials'), { name: 'TimeoutError' }));
    expect(await readHourlyRain(city, day)).toBeNull(); expect(m.set).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({ stage: 'request', kind: 'timeout' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });
  it.each(['cache-read', 'cache-write'])('%s 失败如实返回不可用', async stage => {
    (stage === 'cache-read' ? m.get : m.set).mockRejectedValue(new Error('private storage error'));
    expect(await readHourlyRain(city, day)).toBeNull();
    expect(JSON.parse(warn.mock.calls[0][1])).toEqual({ stage, kind: 'unknown' });
  });
  it.each(['future', 'incomplete'])('不采用 %s 缓存', async kind => {
    m.get.mockResolvedValue({ hours: Array(kind === 'incomplete' ? 23 : 24).fill(0),
      fetchedAt: new Date(checkedAt.getTime() + (kind === 'future' ? 60000 : -60000)).toISOString() });
    expect(await readHourlyRain(city, day)).not.toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('关窗备注', () => {
  const base = () => ({ checkedAt, city, day, weather: { code: 61, precipitation: 1.8 }, fetchedAt: '2026-11-13T20:55:00Z' });
  it('写出实际查询时间及两份预报原获取时间，合并连续时段而不跨过晴时；午夜标为 24:00', () => {
    const hours = Array(24).fill(0); hours[8] = .1; hours[9] = .2; hours[23] = 1.5;
    const text = rainReminderNotes({ ...base(), hourly: { hours, fetchedAt: '2026-11-13T20:58:00Z' } });
    expect(text).toBe([
      '天气查询：2026-11-14 05:01:17（北京时间）', '城市：广州',
      '当日预报：2026-11-14 · 雨；全天降水 1.8 毫米', '日预报获取：2026-11-14 04:55:00',
      '逐时预报获取：2026-11-14 04:58:00', '预计降雨（北京时间）：',
      '08:00–10:00：雨量 0.3 毫米，最大小时雨量 0.2 毫米', '23:00–24:00：雨量 1.5 毫米，最大小时雨量 1.5 毫米',
    ].join('\n'));
  });
  it('微量不四舍五入成无雨，全天连续雨只列一个时段', () => {
    const tiny = rainReminderNotes({ ...base(), hourly: { hours: Array(24).fill(.0001), fetchedAt: checkedAt.toISOString() } });
    expect(tiny).toContain('00:00–24:00：雨量 <0.01 毫米，最大小时雨量 <0.01 毫米');
  });
  it('缺测明确标注不可用，逐时零雨量明确标注与日预报不一致', () => {
    expect(rainReminderNotes({ ...base(), hourly: null })).toContain('预计降雨时段、雨量：逐时预报暂不可用');
    expect(rainReminderNotes({ ...base(), hourly: { hours: Array(24).fill(0), fetchedAt: checkedAt.toISOString() } }))
      .toContain('逐时预报未给出降雨时段，与当日有雨判断不一致');
  });
});
