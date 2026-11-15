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
import { completedTrainingRecord, DEFAULT_TRAINING_SETTINGS, isTrainingCategory, parseTrainingSettings, recordedTrainingProjects,
  trainingIdentity, trainingLibrary as buildTrainingLibrary, trainingProjectKey, trainingProjectName,
  type TrainingCompletion, type TrainingSettings, type TrainingTask } from '../utils/lifeTraining';

export default function LifeEditor({ initial, owner, cycle, periodDays, trainingLibrary = [], trainingCompletions = [], calendarCompletions = [],
  trainingSettings = DEFAULT_TRAINING_SETTINGS, onTrainingSettings, skinSettings = DEFAULT_SKIN_SETTINGS, skinEntries, symptomEntries, onSave, onClose, onExpired }: {
  initial: LifeDraft; owner: string; cycle: CycleSettings; periodDays: string[];
  trainingLibrary?: TrainingTask[]; trainingCompletions?: TrainingCompletion[]; calendarCompletions?: TrainingCompletion[];
  trainingSettings?: TrainingSettings; onTrainingSettings?: (settings: TrainingSettings) => void;
  skinSettings?: SkinSettings; skinEntries: LifeEntries; symptomEntries: LifeEntries;
  onSave: (entry: LifeEntry, draft: LifeDraft) => void; onClose: () => void; onExpired: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<LifeEntry | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const projectMutation = useRef(crypto.randomUUID());
  const attempted = useRef(false);
  const startedOnBackdrop = useRef(false);
  const dirty = Boolean(projectName.trim()) || JSON.stringify(draft) !== JSON.stringify(initial) || Boolean(readDraft(owner, draft));
  const phase = visibleCycleDay(draft.date, cycle, periodDays);
  const guidance = phase ? CYCLE_GUIDANCE[phase.phase] : null;
  const skin = draft.kind === 'skin' ? resolveSkinRecord(draft.date, skinSettings, skinEntries, draft.skin) : undefined;
  const training = draft.kind === 'training' ? completedTrainingRecord(draft.date, trainingLibrary, draft.training, trainingCompletions) : undefined;
  const chosenProjects = training ? recordedTrainingProjects(training, trainingLibrary) : [];
  const manualProjects = draft.training?.completed ? recordedTrainingProjects(draft.training, trainingLibrary) : [];
  const importedProjects = completedTrainingRecord(draft.date, trainingLibrary, undefined, trainingCompletions).projects ?? [];
  const calendarProjects = completedTrainingRecord(draft.date, trainingLibrary, undefined, calendarCompletions).projects ?? [];
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

  async function addProject() {
    if (busy || attempted.current || !onTrainingSettings) return;
    attempted.current = true; setBusy(true); setError('');
    try {
      const name = trainingProjectName(projectName);
      if (isTrainingCategory(name)) throw new Error('请填写具体运动项目');
      if (trainingLibrary.some(task => trainingProjectKey(task.name) === trainingProjectKey(name))) throw new Error('已存在同名运动项目');
      const settings = parseTrainingSettings({ ...trainingSettings, projects: [...trainingSettings.projects,
        { key: projectMutation.current, name, notes: '', rotation: false }] });
      const result = await lifeRequest<{ settings: TrainingSettings }>('POST', { action: 'save-training-settings',
        year: Number(draft.date.slice(0, 4)), settings, mutationId: projectMutation.current });
      const library = buildTrainingLibrary(trainingLibrary, result.settings);
      const project = library.find(task => trainingIdentity(task) === projectMutation.current);
      if (!project) throw new Error('项目保存未确认，请重试');
      onTrainingSettings(result.settings);
      change({ training: completedTrainingRecord(draft.date, library,
        { plan: '', effort: 'normal', completed: true, projects: [...manualProjects, trainingIdentity(project)] }) });
      setAddingProject(false); setProjectName(''); projectMutation.current = crypto.randomUUID();
    } catch (cause) {
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      setError(cause instanceof Error ? cause.message : '添加失败，请重试');
    } finally { setBusy(false); attempted.current = false; }
  }

  async function save() {
    if (busy || attempted.current) return;
    attempted.current = true;
    setBusy(true); setError(''); persist(draft);
    try {
      let savedDraft = skin ? { ...draft, skin } : training
        ? { ...draft, training: draft.training ?? completedTrainingRecord(draft.date, trainingLibrary) } : draft;
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
    <form className="persistent-form" onSubmit={(event) => { event.preventDefault(); if (addingProject) void addProject(); else void save(); }}>
      <div className="persistent-form-body">
      <div className="life-editor-heading"><h2 id="life-editor-title">{LIFE_LABELS[draft.kind]} <span>{draft.date.replace(/-/g, '.')}</span></h2>
        {guidance && draft.kind !== 'training' && <span className={`life-period-label phase-${phase?.phase}`}>{phase?.estimated ? '预计·' : ''}{guidance.label}</span>}</div>
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
        <fieldset className="life-skin-choices" disabled={busy}><legend>做了什么</legend><div>{trainingLibrary.map((task) => <button type="button" key={trainingIdentity(task)}
          aria-pressed={chosenProjects.includes(trainingIdentity(task))} disabled={importedProjects.includes(trainingIdentity(task))}
          title={calendarProjects.includes(trainingIdentity(task)) ? '日历记录' : importedProjects.includes(trainingIdentity(task)) ? 'TickTick 已完成' : undefined} onClick={() => {
            const key = trainingIdentity(task);
            const keys = manualProjects.includes(key) ? manualProjects.filter((value) => value !== key) : [...manualProjects, key];
            try { change({ training: completedTrainingRecord(draft.date, trainingLibrary,
              { plan: '', projects: keys, effort: 'normal', completed: true }) }); setError(''); }
            catch (cause) { setError(cause instanceof Error ? cause.message : '运动项目选择失败'); }
          }}>{task.name}{calendarProjects.includes(trainingIdentity(task)) ? <small className="life-training-tags">日历</small>
            : importedProjects.includes(trainingIdentity(task)) ? <small className="life-training-tags">TickTick</small> : null}</button>)}</div></fieldset>
        {addingProject ? <div className="life-training-add">
          <label className="life-field">运动项目<input autoFocus maxLength={60} value={projectName} disabled={busy}
            onChange={event => { setProjectName(event.target.value); projectMutation.current = crypto.randomUUID(); setError(''); }} /></label>
          <div className="life-training-add-actions"><button type="button" disabled={busy} onClick={() => { setAddingProject(false); setProjectName(''); setError(''); }}>取消</button>
            <button type="button" disabled={busy || !projectName.trim()} onClick={() => void addProject()}>{busy ? '添加中…' : '添加'}</button></div>
        </div> : <button type="button" className="life-project-add" disabled={busy || !onTrainingSettings || trainingSettings.projects.length >= 60}
          onClick={() => { setAddingProject(true); setError(''); }}>＋ 添加运动项目</button>}
      </div>}
      {draft.kind !== 'training' && <label className="life-field">{draft.kind === 'skin' ? '皮肤备注' : draft.kind === 'mood' ? '情绪' : '备注'}
      <textarea aria-label={`${LIFE_LABELS[draft.kind]}记录`} autoFocus={draft.kind !== 'skin' && !isSymptom} rows={draft.kind === 'skin' || isSymptom ? 3 : 7} maxLength={LIFE_TEXT_LIMIT}
        placeholder="写几句话…" value={draft.text} disabled={busy} onChange={(event) => change({ text: event.target.value })} /></label>}
      {error && <p role="alert" className="life-error">{error}</p>}
      {conflict && <div className="life-conflict"><p>云端记录</p><blockquote>{entrySummary(draft.kind, conflict) || '（空白）'}</blockquote>
        <button type="button" onClick={() => {
          const next = { ...draft, revision: conflict.revision, mutationId: crypto.randomUUID(),
            ...(draft.makeup ? { makeup: { ...draft.makeup, revision: conflict.makeup?.revision ?? '' } } : {}) };
          setDraft(next); persist(next); setConflict(null); setError('');
        }}>保留我的记录并继续编辑</button></div>}
      </div>
      <div className="life-editor-actions"><button type="button" disabled={busy} onClick={close}>{discarding ? '放弃修改' : '取消'}</button>
        <button type="submit" className="life-primary" disabled={busy || addingProject || Boolean(conflict)}>{busy ? '保存中…' : '保存'}</button></div>
    </form>
  </dialog>;
}
