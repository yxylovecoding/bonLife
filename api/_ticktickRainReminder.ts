import { kv } from './_accountKv.js';
import { readCalendarLocations } from './_calendarWeather.js';
import { readDailyWeather } from './_dailyWeather.js';
import { sleepWindow } from './_ticktickSleepTags.js';
import { calendarDateInTimeZone, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';

export const rainReminderKey = (connectionId: string) => `ticktick:rain-reminder:v1:${connectionId}`;
export const isRainReminder = (task: TickTickTask) => task.title === '关窗'
  && ['活', '当天'].every(tag => task.tags?.includes(tag)) && !task.repeatFlag;
export const isRainReminderOnDay = (task: TickTickTask, day: string) => isRainReminder(task)
  && [0, 2, -1].includes(task.status ?? 0)
  && calendarDateInTimeZone(task.startDate || task.dueDate, 'Asia/Shanghai') === day;

// Called inside Orche's shared lock and task draft. Persist only after verified writes.
export async function planRainReminder(api: TickTickApi, options: {
  connectionId: string; projectId: string; tasks: TickTickTask[]; completedTasks: TickTickTask[]; abandonedTasks: TickTickTask[];
  calendarState: unknown; now: Date; deferState: (save: () => Promise<unknown>) => void;
  verifyReminder: () => Promise<boolean>;
  manualDate?: string;
}) {
  const { day, hidden } = sleepWindow(options.now);
  const noon = Date.parse(`${day}T12:00:00+08:00`);
  if (options.manualDate !== undefined && options.manualDate !== day) throw new Error('补跑日期必须是北京时间今天');
  if (!options.manualDate && (hidden || options.now.getTime() >= noon)) return { reason: '不在晨间检查时段（05:01–11:59）' };
  const key = rainReminderKey(options.connectionId);
  if (await kv.get<string>(key) === day) return { reason: '当天已检查' };
  const finish = (needsReminder: boolean) => options.deferState(async () => {
    // A draft match is provisional. Cancelled or unconfirmed writes cannot
    // consume the day, even if another rule proposed a same-day reminder.
    if (needsReminder && !await options.verifyReminder()) throw new Error('当天关窗任务未确认，保留重试机会');
    return kv.set(key, day);
  });
  // Recover an already-created task after an interrupted run, including completion.
  if ([...options.tasks, ...options.completedTasks, ...options.abandonedTasks].some(task => isRainReminderOnDay(task, day))) {
    finish(true); return { reason: '已有同日关窗，不重复创建' };
  }
  const { rainy } = await readRainReminderForecast(day, options.calendarState);
  if (rainy) {
    const time = `${day}T08:00:00+0800`;
    await api.createTask({ projectId: options.projectId, title: '关窗', startDate: time, dueDate: time,
      timeZone: 'Asia/Shanghai', isAllDay: false, priority: 0, tags: ['活', '当天'], reminders: ['TRIGGER:PT0S'] });
  }
  finish(rainy);
  return { reason: rainy ? '有雨，已生成当天 08:00 关窗提醒' : '当天预报无雨，无需关窗提醒' };
}

export async function readRainReminderForecast(day: string, calendarState: unknown) {
  const locations = (await readCalendarLocations(day, day, calendarState))[day];
  if (!locations || locations.error || locations.unresolved?.length || locations.locations.length !== 1)
    throw new Error('boncal 当天城市未确认');
  const city = locations.locations[0];
  const forecast = await readDailyWeather(city, day, day, 'Asia/Shanghai');
  const weather = forecast.days[day];
  if (forecast.stale || forecast.error || !weather || !Number.isFinite(weather.precipitation))
    throw new Error('当天降雨预报未确认');
  const rainCodes = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];
  const snowCodes = [71, 73, 75, 77, 85, 86];
  const rainy = rainCodes.includes(weather.code!) || weather.precipitation > 0 && !snowCodes.includes(weather.code!);
  return { city, weather, rainy, fetchedAt: forecast.fetchedAt };
}
