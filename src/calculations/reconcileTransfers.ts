import type { AccountSnapshot, RaiseSavingsSettings } from '../models/types';
import type { BillIncomeMonth } from '../utils/importBill';

export const DEFAULT_RECURRING_INCOME_BASELINE = 4060;
export const TRANSFER_KEYS = ['raiseSavings', 'campusCard', 'repayment', 'living', 'consumption', 'wishJar', 'invest'] as const;
export type TransferKey = typeof TRANSFER_KEYS[number];

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export function resolveRecurringIncomeBaseline(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? roundMoney(value)
    : DEFAULT_RECURRING_INCOME_BASELINE;
}

export function resolveRaiseSavingsSettings(settings?: RaiseSavingsSettings): Required<RaiseSavingsSettings> {
  return {
    enabled: settings?.enabled !== false,
    includeVolatileIncome: settings?.includeVolatileIncome !== false,
    mode: settings?.mode === 'manual' ? 'manual' : 'automatic',
    manualRaiseAmount: Number.isFinite(settings?.manualRaiseAmount)
      ? Math.max(0, roundMoney(settings!.manualRaiseAmount!)) : 0,
  };
}

export function calculateMonthlyRaiseSavings(recurringIncome: number, volatileIncome: number, baseline?: number, settings?: RaiseSavingsSettings): number {
  const resolved = resolveRaiseSavingsSettings(settings);
  if (!resolved.enabled) return 0;
  const raiseCents = resolved.mode === 'manual'
    ? Math.round(resolved.manualRaiseAmount * 100)
    : Math.round(recurringIncome * 100) - Math.round(resolveRecurringIncomeBaseline(baseline) * 100);
  const excessCents = raiseCents + (resolved.includeVolatileIncome ? Math.round(volatileIncome * 100) : 0);
  return Math.max(Math.round(excessCents / 2), 0) / 100;
}

export function calculateRaiseSavings({ incomeItems, today, baseline, settings, saved = 0 }: {
  incomeItems: BillIncomeMonth;
  today: string;
  baseline?: number;
  settings?: RaiseSavingsSettings;
  saved?: number;
}) {
  let recurringIncome = 0;
  let volatileIncome = 0;
  for (const item of incomeItems) {
    if (item.date.slice(0, 7) !== today.slice(0, 7) || item.date > today || !Number.isFinite(item.amount)) continue;
    const tags = new Set(item.tags.split(',').map((tag) => tag.trim()).filter(Boolean));
    if ((item.category.trim() === '出物' || item.subcategory.trim() === '出物') && tags.has('消费')) continue;
    if (tags.has('波动收入')) volatileIncome += item.amount;
    else if (tags.has('周期收入')) recurringIncome += item.amount;
  }
  recurringIncome = roundMoney(recurringIncome);
  volatileIncome = roundMoney(volatileIncome);
  const effectiveBaseline = resolveRecurringIncomeBaseline(baseline);
  const target = calculateMonthlyRaiseSavings(recurringIncome, volatileIncome, effectiveBaseline, settings);
  const alreadySaved = Number.isFinite(saved) ? Math.max(0, roundMoney(saved)) : 0;
  return {
    recurringIncome,
    volatileIncome,
    baseline: effectiveBaseline,
    target,
    saved: alreadySaved,
    remaining: roundMoney(Math.max(target - alreadySaved, 0)),
  };
}

export function calculateTransferAllocation(incomeBalance: number, essentialNeed: number, raiseSavingsRemaining: number) {
  const afterRaiseSavings = roundMoney(incomeBalance - raiseSavingsRemaining);
  const needsRedemption = roundMoney(Math.max(essentialNeed - afterRaiseSavings, 0));
  const afterEssentials = roundMoney(Math.max(afterRaiseSavings - essentialNeed, 0));
  // 保留原有整数舍入与 50% / 80% 分配规则。
  const invest = Math.min(Math.round(afterEssentials * 0.5), afterEssentials);
  const consumeTotal = roundMoney(afterEssentials - invest);
  const wishJar = Math.min(Math.round(consumeTotal * 0.8), consumeTotal);
  return { needsRedemption, afterEssentials, invest, wishJar, consumption: roundMoney(consumeTotal - wishJar) };
}

export function calculateLivingTransfer({ monthlyShortfall, monthlyBalances, incomeBalance, raiseSavingsRemaining, repaymentShortfall }: {
  monthlyShortfall: number;
  monthlyBalances: readonly number[];
  incomeBalance: number;
  raiseSavingsRemaining: number;
  repaymentShortfall: number;
}) {
  // 结余已逐月结转，同一赤字不能重复相加；取三个月内最大的累计缺口。
  const deficitReserve = roundMoney(Math.max(0, ...monthlyBalances.map(balance => -balance)));
  const need = roundMoney(Math.max(monthlyShortfall, 0) + deficitReserve);
  const available = roundMoney(Math.max(incomeBalance - raiseSavingsRemaining - repaymentShortfall, 0));
  const transfer = Math.min(need, available);
  return { deficitReserve, need, available, transfer };
}

const TRANSFER_ACCOUNT_KEYS: Partial<Record<TransferKey, keyof AccountSnapshot['accounts']>> = {
  raiseSavings: 'investCnyBank',
  campusCard: 'campusCard',
  repayment: 'savingsCard',
  living: 'livingBank',
  consumption: 'consumptionBank',
  invest: 'investCnyBank',
};

export function calculateTransferChanges(
  snapshot: AccountSnapshot,
  transfers: Partial<Record<TransferKey, number>>,
  yearMonth: string,
) {
  const accounts: Partial<AccountSnapshot['accounts']> = {};
  let totalOut = 0;
  let raiseSavingsByMonth = snapshot.raiseSavingsByMonth;
  for (const key of TRANSFER_KEYS) {
    const rawAmount = transfers[key] ?? 0;
    if (!Number.isFinite(rawAmount)) continue;
    const amount = roundMoney(key === 'raiseSavings' ? Math.max(rawAmount, 0) : rawAmount);
    if (amount === 0) continue;
    if (key === 'campusCard') {
      accounts.campusCard = roundMoney((accounts.campusCard ?? snapshot.accounts.campusCard ?? 0) + amount);
      accounts.credit = roundMoney((accounts.credit ?? snapshot.accounts.credit ?? 0) + amount);
      continue;
    }
    totalOut = roundMoney(totalOut + amount);
    if (key === 'raiseSavings') {
      raiseSavingsByMonth = {
        ...raiseSavingsByMonth,
        [yearMonth]: roundMoney((raiseSavingsByMonth?.[yearMonth] ?? 0) + amount),
      };
    }
    const accountKey = TRANSFER_ACCOUNT_KEYS[key];
    if (accountKey) accounts[accountKey] = roundMoney((accounts[accountKey] ?? snapshot.accounts[accountKey] ?? 0) + amount);
  }
  if (totalOut > 0) accounts.incomeBank = roundMoney((snapshot.accounts.incomeBank ?? 0) - totalOut);
  return { accounts, raiseSavingsByMonth };
}
