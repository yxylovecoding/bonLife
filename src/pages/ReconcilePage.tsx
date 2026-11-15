import { resolveDailyContext } from '../utils/internship';
import { InternshipPeriods } from '../components/InternshipSettings';
import { dailyLivingAmount } from '../utils/cityLiving';
import { useLifeCalendar } from '../hooks/useLifeCalendar';
import { Fragment, useEffect, useLayoutEffect, useState, useMemo, useRef, type PointerEvent } from 'react';
import { useSyncStatus } from '../utils/syncStatus';
import Card from '../components/Card';
import { formatCurrency } from '../components/CurrencyDisplay';
import AmountInput from '../components/AmountInput';
import SceneCityFields, { type SceneCitySettings } from '../components/SceneCityFields';
import SchoolPeriods from '../components/SchoolPeriods';

const fmtInt = (v: number) => Math.round(v).toLocaleString('zh-CN');
import { useSnapshotStore } from '../stores/snapshotStore';
import { DEFAULT_CONFIG, useConfigStore } from '../stores/configStore';
import { useMonthlyStore } from '../stores/monthlyStore';
import { useCalendarStore } from '../stores/calendarStore';
import { useBillDetailStore } from '../stores/billDetailStore';
import { useExpenseScopeOverrideStore } from '../stores/expenseScopeOverrideStore';
import { useTripStore } from '../stores/tripStore';
import { usePrefsStore } from '../stores/prefsStore';
import { budgetCalendarTags, calcBudget, rollBudgetMonths } from '../calculations/budget';
import { calculateLivingTransfer, calculateRaiseSavings, calculateTransferAllocation, resolveRaiseSavingsSettings, resolveRecurringIncomeBaseline, TRANSFER_KEYS, type TransferKey } from '../calculations/reconcileTransfers';
import { calcHistoryStats } from '../calculations/history';
import { calcAllocationRatios, calcRebalance, calcTopUpRebalance } from '../calculations/rebalance';
import { calcRemainingRecurringInvestments, deductRecurringInvestments, shouldCancelRecurringInvestment } from '../calculations/recurringInvestment';
import { investMeta, tagMeta } from '../data/mockData';
import type { AccountSnapshot, AppConfig, DailyTag, InvestAllocTargets, InvestHoldings, InvestKey, TagKind, UsStockHoldingItem } from '../models/types';
import { useHolidayYears } from '../utils/holidays';
import { normalizeDecimalPunctuation, sanitizeDecimalNumberInput } from '../utils/numberInput';
import { tryEvalFormula } from '../utils/formula';
import { dateLabel, formatDateKey, resolveAllIncomeForMonth, type ResolvedIncomeItem } from '../utils/payroll';
import {
  migrateLegacyInvestPositionItems,
  summarizeInvestPositionItems,
} from '../utils/investPositionItems';
import { calculateCreditRepaymentPlan, LONG_BOND_REPAY_THRESHOLD } from '../utils/creditRepayment';
import {
  FINANCE_SCREENSHOT_IMPORT_EVENT,
  type FinanceScreenshotImportEventDetail,
} from '../utils/financeScreenshotOcr';
import { pendingInvestmentAmounts } from '../utils/investmentRollover';
import { createManualBackup } from '../utils/syncEngine';
import {
  buildDramDecision,
  normalizeDramDecisionConfig,
  type DramDecisionKind,
  type MarketChartResponse,
} from '../utils/dramDecision';
import {
  calculatePortfolioBacktest,
  portfolioBacktestRequestUrl,
  PORTFOLIO_BACKTEST_REQUESTS,
  PORTFOLIO_BACKTEST_SOURCE_TITLE,
  type PortfolioBacktestSeriesId,
} from '../utils/portfolioBacktest';
const C = { blue: '#1a73e8', red: '#ea4335', green: '#0d9488', sub: '#5f6368', orange: '#e8710a' };
const INVEST_TARGET_KEYS: InvestKey[] = ['us', 'eu', 'asia', 'a', 'longBond', 'usBond', 'gold'];
const USD_INVEST_KEYS: InvestKey[] = ['us', 'usBond'];
const USD_VIRTUAL_ACCOUNT_KEYS = ['usdLivingBank', 'usdConsumptionBank', 'usdWishJar', 'investUsdBank'] as const;
const EMPTY_US_STOCK_ITEMS: UsStockHoldingItem[] = [];
const emptyInvestHoldings = (): InvestHoldings => Object.fromEntries(
  INVEST_TARGET_KEYS.map((key) => [key, 0]),
) as unknown as InvestHoldings;
type UsdVirtualAccountKey = typeof USD_VIRTUAL_ACCOUNT_KEYS[number];
const USD_REPLACE_BUCKETS: {
  usdKey: UsdVirtualAccountKey;
  cnyKey: keyof AccountSnapshot['accounts'];
  label: string;
}[] = [
  { usdKey: 'usdLivingBank', cnyKey: 'livingBank', label: '生活' },
  { usdKey: 'usdConsumptionBank', cnyKey: 'consumptionBank', label: '消费' },
  { usdKey: 'usdWishJar', cnyKey: 'wishJar', label: '心愿' },
];
type RebalanceFundingBucket = typeof USD_REPLACE_BUCKETS[number] & {
  amountCny: number;
};
// 配平转账的腿币种标注：cny/usd=假置换同步对敲、无手续费；forex=真换汇、有手续费
type FundingBadgeKind = 'cny' | 'usd' | 'forex';

const INVEST_GROUPS = [
  { key: 'stock', label: '股', keys: ['us', 'eu', 'asia', 'a'] as InvestKey[], color: C.blue },
  { key: 'bond', label: '债', keys: ['longBond', 'usBond'] as InvestKey[], color: C.green },
  { key: 'commodity', label: '商', keys: ['gold'] as InvestKey[], color: C.orange },
] as const;
type InvestGroupKey = typeof INVEST_GROUPS[number]['key'];
const INVEST_GROUP_TONES: Record<InvestGroupKey, { header: string; surface: string; border: string }> = {
  stock: { header: '#e8f0fe', surface: '#f7faff', border: '#d2e3fc' },
  bond: { header: '#e6f4ea', surface: '#f5fbf7', border: '#ceead6' },
  commodity: { header: '#fef7e0', surface: '#fffaf0', border: '#fde293' },
};
const INVEST_GROUP_WARNING_THRESHOLD = 0.1;
type GroupedTargetInputs = {
  groups: Record<InvestGroupKey, string>;
  assets: Record<InvestKey, string>;
};
type UsStockItemInput = {
  id: string;
  name: string;
  symbol: string;
  amountCny: string;
  shares: string;
  costPrice: string;
};
type UsdRateResponse = {
  rate: number;
  date: string;
  source: string;
};

