import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DoneItem } from '../utils/bonLife';
import { accountFetch } from '../utils/authClient';
import { doneCategory, doneWeekDates, doneWeekMonths, doneWeekNumber, earlierDoneWeeks, computeDoneDurations, groupDoneWeek, shiftDoneDate } from '../utils/lifeDone';
import { squarifiedTreemap } from '../utils/squarifiedTreemap';
import { useDoneRecords } from './useDoneRecords';
import { markedTaskMinutes } from '../utils/taskDuration';

const shanghaiToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const completionTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
// 任务按分类映射到色系：课绿、活蓝、玩粉，未归类走中性灰。
const CATEGORY_CLASS: Record<string, string> = { 课: 'is-study', 活: 'is-life', 玩: 'is-play', 未分类: 'is-other' };
// 每次加载 DoneList 页面时自动触发一次 Orchestrate（静默，不打扰用户）。
// 使用模块级 flag 避免因组件在同一次会话内多次挂载/卸载重复触发。
let autoReplanDispatched = false;

// 按每天框内的实际可用宽高布局，外框的留白不计入瓷砖面积。
function DoneTiles({ items, durations }: { items: DoneItem[]; durations: Map<string, number> }) {
  const container = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const update = ({ width, height }: { width: number; height: number }) => {
      setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    };
    update(el.getBoundingClientRect());
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const sorted = [...items].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const byId = new Map(sorted.map((item) => [item.id, item] as const));
  const rects = width > 0 && height > 0 ? squarifiedTreemap(
    sorted.map((item) => ({ id: item.id, value: durations.get(item.id) ?? 15 })),
    width,
    height,
  ) : [];
  return <div ref={container} className="life-week-tiles">
    {rects.map((rect) => {
      const item = byId.get(rect.id);
      if (!item) return null;
      const minutes = durations.get(item.id) ?? 15;
      const category = doneCategory(item);
      const durationLabel = item.durationBasis === 'default' || (!item.durationBasis && markedTaskMinutes(item) === null)
        ? '未标注时长，暂按 15 分钟' : `${Number(minutes.toFixed(1))} 分钟`;
      return <div key={item.id} className={`life-week-tile ${CATEGORY_CLASS[category] ?? 'is-other'}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        title={`${item.source === 'outlook' ? 'Outlook' : 'TickTick'} · [${category}] ${item.title} · ${durationLabel} · ${completionTime.format(new Date(item.completedAt))}`}>
        <div className="life-week-tile-content">
          <span className="life-done-task-title">{item.title}</span>
          <time dateTime={item.completedAt}>{completionTime.format(new Date(item.completedAt))}</time>
        </div>
      </div>;
    })}
  </div>;
}

function DoneDay({ date, index, items, today, pending, busy, error }: {
  date: string; index: number; items: DoneItem[]; today: string; pending: boolean; busy: boolean; error: boolean;
}) {
  const isToday = date === today;
  const future = date > today;
  // 每天固定高度展示，squarified treemap 按耗时占比把任务瓷砖铺满容器、无缝隙；颜色区分课/活/玩分类。
  const durations = computeDoneDurations(items);
  return <section className={`life-week-day${isToday ? ' is-today' : ''}${future ? ' is-future' : ''}`} aria-label={`${date}完成记录`}>
    <header className="life-week-day-heading"><time dateTime={date}>{Number(date.slice(8))}</time><span>{weekdays[index]}</span>{isToday && <span className="life-week-today">今天</span>}</header>
    <div className="life-week-day-content">
      {future ? null : pending && !items.length ? <p className="life-week-empty">{busy ? '读取中…' : error ? '暂未读到记录' : '等待同步'}</p>
        : items.length ? <DoneTiles items={items} durations={durations} /> : <p className="life-week-category-empty">—</p>}
    </div>
  </section>;
}

export default function LifeDoneList({ onExpired, recordsControlsTarget, replanning = false }: { onExpired: () => void; recordsControlsTarget?: HTMLDivElement | null; replanning?: boolean }) {
  const [today, setToday] = useState(shanghaiToday);
  const thisWeek = doneWeekDates(today)[0];
  const [weeks, setWeeks] = useState(() => [...earlierDoneWeeks(thisWeek, 1), thisWeek]);
  const { data, months, errors, busy, refresh } = useDoneRecords(weeks[0], today, onExpired);
  const refreshedAt = useRef(Date.now());
  const strip = useRef<HTMLDivElement>(null);
  const earlierSpace = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const beforePrepend = useRef<{ width: number; left: number } | null>(null);
  const goToLatest = useRef(false);
  const [atLatest, setAtLatest] = useState(true);
  // 页面打开时自动静默触发一次 Orchestrate，等价于用户点击「Orche」按钮，
  // 不走组件状态，避免打扰用户；失败也静默忽略。
  useEffect(() => {
    if (autoReplanDispatched) return;
    autoReplanDispatched = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    void (async () => {
      try {
        await accountFetch('/api/ticktick-trips?action=trigger-replan', {
          method: 'POST', credentials: 'same-origin', signal: controller.signal,
        });
      } catch { /* 静默忽略触发失败，用户仍可手动点击「Orche」。*/ }
      finally { clearTimeout(timer); }
    })();
    return () => { clearTimeout(timer); controller.abort(); };
  }, []);
  useEffect(() => {
    const update = () => {
      setToday(shanghaiToday());
      if (!replanning && document.visibilityState === 'visible' && Date.now() - refreshedAt.current >= 300_000) {
        refreshedAt.current = Date.now();
        refresh('refresh');
      }
    };
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    const timer = window.setInterval(update, 300_000);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [refresh, replanning]);
  useEffect(() => {
    if (weeks[weeks.length - 1] >= thisWeek) return;
    goToLatest.current = atLatest;
    setWeeks((previous) => {
      const next = [...previous];
      for (let week = shiftDoneDate(next[next.length - 1], 7); week <= thisWeek; week = shiftDoneDate(week, 7)) next.push(week);
      return next;
    });
  }, [thisWeek, weeks, atLatest]);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    if (!positioned.current || goToLatest.current) {
      element.scrollLeft = element.scrollWidth - element.clientWidth;
      positioned.current = true; goToLatest.current = false;
    } else if (beforePrepend.current) {
      element.scrollLeft = beforePrepend.current.left + element.scrollWidth - beforePrepend.current.width;
      beforePrepend.current = null;
    }
    setAtLatest(element.scrollWidth - element.clientWidth - element.scrollLeft < 8);
  }, [weeks]);
  function loadEarlier(offset = 0) {
    const element = strip.current;
    if (!element || beforePrepend.current) return;
    const earlier = earlierDoneWeeks(weeks[0], 1);
    if (!earlier.length) return;
    beforePrepend.current = { width: element.scrollWidth, left: element.scrollLeft + offset };
    setWeeks((previous) => [...earlier, ...previous]);
  }
  function move(direction: number) {
    const element = strip.current;
    if (!element) return;
    const page = element.querySelector<HTMLElement>('.life-week-page');
    if (!page) return;
    const distance = page.getBoundingClientRect().width + parseFloat(getComputedStyle(element).columnGap);
    if (direction < 0 && earlierSpace.current && page.getBoundingClientRect().left + distance > element.getBoundingClientRect().left + 1) {
      loadEarlier(-distance);
      return;
    }
    element.scrollBy({ left: direction * distance, behavior: 'smooth' });
  }
  const syncTimes = months.map(value => {
    if (!value) return undefined;
    const times = [...(value.connected ? [value.syncedAt] : []), ...(value.outlookConnected ? [value.outlookSyncedAt] : [])];
    return times.length && times.every(Boolean) ? (times as string[]).sort()[0] : undefined;
  });
  const syncedAt = syncTimes.every(Boolean) ? syncTimes.sort()[0] : null;
  return <section className="life-done" aria-label="DoneList 周本" aria-busy={busy || replanning}>
    <div className="life-done-heading"><h2>完成周本</h2><nav className="life-week-navigation" aria-label="翻阅周本">
      <button className="life-arrow" aria-label="上一周" onClick={() => move(-1)}>‹</button>
      <button className="life-today" onClick={() => strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: 'smooth' })}>本周</button>
      <button className="life-arrow" aria-label="下一周" disabled={atLatest} onClick={() => move(1)}>›</button>
    </nav></div>
    {recordsControlsTarget && createPortal(<div className="life-orchestrator-records">
      <span role="status">{busy ? '同步中…' : syncedAt ? `${completionTime.format(new Date(syncedAt))} 已同步` : '尚未同步'}</span>
      <button type="button" disabled={busy || replanning} onClick={() => refresh('force')}>同步记录</button>
    </div>, recordsControlsTarget)}
    {Object.entries(errors).map(([key, error]) => <p className="life-error" role="alert" key={key}>{key.replace('-', ' 年 ')} 月 · {error}</p>)}
    {months.some((value) => value && !value.connected) && <p className="life-empty-state">TickTick 未连接 · <a href="https://bill.bonbills.cn/calendar" target="_blank" rel="noreferrer">连接 TickTick ↗</a></p>}
    <div ref={strip} className="life-week-strip" role="region" aria-label="连续周本，向左查看更早记录" tabIndex={0} onScroll={(event) => {
      const element = event.currentTarget;
      setAtLatest(element.scrollWidth - element.clientWidth - element.scrollLeft < 8);
      const space = earlierSpace.current;
      if (positioned.current && space && space.getBoundingClientRect().right > element.getBoundingClientRect().left + 1) loadEarlier();
    }}>
      {weeks[0] > '1900-01-01' && <div ref={earlierSpace} className="life-week-earlier-space" aria-hidden="true" />}
      {weeks.map((week) => {
        const days = doneWeekDates(week);
        const records = groupDoneWeek(doneWeekMonths(week, today).flatMap((key) => data[key]?.items ?? []), week, today);
        const firstMonth = Number(days[0].slice(5, 7)); const lastMonth = Number(days[6].slice(5, 7));
        return <article key={week} className="life-week-page" aria-label={`${week}至${days[6]}周本`} data-week={week}>
          <header className="life-week-page-heading"><div><h3>{firstMonth}{firstMonth !== lastMonth && <> | {lastMonth}</>}</h3><span>{doneWeekDates(week)[3].slice(0, 4)} · 第 {doneWeekNumber(week)} 周</span></div>
            <span>{days[0].slice(5).replace('-', '.')} — {days[6].slice(5).replace('-', '.')}</span></header>
          {records.map((day, index) => {
            const month = data[day.date.slice(0, 7)];
            const pending = !month || day.date < month.from || day.date > month.to || !(month.syncedAt || month.outlookSyncedAt);
            return <DoneDay key={day.date} {...day} index={index} today={today} busy={busy} error={Boolean(errors[day.date.slice(0, 7)])} pending={pending} />;
          })}
        </article>;
      })}
    </div>
  </section>;
}
