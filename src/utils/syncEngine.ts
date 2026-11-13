import { BONCAL_CONFIG_FIELDS, BONCAL_CALENDAR_FIELDS } from '../boncal/state';
import { normalizeDayOverrides } from './internship';
import { getAccountStorage } from './accountCache';
import { apiFetch } from './authClient';
import { requestWithRetry } from './requestWithRetry';
import { normalizeBillDetailState, useBillDetailStore } from '../stores/billDetailStore';
import { normalizeConfirmedExpenses, useCalendarStore } from '../stores/calendarStore';
import { useConfigStore } from '../stores/configStore';
import { normalizeExpenseScopeOverrides, useExpenseScopeOverrideStore } from '../stores/expenseScopeOverrideStore';
import { normalizeMonthlyRecords, useMonthlyStore } from '../stores/monthlyStore';
import { DEFAULT_EXPENSE_SCOPE_HELP_TEXT, usePrefsStore } from '../stores/prefsStore';
import { usePossessionStore } from '../stores/possessionStore';
import { useSnapshotStore } from '../stores/snapshotStore';
import { useTripStore } from '../stores/tripStore';
import { useSyncStatus } from './syncStatus';
import { loadTickTickSyncStatus, syncTickTickTrips } from './tickTickSync';
import { normalizeOutlookCalendarState, normalizeOutlookTravelTitles, normalizeOutlookWishEvents } from './outlookCalendar';
import { mergeSyncValue, sameSyncValue } from './syncMerge';
import { detectAllTrips } from './trips';
import { reconcileTripWishes } from './wishes';
import { acceptBonCalRevision, bonCalRevision } from '../boncal/client';

const accountStorage = getAccountStorage();

const EXPENSE_SCOPE_SYNC_KEY = 'expense-scope-overrides';
const LEGACY_EXPENSE_SCOPE_SYNC_KEY = 'life-period-overrides';

type StoreEntry = {
  key: string;
  legacyKeys?: readonly string[];
  getState: () => unknown;
  setState: (partial: Record<string, unknown>) => void;
  subscribe: (listener: () => void) => () => void;
  serialize: () => Record<string, unknown>;
};

