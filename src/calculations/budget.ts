import { dailyLivingAmount } from '../utils/cityLiving';
import { dateRange, internshipStart, resolveDailyContext, type InternshipContext } from '../utils/internship';
import type { ResolvedIncomeItem } from '../utils/payroll';
import type { AppConfig, CurrentStats, DailyTag, BudgetResult, TagKind } from '../models/types';

// payDay === 0 means last day of month
export function resolvePayDay(payDay: number, year: number, month: number): number {
  if (payDay === 0) return new Date(year, month + 1, 0).getDate();
  return payDay;
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function countFutureTagDays(tags: DailyTag[], tagKind: string, today: Date): number {
  const yearMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  return tags.filter((t) => {
    return t.tag === tagKind && t.date > `${yearMonth}-${String(today.getDate()).padStart(2, '0')}` && t.date.startsWith(yearMonth);
  }).length;
}

/** Fill forecast days without persisting them as historical calendar observations. */
export function budgetCalendarTags(tags: DailyTag[], today: Date, context?: InternshipContext): DailyTag[] {
  const start = context && internshipStart(context.config);
  if (!context || !start) return tags;
  const year = today.getFullYear(), month = today.getMonth();
  const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const end = new Date(year, month + 3, 0);
  const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${end.getDate()}`;
  const map = Object.fromEntries(tags.map(t => [t.date, t.tag]));
  for (const date of dateRange(from, to)) if (date >= start) map[date] = resolveDailyContext(date, map[date], context).tag;
  return Object.entries(map).map(([date, tag]) => ({ date, tag }));
}

/** 每月沿用上月结余；负值只结转一次，供明细与转账共用。 */
export function rollBudgetMonths(months: readonly { income: number; expense: number }[]) {
  let balance = 0;
  return months.map(month => {
    const carry = balance;
    const income = Math.round((month.income + Math.max(carry, 0)) * 100) / 100;
    const expense = Math.round((month.expense + Math.max(-carry, 0)) * 100) / 100;
    balance = Math.round((income - expense) * 100) / 100;
    return { income, expense, carry, balance };
  });
}

export interface AccountBalances {
  incomeBank: number;
  campusCard: number;
  livingBank: number;
  consumptionBank: number;
}

export function calcBudget(
  config: AppConfig,
  stats: CurrentStats,
  _transfersDone: Record<string, number>,
  tags: DailyTag[],
  today: Date,
  accounts?: Partial<AccountBalances>,
  internship?: InternshipContext,
  nextIncome?: ResolvedIncomeItem[],
): BudgetResult {
  tags = budgetCalendarTags(tags, today, internship);
  const year = today.getFullYear();
  const month = today.getMonth();
  const dayOfMonth = today.getDate();
  const totalDays = getDaysInMonth(year, month);
  const daysLeftInMonth = totalDays - dayOfMonth;

  // 从日历 tag 推算各状态剩余天数
  const stateDaysLeft: Record<TagKind, number> = {
    intern: countFutureTagDays(tags, 'intern', today),
    school: countFutureTagDays(tags, 'school', today),
    home:   countFutureTagDays(tags, 'home', today),
    travel: countFutureTagDays(tags, 'travel', today),
  };

  // 下月各状态天数
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear  = month === 11 ? year + 1 : year;
  const nextYM = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}`;
  const stateDaysNextMonth: Record<TagKind, number> = { intern: 0, school: 0, home: 0, travel: 0 };
  for (const t of tags) {
    if (t.date.startsWith(nextYM)) stateDaysNextMonth[t.tag]++;
  }

  const d  = stats.stateDailyAvg;

  const stateTotal = (daysMap: Record<TagKind, number>) =>
    (['school', 'intern', 'home', 'travel'] as TagKind[]).reduce(
      (s, k) => s + daysMap[k] * d[k], 0,
    );

  // === 月内预算（本月剩余各状态天数 × (生活+消费)日均）===
  const currentYM = `${year}-${String(month + 1).padStart(2, '0')}`;
  const futureTags = tags.filter(t => t.date.startsWith(currentYM) && Number(t.date.slice(8)) > dayOfMonth);
  const totalDates = (items: DailyTag[]) => items.reduce((sum, t) => sum + dailyLivingAmount(t.date, t.tag, stats, internship), 0);
  const monthlyExpense = internship ? totalDates(futureTags) : stateTotal(stateDaysLeft);

  // === 周内预算（月内按比例缩短到7天）===
  const weekDays = Math.min(daysLeftInMonth, 7);
  const weekEnd = dayOfMonth + weekDays;
  const weekFraction = weekDays / Math.max(daysLeftInMonth, 1);
  const weeklyExpense = internship ? totalDates(futureTags.filter(t => Number(t.date.slice(8)) <= weekEnd)) : monthlyExpense * weekFraction;
  const weeklyIncome = config.incomeItems
    .filter((i) => {
      if (!i.isActive) return false;
      const pd = resolvePayDay(i.payDay, year, month);
      return pd > dayOfMonth && pd <= weekEnd;
    })
    .reduce((s, i) => s + i.amount, 0);

  // === 月内收入 ===
  const monthlyIncome = config.incomeItems
    .filter((i) => {
      if (!i.isActive) return false;
      const pd = resolvePayDay(i.payDay, year, month);
      return pd > dayOfMonth;
    })
    .reduce((s, i) => s + i.amount, 0);

  // === 月外预算（下月各状态天数 × (生活+消费)日均）===
  const beyondIncome = nextIncome ? nextIncome.filter(i => i.isActive).reduce((sum, i) => sum + i.resolvedAmount, 0) : config.incomeItems.filter((i) => i.isActive).reduce((s, i) => s + i.amount, 0);
  const beyondExpense = internship ? totalDates(tags.filter(t => t.date.startsWith(nextYM))) : stateTotal(stateDaysNextMonth);

  // === 各账户本月预计需求 ===
  const campusNeed = Math.ceil(stats.schoolDailyAvg * stateDaysLeft.school);
  const livingNeed = Math.max(Math.ceil(monthlyExpense - campusNeed), 0);

  // 当前余额（若未提供则按 0 处理）
  const accIncome = accounts?.incomeBank ?? 0;
  const accCampus = accounts?.campusCard ?? 0;
  const accLiving = accounts?.livingBank ?? 0;

  // 各账户缺口（需要补充的金额）= 月需 − 当前余额
  const campusShortfall = Math.max(campusNeed - accCampus, 0);
  const livingShortfall = Math.max(livingNeed - accLiving, 0);
  const totalEssential  = campusShortfall + livingShortfall;

  // === 收入优先逻辑 ===
  const incomeAvailable = accIncome;

  // 盈余分配比例（来自 Excel 月初 sheet D15/C16/U12）
  const INVEST_RATIO = 0.5;   // C16: 50% → 理财
  const WISH_SHARE   = 0.8;   // U12: 消费中 80% → 心愿，20% → 消费银行卡

  let campusTransfer: number;
  let livingTransfer: number;
  let consumptionTransfer: number;
  let wishJarTransfer: number;
  let investTransfer: number;
  let needsRedemption: number;
  let incomeAfterEssentials: number;

  if (totalEssential <= 0) {
    campusTransfer = 0;
    livingTransfer = 0;
    incomeAfterEssentials = incomeAvailable;
    needsRedemption = 0;
  } else if (incomeAvailable >= totalEssential) {
    campusTransfer = campusShortfall;
    livingTransfer = livingShortfall;
    incomeAfterEssentials = incomeAvailable - totalEssential;
    needsRedemption = 0;
  } else {
    if (totalEssential > 0) {
      campusTransfer = Math.floor(campusShortfall * incomeAvailable / totalEssential);
      livingTransfer = Math.floor(livingShortfall * incomeAvailable / totalEssential);
    } else {
      campusTransfer = 0;
      livingTransfer = 0;
    }
    incomeAfterEssentials = 0;
    needsRedemption = totalEssential - incomeAvailable;
  }

  // 盈余按比例分配
  if (incomeAfterEssentials > 0) {
    investTransfer = Math.round(incomeAfterEssentials * INVEST_RATIO);
    const consumeTotal = incomeAfterEssentials - investTransfer;
    wishJarTransfer = Math.round(consumeTotal * WISH_SHARE);
    consumptionTransfer = consumeTotal - wishJarTransfer;
  } else {
    investTransfer = 0;
    wishJarTransfer = 0;
    consumptionTransfer = 0;
  }

  return {
    daysLeftInMonth,
    stateDaysLeft,
    stateDaysNextMonth,
    weekly:  { income: Math.round(weeklyIncome * 100) / 100,  expense: Math.round(weeklyExpense * 100) / 100 },
    monthly: { income: Math.round(monthlyIncome * 100) / 100, expense: Math.round(monthlyExpense * 100) / 100 },
    beyond:  { income: Math.round(beyondIncome * 100) / 100,  expense: Math.round(beyondExpense * 100) / 100 },
    recommended: {
      campusCard:   campusTransfer,
      living:       livingTransfer,
      consumption:  consumptionTransfer,
      wishJar:      wishJarTransfer,
      invest:       investTransfer,
      needsRedemption: Math.round(needsRedemption),
      incomeAfterEssentials: Math.round(incomeAfterEssentials),
    },
    needs: {
      campusCard: campusNeed,
      living:     livingNeed,
    },
  };
}
