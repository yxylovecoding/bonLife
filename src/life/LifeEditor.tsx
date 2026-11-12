import LifeSkinFields from './LifeSkinFields';
import LifeMakeupFields from './LifeMakeupFields';
import LifeSymptomFields from './LifeSymptomFields';
import { reusableSymptom, symptomHistory, symptomKey, symptomObservations, type SymptomArea } from '../utils/lifeSymptoms';
import { DEFAULT_SKIN_SETTINGS, type SkinSettings } from '../utils/lifeSkin';
import { resolveSkinRecord } from '../utils/lifeSkinProgress';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { BODY_FIELDS, entrySummary, parseLifeEdit, LIFE_LABELS, LIFE_TEXT_LIMIT, type BodyRecord, type CycleSettings, type LifeEntry, type LifeEntries } from '../utils/bonLife';
import { CYCLE_GUIDANCE, visibleCycleDay } from '../utils/lifeCycle';
import { readDraft, saveDraft, removeDraft, LifeError, lifeRequest, type LifeDraft } from './client';
import { automaticTraining, plannedTraining, recordedTrainingProjects, reuseTrainingProjects, trainingIdentity, type TrainingTask } from '../utils/lifeTraining';

export default function LifeEditor({ initial, owner, cycle, periodDays, trainingTasks, trainingLibrary = [], skinSettings = DEFAULT_SKIN_SETTINGS, skinEntries, symptomEntries, onSave, onClose, onExpired }: {
  initial: LifeDraft; owner: string; cycle: CycleSettings; periodDays: string[];
  trainingTasks?: TrainingTask[]; trainingLibrary?: TrainingTask[]; skinSettings?: SkinSettings; skinEntries: LifeEntries; symptomEntries: LifeEntries;
  onSave: (entry: LifeEntry, draft: LifeDraft) => void; onClose: () => void; onExpired: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<LifeEntry | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const attempted = useRef(false);
  const startedOnBackdrop = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || Boolean(readDraft(owner, draft));
  const phase = visibleCycleDay(draft.date, cycle, periodDays);
  const guidance = phase ? CYCLE_GUIDANCE[phase.phase] : null;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const skin = draft.kind === 'skin' ? resolveSkinRecord(draft.date, skinSettings, skinEntries, draft.skin) : undefined;
  const training = draft.kind === 'training' ? plannedTraining(draft.date, today, trainingTasks, cycle, periodDays, draft.training) : undefined;
  const chosenProjects = training ? recordedTrainingProjects(training, trainingLibrary) : [];
  const chosenTasks = trainingLibrary.filter((task) => chosenProjects.includes(trainingIdentity(task)));
  const isSymptom = draft.kind === 'eyes' || draft.kind === 'discomfort';
  const history = useMemo(() => initial.kind === 'eyes' || initial.kind === 'discomfort' ? symptomHistory(initial.kind, symptomEntries) : [], [initial.kind, symptomEntries]);

  function persist(next: LifeDraft) {
    try { saveDraft(owner, next); return true; }
    catch { setError('草稿暂存失败，请保存后再关闭'); return false; }
  }
  function change(fields: Partial<LifeDraft>) {
    const next = { ...draft, ...fields, mutationId: crypto.randomUUID() };
    setDraft(next); persist(next); setDiscarding(false);
  }
  function close() {
    if (busy) return;
    if (dirty && !discarding) { setDiscarding(true); return; }
    try { removeDraft(owner, draft); } catch { /* No draft storage. */ }
    onClose();
  }
  function dismiss() {
    if (busy || (dirty && !persist(draft))) return;
    onClose();
  }
  function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }
  useEffect(() => {
    dialog.current?.showModal();
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  async function save() {
    if (busy || attempted.current) return;
    attempted.current = true;
    setBusy(true); setError(''); persist(draft);
    try {
      let savedDraft = skin ? { ...draft, skin } : training ? { ...draft, training } : draft;
      if (draft.kind === 'eyes' || draft.kind === 'discomfort') {
        const symptoms = { ...symptomObservations(draft.kind, draft[draft.kind]) };
        for (const [area, name] of Object.entries(draft.symptomNames ?? {})) {
          if (!name?.trim()) continue;
          const key = symptomKey(area as SymptomArea, name);
          symptoms[key] ??= reusableSymptom(area as SymptomArea, name, draft.date, history);
        }
        savedDraft = { ...draft, [draft.kind]: { symptoms }, symptomNames: undefined };
      }
      parseLifeEdit(savedDraft);
      const { entry } = await lifeRequest<{ entry: LifeEntry }>('POST', { action: 'save', ...savedDraft });
      try { removeDraft(owner, draft); } catch { /* Server save succeeded. */ }
      onSave(entry, savedDraft);
    } catch (cause) {
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      else if (cause instanceof LifeError && cause.current) setConflict(cause.current);
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { setBusy(false); attempted.current = false; }
  }
  return <dialog className={`life-dialog${isSymptom ? ' life-symptom-editor' : ''}`} ref={dialog} onCancel={(event) => { event.preventDefault(); dismiss(); }} aria-labelledby="life-editor-title"
    onPointerDown={(event) => { startedOnBackdrop.current = event.button === 0 && isBackdrop(event); }}
    onPointerCancel={() => { startedOnBackdrop.current = false; }}
    onClick={(event) => {
      const outside = startedOnBackdrop.current && isBackdrop(event);
      startedOnBackdrop.current = false;
      if (outside) dismiss();
    }}>
    <form className="persistent-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="persistent-form-body">
      <div className="life-editor-heading"><h2 id="life-editor-title">{LIFE_LABELS[draft.kind]} <span>{draft.date.replace(/-/g, '.')}</span></h2>
        {guidance && <span className={`life-period-label phase-${phase?.phase}`}>{phase?.estimated ? '预计·' : ''}{guidance.label}</span>}</div>
      {(draft.kind === 'skin' || draft.kind === 'eyes') && <LifeMakeupFields value={draft.makeup} busy={busy} onChange={(makeup) => change({ makeup })} />}
      {draft.kind === 'skin' && <LifeSkinFields date={draft.date} value={skin} entries={skinEntries} settings={skinSettings} busy={busy} onChange={(skin) => change({ skin })} />}
      {(draft.kind === 'eyes' || draft.kind === 'discomfort') && <LifeSymptomFields kind={draft.kind}
        value={symptomObservations(draft.kind, draft[draft.kind])} names={draft.symptomNames ?? {}} history={history} date={draft.date} busy={busy}
        onChange={(symptoms, symptomNames) => change({ [draft.kind]: { symptoms }, symptomNames })} />}
      {draft.kind === 'body' && <div className="life-fields">{Object.entries(BODY_FIELDS).map(([key, field]) =>
        <label key={key}>{field.label}{field.unit && ` · ${field.unit}`}<input type="number" min={'min' in field ? field.min : 0.01} max={field.max} step="any" inputMode="decimal" disabled={busy}
          value={draft.body?.[key as keyof BodyRecord] ?? ''} onChange={(event) => {
            const body = { ...draft.body };
            if (!event.target.value) delete body[key as keyof BodyRecord]; else body[key as keyof BodyRecord] = Number(event.target.value);
            change({ body });
          }} /></label>)}</div>}
      {draft.kind === 'training' && <div className="life-training-editor">
        <fieldset className="life-skin-choices" disabled={busy}><legend>运动项目</legend><div>{trainingLibrary.map((task) => <button type="button" key={trainingIdentity(task)}
          aria-pressed={chosenProjects.includes(trainingIdentity(task))} onClick={() => {
            const key = trainingIdentity(task);
            const keys = chosenProjects.includes(key) ? chosenProjects.filter((value) => value !== key) : [...chosenProjects, key];
            try { change({ training: reuseTrainingProjects(trainingLibrary.filter((value) => keys.includes(trainingIdentity(value)))) }); setError(''); }
            catch (cause) { setError(cause instanceof Error ? cause.message : '运动项目选择失败'); }
          }}>{task.name}{task.tags?.length ? <small className="life-training-tags">{task.tags.join(' · ')}</small> : null}</button>)}</div></fieldset>
        {Boolean(chosenTasks.length) && <details className="life-training-details"><summary>运动内容</summary>
          {chosenTasks.map((task) => <div key={task.id}><p>{task.name}</p>{task.notes && <p className="life-training-notes">{task.notes}</p>}
            {task.links.length > 0 && <div className="life-training-links">{task.links.map((link) => <a href={link.url} key={link.url} target="_blank" rel="noreferrer">{link.title} ↗</a>)}</div>}</div>)}
        </details>}
        {guidance && <div className="life-guidance"><p><span>运动</span>{guidance.exercise}</p><p><span>饮食</span>{guidance.food}</p></div>}
        <div className="life-training-mode"><span>{training?.mode === 'auto' ? '自动轮换' : '手动安排'}</span>
          {training?.mode !== 'auto' && !training?.completed && <button type="button" disabled={busy} onClick={() => change({ training: automaticTraining(draft.date, trainingTasks, cycle, periodDays, training?.effort) })}>恢复自动安排</button>}
        </div>
        <label className="life-field">当日强度<select disabled={busy} value={training?.effort ?? 'normal'} onChange={(event) => {
          const effort = event.target.value as 'normal' | 'easy' | 'rest';
          change({ training: { ...automaticTraining(draft.date, training?.mode === 'manual' ? chosenTasks : trainingTasks, cycle, periodDays, effort),
            mode: training?.mode ?? 'auto', completed: training?.completed ?? false } });
        }}><option value="normal">按计划</option><option value="easy">轻量</option><option value="rest">休息</option></select></label>
        <label className="life-field">运动计划<textarea aria-label="运动计划" rows={3} maxLength={1000} disabled={busy} value={training?.plan ?? ''}
          onChange={(event) => change({ training: { effort: 'normal', completed: false, ...training, plan: event.target.value, mode: 'manual', projects: undefined } })} /></label>
        <label className="life-check"><input type="checkbox" disabled={busy} checked={training?.completed ?? false} onChange={(event) =>
          change({ training: { plan: '', effort: 'normal', ...training, completed: event.target.checked } })} />已完成</label>
      </div>}
      <label className="life-field">{draft.kind === 'skin' ? '皮肤备注' : draft.kind === 'mood' ? '情绪' : '备注'}
      <textarea aria-label={`${LIFE_LABELS[draft.kind]}记录`} autoFocus={draft.kind !== 'skin' && !isSymptom} rows={draft.kind === 'skin' || isSymptom ? 3 : 7} maxLength={LIFE_TEXT_LIMIT}
        placeholder="写几句话…" value={draft.text} disabled={busy} onChange={(event) => change({ text: event.target.value })} /></label>
      {error && <p role="alert" className="life-error">{error}</p>}
      {conflict && <div className="life-conflict"><p>云端记录</p><blockquote>{entrySummary(draft.kind, conflict) || '（空白）'}</blockquote>
        <button type="button" onClick={() => {
          const next = { ...draft, revision: conflict.revision, mutationId: crypto.randomUUID(),
            ...(draft.makeup ? { makeup: { ...draft.makeup, revision: conflict.makeup?.revision ?? '' } } : {}) };
          setDraft(next); persist(next); setConflict(null); setError('');
        }}>保留我的记录并继续编辑</button></div>}
      </div>
      <div className="life-editor-actions"><button type="button" disabled={busy} onClick={close}>{discarding ? '放弃修改' : '取消'}</button>
        <button type="submit" className="life-primary" disabled={busy || Boolean(conflict)}>{busy ? '保存中…' : '保存'}</button></div>
    </form>
  </dialog>;
}
