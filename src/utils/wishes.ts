import { repairReminderWishes } from '../boncal/repair.js';
import { wishTripStarts, wishBillTags } from './wishAssociations';
import { wishRequiredIncome } from './wishRaiseSavings';
import type { TagKind, WishExtraExpenseItem, WishItem } from '../models/types';
import { roundToSitePrecision } from './numberInput';
import type { BillExpenseItem, BillExpenseMonth } from './importBill';
import { collapseTripTags, flattenExpenseItems, sumBillsByTag, SYSTEM_BILL_TAGS, tagYearMonthPrefix, type TripSegment } from './trips';
import { getTripDisplayTitle } from './outlookCalendar';

export const POST_LIFE_FLEXIBLE_SHARE = 0.5;
export const FLEXIBLE_WISH_SHARE = 0.8;
export const POST_LIFE_WISH_SHARE = POST_LIFE_FLEXIBLE_SHARE * FLEXIBLE_WISH_SHARE;
export const POST_LIFE_CONSUMPTION_SHARE = 0.1;
export const POST_LIFE_INVESTMENT_SHARE = 0.5;

export interface TravelWishEstimate {
  days: number;
  dailyLifeAmount: number;
  lifeAmount: number;
  ticketAmount: number;
  lodgingDailyAmount: number;
  lodgingAmount: number;
  extraExpenseAmount: number;
  targetAmount: number;
}

function normalizedAmount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(value ?? 0, 0) : 0;
}

function normalizedSignedAmount(value: number | undefined): number {
  return Number.isFinite(value) ? (value ?? 0) : 0;
}

export function resolveWishExtraExpenseItems(
  wish: Pick<WishItem, 'id' | 'travelExtraExpenseItems' | 'travelExtraExpenseAmount'>,
): WishExtraExpenseItem[] {
  if (Array.isArray(wish.travelExtraExpenseItems)) {
    return wish.travelExtraExpenseItems.map((item, index) => ({
      id: item.id || `extra_${wish.id}_${index}`,
      name: typeof item.name === 'string' ? item.name : '',
      amount: normalizedSignedAmount(item.amount),
    }));
  }
  const legacyAmount = normalizedSignedAmount(wish.travelExtraExpenseAmount);
  return legacyAmount !== 0
    ? [{ id: `legacy_extra_${wish.id}`, name: '其他消费', amount: legacyAmount }]
    : [];
}

export function totalWishExtraExpenseAmount(items: WishExtraExpenseItem[]): number {
  return items.reduce((sum, item) => sum + normalizedSignedAmount(item.amount), 0);
}

export function calculateTravelWishEstimate(
  days: number,
  dailyLifeAmount: number,
  ticketAmount?: number,
  lodgingDailyAmount?: number,
  extraExpenseAmount?: number,
): TravelWishEstimate {
  const normalizedDays = Number.isFinite(days) ? Math.max(Math.round(days), 0) : 0;
  const normalizedDailyLifeAmount = normalizedAmount(dailyLifeAmount);
  const normalizedTicketAmount = normalizedAmount(ticketAmount);
  const normalizedLodgingDailyAmount = normalizedAmount(lodgingDailyAmount);
  const normalizedExtraExpenseAmount = normalizedSignedAmount(extraExpenseAmount);
  const lodgingAmount = Math.max(normalizedDays - 1, 0) * normalizedLodgingDailyAmount;
  const lifeAmount = normalizedDays * normalizedDailyLifeAmount;
  return {
    days: normalizedDays,
    dailyLifeAmount: normalizedDailyLifeAmount,
    lifeAmount,
    ticketAmount: normalizedTicketAmount,
    lodgingDailyAmount: normalizedLodgingDailyAmount,
    lodgingAmount,
    extraExpenseAmount: normalizedExtraExpenseAmount,
    targetAmount: Math.max(normalizedTicketAmount + lodgingAmount + normalizedExtraExpenseAmount + lifeAmount, 0),
  };
}

