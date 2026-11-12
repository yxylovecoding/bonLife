import { useEffect, useRef, useState } from 'react';
import { parseCycleSettings, type CycleSettings } from '../utils/bonLife';
import { estimateCycle } from '../utils/lifeCycle';
import { LifeError, lifeRequest } from './client';

export default function LifeCycleSettings({ initial, periodDays, year, tickTickTraining, onSave, onClose, onExpired }: {
  initial: CycleSettings; periodDays: string[]; year: number; tickTickTraining?: boolean; onSave: (settings: CycleSettings, swimmingError?: string) => void; onClose: () => void; onExpired: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(initial);
  const [startEdited, setStartEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mutationId = useRef(crypto.randomUUID());
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const estimate = estimateCycle(draft, periodDays, today);
  const automatic = draft.automatic !== false;
  useEffect(() => { dialog.current?.showModal(); }, []);
  function change(fields: Partial<CycleSettings>) { setDraft((value) => ({ ...value, ...fields })); mutationId.current = crypto.randomUUID(); }
  async function save() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const cycle = parseCycleSettings(draft);
      const result = await lifeRequest<{ cycle: CycleSettings; swimmingError?: string }>('POST', { action: 'save-cycle', year, cycle, mutationId: mutationId.current });
      onSave(result.cycle, result.swimmingError);
    } catch (cause) {
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="life-dialog" aria-labelledby="life-cycle-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="persistent-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="persistent-form-body">
      <div className="life-editor-heading"><h2 id="life-cycle-title">经期与运动</h2></div>
      <label className="life-field">最近月经开始<input type="date" min="1900-01-01" max={today} value={startEdited ? draft.lastPeriodStart : estimate.lastPeriodStart} disabled={busy}
        onChange={(event) => { setStartEdited(true); change({ lastPeriodStart: event.target.value }); }} /></label>
      <label className="life-cycle-auto"><input type="checkbox" checked={automatic} disabled={busy}
        onChange={(event) => change({ automatic: event.target.checked,
          ...(!event.target.checked ? { cycleLength: estimate.cycleLength, periodLength: estimate.periodLength } : {}) })} />自动更新</label>
      <div className="life-fields"><label>周期 · 天<input type="number" required min="21" max="45" value={estimate.cycleLength} disabled={busy} readOnly={automatic && estimate.cycleSamples > 0}
        onChange={(event) => change({ cycleLength: Number(event.target.value) })} /></label>
        <label>经期 · 天<input type="number" required min="1" max="10" value={estimate.periodLength} disabled={busy} readOnly={automatic && estimate.periodSamples > 0}
          onChange={(event) => change({ periodLength: Number(event.target.value) })} /></label></div>
      <p className="life-empty-state" role="status">{automatic ? estimate.cycleSamples ? '预测已更新' : '待积累周期记录' : '手动设置'}
        {estimate.nextPeriodStart && <> · 下次预计 {estimate.nextPeriodStart}{estimate.nextPeriodStart < today ? ' · 待确认' : ''}</>}</p>
      {tickTickTraining ? <p className="life-empty-state">运动安排 · 自动轮换</p> : <fieldset className="life-training-days"><legend>运动日</legend><div>{[1, 2, 3, 4, 5, 6, 0].map((day, index) =>
        <button key={day} type="button" disabled={busy} aria-pressed={draft.trainingDays.includes(day)} aria-label={`周${'一二三四五六日'[index]}`}
          onClick={() => change({ trainingDays: draft.trainingDays.includes(day) ? draft.trainingDays.filter((value) => value !== day) : [...draft.trainingDays, day] })}>{'一二三四五六日'[index]}</button>)}</div></fieldset>}
      {error && <p className="life-error" role="alert">{error}</p>}
      </div>
      <div className="life-editor-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="life-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
    </form>
  </dialog>;
}
