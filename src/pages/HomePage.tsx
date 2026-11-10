import { cityLabel } from '../utils/sceneCities';
import { sceneCitySummaries } from '../utils/sceneDaily';
import InternshipSettings from '../components/InternshipSettings';
import InternshipIncomeCard from '../components/InternshipIncomeCard';
import IncomeItemEditor from '../components/IncomeItemEditor';
import { useLifeCalendar } from '../hooks/useLifeCalendar';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import Card from '../components/Card';
import FireAllocationSlider from '../components/FireAllocationSlider';
import FireScenarioToggle from '../components/FireScenarioToggle';
import StatRow from '../components/StatRow';
import CurrencyDisplay, { formatCurrency } from '../components/CurrencyDisplay';
import AmountInput from '../components/AmountInput';
import { useSnapshotStore } from '../stores/snapshotStore';
import { useConfigStore } from '../stores/configStore';
import { useMonthlyStore } from '../stores/monthlyStore';
import { useCalendarStore } from '../stores/calendarStore';
import { useBillDetailStore } from '../stores/billDetailStore';
import { useExpenseScopeOverrideStore } from '../stores/expenseScopeOverrideStore';
import { useTripStore } from '../stores/tripStore';
import { fetchBonCvFireProfile } from '../utils/bonCv';
import { signOut } from '../utils/authClient';
import { calcHistoryStats } from '../calculations/history';
import { calcFire } from '../calculations/fire';
import { calcPreFireExpenses, getFireGraduationDate } from '../calculations/fireExpenses';
import { calcPostFireExpenses } from '../calculations/fireScenario';
import { tagMeta } from '../data/mockData';
import type { FutureFireExpense, IncomeItem, MajorFireWish, TagKind, LocalLifeBreakdownRow, MonthlyRecord, SharedLifeBreakdownItem, SharedLifeBreakdownRow } from '../models/types';
import { useHolidayYears } from '../utils/holidays';
import { normalizeDecimalPunctuation, sanitizeDecimalNumberInput } from '../utils/numberInput';
import { dateLabel, daysUntilDate, resolveAllIncomeForMonth, type ResolvedIncomeItem } from '../utils/payroll';
import { getAverageAnnualizedRate, getInvestTotalForRate, getYearInvestmentReturn } from '../utils/investRecords';
import {
  SP500_COMPARISON_REQUESTS,
  calculateSp500Comparison,
  portfolioBacktestRequestUrl,
} from '../utils/sp500Comparison';
import type { PortfolioBacktestSeriesId } from '../utils/portfolioBacktest';
import type { MarketChartResponse } from '../utils/dramDecision';
import {
  HANGZHOU_EMPLOYEE_SOCIAL_INSURANCE_RATE,
  TAX_RULE_PRESETS,
} from '../utils/tax';

import { version as APP_VERSION } from '../../package.json';
import { useSyncStatus } from '../utils/syncStatus';
// 本版改动概括（≤6 字），随每次迭代更新
const RELEASE_NOTE = '调度就绪检查';
const C = { blue: '#1a73e8', red: '#ea4335', green: '#0d9488', purple: '#7c3aed', sub: '#5f6368', orange: '#e8710a' };
const DEFAULT_TAX_RULE_TEXT = TAX_RULE_PRESETS[0].text;
const MIN_INVEST_ANNUAL_GROWTH_RATE = -0.99;
const MIN_FIRE_SAVINGS_ALLOCATION_RATE = 0.1;
const CNY_ASSET_ACCOUNT_KEYS = ['savingsCard', 'incomeBank', 'livingBank', 'campusCard', 'consumptionBank', 'wishJar', 'investCnyBank'] as const;
const USD_ASSET_ACCOUNT_KEYS = ['usdLivingBank', 'usdConsumptionBank', 'usdWishJar', 'investUsdBank'] as const;
const FIRE_MODE_LABELS = { life: '活', all: '生活', allocation: '分配' } as const;
const SCENE_PERIODS = {
  day: { label: '日', days: 1 },
  month: { label: '月', days: 365 / 12 },
  year: { label: '年', days: 365 },
} as const;
type ScenePeriod = keyof typeof SCENE_PERIODS;
type FireMode = keyof typeof FIRE_MODE_LABELS;
const FIRE_DEGREE_LABELS = { none: '不计人才政策', bachelor: '本科', master: '硕士', doctor: '博士' } as const;
const HANGZHOU_E_TALENT_WAGE_THRESHOLD = 500000;

type UsdRateResponse = {
  rate: number;
  date?: string;
  source?: string;
};

function fmt万(v: number) { return (v / 10000).toFixed(2) + '万'; }
function fmtW(v: number) { return (v / 10000).toFixed(2) + 'w'; }
function fmt年(v: number) { return Number.isInteger(v) ? String(v) : v.toFixed(1); }
function fmtRatio(v: number | null) { return v === null ? '—' : `${v.toFixed(2)}倍`; }
function Divider() { return <div style={{ height: 1, backgroundColor: '#f1f3f4', margin: '8px 0' }} />; }

function prevYearMonth(ym: string): string {
  const [year, month] = ym.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return '';
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

interface CombinedLifeBreakdownRow {
  category: string;
  amountTotal: number;
  dailyBase: number;
  sharedAmountTotal: number;
  sharedDailyBase: number;
  sharedItems: SharedLifeBreakdownItem[];
  subcategories: {
    subcategory: string;
    amountTotal: number;
    dailyBase: number;
  }[];
}

function mergeSceneLifeBreakdown(
  localRows: LocalLifeBreakdownRow[],
  sharedRows: SharedLifeBreakdownRow[],
): CombinedLifeBreakdownRow[] {
  const byCategory = new Map<string, CombinedLifeBreakdownRow>();
  const addRow = (row: LocalLifeBreakdownRow | SharedLifeBreakdownRow) => {
    const category = byCategory.get(row.category) ?? {
      category: row.category,
      amountTotal: 0,
      dailyBase: 0,
      sharedAmountTotal: 0,
      sharedDailyBase: 0,
      sharedItems: [],
      subcategories: [],
    };
    category.amountTotal += row.amountTotal;
    category.dailyBase += row.dailyBase;
    if ('items' in row) {
      category.sharedAmountTotal += row.amountTotal;
      category.sharedDailyBase += row.dailyBase;
      category.sharedItems.push(...row.items);
    }
    for (const sub of row.subcategories) {
      const existing = category.subcategories.find((item) => item.subcategory === sub.subcategory);
      if (existing) {
        existing.amountTotal += sub.amountTotal;
        existing.dailyBase += sub.dailyBase;
      } else {
        category.subcategories.push({ ...sub });
      }
    }
    byCategory.set(row.category, category);
  };

  localRows.forEach(addRow);
  sharedRows.forEach(addRow);
  return [...byCategory.values()]
    .map((row) => ({
      ...row,
      subcategories: row.subcategories.sort((a, b) => b.dailyBase - a.dailyBase),
    }))
    .sort((a, b) => b.dailyBase - a.dailyBase);
}

const SHARED_BILL_META_TAGS = new Set(['周期生活', '波动生活', '消费', '收入', '红', '黑']);

function sharedBillDisplayName(item: SharedLifeBreakdownItem): string {
  if (item.note.trim()) return item.note.trim();
  const descriptiveTags = item.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && !SHARED_BILL_META_TAGS.has(tag));
  if (descriptiveTags.length > 0) return descriptiveTags.join(' · ');
  if (item.subcategory && item.subcategory !== '未细分') return item.subcategory;
  return item.category;
}

function FireDetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: '10px 0 8px', borderTop: '1px solid #f1f3f4' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#202124', marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

// ── 趋势图 ────────────────────────────────────────────────────────
function TrendCharts({ records }: { records: MonthlyRecord[] }) {
  const chartData = useMemo(
    () => [...records].reverse().slice(-12).map((r) => ({
      month: r.yearMonth.slice(5),
      收入: r.income,
      支出: r.totalExpense,
      结余: r.income - r.totalExpense,
      周期生活: r.periodicLife,
      波动生活: r.volatileLife,
      消费: r.consumption,
    })),
    [records],
  );
  const tickStyle = { fontSize: 11, fill: C.sub };
  return (
    <>
      <Card title="收支趋势" subtitle="近12月">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f4" />
            <XAxis dataKey="month" tick={tickStyle} />
            <YAxis tick={tickStyle} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(v) => `¥${formatCurrency(Number(v))}`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="收入" stroke={C.red}   strokeWidth={2}   dot={false} />
            <Line type="monotone" dataKey="支出" stroke={C.green} strokeWidth={2}   dot={false} />
            <Line type="monotone" dataKey="结余" stroke={C.blue}  strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
          </LineChart>
        </ResponsiveContainer>
      </Card>
      <Card title="支出构成" subtitle="近12月堆叠">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f4" />
            <XAxis dataKey="month" tick={tickStyle} />
            <YAxis tick={tickStyle} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(v) => `¥${formatCurrency(Number(v))}`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="周期生活" stackId="a" fill={C.blue} />
            <Bar dataKey="波动生活" stackId="a" fill="#60a5fa" />
            <Bar dataKey="消费"     stackId="a" fill={C.purple} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </>
  );
}