export function calculateWishFunding(wish: WishItem, lifeAmount = 0) {
  const spentAmount = roundToSitePrecision(wish.billSpending?.amount ?? (wish.spentItems ?? []).reduce(
    (sum, item) => sum + normalizedAmount(item.amount), 0,
  ));
  const consumptionSpentAmount = roundToSitePrecision(normalizedAmount(wish.billSpending?.consumptionAmount ?? spentAmount));
  const lifeSpentAmount = normalizedAmount(wish.billSpending?.lifeAmount);
  const savedAmount = normalizedAmount(wish.savedAmount);
  const repaidAmount = Math.min(normalizedAmount(wish.repaidAmount), consumptionSpentAmount);
  // 行程结束后只需覆盖实际消费；未结束时，预估生活费与已知生活支出不重复扣除。
  const fundingTarget = wish.billSpending?.ended ? consumptionSpentAmount
    : Math.max(normalizedAmount(wish.targetAmount) - Math.max(normalizedAmount(lifeAmount), lifeSpentAmount), consumptionSpentAmount, 0);
  const fundedAmount = roundToSitePrecision(savedAmount + repaidAmount);
  return {
    spentAmount,
    consumptionSpentAmount,
    savedAmount,
    repaidAmount,
    fundingTarget,
    fundedAmount,
    debtAmount: roundToSitePrecision(consumptionSpentAmount - repaidAmount),
    remainingAmount: roundToSitePrecision(Math.max(fundingTarget - fundedAmount, 0)),
    progress: fundingTarget > 0 ? Math.min(fundedAmount / fundingTarget, 1) : 0,
  };
}

export function calculateWishDebtSummary(wishes: readonly WishItem[], total?: number) {
  const spentAmount = roundToSitePrecision(wishes.reduce(
    (sum, wish) => sum + calculateWishFunding(wish).consumptionSpentAmount, 0,
  ));
  const totalAmount = total === undefined ? spentAmount : roundToSitePrecision(normalizedAmount(total));
  return {
    totalAmount,
    assignedAmount: Math.min(spentAmount, totalAmount),
    unassignedAmount: roundToSitePrecision(Math.max(totalAmount - spentAmount, 0)),
    repaidAmount: roundToSitePrecision(Math.max(spentAmount - totalAmount, 0)),
  };
}

/** 仅根据当前总欠款和已花推算，按截止日分配；不依赖已攒、旧已还或录入历史。 */
export function resolveWishRepayments(wishes: readonly WishItem[], total?: number): WishItem[] {
  let remaining = calculateWishDebtSummary(wishes, total).repaidAmount;
  const repayments = new Map<string, number>();
  const ordered = [...wishes].sort((first, second) => (
    (first.deadline || '9999-12-31').localeCompare(second.deadline || '9999-12-31')
    || first.id.localeCompare(second.id)
  ));
  for (const wish of ordered) {
    if (remaining <= 0) break;
    const amount = Math.min(calculateWishFunding(wish).consumptionSpentAmount, remaining);
    if (amount <= 0) continue;
    repayments.set(wish.id, amount);
    remaining = roundToSitePrecision(remaining - amount);
  }
  return wishes.map((wish) => ({ ...wish, repaidAmount: repayments.get(wish.id) ?? 0 }));
}

export function wishTravelLifeAmount(wish: WishItem, dailyLifeAmount: number, tripDatesByStart?: Record<string, string[]>) {
  if (wish.billSpending?.ended) return 0;
  const starts = wishTripStarts(wish);
  const dates = starts.flatMap((start) => tripDatesByStart?.[start] ?? []);
  const days = dates.length ? new Set(dates).size : Math.max(Math.round(wish.plannedTravelDays ?? 0), 0);
  return Math.max(days * normalizedAmount(dailyLifeAmount) - normalizedAmount(wish.travelLifeCorrectionAmount), 0);
}

function wishTagName(value: string) {
  return value.trim().replace(/^\d{2}\.\d{1,2}(?:\.\d{1,2})?\s*/, '').replace(/\s+/g, '').toLowerCase();
}

/** “XX”与“XX心愿”视为同一个出游心愿，避免手动项和自动项并存。 */
function wishTripMatchName(value: string) {
  return wishTagName(value).replace(/心愿$/, '');
}

export function classifyWishBill(item: Pick<BillExpenseItem, 'tags'>): 'consumption' | 'life' | 'unclassified' {
  const tags = new Set((item.tags || '').split(',').map((tag) => tag.trim()));
  const consumption = tags.has('消费');
  const life = tags.has('生活') || tags.has('周期生活') || tags.has('波动生活');
  if (consumption && !life) return 'consumption';
  if (life && !consumption) return 'life';
  return 'unclassified';
}

