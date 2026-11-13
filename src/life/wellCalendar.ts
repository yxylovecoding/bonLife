import { entrySummary, LIFE_LABELS, type LifeEntries } from '../utils/bonLife';
import { skinLocalPlanValues, skinPlanValues, skinSeason, type SkinSettings } from '../utils/lifeSkin';
import { resolveSkinRecord } from '../utils/lifeSkinProgress';
import { WELL_KINDS, wellDay } from '../utils/lifeWell';
import { lifeCalendarStripItems } from './calendarStrips';

export function wellCalendarDay(date: string, now: string, entries: LifeEntries, skinEntries: LifeEntries, settings: SkinSettings) {
  const day = wellDay(entries, date);
  const skin = day.entries.skin;
  const suggestion = date === now && !skin.revision ? resolveSkinRecord(date, settings, skinEntries) : undefined;
  const suggested = suggestion && ((suggestion.status && suggestion.planDay) || suggestion.acneMarks) ? { ...suggestion,
    ...(suggestion.status && suggestion.planDay ? skinPlanValues(settings, suggestion.status, suggestion.planDay, skinSeason(date)) : {}),
    ...skinLocalPlanValues(settings, suggestion) } : undefined;
  const display = { ...day.entries, skin: suggested ? { ...skin, skin: suggested } : skin };
  const summaries = WELL_KINDS.flatMap(kind => {
    const text = entrySummary(kind, display[kind]);
    return text ? [{ kind, text, label: LIFE_LABELS[kind] }] : [];
  });
  const strips = WELL_KINDS.flatMap(kind => lifeCalendarStripItems(kind, day.entries[kind]).map(item => ({ ...item,
    label: `${LIFE_LABELS[kind]} · ${item.label}` })));
  return { ...day, summaries, strips, suggested: Boolean(suggested) };
}
