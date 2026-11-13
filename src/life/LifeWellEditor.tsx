import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { entrySummary, LIFE_LABELS, LIFE_TEXT_LIMIT, type LifeEntries, type LifeEntry } from '../utils/bonLife';
import { WELL_KINDS, type WellDay, type WellKind } from '../utils/lifeWell';
import { resolveSkinRecord } from '../utils/lifeSkinProgress';
import type { SkinSettings } from '../utils/lifeSkin';
import { symptomHistory, symptomObservations } from '../utils/lifeSymptoms';
import { makeupSummary } from '../utils/lifeMakeup';
import LifeMakeupFields from './LifeMakeupFields';
import LifeSkinFields from './LifeSkinFields';
import LifeSymptomFields from './LifeSymptomFields';
import { LifeError, lifeRequest } from './client';
import { createWellDraft, rebaseWellDraft, removeWellDraft, saveWellDraft, wellDraftEdit, type WellDraft } from './wellDraft';

export default function LifeWellEditor({ date, initial, owner, section, skinSettings, skinEntries, symptomEntries, onSave, onClose, onExpired }: {
  date: string; initial: WellDay; owner: string; section?: WellKind; skinSettings: SkinSettings;
  skinEntries: LifeEntries; symptomEntries: LifeEntries; onSave: (value: WellDay) => void; onClose: () => void; onExpired: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => createWellDraft(owner, date, initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<WellDay | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [clearing, setClearing] = useState<WellKind | null>(null);
  const [expanded, setExpanded] = useState<WellKind[]>([...WELL_KINDS]);
  const attempted = useRef(false);
  const backdrop = useRef(false);
  const dirty = draft.changed.length > 0 || draft.makeupChanged;
  const history = useMemo(() => ({ eyes: symptomHistory('eyes', symptomEntries), discomfort: symptomHistory('discomfort', symptomEntries) }), [symptomEntries]);
  // Explicitly cleared records remain empty. Suggestions are never persisted by a different section.
  const skin = draft.entries.skin.skin && Object.keys(draft.entries.skin.skin).length === 0 ? {}
    : resolveSkinRecord(date, skinSettings, skinEntries, draft.entries.skin.skin);

  function persist(next: WellDraft) {
    try { saveWellDraft(owner, next); return true; }
    catch { setError('草稿暂存失败，请保存后再关闭'); return false; }
  }
  function change(next: WellDraft) {
    const value = { ...next, mutationId: crypto.randomUUID() };
    setDraft(value); persist(value); setDiscarding(false); setClearing(null);
  }
  function changeEntry(kind: WellKind, fields: Partial<LifeEntry>, names = draft.names) {
    change({ ...draft, entries: { ...draft.entries, [kind]: { ...draft.entries[kind], ...fields } },
      changed: [...new Set([...draft.changed, kind])], names });
  }
  function dismiss() {
    if (busy || (dirty && !persist(draft))) return;
    onClose();
  }
  function cancel() {
    if (busy) return;
    if (dirty && !discarding) { setDiscarding(true); return; }
    try { removeWellDraft(owner, draft); } catch { setError('无法清除草稿，请重试'); return; }
    onClose();
  }
  function outside(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  useEffect(() => {
    dialog.current?.showModal();
    if (section) {
      const heading = dialog.current?.querySelector<HTMLElement>(`#well-section-${section}`);
      heading?.scrollIntoView({ block: 'start' }); heading?.focus({ preventScroll: true });
    }
  }, [section]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  async function save() {
    if (busy || attempted.current || !dirty || conflict) return;
    attempted.current = true; setBusy(true); setError(''); persist(draft);
    try {
      const edit = wellDraftEdit(draft, symptomEntries);
      const result = await lifeRequest<WellDay>('POST', { action: 'save-well', ...edit });
      try { removeWellDraft(owner, draft); } catch { /* Save succeeded; stale revisions protect the retained local draft. */ }
      onSave(result);
    } catch (cause) {
      if (cause instanceof LifeError && cause.status === 401) onExpired();
      else if (cause instanceof LifeError && cause.currentWell) setConflict(cause.currentWell);
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { setBusy(false); attempted.current = false; }
  }
  return <dialog ref={dialog} className="life-dialog life-well-editor" aria-labelledby="well-editor-title"
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onPointerDown={event => { backdrop.current = event.button === 0 && outside(event); }} onPointerCancel={() => { backdrop.current = false; }}
    onClick={event => { const close = backdrop.current && outside(event); backdrop.current = false; if (close) dismiss(); }}>
    <form className="persistent-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="life-editor-heading"><h2 id="well-editor-title">bonWell <span>{date.replace(/-/g, '.')}</span></h2></div>
      <div className="persistent-form-body">
        <LifeMakeupFields value={draft.makeup} busy={busy} onChange={makeup => change({ ...draft, makeup, makeupChanged: true })} />
        {WELL_KINDS.map(kind => <section className="life-well-section" key={kind} aria-labelledby={`well-section-${kind}`}>
          <div className="life-well-section-heading"><button id={`well-section-${kind}`} type="button" aria-expanded={expanded.includes(kind)} aria-controls={`well-fields-${kind}`}
            onClick={() => setExpanded(previous => previous.includes(kind) ? previous.filter(value => value !== kind) : [...previous, kind])}>
            {LIFE_LABELS[kind]} <span aria-hidden="true">{expanded.includes(kind) ? '⌄' : '›'}</span></button>
            <button type="button" disabled={busy} className="life-well-clear" title={`清空${LIFE_LABELS[kind]}`} aria-label={`清空${LIFE_LABELS[kind]}`}
              onClick={() => setClearing(clearing === kind ? null : kind)}>×</button></div>
          {clearing === kind && <div className="life-well-clear-actions"><span>清空{LIFE_LABELS[kind]}？</span>
            <button type="button" disabled={busy} onClick={() => { changeEntry(kind, { text: '', ...(kind === 'mood' ? {} : { [kind]: {} }) },
              kind === 'eyes' || kind === 'discomfort' ? { ...draft.names, [kind]: {} } : draft.names); }}>清空</button>
            <button type="button" onClick={() => setClearing(null)}>取消</button></div>}
          <div id={`well-fields-${kind}`} hidden={!expanded.includes(kind)}>
            {kind === 'skin' && <LifeSkinFields date={date} value={skin} entries={skinEntries} settings={skinSettings} busy={busy} onChange={value => changeEntry(kind, { skin: value })} />}
            {(kind === 'eyes' || kind === 'discomfort') && <LifeSymptomFields kind={kind} value={symptomObservations(kind, draft.entries[kind][kind])}
              names={draft.names[kind] ?? {}} history={history[kind]} date={date} busy={busy}
              onChange={(symptoms, names) => changeEntry(kind, { [kind]: { symptoms } }, { ...draft.names, [kind]: names })} />}
            <label className="life-field">{kind === 'mood' ? '情绪' : `${LIFE_LABELS[kind]}备注`}
              <textarea aria-label={`${LIFE_LABELS[kind]}记录`} rows={3} maxLength={LIFE_TEXT_LIMIT} placeholder="写几句话…" disabled={busy}
                value={draft.entries[kind].text} onChange={event => changeEntry(kind, { text: event.target.value })} /></label>
          </div>
        </section>)}
        {error && <p role="alert" className="life-error">{error}</p>}
        {conflict && <div className="life-conflict"><p>云端记录</p>
          <blockquote>{[makeupSummary(conflict.makeup).join(' · '), ...WELL_KINDS.map(kind => {
            const value = entrySummary(kind, conflict.entries[kind]); return value ? `${LIFE_LABELS[kind]}：${value}` : '';
          })].filter(Boolean).join('\n') || '（空白）'}</blockquote>
          <button type="button" onClick={() => { const next = rebaseWellDraft(draft, conflict); setDraft(next); persist(next); setConflict(null); setError(''); }}>保留我的修改并继续编辑</button></div>}
      </div>
      <div className="life-editor-actions"><button type="button" disabled={busy} onClick={cancel}>{discarding ? '放弃修改' : '取消'}</button>
        <button type="submit" className="life-primary" disabled={busy || !dirty || Boolean(conflict)}>{busy ? '保存中…' : '保存'}</button></div>
    </form>
  </dialog>;
}