/** 出游所选标签优先，否则按心愿名称匹配；已花始终来自账单，不使用旧手填数据。 */
export function resolveWishBillSpending(
  wishes: readonly WishItem[],
  trips: readonly TripSegment[],
  tripTags: Record<string, string>,
  expenseItems: Record<string, BillExpenseMonth>,
  today: string,
): WishItem[] {
  const tripsByStart = new Map(trips.map((trip) => [trip.startDate, trip]));
  const allItems = flattenExpenseItems(expenseItems);
  const allTags = [...new Set(allItems.flatMap((item) => (item.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean)))];
  const summaries = new Map<string, ReturnType<typeof sumBillsByTag>>();
  return wishes.map((wish) => {
    const linkedTrips = wishTripStarts(wish).flatMap((start) => { const found = tripsByStart.get(start); return found ? [found] : []; });
    const trip = linkedTrips.length ? { startDate: linkedTrips.map((item) => item.startDate).sort()[0], endDate: linkedTrips.map((item) => item.endDate).sort().at(-1)!, dates: [...new Set(linkedTrips.flatMap((item) => item.dates))] } : undefined;
    const selectedTag = wish.billTag !== undefined ? wish.billTag : trip ? tripTags[trip.startDate] : undefined;
    const tripMonths = new Set(trip?.dates.map((date) => `${date.slice(2, 4)}.${Number(date.slice(5, 7))}`));
    const name = wish.name.trim();
    const exactTag = allTags.find((tag) => tag === name && !SYSTEM_BILL_TAGS.has(tag));
    const tags = collapseTripTags(wish.billTags !== undefined ? wishBillTags(wish, tripTags) : wish.billTag === null ? [] : selectedTag ? [selectedTag] : exactTag ? [exactTag] : allTags.filter((tag) => {
      if (!name || SYSTEM_BILL_TAGS.has(tag)) return false;
      const tagMonth = tagYearMonthPrefix(tag);
      return wishTagName(tag) === wishTagName(name)
        && (!trip || !tagMonth || tripMonths.has(tagMonth));
    }));
    const items = [...new Set(tags.flatMap((tag) => {
      let summary = summaries.get(tag);
      if (!summary) {
        summary = sumBillsByTag(allItems, tag);
        summaries.set(tag, summary);
      }
      return summary.items;
    }))];
    const amount = normalizedAmount(Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100);
    // 尚无匹配账单不等同于零支出；有账单但全额退款则按零元结算。
    const ended = !!trip && linkedTrips.length === wishTripStarts(wish).length && trip.endDate < today && items.length > 0;
    const amounts = { consumption: 0, life: 0, unclassified: 0 };
    let unclassifiedCount = 0;
    const categories = new Map<string, number>();
    for (const item of items) {
      const kind = classifyWishBill(item);
      amounts[kind] += item.amount;
      if (kind === 'unclassified') unclassifiedCount += 1;
      // 只有消费账单才能覆盖机酒及额外消费的攒款预估。
      if (kind !== 'consumption') continue;
      const category = item.subcategory || item.category;
      const name = ['住宿', '酒店'].includes(category) ? '酒店'
        : ['机票', '高铁', '机票/高铁'].includes(category) ? '机票/高铁' : category;
      categories.set(name, (categories.get(name) ?? 0) + item.amount);
    }
    const latestBillDate = items.reduce((latest, item) => item.date > latest ? item.date : latest, '');
    return {
      ...wish,
      targetAmount: ended ? amount : wish.targetAmount,
      spentItems: [...categories].map(([name, amount]) => ({ id: `bill_${name}`, name, amount: roundToSitePrecision(normalizedAmount(amount)) })),
      billSpending: {
        tags, amount, count: items.length, ended, estimatedTargetAmount: wish.targetAmount,
        consumptionAmount: roundToSitePrecision(amounts.consumption),
        lifeAmount: roundToSitePrecision(amounts.life),
        unclassifiedAmount: roundToSitePrecision(amounts.unclassified),
        unclassifiedCount,
        month: trip?.startDate.slice(0, 7) || latestBillDate.slice(0, 7) || undefined,
      },
    };
  });
}

