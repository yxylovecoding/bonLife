import type { SchedulingRuleId } from './schedulingRules.js';
import type { TagKind } from '../models/types';

export type OutlookCalendarKind = 'play' | 'class' | 'calendar' | 'work';
export type OutlookTag = Extract<TagKind, 'travel' | 'intern' | 'home'>;
export type OutlookConflictPolicy = 'manual' | 'outlook';

export interface OutlookDayEvent {
  taskLink?: { taskId: string; projectId: string };
  location?: string;
  uid?: string;
  recurrenceId?: string;
  calendar: OutlookCalendarKind;
  title: string;
  startDate: string;
  endDate: string; // Exclusive. All-day dates stay local; timed dates are ISO instants.
  allDay: boolean;
  cancelled?: boolean;
}

export interface OutlookRules {
  homeTitles: string[];
  ignoredPlayTitles: string[];
}

export const DEFAULT_OUTLOOK_RULES: OutlookRules = { homeTitles: ['🏠'], ignoredPlayTitles: ['新卡池', '新卡池&新月卡'] };

export function isPeriodCalendarTitle(title: string): boolean {
  return /月经|🩸/u.test(title);
}

function isInternshipCalendarTitle(title: string): boolean {
  // Emoji and parenthesized notes such as LastDay do not turn an internship into a trip.
  const text = title.replace(/[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F]/gu, '').trim();
  return /^实习(?:\s*(?:\([^()]*\)|（[^（）]*）))*$/u.test(text);
}

// Match holiday/break reminders exactly, leaving actual trips such as 平遥电影节 or 寒假旅行 intact.
const HOLIDAY_REMINDER_TITLES = new Set([
  '寒假', '暑假',
  '元旦', '元旦节', '春节', '除夕', '元宵节', '清明节', '劳动节', '端午节', '中秋节', '国庆节',
  '七夕', '七夕节', '重阳节', '妇女节', '植树节', '青年节', '儿童节', '建党节', '建军节', '教师节',
  '情人节', '母亲节', '父亲节', '感恩节', '平安夜', '圣诞', '圣诞节',
]);

export interface OutlookWishEvent {
  available?: boolean;
  key: string;
  uid: string;
  recurrenceId?: string;
  calendar: OutlookCalendarKind;
  title: string;
  startDate: string;
  endDate: string;
}
export function normalizeOutlookWishEvents(input: unknown): OutlookWishEvent[] {
  if (!Array.isArray(input)) return [];
  return [...new Map(input.filter((event): event is OutlookWishEvent => !!event && typeof event === 'object'
    && typeof event.uid === 'string' && !!event.uid.trim()
    && ['play', 'class', 'work', 'calendar'].includes(event.calendar)
    && (event.recurrenceId === undefined || typeof event.recurrenceId === 'string')
    && typeof event.title === 'string' && !isPeriodCalendarTitle(event.title)
    && isCalendarDate(event.startDate) && isCalendarDate(event.endDate)
    && event.startDate < event.endDate)
    .map((event) => { const key = JSON.stringify([event.calendar, event.uid, event.recurrenceId ?? '']); return [key, { ...event, key }]; })).values()];
}
export interface OutlookSnapshot {
  provider?: 'outlook' | 'google';
  ruleOrder?: SchedulingRuleId[];
  ruleCandidates?: Record<string, SchedulingRuleId[]>;
  startDate: string;
  endDate: string;
  tags: Record<string, OutlookTag>;
  travelTitles?: Record<string, string>;
  wishEvents?: OutlookWishEvent[];
  availability?: OutlookAvailability;
}

export interface OutlookAvailability {
  startDate: string;
  endDate: string;
  events: { title: string; start: string; end: string; taskLink?: { taskId: string; projectId: string } }[];
}

export interface OutlookAppliedDay {
  tag: OutlookTag;
  previousTag: TagKind | null;
}

