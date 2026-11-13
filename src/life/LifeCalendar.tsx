import InstallApp from '../components/InstallApp';
import { makeupSummary, syncMakeupEntries } from '../utils/lifeMakeup';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { resolveSkinRecord } from '../utils/lifeSkinProgress';
import { skinLocalPlanValues, skinPlanValues, skinSeason } from '../utils/lifeSkin';
import { DEFAULT_SKIN_SETTINGS } from '../utils/lifeSkin';
import LifeSkinSettings from './LifeSkinSettings';
import { calendarCells, DEFAULT_CYCLE, entrySummary, LIFE_LABELS, type LifeView, type LifeYear, type TrainingRecord } from '../utils/bonLife';
import { CYCLE_GUIDANCE, cycleDay, cyclePhaseRanges, estimateCycle, visibleCycleDay } from '../utils/lifeCycle';
import { requestSession } from '../utils/authClient';
import { LifeError, lifeRequest, readDraft, type LifeDraft } from './client';
import LifeEditor from './LifeEditor';
import LifeConnection from './LifeConnection';
import LifeCycleSettings from './LifeCycleSettings';
import LifePlanDetails from './LifePlanDetails';
import { useOrchestrate } from './useOrchestrate';
import LifeOrchestrator from './LifeOrchestrator';
import { useLifeTraining } from './useLifeTraining';
import { DEFAULT_TRAINING_SETTINGS, monthlyTrainingPlan, plannedTraining, rollingTrainingPlan, trainingIdentity, trainingLibrary } from '../utils/lifeTraining';
import LifeTrainingSettings from './LifeTrainingSettings';
import { symptomHistory } from '../utils/lifeSymptoms';
import LifeSymptomHistory from './LifeSymptomHistory';
import { symptomColor } from './symptomColor';
import { calendarStripSegments, lifeCalendarStripItems, type CalendarStripItem } from './calendarStrips';

const LifeBodyTrends = lazy(() => import('./LifeBodyTrends'));
const LifeDoneList = lazy(() => import('./LifeDoneList'));

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
function initialDate(draft: LifeDraft | null) {
  const query = new URLSearchParams(window.location.search);
  const date = draft?.date || today();
  const requestedYear = Number(query.get('year'));
  const requestedMonth = Number(query.get('month'));
  return {
    year: !draft && Number.isInteger(requestedYear) && requestedYear >= 1900 && requestedYear <= 2200 ? requestedYear : Number(date.slice(0, 4)),
    month: !draft && requestedMonth >= 1 && requestedMonth <= 12 && Number.isInteger(requestedMonth) ? requestedMonth : Number(date.slice(5, 7)),
    kind: (draft?.kind || (Object.keys(LIFE_LABELS).includes(query.get('kind') || '') ? query.get('kind') : 'skin')) as LifeView,
  };
}