export function reconcileWishTripLinks<T extends WishItem>(
  wishes: readonly T[],
  trips: readonly TripSegment[],
  tripTags: Record<string, string> = {},
  travelTitles: Record<string, string> = {},
): T[] {
  return wishes.map((wish) => {
    const previousStart = wish.linkedTripStartDate;
    if (wish.linkedTripStartDates?.length || !previousStart || trips.some((trip) => trip.startDate === previousStart)) return wish;
    // Outlook 调整出发日或连续出游合并后，旧起点不再是行程的键。
    let trip = trips.find((candidate) => candidate.dates.includes(previousStart));
    if (!trip) {
      const names = new Set([wish.name, tripTags[previousStart] ?? ''].map(wishTagName).filter(Boolean));
      const matches = trips.filter((candidate) => [
        tripTags[candidate.startDate] ?? '',
        ...candidate.dates.map((date) => travelTitles[date] ?? ''),
      ].some((name) => names.has(wishTagName(name))));
      if (matches.length === 1) trip = matches[0];
    }
    if (!trip) return wish;
    const deadline = new Date(`${trip.startDate}T00:00:00Z`);
    deadline.setUTCDate(deadline.getUTCDate() - 1);
    return { ...wish, linkedTripStartDate: trip.startDate, deadline: wish.deadlineMode === 'manual' ? wish.deadline : deadline.toISOString().slice(0, 10) };
  });
}