// 每个 store 只同步数据字段（与各自 persist 的 partialize 对齐）
const stores: StoreEntry[] = [
  {
    key: 'bill-details',
    getState: () => useBillDetailStore.getState(),
    setState: (p) => useBillDetailStore.setState(normalizeBillDetailState(p)),
    subscribe: (l) => useBillDetailStore.subscribe(l),
    serialize: () => {
      const s = useBillDetailStore.getState();
      return { tagStats: s.tagStats, aggregates: s.aggregates, expenseItems: s.expenseItems, incomeItems: s.incomeItems, hasOverride: s.hasOverride };
    },
  },
  {
    key: 'monthly-records',
    getState: () => useMonthlyStore.getState(),
    setState: (p) => useMonthlyStore.setState({
      ...p,
      records: normalizeMonthlyRecords(p.records),
    }),
    subscribe: (l) => useMonthlyStore.subscribe(l),
    serialize: () => {
      const s = useMonthlyStore.getState();
      return { records: s.records };
    },
  },
  {
    key: 'calendar-tags',
    getState: () => useCalendarStore.getState(),
    setState: (p) => useCalendarStore.setState({ ...p, ...normalizeOutlookCalendarState(p), outlookWishEvents: normalizeOutlookWishEvents(p.outlookWishEvents), dayOverrides: normalizeDayOverrides(p.dayOverrides), outlookTravelTitles: normalizeOutlookTravelTitles(p.outlookTravelTitles), confirmedExpenses: normalizeConfirmedExpenses(p.confirmedExpenses) }),
    subscribe: (l) => useCalendarStore.subscribe(l),
    serialize: () => {
      const s = useCalendarStore.getState();
      return { tagMap: s.tagMap, dayOverrides: s.dayOverrides, initializedFromRecords: s.initializedFromRecords, confirmedExpenses: s.confirmedExpenses,
        holidayDataByYear: s.holidayDataByYear, outlookApplied: s.outlookApplied, manualTagDates: s.manualTagDates, outlookTravelTitles: s.outlookTravelTitles, outlookWishEvents: s.outlookWishEvents };
    },
  },
  {
    key: 'trip-tags',
    getState: () => useTripStore.getState(),
    setState: (p) => useTripStore.setState({
      tripTags: p.tripTags && typeof p.tripTags === 'object' ? p.tripTags as Record<string, string> : {},
      tripNotes: p.tripNotes && typeof p.tripNotes === 'object' ? p.tripNotes as Record<string, string> : {},
      tripSplits: p.tripSplits && typeof p.tripSplits === 'object' ? p.tripSplits as Record<string, true> : {},
    }),
    subscribe: (l) => useTripStore.subscribe(l),
    serialize: () => {
      const s = useTripStore.getState();
      return { tripTags: s.tripTags, tripNotes: s.tripNotes, tripSplits: s.tripSplits };
    },
  },
  {
    key: 'account-snapshot',
    getState: () => useSnapshotStore.getState(),
    setState: (p) => useSnapshotStore.setState(p),
    subscribe: (l) => useSnapshotStore.subscribe(l),
    serialize: () => {
      const s = useSnapshotStore.getState();
      return { current: s.current, history: s.history };
    },
  },
  {
    key: 'app-config',
    getState: () => useConfigStore.getState(),
    setState: (p) => useConfigStore.setState(p),
    subscribe: (l) => useConfigStore.subscribe(l),
    serialize: () => ({ config: useConfigStore.getState().config }),
  },
  {
    key: EXPENSE_SCOPE_SYNC_KEY,
    legacyKeys: [LEGACY_EXPENSE_SCOPE_SYNC_KEY],
    getState: () => useExpenseScopeOverrideStore.getState(),
    setState: (p) => {
      useExpenseScopeOverrideStore.setState({
        overrides: normalizeExpenseScopeOverrides(p),
      } as Parameters<typeof useExpenseScopeOverrideStore.setState>[0]);
    },
    subscribe: (l) => useExpenseScopeOverrideStore.subscribe(l),
    serialize: () => ({ overrides: useExpenseScopeOverrideStore.getState().overrides }),
  },
  {
    key: 'user-prefs',
    getState: () => usePrefsStore.getState(),
    setState: (p) => {
      const legacyHelpKey = 'life' + 'PeriodHelpText';
      const rawHelpText = p.expenseScopeHelpText ?? p[legacyHelpKey];
      const persistedHelpText = typeof rawHelpText === 'string' ? rawHelpText : undefined;
      const expenseScopeHelpText = persistedHelpText && /[短长]/.test(persistedHelpText)
        ? DEFAULT_EXPENSE_SCOPE_HELP_TEXT
        : persistedHelpText;
      const { [legacyHelpKey]: _legacyHelp, ...rest } = p;
      void _legacyHelp;
      usePrefsStore.setState({
        ...rest,
        expenseScopeHelpText: expenseScopeHelpText ?? usePrefsStore.getState().expenseScopeHelpText,
      });
    },
    subscribe: (l) => usePrefsStore.subscribe(l),
    serialize: () => {
      const s = usePrefsStore.getState();
      return {
        tagOrder: s.tagOrder,
        accountOrder: s.accountOrder,
        weekdayTags: s.weekdayTags,
        showPayrollCutoffMarkers: s.showPayrollCutoffMarkers,
        reviewableCategories: s.reviewableCategories,
        expenseScopeHelpText: s.expenseScopeHelpText,
        revealConsumptionWishUsd: s.revealConsumptionWishUsd,
        investmentHoldingsView: s.investmentHoldingsView,
      };
    },
  },
  {
    key: 'possessions',
    getState: () => usePossessionStore.getState(),
    setState: (p) => {
      const current = usePossessionStore.getState();
      usePossessionStore.setState({
        items: Array.isArray(p.items) ? p.items as typeof current.items : current.items,
        ignoredBillItemIds: Array.isArray(p.ignoredBillItemIds)
          ? p.ignoredBillItemIds.map(String)
          : current.ignoredBillItemIds,
        tagCategory: p.tagCategory && typeof p.tagCategory === 'object'
          ? p.tagCategory as typeof current.tagCategory
          : current.tagCategory,
        categoryConfig: p.categoryConfig && typeof p.categoryConfig === 'object'
          ? p.categoryConfig as typeof current.categoryConfig
          : current.categoryConfig,
      });
    },
    subscribe: (l) => usePossessionStore.subscribe(l),
    serialize: () => {
      const s = usePossessionStore.getState();
      return {
        items: s.items,
        ignoredBillItemIds: s.ignoredBillItemIds,
        tagCategory: s.tagCategory,
        categoryConfig: s.categoryConfig,
      };
    },
  },
];

