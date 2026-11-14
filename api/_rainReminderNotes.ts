import { kv } from './_accountKv.js';
import { upstream, WeatherRequestError, weatherFailureDetails } from './_weatherClient.js';
import { shiftDay } from '../src/utils/internship.js';
import { weatherSymbol } from '../src/utils/weather.js';
import type { SceneCity } from '../src/models/types.js';

export interface HourlyRain { hours: number[]; fetchedAt: string }
const validHours = (hours: unknown): hours is number[] => Array.isArray(hours) && hours.length === 24
  && Array.from(hours).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);

// Open-Meteo rain/showers at HH:00 are sums for the preceding hour. Read
// tomorrow's 00:00 too, so today's 23:00–24:00 is included without yesterday.
export async function readHourlyRain(city: SceneCity, day: string): Promise<HourlyRain | null> {
  const latitude = Number(city.latitude.toFixed(3)), longitude = Number(city.longitude.toFixed(3));
  const key = `weather:rain-hours:v1:${latitude}:${longitude}:Asia/Shanghai:${day}`;
  let stage = 'cache-read';
  try {
    const saved = await kv.get<HourlyRain>(key);
    const age = Date.now() - Date.parse(saved?.fetchedAt ?? '');
    if (saved && validHours(saved.hours) && age >= 0 && age < 30 * 60000) return saved;
    stage = 'request';
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), timezone: 'Asia/Shanghai',
      hourly: 'rain,showers', precipitation_unit: 'mm', start_date: day, end_date: shiftDay(day, 1) }).toString();
    const response = await upstream(url);
    stage = 'parse';
    const hourly = response?.hourly;
    if (!Array.isArray(hourly?.time) || !Array.isArray(hourly.rain) || !Array.isArray(hourly.showers)
      || hourly.time.length !== hourly.rain.length || hourly.time.length !== hourly.showers.length)
      throw new WeatherRequestError('schema');
    const hours = Array.from({ length: 24 }, (_, index) => {
      const end = index === 23 ? `${shiftDay(day, 1)}T00:00` : `${day}T${String(index + 1).padStart(2, '0')}:00`;
      const matches = hourly.time.flatMap((time: unknown, i: number) => time === end ? [i] : []);
      if (matches.length !== 1) throw new WeatherRequestError('schema');
      const rain = hourly.rain[matches[0]], showers = hourly.showers[matches[0]];
      if (![rain, showers].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0))
        throw new WeatherRequestError('schema');
      return rain + showers;
    });
    if (!validHours(hours)) throw new WeatherRequestError('schema');
    const result = { hours, fetchedAt: new Date().toISOString() };
    stage = 'cache-write';
    await kv.set(key, result, { ex: 86400 });
    return result;
  } catch (error) {
    // A missing hourly forecast must not erase a confirmed daily rain warning.
    // Never turn missing/stale measurements into zero rain or invented times.
    console.warn('[hourly-rain-failure]', JSON.stringify({ stage, ...weatherFailureDetails(error) }));
    return null;
  }
}

const shanghaiTime = (value: Date | string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const mm = (value: number) => value > 0 && value < .01 ? '<0.01' : String(Number(value.toFixed(2)));
const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

export function rainReminderNotes(input: { checkedAt: Date; city: SceneCity; day: string;
  weather: { code?: number; precipitation: number }; fetchedAt?: string; hourly: HourlyRain | null }) {
  const { checkedAt, city, day, weather, fetchedAt, hourly } = input;
  const lines = [`天气查询：${shanghaiTime(checkedAt)}（北京时间）`, `城市：${city.name}`,
    `当日预报：${day} · ${weatherSymbol(weather.code)?.label ?? '有降水'}；全天降水 ${mm(weather.precipitation)} 毫米`];
  if (fetchedAt && Number.isFinite(Date.parse(fetchedAt))) lines.push(`日预报获取：${shanghaiTime(fetchedAt)}`);
  if (!hourly) return [...lines, '预计降雨时段、雨量：逐时预报暂不可用'].join('\n');
  lines.push(`逐时预报获取：${shanghaiTime(hourly.fetchedAt)}`, '预计降雨（北京时间）：');
  const periods: { start: number; end: number; total: number; peak: number }[] = [];
  hourly.hours.forEach((amount, hour) => {
    if (amount <= 0) return;
    const previous = periods.at(-1);
    if (previous?.end === hour) { previous.end++; previous.total += amount; previous.peak = Math.max(previous.peak, amount); }
    else periods.push({ start: hour, end: hour + 1, total: amount, peak: amount });
  });
  if (!periods.length) lines.push('逐时预报未给出降雨时段，与当日有雨判断不一致');
  else for (const period of periods) lines.push(`${clock(period.start)}–${clock(period.end)}：雨量 ${mm(period.total)} 毫米，最大小时雨量 ${mm(period.peak)} 毫米`);
  return lines.join('\n');
}