/** 有名称的出游自动进入心愿；仅补关联，不覆盖已有心愿的预算、名称或启用状态。 */
export function reconcileTripWishes(
  wishes: WishItem[],
  trips: readonly TripSegment[],
  tripTags: Record<string, string> = {},
  travelTitles: Record<string, string> = {},
  dismissedStarts: Record<string, true> = {},
): WishItem[] {
  const beforeDeparture = (start: string) => {
    const day = new Date(`${start}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
  };
  const eligibleTrips = trips.filter((trip) => !dismissedStarts[trip.startDate]);
  const eligibleStarts = new Set(eligibleTrips.map((trip) => trip.startDate));
  const retainedWishes = repairReminderWishes(wishes).filter((wish) => {
    const synthetic = /^wish_trip_\d{4}-\d{2}-\d{2}(?:_\d+)?$/.test(wish.id);
    const untouched = wish.targetAmount === 0 && wish.savedAmount === 0 && wish.plannedTravelDays === 0
      && !wish.repaidAmount && !(wish.spentItems?.length) && wish.deadlineMode !== 'manual' && wish.billTag === undefined;
    return !(synthetic && untouched && wish.linkedTripStartDate && !eligibleStarts.has(wish.linkedTripStartDate));
  });
  let next = reconcileWishTripLinks(retainedWishes, eligibleTrips, tripTags, travelTitles).map((wish) => {
    if (!wish.linkedTripStartDate || wish.linkedTripStartDates?.length || wish.deadlineMode === 'manual') return wish;
    const deadline = beforeDeparture(wish.linkedTripStartDate);
    return wish.deadline === deadline ? wish : { ...wish, deadline };
  });
  // 旧版本可能先自动补建空白项，后又保留了用户填写的同名项。自动合并时始终保留用户数据。
  for (const trip of eligibleTrips) {
    const generated = next.find((wish) => !wish.mergedWishIds?.length && wish.linkedTripStartDate === trip.startDate
      && /^wish_trip_\d{4}-\d{2}-\d{2}(?:_\d+)?$/.test(wish.id)
      && wish.targetAmount === 0 && wish.savedAmount === 0 && !wish.repaidAmount && !(wish.spentItems?.length));
    if (!generated) continue;
    const generatedName = wishTripMatchName(generated.name);
    const manualCandidates = next.filter((wish) => !wish.mergedWishIds?.length && wish !== generated
      && (!wish.linkedTripStartDate || wish.linkedTripStartDate === trip.startDate)
      && !/^wish_trip_\d{4}-\d{2}-\d{2}(?:_\d+)?$/.test(wish.id)
      && wishTripMatchName(wish.name) === generatedName);
    if (manualCandidates.length !== 1) continue;
    const manual = manualCandidates[0];
    const linked = { ...manual, linkedTripStartDate: trip.startDate, deadline: manual.deadlineMode === 'manual' ? manual.deadline : beforeDeparture(trip.startDate) };
    next = next.map((wish) => wish === manual ? linked : wish).filter((wish) => wish !== generated);
  }
  for (const trip of [...trips].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    if (dismissedStarts[trip.startDate] || next.some((wish) => wishTripStarts(wish).includes(trip.startDate))) continue;
    const title = getTripDisplayTitle(tripTags[trip.startDate], trip.dates, travelTitles).trim();
    if (!title) continue;
    const names = new Set([title, getTripDisplayTitle(undefined, trip.dates, travelTitles)]
      .map(wishTripMatchName).filter(Boolean));
    const candidates = next.filter((wish) => !wish.linkedTripStartDate && names.has(wishTripMatchName(wish.name)));
    const deadline = beforeDeparture(trip.startDate);
    if (candidates.length === 1) {
      const existing = candidates[0];
      next[next.indexOf(existing)] = { ...existing, linkedTripStartDate: trip.startDate, deadline: existing.deadlineMode === 'manual' ? existing.deadline : deadline };
    } else {
      // 固定 ID 让多个设备同时补建同一行程时仍能按 ID 合并。
      const baseId = `wish_trip_${trip.startDate}`;
      let id = baseId;
      for (let suffix = 2; next.some((wish) => wish.id === id); suffix += 1) id = `${baseId}_${suffix}`;
      next.push({
        id, name: title.replace(/^\d{2}\.\d{1,2}(?:\.\d{1,2})?\s*/, '').trim() || title,
        targetAmount: 0, savedAmount: 0, plannedTravelDays: 0, isActive: true,
        linkedTripStartDate: trip.startDate, deadline,
      });
    }
  }
  return next.length === wishes.length && next.every((wish, index) => wish === wishes[index]) ? wishes : next;
}

/** 主动删除或解除关联后不重新补建；手动重新关联则解除该行程的忽略状态。 */
export function updateTripWishDismissals(
  previous: readonly WishItem[],
  next: readonly WishItem[],
  dismissedStarts: Record<string, true> = {},
): Record<string, true> {
  const dismissed = { ...dismissedStarts };
  const linkedStarts = new Set(next.flatMap(wishTripStarts));
  for (const wish of previous) {
    for (const start of wishTripStarts(wish)) if (!linkedStarts.has(start)) dismissed[start] = true;
  }
  for (const start of linkedStarts) if (start) delete dismissed[start];
  return dismissed;
}

export function sortWishesForDisplay<T extends WishItem>(wishes: readonly T[], trips: readonly TripSegment[], today: string): T[] {
  const ongoingTrips = new Map(trips
    .filter((trip) => trip.startDate <= today && trip.endDate >= today)
    .map((trip) => [trip.startDate, trip]));
  // A trip's funding deadline is before departure; it does not mark the end of the wish.
  return wishes.map((wish) => {
    const ongoingTrip = wishTripStarts(wish).flatMap((start) => ongoingTrips.get(start) ?? []).sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
    return { wish, ongoing: Boolean(ongoingTrip), date: ongoingTrip?.endDate
      ?? (wish.deadline && wish.deadline >= today ? wish.deadline : '9999-12-31') };
  }).sort((a, b) => Number(b.ongoing) - Number(a.ongoing)
    || a.date.localeCompare(b.date) || a.wish.id.localeCompare(b.wish.id))
    .map(({ wish }) => wish);
}

function expenseName(value: string) {
  return value.trim().replace(/\s*[/／]\s*/g, '/');
}

/** 保留原预估，按名称把同一项目的多笔已花合并覆盖；撤销明细后自然恢复预估。 */
export function resolveWishTravelBudget(wish: WishItem, days: number, dailyLifeAmount: number) {
  const actuals = new Map<string, number>();
  for (const item of wish.spentItems ?? []) {
    const name = expenseName(item.name);
    if (!name) continue;
    const key = ['机票', '高铁', '机票/高铁'].includes(name) ? '机票/高铁' : name;
    actuals.set(key, roundToSitePrecision((actuals.get(key) ?? 0) + normalizedAmount(item.amount)));
  }
  const lodgingDaily = Number.isFinite(wish.travelLodgingDailyAmount)
    ? normalizedAmount(wish.travelLodgingDailyAmount)
    : normalizedAmount(wish.travelLodgingAmount) / Math.max(days - 1, 1);
  const original = calculateTravelWishEstimate(days, dailyLifeAmount, wish.travelTicketAmount, lodgingDaily);
  const ticketActual = actuals.get('机票/高铁');
  const lodgingActual = actuals.get('酒店');
  // 重名额外预算在锁定时合并显示，防止同一笔实际支出被重复计入预估。
  const extras: Array<WishExtraExpenseItem & { actualAmount?: number; sourceIds: string[] }> = [];
  for (const item of resolveWishExtraExpenseItems(wish)) {
    const name = expenseName(item.name);
    const actualAmount = ['机票/高铁', '机票', '高铁', '酒店'].includes(name) ? undefined : actuals.get(name);
    const existing = actualAmount !== undefined ? extras.find((extra) => expenseName(extra.name) === name) : undefined;
    if (existing) {
      existing.amount += item.amount;
      existing.sourceIds.push(item.id);
    } else {
      extras.push({ ...item, actualAmount, sourceIds: [item.id] });
    }
  }
  const ticketAmount = ticketActual ?? original.ticketAmount;
  const lodgingAmount = lodgingActual ?? original.lodgingAmount;
  const extraExpenseAmount = extras.reduce((sum, item) => sum + (item.actualAmount ?? item.amount), 0);
  return {
    ticketActual,
    lodgingActual,
    original,
    extras,
    estimate: {
      ...original,
      ticketAmount,
      lodgingAmount,
      extraExpenseAmount,
      targetAmount: roundToSitePrecision(Math.max(ticketAmount + lodgingAmount + extraExpenseAmount + original.lifeAmount, 0)),
    },
  };
}

export type WishDeadlineState = 'none' | 'scheduled' | 'overdue' | 'completed';

export interface WishPlanItem extends WishItem {
  remainingAmount: number;
  monthsRemaining: number | null;
  monthlyWishAmount: number;
  deadlineState: WishDeadlineState;
}

export interface WishMonthForecast {
  yearMonth: string;
  taggedDays: number;
  availableDays: number;
  lifeExpense: number;
  repayment: number;
  wishAmount: number;
  requiredNetIncome: number;
}

export interface WishPlan {
  items: WishPlanItem[];
  months: WishMonthForecast[];
  averageMonthlyWishAmount: number;
  averageRequiredMonthlyNetIncome: number;
  activeDeadlineCount: number;
}

export interface WishPlanOptions {
  recurringIncomeBaseline?: number;
  raiseSavings?: import('../models/types').RaiseSavingsSettings;
  today?: Date;
  tagMap?: Record<string, TagKind>;
  stateDailyAvg?: Record<TagKind, number>;
  repaymentsByMonth?: Record<string, number>;
  tripDatesByStart?: Record<string, string[]>;
}

function parseLocalDate(value?: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return parsed;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function yearMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthIndex(value: string): number {
  const [year, month] = value.split('-').map(Number);
  return year * 12 + month - 1;
}

function monthFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthsBetweenInclusive(from: string, to: string): string[] {
  const start = monthIndex(from);
  const end = monthIndex(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  // 防止异常的远期日期一次生成过多行；50 年已覆盖实际可用规划区间。
  const count = Math.min(end - start + 1, 600);
  return Array.from({ length: count }, (_, offset) => monthFromIndex(start + offset));
}

/** 当前月和 DDL 所在月都参与分摊；逾期心愿全部计入当前月。 */
export function monthsUntilWishDeadline(deadline: string, today = new Date()): number | null {
  const target = parseLocalDate(deadline);
  if (!target) return null;
  const current = startOfDay(today);
  if (target < current) return 0;
  return monthIndex(yearMonth(target)) - monthIndex(yearMonth(current)) + 1;
}

function countAvailableDays(value: string, today: Date): number {
  const [year, month] = value.split('-').map(Number);
  const totalDays = new Date(year, month, 0).getDate();
  return value === yearMonth(today) ? Math.max(totalDays - today.getDate() + 1, 0) : totalDays;
}

function calculateCalendarLife(
  value: string,
  today: Date,
  tagMap: Record<string, TagKind>,
  stateDailyAvg: Record<TagKind, number>,
): { taggedDays: number; lifeExpense: number } {
  const todayKey = `${yearMonth(today)}-${String(today.getDate()).padStart(2, '0')}`;
  let taggedDays = 0;
  let lifeExpense = 0;
  for (const [date, tag] of Object.entries(tagMap)) {
    if (!date.startsWith(`${value}-`)) continue;
    if (value === yearMonth(today) && date < todayKey) continue;
    taggedDays += 1;
    const daily = stateDailyAvg[tag];
    if (Number.isFinite(daily)) lifeExpense += Math.max(daily, 0);
  }
  return { taggedDays, lifeExpense };
}

export function calculateWishPlan(wishes: WishItem[], options: WishPlanOptions = {}): WishPlan {
  const today = startOfDay(options.today ?? new Date());
  const currentYearMonth = yearMonth(today);
  const tagMap = options.tagMap ?? {};
  const stateDailyAvg = options.stateDailyAvg ?? { intern: 0, school: 0, home: 0, travel: 0 };
  const repaymentsByMonth = options.repaymentsByMonth ?? {};

  const items = wishes.map<WishPlanItem>((wish) => {
    const targetAmount = Number.isFinite(wish.targetAmount) ? Math.max(wish.targetAmount, 0) : 0;
    const savedAmount = Number.isFinite(wish.savedAmount) ? Math.max(wish.savedAmount, 0) : 0;
    const funding = calculateWishFunding(wish, wishTravelLifeAmount(wish, stateDailyAvg.travel, options.tripDatesByStart));
    const remainingAmount = funding.remainingAmount;
    const monthsRemaining = wish.deadline ? monthsUntilWishDeadline(wish.deadline, today) : null;
    const completed = remainingAmount <= 0 && (funding.fundingTarget > 0 || wish.billSpending?.ended === true);
    const overdue = monthsRemaining === 0 && !completed;
    const deadlineState: WishDeadlineState = completed
      ? 'completed'
      : overdue
        ? 'overdue'
        : monthsRemaining === null
          ? 'none'
          : 'scheduled';
    const monthlyWishAmount = wish.isActive && remainingAmount > 0 && monthsRemaining !== null
      ? remainingAmount / Math.max(monthsRemaining, 1)
      : 0;

    return {
      ...wish,
      targetAmount,
      savedAmount,
      remainingAmount,
      monthsRemaining,
      monthlyWishAmount,
      deadlineState,
    };
  });

  const activeDeadlineItems = items.filter(
    (item) => item.isActive && item.remainingAmount > 0 && item.monthsRemaining !== null,
  );
  const lastYearMonth = activeDeadlineItems.reduce((latest, item) => {
    const deadline = parseLocalDate(item.deadline);
    const itemYearMonth = deadline && deadline >= today ? yearMonth(deadline) : currentYearMonth;
    return itemYearMonth > latest ? itemYearMonth : latest;
  }, currentYearMonth);
  const forecastMonthKeys = activeDeadlineItems.length > 0
    ? monthsBetweenInclusive(currentYearMonth, lastYearMonth)
    : [];

  const months = forecastMonthKeys.map<WishMonthForecast>((value) => {
    const { taggedDays, lifeExpense } = calculateCalendarLife(value, today, tagMap, stateDailyAvg);
    const wishAmount = activeDeadlineItems.reduce((sum, item) => {
      const deadline = parseLocalDate(item.deadline);
      const lastContributionMonth = deadline && deadline >= today ? yearMonth(deadline) : currentYearMonth;
      return value <= lastContributionMonth ? sum + item.monthlyWishAmount : sum;
    }, 0);
    const repayment = Number.isFinite(repaymentsByMonth[value]) ? Math.max(repaymentsByMonth[value], 0) : 0;
    return {
      yearMonth: value,
      taggedDays,
      availableDays: countAvailableDays(value, today),
      lifeExpense,
      repayment,
      wishAmount,
      requiredNetIncome: wishRequiredIncome(lifeExpense + repayment + wishAmount / POST_LIFE_WISH_SHARE, options.recurringIncomeBaseline, options.raiseSavings),
    };
  });

  const averageMonthlyWishAmount = months.length > 0
    ? months.reduce((sum, month) => sum + month.wishAmount, 0) / months.length
    : 0;
  const averageRequiredMonthlyNetIncome = months.length > 0
    ? months.reduce((sum, month) => sum + month.requiredNetIncome, 0) / months.length
    : 0;

  return {
    items,
    months,
    averageMonthlyWishAmount,
    averageRequiredMonthlyNetIncome,
    activeDeadlineCount: activeDeadlineItems.length,
  };
}
