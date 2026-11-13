import { kv } from './_accountKv.js';
import { readCalendarLocations } from './_calendarWeather.js';
import { readDailyWeather } from './_dailyWeather.js';
import { sleepWindow } from './_ticktickSleepTags.js';
import { calendarDateInTimeZone, type TickTickApi, type TickTickTask } from './_ticktickTrips.js';

export const rainReminderKey = (connectionId: string) => `ticktick:rain-reminder:v1:${connectionId}`;
export const isRainReminder = (task: TickTickTask) => task.title === '关窗'
  && ['活', '当天'].every(tag => task.tags?.includes(tag)) && !task.repeatFlag;

// Called inside Orche's shared lock and task draft. Persist only after verified writes.
export async function planRainReminder(api: TickTickApi, options: {
  connectionId: string; projectId: string; tasks: TickTickTask[]; completedTasks: TickTickTask[];
  calendarState: unknown; now: Date; deferState: (save: () => Promise<unknown>) => void;
}) {
  const { day, hidden } = sleepWindow(options.now);
  const noon = Date.parse(`${day}T12:00:00+08:00`);
  if (hidden || options.now.getTime() >= noon) return { reason: '不在晨间检查时段（05:01–11:59）' };
  const key = rainReminderKey(options.connectionId);
  if (await kv.get<string>(key) === day) return { reason: '当天已检查' };
  const finish = () => options.deferState(() => kv.set(key, day));
  // Recover an already-created task after an interrupted run, including completion.
  if ([...options.tasks, ...options.completedTasks].some(task => isRainReminder(task)
    && calendarDateInTimeZone(task.startDate || task.dueDate, 'Asia/Shanghai') === day)) {
    finish(); return { reason: '已有同日关窗，不重复创建' };
  }
  const locations = (await readCalendarLocations(day, day, options.calendarState))[day];
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
  if (rainy) {
    const time = `${day}T08:00:00+0800`;
    await api.createTask({ projectId: options.projectId, title: '关窗', startDate: time, dueDate: time,
      timeZone: 'Asia/Shanghai', isAllDay: false, priority: 0, tags: ['活', '当天'], reminders: ['TRIGGER:PT0S'] });
  }
  finish();
  return { reason: rainy ? '有雨，已生成当天 08:00 关窗提醒' : '当天预报无雨，无需关窗提醒' };
}
