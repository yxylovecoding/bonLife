import type { AppConfig, TagKind } from '../models/types.js';
import type { CalendarLocationDay } from '../utils/calendarWeather.js';
import type { OutlookAvailability, OutlookDayEvent, OutlookSnapshot } from './events.js';
import type { bonCalTrips } from './trips.js';

export const BONCAL_CONFIG_FIELDS = ['homeCity', 'schoolCity', 'schoolPeriods', 'internshipLegacyCity',
  'internshipEnabledFrom', 'internshipPeriods'] as const;
export const BONCAL_CALENDAR_FIELDS = ['tagMap', 'dayOverrides', 'holidayDataByYear', 'manualTagDates', 'outlookApplied',
  'outlookTravelTitles', 'outlookWishEvents', 'initializedFromRecords'] as const;
export const BONCAL_EDIT_FIELDS = ['tagMap', 'dayOverrides', 'manualTagDates', 'initializedFromRecords'] as const;
export const BONCAL_TRIP_FIELDS = ['tripTags', 'tripNotes', 'tripSplits'] as const;

export function pickFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(fields.filter(field => object[field] !== undefined).map(field => [field, object[field]]));
}
export function calendarConfig(config: unknown): Partial<AppConfig> { return pickFields(config, BONCAL_CONFIG_FIELDS); }

export interface BonCalContext {
  revision: string;
  startDate: string;
  endDate: string;
  calendar: Record<string, unknown> & { tagMap: Record<string, TagKind> };
  config: Partial<AppConfig>;
  tripSettings: Record<string, unknown>;
  days: Record<string, CalendarLocationDay & { tag: TagKind; location: import('../models/types.js').SceneCity | null }>;
  trips: ReturnType<typeof bonCalTrips>;
  events: OutlookDayEvent[];
  availability?: OutlookAvailability;
  sources: NonNullable<OutlookSnapshot['sources']>;
  status: { connected: boolean; stale: boolean; error?: string; syncedAt?: string };
}
