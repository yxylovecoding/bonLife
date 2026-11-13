import { useState } from 'react';
import { SYMPTOM_AREAS, SYMPTOM_STATES, type SymptomHistory, type SymptomKind } from '../utils/lifeSymptoms';
import { symptomColor } from './symptomColor';

export default function LifeSymptomHistory({ kind, history, onEdit }: {
  kind: SymptomKind | 'well'; history: SymptomHistory[]; onEdit: (date: string, kind: SymptomKind) => void;
}) {
  const [selected, setSelected] = useState('');
  const [limit, setLimit] = useState(12);
  const active = history.find((item) => item.key === selected) ?? history[0];
  const latest = active?.points[0];
  return <details className="life-symptom-history">
    <summary>症状跟踪 <span>{history.length ? `${history.length} 项` : '暂无记录'}</span></summary>
    {active && latest ? <>
      <label className="life-field">症状<select className="life-symptom-mark" style={symptomColor(active.key)} value={active.key} onChange={(event) => { setSelected(event.target.value); setLimit(12); }}>
        {history.map((item) => <option key={item.key} value={item.key}>{kind !== 'eyes' ? `${SYMPTOM_AREAS[item.area]} · ` : ''}{item.name}</option>)}
      </select></label>
      <div className="life-symptom-stats"><span>最近 · {SYMPTOM_STATES[latest.status]}</span><span>记录 {active.points.length} 次</span>
        <span>首次 {active.points[active.points.length - 1].date.replace(/-/g, '.')}</span></div>
      <ol className="life-symptom-timeline">{active.points.slice(0, limit).map((point) => <li key={point.date}>
        <button type="button" onClick={() => onEdit(point.date, active.area === 'eye' ? 'eyes' : 'discomfort')} aria-label={`编辑 ${point.date} ${active.name}`}>
          <time dateTime={point.date}>{point.date.replace(/-/g, '.')}</time><span className="life-symptom-status life-symptom-mark" style={symptomColor(active.key)}>{SYMPTOM_STATES[point.status]}</span>
          {point.note && <span className="life-symptom-note">{point.note}</span>}<span aria-hidden="true">›</span>
        </button></li>)}</ol>
      {active.points.length > limit && <button type="button" className="life-symptom-more" onClick={() => setLimit((value) => value + 24)}>更早记录</button>}
    </> : <p className="life-empty-state">暂无症状记录</p>}
  </details>;
}
