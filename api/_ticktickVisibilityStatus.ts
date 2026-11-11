import { kv } from './_accountKv.js';
import { visibilityInputs, visibilityRules, visibilityDecision, visibilityReleaseBlocker } from './_taskVisibilityRules.js';
import { readSchedulingRules, RULE_RUN_KEY } from './_schedulingRules.js';
import { hasHiddenTag } from './_ticktickHiddenTag.js';
import type { TickTickTask } from './_ticktickTrips.js';
import type { SchedulingRuleId, SchedulingRun } from '../src/utils/schedulingRules.js';

// Only expose the requested tasks' ownership records, never credentials or other tasks.
export async function inspectTickTickVisibility(tasks: TickTickTask[], options: {
  connectionId: string; projectId: string; today: string; calendarState: unknown; timeZone?: string; now?: Date;
}) {
  if (!tasks.length) return [];
  const [input, config, owned, budget, lastRun, trainingShownDate] = await Promise.all([
    visibilityInputs(options.projectId, options.today, options.calendarState), readSchedulingRules(),
    kv.get<Record<string, SchedulingRuleId>>(`ticktick:visibility-owned:v1:${options.connectionId}`),
    kv.get<Record<string, string>>(`ticktick:budget-hidden:v1:${options.connectionId}`),
    kv.get<SchedulingRun>(RULE_RUN_KEY),
    kv.get<string>(`ticktick:training-visible-day:v1:${options.connectionId}`),
  ]);
  const now = options.now ?? new Date();
  const enabled = config.order.filter(id => visibilityRules.includes(id) && !config.removed?.includes(id));
  return tasks.map(task => {
    const decisions = enabled
      .map(id => ({ rule: id, hidden: input.locations ? visibilityDecision(id, task, {
        ...input, now, timeZone: options.timeZone || 'Asia/Shanghai',
      }) : null })).filter(item => item.hidden !== null).map(item => ({ ...item,
        ...(item.hidden === false ? { releaseBlockedBy: visibilityReleaseBlocker(item.rule, task,
          { ...input, now, timeZone: options.timeZone || 'Asia/Shanghai' }, enabled) } : {}),
      }));
    return { hidden: hasHiddenTag(task), priority: task.priority,
      trainingShownDate: typeof trainingShownDate === 'string' ? trainingShownDate : null,
      locationSourceAvailable: Boolean(input.locations), decisions,
      recordedOwner: owned?.[task.id] ?? null, budgetHiddenDate: budget?.[task.id] ?? null,
      sleepRecord: input.journal[task.id] ?? null,
      lastRun: lastRun ? { generatedAt: lastRun.generatedAt, scope: lastRun.scope,
        results: lastRun.results.filter(r => visibilityRules.includes(r.id) || r.id === 'daily-plan')
          .map(r => ({ id: r.id, status: r.status, reason: r.reason,
            conflicts: r.conflicts?.filter(c => c.taskId === task.id) ?? [] })) } : null,
    };
  });
}