// ── 主页 ──────────────────────────────────────────────────────────
export default function HomePage() {
  const syncReady = useSyncStatus((state) => state.ready);
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const { current } = useSnapshotStore();
  const { config, setConfig } = useConfigStore();
  const { records } = useMonthlyStore();
  const { confirmedExpenses } = useCalendarStore();
  const { tagMap, internship } = useLifeCalendar();
  const { expenseItems } = useBillDetailStore();
  const { overrides: expenseScopeOverrides } = useExpenseScopeOverrideStore();
  const { tripTags } = useTripStore();

  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const todayKey = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const currentYearMonth = todayKey.slice(0, 7);
  const twoYearsAgo = `${today.getFullYear() - 1}-01`;
  const filteredRecords = useMemo(
    () => records.filter((r) => r.yearMonth >= twoYearsAgo),
    [records, twoYearsAgo],
  );
  const stats = useMemo(
    () => calcHistoryStats(filteredRecords, tagMap, confirmedExpenses, expenseItems, expenseScopeOverrides, tripTags, internship),
    [filteredRecords, tagMap, confirmedExpenses, expenseItems, expenseScopeOverrides, tripTags, internship],
  );
  const holidayYears = useMemo(() => [currentYear - 1, currentYear, currentYear + 1], [currentYear]);
  const { holidayDataByYear, holidayWarning, unavailableYears } = useHolidayYears(holidayYears);

  // 近一年校园卡日均
  const oneYearAgo = `${today.getFullYear() - 1}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const campusDailyAvgYear = useMemo(() => {
    const recent = records.filter((r) => r.yearMonth >= oneYearAgo && (r.schoolDays ?? 0) > 0 && r.school > 0);
    if (recent.length === 0) return 0;
    return recent.reduce((s, r) => s + r.school / (r.schoolDays ?? 1), 0) / recent.length;
  }, [records, oneYearAgo]);

  const totalInvest = Object.values(current.investHoldings).reduce((s, v) => s + v, 0);
  const fallbackUsdRate = useMemo(
    () => [...records].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))
      .map((r) => r.investProfitComponents?.us?.rate ?? r.investProfitComponents?.usBond?.rate)
      .find((rate) => rate !== undefined && Number.isFinite(rate) && rate > 0) ?? null,
    [records],
  );
  const [remoteUsdRate, setRemoteUsdRate] = useState<UsdRateResponse | null>(null);
  const [usdRateError, setUsdRateError] = useState(false);
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
  const usdRateSourceLabel = remoteUsdRate
    ? `${remoteUsdRate.source ?? '实时汇率'}${remoteUsdRate.date ? ` · ${remoteUsdRate.date}` : ''}`
    : fallbackUsdRate !== null
      ? `${usdRateError ? '联网失败 · ' : ''}历史汇率`
      : '暂无汇率';
  const fireIncomeAssetStats = useMemo(() => {
    const sortedRecords = [...records].sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
    const recentRecords = sortedRecords.slice(0, 12);
    const byMonth = new Map(sortedRecords.map((record) => [record.yearMonth, record]));
    const annualIncome = recentRecords.reduce((sum, record) => sum + record.income, 0);
    const passiveIncome = recentRecords.reduce((sum, record) => {
      const prev = byMonth.get(prevYearMonth(record.yearMonth));
      return prev ? sum + record.accumulatedProfit - (prev.accumulatedProfit ?? 0) : sum;
    }, 0);
    const cnyAssets = CNY_ASSET_ACCOUNT_KEYS.reduce((sum, key) => sum + (current.accounts[key] ?? 0), 0);
    const usdAssetsOriginal = USD_ASSET_ACCOUNT_KEYS.reduce((sum, key) => sum + (current.accounts[key] ?? 0), 0);
    const usdAssetsCny = latestUsdRate !== null ? usdAssetsOriginal * latestUsdRate : 0;
    const creditLiability = current.accounts.credit ?? 0;
    const personalNetAssets = cnyAssets + usdAssetsCny + totalInvest - creditLiability;

    return {
      annualIncome,
      passiveIncome,
      personalNetAssets,
      assetIncomeRatio: annualIncome > 0 ? personalNetAssets / annualIncome : null,
      passiveIncomeRatio: annualIncome > 0 ? passiveIncome / annualIncome : null,
      recentMonthCount: recentRecords.length,
      usdAssetsOriginal,
      usdAssetsIncluded: latestUsdRate !== null,
    };
  }, [current.accounts, latestUsdRate, records, totalInvest]);

  // FIRE 模式切换
  const [fireMode, setFireMode] = useState<FireMode>('all');
  const averageAnnualizedRate = useMemo(() => getAverageAnnualizedRate(records), [records]);
  const fireUseAverageAnnualRate = config.fireUseAverageAnnualRate !== false;
  const fireConfig = useMemo(() => ({
    ...config,
    fireGraduationDate: getFireGraduationDate(config),
    investAnnualGrowthRate: fireUseAverageAnnualRate && averageAnnualizedRate !== null
      ? Math.max(averageAnnualizedRate, MIN_INVEST_ANNUAL_GROWTH_RATE)
      : config.investAnnualGrowthRate,
  }), [averageAnnualizedRate, config, fireUseAverageAnnualRate]);
  const [sceneDailyMode, setSceneDailyMode] = useState<'life' | 'all'>('life');
  const [scenePeriod, setScenePeriod] = useState<ScenePeriod>('day');
  const [fireExpanded, setFireExpanded] = useState(false);
  const [fireHousingFundRateDraft, setFireHousingFundRateDraft] = useState<string | null>(null);
  const [fireHousingFundBalanceDraft, setFireHousingFundBalanceDraft] = useState<string | null>(null);
  const [fireExpectedWageDraft, setFireExpectedWageDraft] = useState<string | null>(null);
  const [bonCvStatus, setBonCvStatus] = useState<'idle' | 'loading' | 'connected' | 'stale' | 'unconfigured'>('idle');
  const [sceneExpanded, setSceneExpanded] = useState<Set<TagKind>>(new Set());
  const [sceneCityFilters, setSceneCityFilters] = useState<Partial<Record<TagKind, string>>>({});
  const sceneCities = useMemo(() => ({
    school: sceneCitySummaries(stats, 'school'),
    intern: sceneCitySummaries(stats, 'intern'),
    home: [], travel: [],
  }), [stats]);
  const [sceneLocalOpenCategories, setSceneLocalOpenCategories] = useState<Set<string>>(new Set());
  const [sceneSharedOpenCategories, setSceneSharedOpenCategories] = useState<Set<string>>(new Set());
  const futureFireExpenses = config.futureFireExpenses ?? [];
  const syncFutureFireExpenses = (items: FutureFireExpense[]) => setConfig({ futureFireExpenses: items });
  const majorFireWishes = config.majorFireWishes ?? [];
  const [majorWishAmountDrafts, setMajorWishAmountDrafts] = useState<Record<string, string>>({});
  const syncMajorFireWishes = (items: MajorFireWish[]) => setConfig({ majorFireWishes: items });
  const postFireExpenses = useMemo(
    () => calcPostFireExpenses(stats, futureFireExpenses, config.fireExpenseTagKind),
    [stats, futureFireExpenses, config.fireExpenseTagKind],
  );
  const activeFutureFireMonthly = postFireExpenses.configuredMonthlyFixedExpense;
  const bonCvSyncedAtLabel = config.bonCvFireSnapshot?.syncedAt
    ? new Date(config.bonCvFireSnapshot.syncedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  const refreshBonCv = async () => {
    if ((config.fireProfileSource ?? 'boncv') !== 'boncv') return;
    setBonCvStatus('loading');
    try {
      const result = await fetchBonCvFireProfile(config.bonCvFireSnapshot?.etag);
      if (result.status === 'not-modified') {
        if (config.bonCvFireSnapshot) setConfig({ bonCvFireSnapshot: { ...config.bonCvFireSnapshot, syncedAt: new Date().toISOString() } });
        setBonCvStatus('connected');
        return;
      }
      const profile = result.profile;
      setConfig({
        birthDate: profile.birthDate || config.birthDate,
        fireTalentDegree: profile.education.level,
        fireGraduationDate: profile.education.graduationDate,
        bonCvFireSnapshot: {
          revision: profile.revision,
          updatedAt: profile.updatedAt,
          syncedAt: new Date().toISOString(),
          etag: result.etag,
          birthDate: profile.birthDate,
          education: profile.education,
        },
      });
      setBonCvStatus('connected');
    } catch (error) {
      setBonCvStatus(error instanceof Error && error.message === 'BONCV_NOT_CONFIGURED' ? 'unconfigured' : 'stale');
    }
  };

  useEffect(() => {
    if (syncReady && (config.fireProfileSource ?? 'boncv') === 'boncv') void refreshBonCv();
    // 仅在来源切换或页面首次进入时同步，避免写回配置后重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.fireProfileSource, syncReady]);
  const {
    base: fireBaseScenario,
    includesTravel: fireIncludesTravel,
    sampleKind: fireSampleKind,
    fallbackSample: fallbackFireExpenseTagKind,
    travelRatio: recentTravelRatio,
    annualizedTravelDays,
    lifeAnnualExpense: futureLifeAnnualExpense,
    consumptionAnnualExpense: futureConsumptionAnnualExpense,
  } = postFireExpenses;
  const fireScenarioLabel = `${fireBaseScenario === 'home' ? '寄' : '居'}${fireIncludesTravel ? '＋旅' : ''}`;
  const preFireExpenses = useMemo(() => calcPreFireExpenses(stats, activeFutureFireMonthly), [stats, activeFutureFireMonthly]);
  const preFireLifeStages = useMemo(() => [
    { endDate: fireConfig.fireGraduationDate, annualExpense: preFireExpenses.beforeGraduation.lifeAnnualExpense },
    { annualExpense: preFireExpenses.working.lifeAnnualExpense },
  ], [fireConfig.fireGraduationDate, preFireExpenses]);
  const preFireLivingStages = useMemo(() => [
    { endDate: fireConfig.fireGraduationDate, annualExpense: preFireExpenses.beforeGraduation.lifeAnnualExpense + preFireExpenses.beforeGraduation.consumptionAnnualExpense },
    { annualExpense: preFireExpenses.working.lifeAnnualExpense + preFireExpenses.working.consumptionAnnualExpense },
  ], [fireConfig.fireGraduationDate, preFireExpenses]);
  const preFireStages = fireMode === 'all' ? preFireLivingStages : preFireLifeStages;
  const fireSavingsAllocationRate = Math.min(Math.max(config.fireSavingsAllocationRate ?? 0.5, MIN_FIRE_SAVINGS_ALLOCATION_RATE), 1);
  const fireAnnualExpense = fireMode === 'life'
    ? futureLifeAnnualExpense
    : futureLifeAnnualExpense + futureConsumptionAnnualExpense;
  const fireExpenseAvg = fireAnnualExpense / 12;
  const fireStats = useMemo(() => ({ ...stats, totalExpenseAvg: fireExpenseAvg }), [stats, fireExpenseAvg]);
  const fireLivingStats = useMemo(
    () => ({ ...stats, totalExpenseAvg: (futureLifeAnnualExpense + futureConsumptionAnnualExpense) / 12 }),
    [stats, futureConsumptionAnnualExpense, futureLifeAnnualExpense],
  );
  const fireLiving = useMemo(
    () => calcFire(fireConfig, fireLivingStats, totalInvest, { essentialExpenseStages: preFireLivingStages }),
    [fireConfig, fireLivingStats, preFireLivingStages, totalInvest],
  );
  const fire = useMemo(() => calcFire(
    fireConfig,
    fireStats,
    totalInvest,
    {
      essentialExpenseStages: preFireStages,
      postEssentialSavingsRate: fireMode === 'allocation' ? fireSavingsAllocationRate : 1,
      wishShare: 0.8,
      salaryComparisonGrossIncomes: fireMode === 'allocation'
        ? [fireLiving.requiredAnnualGrossIncome]
        : undefined,
    },
  ), [fireConfig, fireMode, fireSavingsAllocationRate, fireStats, preFireStages, totalInvest, fireLiving.requiredAnnualGrossIncome]);
  const expectedAnnualWageIncome = config.fireExpectedAnnualWageIncome ?? HANGZHOU_E_TALENT_WAGE_THRESHOLD;
  const expectsETalent = config.fireExpectedTalentClass !== 'none';
  const eTalentIncomeThresholdMet = expectedAnnualWageIncome >= HANGZHOU_E_TALENT_WAGE_THRESHOLD;
  const eTalentRecognitionYear = Math.min(Math.max(Math.round(config.fireETalentRecognitionYear ?? 3), 2), 5);
  const expectedWageMargin = expectedAnnualWageIncome - fire.requiredAnnualGrossIncome;
  const customFireTargetYears = config.fireTargetYears && config.fireTargetYears > 0 && config.fireTargetYears < fire.retireYearsLeft
    ? Math.min(config.fireTargetYears, fire.retireYearsLeft)
    : undefined;
  const fireTargetYearOptions = useMemo(() => {
    const base = [1, 3, 5, 10, 15, 20];
    for (let year = 25; year < fire.retireYearsLeft; year += 5) base.push(year);
    if (customFireTargetYears && !base.includes(customFireTargetYears)) base.push(customFireTargetYears);
    return base.filter((year) => year < fire.retireYearsLeft).sort((a, b) => a - b);
  }, [customFireTargetYears, fire.retireYearsLeft]);
  const fireTargetYearSelectValue = customFireTargetYears ? String(customFireTargetYears) : 'retire';
  const fireTargetYearLabel = customFireTargetYears ? `${fmt年(customFireTargetYears)}年` : '退休';
  const updateFireTargetYears = (raw: string) => {
    if (raw === 'retire') {
      setConfig({ fireTargetYears: undefined });
      return;
    }
    setConfig({ fireTargetYears: Math.min(Number(raw), fire.retireYearsLeft) });
  };
  const updateFireGrowthRate = (raw: string) => {
    const parsed = Number(normalizeDecimalPunctuation(raw));
    const next = Number.isFinite(parsed) ? Math.max(parsed / 100, MIN_INVEST_ANNUAL_GROWTH_RATE) : 0;
    setConfig({ investAnnualGrowthRate: next, fireUseAverageAnnualRate: false });
  };
  const updateFireSavingsAllocationRate = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    setConfig({ fireSavingsAllocationRate: Math.min(Math.max(parsed / 100, MIN_FIRE_SAVINGS_ALLOCATION_RATE), 1) });
  };
  const updateFireHousingFundRate = (raw: string) => {
    setFireHousingFundRateDraft(raw);
    if (raw === '') return;
    const parsed = Number(normalizeDecimalPunctuation(raw));
    const next = Number.isFinite(parsed) ? Math.min(Math.max(parsed / 100, 0.05), 0.12) : 0.12;
    setConfig({ fireHousingFundRate: next });
  };
  const updateFireExpectedWageWan = (raw: string) => {
    const normalized = sanitizeDecimalNumberInput(raw);
    if (normalized === null) return;
    setFireExpectedWageDraft(normalized);
    if (normalized === '') return;
    const amountWan = Number(normalized);
    setConfig({ fireExpectedAnnualWageIncome: Number.isFinite(amountWan) ? Math.max(amountWan, 0) * 10000 : HANGZHOU_E_TALENT_WAGE_THRESHOLD });
  };
  const toggleScene = (tagKind: TagKind) => {
    setSceneExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tagKind)) next.delete(tagKind);
      else next.add(tagKind);
      return next;
    });
  };
  const toggleSceneLocalCategory = (categoryKey: string) => {
    setSceneLocalOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryKey)) next.delete(categoryKey);
      else next.add(categoryKey);
      return next;
    });
  };
  const toggleSceneSharedCategory = (categoryKey: string) => {
    setSceneSharedOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryKey)) next.delete(categoryKey);
      else next.add(categoryKey);
      return next;
    });
  };

  const updateFutureFireExpense = (id: string, field: keyof FutureFireExpense, raw: string | boolean) => {
    syncFutureFireExpenses(futureFireExpenses.map((item) => {
      if (item.id !== id) return item;
      if (field === 'name') return { ...item, name: String(raw) };
      if (field === 'monthlyAmount') return { ...item, monthlyAmount: parseFloat(String(raw)) || 0 };
      if (field === 'isActive') return { ...item, isActive: Boolean(raw) };
      return item;
    }));
  };
  const addFutureFireExpense = () => syncFutureFireExpenses([
    ...futureFireExpenses,
    { id: `future_fire_${Date.now()}`, name: '租房', monthlyAmount: 0, isActive: true },
  ]);
  const removeFutureFireExpense = (id: string) => syncFutureFireExpenses(futureFireExpenses.filter((item) => item.id !== id));
  const updateMajorFireWish = (id: string, field: keyof MajorFireWish, raw: string | boolean) => {
    syncMajorFireWishes(majorFireWishes.map((item) => {
      if (item.id !== id) return item;
      if (field === 'name') return { ...item, name: String(raw) };
      if (field === 'amount') return { ...item, amount: Math.max(parseFloat(String(raw)) || 0, 0) };
      if (field === 'isActive') return { ...item, isActive: Boolean(raw) };
      return item;
    }));
  };
  const addMajorFireWish = () => syncMajorFireWishes([
    ...majorFireWishes,
    { id: `major_fire_wish_${Date.now()}`, name: '买房', amount: 0, isActive: true },
  ]);
  const removeMajorFireWish = (id: string) => syncMajorFireWishes(majorFireWishes.filter((item) => item.id !== id));
  const updateMajorFireWishWan = (id: string, raw: string) => {
    const normalized = sanitizeDecimalNumberInput(raw);
    if (normalized === null) return;
    setMajorWishAmountDrafts((prev) => ({ ...prev, [id]: normalized }));
    const amountWan = Number(normalized);
    updateMajorFireWish(id, 'amount', String(Number.isFinite(amountWan) ? amountWan * 10000 : 0));
  };
  const finishMajorFireWishWanEdit = (id: string) => {
    setMajorWishAmountDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  // 固定收入编辑
  const localIncome = config.incomeItems;
  const syncIncome = (items: IncomeItem[]) => { setConfig({ incomeItems: items }); };
  const updateIncomeField = (id: string, field: keyof IncomeItem, raw: string) => {
    const items = localIncome.map((item) => {
      if (item.id !== id) return item;
      if (field === 'amount')    return { ...item, amount: parseFloat(raw) || 0 };
      if (field === 'payDay')    { const v = parseInt(raw, 10); return { ...item, payDay: isNaN(v) ? 1 : v }; }
      if (field === 'name')      return { ...item, name: raw };
      if (field === 'dailyRate') return { ...item, dailyRate: parseFloat(raw) || undefined };
      if (field === 'taxRuleText') return { ...item, taxRuleText: raw };
      return item;
    });
    syncIncome(items);
  };
  const toggleTaxRule = (id: string) => {
    const items = localIncome.map((item) => {
      if (item.id !== id) return item;
      if (item.taxRuleText?.trim()) {
        const { taxRuleText: _taxRuleText, ...rest } = item;
        return rest as IncomeItem;
      }
      return { ...item, taxRuleText: DEFAULT_TAX_RULE_TEXT };
    });
    syncIncome(items);
  };
  const setTaxRuleText = (id: string, ruleText: string) => {
    syncIncome(localIncome.map((item) => item.id === id ? { ...item, taxRuleText: ruleText } : item));
  };
  const toggleDailyRate = (id: string) => {
    const items = localIncome.map((item) => {
      if (item.id !== id) return item;
      if (item.dailyRate !== undefined) {
        const { dailyRate: _dr, tagKind: _tk, ...rest } = item;
        return rest as IncomeItem;
      }
      return { ...item, dailyRate: 0, tagKind: 'intern' as TagKind };
    });
    syncIncome(items);
  };
  const addIncomeItem    = () => syncIncome([...localIncome, { id: `income_${Date.now()}`, name: '新收入', amount: 0, payDay: 1, isActive: true }]);
  const removeIncomeItem = (id: string) => syncIncome(localIncome.filter((i) => i.id !== id));

  const resolvedIncomeItems = useMemo(
    () => resolveAllIncomeForMonth(localIncome, currentYear, currentMonth, tagMap, holidayDataByYear, internship),
    [localIncome, currentYear, currentMonth, tagMap, holidayDataByYear, internship],
  );

  const renderIncomeEditor = (item: ResolvedIncomeItem) => <IncomeItemEditor key={item.id} item={item} today={today}
    onChange={(field, value) => updateIncomeField(item.id, field, value)}
    onToggleActive={() => syncIncome(localIncome.map(x => x.id === item.id ? { ...x, isActive: !x.isActive } : x))}
    onToggleDailyRate={() => toggleDailyRate(item.id)} onToggleTaxRule={() => toggleTaxRule(item.id)}
    onSetTaxRule={text => setTaxRuleText(item.id, text)} onRemove={() => removeIncomeItem(item.id)}
  />;

  // 月度快照
  const investmentProfitSummary = useMemo(() => {
    const recordsByMonth = new Map(records.map((record) => [record.yearMonth, record]));
    const currentRecord = recordsByMonth.get(currentYearMonth);
    const previousRecord = recordsByMonth.get(prevYearMonth(currentYearMonth));
    const monthIncome = currentRecord && previousRecord
      ? currentRecord.accumulatedProfit - previousRecord.accumulatedProfit
      : null;
    const monthInvestTotal = currentRecord
      ? getInvestTotalForRate(currentYearMonth, currentRecord.investTotal, records)
      : null;
    const monthRate = monthIncome !== null && monthInvestTotal
      ? monthIncome / monthInvestTotal.value
      : null;

    const yearRecords = records.filter((record) => record.yearMonth.startsWith(`${currentYear}-`)
      && record.yearMonth <= currentYearMonth);
    const yearIncomeParts = yearRecords.flatMap((record) => {
      const previous = recordsByMonth.get(prevYearMonth(record.yearMonth));
      return previous ? [record.accumulatedProfit - previous.accumulatedProfit] : [];
    });
    const yearReturn = getYearInvestmentReturn(records, todayKey);

    return {
      monthIncome,
      monthRate,
      yearIncome: yearIncomeParts.length > 0
        ? yearIncomeParts.reduce((sum, income) => sum + income, 0)
        : null,
      yearAnnualizedRate: yearReturn?.annualizedRate ?? null,
    };
  }, [currentYear, currentYearMonth, records, todayKey]);

  // 同期每月定投标普500对比（数据源与「bill-资产配置比例-回测」一致）
  const [sp500Charts, setSp500Charts] = useState<Partial<Record<PortfolioBacktestSeriesId, MarketChartResponse>> | null>(null);
  const [sp500Error, setSp500Error] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(SP500_COMPARISON_REQUESTS.map(async (definition) => {
      const response = await fetch(portfolioBacktestRequestUrl(definition), { signal: controller.signal });
      if (!response.ok) throw new Error(`${definition.symbol} history ${response.status}`);
      return [definition.id, await response.json() as MarketChartResponse] as const;
    })).then((entries) => {
      setSp500Charts(Object.fromEntries(entries));
      setSp500Error(false);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn('sp500 comparison unavailable', error);
      setSp500Error(true);
    });
    return () => controller.abort();
  }, []);
  const sp500Comparison = useMemo(() => {
    if (!sp500Charts) return { monthSp500Profit: null, yearSp500Profit: null };
    return calculateSp500Comparison(sp500Charts, records, currentYearMonth);
  }, [sp500Charts, records, currentYearMonth]);
  const sp500MonthDiff = investmentProfitSummary.monthIncome !== null && sp500Comparison.monthSp500Profit !== null
    ? investmentProfitSummary.monthIncome - sp500Comparison.monthSp500Profit
    : null;
  const sp500YearDiff = investmentProfitSummary.yearIncome !== null && sp500Comparison.yearSp500Profit !== null
    ? investmentProfitSummary.yearIncome - sp500Comparison.yearSp500Profit
    : null;
  const renderSp500Cell = (diff: number | null) => {
    if (sp500Error) return <span style={{ fontSize: 11, color: C.sub }}>标普数据获取失败</span>;
    if (!sp500Charts) return <span style={{ fontSize: 11, color: C.sub }}>标普数据加载中…</span>;
    if (diff === null) return <span style={{ fontSize: 11, color: C.sub }}>标普数据不足</span>;
    return (
      <span style={{ fontSize: 12, fontWeight: 600, color: diff >= 0 ? C.red : C.green }}>
        {diff >= 0 ? '跑赢标普 ' : '跑输标普 '}
        ¥{formatCurrency(Math.abs(diff))}
      </span>
    );
  };
  const monthlySurplus = stats.monthlyIncomeAvg - stats.totalExpenseAvg;
  type SceneDailyRow = { tagKind: TagKind; val: number; lifeVal: number; consumptionVal: number };
  const sceneDailyTagKinds = ['school', 'intern', 'home', 'travel'] as TagKind[];
  const buildSceneDailyRow = (tagKind: TagKind): SceneDailyRow => {
    const lifeVal = stats.stateDailyAvg[tagKind];
    const consumptionVal = stats.stateConsumptionDailyAvg[tagKind];
    return {
      tagKind,
      lifeVal,
      consumptionVal,
      val: lifeVal + (sceneDailyMode === 'all' ? consumptionVal : 0),
    };
  };
  const sceneDailyRows: SceneDailyRow[] = sceneDailyTagKinds.map(buildSceneDailyRow).filter((r) => r.val > 0);
  const hasSceneDaily = sceneDailyRows.length > 0 || sceneDailyTagKinds.some((tagKind) => stats.stateConsumptionDailyAvg[tagKind] > 0);
  const sceneBlocks = (
    [
      { key: 'campus-work', tagKinds: ['school', 'intern'] as TagKind[], bg: '#eff6ff', border: '#bfdbfe' },
      { key: 'home', tagKinds: ['home'] as TagKind[], bg: '#fffbeb', border: '#fde68a' },
      { key: 'travel', tagKinds: ['travel'] as TagKind[], bg: '#fdf2f8', border: '#fbcfe8' },
    ]
  ).map((block) => ({
    ...block,
    rows: block.tagKinds
      .map(buildSceneDailyRow)
      .filter((row) => row.val > 0),
  })).filter((block) => block.rows.length > 0);
  const sceneRangeLabel = filteredRecords.length >= 12
    ? `(近 ${(filteredRecords.length / 12).toFixed(1)} 年)`
    : `(近 ${filteredRecords.length} 个月)`;
  const scenePeriodConfig = SCENE_PERIODS[scenePeriod];
  const formatSceneAmount = (dailyAmount: number) => {
    const amount = dailyAmount * scenePeriodConfig.days;
    const formattedAmount = scenePeriod === 'year'
      ? `${(amount / 10000).toFixed(1)}万`
      : scenePeriod === 'month'
        ? `${(amount / 1000).toFixed(1)}k`
        : formatCurrency(amount);
    return `¥${formattedAmount}/${scenePeriodConfig.label}`;
  };
  const fireProgressPercent = Math.min(Math.max(fire.progress * 100, 0), 100);
  const fireProgressLabel = `${(fire.progress * 100).toFixed(1)}%`;
  const fireProgressGap = Math.max(fire.fireTarget - totalInvest, 0);

  return (
    <div className="home-page-shell">
      {/* 页头：标题 + 人生时钟 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', margin: '0 0 16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, whiteSpace: 'nowrap' }}>盘账助手</h1>
            <button type="button" disabled={signingOut} onClick={() => {
              setSigningOut(true);
              setLogoutError('');
              void signOut().catch((cause) => {
                setLogoutError(cause instanceof Error ? cause.message : '退出失败，请重试');
                setSigningOut(false);
              });
            }} style={{ border: 'none', padding: '4px 0', background: 'transparent', color: C.sub, fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer' }}>
              {signingOut ? '退出中…' : '退出登录'}
            </button>
          </div>
          {logoutError && <p role="alert" style={{ color: '#c5221f', fontSize: 11, margin: '0 0 2px' }}>{logoutError}</p>}
          <p style={{ fontSize: 13, color: C.sub, margin: 0 }}>
            {today.getFullYear()}年{today.getMonth() + 1}月 · 第 {today.getDate()} 天
          </p>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() => navigate('/possessions')}
              style={{ border: 'none', borderRadius: 999, backgroundColor: '#202124', color: '#fff', fontSize: 12, fontWeight: 700, padding: '6px 10px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.14)' }}
            >
              📦 物品
            </button>
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 30, fontWeight: 700, fontFamily: 'monospace', color: '#202124', letterSpacing: 1 }}>
            {fire.lifeClockStr}
          </div>
          <div style={{ fontSize: 11, color: C.sub }}>{fire.lifeClockPeriod}</div>
          <div title={`v${APP_VERSION} 本版改动`} style={{ display: 'inline-block', marginTop: 4, fontSize: 10, fontWeight: 500, color: C.blue, backgroundColor: '#e8f0fe', padding: '2px 6px', borderRadius: 6 }}>
            <a href="/calendar?tab=month" style={{ color: 'inherit', textDecoration: 'none' }}>✨ {RELEASE_NOTE}</a>
          </div>
        </div>
      </div>

      {/* 理财收益 */}
      <Card title="理财收益" subtitle="按月度记录计算">
        {([
          {
            key: 'month',
            label: '本月赚了',
            income: investmentProfitSummary.monthIncome,
            rateLabel: '收益率',
            rateValue: investmentProfitSummary.monthRate === null
              ? '—'
              : `${(investmentProfitSummary.monthRate * 100).toFixed(2)}%`,
            diff: sp500MonthDiff,
          },
          {
            key: 'year',
            label: '今年赚了',
            income: investmentProfitSummary.yearIncome,
            rateLabel: '年化收益率',
            rateValue: investmentProfitSummary.yearAnnualizedRate === null
              ? '—'
              : `${(investmentProfitSummary.yearAnnualizedRate * 100).toFixed(2)}%`,
            diff: sp500YearDiff,
          },
        ] as const).map((row) => (
          <div
            key={row.key}
            className="home-investment-summary"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '7px 0',
              fontSize: 14,
            }}
          >
            <span style={{ color: C.sub, flexShrink: 0 }}>{row.label}</span>
            <span className="home-investment-value" style={{ flex: 1, display: 'inline-flex', alignItems: 'baseline', gap: 8, fontWeight: 500, fontVariantNumeric: 'tabular-nums', minWidth: 0 }}>
              {row.income === null
                ? <span style={{ color: C.sub }}>—</span>
                : <CurrencyDisplay value={row.income} color={row.income >= 0 ? C.red : C.green} />}
              <span style={{ fontSize: 12, color: C.sub, whiteSpace: 'nowrap' }}>
                <span className="rate-label-prefix">{row.rateLabel} </span>{row.rateValue}
              </span>
            </span>
            <span className="home-investment-benchmark" style={{ flexShrink: 0, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {renderSp500Cell(row.diff)}
            </span>
          </div>
        ))}
      </Card>

      {/* 月度快照 */}
      <Card title="月度快照" subtitle={`近两年均值 · 共 ${records.length} 个月`}>
        <StatRow label="月均收入" value={<CurrencyDisplay value={stats.monthlyIncomeAvg} color={C.red}   kFormat />} />
        <StatRow label="月均支出" value={<CurrencyDisplay value={stats.totalExpenseAvg}  color={C.green} kFormat />} />
        <StatRow label="周期生活" indent value={<CurrencyDisplay value={stats.periodicLifeAvg} color={C.blue} kFormat />} />
        <StatRow label="波动生活" indent value={<CurrencyDisplay value={stats.volatileLifeAvg} color={C.blue} kFormat />} />
        <StatRow label="消费"     indent value={<CurrencyDisplay value={stats.consumptionAvg}  color={C.purple} kFormat />} />
        <Divider />
        <StatRow label="月均结余" value={<CurrencyDisplay value={monthlySurplus} color={monthlySurplus >= 0 ? C.red : C.green} kFormat />} />
        {hasSceneDaily && (
          <>
            <Divider />
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px 8px', marginBottom: 4 }}>
              <div style={{ fontSize: 12, color: C.sub, whiteSpace: 'nowrap' }}>场景{scenePeriodConfig.label}均 {sceneRangeLabel}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                <div role="group" aria-label="场景金额周期" style={{ display: 'flex', backgroundColor: '#f1f3f4', borderRadius: 999, padding: 2, gap: 2 }}>
                  {(['day', 'month', 'year'] as const).map((period) => {
                    const active = scenePeriod === period;
                    return (
                      <button
                        key={period}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setScenePeriod(period)}
                        style={{ minWidth: 28, padding: '3px 6px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, backgroundColor: active ? '#fff' : 'transparent', color: active ? C.blue : C.sub, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none', transition: 'all 0.15s' }}
                      >
                        {SCENE_PERIODS[period].label}
                      </button>
                    );
                  })}
                </div>
                <div role="group" aria-label="场景支出范围" style={{ display: 'flex', backgroundColor: '#f1f3f4', borderRadius: 999, padding: 2, gap: 2 }}>
                  {(['life', 'all'] as const).map((mode) => {
                    const active = sceneDailyMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSceneDailyMode(mode)}
                        style={{ minWidth: 38, padding: '3px 9px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, backgroundColor: active ? '#fff' : 'transparent', color: active ? C.blue : C.sub, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none', transition: 'all 0.15s' }}
                      >
                        {mode === 'life' ? '活' : '生活'}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            {sceneBlocks.map((block) => (
              <div key={block.key} style={{ backgroundColor: block.bg, border: `1px solid ${block.border}`, borderRadius: 8, marginTop: 6, overflow: 'hidden' }}>
                {block.rows.map((overall, idx) => {
                  const m = tagMeta[overall.tagKind];
                  const expanded = sceneExpanded.has(overall.tagKind);
                  const cityOptions = sceneCities[overall.tagKind];
                  const selectedCity = expanded ? cityOptions.find(city => city.key === sceneCityFilters[overall.tagKind]) : undefined;
                  const r = selectedCity ? { ...overall, lifeVal: selectedCity.lifeVal, consumptionVal: selectedCity.consumptionVal,
                    val: selectedCity.lifeVal + (sceneDailyMode === 'all' ? selectedCity.consumptionVal : 0) } : overall;
                  const sharedPct = r.val > 0 ? (stats.sharedLifeDailyBase / r.val) * 100 : 0;
                  const combinedBreakdown = mergeSceneLifeBreakdown(selectedCity?.localLifeBreakdown ?? stats.localLifeBreakdown[r.tagKind] ?? [], stats.sharedLifeBreakdown);
                  const combinedBreakdownDaily = combinedBreakdown.reduce((sum, row) => sum + row.dailyBase, 0);
                  const unclassifiedLifeDaily = Math.max(r.lifeVal - combinedBreakdownDaily, 0);
                  return (
                    <div key={r.tagKind} style={{ borderTop: idx > 0 ? `1px solid ${block.border}` : 'none' }}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => toggleScene(r.tagKind)}
                        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '7px 10px', color: 'inherit', background: 'none', border: 'none', cursor: 'pointer' }}
                      >
                        <span style={{ color: C.sub, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, marginRight: 8 }}>
                          <span style={{ marginRight: 4, fontSize: 10, color: '#9aa0a6' }}>{expanded ? '▼' : '▶'}</span>
                          {m.icon} {m.label}
                          {selectedCity && <span> · {cityLabel(selectedCity.city)}</span>}
                          {stats.sharedLifeDailyBase > 0 && r.lifeVal > 0 && (
                            <span style={{ fontSize: 11, color: '#9aa0a6' }}>（共享均摊 {sharedPct.toFixed(1)}%）</span>
                          )}
                        </span>
                        <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: '#202124', flexShrink: 0 }}>{formatSceneAmount(r.val)}</span>
                      </button>
                      {expanded && (
                        <div style={{ padding: '4px 10px 8px', borderTop: '1px dashed #dadce0' }}>
                          {cityOptions.length > 0 && <div role="group" aria-label={`${m.label}城市`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, padding: '3px 0 6px' }}>
                            {[{ key: '', label: '综合' }, ...cityOptions.map(city => ({ key: city.key, label: cityLabel(city.city) }))].map(city => {
                              const active = (selectedCity?.key ?? '') === city.key;
                              return <button key={city.key} type="button" aria-pressed={active}
                                onClick={() => setSceneCityFilters(previous => ({ ...previous, [r.tagKind]: active ? '' : city.key }))}
                                style={{ border: 0, borderRadius: 999, padding: '3px 8px', fontSize: 11, cursor: 'pointer', background: active ? C.blue : '#f1f3f4', color: active ? '#fff' : C.sub }}>{city.label}</button>;
                            })}
                            {selectedCity && <span style={{ color: C.sub, fontSize: 10, marginLeft: 'auto' }}>{selectedCity.days}天</span>}
                          </div>}
                          {combinedBreakdown.map((row) => {
                            const pct = r.val > 0 ? (row.dailyBase / r.val) * 100 : 0;
                            const categoryKey = `${r.tagKind}|${row.category}`;
                            const categoryOpen = sceneLocalOpenCategories.has(categoryKey);
                            const hasSubBreakdown = row.subcategories.length > 0;
                            const sharedBillsOpen = sceneSharedOpenCategories.has(categoryKey);
                            const hasCategoryDetails = hasSubBreakdown || row.sharedItems.length > 0;
                            return (
                              <div key={row.category}>
                                <button
                                  type="button"
                                  aria-expanded={hasCategoryDetails ? categoryOpen : undefined}
                                  onClick={() => hasCategoryDetails && toggleSceneLocalCategory(categoryKey)}
                                  style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '3px 0', color: '#3c4043', background: 'none', border: 'none', cursor: hasCategoryDetails ? 'pointer' : 'default' }}
                                >
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, marginRight: 8, textAlign: 'left' }}>
                                    {hasCategoryDetails && (
                                      <span style={{ marginRight: 4, fontSize: 9, color: '#9aa0a6' }}>{categoryOpen ? '▼' : '▶'}</span>
                                    )}
                                    {row.category} <span style={{ color: '#9aa0a6' }}>· {pct.toFixed(1)}%</span>
                                  </span>
                                  <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, color: C.sub }}>{formatSceneAmount(row.dailyBase)}</span>
                                </button>
                                {categoryOpen && hasSubBreakdown && (
                                  <div style={{ padding: '0 0 3px 14px' }}>
                                    {row.subcategories.map((sub) => {
                                      const subPct = row.dailyBase > 0 ? (sub.dailyBase / row.dailyBase) * 100 : 0;
                                      return (
                                        <div key={sub.subcategory} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0', color: '#5f6368' }}>
                                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, marginRight: 8 }}>
                                            {sub.subcategory} <span style={{ color: '#9aa0a6' }}>· {subPct.toFixed(1)}%</span>
                                          </span>
                                          <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatSceneAmount(sub.dailyBase)}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {categoryOpen && row.sharedItems.length > 0 && (
                                  <div style={{ margin: '2px 0 4px 14px', border: '1px solid rgba(124,58,237,0.14)', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.62)', overflow: 'hidden' }}>
                                    <button
                                      type="button"
                                      aria-expanded={sharedBillsOpen}
                                      onClick={() => toggleSceneSharedCategory(categoryKey)}
                                      style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, border: 'none', backgroundColor: 'transparent', padding: '4px 6px', color: '#6d28d9', fontSize: 9, cursor: 'pointer' }}
                                    >
                                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                                        {sharedBillsOpen ? '▼' : '▶'} 共享均摊账单 · {row.sharedItems.length}笔
                                      </span>
                                      <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{formatSceneAmount(row.sharedDailyBase)}</span>
                                    </button>
                                    {sharedBillsOpen && (
                                      <div style={{ borderTop: '1px dashed rgba(124,58,237,0.16)', padding: '2px 6px 4px' }}>
                                        {row.sharedItems.map((item, itemIndex) => {
                                          const displayName = sharedBillDisplayName(item);
                                          return (
                                            <div key={`${item.id}-${itemIndex}`} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr) auto', alignItems: 'center', gap: 5, padding: '2px 0', fontSize: 9, color: '#5f6368' }}>
                                              <span style={{ color: '#9aa0a6', fontVariantNumeric: 'tabular-nums' }}>{item.date.slice(2)}</span>
                                              <span title={displayName} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
                                              <span style={{ color: '#3c4043', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>¥{formatCurrency(item.amount)}</span>
                                            </div>
                                          );
                                        })}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, paddingTop: 3, borderTop: '1px solid rgba(124,58,237,0.1)', fontSize: 9, color: '#8b5cf6' }}>
                                          <span>历史合计</span>
                                          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>¥{formatCurrency(row.sharedAmountTotal)}</span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {unclassifiedLifeDaily > 0.005 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', color: '#3c4043' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, marginRight: 8 }}>
                                {sceneDailyMode === 'all' ? '活未拆分估算' : '未拆分估算'} <span style={{ color: '#9aa0a6' }}>· {(r.val > 0 ? (unclassifiedLifeDaily / r.val) * 100 : 0).toFixed(1)}%</span>
                              </span>
                              <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, color: C.sub }}>{formatSceneAmount(unclassifiedLifeDaily)}</span>
                            </div>
                          )}
                          {sceneDailyMode === 'all' && r.consumptionVal > 0.005 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', color: '#3c4043' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, marginRight: 8 }}>
                                消费估算 <span style={{ color: '#9aa0a6' }}>· {(r.val > 0 ? (r.consumptionVal / r.val) * 100 : 0).toFixed(1)}%</span>
                              </span>
                              <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, color: C.purple }}>{formatSceneAmount(r.consumptionVal)}</span>
                            </div>
                          )}
                          {r.tagKind === 'school' && (!selectedCity || selectedCity.days === stats.stateDailyConfidence.school) && campusDailyAvgYear > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', color: '#3c4043' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, marginRight: 8 }}>
                                🍜 校园卡{scenePeriodConfig.label}均 <span style={{ color: '#9aa0a6' }}>(近一年 · 已含)</span>
                              </span>
                              <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, color: C.sub }}>{formatSceneAmount(campusDailyAvgYear)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </Card>

      {/* FIRE */}
      <section style={{ backgroundColor: '#fff', borderRadius: 16, padding: '18px 20px', marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <button
            onClick={() => setFireExpanded((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: '#202124', userSelect: 'none' }}
          >
            <span style={{ fontSize: 15, fontWeight: 700 }}>FIRE</span>
            <span style={{ fontSize: 11, color: C.sub, transform: fireExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', display: 'inline-block' }}>▼</span>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'nowrap', minWidth: 0, maxWidth: '100%', overflowX: 'auto', scrollbarWidth: 'none' }}>
            <div style={{ display: 'flex', flex: '0 0 auto', backgroundColor: '#f1f3f4', borderRadius: 999, padding: 2, gap: 2 }} onClick={(e) => e.stopPropagation()}>
              {(Object.keys(FIRE_MODE_LABELS) as FireMode[]).map((mode) => {
                const active = fireMode === mode;
                return (
                  <button key={mode} onClick={() => setFireMode(mode)} style={{ minWidth: 0, padding: '4px 6px', whiteSpace: 'nowrap', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, backgroundColor: active ? '#fff' : 'transparent', color: active ? C.blue : C.sub, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.12)' : 'none', transition: 'all 0.15s' }}>
                    {FIRE_MODE_LABELS[mode]}
                  </button>
                );
              })}
            </div>
            <FireScenarioToggle
              scenario={config.fireExpenseTagKind}
              onChange={(scenario) => setConfig({ fireExpenseTagKind: scenario })}
            />
            <select
              value={fireTargetYearSelectValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => updateFireTargetYears(e.target.value)}
              style={{ flex: '0 0 auto', border: '1px solid #e0e0e0', borderRadius: 999, backgroundColor: '#fff', color: '#202124', fontSize: 12, fontWeight: 700, padding: '5px 6px', outline: 'none', cursor: 'pointer' }}
            >
              <option value="retire">退休</option>
              {fireTargetYearOptions.map((year) => (
                <option key={year} value={year}>{fmt年(year)}年</option>
              ))}
            </select>
          </div>
        </div>
        {fireIncludesTravel && (
          <div style={{ margin: '-4px 0 12px', fontSize: 11, color: C.sub, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            近两年旅行 {annualizedTravelDays.toFixed(1)}天/年 · {(recentTravelRatio * 100).toFixed(1)}%
          </div>
        )}
        {fireMode === 'allocation' && (
          <FireAllocationSlider
            rate={fireSavingsAllocationRate}
            onChange={updateFireSavingsAllocationRate}
            livingMatch={{ rate: fire.salaryComparisonSavingsRates[0] ?? null, annualGrossIncome: fireLiving.requiredAnnualGrossIncome }}
          />
        )}
        <div onClick={() => setFireExpanded((v) => !v)} style={{ cursor: 'pointer', userSelect: 'none' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 180, flex: '1 1 180px' }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 3 }}>{fire.employmentStartYears > 0 ? '就业首年' : '首年'}最低税前年薪</div>
              <div style={{ fontSize: 32, lineHeight: 1.05, fontWeight: 800, color: C.red, fontVariantNumeric: 'tabular-nums' }}>{fire.hasSalarySolution ? fmt万(fire.requiredAnnualGrossIncome) : '—'}</div>
              <div style={{ marginTop: 5, fontSize: 12, color: C.sub }}>
                {!fire.canReachTarget && <span style={{ color: C.orange }}>{fire.preCareerFundingGap > 0 ? `在读预计缺口 ${fmt万(fire.preCareerFundingGap)}` : '就业前未达标'} · </span>}
                {fire.canReachTarget ? `${fireTargetYearLabel}达标` : `${fireTargetYearLabel}目标`} · 年涨薪 {(fire.salaryAnnualGrowthRate * 100).toFixed(0)}% · 首年到手 {fire.hasSalarySolution ? fmt万(fire.requiredAnnualSalaryNetIncome) : '—'}
                {fireMode === 'allocation' && fire.hasSalarySolution && <span style={{ color: C.purple }}> · 消费/心愿 {fmt万(fire.requiredAnnualFlexibleSpending)}</span>}
                {fire.requiredAnnualHousingFundRentWithdrawal > 0 && <span style={{ color: C.green }}> · 公积金可提 {fmt万(fire.requiredAnnualHousingFundRentWithdrawal)}</span>}
                {fire.majorWishTotal > 0 && <span style={{ color: C.purple }}> · 含愿望 {fmtW(fire.majorWishTotal)}</span>}
                <span style={{ color: fire.hasSalarySolution ? (expectedWageMargin >= 0 ? C.green : C.orange) : C.sub }}> · 预期 {fmtW(expectedAnnualWageIncome)}</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, flex: '1 1 230px', minWidth: 0 }}>
              {[
                { label: '目标年数', value: `${fmt年(fire.targetYears)}年`, color: '#202124' },
                { label: '完成进度', value: fireProgressLabel, color: C.blue },
                { label: '首年月存入', value: fire.hasSalarySolution ? fmt万(fire.monthlyNeeded) : '—', color: C.orange },
              ].map((item) => (
                <div key={item.label} style={{ backgroundColor: '#f8f9fa', border: '1px solid #f1f3f4', borderRadius: 10, padding: '8px 10px', minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: C.sub, marginBottom: 3, whiteSpace: 'nowrap' }}>{item.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: item.color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: C.sub, marginBottom: 6 }}>
              <span>{fireMode === 'allocation' ? '退休资产进度' : '资产进度'}{fireProgressGap > 0 && <span style={{ marginLeft: 6, color: C.orange, fontVariantNumeric: 'tabular-nums' }}>还需 {fmt万(fireProgressGap)}</span>}</span>
              <span style={{ fontWeight: 700, color: C.blue, fontVariantNumeric: 'tabular-nums' }}>{fireProgressLabel}</span>
            </div>
            <div style={{ height: 8, backgroundColor: '#edf2f7', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${fireProgressPercent}%`, backgroundColor: C.blue, borderRadius: 999, transition: 'width 0.3s' }} />
            </div>
          </div>
        </div>
        {fireExpanded && (
          <div style={{ marginTop: 16 }}>
            <FireDetailGroup title="收入资产">
              <StatRow label="个人资产/年收入" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: C.blue }}>{fmtRatio(fireIncomeAssetStats.assetIncomeRatio)}</span>} />
              <StatRow label="被动收入/年收入" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: fireIncomeAssetStats.passiveIncome >= 0 ? C.green : C.red }}>{fmtRatio(fireIncomeAssetStats.passiveIncomeRatio)}</span>} />
              <StatRow label={`近一年年收入${fireIncomeAssetStats.recentMonthCount < 12 ? ` · ${fireIncomeAssetStats.recentMonthCount}月` : ''}`} value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt万(fireIncomeAssetStats.annualIncome)}</span>} />
              <StatRow label="近一年被动收入" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: fireIncomeAssetStats.passiveIncome >= 0 ? C.green : C.red }}>{fmt万(fireIncomeAssetStats.passiveIncome)}</span>} />
              <StatRow
                label={(
                  <span>
                    个人净资产
                    {fireIncomeAssetStats.usdAssetsOriginal !== 0 && (
                      <span style={{ fontSize: 11, color: C.sub }}> · {fireIncomeAssetStats.usdAssetsIncluded ? usdRateSourceLabel : '未含美元'}</span>
                    )}
                  </span>
                )}
                value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt万(fireIncomeAssetStats.personalNetAssets)}</span>}
              />
            </FireDetailGroup>
            <FireDetailGroup title="阶段支出">
              <StatRow label="毕业日期" value={fireConfig.fireGraduationDate} />
              <StatRow label="毕业前 · 学＋班＋寄＋游" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt万(preFireStages[0].annualExpense)}/年</span>} />
              <StatRow label="毕业后至 FIRE · 班＋游" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt万(preFireStages[1].annualExpense)}/年{preFireExpenses.workSample !== 'intern' && <span style={{ color: C.sub }}> · 班样本不足</span>}</span>} />
              <StatRow label="FIRE 后场景" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.blue }}>{fireScenarioLabel}{fallbackFireExpenseTagKind !== fireSampleKind ? ` · 暂沿用${fallbackFireExpenseTagKind === 'school' ? '在校' : '旅行'}样本` : ''}</span>} />
              {fireIncludesTravel && <StatRow label="近两年旅行" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.purple }}>{annualizedTravelDays.toFixed(1)}天/年 · {(recentTravelRatio * 100).toFixed(1)}%</span>} />}
              <StatRow label="FIRE 后活年支出" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.blue }}>{fmt万(futureLifeAnnualExpense)}</span>} />
              <StatRow label="FIRE 后消费年支出" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.purple }}>{fmt万(futureConsumptionAnnualExpense)}</span>} />
              {fireMode === 'allocation' && <StatRow label="分配消费/心愿" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.purple }}>{fmt万(fire.requiredAnnualFlexibleSpending)}</span>} />}
              {fireMode === 'allocation' && <StatRow indent label="心愿 · 80%" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.purple }}>{fmt万(fire.requiredAnnualWishAllocation)}</span>} />}
              {fireMode === 'allocation' && <StatRow indent label="消费 · 20%" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.orange }}>{fmt万(fire.requiredAnnualConsumptionAllocation)}</span>} />}
              <StatRow label="未来固定支出" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.orange }}>{fmt万(postFireExpenses.monthlyFixedExpense * 12)}</span>} />
              {fireBaseScenario === 'independent' && <StatRow indent label="房租" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{postFireExpenses.monthlyRentExpense > 0 ? `${fmt万(postFireExpenses.monthlyRentExpense * 12)}/年` : '未设置'}</span>} />}
            </FireDetailGroup>
            <FireDetailGroup title="杭州未来情景">
              <StatRow label="BonCV 联动" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <select
                    value={config.fireProfileSource ?? 'boncv'}
                    onChange={(e) => setConfig({ fireProfileSource: e.target.value as 'boncv' | 'manual' })}
                    style={{ border: '1px solid #e0e0e0', borderRadius: 7, backgroundColor: '#fff', color: '#202124', fontSize: 12, fontWeight: 600, padding: '3px 5px', outline: 'none' }}
                  >
                    <option value="boncv">来自 BonCV</option>
                    <option value="manual">手工维护</option>
                  </select>
                  {(config.fireProfileSource ?? 'boncv') === 'boncv' && <button type="button" onClick={() => void refreshBonCv()} disabled={bonCvStatus === 'loading'} style={{ border: 0, borderRadius: 7, backgroundColor: '#eef4ff', color: C.blue, fontSize: 11, fontWeight: 600, padding: '4px 7px', cursor: 'pointer' }}>{bonCvStatus === 'loading' ? '同步中' : '刷新'}</button>}
                  <span style={{ fontSize: 11, color: bonCvStatus === 'connected' ? C.green : bonCvStatus === 'stale' ? C.orange : C.sub }}>
                    {bonCvStatus === 'connected' ? `已连接 · v${config.bonCvFireSnapshot?.revision ?? '—'} · ${bonCvSyncedAtLabel}` : bonCvStatus === 'stale' ? `旧数据 · ${bonCvSyncedAtLabel || '未同步'}` : bonCvStatus === 'unconfigured' ? '待配置' : ''}
                  </span>
                </span>
              )} />
              <StatRow label="测算状态" value={<span style={{ fontWeight: 500, color: C.blue }}>{fire.employmentStartYears > 0 ? `在读 · ${fireConfig.fireGraduationDate} 后就业` : '就业期 · 杭州工资'}</span>} />
              <StatRow label="人才身份" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <select
                    value={config.fireTalentDegree ?? 'master'}
                    onChange={(e) => setConfig({ fireTalentDegree: e.target.value as NonNullable<typeof config.fireTalentDegree> })}
                    disabled={(config.fireProfileSource ?? 'boncv') === 'boncv' && Boolean(config.bonCvFireSnapshot)}
                    style={{ border: '1px solid #e0e0e0', borderRadius: 7, backgroundColor: '#fff', color: '#202124', fontSize: 12, fontWeight: 600, padding: '3px 5px', outline: 'none' }}
                  >
                    {(Object.keys(FIRE_DEGREE_LABELS) as (keyof typeof FIRE_DEGREE_LABELS)[]).map((degree) => <option key={degree} value={degree}>{FIRE_DEGREE_LABELS[degree]}</option>)}
                  </select>
                  <select
                    value={config.fireHasHangzhouHome === true ? 'home' : 'no-home'}
                    onChange={(e) => setConfig({ fireHasHangzhouHome: e.target.value === 'home' })}
                    style={{ border: '1px solid #e0e0e0', borderRadius: 7, backgroundColor: '#fff', color: '#202124', fontSize: 12, fontWeight: 600, padding: '3px 5px', outline: 'none' }}
                  >
                    <option value="no-home">杭州无房</option>
                    <option value="home">杭州有房</option>
                  </select>
                </span>
              )} />
              <StatRow label="杭州户籍" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <select
                    aria-label="杭州户籍"
                    value={config.fireHasHangzhouHukou === true ? 'local' : 'non-local'}
                    onChange={(e) => setConfig({ fireHasHangzhouHukou: e.target.value === 'local' })}
                    style={{ border: '1px solid #e0e0e0', borderRadius: 7, backgroundColor: '#fff', color: '#202124', fontSize: 12, fontWeight: 600, padding: '3px 5px', outline: 'none' }}
                  >
                    <option value="non-local">非杭州户籍</option>
                    <option value="local">杭州户籍</option>
                  </select>
                  {config.fireHasHangzhouHukou === true && <input
                    type="date"
                    aria-label="杭州落户日期"
                    value={config.fireHangzhouHukouDate ?? ''}
                    onChange={(e) => setConfig({ fireHangzhouHukouDate: e.target.value })}
                    style={{ border: '1px solid #e0e0e0', borderRadius: 7, backgroundColor: '#fff', color: '#202124', fontSize: 12, padding: '3px 5px', outline: 'none' }}
                  />}
                </span>
              )} />
              <StatRow label="预期工资性收入" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={fireExpectedWageDraft ?? (expectedAnnualWageIncome / 10000).toFixed(2).replace(/\.00$/, '')}
                    onChange={(e) => updateFireExpectedWageWan(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => setFireExpectedWageDraft(null)}
                    aria-label="预期年工资性收入"
                    style={{ width: 64, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 700, color: eTalentIncomeThresholdMet ? C.green : C.orange, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  />
                  <span style={{ fontSize: 11, color: C.sub }}>w/年</span>
                  {fire.hasSalarySolution && <span style={{ fontSize: 11, color: expectedWageMargin >= 0 ? C.green : C.orange }}>· {expectedWageMargin >= 0 ? '高于' : '低于'}最低 {fmtW(Math.abs(expectedWageMargin))}</span>}
                </span>
              )} />
              <StatRow label="E 类人才预期" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: expectsETalent && eTalentIncomeThresholdMet ? C.green : C.sub }}>
                    <input type="checkbox" checked={expectsETalent} onChange={(e) => setConfig({ fireExpectedTalentClass: e.target.checked ? 'e' : 'none' })} />
                    <span style={{ fontWeight: 600 }}>{eTalentIncomeThresholdMet ? '收入达门槛' : '收入未达 50w'}</span>
                  </label>
                  {expectsETalent && (
                    <select
                      value={eTalentRecognitionYear}
                      onChange={(e) => setConfig({ fireETalentRecognitionYear: Number(e.target.value) })}
                      aria-label="E 类人才预计认定年度"
                      style={{ border: '1px solid #e0e0e0', borderRadius: 7, backgroundColor: '#fff', color: '#202124', fontSize: 12, fontWeight: 600, padding: '3px 5px', outline: 'none' }}
                    >
                      {[2, 3, 4, 5].map((year) => <option key={year} value={year}>第{year}就业年认定</option>)}
                    </select>
                  )}
                </span>
              )} />
              <StatRow label="人才补贴方案" value={(
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: config.fireTalentSubsidyEnabled === false ? C.sub : C.green }}>
                  <input type="checkbox" checked={config.fireTalentSubsidyEnabled !== false} onChange={(e) => setConfig({ fireTalentSubsidyEnabled: e.target.checked })} />
                  <span style={{ fontWeight: 600 }}>目标期计入 {fmt万(fire.talentSubsidyNominalTotal)}</span>
                </label>
              )} />
              <StatRow label="租金个税扣除" value={(
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: fire.annualRentTaxDeduction > 0 ? C.green : C.sub }}>
                  <input type="checkbox" checked={config.fireRentTaxDeductionEnabled !== false} onChange={(e) => setConfig({ fireRentTaxDeductionEnabled: e.target.checked })} />
                  <span style={{ fontWeight: 600 }}>{fire.annualRentTaxDeduction > 0 ? `${fmt万(fire.annualRentTaxDeduction)}/年` : '添加租房后生效'}</span>
                </label>
              )} />
              <StatRow label="计入公积金提取" value={(
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: fire.requiredAnnualHousingFundRentWithdrawal > 0 ? C.green : C.sub }}>
                  <input type="checkbox" checked={config.fireHousingFundRentWithdrawalEnabled !== false} onChange={(e) => setConfig({ fireHousingFundRentWithdrawalEnabled: e.target.checked })} />
                  <span style={{ fontWeight: 600 }}>{config.fireHousingFundRentWithdrawalEnabled === false ? '未计入' : '已计入'}</span>
                </label>
              )} />
              <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, backgroundColor: '#f8f9fa', color: C.sub, fontSize: 11, lineHeight: 1.55 }}>
                {config.fireGraduationDate && <>BonCV 毕业日期：{config.fireGraduationDate}，人才补贴从毕业后的首个就业年度开始计入。<br /></>}
                {expectsETalent && eTalentIncomeThresholdMet
                  ? `按保守口径：硕士生活补贴 3w；为保留 E 类租赁补贴资格，不叠加应届生租房补贴，预计第 ${eTalentRecognitionYear} 就业年起按 2500 元/月、最长 5 年计入。`
                  : '硕士生活补贴 3w；无房应届生实际租房时，再按 1w/年×3 测算租房补贴。'}
                <br />
                E 类收入通道还要求上一年度工资性收入及所在企业资质同时达标；50w offer 不等于必然认定。
              </div>
            </FireDetailGroup>
            <FireDetailGroup title="资产目标">
              <StatRow label={fireMode === 'allocation' ? '退休目标资产' : '目标资产'} value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt万(fire.fireTarget)}</span>} />
              <StatRow label="退休所需" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt万(fire.retirementTarget)}</span>} />
              <StatRow label="大额愿望" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.purple }}>{fmtW(fire.majorWishTotal)}</span>} />
              <StatRow label="理财总额" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.blue }}>{fmt万(totalInvest)}</span>} />
              <StatRow label="当前公积金余额" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="当前公积金余额"
                    value={fireHousingFundBalanceDraft ?? String(config.fireHousingFundBalance ?? 0)}
                    onChange={(e) => {
                      const next = sanitizeDecimalNumberInput(e.target.value);
                      if (next === null) return;
                      setFireHousingFundBalanceDraft(next);
                      if (next !== '' && Number.isFinite(Number(next))) setConfig({ fireHousingFundBalance: Math.max(Number(next), 0) });
                    }}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => setFireHousingFundBalanceDraft(null)}
                    style={{ width: 80, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 600, color: C.blue, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  />
                  <span style={{ fontSize: 11, color: C.sub }}>元</span>
                </span>
              )} />
              {fire.housingFundExitWithdrawal > 0 && <StatRow label="离职可提余额" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.green }}>{fmt万(fire.housingFundExitWithdrawal)} · 封存半年后</span>} />}
              <StatRow label="实际年化收益" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <button
                    type="button"
                    aria-pressed={fireUseAverageAnnualRate}
                    disabled={averageAnnualizedRate === null}
                    title={averageAnnualizedRate === null ? '暂无平均年化利率' : `记录 · 年：平均年化 ${(averageAnnualizedRate * 100).toFixed(1)}%`}
                    onClick={() => setConfig({ fireUseAverageAnnualRate: true })}
                    style={{ border: `1px solid ${fireUseAverageAnnualRate ? C.blue : '#e0e0e0'}`, borderRadius: 7, backgroundColor: fireUseAverageAnnualRate ? '#e8f0fe' : '#fff', color: averageAnnualizedRate === null ? C.sub : C.blue, fontSize: 12, fontWeight: 600, padding: '3px 5px', cursor: averageAnnualizedRate === null ? 'default' : 'pointer', opacity: averageAnnualizedRate === null ? 0.5 : 1, whiteSpace: 'nowrap' }}
                  >
                    使用平均
                  </button>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="FIRE 实际年化收益率"
                    value={(fire.investAnnualGrowthRate * 100).toFixed(1).replace(/\.0$/, '')}
                    onChange={(e) => {
                      const next = sanitizeDecimalNumberInput(e.target.value, { allowNegative: true });
                      if (next !== null) updateFireGrowthRate(next);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={(e) => e.target.select()}
                    style={{ width: 52, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 13, fontWeight: 600, color: C.blue, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  />
                  <span style={{ fontSize: 12, color: C.sub }}>%</span>
                </span>
              )} />
              <div style={{ marginTop: 4, color: C.sub, fontSize: 11, lineHeight: 1.5 }}>此处按扣除通胀后的实际收益测算，因为 FIRE 目标使用今日支出口径。</div>
              <StatRow label="到期现有资产" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: fire.projectedInvestmentGrowth >= 0 ? C.green : C.red }}>{fmt万(fire.projectedCurrentInvest)}</span>} />
              <StatRow label="目标年数" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt年(fire.targetYears)}年 · 最晚{fmt年(fire.retireYearsLeft)}年</span>} />
            </FireDetailGroup>
            <FireDetailGroup title="收入需求">
              <StatRow label="首年月存入" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.orange }}>{fmt万(fire.monthlyNeeded)}</span>} />
              <StatRow label="估算月结余" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: fire.monthlySurplus >= 0 ? C.green : C.red }}>{fmt万(fire.monthlySurplus)}</span>} />
              {fireMode === 'allocation' && <StatRow label="活后分配" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.purple }}>存 {Math.round(fire.postEssentialSavingsRate * 100)}% · 消费/心愿 {Math.round((1 - fire.postEssentialSavingsRate) * 100)}%</span>} />}
              <StatRow label={fireMode === 'allocation' ? '首年活+分配' : '首年支出+储蓄'} value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{fmt万(fire.requiredAnnualNetIncome)}</span>} />
              <StatRow label="首年工资到手" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.blue }}>{fmt万(fire.requiredAnnualSalaryNetIncome)}</span>} />
              {fire.talentSubsidyFutureValue > 0 && <StatRow label="人才补贴" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.green }}>合计 {fmt万(fire.talentSubsidyNominalTotal)} · 折到目标 {fmt万(fire.talentSubsidyFutureValue)}</span>} />}
              {fire.graduateLifeSubsidyTotal > 0 && <StatRow indent label="硕士生活补贴" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.green }}>{fmt万(fire.graduateLifeSubsidyTotal)}</span>} />}
              {fire.graduateRentSubsidyTotal > 0 && <StatRow indent label="应届租房补贴" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.green }}>{fmt万(fire.graduateRentSubsidyTotal)}</span>} />}
              {fire.eTalentRentSubsidyTotal > 0 && <StatRow indent label="E 类租赁补贴" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.green }}>{fmt万(fire.eTalentRentSubsidyTotal)}</span>} />}
              <StatRow label="杭州五险一金" value={<span style={{ fontWeight: 500, color: C.purple, fontVariantNumeric: 'tabular-nums' }}>{fmt万(fire.requiredAnnualSocialContribution)}</span>} />
              <StatRow indent label="社保" value={(
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontWeight: 500, color: C.purple }}>{fmt万(fire.requiredAnnualSocialInsurance)}</span>
                  <span style={{ marginLeft: 4, fontSize: 11, color: C.sub }}>· 个人 {(HANGZHOU_EMPLOYEE_SOCIAL_INSURANCE_RATE * 100).toFixed(1)}%</span>
                </span>
              )} />
              <StatRow indent label="公积金" value={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontWeight: 500, color: C.purple }}>{fmt万(fire.requiredAnnualHousingFund)}</span>
                  <span style={{ fontSize: 11, color: C.sub }}>· 个人</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="个人住房公积金比例"
                    value={fireHousingFundRateDraft ?? (fire.housingFundRate * 100).toFixed(1).replace(/\.0$/, '')}
                    onChange={(e) => {
                      const next = sanitizeDecimalNumberInput(e.target.value);
                      if (next !== null) updateFireHousingFundRate(next);
                    }}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => setFireHousingFundRateDraft(null)}
                    style={{ width: 38, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 600, color: C.purple, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  />
                  <span style={{ fontSize: 11, color: C.sub }}>%</span>
                </span>
              )} />
              {fire.requiredAnnualHousingFundRentWithdrawal > 0 && <StatRow indent label="首年公积金可提" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.green }}>{fmt万(fire.requiredAnnualHousingFundRentWithdrawal)}</span>} />}
              <StatRow label="预估个税" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.orange }}>{fmt万(fire.requiredAnnualTax)} · 分段最高{(fire.requiredMarginalTaxRate * 100).toFixed(0)}%</span>} />
              {fire.annualRentTaxDeduction > 0 && <StatRow indent label="住房租金扣除" value={<span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: C.green }}>{fmt万(fire.annualRentTaxDeduction)}/年 · 已减应纳税所得额</span>} />}
            </FireDetailGroup>
            <div style={{ paddingTop: 10, borderTop: '1px solid #f1f3f4' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#202124' }}>未来固定支出</span>
                <button onClick={addFutureFireExpense} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, border: 'none', backgroundColor: '#e8f0fe', color: C.blue, cursor: 'pointer', fontWeight: 600 }}>
                  + 添加
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {futureFireExpenses.length === 0 && (
                  <div style={{ fontSize: 12, color: C.sub, backgroundColor: '#f8f9fa', borderRadius: 8, padding: '8px 10px' }}>
                    暂无未来固定支出
                  </div>
                )}
                {futureFireExpenses.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, backgroundColor: item.isActive ? '#f8f9fa' : '#fff', border: `1px solid ${item.isActive ? '#e0e0e0' : '#f1f3f4'}`, borderRadius: 10, padding: '7px 8px' }}>
                    <button onClick={() => updateFutureFireExpense(item.id, 'isActive', !item.isActive)} style={{ flexShrink: 0, width: 16, height: 16, borderRadius: '50%', border: `2px solid ${item.isActive ? C.green : '#dadce0'}`, backgroundColor: item.isActive ? C.green : '#fff', cursor: 'pointer' }} />
                    <input
                      value={item.name}
                      onChange={(e) => updateFutureFireExpense(item.id, 'name', e.target.value)}
                      style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 600, color: item.isActive ? '#202124' : '#9aa0a6' }}
                    />
                    <span style={{ fontSize: 11, color: C.sub }}>¥</span>
                    <AmountInput
                      value={String(item.monthlyAmount || '')}
                      onFocus={(e) => e.target.select()}
                      onChange={(v) => updateFutureFireExpense(item.id, 'monthlyAmount', /^-?0\d/.test(v) ? (v.replace(/^(-?)0+/, '$1') || '0') : v)}
                      style={{ width: 72, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 600, color: C.orange, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                    />
                    <span style={{ fontSize: 11, color: C.sub }}>/月</span>
                    <button onClick={() => removeFutureFireExpense(item.id)} style={{ flexShrink: 0, background: 'none', border: 'none', color: '#dadce0', fontSize: 16, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ paddingTop: 14, marginTop: 14, borderTop: '1px solid #f1f3f4' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#202124' }}>大额愿望</span>
                <button onClick={addMajorFireWish} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, border: 'none', backgroundColor: '#f3e8ff', color: C.purple, cursor: 'pointer', fontWeight: 600 }}>
                  + 添加
                </button>
              </div>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 8 }}>
                金额单位为万元（w）；启用项会加入目标资产，并参与进度、月需存入和收入测算。
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {majorFireWishes.length === 0 && (
                  <div style={{ fontSize: 12, color: C.sub, backgroundColor: '#f8f9fa', borderRadius: 8, padding: '8px 10px' }}>
                    暂无大额愿望，例如买房、买车
                  </div>
                )}
                {majorFireWishes.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, backgroundColor: item.isActive ? '#faf5ff' : '#fff', border: `1px solid ${item.isActive ? '#e9d5ff' : '#f1f3f4'}`, borderRadius: 10, padding: '7px 8px' }}>
                    <button
                      aria-label={item.isActive ? '不计入大额愿望' : '计入大额愿望'}
                      onClick={() => updateMajorFireWish(item.id, 'isActive', !item.isActive)}
                      style={{ flexShrink: 0, width: 16, height: 16, borderRadius: '50%', border: `2px solid ${item.isActive ? C.purple : '#dadce0'}`, backgroundColor: item.isActive ? C.purple : '#fff', cursor: 'pointer' }}
                    />
                    <input
                      aria-label="愿望名称"
                      value={item.name}
                      onChange={(e) => updateMajorFireWish(item.id, 'name', e.target.value)}
                      style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 600, color: item.isActive ? '#202124' : '#9aa0a6' }}
                    />
                    <AmountInput
                      aria-label="愿望金额（万元）"
                      value={majorWishAmountDrafts[item.id] ?? (item.amount ? String(item.amount / 10000) : '')}
                      onChange={(v) => updateMajorFireWishWan(item.id, v)}
                      onBlur={() => finishMajorFireWishWanEdit(item.id)}
                      style={{ width: 82, border: 'none', borderBottom: '1px solid #dadce0', outline: 'none', backgroundColor: 'transparent', fontSize: 12, fontWeight: 600, color: C.purple, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                    />
                    <span style={{ fontSize: 11, color: C.sub }}>w</span>
                    <button aria-label="删除大额愿望" onClick={() => removeMajorFireWish(item.id)} style={{ flexShrink: 0, background: 'none', border: 'none', color: '#dadce0', fontSize: 16, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 收入管理 */}
      <Card title="收入管理" collapsible defaultCollapsed>
        <InternshipIncomeCard config={config} incomes={resolvedIncomeItems.filter(item => item.isInternPayroll)} today={today}
          holidayWarning={holidayWarning} unavailableYears={unavailableYears}
          settings={<>
            <InternshipSettings />
            {resolvedIncomeItems.some(item => item.isInternPayroll && !item.internshipPayroll) && <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: C.sub, padding: '4px 0' }}>收入金额与扣税</summary>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>{resolvedIncomeItems.filter(item => item.isInternPayroll && !item.internshipPayroll).map(renderIncomeEditor)}</div>
            </details>}
          </>}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {resolvedIncomeItems.filter(item => !item.isInternPayroll).map(renderIncomeEditor)}
        </div>
        {resolvedIncomeItems.filter((i) => i.isActive && !i.isInternPayroll).map((item) => {
          const daysToNext = daysUntilDate(item.resolvedPayDate, today);
          if (daysToNext < 0 || daysToNext > 3) return null;
          const payInfo = item.isInternPayroll && item.payrollCycle
            ? `最后一个工作日 ${dateLabel(item.payrollCycle.payDate)} 发薪，截止 ${dateLabel(item.payrollCycle.cutoffDate)}`
            : `每月 ${item.payDay === 0 ? '月底' : `${Number(item.resolvedPayDate.slice(8, 10))}号`}`;
          return (
            <div key={item.id} style={{ marginTop: 8, fontSize: 13, color: '#0d9488', backgroundColor: '#e6f4ea', border: '1px solid #81c995', borderRadius: 10, padding: '8px 12px' }}>
              💰 {item.name} {daysToNext === 0 ? '今天发薪' : `还有 ${daysToNext} 天发薪`}（{payInfo}，¥{formatCurrency(item.resolvedAmount)}）
            </div>
          );
        })}
        <button onClick={addIncomeItem} style={{ width: '100%', marginTop: 10, padding: '8px 0', fontSize: 13, color: C.blue, backgroundColor: '#e8f0fe', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>
          + 添加收入项
        </button>
      </Card>

      {/* 收支趋势 + 支出构成 */}
      <TrendCharts records={records} />

      <div style={{ textAlign: 'center', fontSize: 11, color: '#bdc1c6', padding: '8px 0 4px' }}>
        盘账助手 v{APP_VERSION}
      </div>
    </div>
  );
}