async function fetchServer(): Promise<Record<string, unknown> | null> {
  return requestWithRetry(async (signal) => {
    // This read is the baseline for merging and uploading local edits. Always
    // obtain the latest cloud state, while allowing the browser to store it.
    const res = await apiFetch('/api/sync', { method: 'GET', cache: 'reload', signal });
    if (res.status === 204) return null;
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('同步数据无效');
    acceptBonCalRevision((data as Record<string, unknown>).bonCalRevision);
    return data as Record<string, unknown>;
  }, {
    retry: true,
    timeoutMessage: '账单加载超时，请重试',
    networkMessage: '网络连接失败，请重试',
  });
}

function serializeAllStores() {
  return Object.fromEntries(stores.map((store) => [store.key, store.serialize()]));
}

async function uploadStores(selectedStores: readonly StoreEntry[]) {
  const body: Record<string, unknown> = {};
  for (const s of selectedStores) body[s.key] = s.serialize();
  if (bonCalRevision()) body.bonCalRevision = bonCalRevision();
  const res = await requestWithRetry((signal) => apiFetch('/api/sync', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  }), {
    timeoutMessage: '账单保存超时，请重试',
    networkMessage: '网络连接失败，请重试',
  });
  if (!res.ok) throw new Error(res.status === 409 ? '日历已更新，当前编辑已保留，请刷新后保存' : `upload HTTP ${res.status}`);
  const saved = await res.json() as { bonCalRevision?: string; calendar?: Record<string, unknown>; config?: Record<string, unknown>; tripSettings?: Record<string, unknown> };
  for (const s of selectedStores) {
    if (sameSyncValue(s.serialize(), body[s.key])) pending.delete(s.key);
    else pending.set(s.key, body[s.key] as Record<string, unknown>);
  }
  if (saved.calendar && saved.bonCalRevision) applyBonCalResult({ revision: saved.bonCalRevision,
    calendar: saved.calendar, config: saved.config, tripSettings: saved.tripSettings });
  savePending();
}

