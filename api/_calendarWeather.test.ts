import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationParts, readCalendarLocations, readCalendarWeather, resolveDestination, selectDestinationCity } from './_calendarWeather';
import { readDailyWeather } from './_dailyWeather';
import { BEIJING, GUANGZHOU } from '../src/utils/internship';
import { tripDestinationQueries } from '../src/utils/tripDestinations';
import { weatherSymbol } from '../src/utils/weather';

const { store, hashes } = vi.hoisted(() => ({ store: new Map<string, unknown>(), hashes: new Map<string, unknown>() }));
vi.mock('./_accountKv.js', () => ({ kv: { eval: async (_script: string, [key]: string[]) => { store.delete(key); return 1; }, get: async (key: string) => store.get(key) ?? null,
  mget: async (...keys: string[]) => keys.map(key => store.get(key) ?? null),
  set: async (key: string, value: unknown) => { store.set(key, value); return 'OK'; }, hgetall: async (key: string) => hashes.get(key) ?? null } }));
const datong = { name: '大同市', latitude: 40.09, longitude: 113.29, timezone: 'Asia/Shanghai', population: 3105591 };
const linfen = { name: '临汾', latitude: 36.09, longitude: 111.52, timezone: 'Asia/Shanghai', population: 959198 };
const forecast = (dates: string[]) => ({ daily: { time: dates, weather_code: dates.map(() => 61), temperature_2m_min: dates.map(() => 5),
  temperature_2m_max: dates.map(() => 16), apparent_temperature_min: dates.map(() => 3), apparent_temperature_max: dates.map(() => 14), precipitation_sum: dates.map(() => 2), wind_speed_10m_max: dates.map(() => 10) } });
