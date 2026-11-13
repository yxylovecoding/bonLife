import type { AppConfig, DayOverrides, InternshipPeriod, InternshipRules, LivingKind, SceneCity, TagKind } from '../models/types.js';
import type { HolidayDataByYear } from '../utils/holidays.js';
import { cityLabel, readSceneCity } from '../utils/sceneCities.js';
import { schoolPeriodAt } from '../utils/schoolPeriods.js';

export const BEIJING: SceneCity = { name: '北京', latitude: 39.9042, longitude: 116.4074, timezone: 'Asia/Shanghai' };
export const GUANGZHOU: SceneCity = { name: '广州', latitude: 23.1291, longitude: 113.2644, timezone: 'Asia/Shanghai' };
export const DEFAULT_INTERNSHIP_RULES: InternshipRules = {
  workweek: 'statutory', salaryKind: 'daily', salary: null, cycle: 'calendar', cutoffDay: 25, cutoffOffset: 6,
  payMonthOffset: 1, payKind: 'fixed', payDay: 10, payAdjustment: 'none',
  housingKind: 'none', housingAmount: 0, housingProrated: true, housingTaxable: true,
};
export function validDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
export const shiftDay = (date: string, count: number) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
export function dateRange(start: string, end: string): string[] {
  if (!validDate(start) || !validDate(end) || start > end || Date.parse(end) - Date.parse(start) > 3660 * 86400000) return [];
  const dates: string[] = [];
  for (let date = start; date <= end; date = shiftDay(date, 1)) dates.push(date);
  return dates;
}
export function companyWorkingDate(date: string, rules: Pick<InternshipRules, 'workweek'>, holidays: HolidayDataByYear = {}) {
  const holiday = holidays[Number(date.slice(0, 4))]?.[date];
  if (rules.workweek === 'statutory' && holiday) return !holiday.isOffDay;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}
export const cityKey = (city: SceneCity | null | undefined) => city ? `${city.latitude.toFixed(2)},${city.longitude.toFixed(2)}` : 'unknown';
export const sameCity = (a: SceneCity | null | undefined, b: SceneCity | null | undefined) => Boolean(a && b
  && (a.name === b.name || (Math.abs(a.latitude - b.latitude) < 0.2 && Math.abs(a.longitude - b.longitude) < 0.2)));
