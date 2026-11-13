import type { SchedulingRun } from './schedulingRules';

const planDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
export function currentTickTickPlan(plan: TickTickPlanDetails | null | undefined, now = new Date()): TickTickPlanDetails | null {
  return plan?.date === planDay.format(now) ? plan : null;
}

export interface TickTickPlanTask {
  id: string;
  projectId: string;
  title: string;
  minutes: number;
  durationBasis?: string;
  reasons: string[];
}

export interface TickTickPlanDetails {
  rules?: SchedulingRun;
  date: string;
  generatedAt: string;
  selected: TickTickPlanTask[];
  // Older saved plans contain the selected tasks but no capacity snapshot.
  breakdown?: {
    clockRemainingMinutes: number;
    remainingWindows: { start: string; end: string }[];
    calendarEvents?: { title: string; start: string; end: string; overlapMinutes: number }[];
    windowMinutes: number;
    occupiedMinutes: number;
    freeMinutes: number;
    important: { id: string; projectId: string; title: string; minutes: number; additionalMinutes: number; durationBasis: string }[];
    importantAdditionalMinutes: number;
    importantReservationEnabled?: boolean;
    // Missing in legacy snapshots. These values are calculated by the scheduler.
    importantOccupiedMinutes?: number;
    freeAfterImportantMinutes?: number;
    fixedAdditionalMinutes: number;
    afterReservationsMinutes: number;
    bufferMinutes: number;
    allocationRatio: number;
    afterBufferMinutes: number;
    dailyLimitMinutes: number | null;
    completedTodayMinutes: number;
    dailyLimitReductionMinutes: number;
    newTaskCapacityMinutes: number;
    cycleTargetMinutes: number;
    selectionMode?: 'remaining-time';
    unallocatedMinutes?: number;
  };
}
