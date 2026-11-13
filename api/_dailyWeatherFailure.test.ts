import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readDailyWeather } from './_dailyWeather';
import { upstream, weatherFailureDetails } from './_weatherClient';

const m = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('./_accountKv.js', () => ({ kv: { get: m.get, set: m.set } }));
const day = '2026-11-13', city = { name: '广州', latitude: 23.1291, longitude: 113.2644 };
const daily = { time: [day], temperature_2m_min: [19], temperature_2m_max: [28], apparent_temperature_min: [20],
  apparent_temperature_max: [29], precipitation_sum: [6.3], wind_speed_10m_max: [12], weather_code: [81] };
let fetcher: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${day}T15:00:00+08:00`));
  vi.resetAllMocks(); fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  m.get.mockResolvedValue({ days: { [day]: { code: 81, precipitation: 6.3 } }, fetchedAt: `${day}T04:00:00Z`, stale: false });
  m.set.mockResolvedValue('OK'); fetcher.mockResolvedValue({ ok: true, json: async () => ({ daily }) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([403, 429, 500])('HTTP %s 与解析、持久化错误区分，保留过期保护且不记录原始内容', async status => {
  fetcher.mockResolvedValue({ ok: false, status, json: async () => ({ reason: 'private-provider-payload' }) });
  const result = await readDailyWeather(city, day, day, 'Asia/Shanghai');
  expect(result).toMatchObject({ stale: true, error: '天气更新失败' }); expect(m.set).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith('[daily-weather-failure]', JSON.stringify({ stage: 'request', archive: false, kind: 'http', status }));
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
});
it.each([['TimeoutError', undefined, 'timeout'], ['TypeError', 'ENOTFOUND', 'network'], ['TypeError', 'UND_ERR_CONNECT_TIMEOUT', 'timeout']])('区分 %s / %s', async (name, code, kind) => {
  fetcher.mockRejectedValue(Object.assign(new Error('private URL and credentials'), { name, cause: { code } }));
  await readDailyWeather(city, day, day, 'Asia/Shanghai');
  expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({ stage: 'request', kind, ...(code ? { code } : {}) });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
});
it.each(['json', 'schema'])('区分 %s 解析错误，不能覆盖旧缓存', async kind => {
  fetcher.mockResolvedValue({ ok: true, json: async () => { if (kind === 'json') throw new SyntaxError('private body'); return null; } });
  expect((await readDailyWeather(city, day, day, 'Asia/Shanghai')).stale).toBe(true);
  expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({ stage: kind === 'json' ? 'request' : 'parse', kind });
  expect(m.set).not.toHaveBeenCalled();
});
it('持久化失败不冒充请求失败，也不把旧缓存标为新数据', async () => {
  m.set.mockRejectedValue(new Error('database credentials'));
  const result = await readDailyWeather(city, day, day, 'Asia/Shanghai');
  expect(result).toMatchObject({ stale: true, fetchedAt: `${day}T04:00:00Z` });
  expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({ stage: 'cache-write', kind: 'unknown' });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('credentials');
});
it('缓存读取失败明确记录阶段且仍抛错', async () => {
  m.get.mockRejectedValue(new Error('database unavailable'));
  await expect(readDailyWeather(city, day, day, 'Asia/Shanghai')).rejects.toThrow();
  expect(JSON.parse(warn.mock.calls[0][1])).toEqual({ stage: 'cache-read', kind: 'unknown' }); expect(fetcher).not.toHaveBeenCalled();
});
it('成功请求保持原字段、30 分钟缓存及缓存写入', async () => {
  const result = await readDailyWeather(city, day, day, 'Asia/Shanghai');
  expect(result).toMatchObject({ stale: false, days: { [day]: { code: 81, precipitation: 6.3 } } });
  expect(m.set).toHaveBeenCalledOnce(); expect(warn).not.toHaveBeenCalled();
  m.get.mockResolvedValue(result); await readDailyWeather(city, day, day, 'Asia/Shanghai'); expect(fetcher).toHaveBeenCalledOnce();
});
it('正文超时与无效 JSON 区分，未知网络错误不泄露原始文本', async () => {
  fetcher.mockResolvedValue({ ok: true, json: async () => { throw Object.assign(new Error('private'), { name: 'TimeoutError' }); } });
  const error = await upstream(new URL('https://api.open-meteo.com/v1/forecast')).catch(error => error);
  expect(weatherFailureDetails(error)).toMatchObject({ kind: 'timeout' }); expect(error.message).not.toContain('private');
  expect(weatherFailureDetails(new Error('private'))).toEqual({ kind: 'unknown' });
});