export default function LifeCalendar({ owner, onExpired }: { owner: string; onExpired: () => void }) {
  const orche = useOrchestrate(onExpired);
  const [draft, setDraft] = useState<LifeDraft | null>(() => readDraft(owner));
  const [selection, setSelection] = useState(() => initialDate(draft));
  const { year, month, kind } = selection;
  const [data, setData] = useState<LifeYear | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [periodError, setPeriodError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState(false);
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const [recordsControlsTarget, setRecordsControlsTarget] = useState<HTMLDivElement | null>(null);
  const [skinSettingsOpen, setSkinSettingsOpen] = useState(false);
  const [cycleSettings, setCycleSettings] = useState(false);
  const [trainingSettingsOpen, setTrainingSettingsOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [saved, setSaved] = useState(false);
  const [now, setNow] = useState(today);
  const generation = useRef(0);
  const activeSync = useRef<AbortController | null>(null);
  const current = data?.year === year ? data : null;
  const skinEntries = useMemo(() => ({ ...current?.skinHistory, ...current?.entries }), [current]);
  const symptomEntries = useMemo(() => ({ ...current?.symptomHistory, ...current?.entries }), [current]);
  const symptoms = useMemo(() => kind === 'eyes' || kind === 'discomfort' ? symptomHistory(kind, symptomEntries) : [], [kind, symptomEntries]);
  const skinSettings = current?.skinSettings ?? DEFAULT_SKIN_SETTINGS;
  const periodSet = new Set(current?.periodDays ?? []);
  const cycle = current?.cycle ?? DEFAULT_CYCLE;
  const cells = calendarCells(year, month);
  const cycleEstimate = useMemo(() => ({ ...cycle, ...estimateCycle(cycle, current?.periodDays ?? [], now) }), [cycle, current?.periodDays, now]);
  const trainingSource = useLifeTraining(year, !loading && !syncing && Boolean(current)
    && (kind === 'training' || draft?.kind === 'training' || cycleSettings), onExpired);
  const library = useMemo(() => trainingLibrary(trainingSource.current?.tasks ?? [], trainingSource.current?.settings), [trainingSource.current]);
  const hasTrainingSource = Boolean(trainingSource.current && (trainingSource.current.tasks.length || trainingSource.current.settings?.projects.length));
  const rolling = useMemo(() => hasTrainingSource ? rollingTrainingPlan(year, month, now, trainingSource.current!,
    cycle, current?.periodDays ?? [], current?.entries ?? {}) : null, [hasTrainingSource, year, month, now, trainingSource.current, cycle, current]);
  const trainingPlan = kind === 'training' ? rolling?.plans ?? monthlyTrainingPlan(year, month, now,
    undefined, cycle, current?.periodDays ?? [], current?.entries ?? {}) : new Map<string, TrainingRecord>();
  const stripItems = useMemo(() => {
    const result = new Map<string, CalendarStripItem[]>();
    const trainingNames = new Map(library.map((task) => [trainingIdentity(task), task.name]));
    for (const date of cells) {
      if (!date) continue;
      const entry = current?.entries[`${kind}:${date}`];
      const items = kind === 'done' ? [] : lifeCalendarStripItems(kind, entry, trainingPlan.get(date), trainingNames);
      if (items.length) result.set(date, items);
    }
    return result;
  }, [cells, current, kind, library, trainingPlan]);
  const strips = useMemo(() => calendarStripSegments(cells, stripItems), [cells, stripItems]);
  const futurePlanCount = [...trainingPlan].filter(([date, record]) => date >= now && record.plan).length;
  const hasCycle = cells.some((date) => date && cycleDay(date, cycle, current?.periodDays ?? []));
  const todayOverview = useMemo(() => {
    const periods = [...new Set([...(trainingSource.current?.periodDays ?? []), ...(current?.periodDays ?? [])])];
    const entries = { ...trainingSource.current?.entries, ...current?.entries };
    const training = hasTrainingSource ? rollingTrainingPlan(Number(now.slice(0, 4)), Number(now.slice(5, 7)), now,
      trainingSource.current!, cycle, periods, entries).plans.get(now)
      : plannedTraining(now, now, undefined, cycle, periods, entries[`training:${now}`]?.training);
    return { phase: cycleDay(now, cycle, periods), training };
  }, [now, trainingSource.current, current, hasTrainingSource, cycle]);
  const todayAdvice = todayOverview.phase ? CYCLE_GUIDANCE[todayOverview.phase.phase] : null;
  const todayLoading = loading || syncing || trainingSource.busy;

  useEffect(() => {
    const updateDay = () => setNow(today());
    const timer = window.setInterval(updateDay, 60_000);
    window.addEventListener('focus', updateDay);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', updateDay); };
  }, []);

  const syncPeriods = useCallback(async (selectedYear: number, token: number) => {
    activeSync.current?.abort();
    const controller = new AbortController();
    activeSync.current = controller;
    setSyncing(true); setPeriodError('');
    try {
      const result = await lifeRequest<Pick<LifeYear, 'connected'> & Partial<Pick<LifeYear, 'periodDays' | 'syncedAt'>> & { swimmingError?: string }>(
        'POST', { action: 'sync-periods', year: selectedYear }, controller.signal);
      if (token === generation.current && !controller.signal.aborted) {
        setData((previous) => previous?.year === selectedYear ? { ...previous, ...result } : previous);
        setPeriodError(result.swimmingError ?? '');
      }
    } catch (cause) {
      if (controller.signal.aborted || token !== generation.current) return;
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      else setPeriodError(cause instanceof Error ? cause.message : '经期同步失败，请重试');
    } finally { if (token === generation.current && activeSync.current === controller) setSyncing(false); }
  }, [onExpired]);

  useEffect(() => {
    const token = ++generation.current;
    const controller = new AbortController();
    activeSync.current?.abort();
    setLoading(true); setError(''); setPeriodError(''); setSyncing(false); setSaved(false);
    void lifeRequest<LifeYear>('GET', { year }, controller.signal).then((result) => {
      if (token !== generation.current || controller.signal.aborted) return;
      setData(result); setLoading(false);
      if (result.connected) void syncPeriods(year, token);
    }).catch((cause) => {
      if (controller.signal.aborted || token !== generation.current) return;
      setLoading(false);
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      else setError(cause instanceof Error ? cause.message : '读取失败，请重试');
    });
    return () => { controller.abort(); activeSync.current?.abort(); };
  }, [year, retry, onExpired, syncPeriods]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('year', String(year)); url.searchParams.set('month', String(month)); url.searchParams.set('kind', kind);
    window.history.replaceState(window.history.state, '', url);
  }, [year, month, kind]);

  function shiftMonth(delta: number) {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    if (next.getUTCFullYear() < 1900 || next.getUTCFullYear() > 2200) return;
    setSelection((previous) => ({ ...previous, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 }));
  }
  function openEntry(entry: LifeDraft) {
    setDraft(readDraft(owner, entry) ?? entry);
  }
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await requestSession({ method: 'DELETE' });
      try { localStorage.setItem('bonlife-logout-at', String(Date.now())); } catch { /* Current page still logs out. */ }
      onExpired();
    } catch { setError('退出失败，请重试'); }
    finally { setLoggingOut(false); }
  }

  return <main className="life-shell">
    <header className="life-header"><div className="life-header-brand"><h1><span className="life-brand-dot" />BonLog</h1>
      <div className="life-orche-actions">
        <button disabled={orche.replanning} title={orche.replanMessage || undefined} onClick={() => void orche.triggerReplan()}>{orche.replanning ? '提交中…' : 'Orche'}</button>
        <button className="life-plan-trigger" aria-expanded={orche.detailsOpen} aria-controls="life-orche-details" onClick={orche.toggleDetails}>have orched</button>
      </div></div>
      <div className="life-header-actions"><InstallApp app="log" /><button aria-haspopup="dialog" aria-controls="life-orchestrator" onClick={() => setOrchestratorOpen(true)}>Orchestrator</button>
        <button onClick={() => void logout()} disabled={loggingOut}>{loggingOut ? '退出中…' : '退出'}</button></div></header>
    <span className="sr-only" role="status">{orche.replanning ? '正在提交 Orchestrate…' : orche.replanMessage}</span>
    {orche.replanError && <p className="life-error" role="alert">{orche.replanError}</p>}
    {orche.detailsOpen && <section id="life-orche-details" aria-label="当前排期" aria-busy={orche.detailsLoading}>
      {orche.detailsLoading && !orche.planDetails ? <p className="life-empty-state" role="status">读取中…</p>
        : orche.detailsError ? <p className="life-error" role="alert">{orche.detailsError}</p>
          : orche.planDetails ? <LifePlanDetails plan={orche.planDetails} /> : <p className="life-empty-state">今日暂无排期记录</p>}
    </section>}
    <div className="life-toolbar">
      <nav className="life-tabs" aria-label="状态日历">{(['skin', 'eyes', 'discomfort', 'mood', 'training', 'done'] as const).map((value) => <button key={value}
        aria-pressed={(kind === 'body' ? 'training' : kind) === value} onClick={() => { setSelection((previous) => ({ ...previous, kind: value,
          ...(value === 'done' && previous.kind !== 'done' ? { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) } : {}) })); setSaved(false); }}>{LIFE_LABELS[value]}</button>)}</nav>
      {kind !== 'done' && kind !== 'body' && <div className="life-date-controls">
        <button className="life-arrow" aria-label="上个月" disabled={year === 1900 && month === 1} onClick={() => shiftMonth(-1)}>‹</button>
        <select aria-label="年份" value={year} onChange={(event) => setSelection((previous) => ({ ...previous, year: Number(event.target.value) }))}>
          {Array.from({ length: 301 }, (_, i) => 2200 - i).map((value) => <option key={value} value={value}>{value} 年</option>)}
        </select>
        <select aria-label="月份" value={month} onChange={(event) => setSelection((previous) => ({ ...previous, month: Number(event.target.value) }))}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((value) => <option key={value} value={value}>{value} 月</option>)}
        </select>
        <button className="life-arrow" aria-label="下个月" disabled={year === 2200 && month === 12} onClick={() => shiftMonth(1)}>›</button>
        <button className="life-today" onClick={() => setSelection((previous) => ({ ...previous, year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) }))}>今天</button>
      </div>}
    </div>
    {kind === 'skin' && <div className="life-skin-toolbar"><span>皮肤状态 · 日常护理</span><button disabled={loading || !current || Boolean(error)} onClick={() => setSkinSettingsOpen(true)}>护理方案与在用清单 ↗</button></div>}
    {(kind === 'eyes' || kind === 'discomfort') && !loading && current && !error && <LifeSymptomHistory key={kind} kind={kind} history={symptoms} onEdit={(date) => {
      setSelection((previous) => ({ ...previous, year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) }));
      openEntry({ date, kind, ...symptomEntries[`${kind}:${date}`], mutationId: crypto.randomUUID() });
    }} />}
    {kind === 'training' && <div className="life-training-heading"><div><h2>{month} 月运动计划</h2>
      <p role="status">{loading || trainingSource.busy ? '安排中…' : rolling ? `近 7 天 · 已完成 ${rolling.coverage.filter((item) => item.completed).length} / ${rolling.coverage.length} 项` : !hasCycle ? '待设置经期' : futurePlanCount ? `后续 ${futurePlanCount} 天已安排 · 按体感调整` : '历史运动'}</p></div>
      <div className="life-training-actions"><button onClick={() => { setSelection((previous) => ({ ...previous, kind: 'body' })); setSaved(false); }}>身体数据 <span aria-hidden="true">›</span></button></div>
    </div>}
    {kind === 'body' && <div className="life-training-heading"><h2>身体数据</h2>
      <button onClick={() => { setSelection((previous) => ({ ...previous, kind: 'training' })); setSaved(false); }}><span aria-hidden="true">‹ </span>返回运动</button>
    </div>}
    {kind === 'training' && <section className="life-training-source" aria-label="TickTick 运动计划" aria-busy={trainingSource.busy}>
      <div className="life-done-toolbar"><span role="status">{trainingSource.busy ? '读取运动计划…' : trainingSource.current?.syncedAt ? 'TickTick · 已同步' : 'TickTick · 尚未同步'}</span>
        <div className="life-training-actions"><button disabled={trainingSource.busy || !trainingSource.current} onClick={() => setTrainingSettingsOpen(true)}>管理项目</button>
          <button disabled={trainingSource.busy} onClick={() => void trainingSource.refresh(true)}>同步运动</button></div></div>
      {rolling && <details className="life-training-details"><summary>运动项目</summary><p className="life-training-schedule">{rolling.coverage.map(({ task, completed, lastCompleted }) => <span key={task.id}>{task.name}{task.tags?.length ? <small className="life-training-tags">{task.tags.join(' · ')}</small> : null} · {completed ? '已完成' : '待完成'}{lastCompleted ? ` · 上次 ${lastCompleted.slice(5).replace('-', '.')}` : ''}</span>)}</p></details>}
      {trainingSource.error && <p className="life-error" role="alert">{trainingSource.error}</p>}
      {!trainingSource.busy && trainingSource.current && !hasTrainingSource && <p className="life-empty-state">{trainingSource.current.connected ? '未找到运动待办' : <>TickTick 未连接 · <a href="https://bill.bonbills.cn/calendar" target="_blank" rel="noreferrer">连接 TickTick ↗</a></>}</p>}
    </section>}
    {kind === 'training' && <details className="life-phase-guide"><summary>
      <span className="life-guide-heading">运动与饮食 <span>今天 {now.slice(5).replace('-', '.')}{!todayLoading && todayOverview.phase ? ` · ${todayOverview.phase.estimated ? '预计·' : ''}${todayAdvice!.label}` : ''}</span></span>
      <span className="life-guide-toggle">四阶段 <span className="life-guide-chevron" aria-hidden="true">⌄</span></span>
      <span className="life-today-guidance">
        <span><span className="life-today-label">今日运动{!todayLoading && todayOverview.training?.completed ? ' · 已完成' : ''}</span>
          <span>{todayLoading ? '安排中…' : error ? '暂不可用' : todayOverview.training?.plan || '暂无安排'}</span></span>
        <span><span className="life-today-label">运动建议</span><span>{todayLoading ? '读取中…' : error ? '暂不可用' : todayAdvice?.exercise || '待设置经期'}</span></span>
        <span><span className="life-today-label">饮食建议</span><span>{todayLoading ? '读取中…' : error ? '暂不可用' : todayAdvice?.food || '待设置经期'}</span></span>
      </span>
    </summary>
      <div>{cyclePhaseRanges(cycleEstimate).map(({ phase, start, end }) => {
        const advice = CYCLE_GUIDANCE[phase];
        return <div className={`life-phase-row phase-${phase}`} key={phase}>
          <div className="life-phase-name"><strong>{advice.label}</strong>{advice.subtitle && <span>{advice.subtitle}</span>}<span>第 {start}–{end} 天</span></div>
          <p><span>运动</span>{advice.exercise}</p><p><span>饮食</span>{advice.food}</p></div>;
      })}</div>
    </details>}
    {kind === 'body' && !error && <Suspense fallback={<p className="life-empty-state" role="status">曲线读取中…</p>}>
      <LifeBodyTrends year={year} month={month} entries={current?.entries} loading={loading || !current}
        onPeriodChange={(period) => setSelection((previous) => ({ ...previous, ...period }))}
        onEdit={(date) => openEntry({ date, kind: 'body', text: '', revision: '', ...current?.entries[`body:${date}`], mutationId: crypto.randomUUID() })} />
    </Suspense>}
    {kind === 'done' ? <Suspense fallback={<p className="life-empty-state" role="status">读取周本…</p>}><LifeDoneList onExpired={onExpired} recordsControlsTarget={recordsControlsTarget} replanning={orche.replanning} /></Suspense> : kind !== 'body' && <section className={`life-calendar${kind === 'training' ? ' life-training-calendar' : kind === 'skin' || kind === 'eyes' || kind === 'discomfort' ? ' life-symptom-calendar' : ''}`} aria-label={`${year}年${month}月${LIFE_LABELS[kind]}日历`} aria-busy={loading}>
      <div className="life-weekdays">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
      <div className="life-days">{cells.map((date, index) => {
        if (!date) return <div className="life-empty-day" key={`empty-${index}`} aria-hidden="true" />;
        const entry = current?.entries[`${kind}:${date}`];
        const period = periodSet.has(date);
        const phase = visibleCycleDay(date, cycle, current?.periodDays ?? [], now);
        const phaseLabel = phase ? `${phase.estimated ? '预计·' : ''}${CYCLE_GUIDANCE[phase.phase].label}` : '';
        const planned = kind === 'training' ? trainingPlan.get(date) : undefined;
        const skinSuggestion = kind === 'skin' && date === now && (!entry || !entry.revision) ? resolveSkinRecord(date, skinSettings, skinEntries) : undefined;
        const suggestedSkin = skinSuggestion && ((skinSuggestion.status && skinSuggestion.planDay) || skinSuggestion.acneMarks) ? { ...skinSuggestion,
          ...(skinSuggestion.status && skinSuggestion.planDay ? skinPlanValues(skinSettings, skinSuggestion.status, skinSuggestion.planDay, skinSeason(date)) : {}),
          ...skinLocalPlanValues(skinSettings, skinSuggestion) } : undefined;
        const summary = suggestedSkin ? entrySummary('skin', { text: '', revision: '', skin: suggestedSkin, makeup: entry?.makeup }) : entrySummary(kind, planned ? { ...entry, text: entry?.text ?? '', revision: entry?.revision ?? '', training: planned } : entry);
        const planStatus = suggestedSkin ? '个人方案' : planned?.completed ? '已完成' : entry?.training && planned?.mode !== 'auto' ? '手动安排' : date >= now && planned?.plan ? '自动计划' : '';
        const displaySkin = suggestedSkin ?? entry?.skin;
        const skinDetails = kind === 'skin' ? entrySummary('skin', { text: entry?.text ?? '', revision: '',
          skin: { ...displaySkin, status: undefined, acneMarks: false } }) : '';
        return <button type="button" key={date} disabled={loading || !current || Boolean(error) || (kind === 'training' && trainingSource.busy && !trainingSource.current?.completions)}
          className={`life-day${phase ? ` phase-${phase.phase}` : period ? ' phase-menstrual' : ''}${date === now ? ' is-today' : ''}`}
          aria-label={`${date} ${LIFE_LABELS[kind]} ${phaseLabel}${planStatus ? ` ${planStatus}` : ''}${summary ? `：${summary}` : '：未记录'}`}
          onClick={() => openEntry({ date, kind, text: '', revision: '', ...entry,
            ...(planned ? { training: entry?.training && (entry.training.completed || entry.training.mode !== 'auto')
              ? entry.training : planned } : {}),
            mutationId: crypto.randomUUID() })}>
          <span className="life-day-heading"><span className="life-day-number">{Number(date.slice(-2))}</span>{phaseLabel && <span className={`life-period-mark phase-${phase?.phase}`} aria-hidden="true">{phaseLabel}</span>}</span>
          {(kind === 'skin' || kind === 'eyes') && makeupSummary(entry?.makeup).length > 0 && <span className="life-day-text">{makeupSummary(entry?.makeup).join(' · ')}</span>}
          {kind === 'skin' ? <span className="life-day-content">
            {skinDetails && <span className="life-day-text">{skinDetails}</span>}
          </span> : kind === 'eyes' || kind === 'discomfort' ? <span className="life-day-content">
            {entry?.text && <span className="life-day-text">{entry.text}</span>}
          </span> : <span className="life-day-text">{summary}</span>}
          {stripItems.get(date)?.filter((item) => item.resolved).map((item) =>
            <span key={item.key} className="life-day-text">{item.label}</span>)}
          {planStatus && <span className="life-plan-status">{planStatus}</span>}
          {(strips.get(date)?.length ?? 0) > 0 && <span className="life-calendar-strips" aria-hidden="true">
            {strips.get(date)!.map((strip) => {
              const colors = symptomColor(strip.key);
              return <span key={`${strip.key}:${strip.lane}`} className={`life-calendar-strip${strip.starts ? ' starts' : ''}${strip.ends ? ' ends' : ''}`}
                style={{ gridRow: strip.lane + 1, backgroundColor: colors.borderColor } as CSSProperties} title={strip.label}>
                {strip.starts && <span>{strip.label}</span>}
              </span>;
            })}
          </span>}
        </button>;
      })}</div>
    </section>}
    {kind === 'body' && saved && <p className="life-empty-state" role="status">已保存</p>}
    {kind !== 'done' && kind !== 'body' && <footer className="life-footer"><div className="life-footer-left"><div className="life-cycle-key" aria-label="周期阶段">{cyclePhaseRanges(cycle).map(({ phase }) =>
        <span key={phase} className={`life-period-key phase-${phase}`}><i aria-hidden="true" />{CYCLE_GUIDANCE[phase].label}</span>)}</div>
      <button disabled={year <= 1900} onClick={() => setSelection((previous) => ({ ...previous, year: previous.year - 1 }))}>往年同月</button></div>
      <div className="life-sync-status" role="status">{loading ? '读取中…' : saved ? '已保存' : ''}
        {!loading && current?.syncedAt && <span>经期已保存 · {new Date(current.syncedAt).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        })}</span>}
        {current?.connected ? <button disabled={syncing} onClick={() => void syncPeriods(year, generation.current)}>{syncing ? '经期同步中…' : '同步经期'}</button>
          : <button onClick={() => setSettings(true)}>连接经期日历</button>}</div></footer>}
    {error && <div className="life-error-banner" role="alert">{error}<button onClick={() => setRetry((value) => value + 1)}>重试</button></div>}
    {periodError && <div className="life-error-banner" role="alert">{periodError}<button onClick={() => void syncPeriods(year, generation.current)}>重试</button></div>}
    {draft && current && !loading && <LifeEditor key={`${draft.kind}:${draft.date}`} initial={{ ...draft,
      makeup: draft.makeup ?? current.entries[`${draft.kind}:${draft.date}`]?.makeup }} owner={owner} skinSettings={skinSettings} skinEntries={skinEntries} symptomEntries={symptomEntries} cycle={cycle} periodDays={current.periodDays} onExpired={onExpired}
      trainingTasks={rolling ? rolling.byDate.get(draft.date) ?? [] : undefined}
      trainingLibrary={library}
      onClose={() => setDraft(null)} onSave={(entry, savedDraft) => {
        setData((previous) => previous ? { ...previous, entries: syncMakeupEntries({ ...previous.entries,
          [`${savedDraft.kind}:${savedDraft.date}`]: entry }, savedDraft.date, entry.makeup) } : previous);
        setDraft(null); setSaved(true);
      }} />}
    {skinSettingsOpen && current && <LifeSkinSettings initial={current.skinSettings ?? DEFAULT_SKIN_SETTINGS} year={year} onExpired={onExpired}
      onClose={() => { setSkinSettingsOpen(false); setRetry((value) => value + 1); }} onSave={(skinSettings) => {
        setData((previous) => previous ? { ...previous, skinSettings } : previous); setSkinSettingsOpen(false); setSaved(true);
      }} />}
    {orchestratorOpen && !settings && !cycleSettings && <LifeOrchestrator onClose={() => setOrchestratorOpen(false)} onExpired={onExpired}
      onManageOutlook={() => setSettings(true)} onManageCycle={() => setCycleSettings(true)} cycleDisabled={!current || loading}
      recordsControlsRef={kind === 'done' ? setRecordsControlsTarget : undefined} />}
    {settings && <LifeConnection year={year} connected={current?.connected ?? false} onClose={() => setSettings(false)} onChanged={(connected) => {
      setData((previous) => previous ? { ...previous, connected } : previous);
      if (connected) void syncPeriods(year, generation.current);
      else { activeSync.current?.abort(); setSyncing(false); setPeriodError(''); }
    }} />}
    {trainingSettingsOpen && trainingSource.current && <LifeTrainingSettings initial={trainingSource.current.settings ?? DEFAULT_TRAINING_SETTINGS}
      tasks={trainingSource.current.tasks} year={year} onExpired={onExpired}
      onClose={() => { setTrainingSettingsOpen(false); void trainingSource.refresh(); }} onSave={(settings) => {
        trainingSource.updateSettings(settings); setTrainingSettingsOpen(false); setSaved(true);
      }} />}
    {cycleSettings && <LifeCycleSettings initial={cycle} periodDays={current?.periodDays ?? []} year={year} tickTickTraining={hasTrainingSource} onExpired={onExpired} onClose={() => { setCycleSettings(false); setRetry((value) => value + 1); }} onSave={(savedCycle, swimmingError) => {
      setData((previous) => previous ? { ...previous, cycle: savedCycle } : previous); setCycleSettings(false); setSaved(true);
      setPeriodError(swimmingError ?? ''); void trainingSource.refresh(true);
    }} />}
  </main>;
}