beforeEach(() => { store.clear(); hashes.clear(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T16:03:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('日历与穿搭共用所在地', () => {
  it('识别账单式出游名称、多城与带活动名称的城市，保留呼和浩特完整市名', () => {
    expect(tripDestinationQueries('26.10大同&临汾')).toEqual(['大同', '临汾']);
    expect(tripDestinationQueries('2026.10.27 北京演唱会')).toEqual(['北京']);
    expect(tripDestinationQueries('26.10呼和浩特')).toEqual(['呼和浩特']);
    expect(tripDestinationQueries('26.10京都旅行')).toEqual(['京都']);
    expect(tripDestinationQueries('出游')).toEqual([]);
  });
  it('大同优先人口明确的市，拒绝同名且无法区分的地点和模糊返回', async () => {
    expect(selectDestinationCity('大同', [{ name: '大同', latitude: 46, longitude: 124 }, datong])).toMatchObject({ name: '大同市', latitude: 40.09 });
    expect(selectDestinationCity('大同', [{ name: '大同', latitude: 46, longitude: 124 }, { name: '大同', latitude: 28, longitude: 105 }])).toBeNull();
    expect(selectDestinationCity('刘宪华', [datong])).toBeNull();
    const fetch = vi.fn(async (url: URL) => new Response(JSON.stringify({ results: url.searchParams.get('name') === '大同市' ? [datong] : [{ name: '大同', latitude: 46, longitude: 124 }] })));
    vi.stubGlobal('fetch', fetch);
    expect(await resolveDestination('大同')).toMatchObject({ latitude: 40.09 });
    await resolveDestination('大同'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('省名限定用于匹配城市，山西大同不遗漏也不匹配外省同名地点', async () => {
    expect(destinationParts('山西省大同市')).toEqual({ name: '大同市', region: '山西' });
    expect(destinationParts('内蒙古呼和浩特')).toEqual({ name: '呼和浩特', region: '内蒙古' });
    const fetch = vi.fn(async (_url: URL) => new Response(JSON.stringify({ results: [{ ...datong, admin1: '山西' }, { ...datong, latitude: 22, admin1: '广东' }] })));
    vi.stubGlobal('fetch', fetch);
    expect(await resolveDestination('山西大同')).toMatchObject({ name: '大同市', latitude: 40.09 });
    expect(fetch.mock.calls.map(([url]) => url.searchParams.get('name'))).toEqual(['大同', '大同市']);
    expect(selectDestinationCity('广东大同', [{ ...datong, admin1: '山西' }])).toBeNull();
  });
  it('按每天居寄、出行分段和手动城市解析，BonClothes 地点与日历一致', async () => {
    store.set('app-config', { config: { schoolCity: BEIJING, homeCity: GUANGZHOU } });
    store.set('calendar-tags', { tagMap: { '2026-10-25': 'school', '2026-10-26': 'home', '2026-10-27': 'travel', '2026-10-28': 'travel', '2026-10-29': 'travel' },
      dayOverrides: { '2026-10-29': { city: BEIJING } } });
    store.set('trip-tags', { tripTags: { '2026-10-27': '26.10大同&临汾' } });
    hashes.set('bonclothes:contexts:v1', { '2026-10-28': { location: { ...linfen, source: 'manual' }, scene: '有室外', active: true } });
    const fetch = vi.fn(async (url: URL) => new Response(JSON.stringify({ results: url.searchParams.get('name')?.startsWith('大同') ? [datong] : [linfen] })));
    vi.stubGlobal('fetch', fetch);
    const days = await readCalendarLocations('2026-10-25', '2026-10-29');
    expect(days['2026-10-25'].locations[0]).toMatchObject(BEIJING);
    expect(days['2026-10-26'].locations[0]).toMatchObject(GUANGZHOU);
    expect(days['2026-10-27'].locations.map((city) => city.name)).toEqual(['大同市', '临汾']);
    expect(days['2026-10-28']).toMatchObject({ locations: [{ name: '临汾' }], scene: '有室外', active: true });
    expect(days['2026-10-29'].locations[0]).toMatchObject(BEIJING);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('未知出游不借用常住地或上一次 GPS；已选行程目的地可以复用', async () => {
    store.set('app-config', { config: { schoolCity: BEIJING } });
    store.set('calendar-tags', { tagMap: { '2026-10-27': 'travel' } });
    hashes.set('bonclothes:contexts:v1', { '2026-10-27': { location: { ...BEIJING, source: 'geo' } } });
    expect((await readCalendarLocations('2026-10-27', '2026-10-27'))['2026-10-27'].locations).toEqual([]);
    hashes.set('bonclothes:trip-plans:v1', { 'trip:2026-10-27': { location: linfen, days: {} } });
    expect((await readCalendarLocations('2026-10-27', '2026-10-27'))['2026-10-27'].locations[0].name).toBe('临汾');
  });
});

describe('历史及预报天气', () => {
  it('北京午夜使用 forecast_days，空预报不变成晴天，按城市合并月内请求', async () => {
    store.set('app-config', { config: { schoolCity: BEIJING } });
    const payload = forecast(['2026-10-25', '2026-10-26', '2026-11-09']);
    payload.daily.temperature_2m_max[2] = null as unknown as number;
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload))); vi.stubGlobal('fetch', fetch);
    const result = await readCalendarWeather('2026-10-25', '2026-10-26');
    expect(result.days['2026-10-25'][0].weather).toMatchObject({ code: 61, min: 5, max: 16 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain('forecast_days=16'); expect(url).not.toContain('end_date');
    expect((await readDailyWeather(BEIJING, '2026-11-09', '2026-11-09', 'Asia/Shanghai')).days).toEqual({});
    expect(weatherSymbol(null)).toBeNull(); expect(weatherSymbol(0)?.label).toBe('晴');
  });
  it('旧月调用历史接口；遥远未来留空；失败只返回带旧天气标记的原城市缓存', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(forecast(['2026-09-01'])))); vi.stubGlobal('fetch', fetch);
    const result = await readDailyWeather(BEIJING, '2026-09-01', '2026-09-30', 'Asia/Shanghai');
    expect(String(fetch.mock.calls[0][0])).toContain('archive-api.open-meteo.com');
    expect(result.days['2026-09-01'].date).toBe('2026-09-01');
    expect((await readDailyWeather(BEIJING, '2026-12-01', '2026-12-31', 'Asia/Shanghai')).days).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); fetch.mockRejectedValue(new Error('offline'));
    expect(await readDailyWeather(BEIJING, '2026-09-01', '2026-09-30', 'Asia/Shanghai')).toMatchObject({ stale: true, days: result.days });
    expect((await readDailyWeather(GUANGZHOU, '2026-09-01', '2026-09-30', 'Asia/Shanghai')).days).toEqual({});
  });
});