/** Apply a bonCal response without treating cloud updates as user edits. */
export function applyBonCalResult(result: { revision: string; calendar: Record<string, unknown>; config?: Record<string, unknown>; tripSettings?: Record<string, unknown> }) {
  const calendarBusiness = Object.fromEntries(Object.entries(stores.find(store => store.key === 'calendar-tags')!.serialize())
    .filter(([key]) => !BONCAL_CALENDAR_FIELDS.includes(key as never)));
  const values: Record<string, Record<string, unknown>> = { 'calendar-tags': { ...calendarBusiness, ...result.calendar } };
  if (result.tripSettings) values['trip-tags'] = result.tripSettings;
  if (result.config) values['app-config'] = { config: { ...Object.fromEntries(Object.entries(useConfigStore.getState().config).filter(([key]) => !BONCAL_CONFIG_FIELDS.includes(key as never))), ...result.config } };
  syncingFromServer = true;
  try {
    for (const store of stores) {
      const value = values[store.key];
      if (!value) continue;
      const merged = pending.has(store.key) ? mergeSyncValue(pending.get(store.key), store.serialize(), value) : value;
      store.setState(merged as Record<string, unknown>);
      if (sameSyncValue(store.serialize(), value)) pending.delete(store.key);
      else pending.set(store.key, value);
    }
    acceptBonCalRevision(result.revision);
  } finally { syncingFromServer = false; }
  syncTripWishes(); savePending();
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const CACHE_KEY = 'bonbills-sync-cache-v1';
const PENDING_KEY = 'bonbills-sync-pending-v1';
let cacheOwner = '';
let syncingFromServer = false;
let syncPauseDepth = 0;
let activeSession = false;
let initialSync: Promise<void> | null = null;
let subscriptionsStarted = false;
let uploadInFlight: Promise<void> | null = null;
let uploadQueued = false;
let tickTickSyncQueued = false;
// Keep the baseline of unsaved edits, including across reloads and failed fetches.
const pending = new Map<string, Record<string, unknown>>();

function savePending() {
  try {
    if (pending.size) accountStorage.setItem(PENDING_KEY, JSON.stringify({ owner: cacheOwner, stores: Object.fromEntries(pending) }));
    else accountStorage.removeItem(PENDING_KEY);
  } catch { /* In-memory edits still participate in the next retry. */ }
}

export function hasSyncCache(owner: string) {
  try {
    if (!owner || accountStorage.getItem(CACHE_KEY) !== owner) return false;
    return stores.every((store) => {
      const raw = accountStorage.getItem(store.key);
      if (!raw) return false;
      const value = JSON.parse(raw);
      return value?.state && typeof value.state === 'object' && !Array.isArray(value.state)
        && Object.entries(store.serialize()).every(([key, field]) => field === undefined || key in value.state);
    });
  } catch { return false; }
}

function rememberCache() {
  try { if (cacheOwner) accountStorage.setItem(CACHE_KEY, cacheOwner); } catch { /* Cache is optional. */ }
}

function setSaved(message = '') {
  useSyncStatus.getState().setStatus('saved', message);
  setTimeout(() => {
    if (useSyncStatus.getState().state === 'saved') useSyncStatus.getState().setStatus('idle');
  }, 2000);
}

export async function createManualBackup() {
  if (!activeSession) throw new Error('请先登录');
  const res = await apiFetch('/api/sync-monthly-backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serializeAllStores()),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
}

export async function triggerUpload() {
  if (!activeSession) {
    // Import confirmation awaits this inside runWithSyncPaused; startup itself
    // must wait for that transaction to finish. Its edits are already journaled.
    if (syncPauseDepth > 0) return;
    if (!initialSync) return;
    try { await initialSync; } catch { return; }
  }
  if (!pending.size) return;
  uploadQueued = true;
  if (uploadInFlight) return uploadInFlight;
  const status = useSyncStatus.getState();
  uploadInFlight = (async () => {
    try {
      status.setStatus('saving');
      while (uploadQueued && activeSession) {
        uploadQueued = false;
        await uploadStores(stores.filter((store) => pending.has(store.key)));
        if (pending.size) uploadQueued = true;
      }
      if (tickTickSyncQueued && activeSession) {
        tickTickSyncQueued = false;
        void syncTickTickTrips();
      }
      setSaved();
    } catch (e) {
      status.setStatus('error', e instanceof Error ? e.message : String(e));
    } finally {
      uploadInFlight = null;
      if (uploadQueued) void triggerUpload();
    }
  })();
  return uploadInFlight;
}

export function isSyncPaused() { return !activeSession || syncingFromServer || syncPauseDepth > 0; }

export async function runWithSyncPaused<T>(run: () => Promise<T>): Promise<T> {
  syncPauseDepth += 1;
  try {
    return await run();
  } finally {
    syncPauseDepth = Math.max(0, syncPauseDepth - 1);
    if (activeSession && syncPauseDepth === 0) syncTripWishes();
  }
}

function syncTripWishes() {
  if (syncingFromServer || syncPauseDepth > 0) return;
  const { config, setConfig } = useConfigStore.getState();
  const { tagMap, outlookTravelTitles } = useCalendarStore.getState();
  const { tripTags, tripSplits } = useTripStore.getState();
  const previous = config.wishes ?? [];
  const wishes = reconcileTripWishes(previous, detectAllTrips(tagMap, tripSplits), tripTags,
    outlookTravelTitles, config.dismissedTripWishStarts);
  if (wishes !== previous) setConfig({ wishes });
}

function startSubscriptions() {
  if (subscriptionsStarted) return;
  subscriptionsStarted = true;
  const debouncedUpload = debounce(() => {
    if (syncingFromServer) return;
    void triggerUpload();
  }, 2000);

  for (const s of stores) {
    let previous = s.serialize();
    s.subscribe(() => {
      const next = s.serialize();
      const before = previous;
      previous = next;
      if (syncingFromServer || sameSyncValue(before, next)) return;
      if (!pending.has(s.key)) pending.set(s.key, before);
      savePending();
      if (activeSession && syncPauseDepth === 0) debouncedUpload();
    });
  }

  const readTripSignature = () => JSON.stringify({
    tagMap: useCalendarStore.getState().tagMap,
    outlookTravelTitles: useCalendarStore.getState().outlookTravelTitles,
    tripTags: useTripStore.getState().tripTags,
    tripNotes: useTripStore.getState().tripNotes,
    tripSplits: useTripStore.getState().tripSplits,
    wishes: (useConfigStore.getState().config.wishes ?? []).map(({ id, name, deadline, linkedTripStartDate, isActive }) =>
      ({ id, name, deadline, linkedTripStartDate, isActive })),
  });
  let tripSignature = readTripSignature();
  const markTickTickSyncNeeded = () => {
    if (syncingFromServer || syncPauseDepth > 0) return;
    const nextSignature = readTripSignature();
    if (nextSignature === tripSignature) return;
    tripSignature = nextSignature;
    tickTickSyncQueued = true;
  };
  useCalendarStore.subscribe(markTickTickSyncNeeded);
  useTripStore.subscribe(markTickTickSyncNeeded);
  useConfigStore.subscribe(markTickTickSyncNeeded);

  // 云端的日历、标签、心愿全部合并后再补建；日常本地编辑则即时关联。
  const updateTripWishes = () => { if (activeSession) syncTripWishes(); };
  useCalendarStore.subscribe(updateTripWishes);
  useTripStore.subscribe(updateTripWishes);
  useConfigStore.subscribe(updateTripWishes);
}

async function startTickTickSync() {
  const connected = await loadTickTickSyncStatus();
  if (connected) await syncTickTickTrips();
}

export function initSync(owner?: string): Promise<void> {
  if (initialSync) return initialSync;
  if (activeSession) return Promise.resolve();
  if (owner) cacheOwner = owner;
  if (!subscriptionsStarted) {
    try {
      const saved = JSON.parse(accountStorage.getItem(PENDING_KEY) || 'null');
      if (saved?.owner === cacheOwner && saved.stores && typeof saved.stores === 'object') {
        for (const store of stores) {
          const base = saved.stores[store.key];
          if (base && typeof base === 'object' && !Array.isArray(base)) pending.set(store.key, base);
        }
      }
    } catch { /* Invalid metadata must not prevent a fresh cloud sync. */ }
  }
  startSubscriptions();
  initialSync = refreshFromServer().finally(() => { initialSync = null; });
  return initialSync;
}

async function refreshFromServer() {
  const status = useSyncStatus.getState();
  try {
    status.setStatus('loading');
    const serverData = await fetchServer();
    // Let onBlur saves and import transactions finish before replacing store values.
    while (syncPauseDepth > 0 || (typeof document !== 'undefined'
      && (document.activeElement?.matches('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]')
        || document.querySelector('.finance-import-preview-shell, .alipay-correction-preview')))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    syncingFromServer = true;
    if (serverData) {
      for (const s of stores) {
        const legacyVal = s.legacyKeys?.map((key) => serverData[key]).find((val) => val && typeof val === 'object');
        const val = serverData[s.key] ?? legacyVal;
        if (val && typeof val === 'object') {
          const next = pending.has(s.key)
            ? mergeSyncValue(pending.get(s.key), s.serialize(), val)
            : val;
          s.setState(next as Record<string, unknown>);
          if (!sameSyncValue(s.serialize(), val)) pending.set(s.key, val as Record<string, unknown>);
          else pending.delete(s.key);
        } else {
          s.setState(s.serialize());
          pending.set(s.key, {});
        }
      }
    } else {
      for (const s of stores) {
        s.setState(s.serialize());
        pending.set(s.key, {});
      }
    }
    syncingFromServer = false;
    syncTripWishes();
    savePending();
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    useMonthlyStore.getState().ensureInvestmentMonth(yearMonth);
    useMonthlyStore.getState().ensureInvestmentImportCutoff();
    status.markRefreshed();
    // Subscribe before fetching and keep tracking while uploads are in flight.
    while (pending.size) await uploadStores(stores.filter((s) => pending.has(s.key)));
    activeSession = true;
    rememberCache();
    status.setReady(true);
    setSaved();
    void startTickTickSync();
  } catch (e) {
    activeSession = false;
    syncingFromServer = false;
    const msg = e instanceof Error ? e.message : String(e);
    status.setStatus('error', msg);
    throw new Error(/超时|网络连接失败/.test(msg) ? msg : '账单加载失败，请重试');
  }
}

export async function retrySync() {
  if (activeSession) await triggerUpload();
  else await initSync();
}