export type OutlookAppliedDays = Record<string, OutlookAppliedDay>;

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function nextCalendarDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function buildOutlookSnapshot(
  events: OutlookDayEvent[], startDate: string, endDate: string, rules: OutlookRules, ruleOrder?: SchedulingRuleId[],
): OutlookSnapshot {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate >= endDate
    || Date.parse(endDate) - Date.parse(startDate) > 740 * 86_400_000) {
    throw new Error('日历同步日期无效');
  }
  const tags: Record<string, OutlookTag> = {};
  const ruleCandidates: Record<string, SchedulingRuleId[]> = {};
  const titlesByDay: Record<string, Set<string>> = {};
  const wishEvents: OutlookWishEvent[] = [];
  const homeTitles = new Set(rules.homeTitles.map((title) => title.trim()));
  const ignoredTitles = new Set(rules.ignoredPlayTitles.map((title) => title.trim()));
  const priority = ruleOrder ? { intern: -ruleOrder.indexOf('calendar-intern'), home: -ruleOrder.indexOf('calendar-home'), travel: -ruleOrder.indexOf('calendar-travel') } : { intern: 1, home: 2, travel: 3 };
  for (const event of events) {
    if (!event.allDay || event.cancelled) continue;
    const title = event.title.trim();
    if (HOLIDAY_REMINDER_TITLES.has(title) || isPeriodCalendarTitle(title)) continue;
    const isClassLike = event.calendar === 'class' || event.calendar === 'work';
    const tag: OutlookTag | null = isInternshipCalendarTitle(title) ? 'intern' : isClassLike
      ? 'travel'
      : ignoredTitles.has(title) ? null : homeTitles.has(title) ? 'home' : 'travel';
    if (!tag) continue;
    const id: SchedulingRuleId = tag === 'travel' ? 'calendar-travel' : tag === 'home' ? 'calendar-home' : 'calendar-intern';
    if (ruleOrder && !ruleOrder.includes(id)) continue;
    if (!isCalendarDate(event.startDate) || !isCalendarDate(event.endDate) || event.startDate >= event.endDate) {
      throw new Error('Outlook 全天日程日期无效');
    }
    const start = event.startDate > startDate ? event.startDate : startDate;
    const end = event.endDate < endDate ? event.endDate : endDate;
    if (start < end && tag === 'travel' && event.uid) wishEvents.push({ key: '', uid: event.uid, recurrenceId: event.recurrenceId, calendar: event.calendar, title, startDate: event.startDate, endDate: event.endDate });
    for (let day = start; day < end; day = nextCalendarDate(day)) {
      if (!(ruleCandidates[day] ??= []).includes(id)) ruleCandidates[day].push(id);
      if (!tags[day] || priority[tag] > priority[tags[day]]) tags[day] = tag;
      if (tag === 'travel' && title) (titlesByDay[day] ??= new Set()).add(title);
    }
  }
  const travelTitles = Object.fromEntries(Object.entries(titlesByDay).map(([day, titles]) => [day, [...titles].sort().join('、')]));
  return { startDate, endDate, tags, travelTitles, ...(ruleOrder ? { ruleOrder, ruleCandidates } : {}), ...(wishEvents.length ? { wishEvents: normalizeOutlookWishEvents(wishEvents) } : {}) };
}

export function normalizeOutlookTravelTitles(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input).filter(([day, title]) => isCalendarDate(day) && typeof title === 'string' && title.trim()).map(([day, title]) => [day, (title as string).trim()]));
}

// Older snapshots joined all event titles with 、, including period reminders.
function withoutPeriodTitles(title: string): string {
  return title.split('、').map((part) => part.trim()).filter((part) => part && !isPeriodCalendarTitle(part)).join('、');
}

export function getTripDisplayTitle(billTag: string | undefined, dates: string[], travelTitles: Record<string, string>): string {
  return billTag?.trim() || [...new Set(dates.map((day) => travelTitles[day]).filter(Boolean))].join('、');
}

export function reconcileOutlookSnapshot(
  current: Record<string, TagKind>, applied: OutlookAppliedDays, manualDates: Record<string, true>,
  snapshot: OutlookSnapshot, policy: OutlookConflictPolicy,
  today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()),
): { tagMap: Record<string, TagKind>; outlookApplied: OutlookAppliedDays; manualTagDates: Record<string, true> } {
  const tagMap = { ...current };
  const outlookApplied = { ...applied };
  const manualTagDates = { ...manualDates };
  const days = new Set([...Object.keys(applied), ...Object.keys(snapshot.tags)]);
  for (const day of days) {
    if (day < snapshot.startDate || day >= snapshot.endDate) continue;
    const previous = applied[day];
    const next = snapshot.tags[day];
    const manuallyChanged = Boolean(manualDates[day]) || (previous && current[day] !== previous.tag);
    if (!next) {
      // Published feeds have a rolling window: absence is not evidence of a past cancellation.
      if (day < today) continue;
      if (previous && current[day] === previous.tag && (!manuallyChanged || previous.tag === 'travel')) {
        if (previous.previousTag && !(previous.tag === 'travel' && previous.previousTag === 'travel')) tagMap[day] = previous.previousTag;
        else delete tagMap[day];
        if (previous.tag === 'travel') delete manualTagDates[day];
      }
      delete outlookApplied[day];
      continue;
    }
    // Older calendars do not distinguish hand-entered school days from automatic school defaults.
    const legacyManual = !previous && current[day] && current[day] !== 'school';
    // A trip's full dates come from Outlook; local work/week templates must not split it.
    const outlookTrip = next === 'travel' || previous?.tag === 'travel';
    const rule = next === 'travel' ? 'calendar-travel' : next === 'home' ? 'calendar-home' : 'calendar-intern';
    const manualWins = snapshot.ruleOrder ? snapshot.ruleOrder.includes('calendar-manual') && snapshot.ruleOrder.indexOf('calendar-manual') < snapshot.ruleOrder.indexOf(rule) : !outlookTrip && policy === 'manual';
    if (manualWins && (manuallyChanged || legacyManual)) continue;
    const previousTag = previous && (!manuallyChanged || current[day] === previous.tag) ? previous.previousTag : current[day] ?? null;
    tagMap[day] = next;
    // Do not restore an old local trip date after this Outlook trip moves or is cancelled.
    outlookApplied[day] = { tag: next, previousTag: outlookTrip && previousTag === 'travel' ? null : previousTag };
    delete manualTagDates[day];
  }
  return { tagMap, outlookApplied, manualTagDates };
}

