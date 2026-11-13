import type { TagKind } from '../models/types.js';
import { getTripDisplayTitle, repairCalendarState } from './events.js';
import { tripDestinationQueries } from './destinations.js';

export function bonCalTrips(calendarState: unknown, tripState: unknown) {
  const calendar = repairCalendarState((calendarState ?? {}) as Record<string, unknown>);
  const settings = (tripState ?? {}) as { tripTags?: Record<string, string>; tripSplits?: Record<string, true>; tripNotes?: Record<string, string> };
  return detectAllTrips(calendar.tagMap, settings.tripSplits).map(trip => {
    const title = getTripDisplayTitle(settings.tripTags?.[trip.startDate], trip.dates, calendar.outlookTravelTitles);
    return { ...trip, id: `trip:${trip.startDate}`, title, destinations: tripDestinationQueries(title), notes: settings.tripNotes?.[trip.startDate] || '' };
  });
}
export interface TripSegment {
  startDate: string; // "YYYY-MM-DD"
  endDate: string;   // "YYYY-MM-DD"
  dates: string[];   // 连续日期数组
}

export function detectAllTrips(
  tagMap: Record<string, TagKind>,
  tripSplits: Record<string, true> = {},
): TripSegment[] {
  const travelDates = Object.entries(tagMap)
    .filter(([, tag]) => tag === 'travel')
    .map(([date]) => date)
    .sort();
  if (travelDates.length === 0) return [];
  return buildSegments(travelDates, new Set(Object.keys(tripSplits)));
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function addDays(date: string, delta: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function buildSegments(
  dates: string[],
  splitOnDates: Set<string>,
): TripSegment[] {
  const segments: TripSegment[] = [];
  let cur: string[] = [];
  for (const d of dates) {
    if (cur.length === 0) { cur = [d]; continue; }
    const contiguous = addDays(cur[cur.length - 1], 1) === d;
    const splitHere = splitOnDates.has(d);
    if (contiguous && !splitHere) cur.push(d);
    else {
      segments.push({ startDate: cur[0], endDate: cur[cur.length - 1], dates: cur });
      cur = [d];
    }
  }
  if (cur.length > 0) segments.push({ startDate: cur[0], endDate: cur[cur.length - 1], dates: cur });
  return segments;
}

// 找出所有连续 travel 段；只返回与 yearMonth 相交的段（含跨月延伸）
// tripSplits 中的日期会被视为「这一天开启新的一次出游」，即使前一天也是 travel。
export function detectTrips(
  tagMap: Record<string, TagKind>,
  yearMonth: string,
  tripSplits: Record<string, true> = {},
): TripSegment[] {
  const segments = detectAllTrips(tagMap, tripSplits);
  return segments.filter((s) =>
    s.dates.some((d) => d.startsWith(yearMonth)),
  );
}

// 返回原始连续段（忽略 splits），并对每段附上 splits 切出来的子 trip 数组。
// 用于卡片 UI 显示「切分点」控件。
export interface TripGroup {
  rawDates: string[];     // 该连续段的全部日期（未切分）
  trips: TripSegment[];   // splits 切分后的子 trip
}
export function detectTripGroups(
  tagMap: Record<string, TagKind>,
  yearMonth: string,
  tripSplits: Record<string, true> = {},
): TripGroup[] {
  const travelDates = Object.entries(tagMap)
    .filter(([, tag]) => tag === 'travel')
    .map(([date]) => date)
    .sort();
  if (travelDates.length === 0) return [];

  // 原始段（不切分）
  const rawSegs = buildSegments(travelDates, new Set());
  const splitSet = new Set(Object.keys(tripSplits));
  const groups: TripGroup[] = [];
  for (const seg of rawSegs) {
    if (!seg.dates.some((d) => d.startsWith(yearMonth))) continue;
    const subs = buildSegments(seg.dates, splitSet);
    groups.push({ rawDates: seg.dates, trips: subs });
  }
  return groups;
}
