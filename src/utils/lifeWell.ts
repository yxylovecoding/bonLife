import { parseLifeEdit, type LifeEntries, type LifeEntry, type LifeView } from './bonLife.js';
import { EMPTY_MAKEUP, parseMakeupRecord, type MakeupRecord } from './lifeMakeup.js';
import { isCalendarDate } from './outlookCalendar.js';

export const WELL_KINDS = ['skin', 'eyes', 'discomfort', 'mood'] as const;
export type WellKind = typeof WELL_KINDS[number];
export type WellEntries = Record<WellKind, LifeEntry>;
export interface WellDay { entries: WellEntries; makeup: MakeupRecord }
export interface WellEdit { date: string; mutationId: string; entries: Partial<WellEntries>; makeup?: MakeupRecord }
export const isWellKind = (value: unknown): value is WellKind => WELL_KINDS.includes(value as WellKind);
export function wellView(value: LifeView): LifeView { return isWellKind(value) ? 'well' : value; }

export function wellDay(entries: LifeEntries, date: string): WellDay {
  return {
    entries: Object.fromEntries(WELL_KINDS.map(kind => {
      const { makeup: _makeup, ...entry } = entries[`${kind}:${date}`] ?? { text: '', revision: '' };
      return [kind, entry];
    })) as WellEntries,
    makeup: entries[`skin:${date}`]?.makeup ?? entries[`eyes:${date}`]?.makeup ?? { ...EMPTY_MAKEUP },
  };
}

export function parseWellEdit(value: unknown): WellEdit {
  const input = value as WellEdit;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !isCalendarDate(input.date)
    || typeof input.mutationId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.mutationId)
    || !input.entries || typeof input.entries !== 'object' || Array.isArray(input.entries)
    || !Object.keys(input.entries).every(isWellKind)) throw new Error('记录内容无效');
  const entries: Partial<WellEntries> = {};
  for (const kind of WELL_KINDS) {
    const raw = input.entries[kind];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'makeup' in raw
      || Object.keys(raw).some(key => !['text', 'revision', kind === 'mood' ? '' : kind].includes(key))) throw new Error('记录内容无效');
    const { date: _date, year: _year, kind: _kind, mutationId: _id, ...entry } = parseLifeEdit({ ...raw, kind, date: input.date, mutationId: input.mutationId });
    entries[kind] = entry;
  }
  const makeup = input.makeup === undefined ? undefined : parseMakeupRecord(input.makeup);
  if (!Object.keys(entries).length && !makeup) throw new Error('没有修改的记录');
  return { date: input.date, mutationId: input.mutationId, entries, ...(makeup ? { makeup } : {}) };
}
