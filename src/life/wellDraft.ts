import { isWellKind, parseWellEdit, WELL_KINDS, type WellDay, type WellEdit, type WellKind } from '../utils/lifeWell';
import { parseSymptomNames, reusableSymptom, symptomHistory, symptomKey, symptomObservations, type SymptomArea, type SymptomNames } from '../utils/lifeSymptoms';
import type { LifeEntries } from '../utils/bonLife';
import { readDraft, removeDraft } from './client';

export interface WellDraft extends WellDay {
  date: string;
  mutationId: string;
  changed: WellKind[];
  makeupChanged: boolean;
  names: Partial<Record<'eyes' | 'discomfort', SymptomNames>>;
  legacy: Partial<Record<WellKind, string>>;
}
export const wellDraftKey = (owner: string) => `bonlife:well-draft:v1:${encodeURIComponent(owner)}`;
export function readWellDraft(owner: string, date?: string): WellDraft | null {
  try {
    const value: WellDraft = JSON.parse(localStorage.getItem(date ? `${wellDraftKey(owner)}:${date}` : wellDraftKey(owner)) || 'null');
    if (!value || (date && value.date !== date) || !Array.isArray(value.changed) || !value.changed.every(isWellKind)
      || typeof value.makeupChanged !== 'boolean' || !value.names || !value.legacy) return null;
    parseWellEdit({ ...value, entries: value.entries });
    if (!WELL_KINDS.every(kind => Boolean(value.entries[kind]))) return null;
    for (const kind of ['eyes', 'discomfort'] as const) if (value.names[kind]) parseSymptomNames(value.names[kind], kind);
    return value;
  } catch { return null; }
}
export function saveWellDraft(owner: string, draft: WellDraft) {
  const value = JSON.stringify(draft);
  localStorage.setItem(`${wellDraftKey(owner)}:${draft.date}`, value);
  localStorage.setItem(wellDraftKey(owner), value);
}
export function createWellDraft(owner: string, date: string, current: WellDay): WellDraft {
  const saved = readWellDraft(owner, date);
  const draft: WellDraft = saved ?? { ...structuredClone(current), date, mutationId: crypto.randomUUID(),
    changed: [], makeupChanged: false, names: {}, legacy: {} };
  if (saved) {
    for (const kind of WELL_KINDS) if (!draft.changed.includes(kind)) draft.entries[kind] = structuredClone(current.entries[kind]);
    if (!draft.makeupChanged) draft.makeup = { ...current.makeup };
  }
  for (const kind of WELL_KINDS) {
    if (draft.changed.includes(kind)) continue;
    const old = readDraft(owner, { date, kind });
    if (!old) continue;
    draft.entries[kind] = { text: old.text, revision: old.revision,
      ...(kind !== 'mood' && old[kind] !== undefined ? { [kind]: old[kind] } : {}) };
    draft.changed.push(kind);
    draft.mutationId = crypto.randomUUID();
    draft.legacy[kind] = old.mutationId;
    if ((kind === 'eyes' || kind === 'discomfort') && old.symptomNames) draft.names[kind] = old.symptomNames;
    if (!draft.makeupChanged && old.makeup && (old.makeup.face !== current.makeup.face || old.makeup.eyes !== current.makeup.eyes)) {
      draft.makeup = old.makeup; draft.makeupChanged = true;
    }
  }
  return draft;
}
export function removeWellDraft(owner: string, draft: WellDraft) {
  // A newer draft in another window must survive this window's save/discard.
  for (const key of [`${wellDraftKey(owner)}:${draft.date}`, wellDraftKey(owner)]) {
    const raw = localStorage.getItem(key);
    if (raw) {
      const current = JSON.parse(raw) as WellDraft;
      if (current.date === draft.date && current.mutationId === draft.mutationId) localStorage.removeItem(key);
    }
  }
  for (const kind of WELL_KINDS) {
    const old = readDraft(owner, { date: draft.date, kind });
    if (old && old.mutationId === draft.legacy[kind]) removeDraft(owner, old);
  }
}
export function wellDraftEdit(draft: WellDraft, symptomEntries: LifeEntries): WellEdit {
  const entries: WellEdit['entries'] = {};
  for (const kind of draft.changed) {
    entries[kind] = { ...draft.entries[kind] };
    if (kind === 'eyes' || kind === 'discomfort') {
      const symptoms = { ...symptomObservations(kind, draft.entries[kind][kind]) };
      const history = symptomHistory(kind, symptomEntries);
      for (const [area, name] of Object.entries(draft.names[kind] ?? {})) {
        if (!name?.trim()) continue;
        const key = symptomKey(area as SymptomArea, name);
        symptoms[key] ??= reusableSymptom(area as SymptomArea, name, draft.date, history);
      }
      entries[kind] = { text: draft.entries[kind].text, revision: draft.entries[kind].revision, [kind]: { symptoms } };
    }
  }
  return parseWellEdit({ date: draft.date, mutationId: draft.mutationId, entries,
    ...(draft.makeupChanged ? { makeup: draft.makeup } : {}) });
}

export function rebaseWellDraft(draft: WellDraft, current: WellDay): WellDraft {
  return { ...draft, mutationId: crypto.randomUUID(),
    entries: Object.fromEntries(WELL_KINDS.map(kind => [kind, draft.changed.includes(kind)
      ? { ...draft.entries[kind], revision: current.entries[kind].revision } : current.entries[kind]])) as WellDay['entries'],
    makeup: draft.makeupChanged ? { ...draft.makeup, revision: current.makeup.revision } : current.makeup };
}