export function normalizeOutlookCalendarState(state: Record<string, unknown>) {
  const manualTagDates: Record<string, true> = {};
  const outlookApplied: OutlookAppliedDays = {};
  const validTag = (value: unknown): value is TagKind => ['intern', 'school', 'home', 'travel'].includes(String(value));
  if (state.manualTagDates && typeof state.manualTagDates === 'object') {
    for (const [day, value] of Object.entries(state.manualTagDates)) if (isCalendarDate(day) && value === true) manualTagDates[day] = true;
  }
  if (state.outlookApplied && typeof state.outlookApplied === 'object') {
    for (const [day, raw] of Object.entries(state.outlookApplied)) {
      const value = raw as Partial<OutlookAppliedDay> | null;
      if (isCalendarDate(day) && value && ['intern', 'home', 'travel'].includes(String(value.tag))
        && (value.previousTag === null || validTag(value.previousTag))) outlookApplied[day] = value as OutlookAppliedDay;
    }
  }
  return { manualTagDates, outlookApplied };
}

// Shared by the browser and background sync so cancellations and manual overrides agree.
export function applyOutlookSnapshotToState(state: Record<string, unknown>, snapshot: OutlookSnapshot, policy: OutlookConflictPolicy,
  today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())) {
  const source = normalizeOutlookCalendarState(state);
  const tagMap = state.tagMap && typeof state.tagMap === 'object' ? { ...state.tagMap } as Record<string, TagKind> : {};
  const outlookTravelTitles = normalizeOutlookTravelTitles(state.outlookTravelTitles);
  for (const [day, title] of Object.entries(outlookTravelTitles)) {
    const cleaned = withoutPeriodTitles(title);
    if (cleaned) outlookTravelTitles[day] = cleaned;
    else {
      delete outlookTravelTitles[day];
      const previous = source.outlookApplied[day];
      // Explicit title evidence can repair past misclassification, even after the
      // feed window moves on. Never infer cancellation from an absent past event.
      if (previous?.tag !== 'travel') continue;
      if (tagMap[day] === previous.tag) {
        if (previous.previousTag && previous.previousTag !== 'travel') tagMap[day] = previous.previousTag;
        else delete tagMap[day];
        delete source.manualTagDates[day];
      }
      delete source.outlookApplied[day];
    }
  }
  // Saved server snapshots are also replayed over browser uploads. Sanitize them
  // before reconciliation so an older cache cannot put the period trip back.
  snapshot = { ...snapshot, tags: { ...snapshot.tags }, travelTitles: normalizeOutlookTravelTitles(snapshot.travelTitles) };
  for (const [day, title] of Object.entries(snapshot.travelTitles!)) {
    const cleaned = withoutPeriodTitles(title);
    if (cleaned) snapshot.travelTitles![day] = cleaned;
    else {
      delete snapshot.travelTitles![day];
      if (snapshot.tags[day] === 'travel') delete snapshot.tags[day];
    }
  }
  const next = reconcileOutlookSnapshot(tagMap, source.outlookApplied, source.manualTagDates, snapshot, policy, today);
  for (const day of Object.keys(outlookTravelTitles)) {
    if (day >= snapshot.startDate && day < snapshot.endDate && (day >= today || snapshot.tags[day])) delete outlookTravelTitles[day];
  }
  for (const [day, title] of Object.entries(normalizeOutlookTravelTitles(snapshot.travelTitles))) {
    if (day >= snapshot.startDate && day < snapshot.endDate && snapshot.tags[day] === 'travel') outlookTravelTitles[day] = title;
  }
  const retained = normalizeOutlookWishEvents(state.outlookWishEvents).filter((event) => event.endDate <= snapshot.startDate || event.startDate >= snapshot.endDate).map((event) => ({ ...event, available: false }));
  const outlookWishEvents = normalizeOutlookWishEvents([...retained, ...normalizeOutlookWishEvents(snapshot.wishEvents)]);
  return { ...state, ...next, outlookTravelTitles, outlookWishEvents };
}
