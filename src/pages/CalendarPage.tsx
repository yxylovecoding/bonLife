import { calendarVisualTag, monthCityLabels } from '../utils/calendarPresentation';
import { useCalendarWeather } from '../hooks/useCalendarWeather';
import { dailyWeatherLabel, weatherSymbol } from '../utils/weather';
import { cityLabel } from '../utils/sceneCities';
import { APP_LINKS } from '../utils/apps';
import InternshipDayEditor from '../components/InternshipDayEditor';
import { resolveDailyContext } from '../utils/internship';
import { useLifeCalendar } from '../hooks/useLifeCalendar';
﻿import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSyncStatus } from '../utils/syncStatus';
import Card from '../components/Card';
import StatRow from '../components/StatRow';
import CurrencyDisplay, { formatCurrency } from '../components/CurrencyDisplay';
import { tagMeta, investMeta } from '../data/mockData';
import { aggregateExpenseItems, assignExpenseIds, type BillItem, type BillExpenseMonth, type BillExpenseItem } from '../utils/importBill';
import { fieldsNeedingRestore, recordFromBillAggregate } from '../utils/billImportActions';
import { inferInvestmentProfitFromBaseline } from '../utils/investTransactionProfit';
import { useBillDetailStore } from '../stores/billDetailStore';
import { useExpenseScopeOverrideStore, resolveExpenseScope, subcategoryKey, type ExpenseScope, type OverrideValue, type OverrideDimension } from '../stores/expenseScopeOverrideStore';
import { useTripStore } from '../stores/tripStore';
import { detectAllTrips, detectTrips, detectTripGroups, extractCandidateTags, getActiveTripTagsExcept, sumBillsByTag, flattenExpenseItems, tagYearMonthPrefix } from '../utils/trips';
import type { TripGroup } from '../utils/trips';
import { getTripDisplayTitle } from '../utils/outlookCalendar';
import AmountInput from '../components/AmountInput';
import InvestInstrumentPicker from '../components/InvestInstrumentPicker';
import PendingInvestmentBuyRow from '../components/PendingInvestmentBuyRow';
import HoldingsViewToggle from '../components/HoldingsViewToggle';
import AlipayHoldingsSection from '../components/AlipayHoldingsSection';
import InvestPositionMoveMenu from '../components/InvestPositionMoveMenu';
import TickTickTripSyncControl from '../components/TickTickTripSyncControl';
import OutlookCalendarSyncControl from '../components/OutlookCalendarSyncControl';
import { useOutlookCalendarSync } from '../hooks/useOutlookCalendarSync';
import { calcHistoryStats } from '../calculations/history';
import { buildExpenseScopeStats, suggestScope, isInconsistent, type ExpenseScopeStatRow } from '../calculations/expenseScopeStats';
import {
  normalizeConfirmedSelection,
  useCalendarStore,
  type ConfirmedExpenseAssignment,
  type ConfirmedExpenseSelection,
} from '../stores/calendarStore';
import { useConfigStore } from '../stores/configStore';
import { useMonthlyStore, type InvestmentMutationSource } from '../stores/monthlyStore';
import { usePossessionStore } from '../stores/possessionStore';
import { classifyTag, isMajorExcludedTag, type ManualTagCategory } from '../utils/tagCategory';
import { usePrefsStore, REVIEWABLE_CATEGORIES, type ReviewableCategory } from '../stores/prefsStore';
import { useDragSort } from '../hooks/useDragSort';
import type {
  TagKind,
  MonthlyRecord,
  MajorExpense,
  InvestHoldings,
  InvestKey,
  InvestQuoteSource,
  InvestmentProfitBaseline,
  InvestPositionGroupKey,
  InvestPositionItems,
  InvestPositionStatus,
} from '../models/types';
import { useHolidayYears } from '../utils/holidays';
import { sanitizeDecimalNumberInput } from '../utils/numberInput';
import { tryEvalFormula } from '../utils/formula';
import { payrollCutoffMarkerDates } from '../utils/payroll';
import {
  applyInvestAutoSumStartMonth,
  getAverageAnnualizedRate,
  getGroupAverageAnnualizedRate,
  getCategoryProfit,
  getInvestTotalForRate,
  getManualAccumulatedProfit,
  getYearInvestmentReturn,
  isInvestAccumulatedProfitAuto,
} from '../utils/investRecords';
import {
  INVEST_POSITION_GROUP_KEYS,
  INVEST_POSITION_KEYS,
  calculateInvestPositionMonthlyProfit,
  inferInvestPositionFxRateToCny,
  isInvestPositionSummaryItem,
  investPositionQuoteKey,
  migrateLegacyInvestPositionItems,
  summarizeInvestPositionItems,
  type InvestMarketSnapshot,
} from '../utils/investPositionItems';
import {
  canSplitInvestPositionAccount,
  defaultInvestQuoteCurrency,
  investPositionDraftGroupsFromItems,
  investPositionItemsFromDraftGroups,
  moveInvestPositionDraft,
  splitInvestPositionDraft,
  type InvestPositionDraft,
  type InvestPositionDraftGroups,
  type PositionSplitInput,
} from '../utils/investPositionDrafts';
import { getMonthlyAssetChange, getMonthlySavedAmount, getMonthlySavingsRate } from '../utils/monthlyMetrics';
import { createManualBackup, triggerUpload } from '../utils/syncEngine';
import { isFinanceScreenshotFile } from '../utils/financeScreenshotOcr';
import TagLogicStats, { CategoryRow, ExpenseItemLine, extractMeaningful } from '../components/TagLogicStats';
import { useBillStatisticItems } from '../hooks/useBillStatisticItems';
import { importFinanceFile } from '../utils/financeImport';

const C = { blue: '#1a73e8', red: '#ea4335', green: '#0d9488', purple: '#7c3aed', sub: '#5f6368', border: '#e0e0e0', weekend: '#ea4335', orange: '#e8710a' };
const HOLIDAY_COLORS = {
  off: { color: '#dc2626', background: '#fee2e2', cellBackground: '#fff0f0' },
  work: { color: '#15803d', background: '#dcfce7', cellBackground: '#f0fdf4' },
} as const;
const CN_MONTH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const WEEK_HEADERS = ['一', '二', '三', '四', '五', '六', '日'];
const HISTORY_GRID_COLUMNS = '64px repeat(4, minmax(0, 1fr)) 88px';
const INVESTMENT_GROUPS = [
  { label: '股', title: '股（美、欧、亚、A）', keys: ['us', 'eu', 'asia', 'a'] },
  { label: '债', title: '债（长债、美债）', keys: ['longBond', 'usBond'] },
  { label: '商', title: '商（黄金）', keys: ['gold'] },
] as const;
const STOCK_MARKETS = [
  { label: '美', key: 'us' },
  { label: '欧', key: 'eu' },
  { label: '亚', key: 'asia' },
  { label: 'A', key: 'a' },
] as const;

type UsdRateResponse = {
  rate: number;
  date?: string;
  source?: string;
};