const parseAmountPart = (raw: string | undefined) => {
  const value = raw?.trim() ?? '';
  if (!value) return 0;
  const evaluated = tryEvalFormula(value);
  const parsed = parseFloat(evaluated ?? value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeAmountInput = (v: string) => {
  const normalized = normalizeDecimalPunctuation(v);
  return /^-?0\d/.test(normalized) ? (normalized.replace(/^(-?)0+/, '$1') || '0') : normalized;
};
const fmtUsd = (value: number) => {
  const abs = Math.abs(value);
  const body = abs >= 100 ? Math.round(abs).toLocaleString('zh-CN') : abs.toFixed(2);
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}$${body}`;
};
const fmtDollar = (value: number) => `$${value >= 100 ? Math.round(value).toLocaleString('zh-CN') : value.toFixed(2)}`;
const fmtPct = (value: number | null, digits = 1) => value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
const roundMoney = (value: number) => Math.round(value * 100) / 100;

const latestMarketBar = (chart: MarketChartResponse | null | undefined) => {
  const bars = chart?.bars?.filter((bar) => Number.isFinite(Number(bar.adjClose ?? bar.close))) ?? [];
  return bars.length > 0 ? bars[bars.length - 1] : null;
};
const marketNowPrice = (chart: MarketChartResponse | null | undefined) => {
  const regularMarketPrice = Number(chart?.regularMarketPrice);
  if (Number.isFinite(regularMarketPrice) && regularMarketPrice > 0) return regularMarketPrice;
  const latestBar = latestMarketBar(chart);
  return latestBar ? Number(latestBar.adjClose ?? latestBar.close) : null;
};
const usStockCostAmountCny = (item: UsStockItemInput, usdRate: number | null) => {
  if (usdRate === null) return null;
  const shares = item.shares.trim() ? Math.max(0, parseAmountPart(item.shares)) : 0;
  const costPrice = item.costPrice.trim() ? Math.max(0, parseAmountPart(item.costPrice)) : 0;
  return shares > 0 && costPrice > 0 ? roundMoney(shares * costPrice * usdRate) : null;
};
const isSpyUsStockInput = (item: UsStockItemInput) =>
  item.symbol.trim().toUpperCase() === 'SPY' || item.name.trim() === '标普';
const syncSpyUsStockAmount = (items: UsStockItemInput[], usTotalCny: number) => {
  const spyIndex = items.findIndex(isSpyUsStockInput);
  if (spyIndex < 0) return items;
  const nonSpyTotal = items.reduce((sum, item, index) => (
    index === spyIndex || isSpyUsStockInput(item) ? sum : sum + Math.max(0, parseAmountPart(item.amountCny))
  ), 0);
  let usedSpy = false;
  const spyAmount = String(roundMoney(Math.max(0, usTotalCny - nonSpyTotal)));
  return items.map((item) => {
    if (!isSpyUsStockInput(item)) return item;
    if (usedSpy) return { ...item, amountCny: '0' };
    usedSpy = true;
    return { ...item, amountCny: spyAmount };
  });
};
const INVEST_FIELD_LABELS: Record<InvestKey, string> = {
  us: '美股',
  eu: '欧洲',
  asia: '亚洲',
  a: 'A股',
  longBond: '长债',
  usBond: '美债',
  gold: '黄金',
};
const effectiveInvestTargets = (targets: InvestAllocTargets) =>
  INVEST_TARGET_KEYS.some((k) => (targets[k] ?? 0) > 0) ? targets : DEFAULT_CONFIG.investAllocTargets;
const fmtPctInput = (value: number) => String(Math.round(value * 100) / 100);
const groupedTargetInputFromConfig = (targets: InvestAllocTargets): GroupedTargetInputs => {
  const groups = {} as Record<InvestGroupKey, string>;
  const assets = {} as Record<InvestKey, string>;
  for (const group of INVEST_GROUPS) {
    const groupTotal = group.keys.reduce((sum, k) => sum + (targets[k] ?? 0) * 100, 0);
    groups[group.key] = fmtPctInput(groupTotal);
    for (const k of group.keys) {
      assets[k] = groupTotal > 0 ? fmtPctInput(((targets[k] ?? 0) * 100 / groupTotal) * 100) : '0';
    }
  }
  return { groups, assets };
};
const groupedTargetInputsToConfig = (inputs: GroupedTargetInputs): InvestAllocTargets =>
  Object.fromEntries(INVEST_TARGET_KEYS.map((k) => {
    const group = INVEST_GROUPS.find((g) => g.keys.includes(k))!;
    const groupPct = parseFloat(inputs.groups[group.key]) || 0;
    const assetPct = parseFloat(inputs.assets[k]) || 0;
    return [k, (groupPct / 100) * (assetPct / 100)];
  })) as unknown as InvestAllocTargets;
const usStockInputsFromItems = (items: UsStockHoldingItem[]): UsStockItemInput[] =>
  items.map((item) => ({
    id: item.id,
    name: item.name,
    symbol: item.symbol,
    amountCny: String(item.amountCny ?? 0),
    shares: item.shares !== undefined ? String(item.shares) : '',
    costPrice: item.costPrice !== undefined ? String(item.costPrice) : '',
  }));

function RebalanceSettingsModal({
  cities,
  internshipConfig,
  recurringIncomeBaseline,
  groupedTargetInputs,
  setGroupedTargetInputs,
  onRevealConsumptionWish,
  onHideConsumptionWish,
  onClose,
  onSave,
}: {
  cities: SceneCitySettings;
  internshipConfig: import('../models/types').AppConfig;
  recurringIncomeBaseline?: number;
  groupedTargetInputs: GroupedTargetInputs;
  setGroupedTargetInputs: (v: GroupedTargetInputs) => void;
  onRevealConsumptionWish: () => void;
  onHideConsumptionWish: () => void;
  onClose: () => void;
  onSave: (cities: Partial<import('../models/types').AppConfig>, allocationChanged: boolean, recurringIncomeBaseline: number) => void;
}) {
  const [cityDraft, setCityDraft] = useState(cities);
  const [internshipDraft, setInternshipDraft] = useState<Partial<import('../models/types').AppConfig>>({});
  const [editingSchoolPeriod, setEditingSchoolPeriod] = useState(false);
  const [baselineDraft, setBaselineDraft] = useState(String(resolveRecurringIncomeBaseline(recurringIncomeBaseline)));
  const baselineValue = baselineDraft.trim() ? Number(tryEvalFormula(baselineDraft) ?? baselineDraft) : NaN;
  const baselineValid = Number.isFinite(baselineValue) && baselineValue >= 0;
  const [raiseSettingsDraft, setRaiseSettingsDraft] = useState(() => resolveRaiseSavingsSettings(internshipConfig.raiseSavings));
  const [manualRaiseDraft, setManualRaiseDraft] = useState(() => String(resolveRaiseSavingsSettings(internshipConfig.raiseSavings).manualRaiseAmount));
  const manualRaiseValue = manualRaiseDraft.trim() ? Number(tryEvalFormula(manualRaiseDraft) ?? manualRaiseDraft) : NaN;
  const manualRaiseValid = Number.isFinite(manualRaiseValue) && manualRaiseValue >= 0;
  const savingsSettingsValid = !raiseSettingsDraft.enabled || (raiseSettingsDraft.mode === 'manual' ? manualRaiseValid : baselineValid);
  const initialSettings = useRef({ cities, allocation: JSON.stringify(groupedTargetInputs) });
  const total = INVEST_GROUPS.reduce((sum, group) => sum + (parseFloat(groupedTargetInputs.groups[group.key]) || 0), 0);
  const totalOk = Math.abs(total - 100) < 0.01;
  const groupAssetsOk = INVEST_GROUPS.every((group) => {
    const groupTotal = parseFloat(groupedTargetInputs.groups[group.key]) || 0;
    if (groupTotal <= 0) return true;
    const assetTotal = group.keys.reduce((sum, key) => sum + (parseFloat(groupedTargetInputs.assets[key]) || 0), 0);
    return Math.abs(assetTotal - 100) < 0.01;
  });
  const allocationOk = totalOk && groupAssetsOk;
  const [backtestCharts, setBacktestCharts] = useState<Partial<Record<PortfolioBacktestSeriesId, MarketChartResponse>> | null>(null);
  const [backtestError, setBacktestError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(PORTFOLIO_BACKTEST_REQUESTS.map(async (definition) => {
      const response = await fetch(portfolioBacktestRequestUrl(definition), { signal: controller.signal });
      if (!response.ok) throw new Error(`${definition.symbol} history ${response.status}`);
      return [definition.id, await response.json() as MarketChartResponse] as const;
    })).then((entries) => {
      setBacktestCharts(Object.fromEntries(entries));
      setBacktestError(false);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn('portfolio backtest unavailable', error);
      setBacktestError(true);
    });
    return () => controller.abort();
  }, []);
  const backtestTargets = useMemo(
    () => groupedTargetInputsToConfig(groupedTargetInputs),
    [groupedTargetInputs],
  );
  const currentMonth = useMemo(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  const backtest = useMemo(
    () => allocationOk && backtestCharts
      ? calculatePortfolioBacktest(backtestCharts, backtestTargets, currentMonth)
      : null,
    [allocationOk, backtestCharts, backtestTargets, currentMonth],
  );
  const setGroupInput = (group: InvestGroupKey, value: string) =>
    setGroupedTargetInputs({ ...groupedTargetInputs, groups: { ...groupedTargetInputs.groups, [group]: value } });
  const setAssetInput = (key: InvestKey, value: string) =>
    setGroupedTargetInputs({ ...groupedTargetInputs, assets: { ...groupedTargetInputs.assets, [key]: value } });

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div className="reconcile-settings" role="dialog" aria-modal="true" aria-label="设置" style={{ backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '20px 20px 12px' }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>设置</div>
        </div>
        <div className="reconcile-settings-body" style={{ padding: '0 20px 4px' }}>
          <label className="reconcile-settings-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 13, fontWeight: 700 }}>
            <span>涨薪的一半存起来</span>
            <input type="checkbox" role="switch" aria-label="涨薪的一半存起来" checked={raiseSettingsDraft.enabled}
              onChange={event => setRaiseSettingsDraft(previous => ({ ...previous, enabled: event.target.checked }))}
              style={{ accentColor: C.blue }} />
          </label>
          {raiseSettingsDraft.enabled && <>
            <label className="reconcile-settings-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 13 }}>
              <span>计算方式</span>
              <select aria-label="涨薪存半计算方式" value={raiseSettingsDraft.mode}
                onChange={event => setRaiseSettingsDraft(previous => ({ ...previous, mode: event.target.value === 'manual' ? 'manual' : 'automatic' }))}
                style={{ border: '1px solid #dadce0', borderRadius: 8, padding: '6px 8px', fontSize: 13, backgroundColor: '#fff' }}>
                <option value="automatic">自动计算</option>
                <option value="manual">手动填写涨薪</option>
              </select>
            </label>
            <label className="reconcile-settings-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 13 }}>
              <span>{raiseSettingsDraft.mode === 'manual' ? '每月涨薪金额' : '周期收入基本线'}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.sub }}>
                ¥
                <AmountInput
                  key={raiseSettingsDraft.mode}
                  aria-label={raiseSettingsDraft.mode === 'manual' ? '每月涨薪金额' : '周期收入基本线'}
                  value={raiseSettingsDraft.mode === 'manual' ? manualRaiseDraft : baselineDraft}
                  onChange={raiseSettingsDraft.mode === 'manual' ? setManualRaiseDraft : setBaselineDraft}
                  decimalPlaces={2}
                  aria-invalid={!savingsSettingsValid}
                  style={{ width: 110, border: `1px solid ${savingsSettingsValid ? '#dadce0' : C.red}`, borderRadius: 8, padding: '6px 8px', fontSize: 13, textAlign: 'right' }}
                />
                /月
              </span>
            </label>
            <label className="reconcile-settings-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 13 }}>
              <span>波动收入存半</span>
              <input type="checkbox" role="switch" aria-label="波动收入存半" checked={raiseSettingsDraft.includeVolatileIncome}
                onChange={event => setRaiseSettingsDraft(previous => ({ ...previous, includeVolatileIncome: event.target.checked }))}
                style={{ accentColor: C.blue }} />
            </label>
          </>}
          <SceneCityFields value={cityDraft} onChange={setCityDraft} schoolLabel="默认上学城市" />
          <SchoolPeriods periods={internshipDraft.schoolPeriods ?? internshipConfig.schoolPeriods ?? []}
            onChange={schoolPeriods => setInternshipDraft(previous => ({ ...previous, schoolPeriods }))} onEditingChange={setEditingSchoolPeriod} />
          <InternshipPeriods config={{ ...internshipConfig, ...cityDraft, ...internshipDraft }} onChange={changes => setInternshipDraft(previous => ({ ...previous, ...changes }))} />
          <div style={{ border: '1px solid #f1f3f4', borderRadius: 10, padding: '9px 10px', backgroundColor: '#fafafa', marginBottom: 12 }}>
            <div className="reconcile-settings-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#202124' }}>账户显示</div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>消费、心愿美元为 0 时默认隐藏</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={onRevealConsumptionWish}
                  style={{ border: 'none', borderRadius: 8, padding: '7px 10px', backgroundColor: '#e8f0fe', color: C.blue, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  开启录入
                </button>
                <button
                  type="button"
                  onClick={onHideConsumptionWish}
                  style={{ border: 'none', borderRadius: 8, padding: '7px 10px', backgroundColor: '#f1f3f4', color: C.sub, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
          <div style={{ border: '1px solid #f1f3f4', borderRadius: 10, padding: '9px 10px', backgroundColor: '#fafafa', marginBottom: 12 }}>
            <div className="reconcile-settings-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#202124' }}>长债自动还债线</div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>超过此金额的部分用于偿还本期待还</div>
              </div>
              <div style={{ flexShrink: 0, color: C.green, fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                ¥{fmtInt(LONG_BOND_REPAY_THRESHOLD)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#202124' }}>大类目标比例</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: totalOk ? C.green : C.orange }}>
              合计 {total.toFixed(2)}%
            </div>
          </div>
          <div
            role="status"
            title={backtest ? `${backtest.startMonth} 至 ${backtest.endMonth} · ${PORTFOLIO_BACKTEST_SOURCE_TITLE}` : PORTFOLIO_BACKTEST_SOURCE_TITLE}
            style={{ margin: '-2px 0 10px', padding: '7px 9px', borderRadius: 8, backgroundColor: '#f8f9fa', color: C.sub, fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {!allocationOk
              ? '比例配平后显示回测'
              : backtest
                ? <>
                    最长回测 {backtest.years.toFixed(1)} 年
                    <span style={{ color: backtest.annualizedReturn >= 0 ? C.red : C.green }}> · 年化 {(backtest.annualizedReturn * 100).toFixed(1)}%</span>
                    <span style={{ color: C.green }}> · 最大回撤 {(backtest.maxDrawdown * 100).toFixed(1)}%</span>
                  </>
                : backtestError || backtestCharts ? '最长回测数据不足' : '最长回测计算中…'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {INVEST_GROUPS.map((group) => {
              const groupTotal = parseFloat(groupedTargetInputs.groups[group.key]) || 0;
              const assetTotal = group.keys.reduce((sum, k) => sum + (parseFloat(groupedTargetInputs.assets[k]) || 0), 0);
              const remaining = 100 - assetTotal;
              const remainingOk = Math.abs(remaining) < 0.01;
              return (
                <div key={group.key} style={{ border: '1px solid #f1f3f4', borderRadius: 10, padding: '9px 10px', backgroundColor: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: group.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#202124' }}>{group.label}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={groupedTargetInputs.groups[group.key]}
                      onChange={(e) => {
                        const next = sanitizeDecimalNumberInput(e.target.value);
                        if (next !== null) setGroupInput(group.key, next);
                      }}
                      onFocus={(e) => e.target.select()}
                      style={{ marginLeft: 'auto', width: 58, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 13, fontWeight: 700, textAlign: 'right', color: '#202124', fontVariantNumeric: 'tabular-nums' }}
                    />
                    <span style={{ fontSize: 11, color: C.sub }}>%</span>
                  </div>
                  <div className="reconcile-settings-assets">
                    {group.keys.map((k) => (
                      <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, backgroundColor: '#f8f9fa', borderRadius: 8, padding: '6px 8px' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: investMeta[k].color, flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: 12, color: C.sub, whiteSpace: 'nowrap' }}>{investMeta[k].label}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={groupedTargetInputs.assets[k]}
                          onChange={(e) => {
                            const next = sanitizeDecimalNumberInput(e.target.value);
                            if (next !== null) setAssetInput(k, next);
                          }}
                          onFocus={(e) => e.target.select()}
                          style={{ width: 48, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 13, fontWeight: 600, textAlign: 'right', color: '#202124', fontVariantNumeric: 'tabular-nums' }}
                        />
                        <span style={{ fontSize: 11, color: C.sub }}>%</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 11, color: remainingOk ? C.green : C.orange }}>
                    {group.label}类剩余 {remaining.toFixed(2)}% 未分配
                    {groupTotal > 0 && (
                      <span style={{ color: C.sub }}> · 占总资产 {groupTotal.toFixed(2)}%</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0, flexWrap: 'wrap', padding: '12px 20px max(20px, env(safe-area-inset-bottom))', borderTop: '1px solid #f1f3f4' }}>
          <button onClick={onClose}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #dadce0', backgroundColor: '#fff', color: C.sub, fontSize: 13, cursor: 'pointer' }}>
            取消
          </button>
          <button onClick={() => {
            if (!savingsSettingsValid || editingSchoolPeriod) return;
            const cityChanges: SceneCitySettings = {};
            for (const key of ['homeCity', 'schoolCity'] as const) {
              if (JSON.stringify(cityDraft[key]) !== JSON.stringify(initialSettings.current.cities[key])) cityChanges[key] = cityDraft[key];
            }
            onSave({ ...cityChanges, ...internshipDraft, raiseSavings: { ...raiseSettingsDraft,
              manualRaiseAmount: manualRaiseValid ? roundMoney(manualRaiseValue) : resolveRaiseSavingsSettings(internshipConfig.raiseSavings).manualRaiseAmount,
            } }, JSON.stringify(groupedTargetInputs) !== initialSettings.current.allocation,
              baselineValid ? roundMoney(baselineValue) : resolveRecurringIncomeBaseline(recurringIncomeBaseline));
          }}
            disabled={!savingsSettingsValid || editingSchoolPeriod}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', backgroundColor: savingsSettingsValid && !editingSchoolPeriod ? C.blue : '#dadce0', color: '#fff', fontSize: 13, fontWeight: 600, cursor: savingsSettingsValid && !editingSchoolPeriod ? 'pointer' : 'default' }}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}


const TRANSFER_META: Record<TransferKey, { label: string }> = {
  raiseSavings: { label: '涨薪的一半存起来' },
  campusCard:  { label: '🎓 校园卡' },
  repayment:   { label: '💳 还款' },
  living:      { label: '🏦 生活' },
  consumption: { label: '💼 消费' },
  wishJar:     { label: '🏺 心愿罐' },
  invest:      { label: '📈 理财' },
};

type BudgetKey = 'monthly' | 'beyond' | 'following';
type ReconcileMode = 'monthStart' | 'monthMiddle';

type ReconcileUndoState = {
  current: AccountSnapshot;
  config: Pick<AppConfig, 'investAllocTargets' | 'dramDecision' | 'recurringIncomeBaseline' | 'raiseSavings'>;
  revealConsumptionWishUsd: boolean;
  localAccounts: Record<keyof AccountSnapshot['accounts'], string>;
  revealedUsdAccounts: UsdVirtualAccountKey[];
  investUsdInputMode: 'cny' | 'usd';
  investUsdCnyInput: string;
  confirmed: Record<TransferKey, number>;
  localTransferred: Record<TransferKey, string>;
  consumptionWishOpen: boolean;
  groupedTargetInputs: GroupedTargetInputs;
  reconcileMode: ReconcileMode;
  allowRebalanceSell: boolean;
  localHoldings: Record<InvestKey, string>;
  localUsStockItems: UsStockItemInput[];
  dramConfigInputs: { shares: string; costPrice: string };
  localFundingLeg: Record<string, string>;
};

const cloneAccountSnapshot = (snapshot: AccountSnapshot): AccountSnapshot => ({
  ...snapshot,
  accounts: { ...snapshot.accounts },
  accountBalanceSync: snapshot.accountBalanceSync
    ? Object.fromEntries(Object.entries(snapshot.accountBalanceSync).map(([key, cursor]) => [
        key,
        cursor ? { ...cursor, transactionIdsOnDate: [...cursor.transactionIdsOnDate] } : cursor,
      ]))
    : undefined,
  investHoldings: { ...snapshot.investHoldings },
  reconcileInvestHoldings: snapshot.reconcileInvestHoldings ? { ...snapshot.reconcileInvestHoldings } : undefined,
  usStockHoldings: snapshot.usStockHoldings?.map((item) => ({ ...item })),
  transfersDone: { ...snapshot.transfersDone },
  raiseSavingsByMonth: snapshot.raiseSavingsByMonth ? { ...snapshot.raiseSavingsByMonth } : undefined,
});

const cloneReconcileUndoState = (state: ReconcileUndoState): ReconcileUndoState => ({
  ...state,
  current: cloneAccountSnapshot(state.current),
  config: {
    recurringIncomeBaseline: state.config.recurringIncomeBaseline,
    raiseSavings: state.config.raiseSavings ? { ...state.config.raiseSavings } : undefined,
    investAllocTargets: { ...state.config.investAllocTargets },
    dramDecision: state.config.dramDecision ? { ...state.config.dramDecision } : undefined,
  },
  localAccounts: { ...state.localAccounts },
  revealedUsdAccounts: [...state.revealedUsdAccounts],
  confirmed: { ...state.confirmed },
  localTransferred: { ...state.localTransferred },
  groupedTargetInputs: {
    groups: { ...state.groupedTargetInputs.groups },
    assets: { ...state.groupedTargetInputs.assets },
  },
  localHoldings: { ...state.localHoldings },
  localUsStockItems: state.localUsStockItems.map((item) => ({ ...item })),
  dramConfigInputs: { ...state.dramConfigInputs },
  localFundingLeg: { ...state.localFundingLeg },
});

const reconcileUndoFingerprint = (state: ReconcileUndoState) => {
  const visibleAccounts = {
    ...state.localAccounts,
    investUsdBank: state.investUsdInputMode === 'cny'
      ? `cny:${state.investUsdCnyInput}`
      : state.localAccounts.investUsdBank,
  };
  return JSON.stringify({
    config: state.config,
    raiseSavingsByMonth: state.current.raiseSavingsByMonth,
    reconcileInvestHoldings: state.current.reconcileInvestHoldings,
    revealConsumptionWishUsd: state.revealConsumptionWishUsd,
    localAccounts: visibleAccounts,
    revealedUsdAccounts: [...state.revealedUsdAccounts].sort(),
    investUsdInputMode: state.investUsdInputMode,
    confirmed: state.confirmed,
    localTransferred: state.localTransferred,
    consumptionWishOpen: state.consumptionWishOpen,
    groupedTargetInputs: state.groupedTargetInputs,
    reconcileMode: state.reconcileMode,
    allowRebalanceSell: state.allowRebalanceSell,
    localHoldings: state.localHoldings,
    localUsStockItems: state.localUsStockItems,
    dramConfigInputs: state.dramConfigInputs,
    localFundingLeg: state.localFundingLeg,
  });
};

interface BudgetDetailItem { icon?: string; label: string; amount: number; note?: string; isIncome?: boolean; isLivingExpense?: boolean }

const BUDGET_SCENE_META = {
  school: { icon: '🏫', label: '校' },
  work: tagMeta.intern,
  rest: { icon: '☕', label: '休' },
  home: tagMeta.home,
  travel: tagMeta.travel,
} as const;

const RECONCILE_MODES: { key: ReconcileMode; label: string; hint: string }[] = [
  { key: 'monthStart', label: '月初', hint: '1-13号' },
  { key: 'monthMiddle', label: '月中', hint: '11/21' },
];
const defaultReconcileMode = (date: Date): ReconcileMode => (date.getDate() >= 1 && date.getDate() <= 13 ? 'monthStart' : 'monthMiddle');

export default function ReconcilePage() {
  const syncReady = useSyncStatus((state) => state.ready);
  const { current, updateAccounts, executeTransfers, updateReconcileHoldings, updateUsStockHoldings, restoreCurrent } = useSnapshotStore();
  const { config, setConfig } = useConfigStore();
  const { records } = useMonthlyStore();
  const { confirmedExpenses } = useCalendarStore();
  const { tagMap, internship } = useLifeCalendar();
  const { expenseItems, incomeItems: actualIncomeItems } = useBillDetailStore();
  const { overrides: expenseScopeOverrides } = useExpenseScopeOverrideStore();
  const { tripTags } = useTripStore();

  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const nextMonthDate = new Date(currentYear, currentMonth + 1, 1);
  const nextYear = nextMonthDate.getFullYear();
  const nextMonth = nextMonthDate.getMonth();
  const followingMonthDate = new Date(currentYear, currentMonth + 2, 1);
  const followingYear = followingMonthDate.getFullYear();
  const followingMonth = followingMonthDate.getMonth();
  const curYM = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
  const currentInvestRecord = useMemo(
    () => records.find((record) => record.yearMonth === curYM),
    [curYM, records],
  );
  const currentInvestPositionItems = useMemo(
    () => migrateLegacyInvestPositionItems(currentInvestRecord, INVEST_FIELD_LABELS),
    [currentInvestRecord],
  );
  const sourceHoldings = useMemo(() => {
    const now = emptyInvestHoldings();
    const past = emptyInvestHoldings();
    const summary = summarizeInvestPositionItems(currentInvestPositionItems);
    for (const key of INVEST_TARGET_KEYS) {
      for (const item of currentInvestPositionItems[key] ?? []) {
        const target = item.status === 'active' ? now : past;
        target[key] += summary.metricsById[item.id]?.marketValueCny ?? 0;
      }
      now[key] = roundMoney(now[key]);
      past[key] = roundMoney(past[key]);
    }
    return { now, past };
  }, [currentInvestPositionItems]);
  const sourceInvestHoldings = sourceHoldings.now;
  const reconcileHoldings = useMemo(() => {
    if (!current.reconcileInvestHoldings) return sourceInvestHoldings;
    if (current.reconcileInvestHoldingsVersion === 2) return current.reconcileInvestHoldings;
    // 上版独立字段保存的是 now + past，首次读取时转换为 now。
    return Object.fromEntries(INVEST_TARGET_KEYS.map((key) => [
      key, roundMoney(Math.max(0, current.reconcileInvestHoldings![key] - sourceHoldings.past[key])),
    ])) as unknown as InvestHoldings;
  }, [current.reconcileInvestHoldings, current.reconcileInvestHoldingsVersion, sourceHoldings, sourceInvestHoldings]);
  useEffect(() => {
    if (syncReady && current.reconcileInvestHoldingsVersion !== 2 && currentInvestRecord) {
      updateReconcileHoldings(reconcileHoldings);
    }
  }, [current.reconcileInvestHoldingsVersion, currentInvestRecord, reconcileHoldings, updateReconcileHoldings, syncReady]);
  const reconcileTotalHoldings = useMemo(() => Object.fromEntries(INVEST_TARGET_KEYS.map((key) => [
    key, roundMoney(reconcileHoldings[key] + sourceHoldings.past[key]),
  ])) as unknown as InvestHoldings, [reconcileHoldings, sourceHoldings.past]);

  // 账户余额本地编辑
  const [localAccounts, setLocalAccounts] = useState({
    credit:        String(current.accounts.credit ?? 0),
    creditMonthly: String(current.accounts.creditMonthly ?? 0),
    savingsCard:   String(current.accounts.savingsCard ?? 0),
    campusCard:    String(current.accounts.campusCard ?? 0),
    livingBank:    String(current.accounts.livingBank ?? 0),
    consumptionBank: String(current.accounts.consumptionBank ?? 0),
    wishJar:       String(current.accounts.wishJar ?? 0),
    incomeBank:    String(current.accounts.incomeBank ?? 0),
    investCnyBank: String(current.accounts.investCnyBank ?? 0),
    usdLivingBank: String(current.accounts.usdLivingBank ?? 0),
    usdConsumptionBank: String(current.accounts.usdConsumptionBank ?? 0),
    usdWishJar:    String(current.accounts.usdWishJar ?? 0),
    investUsdBank: String(current.accounts.investUsdBank ?? 0),
  });
  useEffect(() => {
    setLocalAccounts({
      credit: String(current.accounts.credit ?? 0),
      creditMonthly: String(current.accounts.creditMonthly ?? 0),
      savingsCard: String(current.accounts.savingsCard ?? 0),
      campusCard: String(current.accounts.campusCard ?? 0),
      livingBank: String(current.accounts.livingBank ?? 0),
      consumptionBank: String(current.accounts.consumptionBank ?? 0),
      wishJar: String(current.accounts.wishJar ?? 0),
      incomeBank: String(current.accounts.incomeBank ?? 0),
      investCnyBank: String(current.accounts.investCnyBank ?? 0),
      usdLivingBank: String(current.accounts.usdLivingBank ?? 0),
      usdConsumptionBank: String(current.accounts.usdConsumptionBank ?? 0),
      usdWishJar: String(current.accounts.usdWishJar ?? 0),
      investUsdBank: String(current.accounts.investUsdBank ?? 0),
    });
  }, [current.accounts]);
  const accountInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const swipeStartXRef = useRef<Partial<Record<UsdVirtualAccountKey, number>>>({});
  const revealConsumptionWishUsd = usePrefsStore((s) => s.revealConsumptionWishUsd);
  const setRevealConsumptionWishUsd = usePrefsStore((s) => s.setRevealConsumptionWishUsd);
  const [revealedUsdAccounts, setRevealedUsdAccounts] = useState<Set<UsdVirtualAccountKey>>(
    () => new Set(revealConsumptionWishUsd ? (['usdConsumptionBank', 'usdWishJar'] as UsdVirtualAccountKey[]) : []),
  );
  const [investUsdInputMode, setInvestUsdInputMode] = useState<'cny' | 'usd'>('cny');
  const [investUsdCnyInput, setInvestUsdCnyInput] = useState('');
  const focusNextAccount = (i: number) => {
    setTimeout(() => {
      for (let next = i + 1; next < accountInputRefs.current.length; next += 1) {
        const input = accountInputRefs.current[next];
        if (!input) continue;
        input.focus();
        return;
      }
    }, 0);
  };
  // 失焦时 AmountInput 的计算结果尚未完成状态更新，保存前需直接解析草稿中的算式。
  const syncAccounts = (next = localAccounts) => updateAccounts({
    credit:        parseAmountPart(next.credit),
    creditMonthly: parseAmountPart(next.creditMonthly),
    savingsCard:   parseAmountPart(next.savingsCard),
    campusCard:    parseAmountPart(next.campusCard),
    livingBank:    parseAmountPart(next.livingBank),
    consumptionBank: parseAmountPart(next.consumptionBank),
    wishJar:       parseAmountPart(next.wishJar),
    incomeBank:    parseAmountPart(next.incomeBank),
    investCnyBank: parseAmountPart(next.investCnyBank),
    usdLivingBank: parseAmountPart(next.usdLivingBank),
    usdConsumptionBank: parseAmountPart(next.usdConsumptionBank),
    usdWishJar:    parseAmountPart(next.usdWishJar),
    investUsdBank: parseAmountPart(next.investUsdBank),
  });
  const showUsdAccount = (usdKey: UsdVirtualAccountKey) =>
    parseAmountPart(localAccounts[usdKey]) !== 0 || (current.accounts[usdKey] ?? 0) !== 0 || revealedUsdAccounts.has(usdKey);
  const revealUsdAccount = (usdKey: UsdVirtualAccountKey) =>
    setRevealedUsdAccounts((prev) => {
      const next = new Set(prev);
      next.add(usdKey);
      return next;
    });
  const hideUsdAccount = (usdKey: UsdVirtualAccountKey) => {
    if (parseAmountPart(localAccounts[usdKey]) !== 0 || (current.accounts[usdKey] ?? 0) !== 0) return;
    setRevealedUsdAccounts((prev) => {
      const next = new Set(prev);
      next.delete(usdKey);
      return next;
    });
  };
  const makeUsdSwipeHandlers = (usdKey: UsdVirtualAccountKey) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      swipeStartXRef.current[usdKey] = e.clientX;
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      const startX = swipeStartXRef.current[usdKey];
      if (startX === undefined) return;
      const delta = e.clientX - startX;
      if (delta < -36) revealUsdAccount(usdKey);
      if (delta > 36) hideUsdAccount(usdKey);
      delete swipeStartXRef.current[usdKey];
    },
  });

  // 信用卡实际待还（储蓄卡先抵本期，溢出抵下期）
  // 长债超过固定阈值的部分可赎回用于偿还信用卡本期待还（储蓄卡抵扣后仍欠的部分）
  const {
    longBondTotalForRepay,
    longBondExcess,
    longBondRepay,
    longBondRepayNext,
    effectiveCreditMonthly,
    effectiveCreditNext,
  } = calculateCreditRepaymentPlan({
    creditMonthly: current.accounts.creditMonthly,
    creditTotal: current.accounts.credit,
    savingsCard: current.accounts.savingsCard,
    longBond: reconcileTotalHoldings.longBond,
  });

  // 已转金额（用户直接编辑）— 每次进入页面默认为 0
  const [confirmed, setConfirmed] = useState<Record<TransferKey, number>>(
    () => Object.fromEntries(TRANSFER_KEYS.map(k => [k, 0])) as Record<TransferKey, number>,
  );
  const [localTransferred, setLocalTransferred] = useState<Record<TransferKey, string>>(
    () => Object.fromEntries(TRANSFER_KEYS.map(k => [k, '0'])) as Record<TransferKey, string>,
  );

  const [expandedBudget, setExpandedBudget] = useState<BudgetKey | null>(null);
  const [expandedTransfer, setExpandedTransfer] = useState<TransferKey | null>(null);
  const [consumptionWishOpen, setConsumptionWishOpen] = useState(revealConsumptionWishUsd);
  const hideConsumptionWishAccounts = () => {
    setRevealedUsdAccounts((prev) => {
      const next = new Set(prev);
      next.delete('usdConsumptionBank');
      next.delete('usdWishJar');
      return next;
    });
    setConsumptionWishOpen(false);
    setRevealConsumptionWishUsd(false);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [groupedTargetInputs, setGroupedTargetInputs] = useState<GroupedTargetInputs>(
    () => groupedTargetInputFromConfig(effectiveInvestTargets(config.investAllocTargets)),
  );
  const [remoteUsdRate, setRemoteUsdRate] = useState<UsdRateResponse | null>(null);
  const [usdRateError, setUsdRateError] = useState(false);
  const [usdRebalanceCells, setUsdRebalanceCells] = useState<Set<InvestKey>>(() => new Set());
  const [screenshotImportMsg, setScreenshotImportMsg] = useState('');
  const [backupCreating, setBackupCreating] = useState(false);
  const [reconcileMode, setReconcileMode] = useState<ReconcileMode>(() => defaultReconcileMode(new Date()));
  const isMonthStartMode = reconcileMode === 'monthStart';

  useEffect(() => {
    const onScreenshotImport = (event: Event) => {
      const detail = (event as CustomEvent<FinanceScreenshotImportEventDetail>).detail;
      detail.reconcileHoldings = reconcileHoldings;
    };
    window.addEventListener(FINANCE_SCREENSHOT_IMPORT_EVENT, onScreenshotImport);
    return () => window.removeEventListener(FINANCE_SCREENSHOT_IMPORT_EVENT, onScreenshotImport);
  }, [reconcileHoldings]);

  const backupCurrentVersion = async () => {
    setBackupCreating(true);
    setScreenshotImportMsg('备份中');
    try {
      await createManualBackup();
      setScreenshotImportMsg('当前版本已备份');
    } catch (error) {
      setScreenshotImportMsg(`备份失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupCreating(false);
    }
  };

  const [allowRebalanceSell, setAllowRebalanceSell] = useState(false);

  // 理财持仓本地编辑
  const [localHoldings, setLocalHoldings] = useState<Record<InvestKey, string>>(
    () => Object.fromEntries(INVEST_TARGET_KEYS.map((k) => [
      k,
      String(reconcileHoldings[k]),
    ])) as Record<InvestKey, string>
  );
  const transferInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => {
    setLocalHoldings(Object.fromEntries(INVEST_TARGET_KEYS.map((key) => [
      key,
      String(reconcileHoldings[key]),
    ])) as Record<InvestKey, string>);
  }, [reconcileHoldings]);

  const holdingInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const commitHolding = (key: InvestKey, raw: string) => {
    const value = Number(tryEvalFormula(raw) ?? raw.trim());
    const amount = Number.isFinite(value) && value >= 0 ? roundMoney(value) : reconcileHoldings[key];
    setLocalHoldings((previous) => ({ ...previous, [key]: String(amount) }));
    updateReconcileHoldings({ ...reconcileHoldings, [key]: amount });
  };

  const showCreditMonthlyInput = isMonthStartMode;
  const { holidayDataByYear, holidayWarning } = useHolidayYears([currentYear - 1, currentYear, nextYear, followingYear]);

  // 历史均值（只取近两年）
  const twoYearsAgo = `${today.getFullYear() - 1}-01`;
  const stats = useMemo(
    () => calcHistoryStats(records.filter((r) => r.yearMonth >= twoYearsAgo), tagMap, confirmedExpenses, expenseItems, expenseScopeOverrides, tripTags, internship),
    [records, tagMap, confirmedExpenses, expenseItems, expenseScopeOverrides, tripTags, internship],
  );

  // 将 tagMap 转为 DailyTag[]
  const tags: DailyTag[] = useMemo(
    () => budgetCalendarTags(Object.entries(tagMap).map(([date, tag]) => ({ date, tag })), today, internship),
    [tagMap, internship, curYM],
  );

  const currentResolvedIncomeItems = useMemo(
    () => resolveAllIncomeForMonth(config.incomeItems, currentYear, currentMonth, tagMap, holidayDataByYear, internship),
    [config.incomeItems, currentYear, currentMonth, tagMap, holidayDataByYear, internship],
  );
  const nextResolvedIncomeItems = useMemo(
    () => resolveAllIncomeForMonth(config.incomeItems, nextYear, nextMonth, tagMap, holidayDataByYear, internship),
    [config.incomeItems, nextYear, nextMonth, tagMap, holidayDataByYear, internship],
  );
  const followingResolvedIncomeItems = useMemo(
    () => resolveAllIncomeForMonth(config.incomeItems, followingYear, followingMonth, tagMap, holidayDataByYear, internship),
    [config.incomeItems, followingYear, followingMonth, tagMap, holidayDataByYear, internship],
  );

  const effectiveConfig = useMemo(() => ({
    ...config,
    incomeItems: currentResolvedIncomeItems.map((item) => ({
      id: item.id,
      name: item.name,
      amount: item.resolvedAmount,
      payDay: Number(item.resolvedPayDate.slice(8, 10)),
      isActive: item.isActive,
      dailyRate: item.dailyRate,
      tagKind: item.tagKind,
    })),
  }), [config, currentResolvedIncomeItems]);

  // 预算计算（传入当前账户余额，启用收入优先逻辑）
  const budget = useMemo(
    () => calcBudget(effectiveConfig, stats, confirmed, tags, today, {
      incomeBank:      current.accounts.incomeBank      ?? 0,
      campusCard:      current.accounts.campusCard      ?? 0,
      livingBank:      current.accounts.livingBank      ?? 0,
      consumptionBank: current.accounts.consumptionBank ?? 0,
    }, internship, nextResolvedIncomeItems),
    [effectiveConfig, stats, confirmed, tags, current.accounts, internship, nextResolvedIncomeItems],
  );

  const investKeys = INVEST_TARGET_KEYS;
  const investAllocTargets = useMemo(
    () => investKeys.some((k) => (config.investAllocTargets[k] ?? 0) > 0)
      ? config.investAllocTargets
      : DEFAULT_CONFIG.investAllocTargets,
    [config.investAllocTargets, investKeys],
  );
  const fallbackUsdRate = useMemo(
    () => [...records].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))
      .map((r) => r.investProfitComponents?.us?.rate ?? r.investProfitComponents?.usBond?.rate)
      .find((rate) => rate !== undefined && Number.isFinite(rate) && rate > 0) ?? null,
    [records],
  );
  useEffect(() => {
    const controller = new AbortController();
    setUsdRateError(false);
    fetch('/api/usd-rate', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as UsdRateResponse;
        if (!Number.isFinite(data.rate) || data.rate <= 0) throw new Error('invalid USD rate');
        setRemoteUsdRate(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setUsdRateError(true);
      });
    return () => controller.abort();
  }, []);
  const latestUsdRate = remoteUsdRate?.rate ?? fallbackUsdRate;
  const pendingInvestHoldings = useMemo(
    () => pendingInvestmentAmounts(currentInvestPositionItems, latestUsdRate),
    [currentInvestPositionItems, latestUsdRate],
  );
  const effectiveInvestHoldings = useMemo(() => Object.fromEntries(
    INVEST_TARGET_KEYS.map((key) => [
      key,
      roundMoney(
        (key === 'longBond'
          ? Math.max(0, reconcileTotalHoldings.longBond - longBondRepay)
          : reconcileTotalHoldings[key])
        + pendingInvestHoldings[key],
      ),
    ]),
  ) as Record<InvestKey, number>, [longBondRepay, reconcileTotalHoldings, pendingInvestHoldings]);
  const usdRateLabel = remoteUsdRate
    ? `${remoteUsdRate.source}${remoteUsdRate.date ? ` · ${remoteUsdRate.date}` : ''}`
    : fallbackUsdRate !== null
      ? `${usdRateError ? '联网失败 · ' : ''}历史汇率`
      : '暂无汇率';
  const storedUsStockItems = current.usStockHoldings ?? EMPTY_US_STOCK_ITEMS;
  const storedDramItem = useMemo(
    () => storedUsStockItems.find((item) => item.symbol.trim().toUpperCase() === 'DRAM' || item.name.trim().toUpperCase() === 'DRAM') ?? null,
    [storedUsStockItems],
  );
  const dramConfig = useMemo(() => normalizeDramDecisionConfig({
    ...config.dramDecision,
    ...(storedDramItem ? {
      symbol: storedDramItem.symbol || config.dramDecision?.symbol,
      shares: storedDramItem.shares ?? config.dramDecision?.shares,
      costPrice: storedDramItem.costPrice ?? config.dramDecision?.costPrice,
    } : {}),
  }), [config.dramDecision, storedDramItem]);
  const [dramConfigInputs, setDramConfigInputs] = useState({
    shares: String(dramConfig.shares),
    costPrice: String(dramConfig.costPrice),
  });
  useEffect(() => {
    setDramConfigInputs({
      shares: String(dramConfig.shares),
      costPrice: String(dramConfig.costPrice),
    });
  }, [dramConfig.shares, dramConfig.costPrice]);
  const commitDramConfig = (patch?: Partial<typeof dramConfig>) => {
    const next = {
      ...dramConfig,
      shares: Math.max(0, parseAmountPart(patch?.shares !== undefined ? String(patch.shares) : dramConfigInputs.shares)),
      costPrice: Math.max(0, parseAmountPart(patch?.costPrice !== undefined ? String(patch.costPrice) : dramConfigInputs.costPrice)),
      ...patch,
    };
    setConfig({ dramDecision: next });
    if (storedDramItem) {
      updateUsStockHoldings(storedUsStockItems.map((item) => (
        item.id === storedDramItem.id
          ? { ...item, symbol: next.symbol, shares: next.shares, costPrice: next.costPrice }
          : item
      )));
    }
  };
  const [dramChart, setDramChart] = useState<MarketChartResponse | null>(null);
  const [dramChartLoading, setDramChartLoading] = useState(false);
  const [dramChartError, setDramChartError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setDramChartLoading(true);
    setDramChartError(false);
    fetch(`/api/market-chart?symbol=${encodeURIComponent(dramConfig.symbol)}&range=6mo&interval=1d`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setDramChart((await response.json()) as MarketChartResponse);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setDramChartError(true);
      })
      .finally(() => setDramChartLoading(false));
    return () => controller.abort();
  }, [dramConfig.symbol]);
  const dramDecision = useMemo(
    () => dramChart ? buildDramDecision({
      chart: dramChart,
      config: dramConfig,
      usdRate: latestUsdRate,
      usStockValueCny: reconcileHoldings.us,
    }) : null,
    [dramChart, dramConfig, latestUsdRate, reconcileHoldings.us],
  );
  const effectiveUsStockItems = useMemo<UsStockHoldingItem[]>(() => {
    if (storedUsStockItems.length > 0) return storedUsStockItems;
    const dramCostValue = latestUsdRate !== null ? roundMoney(dramConfig.shares * dramConfig.costPrice * latestUsdRate) : 0;
    return [
      {
        id: 'dram',
        name: 'DRAM',
        symbol: dramConfig.symbol,
        amountCny: dramCostValue,
        shares: dramConfig.shares,
        costPrice: dramConfig.costPrice,
      },
      {
        id: 'sp500',
        name: '标普',
        symbol: 'SPY',
        amountCny: roundMoney(Math.max(reconcileHoldings.us - dramCostValue, 0)),
      },
    ];
  }, [dramConfig, latestUsdRate, reconcileHoldings.us, storedUsStockItems]);
  const autoFillUsStockAmount = (item: UsStockItemInput) => {
    if (isSpyUsStockInput(item)) return item;
    const amountCny = usStockCostAmountCny(item, latestUsdRate);
    return amountCny !== null ? { ...item, amountCny: String(amountCny) } : item;
  };
  const normalizeUsStockInputs = (inputs: UsStockItemInput[], options?: { autoAmount?: boolean; usTotalCny?: number }) => {
    const shouldAutoAmount = options?.autoAmount !== false;
    const amountInputs = shouldAutoAmount ? inputs.map(autoFillUsStockAmount) : inputs;
    return syncSpyUsStockAmount(amountInputs, options?.usTotalCny ?? reconcileHoldings.us);
  };
  const usStockInputsToItems = (inputs: UsStockItemInput[]) => (
    inputs.map((item, index) => {
      const amountCny = roundMoney(Math.max(0, parseAmountPart(item.amountCny)));
      const shares = item.shares.trim() ? Math.max(0, parseAmountPart(item.shares)) : undefined;
      const costPrice = item.costPrice.trim() ? Math.max(0, parseAmountPart(item.costPrice)) : undefined;
      return {
        id: item.id || `us-stock-${Date.now()}-${index}`,
        name: item.name.trim() || `项目${index + 1}`,
        symbol: item.symbol.trim().toUpperCase(),
        amountCny,
        ...(shares !== undefined ? { shares } : {}),
        ...(costPrice !== undefined ? { costPrice } : {}),
      };
    })
  );
  const [dramDecisionExpanded, setDramDecisionExpanded] = useState(false);
  const [localUsStockItems, setLocalUsStockItems] = useState<UsStockItemInput[]>(
    () => normalizeUsStockInputs(usStockInputsFromItems(effectiveUsStockItems)),
  );
  useEffect(() => {
    setLocalUsStockItems(normalizeUsStockInputs(usStockInputsFromItems(effectiveUsStockItems)));
  }, [effectiveUsStockItems, latestUsdRate, reconcileHoldings.us]);
  const usStockSymbols = useMemo(
    () => [...new Set(localUsStockItems.map((item) => item.symbol.trim().toUpperCase()).filter(Boolean))],
    [localUsStockItems],
  );
  const [usStockCharts, setUsStockCharts] = useState<Record<string, MarketChartResponse>>({});
  const [usStockPriceErrors, setUsStockPriceErrors] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (usStockSymbols.length === 0) return;
    const controller = new AbortController();
    const loadCharts = async () => {
      const results = await Promise.allSettled(usStockSymbols.map(async (symbol) => {
        const response = await fetch(`/api/market-chart?symbol=${encodeURIComponent(symbol)}&range=6mo&interval=1d`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return [symbol, await response.json() as MarketChartResponse] as const;
      }));
      if (controller.signal.aborted) return;
      const failed = new Set<string>();
      setUsStockCharts((prev) => {
        const next = { ...prev };
        results.forEach((result, index) => {
          const symbol = usStockSymbols[index];
          if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
          else failed.add(symbol);
        });
        return next;
      });
      setUsStockPriceErrors(failed);
    };
    loadCharts().catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setUsStockPriceErrors(new Set(usStockSymbols));
    });
    return () => controller.abort();
  }, [usStockSymbols.join('|')]);
  const commitUsStockItems = (inputs = localUsStockItems, options?: { autoAmount?: boolean }) => {
    const normalizedInputs = normalizeUsStockInputs(inputs, options);
    setLocalUsStockItems(normalizedInputs);
    const items = usStockInputsToItems(normalizedInputs);
    updateUsStockHoldings(items);
    const nextDram = items.find((item) => item.symbol === 'DRAM' || item.name.trim().toUpperCase() === 'DRAM');
    if (nextDram) {
      setConfig({
        dramDecision: {
          ...dramConfig,
          symbol: nextDram.symbol || 'DRAM',
          shares: nextDram.shares ?? dramConfig.shares,
          costPrice: nextDram.costPrice ?? dramConfig.costPrice,
        },
      });
    }
  };
  const patchUsStockItem = (item: UsStockItemInput, patch: Partial<UsStockItemInput>, options?: { autoAmount?: boolean }) => {
    const next = { ...item, ...patch };
    return options?.autoAmount ? autoFillUsStockAmount(next) : next;
  };
  const setLocalUsStockItem = (id: string, patch: Partial<UsStockItemInput>, options?: { autoAmount?: boolean }) =>
    setLocalUsStockItems((prev) => normalizeUsStockInputs(prev.map((item) => item.id === id ? patchUsStockItem(item, patch, options) : item)));
  const addUsStockItem = () => {
    const next = normalizeUsStockInputs([
      ...localUsStockItems,
      { id: `us-stock-${Date.now()}`, name: '新项目', symbol: '', amountCny: '0', shares: '', costPrice: '' },
    ]);
    setLocalUsStockItems(next);
    commitUsStockItems(next);
  };
  const removeUsStockItem = (id: string) => {
    const next = normalizeUsStockInputs(localUsStockItems.filter((item) => item.id !== id));
    setLocalUsStockItems(next);
    commitUsStockItems(next);
  };
  const usStockDetailTotal = localUsStockItems.reduce((sum, item) => sum + Math.max(0, parseAmountPart(item.amountCny)), 0);
  const usStockDetailGap = roundMoney(usStockDetailTotal - reconcileHoldings.us);
  const commitInvestUsdCnyInput = (rawCny = investUsdCnyInput) => {
    if (latestUsdRate === null) {
      syncAccounts();
      return;
    }
    const nextAccounts = {
      ...localAccounts,
      investUsdBank: String(roundMoney(parseAmountPart(rawCny) / latestUsdRate)),
    };
    setLocalAccounts(nextAccounts);
    syncAccounts(nextAccounts);
  };
  const switchInvestUsdInputMode = (mode: 'cny' | 'usd') => {
    if (mode === 'usd') {
      commitInvestUsdCnyInput();
      setInvestUsdInputMode('usd');
      return;
    }
    if (latestUsdRate !== null) {
      setInvestUsdCnyInput(String(roundMoney(parseAmountPart(localAccounts.investUsdBank) * latestUsdRate)));
    }
    syncAccounts();
    setInvestUsdInputMode('cny');
  };
  useEffect(() => {
    if (investUsdInputMode !== 'cny' || latestUsdRate === null) return;
    setInvestUsdCnyInput(String(roundMoney(parseAmountPart(localAccounts.investUsdBank) * latestUsdRate)));
  }, [investUsdInputMode, latestUsdRate, localAccounts.investUsdBank]);
  const rebalanceNewFunds = useMemo(
    () => roundMoney((current.accounts.investCnyBank ?? 0) + (latestUsdRate !== null ? (current.accounts.investUsdBank ?? 0) * latestUsdRate : 0)),
    [current.accounts.investCnyBank, current.accounts.investUsdBank, latestUsdRate],
  );
  const recurringInvestments = calcRemainingRecurringInvestments(today, holidayDataByYear);
  const recurringInvestmentTotal = Object.values(recurringInvestments).reduce((sum, amount) => sum + amount, 0);
  const rawRebalanceSuggested = useMemo(() => {
    let suggested;
    if (!allowRebalanceSell && rebalanceNewFunds > 0) {
      suggested = calcTopUpRebalance(effectiveInvestHoldings, investAllocTargets, rebalanceNewFunds, LONG_BOND_REPAY_THRESHOLD);
    } else {
      suggested = calcRebalance(effectiveInvestHoldings, investAllocTargets, rebalanceNewFunds, allowRebalanceSell);
    }
    return deductRecurringInvestments(suggested, recurringInvestments);
  }, [effectiveInvestHoldings, investAllocTargets, rebalanceNewFunds, allowRebalanceSell, recurringInvestments.us, recurringInvestments.asia]);
  const rebalanceSuggested = useMemo(() => {
    const rounded = Object.fromEntries(
      investKeys.map((k) => [k, roundMoney(rawRebalanceSuggested[k] ?? 0)]),
    ) as Record<InvestKey, number>;
    if (allowRebalanceSell || rebalanceNewFunds <= 0) return rounded;

    const isUsdKey = (k: InvestKey) => USD_INVEST_KEYS.includes(k);
    const cnyNeed = investKeys.reduce((s, k) => s + (!isUsdKey(k) ? Math.max(rawRebalanceSuggested[k] ?? 0, 0) : 0), 0);
    const cnyCapacity = roundMoney(Math.max(
      Math.max(current.accounts.investCnyBank ?? 0, 0)
      + Math.max(current.accounts.livingBank ?? 0, 0)
      + Math.max(current.accounts.consumptionBank ?? 0, 0)
      + Math.max(current.accounts.wishJar ?? 0, 0)
      - recurringInvestmentTotal,
      0,
    ));
    if (cnyNeed <= cnyCapacity || cnyNeed <= 0) return rounded;

    const longBondTopUp = Math.max(rawRebalanceSuggested.longBond ?? 0, 0);
    const reservedTopUp = Math.min(cnyCapacity, longBondTopUp);
    rounded.longBond = roundMoney(reservedTopUp);
    const otherCapacity = roundMoney(Math.max(cnyCapacity - reservedTopUp, 0));
    const otherNeed = cnyNeed - longBondTopUp;
    const factor = otherNeed > 0 ? otherCapacity / otherNeed : 0;
    const cnyKeys = investKeys.filter((k) => k !== 'longBond' && !isUsdKey(k) && (rawRebalanceSuggested[k] ?? 0) > 0);
    let scaledTotal = 0;
    let largestKey: InvestKey | null = null;
    for (const k of cnyKeys) {
      const scaled = roundMoney((rawRebalanceSuggested[k] ?? 0) * factor);
      rounded[k] = scaled;
      scaledTotal = roundMoney(scaledTotal + scaled);
      if (largestKey === null || (rawRebalanceSuggested[k] ?? 0) > (rawRebalanceSuggested[largestKey] ?? 0)) {
        largestKey = k;
      }
    }
    const drift = roundMoney(otherCapacity - scaledTotal);
    if (largestKey && Math.abs(drift) >= 0.01) {
      rounded[largestKey] = roundMoney(Math.max(rounded[largestKey] + drift, 0));
    }
    return rounded;
  }, [allowRebalanceSell, current.accounts, investKeys, rawRebalanceSuggested, rebalanceNewFunds, recurringInvestmentTotal]);
  const rebalanceCnyGiveUpCny = useMemo(() => {
    if (allowRebalanceSell || rebalanceNewFunds <= 0) return 0;
    const rawCnyNeed = investKeys.reduce((s, k) => s + (!USD_INVEST_KEYS.includes(k) ? Math.max(rawRebalanceSuggested[k] ?? 0, 0) : 0), 0);
    const cappedCnyNeed = investKeys.reduce((s, k) => s + (!USD_INVEST_KEYS.includes(k) ? Math.max(rebalanceSuggested[k] ?? 0, 0) : 0), 0);
    return roundMoney(Math.max(rawCnyNeed - cappedCnyNeed, 0));
  }, [allowRebalanceSell, investKeys, rawRebalanceSuggested, rebalanceNewFunds, rebalanceSuggested]);

  const totalInvest = investKeys.reduce((s, k) => s + effectiveInvestHoldings[k], 0);
  const allocationRatios = calcAllocationRatios(effectiveInvestHoldings, investAllocTargets, LONG_BOND_REPAY_THRESHOLD);
  const rebalanceFunding = useMemo(() => {
    const isUsdKey = (k: InvestKey) => USD_INVEST_KEYS.includes(k);
    const usdBuyCny = investKeys.reduce((s, k) => s + (isUsdKey(k) ? Math.max(rebalanceSuggested[k], 0) : 0), 0);
    const usdSellCny = investKeys.reduce((s, k) => s + (isUsdKey(k) ? Math.max(-rebalanceSuggested[k], 0) : 0), 0);
    const cnyBuy = recurringInvestmentTotal + investKeys.reduce((s, k) => s + (!isUsdKey(k) ? Math.max(rebalanceSuggested[k], 0) : 0), 0);
    const cnySell = investKeys.reduce((s, k) => s + (!isUsdKey(k) ? Math.max(-rebalanceSuggested[k], 0) : 0), 0);
    const usdInvestCny = latestUsdRate !== null ? (current.accounts.investUsdBank ?? 0) * latestUsdRate : 0;
    const investCny = current.accounts.investCnyBank ?? 0;
    const baseFunding = {
      usdBuyCny,
      usdSellCny,
      cnyBuy,
      cnySell,
      usdInvestCny,
      usdReplaceCny: 0,
      usdReplaceUseCny: 0,
      usdCompensateCny: 0,
      cnyToUsdCny: 0,
      usdSurplusCny: 0,
      usdParkCny: 0,
      cnyFromRmbBuffer: 0,
      cnyGiveUpCny: allowRebalanceSell ? 0 : rebalanceCnyGiveUpCny,
      usdReplaceRows: [] as RebalanceFundingBucket[],
      cnyBufferRows: [] as RebalanceFundingBucket[],
      needConsumption: false,
      needWish: false,
      cnyCashNeeded: Math.max(cnyBuy - cnySell, 0),
      cnyCashAfter: investCny - Math.max(cnyBuy - cnySell, 0),
    };

    if (allowRebalanceSell) {
      return baseFunding;
    }

    let usdAfterInvest = Math.max(usdBuyCny - usdInvestCny, 0);
    let usdReplaceCny = 0;
    let usdReplaceUseCny = 0;
    let usdCompensateCny = 0;
    const usdReplaceRows: RebalanceFundingBucket[] = [];
    let needConsumption = false;
    let needWish = false;
    if (latestUsdRate !== null) {
      for (const bucket of USD_REPLACE_BUCKETS) {
        const availableCny = Math.max(current.accounts[bucket.usdKey] ?? 0, 0) * latestUsdRate;
        usdReplaceCny += availableCny;
        const useCny = Math.min(usdAfterInvest, availableCny);
        if (useCny > 0) {
          usdReplaceUseCny += useCny;
          usdCompensateCny += useCny;
          usdReplaceRows.push({ ...bucket, amountCny: roundMoney(useCny) });
          if (bucket.usdKey === 'usdConsumptionBank') needConsumption = true;
          if (bucket.usdKey === 'usdWishJar') needWish = true;
          usdAfterInvest -= useCny;
        }
      }
    }
    const cnyToUsdCny = Math.max(usdAfterInvest, 0);
    const usdSurplusCny = latestUsdRate !== null ? Math.max(usdInvestCny - usdBuyCny, 0) : 0;
    let cnyAfterInvest = Math.max(cnyBuy - Math.max(investCny, 0), 0);
    let usdSurplusToPark = usdSurplusCny;
    let usdParkCny = 0;
    let cnyFromRmbBuffer = 0;
    const cnyBufferRows: RebalanceFundingBucket[] = [];
    if (latestUsdRate !== null && cnyAfterInvest > 0 && usdSurplusToPark > 0) {
      for (const bucket of USD_REPLACE_BUCKETS) {
        const availableCny = Math.max(current.accounts[bucket.cnyKey] ?? 0, 0);
        const useCny = Math.min(cnyAfterInvest, availableCny, usdSurplusToPark);
        if (useCny <= 0) continue;
        const roundedUseCny = roundMoney(useCny);
        cnyFromRmbBuffer += roundedUseCny;
        usdParkCny += roundedUseCny;
        cnyBufferRows.push({ ...bucket, amountCny: roundedUseCny });
        cnyAfterInvest = roundMoney(cnyAfterInvest - roundedUseCny);
        usdSurplusToPark = roundMoney(usdSurplusToPark - roundedUseCny);
        if (bucket.usdKey === 'usdConsumptionBank') needConsumption = true;
        if (bucket.usdKey === 'usdWishJar') needWish = true;
      }
    }
    const cnyGiveUpCny = roundMoney(Math.max(cnyAfterInvest, 0) + rebalanceCnyGiveUpCny);
    const cnyCashNeeded = Math.max(cnyBuy + usdCompensateCny + cnyToUsdCny - cnySell - cnyFromRmbBuffer, 0);
    const cnyCashAfter = investCny - cnyCashNeeded;
    return {
      usdBuyCny,
      usdSellCny,
      cnyBuy,
      cnySell,
      usdInvestCny,
      usdReplaceCny: roundMoney(usdReplaceCny),
      usdReplaceUseCny: roundMoney(usdReplaceUseCny),
      usdCompensateCny: roundMoney(usdCompensateCny),
      cnyToUsdCny: roundMoney(cnyToUsdCny),
      usdSurplusCny: roundMoney(usdSurplusCny),
      usdParkCny: roundMoney(usdParkCny),
      cnyFromRmbBuffer: roundMoney(cnyFromRmbBuffer),
      cnyGiveUpCny,
      usdReplaceRows,
      cnyBufferRows,
      needConsumption,
      needWish,
      cnyCashNeeded: roundMoney(cnyCashNeeded),
      cnyCashAfter: roundMoney(cnyCashAfter),
    };
  }, [allowRebalanceSell, current.accounts, investKeys, latestUsdRate, rebalanceCnyGiveUpCny, rebalanceSuggested, recurringInvestmentTotal]);

  useEffect(() => {
    if (!rebalanceFunding.needConsumption && !rebalanceFunding.needWish) return;
    setRevealedUsdAccounts((prev) => {
      const next = new Set(prev);
      if (rebalanceFunding.needConsumption) next.add('usdConsumptionBank');
      if (rebalanceFunding.needWish) next.add('usdWishJar');
      if (next.size === prev.size && [...next].every((key) => prev.has(key))) return prev;
      return next;
    });
    setConsumptionWishOpen(true);
  }, [rebalanceFunding.needConsumption, rebalanceFunding.needWish]);


  // 一键执行转账：把已转金额加到对应账户，收入账户相应减少，然后已转归零
  // 校园卡 例外：钱来自信用卡刷一笔，所以不扣 incomeBank，而是挂到信用卡总待还
  const handleExecuteAll = () => {
    const amounts = Object.fromEntries(TRANSFER_KEYS.map((key) => [key, key === 'raiseSavings' && config.raiseSavings?.enabled === false ? 0 : parseAmountPart(localTransferred[key])])) as Record<TransferKey, number>;
    executeTransfers(amounts, curYM);
    const updatedAccounts = useSnapshotStore.getState().current.accounts;
    setLocalAccounts((previous) => {
      const next = { ...previous };
      for (const key of Object.keys(updatedAccounts) as (keyof AccountSnapshot['accounts'])[]) {
        if (updatedAccounts[key] !== current.accounts[key]) next[key] = String(updatedAccounts[key]);
      }
      return next;
    });
    const zeroed = Object.fromEntries(TRANSFER_KEYS.map((k) => [k, 0])) as Record<TransferKey, number>;
    const zeroedStr = Object.fromEntries(TRANSFER_KEYS.map((k) => [k, '0'])) as Record<TransferKey, string>;
    setConfirmed(zeroed);
    setLocalTransferred(zeroedStr);
  };

  const hasTransferChanges = TRANSFER_KEYS.some((k) => (
    k === 'raiseSavings' ? config.raiseSavings?.enabled !== false && parseAmountPart(localTransferred[k]) > 0 : parseAmountPart(localTransferred[k]) !== 0
  ));

  // 赎回长债超过阈值的部分用于还款：长债↓ → 储蓄卡↑（储蓄卡再抵信用卡本期待还）
  const handleRedeemLongBond = () => {
    const amount = roundMoney(longBondRepay);
    if (amount <= 0) return;
    const newLongBond = roundMoney(reconcileHoldings.longBond - amount);
    const newSavings = roundMoney((current.accounts.savingsCard ?? 0) + amount);
    const nextHoldings = { ...reconcileHoldings, longBond: newLongBond };
    updateReconcileHoldings(nextHoldings);
    updateAccounts({ savingsCard: newSavings });
    setLocalAccounts((p) => ({ ...p, savingsCard: String(newSavings) }));
  };

  const todayDate = today.getDate();
  const payDateDay = (item: ResolvedIncomeItem) => Number(item.resolvedPayDate.slice(8, 10));
  const internIncomeLast = (a: ResolvedIncomeItem, b: ResolvedIncomeItem) =>
    Number(a.isInternPayroll) - Number(b.isInternPayroll);
  const makeIncomeNote = (item: ResolvedIncomeItem, status: 'upcoming' | 'received' | 'next' | 'following') => {
    const baseLabel = status === 'received'
      ? `${payDateDay(item)}号已发`
      : status === 'next'
        ? `次月${payDateDay(item)}号发薪`
        : status === 'following'
          ? `后月${payDateDay(item)}号发薪`
        : `${payDateDay(item)}号发薪`;
    const taxLabel = item.taxAmount > 0
      ? `；扣税¥${fmtInt(item.taxAmount)}，到手¥${fmtInt(item.resolvedAmount)}`
      : item.taxRuleError
        ? `；${item.taxRuleError}`
        : '';
    if (item.internshipPayroll) return `${baseLabel} · 出勤${item.resolvedDayCount}天 · 房补¥${fmtInt(item.internshipPayroll.housingAmount)}${taxLabel}`;
    if (item.isInternPayroll && item.payrollCycle) {
      return `${baseLabel}（截止${dateLabel(item.payrollCycle.cutoffDate)}；${item.payrollCycle.internDays}天×¥${item.dailyRate ?? 0}/天${taxLabel}）`;
    }
    if (item.dailyRate !== undefined && item.tagKind) {
      return `${baseLabel}（${item.resolvedDayCount ?? 0}天×¥${item.dailyRate}/天${taxLabel}）`;
    }
    return taxLabel ? `${baseLabel}（${taxLabel.slice(1)}）` : baseLabel;
  };

  // 预算明细（收入按发薪日判断是否已发，日薪项显示计算方式）

  // 信用卡按实际还款日归期；对账视图模式不改变应还月份。
  const configuredCreditPayDay = Math.min(Math.max(Math.round(config.creditPayDate || 1), 1), 31);
  const creditInThisMonth = todayDate <= configuredCreditPayDay;
  const creditMonthlyOriginal = Math.max(current.accounts.creditMonthly ?? 0, 0);
  const creditNextOriginal = Math.max((current.accounts.credit ?? 0) - creditMonthlyOriginal, 0);
  const savingsCardForCredit = Math.max(current.accounts.savingsCard ?? 0, 0);
  const savingsAppliedMonthly = Math.min(savingsCardForCredit, creditMonthlyOriginal);
  const savingsAppliedNext = Math.min(
    Math.max(savingsCardForCredit - creditMonthlyOriginal, 0),
    creditNextOriginal,
  );
  const creditDetailNote = (
    dueLabel: string,
    original: number,
    savingsApplied: number,
    longBondApplied: number,
    remaining: number,
  ) => `${dueLabel} · 原应还 ¥${fmtInt(original)} · 储蓄卡抵 ¥${fmtInt(savingsApplied)} · 长债抵 ¥${fmtInt(longBondApplied)} · 剩 ¥${fmtInt(remaining)}`;
  const creditMonthlyItem: BudgetDetailItem = {
    icon: '💳',
    label: '信用卡本期待还',
    amount: effectiveCreditMonthly,
    note: creditDetailNote(
      `${creditInThisMonth ? '' : '次月'}${configuredCreditPayDay}号还款`,
      creditMonthlyOriginal,
      savingsAppliedMonthly,
      longBondRepay,
      effectiveCreditMonthly,
    ),
  };
  const creditNextItem: BudgetDetailItem = {
    icon: '💳',
    label: '信用卡下期',
    amount: effectiveCreditNext,
    note: creditDetailNote(
      `${creditInThisMonth ? '次月' : '后月'}${configuredCreditPayDay}号还款`,
      creditNextOriginal,
      savingsAppliedNext,
      longBondRepayNext,
      effectiveCreditNext,
    ),
  };
  const settledCreditItem: BudgetDetailItem = {
    icon: '✅',
    label: '信用卡本月',
    amount: 0,
    note: `${configuredCreditPayDay}号已过 · 本月已还清`,
  };

  const livingRows = (window: BudgetKey): BudgetDetailItem[] => {
    const yearMonth = window === 'monthly' ? curYM
      : window === 'beyond' ? `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}`
        : `${followingYear}-${String(followingMonth + 1).padStart(2, '0')}`;
    const grouped = new Map<string, { icon: string; amount: number; days: number }>();
    for (const { date, tag } of tags) {
      const day = Number(date.slice(8));
      const include = date.startsWith(yearMonth) && (window !== 'monthly' || day > todayDate);
      if (!include) continue;
      const context = resolveDailyContext(date, tag, internship);
      const { label, icon } = BUDGET_SCENE_META[context.livingKind];
      const item = grouped.get(label) ?? { icon, amount: 0, days: 0 };
      item.amount += dailyLivingAmount(date, tag, stats, internship); item.days++; grouped.set(label, item);
    }
    return [...grouped].map(([label, value]) => ({ icon: value.icon, label, amount: Math.round(value.amount), note: `${value.days}天`, isLivingExpense: true }));
  };
  const budgetDetails: Record<BudgetKey, { income: BudgetDetailItem[]; expense: BudgetDetailItem[] }> = {
    monthly: {
      income: [
        { icon: '🏦', label: '生活账户余额', amount: current.accounts.livingBank ?? 0, note: '当前余额' },
        ...currentResolvedIncomeItems.filter((item) => item.isActive).sort(internIncomeLast).map((item) => {
          const received = payDateDay(item) <= todayDate;
          return {
            isIncome: true,
            icon: received ? '✅' : '💰',
            label: item.name,
            amount: received ? 0 : item.resolvedAmount,
            note: makeIncomeNote(item, received ? 'received' : 'upcoming'),
          };
        }),
      ],
      expense: [
        creditInThisMonth ? creditMonthlyItem : settledCreditItem,
        ...livingRows('monthly'),
      ],
    },
    beyond: {
      income: nextResolvedIncomeItems.filter((item) => item.isActive).sort(internIncomeLast).map((item) => ({
        isIncome: true,
        icon: '💰',
        label: item.name,
        amount: item.resolvedAmount,
        note: makeIncomeNote(item, 'next'),
      })),
      expense: [
        creditInThisMonth ? creditNextItem : creditMonthlyItem,
        ...livingRows('beyond'),
      ],
    },
    following: {
      income: followingResolvedIncomeItems.filter(item => item.isActive).sort(internIncomeLast).map(item => ({
        isIncome: true,
        icon: '💰',
        label: item.name,
        amount: item.resolvedAmount,
        note: makeIncomeNote(item, 'following'),
      })),
      expense: [
        ...(!creditInThisMonth ? [creditNextItem] : []),
        ...livingRows('following'),
      ],
    },
  };

  const sumDetailExp = (key: BudgetKey) =>
    budgetDetails[key].expense.reduce((s, i) => s + i.amount, 0);
  const sumDetailInc = (key: BudgetKey) =>
    budgetDetails[key].income.reduce((s, i) => s + i.amount, 0);

  const budgetPeriods: { key: BudgetKey; name: string }[] = [
    { key: 'monthly', name: '本月' },
    { key: 'beyond', name: '次月' },
    { key: 'following', name: '后月' },
  ];
  const rolledMonths = rollBudgetMonths(budgetPeriods.map(({ key }) => ({
    income: sumDetailInc(key), expense: sumDetailExp(key),
  })));
  const budgetRows = budgetPeriods.map((period, index) => {
    const { income, expense, carry, balance } = rolledMonths[index];
    if (index > 0 && carry !== 0) {
      const previousName = budgetPeriods[index - 1].name;
      budgetDetails[period.key][carry > 0 ? 'income' : 'expense'].unshift({
        icon: '🔁', label: `${previousName}${carry > 0 ? '结余' : '赤字'}结转`, amount: Math.abs(carry),
      });
    }
    return { ...period, inc: income, exp: expense, balance };
  });

  // 建议转账直接引用预算明细中的本月支出。
  const monthlyExpenseForTransfer = sumDetailExp('monthly');
  const campusShortfallForTransfer = Math.max(budget.needs.campusCard - (current.accounts.campusCard ?? 0), 0);
  const repaymentNeedForTransfer = current.accounts.creditMonthly ?? 0;
  const repaymentShortfallForTransfer = creditInThisMonth
    ? Math.max(repaymentNeedForTransfer - (current.accounts.savingsCard ?? 0) - longBondRepay, 0)
    : 0;
  const livingNeedForTransfer = Math.max(
    monthlyExpenseForTransfer
      - repaymentShortfallForTransfer
      - budget.needs.campusCard,
    0,
  );
  const monthlyLivingShortfall = Math.max(livingNeedForTransfer - (current.accounts.livingBank ?? 0), 0);
  const incomeAvailableForTransfer = current.accounts.incomeBank ?? 0;
  const raiseSavingsSettings = resolveRaiseSavingsSettings(config.raiseSavings);
  const raiseSavings = calculateRaiseSavings({
    incomeItems: actualIncomeItems[curYM] ?? [],
    today: formatDateKey(today),
    baseline: config.recurringIncomeBaseline,
    settings: config.raiseSavings,
    saved: current.raiseSavingsByMonth?.[curYM],
  });
  const livingTransfer = calculateLivingTransfer({
    monthlyShortfall: monthlyLivingShortfall,
    monthlyBalances: budgetRows.map(row => row.balance),
    incomeBalance: incomeAvailableForTransfer,
    raiseSavingsRemaining: raiseSavings.remaining,
    repaymentShortfall: repaymentShortfallForTransfer,
  });
  const livingShortfallForTransfer = livingTransfer.transfer;
  // 校园卡走信用卡，不占工资；生活建议封顶，未补足的需求仍保留缺口提示。
  const essentialTotalForTransfer = repaymentShortfallForTransfer + livingShortfallForTransfer;
  const {
    needsRedemption: needsRedemptionForTransfer,
    afterEssentials: incomeAfterEssentialsForTransfer,
    invest: investForTransfer,
    wishJar: wishJarForTransfer,
    consumption: consumptionForTransfer,
  } = calculateTransferAllocation(incomeAvailableForTransfer, repaymentShortfallForTransfer + livingTransfer.need, raiseSavings.remaining);

  // 配平转账拆成独立的「单腿」：每条都是同币种账户互转（或一笔真换汇），可分开调、分开执行
  type FundingLegOp = 'cnyBufferToInvest' | 'investUsdToBuffer' | 'bufferUsdToInvest' | 'investCnyToBuffer' | 'forex';
  type FundingLeg = {
    key: string;
    kind: FundingBadgeKind;
    op: FundingLegOp;
    amountCny: number;
    text: string;
    usdHint?: boolean;
    cnyKey?: keyof AccountSnapshot['accounts'];
    usdKey?: UsdVirtualAccountKey;
  };
  const [localFundingLeg, setLocalFundingLeg] = useState<Record<string, string>>({});
  const fundingLegValue = (key: string) => localFundingLeg[key] ?? '0';
  const setFundingLegValue = (key: string, v: string) => setLocalFundingLeg((p) => ({ ...p, [key]: v }));
  const resetFundingLegs = (legs: FundingLeg[]) =>
    setLocalFundingLeg((p) => { const n = { ...p }; for (const l of legs) n[l.key] = '0'; return n; });

  // 页面级撤回：只在用户交互触发的可见状态变化前入栈，忽略汇率等异步刷新。
  const undoHistoryRef = useRef<{ state: ReconcileUndoState; fingerprint: string }[]>([]);
  const pendingUndoRef = useRef<{ state: ReconcileUndoState; fingerprint: string } | null>(null);
  const pendingUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoringUndoRef = useRef(false);
  const previousUndoFingerprintRef = useRef<string | null>(null);
  const latestUndoState = useMemo<ReconcileUndoState>(() => ({
    current: cloneAccountSnapshot(current),
    config: {
      recurringIncomeBaseline: config.recurringIncomeBaseline,
      raiseSavings: config.raiseSavings ? { ...config.raiseSavings } : undefined,
      investAllocTargets: { ...config.investAllocTargets },
      dramDecision: config.dramDecision ? { ...config.dramDecision } : undefined,
    },
    revealConsumptionWishUsd,
    localAccounts: { ...localAccounts },
    revealedUsdAccounts: [...revealedUsdAccounts],
    investUsdInputMode,
    investUsdCnyInput,
    confirmed: { ...confirmed },
    localTransferred: { ...localTransferred },
    consumptionWishOpen,
    groupedTargetInputs: {
      groups: { ...groupedTargetInputs.groups },
      assets: { ...groupedTargetInputs.assets },
    },
    reconcileMode,
    allowRebalanceSell,
    localHoldings: { ...localHoldings },
    localUsStockItems: localUsStockItems.map((item) => ({ ...item })),
    dramConfigInputs: { ...dramConfigInputs },
    localFundingLeg: { ...localFundingLeg },
  }), [
    allowRebalanceSell, config.dramDecision, config.investAllocTargets, config.recurringIncomeBaseline, config.raiseSavings, confirmed, consumptionWishOpen,
    current, dramConfigInputs, groupedTargetInputs, investUsdCnyInput, investUsdInputMode,
    localAccounts, localFundingLeg, localHoldings, localTransferred, localUsStockItems,
    reconcileMode, revealConsumptionWishUsd, revealedUsdAccounts,
  ]);
  const latestUndoFingerprint = useMemo(() => reconcileUndoFingerprint(latestUndoState), [latestUndoState]);
  const latestUndoStateRef = useRef(latestUndoState);
  latestUndoStateRef.current = latestUndoState;

  const armUndoCheckpoint = () => {
    if (restoringUndoRef.current) return;
    const state = cloneReconcileUndoState(latestUndoStateRef.current);
    pendingUndoRef.current = { state, fingerprint: reconcileUndoFingerprint(state) };
    if (pendingUndoTimerRef.current) clearTimeout(pendingUndoTimerRef.current);
    pendingUndoTimerRef.current = setTimeout(() => {
      pendingUndoRef.current = null;
      pendingUndoTimerRef.current = null;
    }, 0);
  };

  useLayoutEffect(() => {
    const previousFingerprint = previousUndoFingerprintRef.current;
    if (previousFingerprint === null) {
      previousUndoFingerprintRef.current = latestUndoFingerprint;
      return;
    }
    if (restoringUndoRef.current) {
      restoringUndoRef.current = false;
      pendingUndoRef.current = null;
      previousUndoFingerprintRef.current = latestUndoFingerprint;
      return;
    }
    if (latestUndoFingerprint === previousFingerprint) return;
    const pending = pendingUndoRef.current;
    if (pending?.fingerprint === previousFingerprint) {
      const history = undoHistoryRef.current;
      if (history[history.length - 1]?.fingerprint !== pending.fingerprint) {
        history.push(pending);
        if (history.length > 50) history.shift();
      }
    }
    pendingUndoRef.current = null;
    previousUndoFingerprintRef.current = latestUndoFingerprint;
  }, [latestUndoFingerprint]);

  const handleUndo = () => {
    const previous = undoHistoryRef.current.pop();
    if (!previous) return;
    restoringUndoRef.current = true;
    pendingUndoRef.current = null;
    if (pendingUndoTimerRef.current) {
      clearTimeout(pendingUndoTimerRef.current);
      pendingUndoTimerRef.current = null;
    }
    restoreCurrent(cloneAccountSnapshot(previous.state.current));
    setConfig({
      recurringIncomeBaseline: previous.state.config.recurringIncomeBaseline,
      raiseSavings: previous.state.config.raiseSavings ? { ...previous.state.config.raiseSavings } : undefined,
      investAllocTargets: { ...previous.state.config.investAllocTargets },
      dramDecision: previous.state.config.dramDecision ? { ...previous.state.config.dramDecision } : undefined,
    });
    setRevealConsumptionWishUsd(previous.state.revealConsumptionWishUsd);
    setLocalAccounts({ ...previous.state.localAccounts });
    setRevealedUsdAccounts(new Set(previous.state.revealedUsdAccounts));
    setInvestUsdInputMode(previous.state.investUsdInputMode);
    setInvestUsdCnyInput(previous.state.investUsdCnyInput);
    setConfirmed({ ...previous.state.confirmed });
    setLocalTransferred({ ...previous.state.localTransferred });
    setConsumptionWishOpen(previous.state.consumptionWishOpen);
    setGroupedTargetInputs({
      groups: { ...previous.state.groupedTargetInputs.groups },
      assets: { ...previous.state.groupedTargetInputs.assets },
    });
    setReconcileMode(previous.state.reconcileMode);
    setAllowRebalanceSell(previous.state.allowRebalanceSell);
    setLocalHoldings({ ...previous.state.localHoldings });
    setLocalUsStockItems(previous.state.localUsStockItems.map((item) => ({ ...item })));
    setDramConfigInputs({ ...previous.state.dramConfigInputs });
    setLocalFundingLeg({ ...previous.state.localFundingLeg });
  };

  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      handleUndoRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (pendingUndoTimerRef.current) clearTimeout(pendingUndoTimerRef.current);
    };
  }, []);

  const rebalanceFundingRows = rebalanceFunding.cnyBufferRows.filter((row) => Math.abs(row.amountCny) >= 0.5);
  const usdReplaceRows = rebalanceFunding.usdReplaceRows.filter((row) => Math.abs(row.amountCny) >= 0.5);
  const usdForexCny = !allowRebalanceSell ? rebalanceFunding.cnyToUsdCny : 0;

  // 每个 buffer 一组转换：人民币腿 + 美元腿（同一笔金额、人民币口径）
  type FundingRow = { key: string; label: string; cnyLeg: FundingLeg; usdLeg: FundingLeg };

  // 理财调拨（人民币加仓）= 美元→人民币：理财卖美元(↓转出)、得人民币(↑进入)
  const cnyFundingRows: FundingRow[] = rebalanceFundingRows.map((row) => ({
    key: row.usdKey,
    label: row.label,
    cnyLeg: { key: `${row.usdKey}__cnyIn`, kind: 'cny', op: 'cnyBufferToInvest', cnyKey: row.cnyKey, amountCny: row.amountCny, text: `人民币${row.label} → 人民币理财` },
    usdLeg: { key: `${row.usdKey}__usdPark`, kind: 'usd', op: 'investUsdToBuffer', usdKey: row.usdKey, amountCny: row.amountCny, usdHint: true, text: `美元理财 → 美元${row.label}（停泊）` },
  }));
  const cnyFundingLegs: FundingLeg[] = cnyFundingRows.flatMap((r) => [r.cnyLeg, r.usdLeg]);

  // 美元调拨（美元加仓）= 人民币→美元：买美元（buffer 对敲假置换 + 真换汇）
  const usdFundingRows: FundingRow[] = usdReplaceRows.map((row) => ({
    key: row.usdKey,
    label: row.label,
    cnyLeg: { key: `${row.usdKey}__cnyComp`, kind: 'cny', op: 'investCnyToBuffer', cnyKey: row.cnyKey, amountCny: row.amountCny, text: `人民币理财 → 人民币${row.label}（补偿）` },
    usdLeg: { key: `${row.usdKey}__usdIn`, kind: 'usd', op: 'bufferUsdToInvest', usdKey: row.usdKey, amountCny: row.amountCny, usdHint: true, text: `美元${row.label} → 美元理财` },
  }));
  const forexLeg: FundingLeg | null = usdForexCny >= 0.5
    ? { key: 'forex', kind: 'forex', op: 'forex', amountCny: usdForexCny, usdHint: true, text: '人民币理财 兑换 美元理财（有手续费）' }
    : null;
  const usdFundingLegs: FundingLeg[] = [
    ...usdFundingRows.flatMap((r) => [r.usdLeg, r.cnyLeg]),
    ...(forexLeg ? [forexLeg] : []),
  ];
  const cnyFundingInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const usdFundingInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const hasCnyFundingChanges = cnyFundingLegs.some((l) => parseAmountPart(fundingLegValue(l.key)) > 0);
  const hasUsdFundingChanges = usdFundingLegs.some((l) => parseAmountPart(fundingLegValue(l.key)) > 0);
  // 执行单腿：每条都是「同币种账户互转」或一笔真换汇，按用户输入金额（人民币口径）落账，受可用额封顶
  const applyFundingLeg = (acc: AccountSnapshot['accounts'], leg: FundingLeg, inputCny: number, rate: number): boolean => {
    if (inputCny <= 0) return false;
    switch (leg.op) {
      case 'cnyBufferToInvest': {  // 人民币 buffer → 人民币理财
        const m = roundMoney(Math.min(inputCny, leg.amountCny, Math.max(acc[leg.cnyKey!] ?? 0, 0)));
        if (m <= 0) return false;
        acc[leg.cnyKey!] = roundMoney((acc[leg.cnyKey!] ?? 0) - m);
        acc.investCnyBank = roundMoney((acc.investCnyBank ?? 0) + m);
        return true;
      }
      case 'investCnyToBuffer': {  // 人民币理财 → 人民币 buffer（补偿）
        const m = roundMoney(Math.min(inputCny, leg.amountCny, Math.max(acc.investCnyBank ?? 0, 0)));
        if (m <= 0) return false;
        acc.investCnyBank = roundMoney((acc.investCnyBank ?? 0) - m);
        acc[leg.cnyKey!] = roundMoney((acc[leg.cnyKey!] ?? 0) + m);
        return true;
      }
      case 'investUsdToBuffer': {  // 美元理财 → 美元 buffer（停泊）
        const t = Math.min(inputCny, leg.amountCny, Math.max(acc.investUsdBank ?? 0, 0) * rate);
        const usd = roundMoney(Math.min(Math.max(acc.investUsdBank ?? 0, 0), t / rate));
        if (usd <= 0) return false;
        acc.investUsdBank = roundMoney((acc.investUsdBank ?? 0) - usd);
        acc[leg.usdKey!] = roundMoney((acc[leg.usdKey!] ?? 0) + usd);
        return true;
      }
      case 'bufferUsdToInvest': {  // 美元 buffer → 美元理财
        const t = Math.min(inputCny, leg.amountCny, Math.max(acc[leg.usdKey!] ?? 0, 0) * rate);
        const usd = roundMoney(Math.min(Math.max(acc[leg.usdKey!] ?? 0, 0), t / rate));
        if (usd <= 0) return false;
        acc[leg.usdKey!] = roundMoney((acc[leg.usdKey!] ?? 0) - usd);
        acc.investUsdBank = roundMoney((acc.investUsdBank ?? 0) + usd);
        return true;
      }
      case 'forex': {  // 人民币理财 兑换 美元理财（真换汇）
        const t = Math.min(inputCny, leg.amountCny, Math.max(acc.investCnyBank ?? 0, 0));
        const usd = roundMoney(t / rate);
        const spent = roundMoney(usd * rate);
        if (usd <= 0 || spent <= 0) return false;
        acc.investCnyBank = roundMoney((acc.investCnyBank ?? 0) - spent);
        acc.investUsdBank = roundMoney((acc.investUsdBank ?? 0) + usd);
        return true;
      }
    }
    return false;
  };
  const executeFundingLegs = (legs: FundingLeg[]) => {
    if (latestUsdRate === null) {
      window.alert('暂无美元汇率，先录入汇率后再执行调拨。');
      return;
    }
    const acc: AccountSnapshot['accounts'] = { ...current.accounts };
    let changed = false;
    for (const leg of legs) {
      if (applyFundingLeg(acc, leg, parseAmountPart(fundingLegValue(leg.key)), latestUsdRate)) changed = true;
    }
    if (!changed) return;
    updateAccounts(acc);
    setLocalAccounts((prev) => ({
      ...prev,
      livingBank: String(acc.livingBank),
      consumptionBank: String(acc.consumptionBank),
      wishJar: String(acc.wishJar),
      investCnyBank: String(acc.investCnyBank),
      usdLivingBank: String(acc.usdLivingBank),
      usdConsumptionBank: String(acc.usdConsumptionBank),
      usdWishJar: String(acc.usdWishJar),
      investUsdBank: String(acc.investUsdBank),
    }));
    resetFundingLegs(legs);
  };
  const fmtLegNeed = (leg: FundingLeg) =>
    leg.usdHint && latestUsdRate !== null ? `≈${fmtUsd(leg.amountCny / latestUsdRate)}` : `¥${fmtInt(leg.amountCny)}`;
  const fmtUsdFromCny = (cny: number) =>
    latestUsdRate !== null ? `≈${fmtUsd(cny / latestUsdRate)}` : `¥${fmtInt(cny)}`;
  const renderLegInput = (
    leg: FundingLeg,
    refs: { current: (HTMLInputElement | null)[] },
    refIndex: number,
  ) => {
    const transferred = parseAmountPart(fundingLegValue(leg.key));
    return (
      <AmountInput
        ref={(el) => { refs.current[refIndex] = el; }}
        value={fundingLegValue(leg.key)}
        onChange={(v) => setFundingLegValue(leg.key, normalizeAmountInput(v))}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); refs.current[refIndex + 1]?.focus(); } }}
        style={{ width: '100%', border: `1.5px solid ${transferred > 0 ? '#81c995' : '#dadce0'}`, borderRadius: 8, padding: '5px 8px', fontSize: 13, fontWeight: 600, textAlign: 'right', outline: 'none', backgroundColor: transferred > 0 ? '#e6f4ea' : '#fff', color: transferred > 0 ? C.green : '#202124', boxSizing: 'border-box' }}
      />
    );
  };
  const SwapTag = ({ fee }: { fee?: boolean }) => (
    <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap',
      color: fee ? '#e8710a' : '#137333', backgroundColor: fee ? '#fef3e8' : '#e6f4ea' }}>
      {fee ? '真换汇·手续费' : '假置换·免手续费'}
    </span>
  );
  // 以「理财」为主体的大色块：人民币理财(绿)/美元理财(蓝)，块内挂各 bucket 小色块
  // dir: 'in'=转入理财(↑)、'out'=转出理财(↓)
  const renderBigBlock = (
    kind: 'cny' | 'usd',
    dir: 'in' | 'out',
    legs: { label: string; leg: FundingLeg }[],
    refs: { current: (HTMLInputElement | null)[] },
    startIndex: number,
  ) => {
    const s = kind === 'cny'
      ? { bg: '#e6f4ea', border: '#ceead6', color: C.green, name: '人民币理财' }
      : { bg: '#e8f0fe', border: '#d2e3fc', color: C.blue, name: '美元理财' };
    return (
      <div className="reconcile-funding-block" style={{ backgroundColor: s.bg, border: `1px solid ${s.border}`, borderRadius: 12, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="reconcile-wrap-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: s.color }}>{s.name}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: s.color }}>{dir === 'in' ? '↑ 转入理财' : '↓ 转出理财'}</span>
        </div>
        {legs.map(({ label, leg }, j) => {
          const remain = Math.max(leg.amountCny - parseAmountPart(fundingLegValue(leg.key)), 0);
          return (
            <div key={leg.key} style={{ backgroundColor: '#fff', borderRadius: 8, padding: '5px 7px' }}>
              <div className="reconcile-wrap-row" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4, marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}>{label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{fmtLegNeed(leg)}</span>
              </div>
              {renderLegInput(leg, refs, startIndex + j)}
              {remain >= 1 && <div style={{ fontSize: 10, color: C.orange, textAlign: 'right', marginTop: 2 }}>还需¥{fmtInt(remain)}</div>}
            </div>
          );
        })}
      </div>
    );
  };
  // 真换汇：人民币理财 ——转¥X——→ 美元理财（buffer 美元为 0 时的直接换汇，无 bucket）
  const renderForexArrow = (leg: FundingLeg, refs: { current: (HTMLInputElement | null)[] }, refIndex: number) => {
    const remain = Math.max(leg.amountCny - parseAmountPart(fundingLegValue(leg.key)), 0);
    return (
      <div className="reconcile-forex">
        <div style={{ backgroundColor: '#e6f4ea', border: '1px solid #ceead6', borderRadius: 12, padding: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.green, marginBottom: 4 }}>人民币理财</div>
          {renderLegInput(leg, refs, refIndex)}
          {remain >= 1 && <div style={{ fontSize: 10, color: C.orange, textAlign: 'right', marginTop: 2 }}>还需¥{fmtInt(remain)}</div>}
        </div>
        <div style={{ textAlign: 'center', minWidth: 58 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.orange, lineHeight: 1 }}>→</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.orange, fontVariantNumeric: 'tabular-nums' }}>转¥{fmtInt(leg.amountCny)}</div>
          <div style={{ fontSize: 9, color: C.sub }}>真换汇·手续费</div>
        </div>
        <div style={{ backgroundColor: '#e8f0fe', border: '1px solid #d2e3fc', borderRadius: 12, padding: 8, alignSelf: 'stretch', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.blue, marginBottom: 4 }}>美元理财</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtUsdFromCny(leg.amountCny)}</div>
        </div>
      </div>
    );
  };
  const dramTone: Record<DramDecisionKind, { bg: string; border: string; color: string }> = {
    clear: { bg: '#fce8e6', border: '#f28b82', color: C.red },
    trim: { bg: '#fff4e5', border: '#fbbc04', color: C.orange },
    pause: { bg: '#fff4e5', border: '#fbbc04', color: C.orange },
    buy: { bg: '#e6f4ea', border: '#81c995', color: C.green },
    hold: { bg: '#e8f0fe', border: '#a8c7fa', color: C.blue },
    wait: { bg: '#f8f9fa', border: '#dadce0', color: C.sub },
  };
  const activeDramTone = dramTone[dramDecision?.kind ?? 'wait'];
  const updateDramField = (field: 'shares' | 'costPrice', value: string) => {
    const next = normalizeAmountInput(value);
    setDramConfigInputs((prev) => ({ ...prev, [field]: next }));
  };
  const dramActionPlan = useMemo(() => {
    if (!dramDecision) return null;
    const usSuggested = rebalanceSuggested.us ?? 0;
    const usRemaining = roundMoney(Math.max(usSuggested, 0));
    const priceCny = latestUsdRate !== null ? dramDecision.latestPrice * latestUsdRate : null;
    const sharesFromCny = (cny: number) => (priceCny !== null && priceCny > 0 ? Math.round((cny / priceCny) * 10000) / 10000 : 0);

    if (dramDecision.sellShares > 0) {
      return {
        kind: 'sell' as const,
        button: `减仓约 ¥${fmtInt(dramDecision.sellCny)} · ${dramDecision.sellShares.toFixed(2)}股`,
        detail: `${dramDecision.detail} 本次执行：卖出约 ${dramDecision.sellShares.toFixed(2)} 股，约 ¥${fmtInt(dramDecision.sellCny)}。`,
        buyCny: 0,
        buyShares: 0,
        usRemaining,
      };
    }

    if (dramDecision.buyCapacityCny > 0) {
      const buyCny = roundMoney(Math.min(dramDecision.buyCapacityCny, usRemaining));
      const buyShares = sharesFromCny(buyCny);
      return {
        kind: buyCny > 0 ? 'buy' as const : 'wait' as const,
        button: buyCny > 0 ? `加仓约 ¥${fmtInt(buyCny)} · ${buyShares.toFixed(2)}股` : '本次美股投入不足，暂不加',
        detail: buyCny > 0
          ? `本次美股还需投入 ¥${fmtInt(usRemaining)}，DRAM 目标剩余额度 ¥${fmtInt(dramDecision.buyCapacityCny)}；本次买入 DRAM 约 ¥${fmtInt(buyCny)}，约 ${buyShares.toFixed(2)} 股，其余给 SPY。`
          : `DRAM 仍有目标剩余额度 ¥${fmtInt(dramDecision.buyCapacityCny)}，但本次美股还需投入 ¥${fmtInt(usRemaining)}，这次不加 DRAM。`,
        buyCny,
        buyShares,
        usRemaining,
      };
    }

    return {
      kind: 'hold' as const,
      button: '本次不加 DRAM',
      detail: `${dramDecision.detail} 本次美股还需投入 ¥${fmtInt(usRemaining)}，优先给 SPY。`,
      buyCny: 0,
      buyShares: 0,
      usRemaining,
    };
  }, [dramDecision, latestUsdRate, rebalanceSuggested.us]);
  const renderDramDecisionPanel = () => (
    <div style={{ border: `1.5px solid ${activeDramTone.border}`, borderRadius: 12, padding: '10px 12px', backgroundColor: activeDramTone.bg }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, color: '#202124', fontWeight: 800 }}>DRAM 决策树</div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
            用美股总仓位做分母 · 每周检查一次
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ display: 'inline-flex', borderRadius: 999, padding: '3px 9px', backgroundColor: '#fff', color: activeDramTone.color, fontSize: 12, fontWeight: 800, border: `1px solid ${activeDramTone.border}` }}>
            {dramChartLoading ? '加载中' : dramDecision?.headline ?? (dramChartError ? '价格失败' : '等待价格')}
          </div>
          <div style={{ fontSize: 10, color: C.sub, marginTop: 3 }}>
            {dramDecision ? `${dramDecision.latestDate} · ${dramChart?.source ?? '市场数据'}` : dramChartError ? '稍后重试' : dramConfig.symbol}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <label style={{ backgroundColor: '#fff', borderRadius: 8, padding: '7px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12, color: C.sub, fontWeight: 700 }}>股数</span>
          <AmountInput
            value={dramConfigInputs.shares}
            onChange={(v) => updateDramField('shares', v)}
            onFocus={(e) => e.target.select()}
            onBlur={() => commitDramConfig()}
            style={{ width: 78, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 13, fontWeight: 700, textAlign: 'right', color: '#202124', fontVariantNumeric: 'tabular-nums' }}
          />
        </label>
        <label style={{ backgroundColor: '#fff', borderRadius: 8, padding: '7px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12, color: C.sub, fontWeight: 700 }}>成本价</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 12, color: C.sub, fontWeight: 700 }}>$</span>
            <AmountInput
              value={dramConfigInputs.costPrice}
              onChange={(v) => updateDramField('costPrice', v)}
              onFocus={(e) => e.target.select()}
              onBlur={() => commitDramConfig()}
              style={{ width: 68, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 13, fontWeight: 700, textAlign: 'right', color: '#202124', fontVariantNumeric: 'tabular-nums' }}
            />
          </div>
        </label>
      </div>

      {dramDecision ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginBottom: 8 }}>
            {[
              { label: '现价', value: fmtDollar(dramDecision.latestPrice), color: '#202124' },
              { label: '成本盈亏', value: fmtPct(dramDecision.costProfitRate), color: (dramDecision.costProfitRate ?? 0) >= 0 ? C.red : C.green },
              { label: '占美股', value: fmtPct(dramDecision.weight), color: (dramDecision.weight ?? 0) > dramConfig.targetWeight ? C.orange : C.blue },
              { label: 'MA5', value: dramDecision.ma5 ? fmtDollar(dramDecision.ma5) : '—', color: dramDecision.priceState.aboveMa5 === false ? C.orange : C.green },
              { label: 'MA20', value: dramDecision.ma20 ? fmtDollar(dramDecision.ma20) : '—', color: dramDecision.priceState.aboveMa20 === false ? C.orange : C.green },
              { label: '高点回撤', value: fmtPct(dramDecision.drawdownFromPeak), color: -dramDecision.drawdownFromPeak >= dramConfig.drawdownClear ? C.red : C.sub },
            ].map((item) => (
              <div key={item.label} style={{ backgroundColor: '#fff', borderRadius: 8, padding: '6px 7px', minWidth: 0 }}>
                <div style={{ fontSize: 10, color: C.sub, fontWeight: 700 }}>{item.label}</div>
                <div style={{ fontSize: 12, color: item.color, fontWeight: 800, marginTop: 2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.value}</div>
              </div>
            ))}
          </div>

          <div style={{ backgroundColor: '#fff', borderRadius: 9, padding: '8px 9px', fontSize: 12, color: '#202124', lineHeight: 1.45 }}>
            <div style={{ fontWeight: 800, color: activeDramTone.color, marginBottom: 3 }}>
              {dramDecision.kind === 'clear' ? '清仓信号' : dramDecision.kind === 'trim' ? '减仓信号' : dramDecision.kind === 'buy' ? '买入许可' : dramDecision.kind === 'pause' ? '暂停信号' : '持仓信号'}
            </div>
            <div>{dramActionPlan?.detail ?? dramDecision.detail}</div>
            {dramDecision.sellShares > 0 && (
              <div style={{ marginTop: 5, color: C.orange, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                建议卖出 {dramDecision.sellShares.toFixed(2)} 股 · 约 ¥{fmtInt(dramDecision.sellCny)}
              </div>
            )}
            {dramActionPlan && dramActionPlan.buyCny > 0 && (
              <div style={{ marginTop: 5, color: C.green, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                建议买入 {dramActionPlan.buyShares.toFixed(2)} 股 · 约 ¥{fmtInt(dramActionPlan.buyCny)}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 10, color: C.sub }}>
            <span>美股总额 ¥{fmtInt(dramDecision.usStockValueCny)}</span>
            {dramDecision.dramValueCny !== null && <span>DRAM 市值 ¥{fmtInt(dramDecision.dramValueCny)}</span>}
            <span>清仓线：两周&lt;MA20 或回撤{Math.round(dramConfig.drawdownClear * 100)}%</span>
          </div>
        </>
      ) : (
        <div style={{ backgroundColor: '#fff', borderRadius: 9, padding: '8px 9px', fontSize: 12, color: dramChartError ? C.orange : C.sub }}>
          {dramChartError ? '暂时没有拿到 DRAM 最新价格，保留原有美股再平衡建议。' : '正在获取 DRAM 最新价格和均线。'}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="reconcile-page"
      onPointerDownCapture={armUndoCheckpoint}
      onPointerUpCapture={armUndoCheckpoint}
      onClickCapture={armUndoCheckpoint}
      onBeforeInputCapture={armUndoCheckpoint}
      onInputCapture={armUndoCheckpoint}
      onChangeCapture={armUndoCheckpoint}
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') return;
        armUndoCheckpoint();
      }}
    >
      <div className="reconcile-page-heading" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, margin: '0 0 4px' }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>对账 / 转账</h1>
          {screenshotImportMsg && <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.35, color: C.sub, overflowWrap: 'anywhere' }}>{screenshotImportMsg}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={backupCurrentVersion}
            disabled={backupCreating}
            title="备份当前版本"
            style={{ fontSize: 11, lineHeight: 1, padding: '4px 7px', borderRadius: 7, border: '1px solid #e0e0e0', backgroundColor: backupCreating ? '#f1f3f4' : '#fff', color: backupCreating ? '#9aa0a6' : C.sub, cursor: backupCreating ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
          >
            {backupCreating ? '备份中' : '备份'}
          </button>
          <button
            onClick={() => {
              setGroupedTargetInputs(groupedTargetInputFromConfig(effectiveInvestTargets(config.investAllocTargets)));
              setSettingsOpen(true);
            }}
            aria-label="设置"
            style={{ fontSize: 16, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', color: C.sub, lineHeight: 1 }}
          >
            ⚙️
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: C.sub, margin: '0 0 16px' }}>
        <span>今天 {today.getFullYear()}-{String(today.getMonth()+1).padStart(2,'0')}-{String(today.getDate()).padStart(2,'0')}，对账模式</span>
        <div role="group" aria-label="对账模式" style={{ display: 'inline-flex', border: '1px solid #d2e3fc', borderRadius: 8, overflow: 'hidden', backgroundColor: '#fff' }}>
          {RECONCILE_MODES.map((mode) => {
            const active = reconcileMode === mode.key;
            return (
              <button
                key={mode.key}
                type="button"
                onClick={() => setReconcileMode(mode.key)}
                title={`${mode.label}模式：${mode.hint}`}
                aria-pressed={active}
                style={{
                  border: 'none',
                  borderRight: mode.key === 'monthStart' ? '1px solid #d2e3fc' : 'none',
                  backgroundColor: active ? C.blue : '#fff',
                  color: active ? '#fff' : C.blue,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>
      {settingsOpen && (
        <RebalanceSettingsModal
          internshipConfig={config}
          cities={{ homeCity: config.homeCity, schoolCity: config.schoolCity }}
          recurringIncomeBaseline={config.recurringIncomeBaseline}
          groupedTargetInputs={groupedTargetInputs}
          setGroupedTargetInputs={setGroupedTargetInputs}
          onRevealConsumptionWish={() => {
            revealUsdAccount('usdConsumptionBank');
            revealUsdAccount('usdWishJar');
            setConsumptionWishOpen(true);
            setRevealConsumptionWishUsd(true);
            setSettingsOpen(false);
          }}
          onHideConsumptionWish={() => {
            hideConsumptionWishAccounts();
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
          onSave={(cities, allocationChanged, recurringIncomeBaseline) => {
            if (JSON.stringify(resolveRaiseSavingsSettings(cities.raiseSavings)) !== JSON.stringify(raiseSavingsSettings)
              || recurringIncomeBaseline !== resolveRecurringIncomeBaseline(config.recurringIncomeBaseline)) {
              setLocalTransferred(previous => ({ ...previous, raiseSavings: '0' }));
              setConfirmed(previous => ({ ...previous, raiseSavings: 0 }));
            }
            setConfig({ ...cities, recurringIncomeBaseline, ...(allocationChanged ? { investAllocTargets: groupedTargetInputsToConfig(groupedTargetInputs) } : {}) });
            setSettingsOpen(false);
          }}
        />
      )}
      {holidayWarning && (
        <div style={{ margin: '0 0 16px', fontSize: 12, color: C.orange, backgroundColor: '#fff4e8', border: '1px solid #fed7aa', borderRadius: 10, padding: '8px 10px' }}>
          {holidayWarning}
        </div>
      )}

      {/* 账户余额 */}
      <div id="sec-accounts">
      <Card className="reconcile-card" title="账户余额" subtitle="账单自动更新，可直接校准">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="reconcile-wrap-row reconcile-rate" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: C.sub, backgroundColor: '#f8f9fa', borderRadius: 8, padding: '6px 10px' }}>
            <span>美元汇率</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
              {latestUsdRate !== null ? `$1 ≈ ¥${latestUsdRate.toFixed(2)} · ${usdRateLabel}` : usdRateLabel}
            </span>
          </div>

          {/* 信用卡：总待还 + 本期待还 */}
          <div style={{ backgroundColor: '#fce8e6', borderRadius: 12, padding: '10px 14px', border: '1.5px solid #f28b82' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#202124', marginBottom: 8 }}>💳 信用卡</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                { key: 'credit',        label: '总待还',   idx: 0 },
                ...(showCreditMonthlyInput ? [{ key: 'creditMonthly', label: '本期待还', idx: 1 } as const] : []),
                { key: 'savingsCard',   label: '储蓄卡',   idx: 2 },
              ] as const).map(({ key, label, idx }) => (
                <div key={key} className="reconcile-account-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: '#5f6368' }}>{label}</span>
                  <div className="reconcile-credit-value" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    {key === 'savingsCard' ? (
                      <span style={{ marginRight: 8, color: C.sub, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        长债可还 ¥{fmtInt(longBondExcess)}
                      </span>
                    ) : null}
                    <div className="reconcile-currency-value">
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#c5221f' }}>¥</span>
                      <AmountInput
                        ref={(el) => { accountInputRefs.current[idx] = el; }}
                        value={localAccounts[key]}
                        onChange={(v) => setLocalAccounts((p) => ({ ...p, [key]: /^-?0\d/.test(v) ? (v.replace(/^(-?)0+/, '$1') || '0') : v }))}
                        onFocus={(e) => e.target.select()}
                        onBlur={() => syncAccounts()}
                        onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(idx); } }}
                        style={{ width: 100, border: 'none', outline: 'none', backgroundColor: 'transparent', fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#c5221f', textAlign: 'right' }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 校园卡 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff8e1', borderRadius: 12, padding: '10px 14px', border: '1.5px solid #ffe082' }}>
            <span style={{ fontSize: 14, color: '#202124', fontWeight: 500 }}>🎓 校园卡</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#f57c00' }}>¥</span>
              <AmountInput
                ref={(el) => { accountInputRefs.current[3] = el; }}
                value={localAccounts.campusCard}
                onChange={(v) => setLocalAccounts((p) => ({ ...p, campusCard: /^-?0\d/.test(v) ? (v.replace(/^(-?)0+/, '$1') || '0') : v }))}
                onFocus={(e) => e.target.select()}
                onBlur={() => syncAccounts()}
                onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(3); } }}
                style={{ width: 100, border: 'none', outline: 'none', backgroundColor: 'transparent', fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#f57c00', textAlign: 'right' }}
              />
            </div>
          </div>

          {([
            { cnyKey: 'livingBank', usdKey: 'usdLivingBank', label: '🏦 生活', cnyIdx: 4, usdIdx: 5, color: '#1a73e8', bg: '#e8f0fe', border: '#a8c7fa' },
          ] as const).map(({ cnyKey, usdKey, label, cnyIdx, usdIdx, color, bg, border }) => (
            <div key={cnyKey} className="reconcile-account-row" {...makeUsdSwipeHandlers(usdKey)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: bg, borderRadius: 12, padding: '10px 14px', border: `1.5px solid ${border}`, touchAction: 'pan-y' }}>
              <div>
                <div style={{ fontSize: 14, color: '#202124', fontWeight: 500 }}>{label}</div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
                  {latestUsdRate !== null ? `$≈¥${fmtInt((current.accounts[usdKey] ?? 0) * latestUsdRate)}` : '暂无汇率'}
                </div>
              </div>
              <div className="reconcile-currency-fields">
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color }}>¥</span>
                  <AmountInput
                    ref={(el) => { accountInputRefs.current[cnyIdx] = el; }}
                    value={localAccounts[cnyKey]}
                    onChange={(v) => setLocalAccounts((p) => ({ ...p, [cnyKey]: normalizeAmountInput(v) }))}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => syncAccounts()}
                    onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(cnyIdx); } }}
                    style={{ width: 86, border: 'none', outline: 'none', backgroundColor: 'transparent', borderBottom: `1px solid ${color}`, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color, textAlign: 'right' }}
                  />
                </div>
                {showUsdAccount(usdKey) && <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.blue }}>$</span>
                  <AmountInput
                    ref={(el) => { accountInputRefs.current[usdIdx] = el; }}
                    value={localAccounts[usdKey]}
                    onChange={(v) => setLocalAccounts((p) => ({ ...p, [usdKey]: normalizeAmountInput(v) }))}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => { syncAccounts(); hideUsdAccount(usdKey); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(usdIdx); } }}
                    style={{ width: 86, border: 'none', outline: 'none', backgroundColor: 'transparent', borderBottom: `1px solid ${C.blue}`, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: C.blue, textAlign: 'right' }}
                  />
                </div>}
              </div>
            </div>
          ))}

          {/* 收入账户 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#e6f4ea', borderRadius: 12, padding: '10px 14px', border: '1.5px solid #81c995' }}>
            <span style={{ fontSize: 14, color: '#202124', fontWeight: 500 }}>💰 收入</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#188038' }}>¥</span>
              <AmountInput
                ref={(el) => { accountInputRefs.current[6] = el; }}
                value={localAccounts.incomeBank}
                onChange={(v) => setLocalAccounts((p) => ({ ...p, incomeBank: /^-?0\d/.test(v) ? (v.replace(/^(-?)0+/, '$1') || '0') : v }))}
                onFocus={(e) => e.target.select()}
                onBlur={() => syncAccounts()}
                onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(6); } }}
                style={{ width: 100, border: 'none', outline: 'none', backgroundColor: 'transparent', fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#188038', textAlign: 'right' }}
              />
            </div>
          </div>

          {([
            { usdKey: 'usdConsumptionBank', label: '💼 消费', usdIdx: 8, bg: '#f3e8ff', border: '#c4b5fd' },
          ] as const).map(({ usdKey, label, usdIdx, bg, border }) => (
            (showUsdAccount(usdKey) || showUsdAccount('usdWishJar')) && (
            <Fragment key={usdKey}>
              <div className="reconcile-account-row" {...makeUsdSwipeHandlers(usdKey)} style={{ touchAction: 'pan-y', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: bg, borderRadius: 12, padding: '10px 14px', border: `1.5px solid ${border}` }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14, color: '#202124', fontWeight: 500 }}>{label}</span>
                    <button
                      type="button"
                      onClick={() => setConsumptionWishOpen((v) => !v)}
                      style={{ border: 'none', background: 'transparent', color: C.sub, cursor: 'pointer', padding: '1px 4px', fontSize: 11, lineHeight: 1, transform: consumptionWishOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
                      title="展开心愿"
                    >
                      ▼
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
                    {latestUsdRate !== null ? `$≈¥${fmtInt((current.accounts[usdKey] ?? 0) * latestUsdRate)}` : '暂无汇率'}
                  </div>
                </div>
                <div className="reconcile-currency-fields">
                  {showUsdAccount(usdKey) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.blue }}>$</span>
                      <AmountInput
                        ref={(el) => { accountInputRefs.current[usdIdx] = el; }}
                        value={localAccounts[usdKey]}
                        onChange={(v) => setLocalAccounts((p) => ({ ...p, [usdKey]: normalizeAmountInput(v) }))}
                        onFocus={(e) => e.target.select()}
                        onBlur={() => { syncAccounts(); hideUsdAccount(usdKey); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(usdIdx); } }}
                        style={{ width: 82, border: 'none', outline: 'none', backgroundColor: 'transparent', borderBottom: `1px solid ${C.blue}`, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: C.blue, textAlign: 'right' }}
                      />
                    </div>
                  )}
                </div>
              </div>
              {(consumptionWishOpen || showUsdAccount('usdWishJar')) && (
                <div className="reconcile-account-row" {...makeUsdSwipeHandlers('usdWishJar')} style={{ marginTop: -4, marginLeft: 16, touchAction: 'pan-y', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: '#fff7ed', borderRadius: 10, padding: '8px 12px', border: '1px solid #fed7aa' }}>
                  <div>
                    <div style={{ fontSize: 13, color: '#202124', fontWeight: 500 }}>🏺 心愿</div>
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
                      {latestUsdRate !== null ? `$≈¥${fmtInt((current.accounts.usdWishJar ?? 0) * latestUsdRate)}` : '暂无汇率'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.blue }}>$</span>
                    <AmountInput
                      ref={(el) => { accountInputRefs.current[9] = el; }}
                      value={localAccounts.usdWishJar}
                      onChange={(v) => setLocalAccounts((p) => ({ ...p, usdWishJar: normalizeAmountInput(v) }))}
                      onFocus={(e) => e.target.select()}
                      onBlur={() => { syncAccounts(); hideUsdAccount('usdWishJar'); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(9); } }}
                      style={{ width: 82, border: 'none', outline: 'none', backgroundColor: 'transparent', borderBottom: `1px solid ${C.blue}`, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: C.blue, textAlign: 'right' }}
                    />
                  </div>
                </div>
              )}
            </Fragment>
            )
          ))}

        </div>
      </Card>
      </div>

      {/* Step 1: 预算计算 */}
      <div id="sec-budget">
      <Card className="reconcile-card" title="① 预算计算" subtitle="点击行查看明细">
        <div className="reconcile-wrap-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.sub, marginBottom: 12 }}>
          <span>本月剩余 {budget.daysLeftInMonth} 天</span>
          <span className="reconcile-budget-days">
            {(['school', 'intern', 'home', 'travel'] as TagKind[]).map((k) => {
              const scene = BUDGET_SCENE_META[k === 'intern' ? 'work' : k];
              return <span key={k}>{scene.icon}{scene.label} {budget.stateDaysLeft[k]}</span>;
            })}
          </span>
        </div>

        {budgetRows.map((row, i) => {
          const isOpen = expandedBudget === row.key;
          const detail = budgetDetails[row.key];
          const balance = row.inc - row.exp;
          const incomeTotal = detail.income
            .filter((item) => item.isIncome)
            .reduce((sum, item) => sum + item.amount, 0);
          const livingExpenseTotal = detail.expense
            .filter((item) => item.isLivingExpense)
            .reduce((sum, item) => sum + item.amount, 0);
          const livingExpenseStartIndex = detail.expense.findIndex((item) => item.isLivingExpense);
          return (
            <div key={row.key} style={{ marginBottom: 4 }}>
              <button
                className="reconcile-budget-row"
                aria-expanded={isOpen}
                onClick={() => setExpandedBudget(isOpen ? null : row.key)}
                style={{ backgroundColor: isOpen ? '#e8f0fe' : i % 2 === 0 ? '#fafafa' : '#fff' }}
              >
                <span className="reconcile-budget-heading">
                  <span style={{ fontSize: 13, fontWeight: 600, color: isOpen ? C.blue : '#202124' }}>
                    {row.name} <span aria-hidden="true" style={{ fontSize: 11, color: C.sub }}>{isOpen ? '▾' : '▸'}</span>
                  </span>
                  <span className="reconcile-budget-balance" style={{ color: balance >= 0 ? C.red : C.green }}>
                    {balance >= 0 ? '+' : '-'}¥{formatCurrency(Math.abs(balance))}
                  </span>
                </span>
                <span className="reconcile-budget-flows">
                  <span style={{ color: C.red }}>收入 +¥{formatCurrency(row.inc)}</span>
                  <span style={{ color: C.green }}>支出 -¥{formatCurrency(row.exp)}</span>
                </span>
              </button>

              {isOpen && (
                <div style={{ margin: '2px 0 8px', border: '1.5px solid #c5d9f8', borderRadius: 10, backgroundColor: '#f8fbff', overflow: 'hidden' }}>
                  {detail.income.length > 0 && (
                    <div style={{ padding: '10px 14px 6px' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: C.red, marginBottom: 6 }}>收入来源</div>
                      {detail.income.map((item) => (
                        <div key={item.label} className="reconcile-detail-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                          <div><span style={{ fontSize: 13 }}>{item.icon && `${item.icon} `}{item.label}</span>
                            {item.note && <span className="reconcile-detail-note" style={{ fontSize: 11, color: C.sub }}>{item.note}</span>}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 500, color: C.red, fontVariantNumeric: 'tabular-nums' }}>+¥{formatCurrency(item.amount)}</span>
                        </div>
                      ))}
                      <div className="reconcile-wrap-row" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, paddingTop: 7, borderTop: '1px solid #dbe8fb', fontSize: 13, fontWeight: 700 }}>
                        <span style={{ color: C.sub }}>总收入</span>
                        <span style={{ color: C.red, fontVariantNumeric: 'tabular-nums' }}>+¥{formatCurrency(incomeTotal)}</span>
                      </div>
                    </div>
                  )}
                  <div style={{ height: 1, backgroundColor: '#dbe8fb' }} />
                  {detail.expense.length > 0 && (
                    <div style={{ padding: '6px 14px 10px' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: C.green, marginBottom: 6 }}>支出去向</div>
                      {detail.expense.map((item, itemIndex) => (
                        <div key={item.label} className="reconcile-detail-row" style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: itemIndex === livingExpenseStartIndex && itemIndex > 0 ? '10px 0 4px' : '4px 0',
                          marginTop: itemIndex === livingExpenseStartIndex && itemIndex > 0 ? 5 : 0,
                          borderTop: itemIndex === livingExpenseStartIndex && itemIndex > 0 ? '1px solid #dbe8fb' : 'none',
                        }}>
                          <div><span style={{ fontSize: 13 }}>{item.icon && `${item.icon} `}{item.label}</span>
                            {item.note && <span className="reconcile-detail-note" style={{ fontSize: 11, color: C.sub }}>{item.note}</span>}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 500, color: C.green, fontVariantNumeric: 'tabular-nums' }}>-¥{formatCurrency(item.amount)}</span>
                        </div>
                      ))}
                      {livingExpenseTotal > 0 && (
                        <div className="reconcile-wrap-row" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, paddingTop: 7, borderTop: '1px solid #dbe8fb', fontSize: 13, fontWeight: 700 }}>
                          <span style={{ color: C.sub }}>生活总支出</span>
                          <span style={{ color: C.green, fontVariantNumeric: 'tabular-nums' }}>-¥{formatCurrency(livingExpenseTotal)}</span>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="reconcile-wrap-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', backgroundColor: balance >= 0 ? '#fce8e6' : '#e6f4ea', fontSize: 13, fontWeight: 600 }}>
                    <span style={{ color: C.sub }}>{row.name}结余</span>
                    <span style={{ color: balance >= 0 ? C.red : C.green, fontVariantNumeric: 'tabular-nums' }}>
                      {balance >= 0 ? '+' : '-'}¥{formatCurrency(Math.abs(balance))}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Card>
      </div>

      {/* Step 2: 建议转账 */}
      <div id="sec-transfer">
      <Card className="reconcile-card" title="② 建议转账">

        {/* 收入资金流向概览 */}
        {needsRedemptionForTransfer > 0 ? (
          <div style={{ backgroundColor: '#fce8e6', border: '1px solid #f28b82', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
            ⚠️ 收入账户 <b>¥{fmtInt(current.accounts.incomeBank ?? 0)}</b>，优先存入后建议赎回理财 <b style={{ color: C.red }}>¥{fmtInt(needsRedemptionForTransfer)}</b> 补齐必要账户
          </div>
        ) : (
          <div style={{ backgroundColor: '#e6f4ea', border: '1px solid #81c995', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
            💰 收入账户 <b>¥{fmtInt(current.accounts.incomeBank ?? 0)}</b>
          </div>
        )}

        {/* 统一转账列表 */}
        {(() => {
          const volatileIncomeFormula = raiseSavingsSettings.includeVolatileIncome
            ? ` + 波动收入¥${formatCurrency(raiseSavings.volatileIncome)}` : '';
          const transferRows: { key: TransferKey; rec: number; calc: string }[] = [
            {
              key: 'raiseSavings',
              rec: raiseSavings.remaining,
              calc: raiseSavingsSettings.mode === 'manual'
                ? `（涨薪¥${formatCurrency(raiseSavingsSettings.manualRaiseAmount)}${volatileIncomeFormula}）÷ 2；本月应存¥${formatCurrency(raiseSavings.target)}，已存¥${formatCurrency(raiseSavings.saved)} → 人民币理财现金`
                : `（周期收入¥${formatCurrency(raiseSavings.recurringIncome)} − 基本线¥${formatCurrency(raiseSavings.baseline)}${volatileIncomeFormula}）÷ 2；本月应存¥${formatCurrency(raiseSavings.target)}，已存¥${formatCurrency(raiseSavings.saved)} → 人民币理财现金`,
            },
            {
              key: 'campusCard',
              rec: campusShortfallForTransfer,
              calc: `月需¥${fmtInt(budget.needs.campusCard)}（${budget.stateDaysLeft.school}天×¥${Math.round(stats.schoolDailyAvg)}/天）− 余¥${fmtInt(current.accounts.campusCard ?? 0)}`,
            },
            ...(creditInThisMonth ? [{
              key: 'repayment' as TransferKey,
              rec: repaymentShortfallForTransfer,
              calc: `本期待还¥${fmtInt(repaymentNeedForTransfer)} − 储蓄卡¥${fmtInt(current.accounts.savingsCard ?? 0)}${longBondRepay > 0 ? ` − 长债¥${fmtInt(longBondRepay)}（超¥${fmtInt(LONG_BOND_REPAY_THRESHOLD)}部分赎回）` : ''}`,
            }] : []),
            {
              key: 'living',
              rec: livingShortfallForTransfer,
              calc: `本月待补¥${formatCurrency(monthlyLivingShortfall)} · 负结余预留¥${formatCurrency(livingTransfer.deficitReserve)} · 可用¥${formatCurrency(livingTransfer.available)}`,
            },
            {
              key: 'consumption',
              rec: consumptionForTransfer,
              calc: `可分配¥${fmtInt(incomeAfterEssentialsForTransfer)}×50%消费×20%`,
            },
            {
              key: 'wishJar',
              rec: wishJarForTransfer,
              calc: `可分配¥${fmtInt(incomeAfterEssentialsForTransfer)}×50%消费×80%`,
            },
            {
              key: 'invest',
              rec: investForTransfer,
              calc: `可分配¥${fmtInt(incomeAfterEssentialsForTransfer)}×50%`,
            },
          ];
          return transferRows.filter(row => row.key !== 'raiseSavings' || raiseSavingsSettings.enabled).map((row, i) => {
            const transferred = row.key === 'raiseSavings'
              ? Math.max(parseAmountPart(localTransferred[row.key]), 0)
              : parseAmountPart(localTransferred[row.key]);
            const remain = roundMoney(Math.max(row.rec - transferred, 0));
            const formatTransferAmount = row.key === 'raiseSavings' || row.key === 'living' ? formatCurrency : fmtInt;
            const header = row.key === 'campusCard'
              ? { label: '补充必要', amount: essentialTotalForTransfer, color: C.blue }
              : row.key === 'consumption'
                ? { label: '可分配', amount: incomeAfterEssentialsForTransfer, color: C.green }
                : null;
            return (
              <Fragment key={row.key}>
                {header && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: i === 0 ? 0 : 10, marginBottom: 4, fontSize: 12, color: C.sub, fontWeight: 600 }}>
                    <span>{header.label}</span>
                    <span style={{ color: header.color, fontVariantNumeric: 'tabular-nums' }}>¥{fmtInt(header.amount)}</span>
                    <div style={{ flex: 1, borderBottom: '1px dashed #dadce0' }} />
                  </div>
                )}
              <div style={{ backgroundColor: i % 2 === 0 ? '#fafafa' : '#fff', borderRadius: 10, padding: '10px 12px', marginBottom: 4 }}>
                {/* 名称与建议金额、剩余金额与录入各自成组 */}
                <div className="reconcile-transfer-row">
                  <div className="reconcile-wrap-row">
                    <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{TRANSFER_META[row.key].label}</span>
                    <button
                      type="button"
                      aria-expanded={expandedTransfer === row.key}
                      onClick={() => setExpandedTransfer((prev) => (prev === row.key ? null : row.key))}
                      style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 12, color: C.blue, fontWeight: 600, fontVariantNumeric: 'tabular-nums', cursor: 'pointer', userSelect: 'none', textAlign: 'right', whiteSpace: 'nowrap' }}
                    >需¥{formatTransferAmount(row.rec)} {expandedTransfer === row.key ? '▾' : '▸'}</button>
                  </div>
                  <div className="reconcile-wrap-row">
                    <span style={{ fontSize: 12, color: C.orange, fontWeight: 600, fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' }}>还需¥{formatTransferAmount(remain)}</span>
                    <label className="reconcile-transfer-input">
                      <span style={{ fontSize: 12, color: C.sub }}>已转</span>
                      <AmountInput
                        ref={(el) => { transferInputRefs.current[i] = el; }}
                        value={localTransferred[row.key]}
                        decimalPlaces={row.key === 'raiseSavings' || row.key === 'living' ? 2 : undefined}
                        onChange={(v) => setLocalTransferred((p) => ({ ...p, [row.key]: /^-?0\d/.test(v) ? (v.replace(/^(-?)0+/, '$1') || '0') : v }))}
                        onBlur={row.key === 'raiseSavings' ? (event) => {
                          const amount = String(roundMoney(Math.max(parseAmountPart(event.currentTarget.value), 0)));
                          setLocalTransferred((p) => ({ ...p, raiseSavings: amount }));
                        } : undefined}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); transferInputRefs.current[i + 1]?.focus(); } }}
                        aria-label={`${TRANSFER_META[row.key].label}已转`}
                        style={{ width: 100, minWidth: 0, border: `1.5px solid ${transferred > 0 ? '#81c995' : '#dadce0'}`, borderRadius: 8, padding: '5px 8px', fontSize: 13, fontWeight: 600, textAlign: 'right', outline: 'none', backgroundColor: transferred > 0 ? '#e6f4ea' : '#fff', color: transferred > 0 ? C.green : '#202124', boxSizing: 'border-box' }}
                      />
                    </label>
                  </div>
                </div>
                {/* 第二行：计算说明（点击"需¥"展开） */}
                {expandedTransfer === row.key && (
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>{row.calc}</div>
                )}
                {/* 长债超过阈值部分赎回还款：一键 长债↓ → 储蓄卡↑ */}
                {row.key === 'repayment' && longBondRepay > 0 && (
                  <div className="reconcile-wrap-row" style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: '#e6f4ea', border: '1px solid #81c995', borderRadius: 8, padding: '8px 10px' }}>
                    <span style={{ fontSize: 12, color: '#188038', lineHeight: 1.4 }}>
                      🟢 赎回长债 <b style={{ fontVariantNumeric: 'tabular-nums' }}>¥{fmtInt(longBondRepay)}</b> → 储蓄卡<br />
                      <span style={{ fontSize: 11, color: C.sub }}>长债¥{fmtInt(longBondTotalForRepay)}超过¥{fmtInt(LONG_BOND_REPAY_THRESHOLD)}的部分</span>
                    </span>
                    <button
                      onClick={handleRedeemLongBond}
                      style={{ flexShrink: 0, backgroundColor: C.green, color: '#fff', fontWeight: 700, fontSize: 12, padding: '7px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >✓ 赎回还款</button>
                  </div>
                )}
              </div>
              </Fragment>
            );
          });
        })()}

        <button
          onClick={handleExecuteAll}
          disabled={!hasTransferChanges}
          style={{
            width: '100%', marginTop: 14,
            backgroundColor: hasTransferChanges ? C.green : '#e8eaed',
            color: hasTransferChanges ? '#fff' : C.sub,
            fontWeight: 700, fontSize: 15, padding: '13px 0',
            borderRadius: 12, border: 'none',
            cursor: hasTransferChanges ? 'pointer' : 'default',
            transition: 'background-color 0.2s', letterSpacing: 1,
          }}
        >
          ✓ 一键执行转账
        </button>
      </Card>
      </div>

      {/* Step 3: 理财配置 & 再平衡 */}
      <div id="sec-invest">
      <Card className="reconcile-card" title="③ 理财配置 & 再平衡">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>总金额 ¥{formatCurrency(investKeys.reduce((sum, key) => sum + reconcileTotalHoldings[key], 0))}</span>
        </div>
        {/* 本次投入 */}
        <div className="reconcile-account-row reconcile-invest-input-row" {...makeUsdSwipeHandlers('investUsdBank')} style={{ touchAction: 'pan-y', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1.5px solid #fbbf24', borderRadius: 10, padding: '10px 12px', backgroundColor: '#fffbeb', marginBottom: 14 }}>
          {([
            { cnyKey: 'investCnyBank', usdKey: 'investUsdBank', cnyIdx: 10, usdIdx: 11, color: C.orange },
          ] as const).map(({ cnyKey, usdKey, cnyIdx, usdIdx, color }) => (
            <Fragment key={cnyKey}>
              <div>
                <div style={{ fontSize: 14, color: '#202124', fontWeight: 700 }}>本次投入</div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
                  合计 ¥{fmtInt(rebalanceNewFunds)}
                </div>
              </div>
              <div className="reconcile-currency-fields">
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.sub }}>境内</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color }}>¥</span>
                  <AmountInput
                    ref={(el) => { accountInputRefs.current[cnyIdx] = el; }}
                    value={localAccounts[cnyKey]}
                    onChange={(v) => setLocalAccounts((p) => ({ ...p, [cnyKey]: normalizeAmountInput(v) }))}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => syncAccounts()}
                    onKeyDown={(e) => { if (e.key === 'Enter') { syncAccounts(); focusNextAccount(cnyIdx); } }}
                    style={{ width: 86, border: 'none', outline: 'none', backgroundColor: 'transparent', borderBottom: `1px solid ${color}`, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color, textAlign: 'right' }}
                  />
                </div>
                <>
                  {investUsdInputMode === 'usd' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: C.sub }}>境外</span>
                        <button
                          type="button"
                          onClick={() => switchInvestUsdInputMode('cny')}
                          style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 14, fontWeight: 700, color: C.blue, cursor: 'pointer' }}
                          aria-label="切换境外投入为人民币折算"
                        >
                          $
                        </button>
                        <AmountInput
                          ref={(el) => { accountInputRefs.current[usdIdx] = el; }}
                          value={localAccounts[usdKey]}
                          onChange={(v) => setLocalAccounts((p) => ({ ...p, [usdKey]: normalizeAmountInput(v) }))}
                          onFocus={(e) => e.target.select()}
                          onBlur={() => syncAccounts()}
                          onKeyDown={(e) => { if (e.key === 'Enter') syncAccounts(); }}
                          style={{ width: 86, border: 'none', outline: 'none', backgroundColor: 'transparent', borderBottom: `1px solid ${C.blue}`, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: C.blue, textAlign: 'right' }}
                        />
                      </div>
                  ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: C.sub }}>境外</span>
                        <button
                          type="button"
                          onClick={() => switchInvestUsdInputMode('usd')}
                          style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 14, fontWeight: 700, color: C.blue, cursor: 'pointer' }}
                          aria-label="切换境外投入为美元编辑"
                        >
                          $
                        </button>
                        <span style={{ fontSize: 14, fontWeight: 600, color: C.blue }}>¥</span>
                        {latestUsdRate !== null ? (
                          <AmountInput
                            ref={(el) => { accountInputRefs.current[usdIdx] = el; }}
                            value={investUsdCnyInput}
                            onChange={(v) => setInvestUsdCnyInput(normalizeAmountInput(v))}
                            onFocus={(e) => e.target.select()}
                            onBlur={() => commitInvestUsdCnyInput()}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitInvestUsdCnyInput(); }}
                            style={{ width: 86, border: 'none', outline: 'none', backgroundColor: 'transparent', borderBottom: `1px solid ${C.blue}`, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: C.blue, textAlign: 'right' }}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => switchInvestUsdInputMode('usd')}
                            style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 13, fontWeight: 700, color: C.orange, cursor: 'pointer' }}
                          >
                            暂无汇率
                          </button>
                        )}
                      </div>
                  )}
                </>
              </div>
            </Fragment>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px', marginBottom: 14, fontSize: 13, color: allowRebalanceSell ? C.blue : C.sub, fontWeight: 600, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={allowRebalanceSell}
            onChange={(e) => setAllowRebalanceSell(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: C.blue, cursor: 'pointer' }}
          />
          <span>允许减仓换仓</span>
        </label>
        {!allowRebalanceSell && latestUsdRate !== null && cnyFundingLegs.length > 0 && (
          <div style={{ border: '1px solid #e8eaed', borderRadius: 10, padding: '9px 10px', backgroundColor: '#fff', marginBottom: 14 }}>
            <div className="reconcile-wrap-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, color: C.sub, fontWeight: 700 }}>
              <span>理财调拨 · 美元 → 人民币</span>
              <span style={{ color: C.orange, fontVariantNumeric: 'tabular-nums' }}>¥{fmtInt(rebalanceFunding.cnyFromRmbBuffer)}</span>
              <SwapTag />
              <div style={{ flex: 1, borderBottom: '1px dashed #dadce0' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {renderBigBlock('cny', 'in', cnyFundingRows.map((r) => ({ label: r.label, leg: r.cnyLeg })), cnyFundingInputRefs, 0)}
              {renderBigBlock('usd', 'out', cnyFundingRows.map((r) => ({ label: r.label, leg: r.usdLeg })), cnyFundingInputRefs, cnyFundingRows.length)}
            </div>
            <button
              onClick={() => executeFundingLegs(cnyFundingLegs)}
              disabled={!hasCnyFundingChanges}
              style={{
                width: '100%', marginTop: 8,
                backgroundColor: hasCnyFundingChanges ? C.green : '#e8eaed',
                color: hasCnyFundingChanges ? '#fff' : C.sub,
                fontWeight: 700, fontSize: 14, padding: '10px 0',
                borderRadius: 10, border: 'none',
                cursor: hasCnyFundingChanges ? 'pointer' : 'default',
                transition: 'background-color 0.2s',
              }}
            >
              ✓ 一键执行理财调拨
            </button>
          </div>
        )}
        {!allowRebalanceSell && latestUsdRate !== null && usdFundingLegs.length > 0 && (
          <div style={{ border: '1px solid #e8eaed', borderRadius: 10, padding: '9px 10px', backgroundColor: '#fff', marginBottom: 14 }}>
            <div className="reconcile-wrap-row" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, color: C.sub, fontWeight: 700 }}>
              <span>理财调拨 · 人民币 → 美元</span>
              <span style={{ color: C.orange, fontVariantNumeric: 'tabular-nums' }}>¥{fmtInt(rebalanceFunding.usdReplaceUseCny + rebalanceFunding.cnyToUsdCny)}</span>
              {usdFundingRows.length > 0 && <SwapTag />}
              <div style={{ flex: 1, borderBottom: '1px dashed #dadce0' }} />
            </div>
            {usdFundingRows.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: forexLeg ? 8 : 0 }}>
                {renderBigBlock('cny', 'out', usdFundingRows.map((r) => ({ label: r.label, leg: r.cnyLeg })), usdFundingInputRefs, 0)}
                {renderBigBlock('usd', 'in', usdFundingRows.map((r) => ({ label: r.label, leg: r.usdLeg })), usdFundingInputRefs, usdFundingRows.length)}
              </div>
            )}
            {forexLeg && renderForexArrow(forexLeg, usdFundingInputRefs, usdFundingRows.length * 2)}
            <button
              onClick={() => executeFundingLegs(usdFundingLegs)}
              disabled={!hasUsdFundingChanges}
              style={{
                width: '100%', marginTop: 8,
                backgroundColor: hasUsdFundingChanges ? C.green : '#e8eaed',
                color: hasUsdFundingChanges ? '#fff' : C.sub,
                fontWeight: 700, fontSize: 14, padding: '10px 0',
                borderRadius: 10, border: 'none',
                cursor: hasUsdFundingChanges ? 'pointer' : 'default',
                transition: 'background-color 0.2s',
              }}
            >
              ✓ 一键执行美元调拨
            </button>
          </div>
        )}
        {/* 色条 */}
        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 14 }}>
          {investKeys.map((k) => (
            <div key={k} style={{ width: `${allocationRatios[k] * 100}%`, backgroundColor: investMeta[k].color }} />
          ))}
        </div>

        {/* 持仓表（固定列宽） */}
        <table className="reconcile-holdings" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', marginBottom: 16, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '20%' }} />
            <col style={{ width: '26%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '24%' }} />
          </colgroup>
          <thead>
            <tr style={{ borderBottom: '2px solid #e8eaed' }}>
              <th style={thStyle}>品类</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>now</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>总金额</th>
              <th style={{ ...thStyle, textAlign: 'right', color: allowRebalanceSell ? C.blue : C.orange }}>{allowRebalanceSell ? '需加/赎' : '需加'}</th>
            </tr>
          </thead>
          <tbody>
            {investKeys.map((k, i) => {
              const group = INVEST_GROUPS.find((item) => item.keys.includes(k))!;
              const groupTone = INVEST_GROUP_TONES[group.key];
              const groupKeys = group.keys.filter((key) => investKeys.includes(key));
              const isGroupStart = groupKeys[0] === k;
              const groupRatio = totalInvest > 0
                ? groupKeys.reduce((sum, key) => sum + allocationRatios[key], 0)
                : null;
              const groupTargetRatio = groupKeys.reduce((sum, key) => sum + (investAllocTargets[key] ?? 0), 0);
              const groupTargetGap = groupRatio === null ? null : Math.abs(groupRatio - groupTargetRatio);
              const groupTargetWarning = groupTargetGap !== null
                && groupTargetGap >= INVEST_GROUP_WARNING_THRESHOLD - 1e-9;
              const groupTargetDirection = groupRatio !== null && groupRatio > groupTargetRatio ? '偏高' : '偏低';
              const suggested = Math.round(rebalanceSuggested[k]);
              const recurring = recurringInvestments[k] ?? 0;
              const cancelRecurring = (k === 'us' || k === 'asia') && shouldCancelRecurringInvestment(suggested, recurring);
              const showUsd = (USD_INVEST_KEYS.includes(k) || usdRebalanceCells.has(k)) && latestUsdRate !== null;
              const remainingLabel = suggested === 0
                ? recurring > 0 ? showUsd ? '$0' : '0' : '—'
                : showUsd
                  ? fmtUsd(suggested / latestUsdRate)
                  : suggested > 0
                    ? `+${suggested}`
                    : `${suggested}`;
              return (
                <Fragment key={k}>
                {isGroupStart && i > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={4} style={{ height: 8, padding: 0, backgroundColor: '#fff' }} />
                  </tr>
                )}
                {isGroupStart && (
                  <tr>
                    <td
                      colSpan={4}
                      style={{ padding: '7px 10px', backgroundColor: groupTargetWarning ? '#fce8e6' : groupTone.header, borderBottom: `1px solid ${groupTargetWarning ? '#f28b82' : groupTone.border}` }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: group.color, fontSize: 12, fontWeight: 800 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: group.color, flexShrink: 0 }} />
                          {group.label}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap', color: groupTargetWarning ? C.red : C.sub, fontSize: 11, fontWeight: 600 }}>
                          <span>
                            当前 <strong style={{ color: groupTargetWarning ? C.red : group.color, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{fmtPct(groupRatio)}</strong>
                          </span>
                          {groupTargetWarning && (
                            <span style={{ padding: '2px 6px', borderRadius: 999, backgroundColor: '#fff', color: C.red, fontSize: 10, fontWeight: 800, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                              {groupTargetDirection} {(groupTargetGap * 100).toFixed(1)}点
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
                <tr className="reconcile-holding-row" style={{ backgroundColor: groupTone.surface, borderBottom: `1px solid ${groupTone.border}` }}>
                  <td style={{ padding: '8px 0', paddingRight: 8, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'relative' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: investMeta[k].color, marginRight: 4, verticalAlign: 'middle', flexShrink: 0 }} />
                    {investMeta[k].label}

                  </td>
                  <td className="reconcile-holding-now" data-label="now" style={{ padding: '4px 0', textAlign: 'right' }}>
                    <AmountInput
                      ref={(element) => { holdingInputRefs.current[i] = element; }}
                      aria-label={`${investMeta[k].label} now`}
                      value={localHoldings[k]}
                      onChange={(value) => setLocalHoldings((previous) => ({ ...previous, [k]: value }))}
                      onBlur={(event) => commitHolding(k, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        event.currentTarget.blur();
                        holdingInputRefs.current[i + 1]?.focus();
                      }}
                      style={{ width: '100%', minWidth: 0, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', textAlign: 'right', fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: C.blue }}
                    />
                    {k === 'longBond' && longBondRepay > 0 && (
                      <div title={`已扣除信用卡还款 ¥${fmtInt(longBondRepay)}`} style={{ marginTop: 2, color: C.sub, fontSize: 9, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        配置净额 ¥{fmtInt(effectiveInvestHoldings.longBond)}
                      </div>
                    )}
                    {pendingInvestHoldings[k] > 0 && (
                      <div style={{ marginTop: 2, color: C.orange, fontSize: 9, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        待确认 ¥{fmtInt(pendingInvestHoldings[k])}
                      </div>
                    )}
                  </td>
                  <td className="reconcile-holding-total" data-label="总金额" style={{ padding: '8px 0 8px 8px', textAlign: 'right', color: C.sub, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                    ¥{reconcileTotalHoldings[k].toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  {/* 需加/需赎建议；正=加仓，负=赎回 */}
                  <td
                    className="reconcile-holding-suggestion"
                    data-label={allowRebalanceSell ? '需加/赎' : '需加'}
                    onClick={() => {
                      if (latestUsdRate === null || suggested === 0) return;
                      setUsdRebalanceCells((prev) => {
                        const next = new Set(prev);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      });
                    }}
                    title={latestUsdRate === null ? '暂无美元汇率' : '点击切换人民币/美元'}
                    style={{ padding: '8px 0', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: suggested > 0 ? C.orange : suggested < 0 ? C.blue : C.sub, cursor: latestUsdRate !== null && suggested !== 0 ? 'pointer' : 'default', userSelect: 'none' }}
                  >
                    {remainingLabel}
                    {recurring > 0 && (
                      <span style={{ display: 'block', fontSize: 10, fontWeight: 400, color: C.sub, whiteSpace: 'nowrap' }}>
                        (定投{fmtInt(recurring)})
                      </span>
                    )}
                    {cancelRecurring && (
                      <span role="alert" style={{ display: 'block', fontSize: 10, fontWeight: 700, color: C.red, whiteSpace: 'nowrap' }}>
                        需加低于定投，请取消定投
                      </span>
                    )}
                  </td>
                </tr>
                {false && (
                  <tr style={{ backgroundColor: '#f8fbff', borderBottom: '1px solid #e8f0fe' }}>
                    <td colSpan={4} style={{ padding: '8px 0 10px' }}>
                      <div style={{ border: '1px solid #d2e3fc', borderRadius: 10, padding: '8px 9px', backgroundColor: '#fff' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 800, color: '#202124' }}>美股明细</div>
                            <div style={{ fontSize: 10, color: Math.abs(usStockDetailGap) >= 1 ? C.orange : C.sub, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                              合计 ¥{fmtInt(usStockDetailTotal)} · 美股 ¥{fmtInt(reconcileHoldings.us)}
                              {Math.abs(usStockDetailGap) >= 1 ? ` · 差额 ${usStockDetailGap > 0 ? '+' : ''}¥${fmtInt(usStockDetailGap)}` : ''}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={addUsStockItem}
                            style={{ border: 'none', borderRadius: 8, backgroundColor: '#e8f0fe', color: C.blue, padding: '6px 9px', fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
                          >
                            + 项目
                          </button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                          {localUsStockItems.map((item) => {
                            const amount = Math.max(0, parseAmountPart(item.amountCny));
                            const weight = reconcileHoldings.us > 0 ? amount / reconcileHoldings.us : null;
                            const symbol = item.symbol.trim().toUpperCase();
                            const isSpyItem = isSpyUsStockInput(item);
                            const isDramItem = symbol === 'DRAM' || item.name.trim().toUpperCase() === 'DRAM';
                            const symbolMatchesName = Boolean(symbol) && item.name.trim().toUpperCase() === symbol;
                            const chart = isDramItem ? (dramChart ?? usStockCharts[symbol]) : usStockCharts[symbol];
                            const priceBar = latestMarketBar(chart);
                            const currentPrice = marketNowPrice(chart);
                            const costAmountCny = isSpyItem ? null : usStockCostAmountCny(item, latestUsdRate);
                            const amountLocked = isSpyItem || costAmountCny !== null;
                            const weightLabel = weight !== null ? `${(weight * 100).toFixed(1)}%` : '—';
                            const priceLabel = currentPrice !== null
                              ? fmtDollar(currentPrice)
                              : (symbol && (usStockPriceErrors.has(symbol) || (isDramItem && dramChartError)))
                                ? '价格失败'
                                : symbol
                                  ? '取价中'
                                  : '填代码';
                            return (
                              <div key={item.id} style={{ border: '1px solid #edf2fb', borderRadius: 9, padding: '7px 8px', backgroundColor: '#fbfdff' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(54px, 86px) minmax(58px, 76px) minmax(96px, 1fr) 28px', gap: 6, alignItems: 'center', marginBottom: isSpyItem ? 0 : 6 }}>
                                  <input
                                    value={item.name}
                                    onChange={(e) => {
                                      const nextName = e.target.value;
                                      const previousName = item.name.trim().toUpperCase();
                                      const previousSymbol = item.symbol.trim().toUpperCase();
                                      setLocalUsStockItem(item.id, {
                                        name: nextName,
                                        ...(previousSymbol && previousSymbol === previousName ? { symbol: nextName.toUpperCase() } : {}),
                                      });
                                    }}
                                    onBlur={() => commitUsStockItems()}
                                    style={{ width: '100%', border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 13, fontWeight: 800, color: '#202124' }}
                                  />
                                  <div style={{ minWidth: 0, textAlign: 'right' }}>
                                    <div style={{ fontSize: 10, color: C.sub, fontWeight: 700, lineHeight: 1.1 }}>现价</div>
                                    <div title={chart?.regularMarketTime ?? priceBar?.date ?? undefined} style={{ fontSize: 12, color: currentPrice !== null ? C.blue : C.orange, fontWeight: 800, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                      {priceLabel}
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                    <span style={{ fontSize: 11, color: C.sub, fontWeight: 700 }}>¥</span>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0, width: '100%' }}>
                                      <AmountInput
                                        value={item.amountCny}
                                        onChange={(v) => {
                                          if (amountLocked) return;
                                          setLocalUsStockItem(item.id, { amountCny: normalizeAmountInput(v) });
                                        }}
                                        onFocus={(e) => e.target.select()}
                                        onBlur={() => {
                                          if (!amountLocked) commitUsStockItems();
                                        }}
                                        readOnly={amountLocked}
                                        tabIndex={amountLocked ? -1 : undefined}
                                        title={isSpyItem ? '由美股总额扣除其他美股自动计算' : costAmountCny !== null ? '由股数和成本价自动计算' : undefined}
                                        style={{ minWidth: 0, width: '100%', border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: amountLocked ? '#f8fbff' : 'transparent', fontSize: 13, fontWeight: 800, color: amountLocked ? C.blue : '#202124', textAlign: 'right', fontVariantNumeric: 'tabular-nums', cursor: amountLocked ? 'default' : 'text' }}
                                      />
                                      <span style={{ fontSize: 10, color: C.sub, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{weightLabel}</span>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeUsStockItem(item.id)}
                                    aria-label={`删除${item.name || item.symbol || '美股项目'}`}
                                    style={{ border: 'none', borderRadius: 7, width: 26, height: 26, backgroundColor: '#fce8e6', color: C.red, fontSize: 14, fontWeight: 800, cursor: 'pointer', lineHeight: 1 }}
                                  >
                                    ×
                                  </button>
                                </div>
                                {!isSpyItem && (
                                <div style={{ display: 'grid', gridTemplateColumns: symbolMatchesName ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 0.9fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 8, alignItems: 'center' }}>
                                  {!symbolMatchesName && (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                      <span style={{ fontSize: 10, color: C.sub, fontWeight: 700, whiteSpace: 'nowrap' }}>代码</span>
                                      <input
                                        value={item.symbol}
                                        onChange={(e) => setLocalUsStockItem(item.id, { symbol: e.target.value.toUpperCase() })}
                                        onBlur={() => commitUsStockItems()}
                                        style={{ minWidth: 0, width: '100%', border: 'none', borderBottom: '1px solid #e8eaed', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 800, color: C.blue, textAlign: 'right', textTransform: 'uppercase' }}
                                      />
                                    </label>
                                  )}
                                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                    <span style={{ fontSize: 10, color: C.sub, fontWeight: 700, whiteSpace: 'nowrap' }}>股数</span>
                                    <AmountInput
                                      value={item.shares}
                                      onChange={(v) => setLocalUsStockItem(item.id, { shares: normalizeAmountInput(v) }, { autoAmount: true })}
                                      onFocus={(e) => e.target.select()}
                                      onBlur={() => commitUsStockItems(undefined, { autoAmount: true })}
                                      style={{ minWidth: 0, width: '100%', border: 'none', borderBottom: '1px solid #e8eaed', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 700, color: C.sub, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                                    />
                                  </label>
                                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                    <span style={{ fontSize: 10, color: C.sub, fontWeight: 700, whiteSpace: 'nowrap' }}>成本$</span>
                                    <AmountInput
                                      value={item.costPrice}
                                      onChange={(v) => setLocalUsStockItem(item.id, { costPrice: normalizeAmountInput(v) }, { autoAmount: true })}
                                      onFocus={(e) => e.target.select()}
                                      onBlur={() => commitUsStockItems(undefined, { autoAmount: true })}
                                      style={{ minWidth: 0, width: '100%', border: 'none', borderBottom: '1px solid #e8eaed', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 700, color: C.sub, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                                    />
                                  </label>
                                </div>
                                )}
                                {isDramItem && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 7 }}>
                                    <button
                                      type="button"
                                      onClick={() => setDramDecisionExpanded((prev) => !prev)}
                                      aria-expanded={dramDecisionExpanded}
                                      style={{ width: '100%', border: `1px solid ${activeDramTone.border}`, borderRadius: 8, backgroundColor: activeDramTone.bg, color: '#202124', padding: '7px 8px', cursor: 'pointer', textAlign: 'left', fontSize: 11, lineHeight: 1.35 }}
                                    >
                                      <span style={{ color: activeDramTone.color, fontWeight: 900 }}>
                                        决策详情：{dramChartLoading ? '加载中' : dramDecision?.headline ?? (dramChartError ? '价格失败' : '等待价格')}
                                      </span>
                                      {dramActionPlan && (
                                        <>
                                          <span style={{ color: C.sub }}> · </span>
                                          <span style={{ color: activeDramTone.color, fontWeight: 800 }}>{dramActionPlan.button}</span>
                                        </>
                                      )}
                                      <span style={{ color: C.sub }}> · </span>
                                      <span style={{ color: C.sub, fontWeight: 700 }}>{dramDecisionExpanded ? '收起' : '点击查看'}</span>
                                    </button>
                                    {dramDecisionExpanded && renderDramDecisionPanel()}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          {!currentInvestRecord && <span style={{ color: C.sub, fontSize: 11 }}>暂无本月记录</span>}
          <button type="button" disabled={!currentInvestRecord}
            onClick={() => updateReconcileHoldings(sourceInvestHoldings)}
            style={{ border: 'none', borderRadius: 8, padding: '6px 9px', backgroundColor: currentInvestRecord ? '#e8f0fe' : '#f1f3f4', color: currentInvestRecord ? C.blue : C.sub, fontSize: 12, fontWeight: 700, cursor: currentInvestRecord ? 'pointer' : 'default' }}>
            获取持仓
          </button>
        </div>
      </Card>
      </div>

    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '8px 0', fontSize: 12, color: '#5f6368', fontWeight: 500,
};
