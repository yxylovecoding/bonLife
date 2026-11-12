import { useEffect, useRef, useState } from 'react';
import { isSwimmingTraining, isTrainingCategory, parseTrainingSettings, TRAINING_TAGS, trainingIdentity, trainingLibrary, trainingProjectKey, trainingTags,
  type TrainingProject, type TrainingSettings, type TrainingTask } from '../utils/lifeTraining';
import { LifeError, lifeRequest } from './client';

export default function LifeTrainingSettings({ initial, tasks, year, onSave, onClose, onExpired }: {
  initial: TrainingSettings; tasks: TrainingTask[]; year: number;
  onSave: (settings: TrainingSettings) => void; onClose: () => void; onExpired: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(initial);
  const [item, setItem] = useState<TrainingProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const mutation = useRef(crypto.randomUUID());
  const attempted = useRef(false);
  const dirty = draft !== initial || Boolean(item);
  const library = trainingLibrary(tasks, draft);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  function close() { if (busy) return; if (dirty && !discarding) { setDiscarding(true); return; } onClose(); }
  function update(project: TrainingProject) {
    const next = { ...draft, projects: [...draft.projects.filter((value) => value.key !== project.key), project] };
    setDraft(parseTrainingSettings(next)); mutation.current = crypto.randomUUID(); setDiscarding(false); setError('');
  }
  function finish() {
    if (!item) return;
    try {
      if (isTrainingCategory(item.name)) throw new Error('有氧、力量是标签，请填写具体项目名称');
      if (library.some((task) => trainingIdentity(task) !== item.key && trainingProjectKey(task.name) === trainingProjectKey(item.name))) throw new Error('已存在同名运动项目');
      update(item); setItem(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '运动项目信息无效'); }
  }
  async function save() {
    if (busy || attempted.current || item) return;
    setBusy(true); setError(''); attempted.current = true;
    try {
      const settings = parseTrainingSettings(draft);
      const result = await lifeRequest<{ settings: TrainingSettings }>('POST', { action: 'save-training-settings', year, settings, mutationId: mutation.current });
      onSave(result.settings);
    } catch (cause) {
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { setBusy(false); attempted.current = false; }
  }
  return <dialog ref={dialog} className="life-dialog" aria-labelledby="life-training-settings-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <form className="persistent-form" onSubmit={(event) => { event.preventDefault(); if (item) finish(); else void save(); }}>
      <div className="life-editor-heading"><h2 id="life-training-settings-title">运动项目</h2><span>{dirty ? '未保存' : '常用项目'}</span></div>
      <div className="persistent-form-body">
      {item ? <>
        <label className="life-field">项目名称<input autoFocus required maxLength={60} value={item.name} disabled={busy} onChange={(event) => setItem({ ...item, name: event.target.value })} /></label>
        <fieldset className="life-skin-choices" disabled={busy}><legend>标签</legend><div>{TRAINING_TAGS.map((tag) => <button key={tag} type="button"
          aria-pressed={trainingTags(item).includes(tag)} onClick={() => {
            const tags = trainingTags(item);
            setItem({ ...item, tags: tags.includes(tag) ? tags.filter((value) => value !== tag) : [...tags, tag] });
          }}>{tag}</button>)}</div></fieldset>
        <label className="life-field">运动内容<textarea rows={3} maxLength={500} value={item.notes} disabled={busy} placeholder="时长、组数或跟练内容" onChange={(event) => setItem({ ...item, notes: event.target.value })} /></label>
        <label className="life-check"><input type="checkbox" checked={item.rotation} disabled={busy} onChange={(event) => setItem({ ...item, rotation: event.target.checked })} />{isSwimmingTraining({ title: item.key, name: item.name }) ? '独立安排' : '加入轮换'}</label>
      </> : <>
        <ul className="life-project-list">{library.map((task) => <li key={trainingIdentity(task)}>
          <div><strong>{task.name}</strong>{task.tags?.length ? <small className="life-training-tags">{task.tags.join(' · ')}</small> : null}<span>{task.rotation ? isSwimmingTraining(task) ? '独立安排' : '参与轮换' : '按需选择'}</span>{task.notes && <p>{task.notes}</p>}</div>
          <button type="button" disabled={busy} aria-label={`编辑${task.name}`} onClick={() => {
            setItem({ key: trainingIdentity(task), name: task.name, notes: task.notes, rotation: task.rotation ?? true, tags: task.tags }); setError(''); setDiscarding(false);
          }}>编辑</button>
        </li>)}</ul>
        <button type="button" className="life-project-add" disabled={busy || draft.projects.length >= 60} onClick={() => {
          setItem({ key: crypto.randomUUID(), name: '', notes: '', rotation: false }); setError(''); setDiscarding(false);
        }}>＋ 添加项目</button>

      </>}
      {error && <p role="alert" className="life-error">{error}</p>}
      </div>
      {item ? <div className="life-editor-actions"><button type="button" onClick={() => { setItem(null); setError(''); }}>取消编辑</button><button type="submit" className="life-primary">完成编辑</button></div> : <>
        <div className="life-editor-actions"><button type="button" disabled={busy} onClick={close}>{discarding ? '放弃修改' : '取消'}</button>
          <button type="submit" className="life-primary" disabled={busy}>{busy ? '保存中…' : '保存项目'}</button></div>
      </>}
    </form>
  </dialog>;
}
