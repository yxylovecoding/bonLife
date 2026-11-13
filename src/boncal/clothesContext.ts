import type { CalendarLocationDay } from '../utils/calendarWeather.js';
import type { ClothesDayContext, ClothesLocation } from '../clothes/types.js';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());

export function linkedClothesContext(context: ClothesDayContext, day?: CalendarLocationDay): ClothesDayContext {
  if (!day) return context;
  const chosen = context.location?.source === 'manual' || (context.location?.source === 'geo' && context.date <= today()) ? context.location : null;
  const location = chosen ?? (day.locations.length === 1 && !day.unresolved?.length ? day.locations[0] : null);
  return { ...context, location, timezone: location?.timezone ?? context.timezone,
    scene: context.scene ?? day.scene ?? null, active: context.active ?? day.active ?? null };
}

/** Legacy picker adapter; current pages use the shared day context. */
export function chooseLocation(context: ClothesLocation | null, located: ClothesLocation | null, lastManual: ClothesLocation | null) {
  return context && context.source !== 'geo' ? context : located ?? context ?? lastManual;
}
