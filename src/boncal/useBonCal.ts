import type { TagKind } from '../models/types';
import { useMemo } from 'react';
import { useCalendarStore } from '../stores/calendarStore';
import { useConfigStore } from '../stores/configStore';
import { resolvedTagMap, type InternshipContext } from './daily';
import { useHolidayYears } from '../utils/holidays';

export function useLifeCalendar() {
  const config = useConfigStore(s => s.config);
  const rawTagMap = useCalendarStore(s => s.tagMap);
  const dayOverrides = useCalendarStore(s => s.dayOverrides);
  const years = useMemo(() => {
    const current = new Date().getFullYear(), values = new Set([current - 1, current, current + 1]);
    for (const date of Object.keys(rawTagMap)) values.add(Number(date.slice(0, 4)));
    for (const p of config.internshipPeriods ?? []) {
      const from = Number(p.startDate.slice(0, 4)), to = Number(p.endDate.slice(0, 4));
      if (to - from <= 10) for (let y = from - 1; y <= to + 1; y++) values.add(y);
    }
    return [...values].filter(y => y >= 2000 && y <= 2100).sort();
  }, [rawTagMap, config.internshipPeriods]);
  const { holidayWarning } = useHolidayYears(years);
  const holidayDataByYear = useCalendarStore(s => s.holidayDataByYear);
  const internship = useMemo<InternshipContext>(() => ({ config, dayOverrides, holidayDataByYear }), [config, dayOverrides, holidayDataByYear]);
  const tagMap = useMemo(() => resolvedTagMap(rawTagMap, internship), [rawTagMap, internship]);
  const countByTag = (month: string) => {
    const counts: Record<TagKind, number> = { school: 0, intern: 0, home: 0, travel: 0 };
    for (const [date, tag] of Object.entries(tagMap)) if (date.startsWith(`${month}-`)) counts[tag]++;
    return counts;
  };
  return { tagMap, rawTagMap, internship, holidayWarning, countByTag };
}