export function rulesError(r: InternshipRules): string | null {
  if (!r || !Number.isFinite(r.salary) || r.salary === null || r.salary < 0) return '请填写工资金额';
  if (!['statutory', 'weekdays'].includes(r.workweek) || !['daily', 'monthly'].includes(r.salaryKind)
    || !['calendar', 'cutoff', 'beforePay'].includes(r.cycle) || !['fixed', 'monthEnd', 'lastWorkingDay'].includes(r.payKind)
    || !['none', 'previous', 'next'].includes(r.payAdjustment) || !['none', 'monthly', 'residence', 'attendance'].includes(r.housingKind)
    || ![0, 1].includes(r.payMonthOffset)) return '计薪规则无效';
  if (!Number.isInteger(r.payDay) || r.payDay < 1 || r.payDay > 31 || !Number.isInteger(r.cutoffDay) || r.cutoffDay < 1 || r.cutoffDay > 31
    || !Number.isInteger(r.cutoffOffset) || r.cutoffOffset < 0 || r.cutoffOffset > 28) return '发薪或截薪日期无效';
  if (r.monthlyDivisor !== undefined && (!Number.isFinite(r.monthlyDivisor) || r.monthlyDivisor <= 0)) return '月薪折算天数须大于零';
  if (!Number.isFinite(r.housingAmount) || r.housingAmount < 0) return '房补金额无效';
  return null;
}
export function periodReady(p: InternshipPeriod): boolean {
  return Boolean(p && validDate(p.startDate) && validDate(p.endDate) && p.startDate <= p.endDate
    && Date.parse(p.endDate) - Date.parse(p.startDate) <= 3660 * 86400000 && readSceneCity(p.city) && !rulesError(p.rules));
}
export function periodOverlap(period: InternshipPeriod, periods: InternshipPeriod[]) {
  if (!validDate(period.startDate) || !validDate(period.endDate) || period.startDate > period.endDate) return false;
  return periods.some(p => p.id !== period.id && validDate(p.startDate) && validDate(p.endDate)
    && p.startDate <= p.endDate && period.startDate <= p.endDate && p.startDate <= period.endDate);
}
export function internshipStart(config: Partial<AppConfig>): string | undefined {
  return [config.internshipEnabledFrom, ...(config.internshipPeriods ?? []).filter(periodReady).map(p => p.startDate)]
    .filter((date): date is string => Boolean(date && validDate(date))).sort()[0];
}
export interface DailyContext {
  date: string;
  city: SceneCity | null;
  period?: InternshipPeriod;
  planned: boolean;
  working: boolean;
  paid: boolean;
  tag: TagKind;
  livingKind: LivingKind;
  awayInternship?: boolean;
  label: string;
}
export interface InternshipContext {
  config: Partial<AppConfig>;
  dayOverrides?: DayOverrides;
  holidayDataByYear?: HolidayDataByYear;
}
export function resolveDailyContext(date: string, rawTag: TagKind | undefined, input: InternshipContext): DailyContext {
  const { config, dayOverrides = {}, holidayDataByYear = {} } = input;
  const start = internshipStart(config), planned = Boolean(start && date >= start);
  const periods = (config.internshipPeriods ?? []).filter(p => periodReady(p) && date >= p.startDate && date <= p.endDate);
  // Conflicting cloud edits never silently choose one employer and pay twice.
  const period = periods.length === 1 ? periods[0] : undefined;
  const away = rawTag === 'home' || rawTag === 'travel';
  const override = dayOverrides[date];
  const schoolPeriod = schoolPeriodAt(date, config);
  const school = readSceneCity(schoolPeriod?.city)
    ?? readSceneCity((start && date < start ? config.internshipLegacyCity : null) ?? config.schoolCity);
  // School history must not move legacy internships to a former school city.
  const residence = !planned && rawTag === 'intern'
    ? readSceneCity(config.internshipLegacyCity ?? config.schoolCity) ?? school : school;
  const city = readSceneCity(override?.city) ?? (rawTag === 'home' ? readSceneCity(config.homeCity)
    : rawTag === 'travel' ? null : period?.city ?? residence);
  const working = !away && (period
    ? override?.attendance ? override.attendance === 'work' : companyWorkingDate(date, period.rules, holidayDataByYear)
    : !planned && rawTag === 'intern');
  const local = period && sameCity(period.city, schoolPeriod?.city ?? period.schoolCity ?? school);
  const tag: TagKind = away ? rawTag : period ? working || !local ? 'intern' : 'school' : planned ? 'school' : rawTag ?? 'school';
  const livingKind: LivingKind = away ? rawTag : working ? 'work' : period && !local ? 'rest' : 'school';
  const suffix = livingKind === 'work' ? '班' : livingKind === 'rest' ? '休' : livingKind === 'school' ? '校' : livingKind === 'home' ? '寄' : '游';
  const cityName = cityLabel(city);
  return { date, city, period, planned, working, paid: working, tag, livingKind, awayInternship: Boolean(period && !local), label: `${cityName ? `${cityName}·` : ''}${suffix}` };
}
export function resolvedTagMap(raw: Record<string, TagKind>, input: InternshipContext) {
  const dates = new Set(Object.keys(raw));
  for (const p of input.config.internshipPeriods ?? []) if (periodReady(p)) dateRange(p.startDate, p.endDate).forEach(d => dates.add(d));
  return Object.fromEntries([...dates].map(date => [date, resolveDailyContext(date, raw[date], input).tag]));
}
export function normalizeDayOverrides(value: unknown): DayOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([date, raw]) => {
    if (!validDate(date) || !raw || typeof raw !== 'object') return [];
    const v = raw as { city?: unknown; attendance?: unknown; attendanceLocked?: unknown }, city = readSceneCity(v.city);
    const attendance = v.attendance === 'work' || v.attendance === 'rest' ? v.attendance : undefined;
    return city || attendance ? [[date, { ...(city ? { city } : {}), ...(attendance ? { attendance, ...(v.attendanceLocked === true ? { attendanceLocked: true } : {}) } : {}) }]] : [];
  }));
}

export function resolveCalendarState(configState: unknown, calendarState: unknown) {
  const config = (configState as { config?: Partial<AppConfig> } | null)?.config ?? {};
  const calendar = (calendarState ?? {}) as { tagMap?: Record<string, TagKind>; dayOverrides?: DayOverrides; holidayDataByYear?: HolidayDataByYear };
  const dayOverrides = normalizeDayOverrides(calendar.dayOverrides);
  const holidayDataByYear = calendar.holidayDataByYear ?? {};
  const tagMap = resolvedTagMap(calendar.tagMap ?? {}, { config, dayOverrides, holidayDataByYear });
  // Derived only for this read; never persist these maps over the source calendar.
  const cityMap = Object.fromEntries([...new Set([...Object.keys(tagMap), ...Object.keys(dayOverrides)])]
    .filter(validDate).map(date => [date, resolveDailyContext(date, tagMap[date], { config, dayOverrides, holidayDataByYear }).city]));
  const locationCities = [BEIJING, GUANGZHOU, config.schoolCity, config.homeCity, config.internshipLegacyCity,
    ...(config.schoolPeriods ?? []).map(p => p.city),
    ...(config.internshipPeriods ?? []).flatMap(p => [p.city, p.schoolCity]), ...Object.values(cityMap)]
    .map(readSceneCity).filter((city): city is SceneCity => city !== null);
  return { ...calendar, tagMap, cityMap, locationCities };
}
