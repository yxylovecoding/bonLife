import { describe, expect, it } from 'vitest';
import { budgetCalendarTags, rollBudgetMonths } from './budget';
import { resolveAllIncomeForMonth } from '../utils/payroll';
import { dailyLivingAmount } from '../utils/cityLiving';
import type { DailyTag } from '../models/types';

describe('三个月预算', () => {
  it('本月剩余结余依次进入次月、后月，保留分位且不修改原始收支', () => {
    const months = [
      { income: 7100, expense: 2851 },
      { income: 9483.81, expense: 12862.69 },
      { income: 1000, expense: 2000 },
    ];
    const before = structuredClone(months);
    expect(rollBudgetMonths(months)).toEqual([
      { income: 7100, expense: 2851, carry: 0, balance: 4249 },
      { income: 13732.81, expense: 12862.69, carry: 4249, balance: 870.12 },
      { income: 1870.12, expense: 2000, carry: 870.12, balance: -129.88 },
    ]);
    expect(months).toEqual(before);
  });

  it('赤字作为下月支出结转，后月恢复收入可以补回缺口', () => {
    expect(rollBudgetMonths([
      { income: 0, expense: 100 },
      { income: 200, expense: 300 },
      { income: 500, expense: 100 },
    ])).toEqual([
      { income: 0, expense: 100, carry: 0, balance: -100 },
      { income: 200, expense: 400, carry: -100, balance: -200 },
      { income: 500, expense: 300, carry: -200, balance: 200 },
    ]);
  });

  it.each([
    [2026, 10, '2027-01', 31],
    [2026, 11, '2027-02', 28],
    [2027, 11, '2028-02', 29],
  ])('从 %s 年 %s 月偏移预测后月 %s 的完整收支', (year, month, following, days) => {
    const context = { config: { internshipEnabledFrom: '2026-01-01' } };
    const saved: DailyTag[] = [{ date: `${following}-02`, tag: 'travel' }];
    const tags = budgetCalendarTags(saved, new Date(year, month, 30), context);
    const followingTags = tags.filter(tag => tag.date.startsWith(following));
    expect(followingTags).toHaveLength(days);
    expect(followingTags.find(tag => tag.date.endsWith('-02'))?.tag).toBe('travel');
    const stats = { stateDailyAvg: { school: 10, intern: 20, home: 30, travel: 100 } };
    expect(followingTags.reduce((sum, tag) => sum + dailyLivingAmount(tag.date, tag.tag, stats, context), 0))
      .toBe((days - 1) * 10 + 100);
    const income = resolveAllIncomeForMonth([
      { id: 'salary', name: '固定收入', amount: 1000, payDay: 0, isActive: true },
    ], Number(following.slice(0, 4)), Number(following.slice(5)) - 1, {}, {}, context);
    expect(income[0]).toMatchObject({ resolvedPayDate: `${following}-${days}`, resolvedAmount: 1000 });
    expect(saved).toEqual([{ date: `${following}-02`, tag: 'travel' }]);
  });
});