// ── Calendar helpers ──────────────────────────────────────────────
function pad(n: number) { return String(n).padStart(2, '0'); }
function getDaysInMonth(year: number, month: number) { return new Date(year, month + 1, 0).getDate(); }
function getDayOfWeek(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function isWeekend(key: string) { const dow = getDayOfWeek(key); return dow === 0 || dow === 6; }
function getRange(a: string, b: string): string[] {
  const [s, e] = a <= b ? [a, b] : [b, a];
  const result: string[] = [];
  const cur = new Date(s + 'T00:00:00');
  const end = new Date(e + 'T00:00:00');
  while (cur <= end) {
    result.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

function formatSignedCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}¥${formatCurrency(Math.abs(value))}`;
}

function formatCompactAmount(value: number) {
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 10000) {
    const valueInWan = Math.round(absoluteValue / 1000) / 10;
    return `${valueInWan.toFixed(1)}w`;
  }
  if (absoluteValue >= 1000) return `${Math.round(absoluteValue / 1000)}k`;
  return formatCurrency(absoluteValue);
}

function formatSignedCompactCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}¥${formatCompactAmount(value)}`;
}

function formatCurrencyValue(value: number) {
  return `${value < 0 ? '-' : ''}¥${formatCurrency(value)}`;
}

function currencyMark(currency: string) {
  const normalized = currency.toUpperCase();
  if (normalized === 'USD') return '$';
  if (normalized === 'CNY' || normalized === 'CNH') return '¥';
  return `${normalized} `;
}

function formatNativeCurrency(value: number, currency: string, signed = false) {
  const sign = value < 0 ? '-' : signed ? '+' : '';
  return `${sign}${currencyMark(currency)}${formatCurrency(value)}`;
}

function cloneInvestPositionItems(items: InvestPositionItems): InvestPositionItems {
  return Object.fromEntries(
    Object.entries(items).map(([key, group]) => [key, group?.map((item) => ({
      ...item,
      pendingBuys: item.pendingBuys?.map((pending) => ({ ...pending })),
    }))]),
  ) as InvestPositionItems;
}

function getAssetChangeTitle(currentTotalAssets?: number, previousTotalAssets?: number) {
  const formula = '资产增加 = 本月总资产 − 上月总资产';
  if (currentTotalAssets === undefined) return `${formula}；本月总资产未记录`;
  if (previousTotalAssets === undefined) return `${formula}；上月总资产未记录`;
  return `${formula} = ${formatCurrencyValue(currentTotalAssets)} − ${formatCurrencyValue(previousTotalAssets)} = ${formatSignedCurrency(currentTotalAssets - previousTotalAssets)}`;
}

function getSavedAmountTitle(
  record: Pick<MonthlyRecord, 'income' | 'investTotal' | 'accumulatedProfit'>,
  previous?: Pick<MonthlyRecord, 'investTotal' | 'accumulatedProfit'>,
) {
  const formula = '存下 = (本月理财总额 − 上月理财总额) − (本月累计盈利 − 上月累计盈利)';
  if (!previous) return `${formula}\n上月数据未记录`;
  const investmentAssetChange = record.investTotal - previous.investTotal;
  const investmentIncome = record.accumulatedProfit - previous.accumulatedProfit;
  const savedAmount = investmentAssetChange - investmentIncome;
  const savedCalculation = `${formula}\n= (${formatCurrencyValue(record.investTotal)} − ${formatCurrencyValue(previous.investTotal)}) − (${formatCurrencyValue(record.accumulatedProfit)} − ${formatCurrencyValue(previous.accumulatedProfit)})\n= (${formatSignedCurrency(investmentAssetChange)}) − (${formatSignedCurrency(investmentIncome)}) = ${formatSignedCurrency(savedAmount)}`;
  if (record.income <= 0) return `${savedCalculation}\n储蓄率 = 存下 ÷ 本月收入；本月收入需大于 0`;
  return `${savedCalculation}\n储蓄率 = 存下 ÷ 本月收入 = ${formatSignedCurrency(savedAmount)} ÷ ${formatCurrencyValue(record.income)} = ${((savedAmount / record.income) * 100).toFixed(1)}%`;
}

// ── History helpers ───────────────────────────────────────────────
const YEARLY_ONLY_BEFORE = '2023-01';
const INVEST_KEYS = ['us', 'eu', 'asia', 'a', 'longBond', 'usBond', 'gold'] as const;
const INVEST_POSITION_LABELS = Object.fromEntries(
  INVEST_POSITION_KEYS.map((key) => [key, investMeta[key].label]),
) as Record<InvestKey, string>;
const INVEST_POSITION_STATUS_META: Record<InvestPositionStatus, { label: string; color: string }> = {
  active: { label: 'now', color: C.blue },
  paused: { label: 'past', color: C.orange },
  closed: { label: 'past', color: C.orange },
};
const INVEST_POSITION_TAB_STATUSES: InvestPositionStatus[] = ['active', 'paused'];

type InvestmentQuoteResponse = {
  symbol?: string;
  currency?: string;
  regularMarketPrice?: number | null;
  regularMarketTime?: string | null;
  bars?: Array<{ date: string; close?: number | null; adjClose?: number | null }>;
};
type InvestQuoteTarget = { key: string; symbol: string; source: InvestQuoteSource; currency?: string; fallbackPrice?: number };
function numberOrUndefined(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const roundCny = (value: number) => Math.round(value * 100) / 100;

function makeInvestPositionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `invest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function latestQuotePrice(quote: InvestmentQuoteResponse | undefined) {
  const regularMarketPrice = Number(quote?.regularMarketPrice);
  if (Number.isFinite(regularMarketPrice) && regularMarketPrice > 0) return regularMarketPrice;
  const bars = quote?.bars ?? [];
  for (let index = bars.length - 1; index >= 0; index--) {
    const price = Number(bars[index].adjClose ?? bars[index].close);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

function useInvestPositionMarkets(items: InvestPositionItems, enabled: boolean, fallbackUsdRate: number | null) {
  const quoteTargets = useMemo(() => {
    const targets = new Map<string, InvestQuoteTarget>();
    for (const categoryKey of INVEST_POSITION_KEYS) {
      for (const item of items[categoryKey] ?? []) {
        const symbol = item.symbol.trim().toUpperCase();
        if (!symbol) continue;
        // 裸六位代码可能是 A 股或公募基金，先要求用户从候选项确认数据源。
        if (!item.quoteSource && /^\d{6}$/.test(symbol)) continue;
        const source = item.quoteSource ?? 'yahoo';
        const key = investPositionQuoteKey({ symbol, quoteSource: source });
        targets.set(key, {
          key,
          symbol,
          source,
          currency: item.quoteCurrency || defaultInvestQuoteCurrency(categoryKey),
          fallbackPrice: item.lastPrice,
        });
      }
    }
    return [...targets.values()];
  }, [items]);
  const quoteTargetSignature = quoteTargets.map((target) => `${target.key}:${target.currency ?? ''}:${target.fallbackPrice ?? ''}`).join('|');
  const [quotes, setQuotes] = useState<Record<string, InvestmentQuoteResponse>>({});
  const [quoteErrors, setQuoteErrors] = useState<Set<string>>(() => new Set());
  const [usdRate, setUsdRate] = useState<number | null>(fallbackUsdRate);
  const [otherFxRates, setOtherFxRates] = useState<Record<string, number>>({});
  const resolvedCurrencySignature = quoteTargets.map((target) => (
    quotes[target.key]?.currency || target.currency || ''
  ).toUpperCase()).join('|');

  useEffect(() => {
    if (!enabled || quoteTargets.length === 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const results = await Promise.allSettled(quoteTargets.map(async (target) => {
        const currencyParam = target.currency ? `&currency=${encodeURIComponent(target.currency)}` : '';
        const response = await fetch(`/api/market-chart?symbol=${encodeURIComponent(target.symbol)}&source=${encodeURIComponent(target.source)}${currencyParam}&range=5d&interval=1d`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return [target.key, await response.json() as InvestmentQuoteResponse] as const;
      }));
      if (controller.signal.aborted) return;
      const errors = new Set<string>();
      setQuotes((previous) => {
        const next = { ...previous };
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
          else errors.add(quoteTargets[index].key);
        });
        return next;
      });
      setQuoteErrors(errors);
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, quoteTargetSignature]);

  useEffect(() => {
    if (!enabled || !quoteTargets.some((target) => (quotes[target.key]?.currency || target.currency || '').toUpperCase() === 'USD')) return;
    const controller = new AbortController();
    fetch('/api/usd-rate', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as UsdRateResponse;
        if (Number.isFinite(payload.rate) && payload.rate > 0) setUsdRate(payload.rate);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      });
    return () => controller.abort();
  }, [enabled, resolvedCurrencySignature]);

  const otherCurrencies = useMemo(() => [...new Set(quoteTargets.map((target) => (quotes[target.key]?.currency || target.currency || '').toUpperCase())
    .filter((currency) => currency && !['CNY', 'CNH', 'USD'].includes(currency)))], [quotes, quoteTargetSignature]);
  useEffect(() => {
    if (!enabled || otherCurrencies.length === 0) return;
    const controller = new AbortController();
    Promise.allSettled(otherCurrencies.map(async (currency) => {
      const pair = `${currency}CNY=X`;
      const response = await fetch(`/api/market-chart?symbol=${encodeURIComponent(pair)}&source=yahoo&range=5d&interval=1d`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const quote = await response.json() as InvestmentQuoteResponse;
      const rate = latestQuotePrice(quote);
      if (rate === null) throw new Error('missing fx rate');
      return [currency, rate] as const;
    })).then((results) => {
      if (controller.signal.aborted) return;
      setOtherFxRates((previous) => {
        const next = { ...previous };
        for (const result of results) if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
        return next;
      });
    });
    return () => controller.abort();
  }, [enabled, otherCurrencies.join('|')]);

  const marketsBySymbol = useMemo<Record<string, InvestMarketSnapshot | undefined>>(() => Object.fromEntries(quoteTargets.map((target) => {
    const quote = quotes[target.key];
    const livePrice = latestQuotePrice(quote);
    const fallbackPrice = Number(target.fallbackPrice);
    const price = livePrice ?? (Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null);
    const currency = (quote?.currency || target.currency || '').toUpperCase();
    const fxRateToCny = ['CNY', 'CNH'].includes(currency)
      ? 1
      : currency === 'USD'
        ? usdRate
        : otherFxRates[currency] ?? null;
    if (price === null || fxRateToCny === null || !Number.isFinite(fxRateToCny) || fxRateToCny <= 0) return [target.key, undefined];
    return [target.key, {
      price,
      currency,
      fxRateToCny,
      live: livePrice !== null,
      quoteAt: quote?.regularMarketTime ?? (quote?.bars?.length ? quote.bars[quote.bars.length - 1].date : undefined),
    } satisfies InvestMarketSnapshot];
  })), [otherFxRates, quotes, quoteTargetSignature, usdRate]);

  return { quotes, quoteErrors, marketsBySymbol };
}
const _NOW = new Date();

function prevYearMonth(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function getRecordInvestMonthlyProfit(record: MonthlyRecord, previous?: MonthlyRecord) {
  if (!previous) return null;
  return record.accumulatedProfit - (previous.accumulatedProfit ?? 0);
}

// ── 本地/共享分类规则弹窗 ────────────────────────────────────────
function ScopeChip({
  current,
  suggestion,
  onChange,
  allowIgnore,
}: {
  current: OverrideValue | undefined;
  suggestion: ExpenseScope | null;
  onChange: (next: OverrideValue | null) => void;
  allowIgnore?: boolean;
}) {
  const opts: { v: OverrideValue | null; label: string; bg: string; fg: string }[] = [
    { v: null,     label: '默认', bg: '#f1f3f4', fg: '#5f6368' },
    { v: 'local',  label: '本地', bg: '#e8f0fe', fg: '#1a73e8' },
    { v: 'shared',   label: '共享', bg: '#fff4e8', fg: '#e8710a' },
  ];
  if (allowIgnore) {
    opts.push({ v: 'ignore', label: '忽略', bg: '#f3e8ff', fg: '#7c3aed' });
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {opts.map((o) => {
        const active = (o.v === null && current === undefined) || current === o.v;
        const isSuggested = current === undefined && (o.v === 'local' || o.v === 'shared') && suggestion === o.v;
        return (
          <button
            key={String(o.v)}
            onClick={() => onChange(o.v)}
            style={{
              padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              border: active ? `1.5px solid ${o.fg}` : (isSuggested ? `1px dashed ${o.fg}` : '1px solid #dadce0'),
              backgroundColor: active ? o.bg : '#fff',
              color: active ? o.fg : (isSuggested ? o.fg : '#5f6368'),
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ScopeRow({
  row,
  current,
  suggestion,
  inconsistent,
  onChange,
  displayName,
  allowIgnore,
  expanded,
  onToggleExpand,
  expandedItems,
}: {
  row: ExpenseScopeStatRow;
  current: OverrideValue | undefined;
  suggestion: ExpenseScope | null;
  inconsistent: boolean;
  onChange: (next: OverrideValue | null) => void;
  displayName: string;
  allowIgnore?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  expandedItems?: BillExpenseItem[];
}) {
  return (
    <div style={{
      borderRadius: 8, marginBottom: 4,
      border: inconsistent && current === undefined ? '1px solid #f59e0b' : '1px solid transparent',
      backgroundColor: inconsistent && current === undefined ? '#fffbeb' : '#fafbfc',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '6px 8px',
      }}>
        <button
          type="button"
          onClick={onToggleExpand}
          style={{ minWidth: 0, flex: 1, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: onToggleExpand ? 'pointer' : 'default' }}
        >
          <div style={{ fontSize: 12, fontWeight: 500, color: '#202124', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: '#9aa0a6', marginRight: 4, fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
            {inconsistent && current === undefined && <span title="历史勾选不一致" style={{ color: '#f59e0b', marginRight: 4 }}>⚠️</span>}
            {displayName}
          </div>
          <div style={{ fontSize: 10, color: '#5f6368', marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>
            {row.localCount > 0 && <span style={{ color: '#1a73e8', marginRight: 8 }}>本地×{row.localCount}</span>}
            {row.sharedCount > 0 && <span style={{ color: '#e8710a' }}>共享×{row.sharedCount}</span>}
          </div>
        </button>
        <ScopeChip current={current} suggestion={suggestion} onChange={onChange} allowIgnore={allowIgnore} />
      </div>
      {expanded && expandedItems && (
        <div style={{ padding: '4px 8px 8px', borderTop: '1px dashed #e8eaed', maxHeight: 200, overflowY: 'auto' }}>
          {expandedItems.length === 0 ? (
            <div style={{ fontSize: 11, color: '#9aa0a6', padding: '6px 0', textAlign: 'center' }}>无匹配账单</div>
          ) : (
            [...expandedItems].sort((a, b) => b.date.localeCompare(a.date)).map((it, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '3px 0', color: '#3c4043' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                  <span style={{ color: '#9aa0a6', marginRight: 6 }}>{it.date.slice(5)}</span>
                  {it.note || it.subcategory || it.category || '—'}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, color: '#5f6368' }}>¥{formatCurrency(it.amount)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SettingsModal({
  onClose,
  syncControls,
  thresholdInput,
  setThresholdInput,
  autoSumStartMonthInput,
  setAutoSumStartMonthInput,
  selectedYearMonth,
  today,
  investmentProfitBaseline,
  onSetInvestmentProfitBaseline,
  onInferInvestmentProfit,
  reviewableCategories,
  setReviewableCategories,
  expenseScopeHelpText,
  setExpenseScopeHelpText,
  onSave,
  tagMap,
  confirmedExpenses,
  expenseItems,
  overrides,
  setOverride,
}: {
  onClose: () => void;
  syncControls?: React.ReactNode;
  thresholdInput: string;
  setThresholdInput: (v: string) => void;
  autoSumStartMonthInput: string;
  setAutoSumStartMonthInput: (v: string) => void;
  selectedYearMonth: string;
  today: string;
  investmentProfitBaseline?: InvestmentProfitBaseline;
  onSetInvestmentProfitBaseline: (date: string) => string;
  onInferInvestmentProfit: () => string;
  reviewableCategories: ReviewableCategory[];
  setReviewableCategories: (cats: ReviewableCategory[]) => void;
  expenseScopeHelpText: string;
  setExpenseScopeHelpText: (text: string) => void;
  onSave: () => void;
  tagMap: Record<string, TagKind>;
  confirmedExpenses: Record<string, unknown>;
  expenseItems: Record<string, BillExpenseMonth>;
  overrides: { categories: Record<string, OverrideValue>; subcategories: Record<string, OverrideValue>; notes: Record<string, OverrideValue>; tags: Record<string, OverrideValue> };
  setOverride: (dim: OverrideDimension, name: string, value: OverrideValue | null) => void;
}) {
  const [scopeTab, setScopeTab] = useState<'subcategory' | 'note' | 'tag'>('subcategory');
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [expandedCategoryKey, setExpandedCategoryKey] = useState<string | null>(null);
  const [expenseScopeHelpDraft, setExpenseScopeHelpDraft] = useState(expenseScopeHelpText);
  const [investmentBaselineDate, setInvestmentBaselineDate] = useState(investmentProfitBaseline?.date ?? today);
  const [investmentInferenceMessage, setInvestmentInferenceMessage] = useState('');
  const stats = useMemo(
    () => buildExpenseScopeStats(tagMap, confirmedExpenses, expenseItems, reviewableCategories),
    [tagMap, confirmedExpenses, expenseItems, reviewableCategories],
  );

  const overrideMap = scopeTab === 'subcategory' ? (overrides.subcategories ?? {})
    : scopeTab === 'note' ? (overrides.notes ?? {})
    : (overrides.tags ?? {});
  const tabRows = useMemo(() => {
    const rows = scopeTab === 'subcategory' ? stats.subcategories
      : scopeTab === 'note' ? stats.notes
      : stats.tags;
    return [...rows].sort((a, b) => {
      const aSet = overrideMap[a.name] !== undefined;
      const bSet = overrideMap[b.name] !== undefined;
      if (aSet !== bSet) return aSet ? 1 : -1;
      return (b.localCount + b.sharedCount) - (a.localCount + a.sharedCount);
    });
  }, [scopeTab, stats, overrideMap]);
  const subcategoryGroups = useMemo(() => {
    if (scopeTab !== 'subcategory') return [];
    const map = new Map<string, ExpenseScopeStatRow[]>();
    for (const row of tabRows) {
      const [category] = row.name.split('|');
      const groupName = category || '(未分类)';
      const rows = map.get(groupName) ?? [];
      rows.push(row);
      map.set(groupName, rows);
    }
    return [...map.entries()].map(([category, rows]) => ({
      category,
      rows,
      localCount: rows.reduce((sum, row) => sum + row.localCount, 0),
      sharedCount: rows.reduce((sum, row) => sum + row.sharedCount, 0),
      configuredCount: rows.reduce((sum, row) => sum + (overrideMap[row.name] !== undefined ? 1 : 0), 0),
    }));
  }, [scopeTab, tabRows, overrideMap]);

  // 切 tab 时收起展开行
  useEffect(() => {
    setExpandedRowKey(null);
    setExpandedCategoryKey(null);
  }, [scopeTab]);

  // 把所有月份的账单展平成数组，按行点击展开时按 tab 维度过滤
  const allItems = useMemo(() => {
    const out: BillExpenseItem[] = [];
    for (const monthItems of Object.values(expenseItems)) {
      if (monthItems) out.push(...monthItems);
    }
    return out;
  }, [expenseItems]);

  const itemsForRow = (rowName: string): BillExpenseItem[] => {
    if (scopeTab === 'subcategory') {
      return allItems.filter((it) => {
        const cat = it.category || '(未分类)';
        return subcategoryKey(cat, it.subcategory || '') === rowName;
      });
    }
    if (scopeTab === 'note') {
      return allItems.filter((it) => (it.note || '') === rowName);
    }
    return allItems.filter((it) => {
      const tagList = (it.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      return tagList.includes(rowName);
    });
  };

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: 'none',
    backgroundColor: active ? '#e8f0fe' : '#f1f3f4',
    color: active ? '#1a73e8' : '#5f6368',
  });

  const overrideCount =
    Object.keys(overrides.subcategories ?? {}).length +
    Object.keys(overrides.notes ?? {}).length +
    Object.keys(overrides.tags ?? {}).length;
  const handleSave = () => {
    setExpenseScopeHelpText(expenseScopeHelpDraft);
    onSave();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, maxHeight: '85dvh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div style={{ padding: '20px 20px 12px' }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>设置</div>
        </div>
        {/* 滚动内容 */}
        <div style={{ overflowY: 'auto', padding: '0 20px', flex: 1 }}>
          {syncControls}
          {/* 大额阈值 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#5f6368', marginBottom: 6 }}>大额支出筛选门槛（元）</div>
            <input type="text" inputMode="decimal" value={thresholdInput} onChange={(e) => {
              const next = sanitizeDecimalNumberInput(e.target.value);
              if (next !== null) setThresholdInput(next);
            }}
              style={{ width: '100%', border: '1.5px solid #dadce0', borderRadius: 8, padding: '8px 10px', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <div hidden style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#5f6368', marginBottom: 6 }}>累计盈利自动求和起始月</div>
            <input
              type="month"
              value={autoSumStartMonthInput}
              onChange={(event) => setAutoSumStartMonthInput(event.target.value)}
              style={{ width: '100%', border: '1.5px solid #dadce0', borderRadius: 8, padding: '8px 10px', fontSize: 14, outline: 'none', boxSizing: 'border-box', backgroundColor: '#fff' }}
            />
          </div>
          <div hidden style={{ borderTop: '1px solid #f1f3f4', paddingTop: 14, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#202124' }}>收益推算</div>
              <div style={{ fontSize: 10, color: investmentProfitBaseline ? C.green : '#9aa0a6' }}>
                {investmentProfitBaseline ? `基准 ${investmentProfitBaseline.date}` : '未设基准'}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, marginBottom: 6 }}>
              <input
                type="date"
                value={investmentBaselineDate}
                max={today}
                onChange={(event) => setInvestmentBaselineDate(event.target.value)}
                style={{ minWidth: 0, border: '1.5px solid #dadce0', borderRadius: 8, padding: '7px 9px', fontSize: 12, outline: 'none', backgroundColor: '#fff' }}
              />
              <button
                type="button"
                onClick={() => {
                  try {
                    setInvestmentInferenceMessage(onSetInvestmentProfitBaseline(investmentBaselineDate));
                  } catch (error) {
                    setInvestmentInferenceMessage(error instanceof Error ? error.message : String(error));
                  }
                }}
                style={{ border: 'none', borderRadius: 8, padding: '7px 10px', backgroundColor: '#e8f0fe', color: C.blue, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
              >
                设为基准
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                try {
                  setInvestmentInferenceMessage(onInferInvestmentProfit());
                } catch (error) {
                  setInvestmentInferenceMessage(error instanceof Error ? error.message : String(error));
                }
              }}
              style={{ width: '100%', border: 'none', borderRadius: 8, padding: '8px 10px', backgroundColor: C.blue, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
            >
              推算 {selectedYearMonth}
            </button>
            {investmentInferenceMessage && (
              <div role="status" style={{ marginTop: 6, fontSize: 10, color: C.sub }}>{investmentInferenceMessage}</div>
            )}
          </div>
          {/* 明细模式：勾选时显示哪些类型 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#202124', marginBottom: 4 }}>明细模式：勾选时显示</div>
            <div style={{ fontSize: 11, color: '#5f6368', marginBottom: 8 }}>仅显示选中标签的账单，便于聚焦勾选</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {REVIEWABLE_CATEGORIES.map((cat) => {
                const checked = reviewableCategories.includes(cat);
                return (
                  <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, backgroundColor: checked ? '#e8f0fe' : '#f1f3f4', cursor: 'pointer', fontSize: 12, color: checked ? '#1a73e8' : '#5f6368', fontWeight: 500 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setReviewableCategories([...reviewableCategories, cat]);
                        else setReviewableCategories(reviewableCategories.filter((c) => c !== cat));
                      }}
                      style={{ width: 14, height: 14, accentColor: '#1a73e8' }}
                    />
                    {cat}
                  </label>
                );
              })}
            </div>
          </div>
          {/* 本地/共享分类 */}
          <div style={{ borderTop: '1px solid #f1f3f4', paddingTop: 14, marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#202124', marginBottom: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>本地/共享分类规则</span>
              {overrideCount > 0 && (
                <span style={{ fontSize: 10, fontWeight: 500, color: '#1a73e8', backgroundColor: '#e8f0fe', padding: '2px 6px', borderRadius: 6 }}>
                  已设 {overrideCount}
                </span>
              )}
            </div>
            <textarea
              value={expenseScopeHelpDraft}
              onChange={(e) => setExpenseScopeHelpDraft(e.target.value)}
              rows={4}
              style={{
                width: '100%', border: '1.5px solid #dadce0', borderRadius: 8, padding: '8px 10px',
                fontSize: 11, lineHeight: 1.55, color: '#5f6368', outline: 'none', boxSizing: 'border-box',
                resize: 'vertical', fontFamily: 'inherit', marginBottom: 10, backgroundColor: '#fff',
              }}
            />
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              <button onClick={() => setScopeTab('subcategory')} style={tabBtnStyle(scopeTab === 'subcategory')}>子分类 ({stats.subcategories.length})</button>
              <button onClick={() => setScopeTab('note')} style={tabBtnStyle(scopeTab === 'note')}>笔记 ({stats.notes.length})</button>
              <button onClick={() => setScopeTab('tag')} style={tabBtnStyle(scopeTab === 'tag')}>标签 ({stats.tags.length})</button>
            </div>
            {tabRows.length === 0 ? (
              <div style={{ fontSize: 11, color: '#9aa0a6', padding: '16px 8px', textAlign: 'center' }}>
                暂无数据。导入账单后，对应的子分类/笔记/标签会出现在这里。
              </div>
            ) : scopeTab === 'subcategory' ? (
              <div>
                {subcategoryGroups.map((group) => {
                  const expanded = expandedCategoryKey === group.category;
                  return (
                    <div key={group.category} style={{ borderRadius: 8, marginBottom: 6, backgroundColor: '#fafbfc' }}>
                      <button
                        type="button"
                        onClick={() => setExpandedCategoryKey(expanded ? null : group.category)}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'none', border: 'none', padding: '8px 10px', textAlign: 'left', cursor: 'pointer' }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#202124', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <span style={{ color: '#9aa0a6', marginRight: 6, fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
                            {group.category}
                          </div>
                          <div style={{ fontSize: 10, color: '#5f6368', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                            {group.rows.length} 项
                            {group.configuredCount > 0 && <span style={{ marginLeft: 8, color: '#1a73e8' }}>已设×{group.configuredCount}</span>}
                            {group.localCount > 0 && <span style={{ marginLeft: 8, color: '#1a73e8' }}>本地×{group.localCount}</span>}
                            {group.sharedCount > 0 && <span style={{ marginLeft: 8, color: '#e8710a' }}>共享×{group.sharedCount}</span>}
                          </div>
                        </div>
                      </button>
                      {expanded && (
                        <div style={{ padding: '0 0 4px 12px' }}>
                          {group.rows.map((row) => {
                            const current = overrideMap[row.name];
                            const sug = suggestScope(row);
                            const inc = isInconsistent(row);
                            const displayName = row.name.includes('|')
                              ? row.name.split('|').slice(1).join('|') || group.category
                              : row.name;
                            const rowExpanded = expandedRowKey === row.name;
                            return (
                              <ScopeRow
                                key={row.name}
                                row={row}
                                current={current}
                                suggestion={sug}
                                inconsistent={inc}
                                displayName={displayName}
                                allowIgnore
                                expanded={rowExpanded}
                                onToggleExpand={() => setExpandedRowKey(rowExpanded ? null : row.name)}
                                expandedItems={rowExpanded ? itemsForRow(row.name) : undefined}
                                onChange={(next) => setOverride(scopeTab, row.name, next)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div>
                {tabRows.map((row) => {
                  const current = overrideMap[row.name];
                  const sug = suggestScope(row);
                  const inc = isInconsistent(row);
                  const expanded = expandedRowKey === row.name;
                  return (
                    <ScopeRow
                      key={row.name}
                      row={row}
                      current={current}
                      suggestion={sug}
                      inconsistent={inc}
                      displayName={row.name}
                      allowIgnore
                      expanded={expanded}
                      onToggleExpand={() => setExpandedRowKey(expanded ? null : row.name)}
                      expandedItems={expanded ? itemsForRow(row.name) : undefined}
                      onChange={(next) => setOverride(scopeTab, row.name, next)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {/* 底部按钮 */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0, flexWrap: 'wrap', padding: '12px 20px max(20px, env(safe-area-inset-bottom))', borderTop: '1px solid #f1f3f4' }}>
          <button onClick={onClose}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #dadce0', backgroundColor: '#fff', color: '#5f6368', fontSize: 13, cursor: 'pointer' }}>
            取消
          </button>
          <button onClick={handleSave}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', backgroundColor: '#1a73e8', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MonthForm ─────────────────────────────────────────────────────
// 大额支出中的出游标签只排除当前记录月份；未来或其他月份仍可展示。
function isMajorExpenseExcludedTag(tag: string, tagCategory: Record<string, ManualTagCategory>, yearMonth: string): boolean {
  const c = classifyTag(tag, tagCategory);
  if (c === 'trip') {
    const [year, month] = yearMonth.split('-');
    return tagYearMonthPrefix(tag) === `${year.slice(-2)}.${Number(month)}`;
  }
  return isMajorExcludedTag(tag, tagCategory);
}

function editableInvestmentSignature(items: InvestPositionItems | undefined) {
  return JSON.stringify(Object.entries(items ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => [key, (group ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      symbol: item.symbol,
      quoteSource: item.quoteSource,
      quoteCurrency: item.quoteCurrency,
      status: item.status,
      shares: item.shares,
      costPrice: item.costPrice,
      historicalProfitCny: item.historicalProfitCny,
      historicalProfitCurrency: item.historicalProfitCurrency,
      profitInputMode: item.profitInputMode,
      marketValueCny: item.symbol ? undefined : item.marketValueCny,
      holdingProfitCny: item.symbol ? undefined : item.holdingProfitCny,
    }))]));
}

type MonthFormProps = {
  yearMonth: string;
  existing?: MonthlyRecord;
  prevRecord?: MonthlyRecord;
  allRecords: MonthlyRecord[];
  tagCounts: Record<TagKind, number>;
  expenseItems?: BillExpenseMonth;
  onSave: (r: MonthlyRecord, investmentSource?: InvestmentMutationSource) => void;
};

function useMonthForm({ yearMonth, existing, prevRecord, allRecords, tagCounts, expenseItems, onSave }: MonthFormProps) {
  const syncReady = useSyncStatus((state) => state.ready);
  const [income,       setIncome]       = useState(String(existing?.income        ?? ''));
  const [totalExpense, setTotalExpense]  = useState(String(existing?.totalExpense  ?? ''));
  const [periodicLife, setPeriodicLife]  = useState(String(existing?.periodicLife  ?? ''));
  const [volatileLife, setVolatileLife]  = useState(String(existing?.volatileLife  ?? ''));
  const [consumption,  setConsumption]   = useState(String(existing?.consumption   ?? ''));
  const [school,       setSchool]        = useState(String(existing?.school        ?? ''));
  const [totalAssets,  setTotalAssets]   = useState(String(existing?.totalAssets   ?? ''));
  const [savingsNote, setSavingsNote] = useState(existing?.savingsNote ?? '');
  const [accProfit,    setAccProfit]     = useState(String(getManualAccumulatedProfit(existing) || ''));

  // 自动保存的跳过标志：声明在同步 effect 之前，便于同步时复位
  const isFirstSave = useRef(true);
  const lastAutoSaveSignatureRef = useRef<string | null>(null);
  // 记录本组件最近一次写出的核心字段；用来识别"自己 upsert 引发的 existing 反弹"，
  // 区分外部刷新（导入账单 / 跨端同步）所引起的 existing 变化
  const ourLastWrittenRef = useRef<{
    income: number; totalExpense: number; periodicLife: number;
    volatileLife: number; consumption: number; school: number;
    totalAssets?: number;
    savingsNote: string;
    manualAccumulatedProfit: number;
  } | null>(null);

  useEffect(() => {
    const our = ourLastWrittenRef.current;
    const isBounceback =
      our !== null
      && our.income        === (existing?.income        ?? 0)
      && our.totalExpense  === (existing?.totalExpense  ?? 0)
      && our.periodicLife  === (existing?.periodicLife  ?? 0)
      && our.volatileLife  === (existing?.volatileLife  ?? 0)
      && our.consumption   === (existing?.consumption   ?? 0)
      && our.school        === (existing?.school        ?? 0)
      && our.totalAssets   === existing?.totalAssets
      && our.savingsNote   === (existing?.savingsNote ?? '')
      && our.manualAccumulatedProfit === getManualAccumulatedProfit(existing);
    // 自己保存后 store 反弹回来：state 已经是最新值，不要再 setState/复位 flag，
    // 否则用户连续输入会被下一次 sync 触发的 isFirstSave 复位吃掉
    if (isBounceback) return;
    setIncome(String(existing?.income ?? ''));
    setTotalExpense(String(existing?.totalExpense ?? ''));
    setPeriodicLife(String(existing?.periodicLife ?? ''));
    setVolatileLife(String(existing?.volatileLife ?? ''));
    setConsumption(String(existing?.consumption ?? ''));
    setSchool(String(existing?.school ?? ''));
    setTotalAssets(String(existing?.totalAssets ?? ''));
    setSavingsNote(existing?.savingsNote ?? '');
    setAccProfit(String(getManualAccumulatedProfit(existing) || ''));
    // existing 由外部刷新（导入账单 upsert 等）时，跳过下一次由派生依赖触发的自动保存，
    // 避免在 setState 还未应用的闭包里读到空字符串把 store 清零
    isFirstSave.current = true;
  }, [
    existing?.income,
    existing?.totalExpense,
    existing?.periodicLife,
    existing?.volatileLife,
    existing?.consumption,
    existing?.school,
    existing?.totalAssets,
    existing?.savingsNote,
    existing?.accumulatedProfit,
    existing?.manualAccumulatedProfit,
  ]);

  const homeDays   = tagCounts.home   > 0 ? tagCounts.home   : (existing?.homeDays   ?? 0);
  const travelDays = tagCounts.travel > 0 ? tagCounts.travel : (existing?.travelDays ?? 0);
  const schoolDays = tagCounts.school > 0 ? tagCounts.school : (existing?.schoolDays ?? 0);
  const internDays = tagCounts.intern > 0 ? tagCounts.intern : (existing?.internDays ?? 0);

  const [majorExpensesNote, setMajorExpensesNote] = useState<string>(existing?.majorExpensesNote ?? '');
  const [majorExpenseNameDrafts, setMajorExpenseNameDrafts] = useState<Record<string, string>>({});
  const [breakdown] = useState<Partial<Record<keyof InvestHoldings, string>>>(
    () => Object.fromEntries(INVEST_KEYS.map((k) => [k, String(existing?.investBreakdown?.[k] ?? '')])) as Record<keyof InvestHoldings, string>
  );
  const [breakdownProfit] = useState<Partial<Record<keyof InvestHoldings, string>>>(
    () => Object.fromEntries(INVEST_KEYS.map((k) => [k, String(existing?.investBreakdownProfit?.[k] ?? '')])) as Record<keyof InvestHoldings, string>
  );
  // past 收益：本月已存优先，否则继承上月，逐月带入作为默认起点。
  const [pastBreakdownProfit] = useState<Partial<Record<keyof InvestHoldings, string>>>(() => {
    const src = existing?.investBreakdownPastProfit ?? prevRecord?.investBreakdownPastProfit;
    return Object.fromEntries(INVEST_KEYS.map((k) => [k, String(src?.[k] ?? '')])) as Record<keyof InvestHoldings, string>;
  });
  const initUsdComponents = (src: MonthlyRecord['investProfitComponents'] | undefined) => {
    const init: Partial<Record<'us' | 'usBond', { cny: string; rate: string; usd: string }>> = {};
    for (const k of ['us', 'usBond'] as const) {
      const c = src?.[k];
      if (c) init[k] = { cny: String(c.cny), rate: String(c.rate), usd: String(c.usd) };
    }
    return init;
  };
  const [usdComponents] = useState(() => initUsdComponents(existing?.investProfitComponents));
  const [pastUsdComponents] = useState(() =>
    initUsdComponents(existing?.investPastProfitComponents ?? prevRecord?.investPastProfitComponents),
  );
  const [sharedUsdRate] = useState(() => {
    const rate = existing?.investProfitComponents?.us?.rate ?? existing?.investProfitComponents?.usBond?.rate;
    return rate !== undefined ? String(rate) : '';
  });
  const initialPositionItemsRef = useRef<InvestPositionItems | null>(null);
  if (initialPositionItemsRef.current === null) {
    const hasExistingInvestmentData = existing?.investPositionItems !== undefined
      || INVEST_KEYS.some((key) => (existing?.investBreakdown?.[key] ?? 0) !== 0
        || (existing?.investBreakdownProfit?.[key] ?? 0) !== 0
        || (existing?.investBreakdownPastProfit?.[key] ?? 0) !== 0);
    const sourceRecord = hasExistingInvestmentData
      ? existing
      : prevRecord?.investPositionItems !== undefined
        ? { ...prevRecord, yearMonth, accumulatedProfit: existing?.accumulatedProfit ?? prevRecord.accumulatedProfit }
        : existing;
    initialPositionItemsRef.current = migrateLegacyInvestPositionItems(sourceRecord, INVEST_POSITION_LABELS);
  }
  const [positionDraftGroups, setPositionDraftGroups] = useState<InvestPositionDraftGroups>(() =>
    investPositionDraftGroupsFromItems(initialPositionItemsRef.current ?? {}),
  );
  const positionItems = useMemo(() => investPositionItemsFromDraftGroups(positionDraftGroups), [positionDraftGroups]);
  const hasPositionModel = existing?.investPositionItems !== undefined
    || INVEST_POSITION_GROUP_KEYS.some((key) => positionDraftGroups[key].length > 0);
  const isCurrentRecordMonth = yearMonth === `${_NOW.getFullYear()}-${String(_NOW.getMonth() + 1).padStart(2, '0')}`;
  const fallbackUsdRate = Number(sharedUsdRate);
  const { quotes: positionQuotes, quoteErrors: positionQuoteErrors, marketsBySymbol } = useInvestPositionMarkets(
    positionItems,
    isCurrentRecordMonth && syncReady,
    Number.isFinite(fallbackUsdRate) && fallbackUsdRate > 0 ? fallbackUsdRate : null,
  );
  const positionSummary = useMemo(
    () => summarizeInvestPositionItems(positionItems, marketsBySymbol),
    [marketsBySymbol, positionItems],
  );
  const previousPositionItems = useMemo(
    () => prevRecord ? migrateLegacyInvestPositionItems(prevRecord, INVEST_POSITION_LABELS) : undefined,
    [prevRecord],
  );
  const previousMarketsBySymbol = useMemo(() => {
    const markets: Record<string, InvestMarketSnapshot | undefined> = {};
    for (const groupKey of INVEST_POSITION_KEYS) {
      for (const item of previousPositionItems?.[groupKey] ?? []) {
        const price = Number(item.lastPrice);
        const currency = (item.lastCurrency || item.quoteCurrency || defaultInvestQuoteCurrency(groupKey) || '').toUpperCase();
        const currentMarket = marketsBySymbol[investPositionQuoteKey(item)];
        const fxRateToCny = ['CNY', 'CNH'].includes(currency)
          ? 1
          : Number(item.lastFxRateToCny) || currentMarket?.fxRateToCny || 0;
        if (!item.symbol.trim() || !(price > 0) || !currency || !(fxRateToCny > 0)) continue;
        markets[investPositionQuoteKey(item)] = {
          price,
          currency,
          fxRateToCny,
          live: false,
          quoteAt: item.quoteAt,
        };
      }
    }
    return markets;
  }, [marketsBySymbol, previousPositionItems]);
  const positionMonthlyProfit = useMemo(
    () => calculateInvestPositionMonthlyProfit(
      positionItems,
      previousPositionItems,
      marketsBySymbol,
      previousMarketsBySymbol,
    ),
    [marketsBySymbol, positionItems, previousMarketsBySymbol, previousPositionItems],
  );
  const positionMonthlyProfitById = positionMonthlyProfit.byItemId;
  const positionMonthlyIncome = useMemo(() => {
    if (!previousPositionItems) return null;
    const previousSummary = summarizeInvestPositionItems(previousPositionItems, previousMarketsBySymbol);
    return roundCny(positionSummary.totalProfitCny - previousSummary.totalProfitCny);
  }, [positionSummary.totalProfitCny, previousMarketsBySymbol, previousPositionItems]);
  const positionItemsForSave = useMemo<InvestPositionItems>(() => {
    const next: InvestPositionItems = {};
    for (const key of INVEST_POSITION_GROUP_KEYS) {
      const group = positionItems[key] ?? [];
      if (group.length === 0) continue;
      next[key] = group.map((item) => {
        const metric = positionSummary.metricsById[item.id];
        if (!metric) return item;
        return {
          ...item,
          marketValueCny: metric.marketValueCny,
          holdingProfitCny: metric.holdingProfitCny,
          lastPrice: metric.price,
          lastCurrency: metric.currency,
          lastFxRateToCny: metric.fxRateToCny
            ?? inferInvestPositionFxRateToCny(item, item.lastCurrency || item.quoteCurrency || defaultInvestQuoteCurrency(key))
            ?? item.lastFxRateToCny,
          quoteAt: metric.quoteAt,
        };
      });
    }
    return next;
  }, [positionItems, positionSummary]);
  const { config } = useConfigStore();
  const isAccumulatedProfitAuto = isInvestAccumulatedProfitAuto(yearMonth, config.investAutoSumStartMonth)
    && hasPositionModel;
  const { tagCategory } = usePossessionStore();

  const n = (v: string) => parseFloat(v) || 0;
  const nOrNull = (v: string | undefined) => {
    if (v === undefined || v.trim() === '') return null;
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const nOrUndefined = (v: string) => {
    if (v.trim() === '') return undefined;
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const breakdownInvestTotal = INVEST_KEYS.reduce((sum, k) => sum + (parseFloat(breakdown[k] ?? '') || 0), 0);
  const hasBreakdownAmount = INVEST_KEYS.some((k) => (parseFloat(breakdown[k] ?? '') || 0) > 0);
  const investTotalStoredOnly = !hasPositionModel && !hasBreakdownAmount && (existing?.investTotal ?? 0) > 0;
  const investTotal = hasPositionModel
    ? positionSummary.totalMarketValueCny
    : hasBreakdownAmount
      ? breakdownInvestTotal
      : (existing?.investTotal ?? 0);
  const investTotalForRate = useMemo(
    () => getInvestTotalForRate(yearMonth, investTotal, allRecords),
    [yearMonth, investTotal, allRecords],
  );
  const surplus = n(income) - n(totalExpense);
  const totalAssetsValue = nOrUndefined(totalAssets);
  const assetChange = getMonthlyAssetChange({ totalAssets: totalAssetsValue }, prevRecord);
  const accumulatedProfitValue = isAccumulatedProfitAuto ? positionSummary.totalProfitCny : n(accProfit);
  const investIncome = prevRecord
    ? accumulatedProfitValue - (prevRecord.accumulatedProfit ?? 0)
    : null;
  const savingsDraft = {
    income: n(income),
    investTotal,
    accumulatedProfit: accumulatedProfitValue,
  };
  const savedAmount = getMonthlySavedAmount(savingsDraft, prevRecord);
  const savingsRate = getMonthlySavingsRate(savingsDraft, prevRecord);
  const savedAmountTitle = getSavedAmountTitle(savingsDraft, prevRecord);
  const investMonthly = investIncome !== null && investTotalForRate !== null ? investIncome / investTotalForRate.value : null;
  const investAnnual = investMonthly !== null ? investMonthly * 12 : null;
  const getBreakdownMonthlyProfit = (k: keyof InvestHoldings) => {
    if (!prevRecord) return null;
    if (hasPositionModel) return positionMonthlyProfit.byCategory[k] ?? null;
    const now = nOrNull(breakdownProfit[k]);
    const past = nOrNull(pastBreakdownProfit[k]);
    const totalProfit = (now !== null || past !== null) ? (now ?? 0) + (past ?? 0) : null;
    const storedPreviousProfit = getCategoryProfit(prevRecord, k);
    return totalProfit !== null && storedPreviousProfit !== null ? totalProfit - storedPreviousProfit : null;
  };

  const updatePositionDraft = (groupKey: InvestPositionGroupKey, id: string, patch: Partial<InvestPositionDraft>) => {
    setPositionDraftGroups((previous) => ({
      ...previous,
      [groupKey]: previous[groupKey].map((item) => item.id === id ? { ...item, ...patch } : item),
    }));
  };
  const addPositionDraft = (groupKey: InvestPositionGroupKey, status: InvestPositionStatus) => {
    const nextStatus = groupKey === 'account' ? 'closed' : groupKey === 'aggregate' ? 'paused' : status;
    const id = makeInvestPositionId();
    setPositionDraftGroups((previous) => ({
      ...previous,
      [groupKey]: [...previous[groupKey], {
        id,
        name: groupKey === 'account' ? '新历史账户' : groupKey === 'aggregate' ? '新总账户' : '',
        symbol: '',
        status: nextStatus,
        shares: '',
        costPrice: '',
        historicalProfitCny: '0',
        historicalProfitCurrency: 'CNY',
        profitInputMode: 'historical',
        marketValueCny: '',
        holdingProfitCny: '',
        lastPrice: '',
      }],
    }));
    return id;
  };
  const removePositionDraft = (groupKey: InvestPositionGroupKey, id: string) => {
    setPositionDraftGroups((previous) => ({
      ...previous,
      [groupKey]: previous[groupKey].filter((item) => item.id !== id),
    }));
  };
  const movePositionDraft = (sourceGroupKey: InvestPositionGroupKey, id: string, targetGroupKey: InvestKey, targetStatus?: 'active' | 'paused') => {
    setPositionDraftGroups((previous) => moveInvestPositionDraft(previous, sourceGroupKey, id, targetGroupKey, targetStatus));
  };
  const splitPositionAccount = (input: PositionSplitInput) => {
    const targetId = makeInvestPositionId();
    setPositionDraftGroups((previous) => splitInvestPositionDraft(previous, input, targetId));
  };

  const suggestedMajorExpenses = useMemo<MajorExpense[]>(() => {
    if (!expenseItems || expenseItems.length === 0) {
      return existing?.majorExpenses ?? [];
    }
    // 按标签聚合：统计每个标签对应的条目集合与总金额
    const tagIndices = new Map<string, Set<number>>();
    for (let i = 0; i < expenseItems.length; i++) {
      const tags = expenseItems[i].tags.split(',').map(t => t.trim()).filter(Boolean);
      for (const tag of tags) {
        if (!tagIndices.has(tag)) tagIndices.set(tag, new Set());
        tagIndices.get(tag)!.add(i);
      }
    }
    const threshold = config.majorExpenseThreshold ?? 500;
    const tagTotals = new Map<string, number>();
    for (const [tag, idxs] of tagIndices) {
      if (isMajorExpenseExcludedTag(tag, tagCategory, yearMonth)) continue;
      const total = [...idxs].reduce((s, i) => s + expenseItems[i].amount, 0);
      if (total >= threshold) tagTotals.set(tag, total);
    }
    // 去除子标签：B 的条目集合 ⊊ A 的条目集合（真子集）→ B 被过滤
    // 集合相等时，按 tag 名 tie-break，保留较小者，避免互相过滤导致两边都丢
    const topTags = [...tagTotals.keys()].filter(tag => {
      const myIdxs = tagIndices.get(tag)!;
      return ![...tagTotals.keys()].some(other => {
        if (other === tag) return false;
        const otherIdxs = tagIndices.get(other)!;
        if (otherIdxs.size < myIdxs.size) return false;
        const contained = [...myIdxs].every(i => otherIdxs.has(i));
        if (!contained) return false;
        if (otherIdxs.size > myIdxs.size) return true; // 真子集
        return other < tag; // 集合相等，名字小的保留
      });
    });
    topTags.sort((a, b) => tagTotals.get(b)! - tagTotals.get(a)!);
    return topTags.map(tag => {
      let lifeAmt = 0, consumeAmt = 0;
      for (const i of tagIndices.get(tag)!) {
        const item = expenseItems[i];
        const itemTags = item.tags.split(',').map(t => t.trim());
        if (itemTags.includes('消费')) consumeAmt += item.amount;
        if (itemTags.includes('波动生活') || itemTags.includes('周期生活')) lifeAmt += item.amount;
      }
      const type: '生活' | '消费' = consumeAmt > lifeAmt ? '消费' : '生活';
      return { type, name: tag, amount: Math.round(tagTotals.get(tag)! * 100) / 100 };
    });
  }, [expenseItems, config.majorExpenseThreshold, tagCategory, yearMonth, existing?.majorExpenses]);
  const majorExpenses = useMemo(() => {
    const savedNames = new Map((existing?.majorExpenses ?? []).map((expense) => [expense.sourceName ?? expense.name, expense.name]));
    return suggestedMajorExpenses.map((expense) => {
      const sourceName = expense.sourceName ?? expense.name;
      return {
        ...expense,
        sourceName,
        name: majorExpenseNameDrafts[sourceName] ?? savedNames.get(sourceName) ?? expense.name,
      };
    });
  }, [existing?.majorExpenses, majorExpenseNameDrafts, suggestedMajorExpenses]);
  const updateMajorExpenseName = (sourceName: string, name: string) => {
    setMajorExpenseNameDrafts((previous) => ({ ...previous, [sourceName]: name }));
  };

  const buildProfitComponents = (): MonthlyRecord['investProfitComponents'] => {
    const out: NonNullable<MonthlyRecord['investProfitComponents']> = {};
    for (const k of ['us', 'usBond'] as const) {
      const c = usdComponents[k];
      if (!c) continue;
      const cny = parseFloat(c.cny);
      const rate = parseFloat(sharedUsdRate);
      const usd = parseFloat(c.usd);
      if (isNaN(cny) || isNaN(rate) || isNaN(usd)) continue;
      out[k] = { cny, rate, usd };
    }
    return Object.keys(out).length ? out : undefined;
  };
  const buildPastProfitComponents = (): MonthlyRecord['investPastProfitComponents'] => {
    const out: NonNullable<MonthlyRecord['investPastProfitComponents']> = {};
    for (const k of ['us', 'usBond'] as const) {
      const c = pastUsdComponents[k];
      if (!c) continue;
      const cny = parseFloat(c.cny);
      const rate = parseFloat(c.rate);
      const usd = parseFloat(c.usd);
      if (isNaN(cny) || isNaN(rate) || isNaN(usd)) continue;
      out[k] = { cny, rate, usd };
    }
    return Object.keys(out).length ? out : undefined;
  };
  const handleSave = () => {
    const bd = hasPositionModel
      ? positionSummary.marketValueByCategory
      : Object.fromEntries(INVEST_KEYS.map((k) => [k, parseFloat(breakdown[k] ?? '') || 0])) as unknown as InvestHoldings;
    const hasBreakdown = INVEST_KEYS.some((k) => (bd[k] || 0) > 0);
    const bp = hasPositionModel
      ? positionSummary.holdingProfitByCategory
      : Object.fromEntries(INVEST_KEYS.map((k) => [k, parseFloat(breakdownProfit[k] ?? '') || 0])) as unknown as InvestHoldings;
    const hasBreakdownProfit = INVEST_KEYS.some((k) => (bp[k] || 0) !== 0);
    const pbp = hasPositionModel
      ? positionSummary.historicalProfitByCategory
      : Object.fromEntries(INVEST_KEYS.map((k) => [k, parseFloat(pastBreakdownProfit[k] ?? '') || 0])) as unknown as InvestHoldings;
    const hasPastProfit = INVEST_KEYS.some((k) => (pbp[k] || 0) !== 0);
    const incomeNum       = n(income);
    const totalExpenseNum = n(totalExpense);
    const periodicLifeNum = n(periodicLife);
    const volatileLifeNum = n(volatileLife);
    const consumptionNum  = n(consumption);
    const schoolNum       = n(school);
    const totalAssetsNum  = nOrUndefined(totalAssets);
    const investmentInputsChanged = editableInvestmentSignature(positionItemsForSave)
      !== editableInvestmentSignature(existing?.investPositionItems)
      || (!hasPositionModel && n(accProfit) !== getManualAccumulatedProfit(existing));
    const investmentEditedAt = investmentInputsChanged
      ? new Date().toISOString()
      : existing?.investmentEditedAt;
    // 记录本次写出的核心字段，便于 sync effect 识别 store 反弹（避免误复位 isFirstSave）
    ourLastWrittenRef.current = {
      income: incomeNum, totalExpense: totalExpenseNum,
      periodicLife: periodicLifeNum, volatileLife: volatileLifeNum,
      consumption: consumptionNum, school: schoolNum, totalAssets: totalAssetsNum,
      savingsNote,
      manualAccumulatedProfit: n(accProfit),
    };
    onSave({
      yearMonth, income: incomeNum, totalExpense: totalExpenseNum,
      periodicLife: periodicLifeNum, volatileLife: volatileLifeNum,
      consumption: consumptionNum, school: schoolNum,
      totalAssets: totalAssetsNum,
      savingsNote,
      accumulatedProfit: accumulatedProfitValue,
      manualAccumulatedProfit: n(accProfit),
      investTotal,
      investBreakdown: hasBreakdown ? bd : undefined,
      investBreakdownProfit: hasBreakdownProfit ? bp : undefined,
      investProfitComponents: buildProfitComponents(),
      investBreakdownPastProfit: hasPastProfit ? pbp : undefined,
      investPastProfitComponents: buildPastProfitComponents(),
      investPositionItems: hasPositionModel ? positionItemsForSave : undefined,
      investmentTransactions: existing?.investmentTransactions,
      importedInvestmentTransactionIds: existing?.importedInvestmentTransactionIds,
      lastInvestmentMailUid: existing?.lastInvestmentMailUid,
      investmentEditedAt,
      investmentRolledOverFrom: investmentInputsChanged ? undefined : existing?.investmentRolledOverFrom,
      investmentInheritanceRevision: existing?.investmentInheritanceRevision,
      isBaseline: undefined,
      homeDays, travelDays, schoolDays, internDays,
      majorExpenses: majorExpenses.map((expense) => ({ ...expense, name: expense.name.trim() || expense.sourceName })),
      majorExpensesNote: majorExpensesNote.trim() || undefined,
    }, investmentInputsChanged ? 'manual' : undefined);
  };

  const autoSaveSignature = useMemo(() => JSON.stringify({
    income, totalExpense, periodicLife, volatileLife, consumption, school, totalAssets, accProfit, isAccumulatedProfitAuto,
    majorExpenses, majorExpensesNote, savingsNote, breakdown, breakdownProfit, usdComponents, sharedUsdRate,
    pastBreakdownProfit, pastUsdComponents, positionDraftGroups, positionItemsForSave,
  }), [
    income, totalExpense, periodicLife, volatileLife, consumption, school, totalAssets, accProfit, isAccumulatedProfitAuto,
    majorExpenses, majorExpensesNote, savingsNote, breakdown, breakdownProfit, usdComponents, sharedUsdRate,
    pastBreakdownProfit, pastUsdComponents, positionDraftGroups, positionItemsForSave,
  ]);
  const criticalInvestmentSignature = useMemo(() => JSON.stringify({
    pastBreakdownProfit,
    pastUsdComponents,
    positionDraftGroups,
  }), [pastBreakdownProfit, pastUsdComponents, positionDraftGroups]);
  const lastCriticalInvestmentSignatureRef = useRef(criticalInvestmentSignature);

  // 自动保存：任何字段变化都立即写回 store。
  // React StrictMode 在开发环境会重复执行 mount effect；用签名去重，避免空白新月份被写成 0。
  useEffect(() => {
    if (isFirstSave.current) {
      isFirstSave.current = false;
      lastAutoSaveSignatureRef.current = autoSaveSignature;
      return;
    }
    if (lastAutoSaveSignatureRef.current === autoSaveSignature) return;
    lastAutoSaveSignatureRef.current = autoSaveSignature;
    handleSave();
  }, [autoSaveSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // past 收益影响后续月份，变更后立即补一次云同步，避免刷新时被旧云数据覆盖。
  useEffect(() => {
    if (lastCriticalInvestmentSignatureRef.current === criticalInvestmentSignature) return;
    lastCriticalInvestmentSignatureRef.current = criticalInvestmentSignature;
    void triggerUpload();
  }, [criticalInvestmentSignature]);

  const fieldStyle: React.CSSProperties = {
    width: '100%', border: '1.5px solid #fbbf24', borderRadius: 8,
    padding: '8px 10px', fontSize: 13, fontVariantNumeric: 'tabular-nums',
    outline: 'none', backgroundColor: '#fffbeb', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, color: C.sub, marginBottom: 3, fontWeight: 500 };

  return {
    income, setIncome, totalExpense, setTotalExpense, periodicLife, setPeriodicLife,
    volatileLife, setVolatileLife, consumption, setConsumption, school, setSchool,
    totalAssets, setTotalAssets, totalAssetsValue, previousTotalAssets: prevRecord?.totalAssets,
    assetChange, savedAmount, savingsRate, savedAmountTitle,
    savingsNote, setSavingsNote,
    accProfit, setAccProfit, accumulatedProfitValue, isAccumulatedProfitAuto, hasPositionModel, investTotal,
    majorExpenses, updateMajorExpenseName, majorExpensesNote, setMajorExpensesNote,
    surplus, investIncome, investMonthly, investAnnual, investTotalForRate, investTotalStoredOnly, n,
    getBreakdownMonthlyProfit,
    positionDraftGroups, updatePositionDraft, addPositionDraft, removePositionDraft,
    splitPositionAccount, movePositionDraft,
    positionSummary, positionMonthlyIncome, positionMonthlyProfitById, positionQuotes, positionQuoteErrors, isCurrentRecordMonth,
    positionItemsForSave, previousPositionItems, marketsBySymbol, previousMarketsBySymbol, allRecords, previousMonth: prevRecord?.yearMonth,
    handleSave,
    fieldStyle, labelStyle,
    yearMonth,
  };
}

type MonthFormState = ReturnType<typeof useMonthForm>;

function MonthDataSection({ state }: { state: MonthFormState }) {
  const {
    income, totalExpense, periodicLife, volatileLife, consumption,
    totalAssets, setTotalAssets, totalAssetsValue, previousTotalAssets, assetChange, savedAmount, savingsRate, savedAmountTitle,
    savingsNote, setSavingsNote,
    investTotal,
    surplus, investIncome, investMonthly, investAnnual, investTotalForRate, investTotalStoredOnly, n,
    labelStyle,
  } = state;
  const investTotalDisplay = investTotal > 0
    ? formatCurrency(investTotal)
    : investTotalForRate !== null
      ? `≈${formatCurrency(investTotalForRate.value)}`
      : '—';
  const investTotalTitle = investTotal > 0
    ? (investTotalStoredOnly ? '沿用已保存的理财总额' : '由各品类持仓求和')
    : investTotalForRate?.estimated
      ? `理财总额按 ${investTotalForRate.beforeMonth} / ${investTotalForRate.afterMonth} 均值估算`
      : undefined;
  const lifeAmount = n(periodicLife) + n(volatileLife);
  const lowerFields = [
    {
      label: '本月结余',
      val: formatSignedCurrency(surplus),
      bg: surplus >= 0 ? '#fce8e6' : '#e6f4ea',
      fg: surplus >= 0 ? C.red : C.green,
      kind: 'result' as const,
    },
    {
      label: '总资产',
      val: '',
      bg: '#fffbeb',
      fg: '#202124',
      kind: 'manual' as const,
    },
    {
      label: '资产增加',
      val: assetChange !== null ? formatSignedCurrency(assetChange) : '—',
      bg: assetChange !== null && assetChange >= 0 ? '#fce8e6' : '#e6f4ea',
      fg: assetChange !== null && assetChange >= 0 ? C.red : C.green,
      kind: 'result' as const,
      hint: assetChange === null && totalAssetsValue !== undefined ? '上月未记录' : undefined,
      title: getAssetChangeTitle(totalAssetsValue, previousTotalAssets),
    },
    { label: '总收入', val: income ? formatCurrency(n(income)) : '—', bg: '#f1f3f4', fg: '#3c4043', kind: 'auto' as const },
    { label: '总支出', val: totalExpense ? formatCurrency(n(totalExpense)) : '—', bg: '#f1f3f4', fg: '#3c4043', kind: 'auto' as const },
    {
      label: '理财总额',
      val: investTotalDisplay,
      bg: '#f1f3f4',
      fg: '#3c4043',
      kind: investTotal > 0 ? (investTotalStoredOnly ? 'stored' as const : 'sum' as const) : (investTotalForRate?.estimated ? 'estimate' as const : 'sum' as const),
      title: investTotalTitle,
    },
  ];
  return (
    <>
      <div className="monthly-expense-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(50px, auto))', gap: 8, marginBottom: 8 }}>
        <div style={{ gridColumn: '1', gridRow: '1 / 3', minWidth: 0, backgroundColor: '#e6f4ea', borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: 11, color: C.sub }}>生活</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums' }}>
            {periodicLife || volatileLife ? `¥${formatCurrency(lifeAmount)}` : '—'}
          </div>
        </div>
        <div style={{ gridColumn: '2', gridRow: '1', minWidth: 0, backgroundColor: '#f1f8f3', borderRadius: 10, padding: '7px 10px' }}>
          <div style={{ fontSize: 10, color: C.sub }}>周期生活</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {periodicLife ? formatCurrency(n(periodicLife)) : '—'}
          </div>
        </div>
        <div style={{ gridColumn: '2', gridRow: '2', minWidth: 0, backgroundColor: '#f1f8f3', borderRadius: 10, padding: '7px 10px' }}>
          <div style={{ fontSize: 10, color: C.sub }}>波动生活</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.green, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {volatileLife ? formatCurrency(n(volatileLife)) : '—'}
          </div>
        </div>
        <div style={{ gridColumn: '3', gridRow: '1 / 3', minWidth: 0, backgroundColor: '#f3e8ff', borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: 11, color: C.sub }}>消费</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.purple, fontVariantNumeric: 'tabular-nums' }}>
            {consumption ? `¥${formatCurrency(n(consumption))}` : '—'}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 16 }}>
        <div title={savedAmountTitle} style={{ minWidth: 0, backgroundColor: savedAmount !== null && savedAmount >= 0 ? '#fce8e6' : '#e6f4ea', borderRadius: 10, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: C.sub }}>存下</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: savedAmount !== null && savedAmount >= 0 ? C.red : C.green, fontVariantNumeric: 'tabular-nums' }}>
            {savedAmount !== null ? formatSignedCurrency(savedAmount) : '—'}
          </div>
          <div style={{ marginTop: 5, fontSize: 10, fontWeight: 600, color: savingsRate !== null && savingsRate >= 0 ? C.red : C.green, fontVariantNumeric: 'tabular-nums' }}>
            储蓄率 {savingsRate !== null ? `${(savingsRate * 100).toFixed(1)}%` : '—'}
          </div>
          <label title="" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, minWidth: 0, color: C.sub }}>
            <span aria-hidden="true" style={{ fontSize: 13 }}>🪿</span>
            <input
              aria-label="储蓄备注"
              value={savingsNote}
              onChange={(event) => setSavingsNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                const evaluated = tryEvalFormula(event.currentTarget.value);
                if (evaluated !== null) setSavingsNote(evaluated);
                event.currentTarget.blur();
              }}
              style={{ flex: 1, width: '100%', minWidth: 0, border: 'none', borderBottom: '1px solid #9ca3af', borderRadius: 0, padding: '2px 0', fontSize: 11, color: '#202124', outline: 'none', backgroundColor: 'transparent' }}
            />
          </label>
        </div>
        <div style={{ minWidth: 0, backgroundColor: investIncome !== null && investIncome >= 0 ? '#fce8e6' : '#e6f4ea', borderRadius: 10, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, color: C.sub }}>理财收入</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: investIncome !== null && investIncome >= 0 ? C.red : C.green, fontVariantNumeric: 'tabular-nums' }}>
            {investIncome !== null ? `${investIncome >= 0 ? '+' : ''}¥${formatCurrency(investIncome)}` : '—'}
          </div>
          <div style={{ marginTop: 5, fontSize: 10, fontWeight: 600, color: C.sub, fontVariantNumeric: 'tabular-nums' }}>
            {investMonthly !== null ? `${investTotalForRate?.estimated ? '月≈' : '月'} ${(investMonthly * 100).toFixed(2)}% · 年化 ${(investAnnual! * 100).toFixed(1)}%` : '月 — · 年化 —'}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        {lowerFields.map(({ label, val, bg, fg, kind, hint, title }) => (
          <div key={label} title={title}>
            <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
              {label}
              {kind === 'auto' && <span style={{ fontSize: 10, color: C.sub }}>（账单自动）</span>}
              {kind === 'manual' && <span style={{ fontSize: 10, color: C.sub }}>（手填）</span>}
              {kind === 'sum' && <span style={{ fontSize: 10, color: C.sub }}>（持仓求和）</span>}
              {kind === 'stored' && <span style={{ fontSize: 10, color: C.sub }}>（历史总额）</span>}
              {kind === 'estimate' && <span style={{ fontSize: 10, color: C.orange }}>（前后估）</span>}
            </div>
            <div style={{ padding: kind === 'manual' ? '5px 10px' : '8px 10px', fontSize: 13, fontVariantNumeric: 'tabular-nums', borderRadius: 8, backgroundColor: bg, color: fg, minHeight: 20 }}>
              {kind === 'manual' ? (
                <AmountInput
                  aria-label="月末总资产"
                  value={totalAssets}
                  onChange={setTotalAssets}
                  placeholder="0.00"
                  style={{ width: '100%', border: 'none', borderBottom: '1.5px solid #fbbf24', borderRadius: 0, padding: '2px 0', fontSize: 13, fontVariantNumeric: 'tabular-nums', outline: 'none', backgroundColor: 'transparent', boxSizing: 'border-box', color: '#202124' }}
                />
              ) : val}
              {hint && <span style={{ marginLeft: 6, fontSize: 10, color: C.sub }}>{hint}</span>}
            </div>
          </div>
        ))}
      </div>

      {(() => {
        const pe = parseFloat(periodicLife) || 0;
        const vo = parseFloat(volatileLife) || 0;
        const co = parseFloat(consumption) || 0;
        const te = parseFloat(totalExpense) || 0;
        if (!periodicLife && !volatileLife && !consumption && !totalExpense) return null;
        const diff = Math.round((pe + vo + co - te) * 100) / 100;
        if (diff === 0) return null;
        return (
          <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 10, fontSize: 12, backgroundColor: '#fce8e6', color: '#c5221f', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>三项之和 − 总支出</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
              {diff > 0 ? '+' : ''}{formatCurrency(diff)}
            </span>
          </div>
        );
      })()}
    </>
  );
}

function InvestmentMonthlyReturn({ label, profit, marketValue }: { label: string; profit: number | null; marketValue: number }) {
  const monthlyProfit = profit !== null && Number.isFinite(profit) ? profit : null;
  const rate = monthlyProfit !== null && Number.isFinite(marketValue) && marketValue > 0
    ? monthlyProfit / marketValue
    : null;
  return (
    <div className="invest-position-group-monthly">
      <span aria-label={`${label}本月收益`} style={{ color: monthlyProfit === null ? C.sub : monthlyProfit >= 0 ? C.red : C.green }}>
        本月 {monthlyProfit === null ? '—' : formatSignedCurrency(monthlyProfit)}
      </span>
      <span aria-label={`${label}月收益率`} style={{ color: rate === null ? C.sub : rate >= 0 ? C.red : C.green }}>
        月收益率 {rate === null ? '—' : `${(rate * 100).toFixed(2)}%`}
      </span>
    </div>
  );
}

function HoldingsSection({ state }: { state: MonthFormState }) {
  const view = usePrefsStore((prefs) => prefs.investmentHoldingsView);
  return <>
    {view === 'alipay' ? <AlipayHoldingsSection items={state.positionItemsForSave} previousItems={state.previousPositionItems}
      records={state.allRecords} yearMonth={state.yearMonth} previousMonth={state.previousMonth}
      markets={state.marketsBySymbol} previousMarkets={state.previousMarketsBySymbol}
      onUpdate={state.updatePositionDraft} /> : <YimuHoldingsSection state={state} />}
  </>;
}

function YimuHoldingsSection({ state }: { state: MonthFormState }) {
  const {
    positionDraftGroups, updatePositionDraft, addPositionDraft, removePositionDraft,
    splitPositionAccount, movePositionDraft,
    positionSummary, positionMonthlyIncome, positionMonthlyProfitById, positionQuotes, positionQuoteErrors, isCurrentRecordMonth,
  } = state;
  const [activeStatus, setActiveStatus] = useState<InvestPositionStatus>('active');
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(() => new Set());
  const [expandedClearedGroupKeys, setExpandedClearedGroupKeys] = useState<Set<string>>(() => new Set());
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(null);
  const [cumulativeProfitInputs, setCumulativeProfitInputs] = useState<Record<string, string>>({});
  const [autoFocusCodeItemKey, setAutoFocusCodeItemKey] = useState<string | null>(null);
  const [splitSource, setSplitSource] = useState<{ groupKey: InvestPositionGroupKey; id: string } | null>(null);
  useEffect(() => {
    if (!expandedItemKey) return;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('[data-invest-position-expanded="true"]')) {
        setExpandedItemKey(null);
      }
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [expandedItemKey]);
  const holdingSections: { label?: string; keys: readonly InvestPositionGroupKey[] }[] = [
    ...(activeStatus !== 'active' ? [{ keys: ['account' as const] }] : []),
    ...INVESTMENT_GROUPS,
    ...(activeStatus !== 'active' && positionDraftGroups.aggregate.length > 0 ? [{ keys: ['aggregate' as const] }] : []),
  ];
  const signedAmount = (value: number) => `${value >= 0 ? '+' : '-'}¥${formatCurrency(value)}`;
  const positionMonthlyRate = positionMonthlyIncome !== null && positionSummary.totalMarketValueCny > 0
    ? positionMonthlyIncome / positionSummary.totalMarketValueCny
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="invest-holdings-totals">
        <div style={{ backgroundColor: '#f1f3f4' }}>
          <div style={{ fontSize: 10, color: C.sub }}>持有市值</div>
          <div className="invest-holdings-total-amount">¥{formatCurrency(positionSummary.totalMarketValueCny)}</div>
        </div>
        <div style={{ backgroundColor: positionMonthlyIncome === null ? '#f1f3f4' : positionMonthlyIncome >= 0 ? '#fce8e6' : '#e6f4ea' }}>
          <div style={{ fontSize: 10, color: C.sub }}>本月收益</div>
          <div className="invest-holdings-total-value-row" style={{ color: positionMonthlyIncome === null ? C.sub : positionMonthlyIncome >= 0 ? C.red : C.green }}>
            <span className="invest-holdings-total-amount">{positionMonthlyIncome === null ? '—' : signedAmount(positionMonthlyIncome)}</span>
            <span className="invest-holdings-total-rate" aria-label="本月收益率">
              {positionMonthlyRate === null ? '—' : `${(positionMonthlyRate * 100).toFixed(2)}%`}
            </span>
          </div>
        </div>
        <div style={{ backgroundColor: positionSummary.totalProfitCny >= 0 ? '#fce8e6' : '#e6f4ea' }}>
          <div style={{ fontSize: 10, color: C.sub }}>累计收益</div>
          <div className="invest-holdings-total-amount" style={{ color: positionSummary.totalProfitCny >= 0 ? C.red : C.green }}>{signedAmount(positionSummary.totalProfitCny)}</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', border: '1px solid #dadce0', borderRadius: 8, overflow: 'hidden' }}>
        {INVEST_POSITION_TAB_STATUSES.map((status) => {
          const meta = INVEST_POSITION_STATUS_META[status];
          const selected = activeStatus === status;
          return (
            <button key={status} type="button" aria-pressed={selected} onClick={() => setActiveStatus(status)} style={{ border: 'none', borderRight: status === 'active' ? '1px solid #dadce0' : 'none', padding: '7px 4px', backgroundColor: selected ? `${meta.color}18` : '#fff', color: selected ? meta.color : C.sub, fontSize: 12, fontWeight: selected ? 800 : 500, cursor: 'pointer' }}>
              {meta.label}
            </button>
          );
        })}
      </div>

      {holdingSections.map(({ label, keys }) => {
        const investmentKeys = keys.filter((key): key is InvestKey => key !== 'account' && key !== 'aggregate');
        const monthlyProfits = investmentKeys.map(state.getBreakdownMonthlyProfit).filter((profit): profit is number => profit !== null);
        const monthlyProfit = monthlyProfits.length > 0 ? roundCny(monthlyProfits.reduce((sum, profit) => sum + profit, 0)) : null;
        const marketValue = investmentKeys.reduce((sum, key) => sum + positionSummary.marketValueByCategory[key], 0);
        return (
          <section key={label ?? keys[0]} className="invest-holdings-group" aria-label={label ? `${label}类持仓` : undefined}>
            {label && (
              <div className="invest-holdings-group-header">
                <h3>{label}</h3>
                <InvestmentMonthlyReturn label={label} profit={monthlyProfit} marketValue={marketValue} />
              </div>
            )}
            {keys.map((groupKey) => {
              const items = positionDraftGroups[groupKey].filter((item) => activeStatus === 'active'
                ? item.status === 'active'
                : item.status !== 'active');
              const itemSections: { cleared: boolean; items: InvestPositionDraft[] }[] = [
                { cleared: false, items: [] },
                { cleared: true, items: [] },
              ];
              for (const item of items) {
                const cleared = activeStatus !== 'active' && positionSummary.metricsById[item.id]?.marketValueCny === 0;
                itemSections[cleared ? 1 : 0].items.push(item);
              }
              const groupStateKey = `${activeStatus}:${groupKey}`;
              const groupExpanded = expandedGroupKeys.has(groupStateKey);
              const clearedGroupExpanded = expandedClearedGroupKeys.has(groupStateKey);
              const groupLabel = groupKey === 'account' ? '历史账户' : groupKey === 'aggregate' ? '待归类账户' : investMeta[groupKey].label;
              const groupColor = groupKey === 'account' || groupKey === 'aggregate' ? C.sub : investMeta[groupKey].color;
              const groupMonthlyProfit = groupKey === 'account' || groupKey === 'aggregate'
                ? null
                : state.getBreakdownMonthlyProfit(groupKey);
              const displayedGroupMarketValue = items.reduce(
                (sum, item) => sum + (positionSummary.metricsById[item.id]?.marketValueCny ?? 0),
                0,
              );
              const combinedGroupMarketValue = groupKey === 'account' || groupKey === 'aggregate'
                ? displayedGroupMarketValue
                : positionSummary.marketValueByCategory[groupKey];
              return (
                <div key={groupKey} style={{ border: '1px solid #e8eaed', borderRadius: 10, padding: '8px', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: groupExpanded && items.length > 0 ? 7 : 0 }}>
                    <button
                      type="button"
                      className="invest-position-group-toggle"
                      aria-expanded={groupExpanded}
                      aria-label={`${groupExpanded ? '收起' : '展开'}${groupLabel}`}
                      onClick={() => setExpandedGroupKeys((current) => {
                        const next = new Set(current);
                        if (next.has(groupStateKey)) next.delete(groupStateKey);
                        else next.add(groupStateKey);
                        return next;
                      })}
                      style={{ flex: 1, minWidth: 0, border: 'none', padding: 0, backgroundColor: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                    >
                      <div className="invest-position-group-heading">
                        <div className="invest-position-group-title" style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 800, whiteSpace: 'nowrap' }}>
                          <span style={{ color: C.sub, fontSize: 9 }}>{groupExpanded ? '▼' : '▶'}</span>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: groupColor }} />
                          {groupLabel}
                        </div>
                        {groupKey !== 'account' && groupKey !== 'aggregate' && (
                          <>
                            <span className="invest-position-group-market">¥{formatCurrency(displayedGroupMarketValue)}</span>
                            <InvestmentMonthlyReturn label={groupLabel} profit={groupMonthlyProfit} marketValue={combinedGroupMarketValue} />
                          </>
                        )}
                      </div>
                    </button>
                    {groupKey !== 'aggregate' && <button type="button" className="invest-position-group-add" aria-label={`新增${groupLabel}${groupKey === 'account' ? '' : '股票/基金'}`} title={groupKey === 'account' ? '新增账户' : '新增股票/基金'} onClick={() => {
                      const id = addPositionDraft(groupKey, activeStatus);
                      setExpandedGroupKeys((current) => new Set(current).add(groupStateKey));
                      if (activeStatus !== 'active') {
                        setExpandedClearedGroupKeys((current) => new Set(current).add(groupStateKey));
                      }
                      if (groupKey !== 'account') {
                        const itemKey = `${groupKey}:${id}`;
                        setExpandedItemKey(itemKey);
                        setAutoFocusCodeItemKey(itemKey);
                        setSplitSource(null);
                      }
                    }} style={{ flexShrink: 0, whiteSpace: 'nowrap', border: 'none', borderRadius: 7, backgroundColor: `${INVEST_POSITION_STATUS_META[activeStatus].color}16`, color: INVEST_POSITION_STATUS_META[activeStatus].color, padding: '4px 8px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
                      +<span className="invest-position-group-add-label"> {groupKey === 'account' ? '账户' : '股票/基金'}</span>
                    </button>}
                  </div>

                  {groupExpanded && itemSections.map(({ cleared, items: sectionItems }) => sectionItems.length > 0 ? (
                    <div key={cleared ? 'cleared' : 'holding'}>
                      {cleared && (
                        <button
                          type="button"
                          aria-expanded={clearedGroupExpanded}
                          aria-label={`${clearedGroupExpanded ? '收起' : '展开'}${groupLabel}已清仓项目`}
                          onClick={() => {
                            setExpandedClearedGroupKeys((current) => {
                              const next = new Set(current);
                              if (next.has(groupStateKey)) next.delete(groupStateKey);
                              else next.add(groupStateKey);
                              return next;
                            });
                            setExpandedItemKey(null);
                            setSplitSource(null);
                          }}
                          style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', border: 'none', borderTop: '1px solid #f1f3f4', padding: '8px 0 4px', backgroundColor: 'transparent', color: C.sub, fontSize: 11, cursor: 'pointer', textAlign: 'left' }}
                        >
                          <span aria-hidden="true" style={{ fontSize: 9 }}>{clearedGroupExpanded ? '▼' : '▶'}</span>
                          已清仓（{sectionItems.length}）
                        </button>
                      )}
                      {(!cleared || clearedGroupExpanded) && sectionItems.map((item) => {
                        const metric = positionSummary.metricsById[item.id];
                        const isEmptyPastHolding = activeStatus !== 'active' && metric?.marketValueCny === 0;
                        const summaryBackground = isEmptyPastHolding ? '#e8eaed' : '#f8f9fa';
                        const symbol = item.symbol.trim().toUpperCase();
                        const quoteKey = investPositionQuoteKey(item);
                        const quote = symbol ? positionQuotes[quoteKey] : undefined;
                        const quoteFailed = symbol ? positionQuoteErrors.has(quoteKey) : false;
                        const needsSelection = Boolean(symbol && !item.quoteSource && /^\d{6}$/.test(symbol));
                        const priceDisplay = metric?.price !== undefined
                          ? `${metric.price.toFixed(item.quoteSource === 'eastmoney-fund' ? 4 : 2)} ${metric.currency ?? ''}`
                          : null;
                        const positionCurrency = (item.quoteCurrency || metric?.currency || defaultInvestQuoteCurrency(groupKey) || '').toUpperCase();
                        const profitCurrency = isInvestPositionSummaryItem(item)
                          ? 'CNY'
                          : (positionCurrency || item.historicalProfitCurrency || 'CNY').toUpperCase();
                        const costPriceLabel = positionCurrency ? `成本价（${positionCurrency}）` : '成本价';
                        const cumulativeProfitLabel = `累计收益${currencyMark(profitCurrency)}`;
                        const nativeFxRate = ['CNY', 'CNH'].includes(profitCurrency)
                          ? 1
                          : (metric?.fxRateToCny
                            || inferInvestPositionFxRateToCny(item, profitCurrency)
                            || metric?.profitFxRateToCny
                            || 1);
                        const nativeMarketValue = (metric?.marketValueCny ?? 0) / (metric?.fxRateToCny || nativeFxRate);
                        const nativeHoldingProfit = (metric?.holdingProfitCny ?? 0) / nativeFxRate;
                        const nativeTotalProfit = (metric?.totalProfitCny ?? 0) / nativeFxRate;
                        const canSplitAccount = canSplitInvestPositionAccount(item);
                        const splitOpen = splitSource?.id === item.id && splitSource.groupKey === groupKey;
                        const itemKey = `${groupKey}:${item.id}`;
                        const isExpanded = expandedItemKey === itemKey;
                        const cumulativeProfitInput = cumulativeProfitInputs[itemKey] ?? String(roundCny(nativeTotalProfit));
                        const monthlyProfit = positionMonthlyProfitById[item.id] ?? null;
                        const showMonthlyProfit = Boolean(
                          symbol
                          && item.status !== 'closed'
                          && numberOrUndefined(item.shares) !== 0
                          && (metric?.marketValueCny ?? 0) > 0,
                        );
                        const profitInputColor = Number(cumulativeProfitInput) > 0
                          ? C.red
                          : Number(cumulativeProfitInput) < 0
                            ? C.green
                            : C.sub;
                        return (
                          <div key={item.id} data-invest-position-key={itemKey} data-invest-position-expanded={isExpanded ? 'true' : undefined} style={{ borderTop: '1px solid #f1f3f4', padding: '8px 0 2px', backgroundColor: isEmptyPastHolding ? '#f1f3f4' : undefined, borderRadius: isEmptyPastHolding ? 8 : undefined }}>
                            <div className={`invest-position-header${!isExpanded ? ' invest-position-header--collapsed' : groupKey !== 'account' ? ' invest-position-header--with-code' : ''}`}>
                              <input
                                className="invest-position-name"
                                aria-label={`${groupLabel}名称`}
                                value={item.name}
                                readOnly={!isExpanded}
                                title={isExpanded ? '编辑名称' : '展开详情'}
                                onClick={() => {
                                  if (!isExpanded) {
                                    setExpandedItemKey(itemKey);
                                    setSplitSource(null);
                                  }
                                }}
                                onChange={(event) => updatePositionDraft(groupKey, item.id, { name: event.target.value })}
                                onKeyDown={(event) => { if (event.key === 'Escape') setExpandedItemKey(null); }}
                                style={{ minWidth: 0, width: '100%', border: 'none', borderBottom: isExpanded ? '1px solid #dadce0' : '1px solid transparent', outline: 'none', fontWeight: 800, backgroundColor: 'transparent', cursor: isExpanded ? 'text' : 'pointer' }}
                              />
                              {isExpanded && groupKey !== 'account' && (
                                <div className="invest-position-code">
                                  <InvestInstrumentPicker
                                    hideName
                                    autoFocusSymbol={autoFocusCodeItemKey === itemKey}
                                    onSymbolFocus={() => setAutoFocusCodeItemKey(null)}
                                    name={item.name}
                                    symbol={item.symbol}
                                    quoteSource={item.quoteSource}
                                    ariaLabel={groupLabel}
                                    onChange={(patch) => updatePositionDraft(groupKey, item.id, {
                                      ...patch,
                                      historicalProfitCurrency: patch.quoteCurrency || item.historicalProfitCurrency,
                                    })}
                                  />
                                </div>
                              )}
                              {!isExpanded && (
                                <div className="invest-position-summary" style={{ gridTemplateColumns: showMonthlyProfit ? 'repeat(3, minmax(0, 1fr))' : 'repeat(2, minmax(0, 1fr))', backgroundColor: summaryBackground, color: C.sub }}>
                                  <span>持有金额<br /><b style={{ color: '#202124' }}>{formatNativeCurrency(nativeMarketValue, positionCurrency || 'CNY')}</b></span>
                                  <span>累计收益<br /><b style={{ color: nativeTotalProfit >= 0 ? C.red : C.green }}>{formatNativeCurrency(nativeTotalProfit, profitCurrency, true)}</b></span>
                                  {showMonthlyProfit && <span>本月收益<br /><b style={{ color: monthlyProfit === null ? C.sub : monthlyProfit.value >= 0 ? C.red : C.green }}>{monthlyProfit === null ? '—' : formatNativeCurrency(monthlyProfit.value, monthlyProfit.currency, true)}</b></span>}
                                </div>
                              )}
                              <div className="invest-position-actions">
                                {canSplitAccount ? (
                                  <button type="button" aria-label={splitOpen ? '收起分出个股' : '分出个股'} title={splitOpen ? '收起' : '分出个股'} aria-pressed={splitOpen} onClick={() => {
                                    setExpandedItemKey(null);
                                    setSplitSource(splitOpen ? null : { groupKey, id: item.id });
                                  }} style={{ width: 26, height: 26, border: 'none', borderRadius: 6, backgroundColor: '#e8f0fe', color: C.blue, fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>
                                    ｜
                                  </button>
                                ) : null}
                                <InvestPositionMoveMenu
                                  name={item.name}
                                  status={item.status}
                                  currentGroup={groupKey}
                                  onToggleStatus={(status) => {
                                    movePositionDraft(groupKey, item.id, groupKey as InvestKey, status);
                                    setExpandedItemKey(null);
                                    setSplitSource(null);
                                  }}
                                  onMoveCategory={(targetGroupKey) => {
                                    movePositionDraft(groupKey, item.id, targetGroupKey);
                                    setExpandedItemKey(null);
                                    setSplitSource(null);
                                  }}
                                />
                                <button type="button" onClick={() => { if (window.confirm(`删除“${item.name}”？`)) { removePositionDraft(groupKey, item.id); setExpandedItemKey(null); } }} aria-label={`删除${item.name}`} style={{ width: 24, height: 24, border: 'none', borderRadius: 6, backgroundColor: '#fce8e6', color: C.red, cursor: 'pointer', fontWeight: 800 }}>×</button>
                              </div>
                            </div>

                            {item.pendingBuys?.some((pending) => !pending.booking) && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 5 }}>
                                {item.pendingBuys?.filter((pending) => !pending.booking).map((pending) => (
                                  <PendingInvestmentBuyRow key={pending.id} pending={pending} quoteSource={item.quoteSource} />
                                ))}
                              </div>
                            )}

                            {isExpanded && (
                              <div style={{ marginTop: 8 }}>
                                <label style={{ display: 'grid', gridTemplateColumns: '1fr minmax(90px, 130px)', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 10, color: C.sub }}>
                                  <span>分类</span>
                                  <select
                                    aria-label={`${item.name}分类`}
                                    value={groupKey}
                                    onChange={(event) => {
                                      const targetGroupKey = event.target.value as InvestKey;
                                      movePositionDraft(groupKey, item.id, targetGroupKey);
                                      setExpandedGroupKeys((current) => new Set(current).add(`${activeStatus}:${targetGroupKey}`));
                                      setExpandedItemKey(`${targetGroupKey}:${item.id}`);
                                      setSplitSource(null);
                                    }}
                                    style={{ width: '100%', border: '1px solid #dadce0', borderRadius: 6, padding: '4px 6px', fontSize: 11, color: C.sub, backgroundColor: '#fff', cursor: 'pointer' }}
                                  >
                                    {(groupKey === 'account' || groupKey === 'aggregate') && <option value={groupKey} disabled>{groupLabel}</option>}
                                    {INVESTMENT_GROUPS.map((group) => (
                                      <optgroup key={group.label} label={group.label}>
                                        {group.keys.map((key) => <option key={key} value={key}>{investMeta[key].label}</option>)}
                                      </optgroup>
                                    ))}
                                  </select>
                                </label>
                                {groupKey === 'account' ? (
                                  <label style={{ display: 'grid', gridTemplateColumns: '1fr minmax(90px, 130px)', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 10, color: C.sub }}>
                                    <span>累计收益</span>
                                    <AmountInput value={item.historicalProfitCny} onChange={(value) => updatePositionDraft(groupKey, item.id, { historicalProfitCny: value })} style={{ width: '100%', border: 'none', borderBottom: `1px solid ${profitInputColor}`, outline: 'none', textAlign: 'right', color: profitInputColor, fontSize: 12, fontWeight: 700, backgroundColor: 'transparent' }} />
                                  </label>
                                ) : (
                                  <>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 7, marginTop: 8 }}>
                                      {([
                                        ['份额', 'shares'],
                                        [costPriceLabel, 'costPrice'],
                                        [cumulativeProfitLabel, 'historicalProfitCny'],
                                      ] as const).map(([label, field]) => (
                                        <label key={field} style={{ minWidth: 0, fontSize: 10, color: C.sub }}>
                                          <span>{label}</span>
                                          <AmountInput
                                            decimalPlaces={field === 'costPrice' || field === 'shares' ? 4 : undefined}
                                            value={field === 'historicalProfitCny' ? cumulativeProfitInput : item[field]}
                                            onChange={(value) => {
                                              if (field !== 'historicalProfitCny') {
                                                updatePositionDraft(groupKey, item.id, { [field]: value });
                                                return;
                                              }
                                              setCumulativeProfitInputs((current) => ({ ...current, [itemKey]: value }));
                                              const totalProfit = numberOrUndefined(value);
                                              if (totalProfit === undefined) return;
                                              updatePositionDraft(groupKey, item.id, {
                                                historicalProfitCny: String(roundCny(totalProfit - nativeHoldingProfit)),
                                                historicalProfitCurrency: profitCurrency,
                                                profitInputMode: 'historical',
                                              });
                                            }}
                                            onBlur={() => {
                                              if (field !== 'historicalProfitCny') return;
                                              setCumulativeProfitInputs((current) => {
                                                const next = { ...current };
                                                delete next[itemKey];
                                                return next;
                                              });
                                            }}
                                            style={{ width: '100%', border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', textAlign: 'right', fontSize: 11, fontWeight: 700, color: field === 'historicalProfitCny' ? profitInputColor : '#202124', backgroundColor: 'transparent', boxSizing: 'border-box' }}
                                          />
                                        </label>
                                      ))}
                                    </div>
                                    {quoteFailed && (
                                      <label style={{ display: 'grid', gridTemplateColumns: '1fr minmax(90px, 130px)', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 10, color: C.sub }}>
                                        <span>手填{item.quoteSource === 'eastmoney-fund' ? '净值' : '现价'}（{positionCurrency || 'CNY'}）</span>
                                        <AmountInput decimalPlaces={4} value={item.lastPrice} onChange={(value) => updatePositionDraft(groupKey, item.id, { lastPrice: value })} style={{ width: '100%', border: 'none', borderBottom: `1px solid ${C.orange}`, outline: 'none', textAlign: 'right', color: C.orange, fontSize: 11, fontWeight: 700, backgroundColor: 'transparent' }} />
                                      </label>
                                    )}
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 4, marginTop: 8, padding: '6px', borderRadius: 7, backgroundColor: summaryBackground, fontSize: 9, color: C.sub }}>
                                      <span>{item.quoteSource === 'eastmoney-fund' ? '净值' : '现价'}<br /><b style={{ color: metric?.live ? C.blue : C.sub }}>{priceDisplay ?? (needsSelection ? '请选择' : quoteFailed ? '失败' : symbol && isCurrentRecordMonth ? '获取中' : '—')}</b></span>
                                      <span>市值<br /><b style={{ color: '#202124' }}>{formatNativeCurrency(nativeMarketValue, positionCurrency || 'CNY')}</b></span>
                                      <span>持有收益<br /><b style={{ color: nativeHoldingProfit >= 0 ? C.red : C.green }}>{formatNativeCurrency(nativeHoldingProfit, profitCurrency, true)}</b></span>
                                      <span>累计收益<br /><b style={{ color: nativeTotalProfit >= 0 ? C.red : C.green }}>{formatNativeCurrency(nativeTotalProfit, profitCurrency, true)}</b></span>
                                    </div>
                                    {quote?.regularMarketTime && <div style={{ marginTop: 4, textAlign: 'right', fontSize: 9, color: C.sub }}>{quote.regularMarketTime.slice(0, 10)}</div>}
                                  </>
                                )}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                                  <button type="button" onClick={() => setExpandedItemKey(null)} style={{ border: 'none', padding: 0, backgroundColor: 'transparent', color: C.sub, fontSize: 9, cursor: 'pointer' }}>收起</button>
                                </div>
                              </div>
                            )}
                            {splitOpen && canSplitAccount && (
                              <PositionSplitPanel
                                key={`${groupKey}:${item.id}`}
                                sourceGroupKey={groupKey}
                                source={item}
                                sourceMarketValueCny={metric?.marketValueCny ?? 0}
                                isCurrentRecordMonth={isCurrentRecordMonth}
                                onClose={() => setSplitSource(null)}
                                onConfirm={(input) => {
                                  splitPositionAccount(input);
                                  setSplitSource(null);
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null)}
                </div>
              );
            })}

          </section>
        );
      })}

    </div>
  );
}

type PositionSplitDraft = {
  name: string;
  symbol: string;
  quoteSource?: InvestQuoteSource;
  quoteCurrency?: string;
  shares: string;
  costPrice: string;
  manualMarketValueCny: string;
  totalProfitCny: string;
};

type PositionSplitPanelProps = {
  sourceGroupKey: InvestPositionGroupKey;
  source: InvestPositionDraft;
  sourceMarketValueCny: number;
  isCurrentRecordMonth: boolean;
  onClose: () => void;
  onConfirm: (input: PositionSplitInput) => void;
};

function PositionSplitPanel({
  sourceGroupKey,
  source,
  sourceMarketValueCny,
  isCurrentRecordMonth,
  onClose,
  onConfirm,
}: PositionSplitPanelProps) {
  const [splitDraft, setSplitDraft] = useState<PositionSplitDraft>(() => ({
    name: '',
    symbol: '',
    shares: '',
    costPrice: '',
    manualMarketValueCny: '',
    totalProfitCny: '',
  }));
  const previewGroupKey = INVEST_POSITION_KEYS.includes(sourceGroupKey as InvestKey)
    ? sourceGroupKey as InvestKey
    : 'us';
  const previewItems = useMemo<InvestPositionItems>(() => {
    return {
      [previewGroupKey]: [{
        id: 'aggregate-split-preview',
        name: splitDraft.name,
        symbol: splitDraft.symbol,
        quoteSource: splitDraft.quoteSource,
        quoteCurrency: splitDraft.quoteCurrency,
        status: source.status,
        shares: numberOrUndefined(splitDraft.shares),
        costPrice: numberOrUndefined(splitDraft.costPrice),
        historicalProfitCny: 0,
        marketValueCny: numberOrUndefined(splitDraft.manualMarketValueCny),
        holdingProfitCny: 0,
      }],
    };
  }, [previewGroupKey, source.status, splitDraft]);
  const { quoteErrors, marketsBySymbol } = useInvestPositionMarkets(previewItems, isCurrentRecordMonth, null);
  const previewSummary = useMemo(
    () => summarizeInvestPositionItems(previewItems, marketsBySymbol),
    [marketsBySymbol, previewItems],
  );
  const previewMetric = previewSummary.metricsById['aggregate-split-preview'];
  const previewCurrency = (splitDraft.quoteCurrency || previewMetric?.currency || defaultInvestQuoteCurrency(previewGroupKey) || '').toUpperCase();
  const splitCostPriceLabel = previewCurrency ? `成本价（${previewCurrency}）` : '成本价';
  const previewQuoteKey = investPositionQuoteKey(splitDraft);
  const quoteFailed = Boolean(previewQuoteKey && quoteErrors.has(previewQuoteKey));
  const isClosedTarget = source.status === 'closed';
  const shares = numberOrUndefined(splitDraft.shares);
  const hasLiveAmount = Boolean(!isClosedTarget && previewMetric?.live && shares && shares > 0);
  const effectiveMarketValue = isClosedTarget
    ? 0
    : hasLiveAmount
      ? previewMetric.marketValueCny
      : numberOrUndefined(splitDraft.manualMarketValueCny) ?? 0;
  const holdingProfitAtSplit = isClosedTarget ? 0 : previewMetric?.holdingProfitCny ?? 0;
  const profitCurrency = (splitDraft.quoteCurrency || previewMetric?.profitCurrency || source.historicalProfitCurrency || defaultInvestQuoteCurrency(previewGroupKey) || 'CNY').toUpperCase();
  const profitFxRateToCny = previewMetric?.profitFxRateToCny || source.lastFxRateToCny || 1;
  const holdingProfitAtSplitOriginal = holdingProfitAtSplit / profitFxRateToCny;
  const effectiveTotalProfitOriginal = numberOrUndefined(splitDraft.totalProfitCny) ?? holdingProfitAtSplitOriginal;
  const amountTooLarge = effectiveMarketValue > sourceMarketValueCny + 0.01;
  const canSplit = Boolean(
    splitDraft.name.trim()
    && (effectiveMarketValue > 0 || effectiveTotalProfitOriginal !== 0)
    && !amountTooLarge,
  );
  const signedProfit = (value: number) => formatNativeCurrency(value, profitCurrency, true);

  return (
    <div style={{ marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: '#f8f9fa' }}>
                <InvestInstrumentPicker
                  name={splitDraft.name}
                  symbol={splitDraft.symbol}
                  quoteSource={splitDraft.quoteSource}
                  ariaLabel="分出标的"
                  onChange={(patch) => setSplitDraft((current) => ({ ...current, ...patch }))}
                />
                {!isClosedTarget && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7, marginTop: 8 }}>
                  {([
                    ['份额', 'shares'],
                    [splitCostPriceLabel, 'costPrice'],
                  ] as const).map(([label, field]) => (
                    <label key={field} style={{ minWidth: 0, fontSize: 10, color: C.sub }}>
                      <span>{label}</span>
                      <AmountInput decimalPlaces={4} value={splitDraft[field]} onChange={(value) => setSplitDraft({ ...splitDraft, [field]: value })} style={{ width: '100%', border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', textAlign: 'right', fontSize: 11, fontWeight: 700, backgroundColor: 'transparent', boxSizing: 'border-box' }} />
                    </label>
                  ))}
                  <label style={{ minWidth: 0, fontSize: 10, color: C.sub }}>
                    <span>分出金额</span>
                    <AmountInput
                      value={hasLiveAmount ? String(roundCny(effectiveMarketValue)) : splitDraft.manualMarketValueCny}
                      onChange={(value) => setSplitDraft({ ...splitDraft, manualMarketValueCny: value })}
                      disabled={hasLiveAmount}
                      placeholder={quoteFailed ? '行情失败' : '0'}
                      style={{ width: '100%', border: 'none', borderBottom: `1px solid ${hasLiveAmount ? C.green : C.blue}`, outline: 'none', textAlign: 'right', fontSize: 11, fontWeight: 700, color: hasLiveAmount ? C.green : '#202124', backgroundColor: 'transparent', boxSizing: 'border-box' }}
                    />
                  </label>
                  <label style={{ minWidth: 0, fontSize: 10, color: C.sub }}>
                    <span>分出累计收益{currencyMark(profitCurrency)}</span>
                    <AmountInput value={splitDraft.totalProfitCny} onChange={(value) => setSplitDraft({ ...splitDraft, totalProfitCny: value })} placeholder={String(roundCny(holdingProfitAtSplitOriginal))} style={{ width: '100%', border: 'none', borderBottom: `1px solid ${C.orange}`, outline: 'none', textAlign: 'right', fontSize: 11, fontWeight: 700, color: C.orange, backgroundColor: 'transparent', boxSizing: 'border-box' }} />
                  </label>
                </div>}
                {isClosedTarget && <div style={{ marginTop: 8 }}>
                  <label style={{ minWidth: 0, fontSize: 10, color: C.sub }}>
                    <span>分出累计收益{currencyMark(profitCurrency)}</span>
                    <AmountInput value={splitDraft.totalProfitCny} onChange={(value) => setSplitDraft({ ...splitDraft, totalProfitCny: value })} placeholder={String(roundCny(holdingProfitAtSplitOriginal))} style={{ width: '100%', border: 'none', borderBottom: `1px solid ${C.orange}`, outline: 'none', textAlign: 'right', fontSize: 11, fontWeight: 700, color: C.orange, backgroundColor: 'transparent', boxSizing: 'border-box' }} />
                  </label>
                </div>}
                {!isClosedTarget && splitDraft.symbol.trim() && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 5, marginTop: 8, padding: 6, borderRadius: 7, backgroundColor: '#fff', fontSize: 9, color: C.sub }}>
                  <span>{splitDraft.quoteSource === 'eastmoney-fund' ? '净值' : '现价'}<br /><b style={{ color: previewMetric?.live ? C.blue : C.sub }}>{previewMetric?.price !== undefined ? previewMetric.price.toFixed(splitDraft.quoteSource === 'eastmoney-fund' ? 4 : 2) : quoteFailed ? '失败' : splitDraft.symbol ? '获取中' : '—'}</b></span>
                  <span>持有收益<br /><b style={{ color: holdingProfitAtSplitOriginal >= 0 ? C.red : C.green }}>{signedProfit(holdingProfitAtSplitOriginal)}</b></span>
                  <span>累计收益<br /><b style={{ color: effectiveTotalProfitOriginal >= 0 ? C.red : C.green }}>{signedProfit(effectiveTotalProfitOriginal)}</b></span>
                </div>}
                {amountTooLarge && <div role="alert" style={{ marginTop: 6, fontSize: 10, color: C.red }}>分出金额超过账户金额</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                  <button type="button" onClick={onClose} style={{ border: '1px solid #dadce0', borderRadius: 6, padding: '5px 9px', backgroundColor: '#fff', color: C.sub, fontSize: 10, cursor: 'pointer' }}>取消</button>
                  <button type="button" disabled={!canSplit} onClick={() => {
                    onConfirm({
                      sourceGroupKey,
                      sourceId: source.id,
                      name: splitDraft.name,
                      symbol: splitDraft.symbol,
                      quoteSource: splitDraft.quoteSource,
                      quoteCurrency: splitDraft.quoteCurrency,
                      shares: numberOrUndefined(splitDraft.shares),
                      costPrice: numberOrUndefined(splitDraft.costPrice),
                      splitMarketValueCny: effectiveMarketValue,
                      splitTotalProfitOriginal: effectiveTotalProfitOriginal,
                      holdingProfitAtSplitCny: holdingProfitAtSplit,
                      profitCurrency,
                      profitFxRateToCny,
                    });
                  }} style={{ border: 'none', borderRadius: 6, padding: '5px 9px', backgroundColor: canSplit ? C.blue : '#dadce0', color: '#fff', fontSize: 10, fontWeight: 800, cursor: canSplit ? 'pointer' : 'default' }}>确定</button>
                </div>
    </div>
  );
}

function MajorExpensesSection({ state }: { state: MonthFormState }) {
  const { majorExpenses, updateMajorExpenseName, majorExpensesNote, setMajorExpensesNote, fieldStyle } = state;
  return (
    <div style={{ marginBottom: 12 }}>
      {(() => {
        const amounts = majorExpenses.map((x) => x.amount || 0);
        const maxAmt = Math.max(0, ...amounts);
        const minAmt = Math.min(...amounts.filter((a) => a > 0), maxAmt);
        return majorExpenses.map((e, i) => {
        const amt = e.amount || 0;
        const hasRange = maxAmt > minAmt && amt > 0;
        const ratio = hasRange ? (amt - minAmt) / (maxAmt - minAmt) : (amt > 0 ? 1 : 0);
        const hue = 120 - ratio * 120;
        const amtBg = amt > 0 ? `hsl(${hue}, 72%, 92%)` : '#fffbeb';
        const amtBorder = amt > 0 ? `hsl(${hue}, 65%, 55%)` : '#fbbf24';
        const amtColor = amt > 0 ? `hsl(${hue}, 70%, 30%)` : '#202124';
        const typeColor = e.type === '生活' ? C.blue : C.purple;
        return (
        <div key={e.sourceName} style={{ display: 'grid', gridTemplateColumns: '46px minmax(0, 1fr) 76px', gap: 5, marginBottom: 6, alignItems: 'center' }}>
          <span style={{ border: `1.5px solid ${typeColor}`, borderRadius: 6, padding: '6px 2px', fontSize: 11, color: typeColor, fontWeight: 600, backgroundColor: `${typeColor}12`, textAlign: 'center' }}>{e.type}</span>
          <input
            type="text"
            aria-label={`大额支出名称 ${i + 1}`}
            title="点击编辑名称"
            value={e.name}
            placeholder={e.sourceName}
            onChange={(event) => updateMajorExpenseName(e.sourceName, event.target.value)}
            onBlur={() => updateMajorExpenseName(e.sourceName, e.name.trim() || e.sourceName)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
            }}
            style={{ width: '100%', minWidth: 0, border: 'none', backgroundColor: 'transparent', fontSize: 13, padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          />
          <span style={{ ...fieldStyle, padding: '6px 8px', backgroundColor: amtBg, borderColor: amtBorder, color: amtColor, fontWeight: 600, textAlign: 'right', display: 'block' }}>{amt ? Math.round(amt) : ''}</span>
        </div>
        );
        });
      })()}
      <textarea
        value={majorExpensesNote}
        onChange={(ev) => setMajorExpensesNote(ev.target.value)}
        placeholder="备注（可选）"
        rows={1}
        style={{
          ...fieldStyle,
          width: '100%',
          marginTop: 6,
          padding: '6px 8px',
          fontSize: 12,
          resize: 'none',
          overflow: 'hidden',
          minHeight: 30,
          boxSizing: 'border-box',
          fontFamily: 'inherit',
        }}
        onInput={(ev) => {
          const el = ev.currentTarget;
          el.style.height = 'auto';
          el.style.height = el.scrollHeight + 'px';
        }}
        ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }}
      />
    </div>
  );
}

function MonthFormCards(props: MonthFormProps & { subtitle?: string }) {
  const state = useMonthForm(props);
  const majorTotal = state.majorExpenses.reduce((s, e) => s + Math.round(e.amount || 0), 0);
  const lifeTotal = state.majorExpenses.reduce((s, e) => s + (e.type === '生活' ? Math.round(e.amount || 0) : 0), 0);
  const consumeTotal = state.majorExpenses.reduce((s, e) => s + (e.type === '消费' ? Math.round(e.amount || 0) : 0), 0);
  const fmtK = (v: number) => {
    const k = Math.round(v / 100) / 10;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
  };
  const majorSubtitle = majorTotal > 0
    ? `¥${fmtK(majorTotal)} (生活${fmtK(lifeTotal)}, 消费${fmtK(consumeTotal)})`
    : undefined;
  return (
    <>
      <Card title={`${props.yearMonth} 数据`} subtitle={props.subtitle}>
        <MonthDataSection state={state} />
      </Card>
      <Card title="大额支出" subtitle={majorSubtitle}>
        <MajorExpensesSection state={state} />
      </Card>
      <Card title="理财各品类持仓 & 累计收益" headerAction={<HoldingsViewToggle />}>
        <HoldingsSection state={state} />
      </Card>
    </>
  );
}

function PendingManualPanel({ entries, onSetScope, onClose }: {
  entries: { date: string; id: string; item: BillExpenseItem }[];
  onSetScope: (date: string, id: string, scope: ConfirmedExpenseAssignment) => void;
  onClose: () => void;
}) {
  const total = entries.reduce((s, e) => s + e.item.amount, 0);
  const grouped = useMemo(() => {
    const map = new Map<string, { date: string; id: string; item: BillExpenseItem }[]>();
    for (const e of entries) {
      const arr = map.get(e.date) ?? [];
      arr.push(e);
      map.set(e.date, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);
  return (
    <Card
      title="待手动分类"
      subtitle={entries.length === 0
        ? '本月没有未规则覆盖的待分类账单'
        : `共 ${entries.length} 条 · ¥${formatCurrency(total)}`}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button
          onClick={onClose}
          style={{ fontSize: 12, color: C.sub, border: 'none', background: 'none', cursor: 'pointer' }}
        >✕ 收起</button>
      </div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 13, color: C.sub, textAlign: 'center', padding: '12px 0' }}>
          全部账单都已被「本地/共享分类规则」覆盖，或已手动确认过。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {grouped.map(([date, rows]) => {
            const daySum = rows.reduce((s, r) => s + r.item.amount, 0);
            return (
              <div key={date}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, color: C.sub, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, color: '#202124' }}>{date}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{rows.length} 条 · ¥{formatCurrency(daySum)}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {rows.map(({ date: d, id, item }) => (
                    <div
                      key={`${d}|${id}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
                        backgroundColor: '#fffaf0', border: '1px solid #fdba74', fontSize: 13,
                      }}
                    >
                      <div style={{ display: 'inline-flex', borderRadius: 6, border: `1px solid ${C.border}`, overflow: 'hidden', flexShrink: 0 }}>
                        {((item.tags.split(',').map((tag) => tag.trim()).includes('消费')
                          ? ['local', 'travel', 'shared']
                          : ['local', 'shared']) as ConfirmedExpenseAssignment[]).map((p, index) => {
                          const activeBg = p === 'local' ? C.blue : p === 'travel' ? tagMeta.travel.color : C.orange;
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => onSetScope(d, id, p)}
                              style={{
                                padding: '3px 10px', fontSize: 11, fontWeight: 600, lineHeight: 1.3,
                                border: 'none', borderLeft: index > 0 ? `1px solid ${C.border}` : 'none',
                                backgroundColor: '#fff', color: activeBg, cursor: 'pointer',
                              }}
                            >{p === 'local' ? '本地' : p === 'travel' ? '游' : '共享'}</button>
                          );
                        })}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, color: '#202124', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.note || item.subcategory || item.category || '—'}
                        </div>
                        <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
                          {item.category}{item.subcategory ? ` · ${item.subcategory}` : ''}{item.tags ? ` · ${item.tags}` : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#202124', flexShrink: 0 }}>¥{formatCurrency(item.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function DayDetailPanel({ date, items, selection, onSetScope, onMarkZero, onClear, resolveOverride }: {
  date: string;
  items: BillExpenseItem[];
  selection: ConfirmedExpenseSelection;
  onSetScope: (id: string, scope: ConfirmedExpenseAssignment) => void;
  onMarkZero: () => void;
  onClear: () => void;
  resolveOverride: (item: BillExpenseItem) => ExpenseScope | null;
}) {
  const isReviewed = selection.reviewed;
  const hasExplicitShared = selection.sharedIds !== undefined;
  const withIds = useMemo(() => assignExpenseIds(items), [items]);
  const localSet = useMemo(() => new Set(selection.localIds), [selection.localIds]);
  const travelSet = useMemo(() => new Set(selection.travelIds ?? []), [selection.travelIds]);
  const sharedSet = useMemo(() => new Set(selection.sharedIds ?? []), [selection.sharedIds]);
  const rows = withIds.map(({ item, id }) => {
    const auto = resolveOverride(item);
    let manualScope: ConfirmedExpenseAssignment | null = null;
    if (!auto) {
      if (travelSet.has(id)) manualScope = 'travel';
      else if (localSet.has(id)) manualScope = 'local';
      else if (sharedSet.has(id)) manualScope = 'shared';
      else if (isReviewed && !hasExplicitShared) manualScope = 'shared'; // 旧数据兜底
    }
    const scope: ExpenseScope | null = auto ?? (manualScope === 'travel' ? 'local' : manualScope);
    const checked = scope === 'local';
    return { item, id, auto, manualScope, scope, checked, needsManual: auto === null && manualScope === null };
  });
  const manualRows = rows.filter((row) => row.auto === null);
  const pendingRows = rows.filter((row) => row.needsManual);
  const autoRows = rows.filter((row) => row.auto !== null);
  const displayRows = [...manualRows, ...autoRows];
  const manualTotal = pendingRows.reduce((s, row) => s + row.item.amount, 0);
  const confirmedSum = rows.reduce((s, row) => s + (row.checked ? row.item.amount : 0), 0);
  const classifiedCount = rows.reduce((c, row) => c + (row.scope ? 1 : 0), 0);
  const totalSum = items.reduce((s, i) => s + i.amount, 0);
  const isZeroSpend = isReviewed && classifiedCount === 0;
  if (withIds.length === 0) {
    return (
      <Card title={`${date} 当日账单`} subtitle={isZeroSpend ? '已确认当天 0 支出' : '当天无账单数据'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: C.sub, textAlign: 'center', paddingTop: 6 }}>
            {isZeroSpend ? '这一天已记为 0 支出' : '当天无账单数据'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onMarkZero}
              style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${isZeroSpend ? C.green : C.blue}`, backgroundColor: isZeroSpend ? '#e6f4ea' : '#fff', color: isZeroSpend ? C.green : C.blue, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              记为 0 支出
            </button>
            {isReviewed && (
              <button
                onClick={onClear}
                style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${C.border}`, backgroundColor: '#fff', color: C.sub, fontSize: 13, cursor: 'pointer' }}
              >
                重置
              </button>
            )}
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card
      title={`${date} 当日账单`}
      subtitle={isZeroSpend
        ? `已确认 0/${withIds.length} 条 · 当天 0 支出`
        : `已分类 ${classifiedCount}/${withIds.length} 条 · 本地¥${formatCurrency(confirmedSum)}/总¥${formatCurrency(totalSum)}`}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button
          onClick={onMarkZero}
          style={{ flex: 1, padding: '9px 0', borderRadius: 8, border: `1px solid ${isZeroSpend ? C.green : C.blue}`, backgroundColor: isZeroSpend ? '#e6f4ea' : '#fff', color: isZeroSpend ? C.green : C.blue, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          记为 0 支出
        </button>
        {isReviewed && (
          <button
            onClick={onClear}
            style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${C.border}`, backgroundColor: '#fff', color: C.sub, fontSize: 13, cursor: 'pointer' }}
          >
            重置
          </button>
        )}
      </div>
      {pendingRows.length > 0 && (
        <div style={{
          marginBottom: 10,
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid #fed7aa',
          backgroundColor: '#fff7ed',
          color: C.orange,
          fontSize: 12,
          lineHeight: 1.5,
        }}>
          {`这天还有 ${pendingRows.length} 条账单没被规则覆盖，请手动分类。`}
          <span style={{ marginLeft: 6, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            ¥{formatCurrency(manualTotal)}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {displayRows.map(({ item, id, auto, manualScope, scope, needsManual }) => {
          const bg = manualScope === 'travel' ? `${tagMeta.travel.color}18` : scope === 'local' ? '#e8f0fe' : scope === 'shared' ? '#fff4e8' : (isReviewed ? '#f8f9fa' : '#fffaf0');
          const isManualRow = auto === null;
          const assignmentOptions: ConfirmedExpenseAssignment[] = item.tags.split(',').map((tag) => tag.trim()).includes('消费')
            ? ['local', 'travel', 'shared']
            : ['local', 'shared'];
          return (
            <div
              key={id}
              title={auto ? '已被「本地/共享分类规则」覆盖，去设置修改' : (needsManual ? '这条账单没被规则覆盖，需要你手动分类' : '已手动分类，可点击切换')}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
                backgroundColor: bg, cursor: auto ? 'not-allowed' : 'default', fontSize: 13,
                opacity: auto === 'shared' ? 0.7 : 1,
                border: needsManual ? '1px solid #fdba74' : '1px solid transparent',
              }}
            >
              {isManualRow ? (
                <div style={{ display: 'inline-flex', borderRadius: 6, border: `1px solid ${C.border}`, overflow: 'hidden', flexShrink: 0 }}>
                  {assignmentOptions.map((p, index) => {
                    const active = manualScope === p;
                    const activeBg = p === 'local' ? C.blue : p === 'travel' ? tagMeta.travel.color : C.orange;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => onSetScope(id, p)}
                        style={{
                          padding: '3px 8px', fontSize: 11, fontWeight: 600, lineHeight: 1.3,
                          border: 'none', borderLeft: index > 0 ? `1px solid ${C.border}` : 'none',
                          backgroundColor: active ? activeBg : '#fff',
                          color: active ? '#fff' : C.sub, cursor: 'pointer',
                        }}
                      >
                        {p === 'local' ? '本地' : p === 'travel' ? '游' : '共享'}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <span style={{
                  width: 34, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 4, fontSize: 10, fontWeight: 700, flexShrink: 0,
                  backgroundColor: auto === 'local' ? C.blue : C.orange, color: '#fff',
                }}>{auto === 'local' ? '本地' : '共享'}</span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, color: '#202124', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.note || item.subcategory || item.category || '—'}
                </div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
                  {item.category}{item.subcategory ? ` · ${item.subcategory}` : ''}{item.tags ? ` · ${item.tags}` : ''}
                  {auto && (
                    <span style={{
                      marginLeft: 6, padding: '1px 5px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                      backgroundColor: auto === 'local' ? '#1a73e8' : '#e8710a', color: '#fff',
                    }}>📌 自动归{auto === 'local' ? '本地' : '共享'}</span>
                  )}
                  {!auto && (
                    <span style={{
                      marginLeft: 6, padding: '1px 5px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                      backgroundColor: manualScope ? '#f1f3f4' : '#fff7ed',
                      color: manualScope ? C.sub : C.orange,
                      border: manualScope ? '1px solid #dadce0' : '1px solid #fdba74',
                    }}>{manualScope ? '手动项' : '待手动分类'}</span>
                  )}
                </div>
              </div>
              <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: manualScope === 'travel' ? tagMeta.travel.color : scope === 'local' ? C.blue : scope === 'shared' ? C.orange : '#202124', flexShrink: 0 }}>¥{formatCurrency(item.amount)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CategoryBreakdown({ items }: { items: BillExpenseItem[] }) {
  const [open, setOpen] = useState(false);
  const total = items.reduce((s, i) => s + i.amount, 0);
  const catMap = new Map<string, BillExpenseItem[]>();
  for (const it of items) {
    const c = it.category || '';
    if (!catMap.has(c)) catMap.set(c, []);
    catMap.get(c)!.push(it);
  }
  const cats = [...catMap.entries()]
    .map(([cat, arr]) => ({ cat, items: arr, total: arr.reduce((s, i) => s + i.amount, 0) }))
    .sort((a, b) => b.total - a.total);
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #e8eaed' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, color: C.sub, marginBottom: open ? 6 : 0 }}
      >
        <span>分类支出</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && cats.map((c) => <CategoryRow key={c.cat} cat={c.cat} items={c.items} total={total} />)}
    </div>
  );
}

// ── MonthRow ──────────────────────────────────────────────────────
function MonthRow({
  record,
  prev,
  allRecords,
  onJumpToMonth,
  expenseItems,
}: {
  record: MonthlyRecord;
  prev?: MonthlyRecord;
  allRecords: MonthlyRecord[];
  onJumpToMonth?: (ym: string) => void;
  expenseItems?: BillExpenseMonth;
}) {
  const [open, setOpen] = useState(false);
  const surplus = record.income - record.totalExpense;
  const assetChange = getMonthlyAssetChange(record, prev);
  const savedAmount = getMonthlySavedAmount(record, prev);
  const savingsRate = getMonthlySavingsRate(record, prev);
  const savedAmountTitle = getSavedAmountTitle(record, prev);
  const expenseSum = record.periodicLife + record.volatileLife + record.consumption;
  const expenseDiff = Math.round((expenseSum - record.totalExpense) * 100) / 100;
  const expenseMismatch = Math.abs(expenseDiff) > 0.01;
  const previousPositionItems = prev
    ? migrateLegacyInvestPositionItems(prev, INVEST_POSITION_LABELS)
    : undefined;
  const recordPositionMonthlyProfit = record.investPositionItems !== undefined
    ? calculateInvestPositionMonthlyProfit(
      record.investPositionItems,
      previousPositionItems,
      {},
      {},
    )
    : null;
  const investIncome = getRecordInvestMonthlyProfit(record, prev);
  const investTotalForRate = getInvestTotalForRate(record.yearMonth, record.investTotal, allRecords);
  const investMonthly = investIncome !== null && investTotalForRate !== null ? investIncome / investTotalForRate.value : null;

  // 异常支出：缺少 / 同时多个核心标签的明细。提前算出，供折叠头部与展开详情共用
  const ABNORMAL_CORE_TAGS = ['消费', '波动生活', '周期生活'];
  const noTagExpenses: BillExpenseItem[] = [];
  const multiTagExpenses: BillExpenseItem[] = [];
  if (expenseItems) {
    for (const it of expenseItems) {
      const tags = it.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const matched = ABNORMAL_CORE_TAGS.filter((c) => tags.includes(c));
      if (matched.length === 0) noTagExpenses.push(it);
      else if (matched.length > 1) multiTagExpenses.push(it);
    }
  }
  const hasAbnormalExpense = noTagExpenses.length > 0 || multiTagExpenses.length > 0;

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', display: 'grid', gridTemplateColumns: HISTORY_GRID_COLUMNS,
          alignItems: 'center', padding: '12px 10px', borderRadius: 10, border: 'none',
          backgroundColor: open ? '#e8f0fe' : '#fafafa', cursor: 'pointer',
          textAlign: 'left', transition: 'background-color 0.15s',
        }}
        className="history-summary"
      >
        <span data-label="月份" style={{ fontSize: 13, fontWeight: 600, color: open ? C.blue : '#202124' }}>
          {record.yearMonth.slice(2)}
          {expenseMismatch && <span title={`三项之和 ${formatCurrency(expenseSum)} ≠ 总支出 ${formatCurrency(record.totalExpense)}`} style={{ marginLeft: 4, color: '#c5221f' }}>⚠️</span>}
          {hasAbnormalExpense && <span title={`异常支出：缺少核心标签 ${noTagExpenses.length} 笔，多个核心标签 ${multiTagExpenses.length} 笔`} style={{ marginLeft: 4, color: '#c5221f' }}>⚠️</span>}
        </span>
        <span data-label="收入" title={`¥${formatCurrency(record.income)}`} style={{ fontSize: 13, color: C.red,   fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>+{formatCompactAmount(record.income)}</span>
        <span data-label="支出" title={`¥${formatCurrency(record.totalExpense)}`} style={{ fontSize: 13, color: C.green,  fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>-{formatCompactAmount(record.totalExpense)}</span>
        <span data-label="结余" title={formatSignedCurrency(surplus)} style={{ fontSize: 13, fontWeight: 600, color: surplus >= 0 ? C.red : C.green, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {surplus >= 0 ? '+' : '-'}{formatCompactAmount(surplus)}
        </span>
        <span
          data-label="存下"
          title={savedAmountTitle}
          style={{ fontSize: 12, fontWeight: 600, color: savedAmount !== null ? (savedAmount >= 0 ? C.red : C.green) : C.sub, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
        >
          {savedAmount !== null ? formatSignedCompactCurrency(savedAmount) : '—'}
        </span>
        <span
          data-label="收益率"
          title={investTotalForRate?.estimated ? `理财总额按 ${investTotalForRate.beforeMonth} / ${investTotalForRate.afterMonth} 均值估算` : undefined}
          style={{ fontSize: 12, color: investMonthly !== null ? (investMonthly >= 0 ? C.red : C.green) : C.sub, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
        >
          {investMonthly !== null ? `${(investMonthly * 100).toFixed(2)}%` : '—'}
        </span>
      </button>

      {open && (
        <div style={{ margin: '2px 0 8px', border: '1.5px solid #c5d9f8', borderRadius: 10, backgroundColor: '#f8fbff', padding: '14px 16px' }}>
          {expenseMismatch && (
            <div style={{ marginBottom: 10, padding: '6px 10px', borderRadius: 8, fontSize: 12, backgroundColor: '#fce8e6', color: '#c5221f', display: 'flex', justifyContent: 'space-between' }}>
              <span>三项之和 − 总支出</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{expenseDiff > 0 ? '+' : ''}{formatCurrency(expenseDiff)}</span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
            {([
              {
                label: '总资产',
                value: record.totalAssets !== undefined ? `¥${formatCurrency(record.totalAssets)}` : '未记录',
                color: record.totalAssets !== undefined ? '#202124' : C.sub,
                title: undefined,
              },
              {
                label: '资产增加',
                value: assetChange !== null ? formatSignedCurrency(assetChange) : '—',
                color: assetChange !== null ? (assetChange >= 0 ? C.red : C.green) : C.sub,
                title: getAssetChangeTitle(record.totalAssets, prev?.totalAssets),
              },
              {
                label: '存下',
                value: savedAmount !== null ? formatSignedCurrency(savedAmount) : '—',
                color: savedAmount !== null ? (savedAmount >= 0 ? C.red : C.green) : C.sub,
                title: savedAmountTitle,
              },
              {
                label: '储蓄率',
                value: savingsRate !== null ? `${(savingsRate * 100).toFixed(1)}%` : '—',
                color: savingsRate !== null ? (savingsRate >= 0 ? C.red : C.green) : C.sub,
                title: savedAmountTitle,
              },
            ]).map((item) => (
              <div key={item.label} title={item.title} style={{ minWidth: 0, padding: '8px 10px', borderRadius: 8, backgroundColor: '#fff' }}>
                <div style={{ fontSize: 10, color: C.sub, marginBottom: 3 }}>{item.label}</div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13, fontWeight: 600, color: item.color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div>
              <StatRow label="收入"   value={<CurrencyDisplay value={record.income}       color={C.red}   />} />
              <StatRow label="总支出" value={<CurrencyDisplay value={record.totalExpense}  color={C.green} />} />
              <StatRow label="结余"   value={<CurrencyDisplay value={surplus} color={surplus >= 0 ? C.red : C.green} />} />
            </div>
            <div>
              <StatRow label="周期生活" value={<CurrencyDisplay value={record.periodicLife} color={C.blue}   />} />
              <StatRow label="波动生活" value={<CurrencyDisplay value={record.volatileLife} color={C.blue}   />} />
              <StatRow label="消费"     value={<CurrencyDisplay value={record.consumption}  color={C.purple} />} />
            </div>
          </div>
          {investIncome !== null && (
            <div style={{ borderTop: '1px solid #dbe8fb', paddingTop: 10, marginBottom: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 6 }}>
                <StatRow label="理财收入" value={<CurrencyDisplay value={investIncome} color={investIncome >= 0 ? C.red : C.green} />} />
                {investMonthly !== null && <StatRow label={investTotalForRate?.estimated ? '月收益率(估)' : '月收益率'} value={<span title={investTotalForRate?.estimated ? `理财总额按 ${investTotalForRate.beforeMonth} / ${investTotalForRate.afterMonth} 均值估算` : undefined} style={{ color: investMonthly >= 0 ? C.red : C.green, fontWeight: 500 }}>{(investMonthly * 100).toFixed(2)}%</span>} />}
              </div>
              {record.investBreakdown && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e8eaed' }}>
                      <th style={{ textAlign: 'left',  padding: '3px 0', color: C.sub, fontWeight: 500 }}>品类</th>
                      <th style={{ textAlign: 'right', padding: '3px 0', color: C.sub, fontWeight: 500 }}>持仓</th>
                      <th style={{ textAlign: 'right', padding: '3px 0', color: C.sub, fontWeight: 500 }}>累计收益</th>
                      <th style={{ textAlign: 'right', padding: '3px 0', color: C.sub, fontWeight: 500 }}>本月收益</th>
                      <th style={{ textAlign: 'right', padding: '3px 0', color: C.sub, fontWeight: 500 }}>收益率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {INVEST_KEYS.filter((k) => {
                      const cur = record.investBreakdown![k] ?? 0;
                      const rawProfit = record.investBreakdownProfit?.[k];
                      return cur > 0 || (record.investBreakdownPastProfit?.[k] ?? 0) !== 0 || (rawProfit !== undefined && rawProfit !== null && rawProfit !== 0);
                    }).map((k) => {
                      const cur    = record.investBreakdown![k] ?? 0;
                      const profit = getCategoryProfit(record, k);
                      const prevProfit = getCategoryProfit(prev, k);
                      const monthlyProfit = recordPositionMonthlyProfit
                        ? recordPositionMonthlyProfit.byCategory[k] ?? null
                        : (profit === null || prevProfit === null)
                          ? null
                          : profit - prevProfit;
                      const rate = (monthlyProfit !== null && cur > 0) ? monthlyProfit / cur : null;
                      return (
                        <tr key={k} style={{ borderBottom: '1px solid #f5f5f5' }}>
                          <td style={{ padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: investMeta[k].color, display: 'inline-block', flexShrink: 0 }} />
                            {investMeta[k].label}
                          </td>
                          <td style={{ padding: '4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(cur)}</td>
                          <td style={{ padding: '4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: profit !== null ? (profit >= 0 ? C.red : C.green) : C.sub }}>
                            {profit !== null ? `${profit >= 0 ? '+' : ''}${Math.round(profit)}` : '—'}
                          </td>
                          <td style={{ padding: '4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: monthlyProfit !== null ? (monthlyProfit >= 0 ? C.red : C.green) : C.sub }}>
                            {monthlyProfit !== null ? `${monthlyProfit >= 0 ? '+' : ''}${Math.round(monthlyProfit)}` : '—'}
                          </td>
                          <td style={{ padding: '4px 0', textAlign: 'right', color: rate !== null ? (rate >= 0 ? C.red : C.green) : C.sub }}>
                            {rate !== null ? `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {hasAbnormalExpense && (
            <div style={{ borderTop: '1px solid #dbe8fb', paddingTop: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#c5221f', marginBottom: 6, fontWeight: 600 }}>⚠️ 异常支出</div>
              {noTagExpenses.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: C.sub, marginBottom: 2 }}>缺少消费/波动生活/周期生活标签（{noTagExpenses.length}）</div>
                  {noTagExpenses.map((it, i) => <ExpenseItemLine key={i} it={it} />)}
                </div>
              )}
              {multiTagExpenses.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: C.sub, marginBottom: 2 }}>同时有多个核心标签（{multiTagExpenses.length}）</div>
                  {multiTagExpenses.map((it, i) => <ExpenseItemLine key={i} it={it} />)}
                </div>
              )}
            </div>
          )}
          {expenseItems && expenseItems.length > 0 && (() => {
            const total = expenseItems.reduce((s, i) => s + i.amount, 0);
            const catMap = new Map<string, BillExpenseItem[]>();
            for (const it of expenseItems) {
              const c = it.category || '';
              if (!catMap.has(c)) catMap.set(c, []);
              catMap.get(c)!.push(it);
            }
            const cats = [...catMap.entries()]
              .map(([cat, arr]) => ({ cat, items: arr, total: arr.reduce((s, i) => s + i.amount, 0) }))
              .sort((a, b) => b.total - a.total);
            return (
              <div style={{ borderTop: '1px solid #dbe8fb', paddingTop: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>分类支出</div>
                {cats.map((c) => <CategoryRow key={c.cat} cat={c.cat} items={c.items} total={total} />)}
              </div>
            );
          })()}
          <div style={{ borderTop: '1px solid #dbe8fb', paddingTop: 10, display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: C.sub, flexWrap: 'wrap' }}>
            {([
              { key: 'school' as TagKind, days: record.schoolDays },
              { key: 'intern' as TagKind, days: record.internDays },
              { key: 'home'   as TagKind, days: record.homeDays },
              { key: 'travel' as TagKind, days: record.travelDays },
            ]).filter(({ days }) => days && days > 0).map(({ key, days }) => (
              <span key={key} style={{ color: tagMeta[key].color, fontWeight: 500 }}>{tagMeta[key].icon} {tagMeta[key].label} {days}天</span>
            ))}
            {record.school > 0 && <span>校园卡 ¥{formatCurrency(record.school)}</span>}
            <span style={{ flex: 1 }} />
            {onJumpToMonth && (
              <button
                onClick={() => onJumpToMonth(record.yearMonth)}
                style={{ fontSize: 11, color: C.blue, border: `1px solid #a8c7fa`, borderRadius: 8, padding: '3px 10px', backgroundColor: '#e8f0fe', cursor: 'pointer', fontWeight: 600, flexShrink: 0 }}
              >
                → 日历
              </button>
            )}
          </div>
          {((record.majorExpenses && record.majorExpenses.length > 0) || record.majorExpensesNote) && (
            <div style={{ borderTop: '1px solid #dbe8fb', paddingTop: 10, marginTop: 8 }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>大额支出</div>
              {record.majorExpenses?.map((e, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '3px 0' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: 11, marginRight: 6, backgroundColor: e.type === '生活' ? '#e8f0fe' : '#f3e8fd', color: e.type === '生活' ? C.blue : C.purple }}>{e.type}</span>
                    {e.name}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, flexShrink: 0 }}>¥{formatCurrency(e.amount)}</span>
                </div>
              ))}
              {record.majorExpensesNote && (
                <div style={{ fontSize: 12, color: C.sub, marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {record.majorExpensesNote}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type YearProfitMode = 'rate' | 'amount';

// ── YearSection ───────────────────────────────────────────────────
function YearSection({
  year,
  asOfDate,
  recs,
  allRecords,
  yearProfitMode,
  onToggleYearProfitMode,
  onJumpToMonth,
  expenseItemsByMonth,
}: {
  year: string;
  asOfDate: string;
  recs: MonthlyRecord[];
  allRecords: MonthlyRecord[];
  yearProfitMode: YearProfitMode;
  onToggleYearProfitMode: () => void;
  onJumpToMonth?: (ym: string) => void;
  expenseItemsByMonth?: Record<string, BillExpenseMonth>;
}) {
  const currentYear = asOfDate.slice(0, 4);
  const [expanded, setExpanded] = useState(year === currentYear);
  const totalIncome  = recs.reduce((s, r) => s + r.income, 0);
  const totalExpense = recs.reduce((s, r) => s + r.totalExpense, 0);
  const surplus = totalIncome - totalExpense;
  const hasMonths = `${year}-01` >= YEARLY_ONLY_BEFORE;
  const monthlySavedAmounts = recs.map((r) => {
    const prev = allRecords.find((x) => x.yearMonth === prevYearMonth(r.yearMonth));
    return getMonthlySavedAmount(r, prev);
  }).filter((value): value is number => value !== null);
  const yearSavedAmount = monthlySavedAmounts.length > 0
    ? monthlySavedAmounts.reduce((sum, value) => sum + value, 0)
    : null;

  // 年度行与首页复用加权投入额及按实际天数折算的年化；往年截至年末。
  const yearReturn = year <= currentYear
    ? getYearInvestmentReturn(allRecords, year === currentYear ? asOfDate : `${year}-12-31`)
    : null;
  const monthlyProfits = recs.filter(r => r.yearMonth <= asOfDate.slice(0, 7)).map(r => {
    const prev = allRecords.find(x => x.yearMonth === prevYearMonth(r.yearMonth));
    return getRecordInvestMonthlyProfit(r, prev);
  }).filter((x): x is number => x !== null);
  const yearRate = yearReturn?.annualizedRate ?? null;
  const yearProfitAmount = monthlyProfits.length > 0 ? monthlyProfits.reduce((a, b) => a + b, 0) : null;
  const yearProfitValue = yearProfitMode === 'rate' ? yearRate : yearProfitAmount;

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => setExpanded((o) => !o)}
        className="history-summary"
        style={{
          width: '100%', display: 'grid', gridTemplateColumns: HISTORY_GRID_COLUMNS,
          alignItems: 'center', padding: '12px 10px', borderRadius: 10, border: 'none',
          backgroundColor: expanded ? '#e8f0fe' : '#f1f3f4', cursor: 'pointer',
          textAlign: 'left', transition: 'background-color 0.15s',
        }}
      >
        <span data-label="年份" style={{ fontSize: 14, fontWeight: 700, color: expanded ? C.blue : '#202124' }}>{year} {expanded ? '▼' : '▶'}</span>
        <span data-label="收入" title={`¥${formatCurrency(totalIncome)}`} style={{ fontSize: 13, color: C.red,   fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>+{formatCompactAmount(totalIncome)}</span>
        <span data-label="支出" title={`¥${formatCurrency(totalExpense)}`} style={{ fontSize: 13, color: C.green,  fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>-{formatCompactAmount(totalExpense)}</span>
        <span data-label="结余" title={formatSignedCurrency(surplus)} style={{ fontSize: 13, fontWeight: 600, color: surplus >= 0 ? C.red : C.green, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {surplus >= 0 ? '+' : '-'}{formatCompactAmount(surplus)}
        </span>
        <span
          data-label="存下"
          title="本年各月存下合计"
          style={{ fontSize: 12, fontWeight: 600, color: yearSavedAmount !== null ? (yearSavedAmount >= 0 ? C.red : C.green) : C.sub, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
        >
          {yearSavedAmount !== null ? formatSignedCompactCurrency(yearSavedAmount) : '—'}
        </span>
        <span
          role="button"
          data-label={yearProfitMode === 'rate' ? '收益率' : '收益'}
          tabIndex={0}
          aria-label={yearProfitMode === 'rate' ? `${year}年年化收益率` : `${year}年收益金额`}
          title={yearProfitMode === 'rate' ? '点击切换为收益金额' : '点击切换为收益率'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleYearProfitMode();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            onToggleYearProfitMode();
          }}
          style={{ fontSize: 12, fontWeight: 600, color: yearProfitValue !== null ? (yearProfitValue >= 0 ? C.red : C.green) : C.sub, fontVariantNumeric: 'tabular-nums', textAlign: 'right', cursor: 'pointer' }}
        >
          {yearProfitMode === 'rate'
            ? (yearRate !== null ? `${(yearRate * 100).toFixed(2)}%` : '—')
            : (yearProfitAmount !== null ? formatSignedCompactCurrency(yearProfitAmount) : '—')}
        </span>
      </button>
      {expanded && (
        <div style={{ paddingLeft: 8, marginTop: 4, marginBottom: 8 }}>
          {hasMonths ? (
            recs.map(r => {
              const prevRecord = allRecords.find((x) => x.yearMonth === prevYearMonth(r.yearMonth));
              return <MonthRow key={r.yearMonth} record={r} prev={prevRecord} allRecords={allRecords} onJumpToMonth={onJumpToMonth} expenseItems={expenseItemsByMonth?.[r.yearMonth]} />;
            })
          ) : (
            <div style={{ padding: '10px 14px', backgroundColor: '#fafafa', borderRadius: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <StatRow label="总收入"  value={<CurrencyDisplay value={totalIncome}  color={C.red}   />} />
                <StatRow label="总支出"  value={<CurrencyDisplay value={totalExpense} color={C.green} />} />
                <StatRow label="总结余"  value={<CurrencyDisplay value={surplus} color={surplus >= 0 ? C.red : C.green} />} />
                <StatRow label="月均收入" value={<CurrencyDisplay value={totalIncome  / recs.length} color={C.red}   />} />
                <StatRow label="月均支出" value={<CurrencyDisplay value={totalExpense / recs.length} color={C.green} />} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────
export default function CalendarPage() {
  const syncReady = useSyncStatus((state) => state.ready);
  const syncRevision = useSyncStatus((state) => state.revision);
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<'month' | 'year'>(
    searchParams.get('tab') === 'year' ? 'year' : 'month'
  );

  // ── Calendar state ──
  const _now = _NOW;
  const today = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
  const requestedMonth = searchParams.get('month') ?? '';
  const validRequestedMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth);
  const focusMonthCalendar = searchParams.get('focus') === 'calendar';
  const [year,  setYear]  = useState(() => validRequestedMonth ? Number(requestedMonth.slice(0, 4)) : _now.getFullYear());
  const [month, setMonth] = useState(() => validRequestedMonth ? Number(requestedMonth.slice(5, 7)) - 1 : _now.getMonth());
  const [selectedTag, setSelectedTag] = useState<TagKind>('school');
  const [selectMode, setSelectMode]   = useState<'single' | 'range' | 'detail'>('detail');
  const [rangeStart, setRangeStart]   = useState<string | null>(null);
  const [rangeHover, setRangeHover]   = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showWeekTemplate, setShowWeekTemplate] = useState(false);
  const [showPendingPanel, setShowPendingPanel] = useState(false);
  const [activeTripStartDate, setActiveTripStartDate] = useState<string | null>(null);
  const [tripFilterPanelOpen, setTripFilterPanelOpen] = useState(false);

  // ── History state ──
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [yearProfitMode, setYearProfitMode] = useState<YearProfitMode>('rate');
  const toggleYearProfitMode = () => setYearProfitMode((m) => m === 'rate' ? 'amount' : 'rate');

  // ── Stores ──
  const { setTag, toggleTag, bulkFillSchool, confirmedExpenses, setConfirmedExpenseScope, markConfirmedExpenseZero, clearConfirmedExpenseSelection } = useCalendarStore();
  const { tagMap, internship, countByTag } = useLifeCalendar();
  const { config, setConfig } = useConfigStore();
  const { records, upsert, updateDayCounts } = useMonthlyStore();
  const { tagStats: billTagStats, aggregates: billAggregates, expenseItems: billExpenseItems } = useBillDetailStore();
  const { overrides: expenseScopeOverrides, setOverride: setExpenseScopeOverride } = useExpenseScopeOverrideStore();
  const { tripTags, tripNotes, tripSplits, setTripTag, setTripNote, clearTripTag, toggleTripSplit } = useTripStore();
  const {
    tagOrder, setTagOrder, weekdayTags, setWeekdayTags,
    showPayrollCutoffMarkers: legacyCutoffPreference,
    reviewableCategories, setReviewableCategories,
    expenseScopeHelpText, setExpenseScopeHelpText,
  } = usePrefsStore();
  const tagDrag = useDragSort(tagOrder, setTagOrder, 'horizontal');
  const { holidayDataByYear, holidayWarning } = useHolidayYears([year]);


  // ── 批量补填"学"：历史未标记天 + 切换月份时自动补当月 ──
  useEffect(() => {
    if (!syncReady || records.length === 0) return;
    const earliest = records[records.length - 1].yearMonth + '-01';
    const todayStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
    bulkFillSchool(earliest, todayStr);
  }, [syncReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!syncReady || records.length === 0) return;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
    bulkFillSchool(`${ym}-01`, `${ym}-${String(daysInMonth).padStart(2, '0')}`);
  }, [year, month, syncReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── tagMap → MonthlyRecord 天数字段同步 ──
  useEffect(() => {
    if (!syncReady) return;
    // 按月聚合 tagMap 中的状态天数
    const countsByMonth: Record<string, { school: number; intern: number; home: number; travel: number }> = {};
    for (const [date, tag] of Object.entries(tagMap)) {
      const ym = date.slice(0, 7);
      if (!countsByMonth[ym]) countsByMonth[ym] = { school: 0, intern: 0, home: 0, travel: 0 };
      countsByMonth[ym][tag]++;
    }
    // 只更新已有 MonthlyRecord 的月份
    for (const [ym, counts] of Object.entries(countsByMonth)) {
      const rec = records.find((r) => r.yearMonth === ym);
      if (!rec) continue;
      if (
        rec.schoolDays !== counts.school ||
        rec.internDays !== counts.intern ||
        rec.homeDays   !== counts.home   ||
        rec.travelDays !== counts.travel
      ) {
        updateDayCounts(ym, {
          schoolDays: counts.school,
          internDays: counts.intern,
          homeDays:   counts.home,
          travelDays: counts.travel,
        });
      }
    }
  }, [tagMap, syncReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // 账单明细与月度记录分开持久化。若历史上只同步到了明细，或月度卡片曾把核心字段写成 0，
  // 用账单侧汇总把缺失的字段逐项补回来——总收入/总支出仍在但四项细分丢失的半空状态也覆盖。
  useEffect(() => {
    if (!syncReady) return;
    for (const [ym, aggregate] of Object.entries(billAggregates)) {
      const prev = records.find((r) => r.yearMonth === ym);
      if (fieldsNeedingRestore(prev, aggregate).length === 0) continue;
      upsert(recordFromBillAggregate(ym, aggregate, prev));
    }
  }, [billAggregates, records, upsert, syncReady]);

  // ── 历史回归均值（近两年，用作当月按比例拆分的权重）──
  const twoYearsAgo = `${_now.getFullYear() - 1}-01`;
  const historyStats = useMemo(
    () => calcHistoryStats(records.filter((r) => r.yearMonth >= twoYearsAgo), tagMap, confirmedExpenses, billExpenseItems, expenseScopeOverrides, tripTags, internship),
    [records, tagMap, confirmedExpenses, billExpenseItems, expenseScopeOverrides, tripTags, internship],
  );

  // ── Calendar computed ──
  const yearMonth    = `${year}-${pad(month + 1)}`;
  // 自动同步跟随月历，打开或关闭设置不会重启同步。
  const outlookSync = useOutlookCalendarSync(yearMonth, tab === 'month');
  useEffect(() => {
    if (tab !== 'month' || !focusMonthCalendar) return;
    let secondFrame = 0;
    const scrollToCalendar = () => {
      document.getElementById('month-calendar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(scrollToCalendar);
    });
    const settleTimer = window.setTimeout(scrollToCalendar, 350);
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(settleTimer);
    };
  }, [focusMonthCalendar, tab, yearMonth]);
  const daysInMonth  = getDaysInMonth(year, month);
  const firstDayWeekIdx = (new Date(year, month, 1).getDay() + 6) % 7;
  const payrollCutoffDates = useMemo(
    () => payrollCutoffMarkerDates({ ...internship, holidayDataByYear: { ...internship.holidayDataByYear, ...holidayDataByYear } }, tagMap, year, month, legacyCutoffPreference),
    [internship, tagMap, year, month, holidayDataByYear, legacyCutoffPreference],
  );

  const calendarWeather = useCalendarWeather(yearMonth, syncReady && tab === 'month');
  const cells = useMemo(() => {
    const arr: { key: string; day: number | null }[] = [];
    for (let i = 0; i < firstDayWeekIdx; i++) arr.push({ key: `empty-${i}`, day: null });
    for (let d = 1; d <= daysInMonth; d++) arr.push({ key: `${year}-${pad(month + 1)}-${pad(d)}`, day: d });
    while (arr.length < 42) arr.push({ key: `tail-${arr.length}`, day: null });
    return arr;
  }, [year, month, firstDayWeekIdx, daysInMonth]);

  // ── 出游胶囊：连接同段 trip 内同周的相邻 cell（splits 处自动断开）──
  const tripsThisMonth = useMemo(() => detectTrips(tagMap, yearMonth, tripSplits), [tagMap, yearMonth, tripSplits]);
  const tripGroupsThisMonth = useMemo(() => detectTripGroups(tagMap, yearMonth, tripSplits), [tagMap, yearMonth, tripSplits]);
  const activeTripStartDates = useMemo(
    () => new Set(detectAllTrips(tagMap, tripSplits).map((trip) => trip.startDate)),
    [tagMap, tripSplits],
  );
  const selectedTripStartsThisMonth = useMemo(
    () => tripGroupsThisMonth.flatMap((group) => group.trips.map((trip) => trip.startDate)).filter((startDate) => !!tripTags[startDate]),
    [tripGroupsThisMonth, tripTags],
  );
  const effectiveActiveTripStartDate = activeTripStartDate && selectedTripStartsThisMonth.includes(activeTripStartDate)
    ? activeTripStartDate
    : (selectedTripStartsThisMonth[0] ?? null);
  const activeTripFilterTag = effectiveActiveTripStartDate ? (tripTags[effectiveActiveTripStartDate] ?? '') : '';
  const activeTripFilterDays = tripsThisMonth.find((trip) => trip.startDate === effectiveActiveTripStartDate)?.dates.length;
  const tripConnect = useMemo(() => {
    // 用每段 trip 的 dates 单独构造连接集合，跨 trip（即 split 点两侧）不连
    const datesByTripKey = tripsThisMonth.map((t) => new Set(t.dates));
    const dateToTripIdx = new Map<string, number>();
    tripsThisMonth.forEach((t, idx) => { for (const d of t.dates) dateToTripIdx.set(d, idx); });
    const map: Record<string, { left: boolean; right: boolean }> = {};
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.day === null) continue;
      const tripIdx = dateToTripIdx.get(cell.key);
      if (tripIdx === undefined) continue;
      const colIdx = i % 7;
      const leftCell = colIdx > 0 ? cells[i - 1] : null;
      const rightCell = colIdx < 6 ? cells[i + 1] : null;
      const sameTrip = (other: { key: string; day: number | null } | null) =>
        !!other && other.day !== null && datesByTripKey[tripIdx].has(other.key);
      map[cell.key] = { left: sameTrip(leftCell), right: sameTrip(rightCell) };
    }
    return map;
  }, [cells, tripsThisMonth]);

  const TAG_CYCLE: (TagKind | undefined)[] = [undefined, 'intern', 'school', 'home', 'travel'];
  const cycleWeekday = (dow: number) => {
    const cur = weekdayTags[dow];
    const idx = TAG_CYCLE.indexOf(cur);
    const next = TAG_CYCLE[(idx + 1) % TAG_CYCLE.length];
    const next_ = { ...weekdayTags };
    if (next === undefined) { delete next_[dow]; } else { next_[dow] = next; }
    setWeekdayTags(next_);
  };
  const applyWeekdayTemplate = () => {
    for (const cell of cells) {
      if (cell.day === null) continue;
      const dow = getDayOfWeek(cell.key);
      const tag = weekdayTags[dow];
      if (!tag) continue;
      if (tag === 'intern' && isWeekend(cell.key)) continue;
      setTag(cell.key, tag);
    }
  };

  const previewRange = useMemo<Set<string>>(() => {
    if (selectMode !== 'range' || !rangeStart) return new Set();
    return new Set(getRange(rangeStart, rangeHover ?? rangeStart));
  }, [selectMode, rangeStart, rangeHover]);

  const pendingManualEntries = useMemo(() => {
    const allowedSet = new Set(reviewableCategories);
    if (allowedSet.size === 0) return [] as { date: string; id: string; item: BillExpenseItem }[];
    const items = billExpenseItems[yearMonth] ?? [];
    const itemsByDate = new Map<string, BillExpenseItem[]>();
    for (const it of items) {
      const arr = itemsByDate.get(it.date) ?? [];
      arr.push(it);
      itemsByDate.set(it.date, arr);
    }
    const out: { date: string; id: string; item: BillExpenseItem }[] = [];
    const dates = [...itemsByDate.keys()].sort();
    for (const date of dates) {
      const sel = normalizeConfirmedSelection(confirmedExpenses[date]);
      const localSet = new Set(sel.localIds);
      const sharedSet = new Set(sel.sharedIds ?? []);
      const hasExplicitShared = sel.sharedIds !== undefined;
      // 旧数据：reviewed 且没存 sharedIds → 整天兜底为共享，不算待分类
      if (sel.reviewed && !hasExplicitShared) continue;
      const withIds = assignExpenseIds(itemsByDate.get(date) ?? []);
      for (const { item, id } of withIds) {
        const tagList = (item.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
        if (!tagList.some((t) => allowedSet.has(t as ReviewableCategory))) continue;
        if (resolveExpenseScope(item, expenseScopeOverrides) !== null) continue;
        if (localSet.has(id) || sharedSet.has(id)) continue;
        out.push({ date, id, item });
      }
    }
    return out;
  }, [billExpenseItems, yearMonth, expenseScopeOverrides, confirmedExpenses, reviewableCategories]);

  const stats = useMemo(() => {
    const counts: Record<TagKind, number> = { intern: 0, school: 0, home: 0, travel: 0 };
    for (const cell of cells) {
      if (cell.day === null) continue;
      const tag = tagMap[cell.key];
      if (tag) counts[tag]++;
    }
    return { counts, tagged: Object.values(counts).reduce((a, b) => a + b, 0), total: daysInMonth };
  }, [cells, tagMap, daysInMonth]);

  // 截止今天的 tag 天数（用于日均计算，未来的天不算）
  const statsToDate = useMemo(() => {
    const isCurrentMonth = yearMonth === today.slice(0, 7);
    const counts: Record<TagKind, number> = { intern: 0, school: 0, home: 0, travel: 0 };
    for (const cell of cells) {
      if (cell.day === null) continue;
      if (isCurrentMonth && cell.key > today) continue;
      const tag = tagMap[cell.key];
      if (tag) counts[tag]++;
    }
    return counts;
  }, [cells, tagMap, yearMonth, today]);

  const awayInternshipMonth = cells.some(cell => cell.day !== null
    && resolveDailyContext(cell.key, tagMap[cell.key], internship).awayInternship);
  const citySegmentLabels = monthCityLabels(cells.filter(cell => cell.day !== null).map(cell => cell.key),
    Object.fromEntries(cells.filter(cell => cell.day !== null).map(cell => {
      const city = resolveDailyContext(cell.key, tagMap[cell.key], internship).city;
      return [cell.key, calendarWeather.locations?.[cell.key] ?? { locations: city ? [{ ...city, source: 'calendar' as const }] : [], travel: tagMap[cell.key] === 'travel' }];
    })));

  const handleCellClick = (key: string) => {
    if (selectMode === 'detail') { setSelectedDay((cur) => cur === key ? null : key); return; }
    if (selectMode === 'single') {
      const context = resolveDailyContext(key, tagMap[key], internship);
      if (context.period && (selectedTag === 'intern' || selectedTag === 'school')) setTag(key, selectedTag);
      else toggleTag(key, selectedTag);
      return;
    }
    if (!rangeStart) { setRangeStart(key); setRangeHover(key); }
    else {
      const range = getRange(rangeStart, key);
      const validKeys = new Set(cells.filter(c => c.day !== null).map(c => c.key));
      for (const k of range) { if (validKeys.has(k)) setTag(k, selectedTag); }
      setRangeStart(null); setRangeHover(null);
    }
  };
  useEffect(() => { setRangeStart(null); setRangeHover(null); setSelectedDay(null); }, [year, month]);
  const cancelRange = () => { setRangeStart(null); setRangeHover(null); };
  const switchMode  = (m: 'single' | 'range' | 'detail') => {
    setSelectMode(m); cancelRange();
    if (m !== 'detail') setSelectedDay(null);
  };
  const prevMonth   = () => { cancelRange(); setSelectedDay(null); if (month === 0) { setYear((y) => y - 1); setMonth(11); } else setMonth((m) => m - 1); };
  const nextMonth   = () => { cancelRange(); setSelectedDay(null); if (month === 11) { setYear((y) => y + 1); setMonth(0); } else setMonth((m) => m + 1); };

  // ── 年月快捷跳转面板 ──
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [thresholdInput, setThresholdInput] = useState(String(config.majorExpenseThreshold ?? 500));
  const [autoSumStartMonthInput, setAutoSumStartMonthInput] = useState(config.investAutoSumStartMonth ?? '');
  const [expandedTag, setExpandedTag] = useState<null | 'eat' | 'red' | 'black'>(null);
  const [billImportMsg, setBillImportMsg] = useState<string>('');
  const [backupCreating, setBackupCreating] = useState(false);
  const [billImporting, setBillImporting] = useState(false);
  const billFileRef = useRef<HTMLInputElement>(null);
  const importBillFromFile = async (file: File) => {
    setBillImporting(true);
    try {
      setBillImportMsg(isFinanceScreenshotFile(file) ? '图片OCR中' : '导入中');
      setBillImportMsg(await importFinanceFile(file));
    } catch (err) {
      setBillImportMsg(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBillImporting(false);
    }
  };
  const backupCurrentVersion = async () => {
    setBackupCreating(true);
    setBillImportMsg('备份中');
    try {
      await createManualBackup();
      setBillImportMsg('当前版本已备份');
    } catch (error) {
      setBillImportMsg(`备份失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupCreating(false);
    }
  };
  const handleBillFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (/\.(xlsx?|csv)$/i.test(file.name) || isFinanceScreenshotFile(file)) {
        await importBillFromFile(file);
      } else {
        setBillImportMsg('请选择 Excel、CSV 或图片文件');
      }
    }
    if (billFileRef.current) billFileRef.current.value = '';
  };
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  // ── History computed ──
  // 当前日历所在月的数据（月视图用）
  const existingForYearMonth = records.find((r) => r.yearMonth === yearMonth);
  const setInvestmentProfitBaseline = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== yearMonth) {
      throw new Error(`请选择 ${yearMonth} 内的日期`);
    }
    if (date > today) throw new Error('基准日期不能晚于今天');
    const currentRecord = useMonthlyStore.getState().getByYearMonth(yearMonth);
    const positionItems = currentRecord?.investPositionItems;
    const itemCount = INVEST_POSITION_GROUP_KEYS.reduce((sum, key) => sum + (positionItems?.[key]?.length ?? 0), 0);
    if (!currentRecord || !positionItems || itemCount === 0) throw new Error('请先填写本月理财明细');
    setConfig({
      investmentProfitBaseline: {
        date,
        yearMonth,
        createdAt: new Date().toISOString(),
        positionItems: cloneInvestPositionItems(positionItems),
      },
    });
    void triggerUpload();
    return `已保存 ${itemCount} 个条目`;
  };
  const inferSelectedMonthInvestmentProfit = () => {
    const baseline = useConfigStore.getState().config.investmentProfitBaseline;
    if (!baseline) throw new Error('请先设置推算基准');
    if (baseline.yearMonth > yearMonth) throw new Error('当前月份早于推算基准');
    const monthlyStore = useMonthlyStore.getState();
    const currentRecord = monthlyStore.getByYearMonth(yearMonth);
    if (!currentRecord?.investPositionItems) throw new Error('本月没有理财明细');
    const currentSummary = summarizeInvestPositionItems(currentRecord.investPositionItems);
    const throughDate = yearMonth === today.slice(0, 7)
      ? today
      : `${yearMonth}-${String(new Date(Number(yearMonth.slice(0, 4)), Number(yearMonth.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
    const result = inferInvestmentProfitFromBaseline(
      baseline,
      currentRecord.investPositionItems,
      currentSummary,
      monthlyStore.records.flatMap((record) => record.investmentTransactions ?? []),
      throughDate,
    );
    if (result.totalProfitCny === null) {
      throw new Error(`持仓与变动未对上：${result.mismatchedItems.join('、')}`);
    }
    const updatedItems: InvestPositionItems = {};
    for (const groupKey of INVEST_POSITION_GROUP_KEYS) {
      const group = currentRecord.investPositionItems[groupKey];
      if (!group) continue;
      updatedItems[groupKey] = group.map((item) => {
        const inferred = result.profitsByItemId[item.id];
        if (!inferred) return item;
        const metric = currentSummary.metricsById[item.id];
        const profitFxRateToCny = metric?.profitFxRateToCny || 1;
        const historicalProfit = inferred.value - (metric?.holdingProfitCny ?? 0) / profitFxRateToCny;
        return {
          ...item,
          historicalProfitCny: roundCny(historicalProfit),
          historicalProfitCurrency: inferred.currency,
          profitInputMode: 'historical',
        };
      });
    }
    const updatedSummary = summarizeInvestPositionItems(updatedItems);
    const isAuto = isInvestAccumulatedProfitAuto(yearMonth, useConfigStore.getState().config.investAutoSumStartMonth);
    monthlyStore.upsert({
      ...currentRecord,
      investPositionItems: updatedItems,
      investTotal: updatedSummary.totalMarketValueCny,
      investBreakdown: updatedSummary.marketValueByCategory,
      investBreakdownProfit: updatedSummary.holdingProfitByCategory,
      investBreakdownPastProfit: updatedSummary.historicalProfitByCategory,
      accumulatedProfit: updatedSummary.totalProfitCny,
      manualAccumulatedProfit: isAuto
        ? currentRecord.manualAccumulatedProfit
        : updatedSummary.totalProfitCny,
      investmentEditedAt: new Date().toISOString(),
      investmentRolledOverFrom: undefined,
    }, { investmentSource: 'manual' });
    void triggerUpload();
    return `已推算 ${Object.keys(result.profitsByItemId).length} 个条目 · ${result.transactionCount} 笔变动`;
  };
  const derivedExpenseForYearMonth = useMemo(
    () => aggregateExpenseItems(billExpenseItems[yearMonth] ?? []),
    [billExpenseItems, yearMonth],
  );
  const prevForYearMonth     = records.find((r) => r.yearMonth === prevYearMonth(yearMonth));
  const years = useMemo(() => {
    const map: Record<string, MonthlyRecord[]> = {};
    for (const r of records) {
      const y = r.yearMonth.slice(0, 4);
      if (!map[y]) map[y] = [];
      map[y].push(r);
    }
    return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]));
  }, [records]);
  const averageAnnualizedRate = useMemo(() => getAverageAnnualizedRate(records), [records]);
  const groupAverageAnnualizedRates = useMemo(() => INVESTMENT_GROUPS.map((group) => ({
    ...group,
    rate: getGroupAverageAnnualizedRate(records, group.keys),
  })), [records]);
  const stockAverageAnnualizedRates = useMemo(() => STOCK_MARKETS.map((market) => ({
    ...market,
    rate: getGroupAverageAnnualizedRate(records, [market.key]),
  })), [records]);
  const allBillStatisticItems = useBillStatisticItems();
  const tripFilterLayoutOpen = tripFilterPanelOpen && !!activeTripFilterTag;

  // 快捷跳转面板可选年份：最早记录年 → 当前查看年与今年的较大者
  const yearOptions = useMemo(() => {
    const earliest = records.length
      ? parseInt(records[records.length - 1].yearMonth.slice(0, 4), 10)
      : _now.getFullYear();
    const latest = Math.max(_now.getFullYear(), year);
    return Array.from({ length: latest - earliest + 1 }, (_, i) => earliest + i);
  }, [records, year, _now]);

  const tableHeader = (
    <div style={{ marginBottom: 4 }}>
      {yearProfitMode === 'rate' && (
        <div aria-label="平均年化收益率" style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '4px 12px', padding: '0 10px', fontSize: 10, fontWeight: 600, marginBottom: 2 }}>
          <span style={{ color: averageAnnualizedRate !== null ? (averageAnnualizedRate >= 0 ? C.red : C.green) : C.sub, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            平均年化 {averageAnnualizedRate !== null ? `${(averageAnnualizedRate * 100).toFixed(1)}%` : '—'}
          </span>
          {groupAverageAnnualizedRates.map(({ label, title, rate }) => (
            <span key={label} aria-label={`${label}平均年化`} title={title} style={{ color: rate !== null ? (rate >= 0 ? C.red : C.green) : C.sub, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {label} {rate !== null ? `${(rate * 100).toFixed(1)}%` : '—'}
              {label === '股' && (
                <span>（{stockAverageAnnualizedRates.map((market, index) => (
                  <span key={market.key} style={{ color: market.rate !== null ? (market.rate >= 0 ? C.red : C.green) : C.sub }}>
                    {index > 0 ? ' ' : ''}{market.label}{market.rate !== null ? `${(market.rate * 100).toFixed(1)}%` : '—'}
                  </span>
                ))}）</span>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="history-grid-heading" style={{ display: 'grid', gridTemplateColumns: HISTORY_GRID_COLUMNS, padding: '6px 10px', fontSize: 11, color: C.sub, fontWeight: 500 }}>
        <span>年/月</span>
        <span style={{ textAlign: 'right' }}>收入</span>
        <span style={{ textAlign: 'right' }}>支出</span>
        <span style={{ textAlign: 'right' }}>结余</span>
        <span style={{ textAlign: 'right' }}>存下</span>
        <button
          type="button"
          onClick={toggleYearProfitMode}
          title={yearProfitMode === 'rate' ? '点击切换为收益金额' : '点击切换为收益率'}
          style={{ textAlign: 'right', color: C.sub, font: 'inherit', fontWeight: 500, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}
        >
          {yearProfitMode === 'rate' ? '收益率' : '收益'}
        </button>
      </div>
    </div>
  );

  // 从"年"跳转到"月"并定位到指定月份
  const handleJumpToMonth = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    setYear(y);
    setMonth(m - 1);
    setTab('month');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className={`calendar-page-shell${tab === 'month' && tripFilterLayoutOpen ? ' calendar-page-shell--split' : ''}`}>
      {/* 不设置 accept，避免微信将混合文件类型的选择入口限制为拍摄和相册；格式在选取后校验。 */}
      <input ref={billFileRef} type="file" style={{ display: 'none' }} onChange={handleBillFile} />
      {/* 页头 + 胶囊切换 */}
      <div className="calendar-page-header" style={{ margin: '0 0 16px' }}>
        <div className="calendar-header-toolbar">
          <h1 style={{ fontSize: 'clamp(18px, 4.8vw, 22px)', fontWeight: 700, margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {tab === 'month' ? 'boncal' : '历史记录'}
          </h1>
          <div className="calendar-header-actions">
            <div className="calendar-header-imports">
              <button
                type="button"
                onClick={backupCurrentVersion}
                disabled={backupCreating}
                title="备份当前版本"
                style={{ fontSize: 11, lineHeight: 1, padding: '4px clamp(5px, 1.5vw, 7px)', borderRadius: 7, border: `1px solid ${C.border}`, backgroundColor: backupCreating ? '#f1f3f4' : '#fff', color: backupCreating ? '#9aa0a6' : C.sub, cursor: backupCreating ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
              >
                {backupCreating ? '备份中' : '备份'}
              </button>
              <button
                onClick={() => billFileRef.current?.click()}
                disabled={billImporting}
                title="手动选择账单、图片或理财文件"
                style={{ fontSize: 11, lineHeight: 1, padding: '4px clamp(5px, 1.5vw, 7px)', borderRadius: 7, border: `1px solid ${C.border}`, backgroundColor: '#fff', color: billImporting ? '#9aa0a6' : C.sub, cursor: billImporting ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
              >
                本地
              </button>
            </div>
            <div className="calendar-header-views" role="group" aria-label="记录视图" style={{ display: 'flex', backgroundColor: '#e8eaed', borderRadius: 20, padding: 3, gap: 2, flexShrink: 0 }}>
              {(['month', 'year'] as const).map((t) => {
                const active = tab === t;
                return (
                  <button key={t} aria-pressed={active} onClick={() => setTab(t)} style={{
                    padding: '5px clamp(9px, 3vw, 14px)', borderRadius: 16, border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600,
                    backgroundColor: active ? '#fff' : 'transparent',
                    color: active ? C.blue : C.sub,
                    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.15)' : 'none',
                    transition: 'all 0.15s',
                  }}>
                    {t === 'month' ? '月' : '年'}
                  </button>
                );
              })}
            </div>
            <button onClick={() => {
              setThresholdInput(String(config.majorExpenseThreshold ?? 500));
              setAutoSumStartMonthInput(config.investAutoSumStartMonth ?? '');
              setSettingsOpen(true);
            }}
              aria-label="设置"
              style={{ fontSize: 16, background: 'none', border: 'none', cursor: 'pointer', padding: '4px clamp(2px, 1.5vw, 6px)', color: C.sub, lineHeight: 1, flexShrink: 0 }}>
              ⚙️
            </button>
          </div>
        </div>
        {billImportMsg && (
          <div role="status" title={billImportMsg} style={{ marginTop: 6, fontSize: 11, lineHeight: 1.35, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' }}>
            {billImportMsg}
          </div>
        )}
      </div>
      {holidayWarning && (
        <div className="calendar-page-header" style={{ margin: '0 0 16px', fontSize: 12, color: C.orange, backgroundColor: '#fff4e8', border: '1px solid #fed7aa', borderRadius: 10, padding: '8px 10px' }}>
          {holidayWarning}
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          syncControls={tab === 'month' ? <>
            <OutlookCalendarSyncControl sync={outlookSync} />
            <TickTickTripSyncControl />
          </> : undefined}
          thresholdInput={thresholdInput}
          setThresholdInput={setThresholdInput}
          autoSumStartMonthInput={autoSumStartMonthInput}
          setAutoSumStartMonthInput={setAutoSumStartMonthInput}
          selectedYearMonth={yearMonth}
          today={today}
          investmentProfitBaseline={config.investmentProfitBaseline}
          onSetInvestmentProfitBaseline={setInvestmentProfitBaseline}
          onInferInvestmentProfit={inferSelectedMonthInvestmentProfit}
          reviewableCategories={reviewableCategories}
          setReviewableCategories={setReviewableCategories}
          expenseScopeHelpText={expenseScopeHelpText}
          setExpenseScopeHelpText={setExpenseScopeHelpText}
          onSave={() => {
            const investAutoSumStartMonth = /^\d{4}-\d{2}$/.test(autoSumStartMonthInput)
              ? autoSumStartMonthInput
              : undefined;
            useMonthlyStore.setState({
              records: applyInvestAutoSumStartMonth(records, investAutoSumStartMonth),
            });
            setConfig({
              majorExpenseThreshold: parseFloat(thresholdInput) || 500,
              investAutoSumStartMonth,
            });
            setSettingsOpen(false);
          }}
          tagMap={tagMap}
          confirmedExpenses={confirmedExpenses}
          expenseItems={billExpenseItems}
          overrides={expenseScopeOverrides}
          setOverride={setExpenseScopeOverride}
        />
      )}

      {tab === 'month' ? (
        /* ── 统计月：日历标记 ── */
        <div className="calendar-month-grid">
          <div>
          {/* 月份导航（sticky） */}
          <div style={{
            position: 'sticky', top: 0, zIndex: 10,
            backgroundColor: '#f0f2f5',
            paddingTop: 8, paddingBottom: 8,
            marginBottom: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }} ref={pickerRef}>
              <button onClick={prevMonth} style={navBtnStyle}>‹</button>
              <button
                onClick={() => setPickerOpen((v) => !v)}
                style={{ fontSize: 16, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 10px', borderRadius: 8, color: pickerOpen ? C.blue : '#202124' }}
              >
                {CN_MONTH[month]} {year}
              </button>
              <button onClick={nextMonth} style={navBtnStyle}>›</button>
              {pickerOpen && (
                <div style={{
                  position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                  marginTop: 6, zIndex: 20,
                  backgroundColor: '#fff', borderRadius: 12, padding: 12,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', border: '1px solid #e8eaed',
                  minWidth: 260,
                }}>
                  {/* 年份行 */}
                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid #f1f3f4' }}>
                    {yearOptions.map((y) => {
                      const active = y === year;
                      return (
                        <button
                          key={y}
                          onClick={() => setYear(y)}
                          style={{
                            flexShrink: 0, padding: '4px 10px', borderRadius: 16,
                            border: 'none', cursor: 'pointer', fontSize: 13,
                            backgroundColor: active ? C.blue : '#f1f3f4',
                            color: active ? '#fff' : C.sub,
                            fontWeight: active ? 600 : 400,
                          }}
                        >
                          {y}
                        </button>
                      );
                    })}
                  </div>
                  {/* 月份网格 3×4 */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                    {CN_MONTH.map((name, i) => {
                      const active = i === month;
                      return (
                        <button
                          key={i}
                          onClick={() => { cancelRange(); setSelectedDay(null); setMonth(i); setPickerOpen(false); }}
                          style={{
                            padding: '8px 0', borderRadius: 8,
                            border: 'none', cursor: 'pointer', fontSize: 13,
                            backgroundColor: active ? C.blue : '#f8f9fa',
                            color: active ? '#fff' : '#202124',
                            fontWeight: active ? 600 : 400,
                          }}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 本月统计 */}
          <Card title="本月统计" subtitle={`${yearMonth} · 已标记 ${stats.tagged}/${stats.total}`}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <colgroup>
                <col style={{ width: '20%' }} />
                <col />
                <col style={{ width: '24px' }} />
                <col style={{ width: '68px' }} />
                <col style={{ width: '68px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  <th />
                  <th />
                  <th style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', paddingBottom: 4 }}>
                    <span style={{ backgroundColor: 'rgba(26,115,232,0.12)', color: C.blue, borderRadius: 6, padding: '2px 6px' }}>生活/天</span>
                  </th>
                  <th style={{ fontSize: 11, fontWeight: 600, textAlign: 'right', paddingBottom: 4, paddingLeft: 6 }}>
                    <span style={{ backgroundColor: 'rgba(124,58,237,0.12)', color: C.purple, borderRadius: 6, padding: '2px 6px' }}>消费/天</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // 当月实际总支出
                  const totalLife = existingForYearMonth
                    ? ((existingForYearMonth.periodicLife + existingForYearMonth.volatileLife) || (derivedExpenseForYearMonth.periodicLife + derivedExpenseForYearMonth.volatileLife))
                    : (derivedExpenseForYearMonth.periodicLife + derivedExpenseForYearMonth.volatileLife);
                  const totalCons = existingForYearMonth
                    ? (existingForYearMonth.consumption || derivedExpenseForYearMonth.consumption)
                    : derivedExpenseForYearMonth.consumption;

                  const wLife = historyStats.stateDailyAvg;
                  const wCons = historyStats.stateConsumptionDailyAvg;
                  const TAG_KINDS = ['school','intern','home','travel'] as TagKind[];

                  // 把当月已勾选的"确切支出"按 状态 × 类型(life/cons) 聚合
                  // 状态来自 tagMap[date]；无标签的勾选忽略（不进入估算）
                  // 类型分类：tags 含 周期生活|波动生活 → life；含 消费 → cons；都不含则忽略
                  const monthItems = billExpenseItems[yearMonth] ?? [];
                  const itemsById = new Map<string, BillExpenseItem>();
                  for (const day of Object.keys(confirmedExpenses)) {
                    if (!day.startsWith(yearMonth)) continue;
                    const dayItems = assignExpenseIds(monthItems.filter((it) => it.date === day));
                    for (const { item, id } of dayItems) itemsById.set(`${day}|${id}`, item);
                  }
                  const confirmedLifeByState: Record<TagKind, number> = { school: 0, intern: 0, home: 0, travel: 0 };
                  const confirmedConsByState: Record<TagKind, number> = { school: 0, intern: 0, home: 0, travel: 0 };
                  const confirmedDaysByState: Record<TagKind, number> = { school: 0, intern: 0, home: 0, travel: 0 };
                  for (const [day, selection] of Object.entries(confirmedExpenses)) {
                    if (!day.startsWith(yearMonth)) continue;
                    const tag = tagMap[day];
                    if (!tag) continue; // 未标记的天不参与状态聚合
                    const normalized = normalizeConfirmedSelection(selection);
                    const travelSet = new Set(normalized.travelIds ?? []);
                    for (const id of normalized.localIds) {
                      const item = itemsById.get(`${day}|${id}`);
                      if (!item) continue;
                      const tags = item.tags.split(',').map(t => t.trim());
                      const localState: TagKind = travelSet.has(id) ? 'travel' : tag;
                      if (tags.includes('周期生活') || tags.includes('波动生活')) {
                        confirmedLifeByState[localState] += item.amount;
                      } else if (tags.includes('消费')) {
                        confirmedConsByState[localState] += item.amount;
                      }
                    }
                    if (normalized.reviewed) confirmedDaysByState[tag] += 1;
                  }

                  // 剩余预算（不动 totalLife / totalCons 本身）
                  const confirmedLifeAll = TAG_KINDS.reduce((s, k) => s + confirmedLifeByState[k], 0);
                  const confirmedConsAll = TAG_KINDS.reduce((s, k) => s + confirmedConsByState[k], 0);
                  const remainLife = Math.max(0, totalLife - confirmedLifeAll);
                  const remainCons = Math.max(0, totalCons - confirmedConsAll);

                  // 剩余加权基数（仅未确切的天）
                  const remainDenomLife = TAG_KINDS.reduce((s, k) => s + Math.max(0, statsToDate[k] - confirmedDaysByState[k]) * wLife[k], 0);
                  const remainDenomCons = TAG_KINDS.reduce((s, k) => s + Math.max(0, statsToDate[k] - confirmedDaysByState[k]) * wCons[k], 0);

                  return tagOrder.map((t) => {
                  const meta  = tagMeta[t];
                  const count = stats.counts[t];
                  const countToDate = statsToDate[t];
                  const pct   = stats.total > 0 ? (count / stats.total) * 100 : 0;
                  const cd = confirmedDaysByState[t];
                  const remainDays = Math.max(0, countToDate - cd);
                  // 未确切日均（沿用比例分配）
                  const estUnconfirmedLife = remainDenomLife > 0 ? wLife[t] * remainLife / remainDenomLife : 0;
                  const estUnconfirmedCons = remainDenomCons > 0 ? wCons[t] * remainCons / remainDenomCons : 0;
                  // 展示日均 = (确切总额 + 估算未确切部分) / 该状态总天数
                  const avgLife = countToDate > 0 ? (confirmedLifeByState[t] + estUnconfirmedLife * remainDays) / countToDate : 0;
                  const avgCons = countToDate > 0 ? (confirmedConsByState[t] + estUnconfirmedCons * remainDays) / countToDate : 0;
                  const fmtLife = (v: number) => v > 0
                    ? <span style={{ backgroundColor: 'rgba(26,115,232,0.08)', color: C.blue, borderRadius: 6, padding: '2px 6px', display: 'inline-block' }}>¥{Math.round(v)}</span>
                    : <span style={{ color: '#dadce0' }}>—</span>;
                  const fmtCons = (v: number) => v > 0
                    ? <span style={{ backgroundColor: 'rgba(124,58,237,0.08)', color: C.purple, borderRadius: 6, padding: '2px 6px', display: 'inline-block' }}>¥{Math.round(v)}</span>
                    : <span style={{ color: '#dadce0' }}>—</span>;
                  const anchor = cd > 0 ? <span style={{ fontSize: 10, color: C.sub, marginLeft: 4 }}>📌{cd}</span> : null;
                  return (
                    <tr key={t}>
                      <td style={{ padding: '6px 0', color: C.sub }}>{meta.icon} {meta.label}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <div style={{ height: 8, backgroundColor: '#e8eaed', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, backgroundColor: meta.color, borderRadius: 4, transition: 'width 0.3s' }} />
                        </div>
                      </td>
                      <td style={{ padding: '6px 0', textAlign: 'right', fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: C.sub }}>{count}</td>
                      <td style={{ padding: '6px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{fmtLife(avgLife)}{anchor}</td>
                      <td style={{ padding: '6px 0 6px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{fmtCons(avgCons)}</td>
                    </tr>
                  );
                  });
                })()}
              </tbody>
            </table>
            {(() => {
              const schoolSpend = existingForYearMonth?.school || derivedExpenseForYearMonth.school;
              const schoolDays = statsToDate.school;
              if (schoolDays > 0 && schoolSpend > 0) {
                const campusDailyAvg = schoolSpend / schoolDays;
                return (
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '8px 12px', backgroundColor: '#f0f7ff', borderRadius: 10 }}>
                    <span style={{ color: C.sub }}>🍜 校园卡日均</span>
                    <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: C.blue }}>¥{Math.round(campusDailyAvg)}</span>
                  </div>
                );
              }
              return null;
            })()}
            {(() => {
              const source = billTagStats;
              const ts = source[yearMonth];
              if (!ts) return null;
              const totalExpense = existingForYearMonth?.totalExpense ?? 0;
              const eatAvg = ts.eatDrinkCount > 0 ? ts.eatDrinkAmount / ts.eatDrinkCount : 0;
              const redPct = totalExpense > 0 ? (ts.redAmount / totalExpense) * 100 : 0;
              const blackPct = totalExpense > 0 ? (ts.blackAmount / totalExpense) * 100 : 0;
              const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '6px 12px', borderRadius: 10, marginTop: 6, cursor: 'pointer', userSelect: 'none' };
              const toggle = (key: 'eat' | 'red' | 'black') => setExpandedTag(prev => prev === key ? null : key);
              const caret = (open: boolean) => <span style={{ fontSize: 10, color: C.sub, marginLeft: 4 }}>{open ? '▾' : '▸'}</span>;
              const renderItems = (items: BillItem[]) => (
                <div style={{ margin: '2px 12px 6px', fontSize: 12 }}>
                  {items.map((it, i) => {
                    const info = extractMeaningful(it.tags, it.note);
                    const cat = it.subcategory ? `${it.category}·${it.subcategory}` : it.category;
                    return (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, padding: '4px 0', borderBottom: '1px dashed #eee' }}>
                        <span style={{ color: C.sub, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{it.date.slice(5)}</span> · {cat}
                          {info && <span style={{ color: '#9aa0a6', marginLeft: 6 }}>{info}</span>}
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>¥{formatCurrency(it.amount)}</span>
                      </div>
                    );
                  })}
                </div>
              );
              return (
                <>
                  {ts.eatDrinkCount > 0 && (
                    <>
                      <div style={{ ...rowStyle, backgroundColor: '#fff7ed' }} onClick={() => toggle('eat')}>
                        <span style={{ color: C.sub }}>🍽️ 吃好喝好 <span style={{ fontSize: 11 }}>({ts.eatDrinkCount} 顿)</span>{caret(expandedTag === 'eat')}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: '#c2410c' }}>
                          ¥{formatCurrency(ts.eatDrinkAmount)} · <span style={{ fontWeight: 600 }}>均 ¥{Math.round(eatAvg)}/顿</span>
                        </span>
                      </div>
                      {expandedTag === 'eat' && renderItems(ts.eatDrinkItems)}
                    </>
                  )}
                  {ts.redAmount > 0 && (
                    <>
                      <div style={{ ...rowStyle, backgroundColor: '#fef2f2' }} onClick={() => toggle('red')}>
                        <span style={{ color: C.sub }}>🔴 红{caret(expandedTag === 'red')}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: C.red }}>
                          ¥{formatCurrency(ts.redAmount)} · <span style={{ fontWeight: 600 }}>{redPct.toFixed(1)}%</span>
                        </span>
                      </div>
                      {expandedTag === 'red' && renderItems(ts.redItems)}
                    </>
                  )}
                  {ts.blackAmount > 0 && (
                    <>
                      <div style={{ ...rowStyle, backgroundColor: '#f3f4f6' }} onClick={() => toggle('black')}>
                        <span style={{ color: C.sub }}>⚫ 黑{caret(expandedTag === 'black')}</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: '#1f2937' }}>
                          ¥{formatCurrency(ts.blackAmount)} · <span style={{ fontWeight: 600 }}>{blackPct.toFixed(1)}%</span>
                        </span>
                      </div>
                      {expandedTag === 'black' && renderItems(ts.blackItems)}
                    </>
                  )}
                </>
              );
            })()}
            {billExpenseItems[yearMonth] && billExpenseItems[yearMonth]!.length > 0 && (
              <CategoryBreakdown items={billExpenseItems[yearMonth]!} />
            )}
            {stats.tagged < stats.total && (
              <div style={{ marginTop: 12, fontSize: 13, color: C.orange, backgroundColor: '#fef7e0', border: '1px solid #fdd663', borderRadius: 12, padding: '10px 14px' }}>
                💡 还有 {stats.total - stats.tagged} 天未标记
              </div>
            )}
          </Card>

          {/* 月度数据 / 大额支出 / 各品类持仓 三张卡片 */}
          <MonthFormCards
            key={`${syncRevision}:${yearMonth}:${existingForYearMonth?.lastInvestmentMailUid ?? 0}:${existingForYearMonth?.importedInvestmentTransactionIds?.length ?? 0}:${existingForYearMonth?.investmentInheritanceRevision ?? 0}`}
            yearMonth={yearMonth}
            existing={existingForYearMonth}
            prevRecord={prevForYearMonth}
            allRecords={records}
            tagCounts={countByTag(yearMonth)}
            expenseItems={billExpenseItems[yearMonth]}
            onSave={(r, investmentSource) => upsert(r, { investmentSource })}
            subtitle={existingForYearMonth ? '已有数据，可修改' : '尚未录入'}
          />

          {/* Tag 选择器 */}
          <div className="calendar-tag-toolbar">
            <div style={{ display: 'flex', flexShrink: 0, gap: 0, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <button type="button" aria-pressed={selectMode !== 'detail'}
                onClick={() => switchMode(selectMode === 'single' ? 'range' : 'single')}
                style={{ padding: '6px 16px', fontSize: 13, border: 'none', cursor: 'pointer', backgroundColor: selectMode !== 'detail' ? C.blue : '#fff', color: selectMode !== 'detail' ? '#fff' : C.sub }}>
                {selectMode === 'range' ? '起止' : '单击'}
              </button>
            </div>
            {tagOrder.map((t, i) => {
              const meta    = tagMeta[t];
              const isRest = t === 'school' && awayInternshipMonth;
              const label = isRest ? '休' : meta.label;
              const active = selectMode !== 'detail' && selectedTag === t;
              const dragging = tagDrag.draggingIdx === i;
              const hp      = tagDrag.handleProps(i);
              return (
                <button key={t} ref={(el) => tagDrag.itemRef(el, i)} {...hp}
                  type="button" className="calendar-tag-button" aria-label={label} title={label} aria-pressed={active}
                  onClick={() => { setSelectedTag(t); switchMode('single'); }}
                  style={{ ...hp.style, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, borderRadius: 20, fontSize: 13, border: active ? `2px solid ${meta.color}` : `1px solid ${C.border}`, backgroundColor: active ? `${meta.color}18` : '#ffffff', color: active ? meta.color : C.sub, fontWeight: active ? 600 : 400, cursor: 'pointer', opacity: dragging ? 0.5 : 1, transition: 'opacity 0.15s' }}
                >
                  <span aria-hidden="true">{isRest ? '☕' : meta.icon}</span>
                  <span className="calendar-tag-label" aria-hidden="true">{label}</span>
                </button>
              );
            })}
          </div>

          {/* 周模板 */}
          <div style={{ marginBottom: 12 }}>
            <button onClick={() => setShowWeekTemplate((v) => !v)}
              style={{ fontSize: 13, color: C.blue, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600, marginBottom: showWeekTemplate ? 8 : 0 }}
            >
              {showWeekTemplate ? '▾' : '▸'} 按周模板
            </button>
            {showWeekTemplate && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 8 }}>
                  {([1,2,3,4,5,6,0] as number[]).map((dow, colIdx) => {
                    const LABELS = ['一','二','三','四','五','六','日'];
                    const tag    = weekdayTags[dow];
                    const meta   = tag ? tagMeta[tag] : null;
                    const isWknd = dow === 0 || dow === 6;
                    return (
                      <button key={dow} onClick={() => cycleWeekday(dow)} style={{ borderRadius: 8, padding: '6px 0', fontSize: 12, border: `1.5px solid ${meta ? meta.color : C.border}`, backgroundColor: meta ? `${meta.color}18` : '#f8f9fa', color: meta ? meta.color : isWknd ? C.weekend : C.sub, fontWeight: meta ? 600 : 400, cursor: 'pointer', textAlign: 'center' }}>
                        <div style={{ fontSize: 10, marginBottom: 2, color: isWknd ? C.weekend : C.sub }}>{LABELS[colIdx]}</div>
                        <div>{meta ? meta.icon : '—'}</div>
                      </button>
                    );
                  })}
                </div>
                <button onClick={applyWeekdayTemplate} style={{ width: '100%', padding: '8px 0', fontSize: 13, fontWeight: 600, color: '#fff', backgroundColor: C.blue, border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                  应用到 {CN_MONTH[month]} 全月
                </button>
              </div>
            )}
          </div>

          {/* 明细与待分类 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => switchMode('detail')}
              aria-pressed={selectMode === 'detail'}
              style={{ padding: '6px 16px', fontSize: 13, borderRadius: 10, border: `1px solid ${selectMode === 'detail' ? C.blue : C.border}`, cursor: 'pointer', backgroundColor: selectMode === 'detail' ? C.blue : '#fff', color: selectMode === 'detail' ? '#fff' : C.sub, fontWeight: selectMode === 'detail' ? 600 : 400 }}
            >
              明细
            </button>
            <button
              onClick={() => setShowPendingPanel((v) => !v)}
              title="集中处理所有未被规则覆盖的待手动分类账单"
              style={{
                padding: '6px 14px', fontSize: 13, borderRadius: 10, cursor: 'pointer', fontWeight: 600,
                border: `1px solid ${pendingManualEntries.length > 0 ? '#fdba74' : C.border}`,
                backgroundColor: showPendingPanel ? '#fff7ed' : '#fff',
                color: pendingManualEntries.length > 0 ? C.orange : C.sub,
              }}
            >
              待分类 {pendingManualEntries.length}
            </button>
          </div>

          {selectMode === 'range' && (
            <div style={{ fontSize: 13, color: rangeStart ? C.blue : C.sub, backgroundColor: rangeStart ? '#e8f0fe' : '#f8f9fa', border: `1px solid ${rangeStart ? '#a8c7fa' : C.border}`, borderRadius: 10, padding: '8px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{rangeStart ? `已选起点 ${rangeStart}，点击终点日期` : '点击起点日期'}</span>
              {rangeStart && <button onClick={cancelRange} style={{ fontSize: 12, color: C.sub, border: 'none', background: 'none', cursor: 'pointer' }}>✕ 取消</button>}
            </div>
          )}

          {selectMode === 'detail' && (
            <div style={{ fontSize: 13, color: C.sub, backgroundColor: '#f0f7ff', border: '1px solid #a8c7fa', borderRadius: 10, padding: '8px 14px', marginBottom: 12 }}>
              点击日期查看当日账单，勾选确切支出；也可以直接记为 0 支出，用于优化日均估算
            </div>
          )}

          {showPendingPanel && (
            <PendingManualPanel
              entries={pendingManualEntries}
              onSetScope={(date, id, scope) => setConfirmedExpenseScope(date, id, scope)}
              onClose={() => setShowPendingPanel(false)}
            />
          )}

          {/* 月历 */}
          <div id="month-calendar" style={{ scrollMarginTop: 58 }}>
            <Card>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginBottom: 5, fontSize: 9, color: C.sub }}>
              <span><span style={{ marginRight: 3, borderRadius: 4, padding: '1px 3px', backgroundColor: HOLIDAY_COLORS.off.background, color: HOLIDAY_COLORS.off.color, fontWeight: 700 }}>休</span>法定节假日</span>
              <span><span style={{ marginRight: 3, borderRadius: 4, padding: '1px 3px', backgroundColor: HOLIDAY_COLORS.work.background, color: HOLIDAY_COLORS.work.color, fontWeight: 700 }}>·</span>调休工作日</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4, textAlign: 'center', fontSize: 11, marginBottom: 4, fontWeight: 500 }}>
              {WEEK_HEADERS.map((w, i) => <div key={w} style={{ color: (i === 5 || i === 6) ? C.weekend : C.sub }}>{w}</div>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
              {cells.map((cell) => {
                if (cell.day === null) return <div key={cell.key} style={{ aspectRatio: '1' }} />;
                const tag = tagMap[cell.key];
                const isToday    = cell.key === today;
                const weekend    = isWeekend(cell.key);
                const holiday = holidayDataByYear[year]?.[cell.key];
                const isStatutoryHoliday = holiday?.isOffDay === true;
                // 接口也包含“小年”等普通工作日纪念日；只有周末被指定上班才属于调休。
                const isAdjustedWorkday = holiday?.isOffDay === false && weekend;
                const holidayMarker = isStatutoryHoliday ? '休' : isAdjustedWorkday ? '班' : null;
                const isPayrollCutoff = payrollCutoffDates.includes(cell.key);
                const isRangeStart = cell.key === rangeStart;
                const isSelectedDay = cell.key === selectedDay;
                const inPreview  = previewRange.has(cell.key);
                const dailyContext = resolveDailyContext(cell.key, tag, internship);
                const displayTag = inPreview ? selectedTag : tag ? calendarVisualTag(dailyContext) : undefined;
                const displayRest = inPreview ? selectedTag === 'school' && dailyContext.awayInternship : dailyContext.livingKind === 'rest';
                const displayMeta = displayTag ? tagMeta[displayTag] : null;
                const confirmedState = normalizeConfirmedSelection(confirmedExpenses[cell.key]);
                const hasReviewed = confirmedState.reviewed;
                const hasConfirmed = confirmedState.localIds.length > 0 || (confirmedState.sharedIds?.length ?? 0) > 0;
                const isZeroConfirmed = hasReviewed && !hasConfirmed;
                let borderStyle = 'none';
                if (isToday || isRangeStart || isSelectedDay) borderStyle = `2px solid ${C.blue}`;
                else if (inPreview) borderStyle = `1.5px dashed ${C.blue}`;
                const weatherEntries = calendarWeather.days[cell.key] ?? [];
                const weatherTitle = weatherEntries.map(({ location, weather, stale }) => `${cityLabel(location)} · ${weather ? dailyWeatherLabel(weather) : '暂无天气'}${stale ? '（待更新）' : ''}`).join('；');
                const connect = tripConnect[cell.key];
                const travelColor = tagMeta.travel.color;
                const backgroundColor = displayMeta
                  ? `${displayMeta.color}20`
                  : isStatutoryHoliday
                    ? HOLIDAY_COLORS.off.cellBackground
                    : isAdjustedWorkday
                      ? HOLIDAY_COLORS.work.cellBackground
                      : '#f8f9fa';
                const textColor = displayMeta
                  ? displayMeta.color
                  : isStatutoryHoliday
                    ? HOLIDAY_COLORS.off.color
                    : isAdjustedWorkday
                      ? HOLIDAY_COLORS.work.color
                      : weekend
                        ? C.weekend
                      : '#202124';
                const radiusStyle: React.CSSProperties = connect
                  ? {
                      borderTopLeftRadius: connect.left ? 0 : 10,
                      borderBottomLeftRadius: connect.left ? 0 : 10,
                      borderTopRightRadius: connect.right ? 0 : 10,
                      borderBottomRightRadius: connect.right ? 0 : 10,
                    }
                  : { borderRadius: 10 };
                return (
                  <button key={cell.key}
                    onClick={() => handleCellClick(cell.key)}
                    onMouseEnter={() => { if (selectMode === 'range' && rangeStart) setRangeHover(cell.key); }}
                    aria-label={`${cell.key}，${dailyContext.livingKind === 'rest' ? '休息' : dailyContext.label}${weatherTitle ? `，${weatherTitle}` : ''}${holidayMarker ? `，${holiday?.name ?? '法定节假日'}，${holidayMarker === '休' ? '休假' : '调休上班'}` : ''}`}
                    title={[dailyContext.livingKind === 'rest' ? `${cityLabel(dailyContext.city)} · 休息` : dailyContext.label, holidayMarker ? `${holiday?.name ?? '法定节假日'} · ${holidayMarker === '休' ? '休假' : '调休上班'}` : '', weatherTitle].filter(Boolean).join('；') || undefined}
                    style={{ aspectRatio: '1', width: '100%', minWidth: 0, minHeight: 48, fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: borderStyle, backgroundColor, color: textColor, cursor: 'pointer', fontWeight: 500, transition: 'all 0.1s', outline: 'none', position: 'relative', ...radiusStyle }}
                  >
                    {connect?.right && (
                      <span style={{ position: 'absolute', right: -5, top: 0, bottom: 0, width: 5, backgroundColor: `${travelColor}20`, pointerEvents: 'none', zIndex: 1 }} />
                    )}
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '100%', alignItems: 'center', gap: 2 }}>
                      {cell.day}
                      <span aria-hidden="true" style={{ display: 'inline-flex', fontSize: 11, lineHeight: 1, opacity: weatherEntries.some((entry) => entry.stale) ? .5 : 1 }}>
                        {weatherEntries.slice(0, 2).map((entry, index) => <span key={index}>{weatherSymbol(entry.weather?.code)?.icon}</span>)}
                      </span>
                    </span>
                    {citySegmentLabels[cell.key] && <span style={{ fontSize: 9 }}>{citySegmentLabels[cell.key]}</span>}
                    {displayMeta && <span aria-hidden="true" style={{ fontSize: 8, marginTop: 1 }}>{displayRest ? '☕' : displayMeta.icon}</span>}
                    {(isPayrollCutoff || holidayMarker) && (
                      <span style={{ position: 'absolute', top: 2, right: 3, display: 'inline-flex', alignItems: 'center', gap: 1, pointerEvents: 'none', zIndex: 2 }}>
                        {isPayrollCutoff && <span style={{ fontSize: 8, fontWeight: 700, color: C.blue }}>截</span>}
                        {holidayMarker && (
                          <span style={{ borderRadius: 4, padding: '1px 2px', backgroundColor: holidayMarker === '休' ? HOLIDAY_COLORS.off.background : HOLIDAY_COLORS.work.background, color: holidayMarker === '休' ? HOLIDAY_COLORS.off.color : HOLIDAY_COLORS.work.color, fontSize: 8, lineHeight: 1.1, fontWeight: 800 }}>
                            {holidayMarker === '班' ? '·' : holidayMarker}
                          </span>
                        )}
                      </span>
                    )}
                    {hasReviewed && <span style={{ position: 'absolute', top: 3, left: 4, width: 5, height: 5, borderRadius: '50%', backgroundColor: isZeroConfirmed ? C.green : C.orange }} />}
                  </button>
                );
              })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 10, color: C.sub }}>
                {calendarWeather.error && <button type="button" disabled={calendarWeather.busy} onClick={calendarWeather.refresh} style={{ border: 0, background: 'none', color: C.sub, cursor: 'pointer', fontSize: 10 }}>天气重试</button>}
                <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>Open-Meteo</a>
              </div>
            </Card>
          </div>

          <TripsSection
            groups={tripGroupsThisMonth}
            allExpenseItems={billExpenseItems}
            tripTags={tripTags}
            tripNotes={tripNotes}
            tripSplits={tripSplits}
            activeTripStartDates={activeTripStartDates}
            activeTripStartDate={effectiveActiveTripStartDate}
            filterPanelOpen={tripFilterPanelOpen}
            onSetTripTag={setTripTag}
            onSetTripNote={setTripNote}
            onClearTripTag={(startDate) => {
              clearTripTag(startDate);
              if (effectiveActiveTripStartDate === startDate) setTripFilterPanelOpen(false);
            }}
            onToggleTripSplit={toggleTripSplit}
            onActivateTrip={setActiveTripStartDate}
            onToggleFilterPanel={(startDate) => {
              if (effectiveActiveTripStartDate === startDate) {
                setTripFilterPanelOpen((open) => !open);
                return;
              }
              setActiveTripStartDate(startDate);
              setTripFilterPanelOpen(true);
            }}
          />

          {selectMode === 'detail' && selectedDay && (() => {
            const selectedConfirmedState = normalizeConfirmedSelection(confirmedExpenses[selectedDay]);
            const allowedSet = new Set(reviewableCategories);
            const dayItems = (billExpenseItems[yearMonth] ?? []).filter((it) => {
              if (it.date !== selectedDay) return false;
              if (allowedSet.size === 0) return false;
              const tagList = (it.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
              return tagList.some((t) => allowedSet.has(t as ReviewableCategory));
            });
            return (
              <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: C.sub, margin: '12px 0' }}>
                <span>{(calendarWeather.days[selectedDay] ?? []).map(({ location, weather, stale }) => `${cityLabel(location)} ${weather ? `${weatherSymbol(weather.code)?.icon ?? ''} ${dailyWeatherLabel(weather)}` : '暂无天气'}${stale ? '（待更新）' : ''}`).join('；')}</span>
                <a href={`${APP_LINKS.clothes.url}?date=${selectedDay}`} style={{ color: C.blue }}>当天穿搭 ↗</a>
              </div>
              <InternshipDayEditor date={selectedDay} />
              <DayDetailPanel
                date={selectedDay}
                items={dayItems}
                selection={selectedConfirmedState}
                onSetScope={(id, scope) => setConfirmedExpenseScope(selectedDay, id, scope)}
                onMarkZero={() => markConfirmedExpenseZero(selectedDay)}
                onClear={() => clearConfirmedExpenseSelection(selectedDay)}
                resolveOverride={(it) => resolveExpenseScope(it, expenseScopeOverrides)}
              />
              </>
            );
          })()}
          </div>
          {tripFilterLayoutOpen && allBillStatisticItems.length > 0 && (
            <aside className="trip-filter-sidecar" aria-label={`${activeTripFilterTag} 出游筛选统计`}>
              <Card title="账单统计" subtitle={activeTripFilterTag}>
                <TagLogicStats key={activeTripFilterTag} items={allBillStatisticItems} initialTags={[activeTripFilterTag]} compact dailyAverageDays={activeTripFilterDays} />
              </Card>
            </aside>
          )}
        </div>
      ) : (
        /* ── 统计年：历史明细 ── */
        <>
          {/* 历史明细（按年展开） */}
          <Card title="历史明细" headerAction={
            <button
              type="button"
              aria-label="统计查找"
              title="统计查找"
              aria-expanded={historySearchOpen}
              aria-controls="history-statistics-search"
              onClick={() => setHistorySearchOpen((open) => !open)}
              style={{ width: 30, height: 30, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 8, backgroundColor: historySearchOpen ? '#ede9fe' : 'transparent', color: historySearchOpen ? C.purple : C.sub, cursor: 'pointer' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 5 5" />
              </svg>
            </button>
          }>
            <div id="history-statistics-search" role="region" aria-label="统计查找" hidden={!historySearchOpen} style={{ marginBottom: 14 }}>
              {allBillStatisticItems.length > 0
                ? <TagLogicStats items={allBillStatisticItems} />
                : <div style={{ color: C.sub, fontSize: 12 }}>暂无账单记录</div>}
            </div>
            {tableHeader}
            {years.map(([yr, recs]) => (
              <YearSection
                key={yr}
                year={yr}
                asOfDate={today}
                recs={recs}
                allRecords={records}
                yearProfitMode={yearProfitMode}
                onToggleYearProfitMode={toggleYearProfitMode}
                onJumpToMonth={handleJumpToMonth}
                expenseItemsByMonth={billExpenseItems}
              />
            ))}
          </Card>
        </>
      )}
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  width: 36, height: 36, borderRadius: '50%', backgroundColor: '#ffffff',
  border: '1px solid #e0e0e0', color: '#5f6368', fontSize: 18, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

function formatTripDateRange(startDate: string, endDate: string): string {
  const fmt = (d: string) => {
    const [, m, day] = d.split('-');
    return `${Number(m)}月${Number(day)}日`;
  };
  if (startDate === endDate) return fmt(startDate);
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

function TripsSection({
  groups,
  allExpenseItems,
  tripTags,
  tripNotes,
  tripSplits,
  activeTripStartDates,
  activeTripStartDate,
  filterPanelOpen,
  onSetTripTag,
  onSetTripNote,
  onClearTripTag,
  onToggleTripSplit,
  onActivateTrip,
  onToggleFilterPanel,
}: {
  groups: TripGroup[];
  allExpenseItems: Record<string, import('../utils/importBill').BillExpenseMonth>;
  tripTags: Record<string, string>;
  tripNotes: Record<string, string>;
  tripSplits: Record<string, true>;
  activeTripStartDates: ReadonlySet<string>;
  activeTripStartDate: string | null;
  filterPanelOpen: boolean;
  onSetTripTag: (startDate: string, tag: string) => void;
  onSetTripNote: (startDate: string, note: string) => void;
  onClearTripTag: (startDate: string) => void;
  onToggleTripSplit: (date: string) => void;
  onActivateTrip: (startDate: string) => void;
  onToggleFilterPanel: (startDate: string) => void;
}) {
  const flatItems = useMemo(() => flattenExpenseItems(allExpenseItems), [allExpenseItems]);
  const outlookTravelTitles = useCalendarStore((state) => state.outlookTravelTitles);
  if (groups.length === 0) return null;
  return (
    <Card title="本月出游">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {groups.map((g) => (
          <div key={g.rawDates[0]} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {g.rawDates.length >= 2 && (
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, fontSize: 11, color: '#5f6368' }}>
                {g.rawDates.map((d, i) => (
                  <span key={d} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <span style={{ padding: '2px 4px' }}>{Number(d.slice(-2))}日</span>
                    {i < g.rawDates.length - 1 && (() => {
                      const boundary = g.rawDates[i + 1];
                      const isSplit = !!tripSplits[boundary];
                      return (
                        <button
                          onClick={() => onToggleTripSplit(boundary)}
                          title={isSplit ? '取消切分（合并相邻段）' : '在此切开为两次出游'}
                          style={{
                            padding: '0 4px', fontSize: 13, lineHeight: 1,
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: isSplit ? '#ea4335' : '#bdc1c6',
                            fontWeight: isSplit ? 700 : 400,
                          }}
                        >
                          {isSplit ? '✂' : '─'}
                        </button>
                      );
                    })()}
                  </span>
                ))}
              </div>
            )}
            {g.trips.map((t) => {
              const tripDateSet = new Set(t.dates);
              const selectedTag = tripTags[t.startDate] ?? '';
              const excludeTags = getActiveTripTagsExcept(tripTags, activeTripStartDates, t.startDate);
              const candidates = extractCandidateTags(flatItems, tripDateSet, excludeTags);
              const summary = selectedTag ? sumBillsByTag(flatItems, selectedTag) : null;
              const note = tripNotes[t.startDate] ?? '';
              const active = activeTripStartDate === t.startDate;
              const filterPanelOpenForTrip = active && filterPanelOpen;
              const optionTags = selectedTag && !candidates.some((c) => c.tag === selectedTag)
                ? [selectedTag, ...candidates.map((c) => c.tag)]
                : candidates.map((c) => c.tag);
              return (
                <div key={t.startDate} style={{ border: `${active ? 1.5 : 1}px solid ${tagMeta.travel.color}${active ? '99' : '40'}`, borderRadius: 10, padding: '10px 12px', backgroundColor: `${tagMeta.travel.color}${active ? '18' : '10'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: tagMeta.travel.color }}>
                      {tagMeta.travel.icon} {formatTripDateRange(t.startDate, t.endDate)} · {t.dates.length}天
                    </span>
                    {selectedTag && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="trip-filter-toggle"
                          onClick={() => onToggleFilterPanel(t.startDate)}
                          aria-expanded={filterPanelOpenForTrip}
                          title={filterPanelOpenForTrip ? '收回右侧筛选' : '在右侧展开筛选'}
                          style={{ fontSize: 11, lineHeight: 1, color: tagMeta.travel.color, background: '#fff', border: `1px solid ${tagMeta.travel.color}80`, borderRadius: 6, cursor: 'pointer', padding: '4px 6px', whiteSpace: 'nowrap' }}
                        >
                          {filterPanelOpenForTrip ? '收回筛选' : '展开筛选'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { onActivateTrip(t.startDate); onClearTripTag(t.startDate); }}
                          style={{ fontSize: 11, color: '#5f6368', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                        >
                          清除
                        </button>
                      </div>
                    )}
                  </div>
                  <select
                    value={selectedTag}
                    aria-label={`${formatTripDateRange(t.startDate, t.endDate)} 出游标签`}
                    onFocus={() => onActivateTrip(t.startDate)}
                    onChange={(e) => {
                      onActivateTrip(t.startDate);
                      const v = e.target.value;
                      if (v === '') onClearTripTag(t.startDate);
                      else onSetTripTag(t.startDate, v);
                    }}
                    style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid #dadce0', backgroundColor: '#fff', fontSize: 13, color: '#202124', cursor: 'pointer' }}
                  >
                    {!selectedTag && (
                      <option value="" disabled>{getTripDisplayTitle(undefined, t.dates, outlookTravelTitles) || '未选择'}</option>
                    )}
                    {optionTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                  </select>
                  {summary && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#202124' }}>
                      <span style={{ fontWeight: 600 }}>¥{formatCurrency(summary.totalAmount)}</span>
                      <span style={{ color: '#5f6368', marginLeft: 6 }}>· {summary.count} 条命中</span>
                    </div>
                  )}
                  <textarea
                    value={note}
                    aria-label={`${formatTripDateRange(t.startDate, t.endDate)} 出游备注`}
                    onFocus={() => onActivateTrip(t.startDate)}
                    onChange={(event) => onSetTripNote(t.startDate, event.target.value)}
                    onInput={(event) => {
                      const element = event.currentTarget;
                      element.style.height = 'auto';
                      element.style.height = `${element.scrollHeight}px`;
                    }}
                    ref={(element) => {
                      if (!element) return;
                      element.style.height = 'auto';
                      element.style.height = `${element.scrollHeight}px`;
                    }}
                    placeholder="备注（可选）"
                    rows={2}
                    style={{ width: '100%', minHeight: 34, marginTop: 8, padding: '6px 8px', borderRadius: 8, border: '1px solid #dadce0', backgroundColor: '#fff', color: '#202124', fontSize: 12, lineHeight: 1.4, resize: 'none', overflow: 'hidden', boxSizing: 'border-box' }}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}
