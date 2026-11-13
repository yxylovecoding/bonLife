import { useMemo, type CSSProperties } from 'react';
import { calendarCells, DEFAULT_CYCLE, type LifeEntries, type LifeYear } from '../utils/bonLife';
import { DEFAULT_SKIN_SETTINGS } from '../utils/lifeSkin';
import { CYCLE_GUIDANCE, visibleCycleDay } from '../utils/lifeCycle';
import { makeupSummary } from '../utils/lifeMakeup';
import { calendarStripSegments } from './calendarStrips';
import { symptomColor } from './symptomColor';
import { wellCalendarDay } from './wellCalendar';

export default function LifeWellCalendar({ year, month, now, data, skinEntries, loading, error, onEdit }: {
  year: number; month: number; now: string; data: LifeYear | null; skinEntries: LifeEntries; loading: boolean; error: string; onEdit: (date: string) => void;
}) {
  const cells = useMemo(() => calendarCells(year, month), [year, month]);
  const days = useMemo(() => new Map(data ? cells.flatMap(date => date ? [[date,
    wellCalendarDay(date, now, data.entries, skinEntries, data.skinSettings ?? DEFAULT_SKIN_SETTINGS)] as const] : []) : []), [cells, data, now, skinEntries]);
  const strips = useMemo(() => calendarStripSegments(cells, new Map([...days].map(([date, day]) => [date, day.strips]))), [cells, days]);
  return <section className="life-calendar life-symptom-calendar life-well-calendar" aria-label={`${year}年${month}月bonWell日历`} aria-busy={loading}>
    <div className="life-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="life-days">{cells.map((date, index) => {
      if (!date) return <div className="life-empty-day" key={`empty-${index}`} aria-hidden="true" />;
      const day = days.get(date);
      const phase = data ? visibleCycleDay(date, data.cycle ?? DEFAULT_CYCLE, data.periodDays, now) : null;
      const phaseLabel = phase ? `${phase.estimated ? '预计·' : ''}${CYCLE_GUIDANCE[phase.phase].label}` : '';
      const makeup = makeupSummary(day?.makeup).join(' · ');
      const summary = [makeup, ...(day?.summaries ?? []).map(item => `${item.label}：${item.text}`)].filter(Boolean).join('；');
      return <button type="button" key={date} disabled={loading || !data || Boolean(error)} onClick={() => onEdit(date)}
        className={`life-day${phase ? ` phase-${phase.phase}` : ''}${date === now ? ' is-today' : ''}`}
        aria-label={`${date} bonWell ${phaseLabel}${day?.suggested ? ' 个人方案' : ''}：${summary || '未记录'}`}>
        <span className="life-day-heading"><span className="life-day-number">{Number(date.slice(-2))}</span>
          {phaseLabel && <span className={`life-period-mark phase-${phase?.phase}`} aria-hidden="true">{phaseLabel}</span>}</span>
        <span className="life-day-content">
          {makeup && <span className="life-day-text">{makeup}</span>}
          {day?.summaries.map(item => <span className="life-day-text life-well-summary" key={item.kind}><span className="life-well-label">{item.label} </span>{item.text.replace(/\n/g, ' · ')}</span>)}
        </span>
        {day?.suggested && <span className="life-plan-status">个人方案</span>}
        {(strips.get(date)?.length ?? 0) > 0 && <span className="life-calendar-strips" aria-hidden="true">{strips.get(date)!.map(strip =>
          <span key={`${strip.key}:${strip.lane}`} className={`life-calendar-strip${strip.starts ? ' starts' : ''}${strip.ends ? ' ends' : ''}`}
            style={{ gridRow: strip.lane + 1, backgroundColor: symptomColor(strip.key).borderColor } as CSSProperties}>{strip.starts ? strip.label : '\u00a0'}</span>)}</span>}
      </button>;
    })}</div>
  </section>;
}
