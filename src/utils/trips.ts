import type { BillExpenseItem, BillExpenseMonth } from './importBill';

export const SYSTEM_BILL_TAGS = new Set([
  '周期生活', '波动生活', '消费', '吃好喝好', '红', '黑',
]);

// 出游 tag 形如「26.5.15 爬山」「26.5.15爬山」「26.5 春节」「26.5春节」：
// yy.m 或 yy.m.d，后跟可选空白 + 描述
export const TRIP_TAG_PATTERN = /^(\d{2})\.(\d{1,2})(?:\.(\d{1,2}))?\s*\S/;

export function isTripTagFormat(tag: string): boolean {
  return TRIP_TAG_PATTERN.test(tag);
}

export function isDailyTripTagFormat(tag: string): boolean {
  return !!tag.match(TRIP_TAG_PATTERN)?.[3];
}

// 解析 tag 前缀 → "yy.m"（月份无前导 0），不匹配返回 null
export function tagYearMonthPrefix(tag: string): string | null {
  const m = tag.match(TRIP_TAG_PATTERN);
  if (!m) return null;
  return `${m[1]}.${Number(m[2])}`;
}

function parseTripRoute(tag: string) {
  const match = tag.trim().match(/^(\d{2})\.(\d{1,2})(?:\.(\d{1,2}))?\s*(.+)$/);
  if (!match) return null;
  const [, year, month, day, name] = match;
  if (Number(month) < 1 || Number(month) > 12 || (day && (Number(day) < 1 || Number(day) > 31))) return null;
  const stops = name.split(/[&＆+＋、/]/).map((stop) => stop.replace(/\s+/g, ''));
  if (stops.some((stop) => !stop)) return null;
  return { period: `${year}.${Number(month)}${day ? `.${Number(day)}` : ''}`, stops: [...new Set(stops)] };
}

/** 主路线包含同一日期前缀的完整子路线；普通标签仍精确匹配。 */
export function createTripTagMatcher(tag: string): (candidate: string) => boolean {
  const parent = parseTripRoute(tag);
  if (!parent || parent.stops.length < 2) return (candidate) => candidate === tag;
  return (candidate) => {
    if (candidate === tag) return true;
    const child = parseTripRoute(candidate);
    if (!child || child.period !== parent.period || child.stops.length >= parent.stops.length) return false;
    const matchedStops = new Set<number>();
    for (const stop of child.stops) {
      const index = parent.stops.findIndex((destination, index) => {
        if (stop === destination) return true;
        if (index === 0 || !stop.endsWith(destination)) return false;
        // “山西大同&临汾”中后续地点可沿用首站前缀：“山西临汾”。
        const prefix = stop.slice(0, -destination.length);
        return prefix.length > 0 && prefix.length < parent.stops[0].length && parent.stops[0].startsWith(prefix);
      });
      if (index < 0 || matchedStops.has(index)) return false;
      matchedStops.add(index);
    }
    return true;
  };
}

/** 仅在主标签实际存在于列表时隐藏其子标签，不生成或改写原始账单标签。 */
export function collapseTripTags(tags: readonly string[]): string[] {
  const unique = [...new Set(tags)];
  const parents = unique.filter((tag) => (parseTripRoute(tag)?.stops.length ?? 0) > 1)
    .map((tag) => ({ tag, matches: createTripTagMatcher(tag) }));
  return unique.filter((tag) => !parents.some((parent) => parent.tag !== tag && parent.matches(tag)));
}

export { detectAllTrips, detectTrips, detectTripGroups } from '../boncal/trips.js';
export type { TripSegment, TripGroup } from '../boncal/trips.js';

export interface TagCandidate { tag: string; hitInRange: number; totalHit: number; }

// 只把仍对应真实行程的其它标签视为已占用。历史行程被删除或重新切分后，
// tripTags 可能留下孤立键；这些旧记录不应继续隐藏候选标签。
export function getActiveTripTagsExcept(
  tripTags: Record<string, string>,
  activeTripStartDates: ReadonlySet<string>,
  currentStartDate: string,
): Set<string> {
  const tags = new Set<string>();
  for (const [startDate, tag] of Object.entries(tripTags)) {
    if (startDate !== currentStartDate && activeTripStartDates.has(startDate) && tag) {
      tags.add(tag);
    }
  }
  return tags;
}

// 从全部账单里抽取候选 tag：
// - 必须命中 TRIP_TAG_PATTERN（yy.m.d 描述）
// - 剔除系统 tag
// - tag 的「yy.m」前缀必须匹配 trip 跨越的某个年月（如 26 年 2 月的 trip 只看 26.2.x）
// - 排除 excludeTags（已被其它 trip 选过的）
// 排序：在 tripDates 范围内的命中次数降序
export function extractCandidateTags(
  allItems: BillExpenseItem[],
  tripDates: Set<string>,
  excludeTags: Set<string> = new Set(),
): TagCandidate[] {
  // 计算 trip 跨越的 yy.m 集合
  const tripYearMonths = new Set<string>();
  for (const d of tripDates) {
    const [y, m] = d.split('-');
    tripYearMonths.add(`${y.slice(-2)}.${Number(m)}`);
  }

  const map = new Map<string, Set<number>>();
  allItems.forEach((it, index) => {
    const tags = (it.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const t of tags) {
      if (SYSTEM_BILL_TAGS.has(t)) continue;
      const prefix = tagYearMonthPrefix(t);
      if (!prefix) continue;
      if (!tripYearMonths.has(prefix)) continue;
      const cur = map.get(t) ?? new Set<number>();
      cur.add(index);
      map.set(t, cur);
    }
  });
  const excluded = [...excludeTags].map((tag) => ({ tag, matches: createTripTagMatcher(tag) }));
  return collapseTripTags([...map.keys()]).flatMap((tag) => {
    const matches = createTripTagMatcher(tag);
    if (excluded.some((other) => other.matches(tag) || matches(other.tag))) return [];
    const indices = new Set([...map].flatMap(([candidate, hits]) => matches(candidate) ? [...hits] : []));
    return [{ tag, hitInRange: [...indices].filter((index) => tripDates.has(allItems[index].date)).length, totalHit: indices.size }];
  })
    .sort((a, b) => (b.hitInRange - a.hitInRange) || (b.totalHit - a.totalHit) || a.tag.localeCompare(b.tag));
}

export function sumBillsByTag(allItems: BillExpenseItem[], tag: string) {
  let totalAmount = 0;
  const items: BillExpenseItem[] = [];
  const matches = createTripTagMatcher(tag);
  for (const it of allItems) {
    const tags = (it.tags || '').split(',').map((t) => t.trim());
    if (tags.some(matches)) {
      totalAmount += it.amount;
      items.push(it);
    }
  }
  return { totalAmount: Math.round(totalAmount * 100) / 100, count: items.length, items };
}

export function flattenExpenseItems(
  byMonth: Record<string, BillExpenseMonth>,
): BillExpenseItem[] {
  const out: BillExpenseItem[] = [];
  for (const arr of Object.values(byMonth)) out.push(...arr);
  return out;
}
