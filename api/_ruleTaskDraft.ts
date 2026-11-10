import { randomUUID } from 'node:crypto';
import type { TickTickApi, TickTickTask } from './_ticktickTrips.js';
import type { SchedulingRuleId, SchedulingRuleResult } from '../src/utils/schedulingRules.js';
import { isHiddenTag, withHiddenTag } from './_ticktickHiddenTag.js';
import { hasNewTaskCompletion, isPendingTickTickTask as pending } from './_ticktickTaskState.js';

const fields = ['title', 'content', 'desc', 'startDate', 'dueDate', 'isAllDay', 'timeZone', 'reminders', 'tags', 'repeatFlag', 'repeatFrom', 'priority', 'sortOrder', 'kind', 'parentId', 'items'] as const;
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a ?? null)) === JSON.stringify(ordered(b ?? null));
const emptyDefault = (key: string, value: unknown) => value ?? (['content', 'desc', 'repeatFlag'].includes(key) ? '' : ['items', 'tags', 'reminders'].includes(key) ? [] : null);
const persistedField = (key: string, a: unknown, b: unknown): boolean => same(emptyDefault(key, a), emptyDefault(key, b))
  || key === 'items' && Array.isArray(a) && Array.isArray(b) && a.length === b.length && b.every((expected, index) => {
    const actual = a[index];
    if (!actual || !expected) return same(actual, expected);
    // TickTick adds checklist metadata/defaults and serializes dates in UTC.
    // Confirm every submitted field, including identity, order and progress.
    return Object.entries(expected).filter(([, value]) => value !== undefined).every(([field, value]) =>
      field === 'status' ? Number(actual[field] ?? 0) === Number(value ?? 0)
        || [1, 2].includes(Number(actual[field])) && [1, 2].includes(Number(value))
        : persistedField(field, actual[field], value));
  })
  || key === 'tags' && Array.isArray(a) && Array.isArray(b) && same([...a].sort(), [...b].sort())
  || (key === 'startDate' || key === 'dueDate') && typeof a === 'string' && typeof b === 'string'
    && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
const dateFields = new Set<string>(['startDate', 'dueDate', 'isAllDay', 'timeZone', 'items']);
const group = (key: string) => dateFields.has(key) ? 'date' : key;
const ruleGroup = (id: SchedulingRuleId, key: string) => id === 'template-content' && key === 'items' ? 'template-items' : group(key);

function logChecklistDifference(actual: TickTickTask['items'], expected: TickTickTask['items']) {
  const metadata = new Set(['status', 'sortOrder', 'isAllDay', 'startDate', 'timeZone', 'completedTime']);
  const differences = (expected ?? []).flatMap((item, index) => Object.entries(item)
    .filter(([, value]) => value !== undefined)
    .filter(([field, value]) => !persistedField(field, (actual?.[index] as Record<string, unknown> | undefined)?.[field], value))
    .map(([field, value]) => ({ index, field,
      expected: metadata.has(field) ? value : '[redacted]',
      actual: metadata.has(field) ? (actual?.[index] as Record<string, unknown> | undefined)?.[field] ?? null : '[redacted]' })));
  console.warn('[ticktick-checklist-verification]', JSON.stringify({ expectedCount: expected?.length ?? 0,
    actualCount: actual?.length ?? 0, differences: differences.slice(0, 12) }));
}

function assignedChecklistIds(expected: TickTickTask['items'], actual: TickTickTask['items'], original: TickTickTask['items'] = []) {
  const ids: [string, string][] = [], known = new Set(original.map(item => item.id).filter(Boolean));
  if (!expected?.length || actual?.length !== expected.length || actual.some(item => !item.id)
    || new Set(actual.map(item => item.id)).size !== actual.length) return { items: expected, ids };
  const check = expected.map((item, index) => {
    if (known.has(item.id) || known.has(actual[index].id)) return item;
    const { id: _id, ...fields } = item; return fields;
  });
  if (!persistedField('items', actual, check)) return { items: expected, ids };
  return { items: expected.map((item, index) => {
    const realId = actual[index].id!;
    if (item.id && item.id !== realId) ids.push([item.id, realId]);
    return { ...item, id: realId };
  }), ids };
}

export class RuleTaskVerificationError extends Error {
  constructor(phase: 'before' | 'after', changedFields: string[]) {
    super(`${phase === 'before' ? '待办已变化，未写入' : '写后回读不一致'}（${changedFields.join('、')}）`);
  }
}

export function ruleTaskFailureReason(error: unknown): string {
  if (error instanceof RuleTaskVerificationError) return error.message;
  const status = error instanceof Error ? error.message.match(/TickTick (\d{3})\b/)?.[1] : undefined;
  return status ? `TickTick 请求失败（HTTP ${status}），已停止本规则后续写入` : '写入未确认，已停止本规则后续写入';
}

/** Per-rule branches never write upstream. Only the merged, verified result is committed. */
export class RuleTaskDraft {
  private original: Map<string, TickTickTask>;
  private tasks: Map<string, TickTickTask>;
  private owners = new Map<string, Map<string, SchedulingRuleId>>();
  private requiredRules = new Map<string, Set<SchedulingRuleId>>();
  private pendingSaves: { rule: SchedulingRuleId; save: () => Promise<unknown> }[] = [];
  readonly writeCounts = new Map<SchedulingRuleId, number>();
  private created = new Set<string>();
  private createdBy = new Map<string, SchedulingRuleId>();
  private committed = new Map<string, TickTickTask>();
  private removed = new Map<string, SchedulingRuleId>();
  private realIds = new Map<string, string>();
  constructor(private source: TickTickApi, tasks: TickTickTask[], private protectedDateTaskIds: ReadonlySet<string> = new Set()) {
    this.committed = new Map(tasks.map(t => [t.id, structuredClone(t)]));
    this.original = new Map(tasks.map(t => [t.id, structuredClone(t)]));
    this.tasks = new Map(tasks.map(t => [t.id, structuredClone(t)]));
  }
  committedValues() { return [...this.committed.values()].map(t => structuredClone(t)); }
  values() { return [...this.tasks.values()].map(t => structuredClone(t)); }
  dateOwner(taskId: string) { return this.owners.get(taskId)?.get('date'); }
  requireRule(id: SchedulingRuleId, taskIds: Iterable<string>) {
    for (const taskId of taskIds) {
      const rules = this.requiredRules.get(taskId) ?? new Set<SchedulingRuleId>();
      rules.add(id); this.requiredRules.set(taskId, rules);
    }
  }
  saveAfterCommit(rule: SchedulingRuleId, save: () => Promise<unknown>) { this.pendingSaves.push({ rule, save }); }
  // Explicit daily training visibility takes precedence for these planned tasks.
  // The ordinary commit path still verifies concurrency and every saved field.
  revealPlannedTraining(taskIds: Iterable<string>) {
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (!task || !pending(task) || this.protectedDateTaskIds.has(id)) continue;
      task.tags = withHiddenTag(task.tags, false);
      const owners = this.owners.get(id) ?? new Map<string, SchedulingRuleId>();
      owners.set('hidden', 'exercise'); this.owners.set(id, owners);
    }
  }
  resolveIds<T>(value: T, publishedOnly = false): T {
    const replace = (item: unknown): unknown => typeof item === 'string' ? this.realIds.get(item) ?? (publishedOnly && item.startsWith('draft-') ? undefined : item)
      : Array.isArray(item) ? item.map(replace).filter(value => value !== undefined) : item && typeof item === 'object'
        ? Object.fromEntries(Object.entries(item).map(([k, v]) => [this.realIds.get(k) ?? k, replace(v)]).filter(([key, value]) => value !== undefined && !(publishedOnly && typeof key === 'string' && key.startsWith('draft-')))) : item;
    return replace(value) as T;
  }
  protect(id: SchedulingRuleId, taskIds: Iterable<string>, field = 'date') {
    for (const taskId of taskIds) {
      const owners = this.owners.get(taskId) ?? new Map<string, SchedulingRuleId>();
      if (!owners.has(field)) owners.set(field, id);
      this.owners.set(taskId, owners);
    }
  }
  datesConfirmed(taskId: string) {
    const proposed = this.tasks.get(taskId), saved = this.committed.get(this.realIds.get(taskId) ?? taskId);
    return Boolean(proposed && saved && ['startDate', 'dueDate', 'isAllDay', 'timeZone'].every(key => persistedField(key, proposed[key as keyof TickTickTask], saved[key as keyof TickTickTask])));
  }
  branch(id: SchedulingRuleId, refineDateOwners: ReadonlySet<SchedulingRuleId> = new Set()) {
    const base = new Map(this.values().map(t => [t.id, t]));
    const branch = new Map([...base].map(([key, t]) => [key, structuredClone(t)]));
    const claims = new Set<string>();
    const api = new Proxy(this.source, { get: (target, key) => {
      if (key === 'filterTasks') return async (_ids: unknown, statuses: number[]) => [...branch.values()].filter(t => statuses.includes(t.status ?? 0)).map(t => structuredClone(t));
      if (key === 'getProjectData') return async (projectId: string) => ({ tasks: [...branch.values()].filter(t => t.projectId === projectId).map(t => structuredClone(t)) });
      if (key === 'getTask') return async (projectId: string, taskId: string) => {
        const task = branch.get(taskId);
        if (task) return structuredClone(task);
        if (base.has(taskId)) throw new Error('TickTick 404');
        if (this.removed.has(taskId)) throw new Error('待办已由前序规则移除');
        const loaded = await target.getTask(projectId, taskId);
        if (!loaded || loaded.id !== taskId || loaded.projectId !== projectId) throw new Error('补读待办身份未确认');
        if (pending(loaded)) {
          // TickTick may return soft-deleted records by ID. Only completed
          // history may legitimately be absent from its current collection.
          const current = await target.getProjectData(projectId);
          if (!current?.tasks?.some(task => task.id === taskId && task.projectId === projectId))
            throw new Error('补读待办不在当前清单，已保留原安排');
        }
        // Detail reads can recover historical tasks absent from the collection.
        // They are existing records, not creations; retain their original state
        // for the same concurrency and write verification as the initial snapshot.
        base.set(taskId, structuredClone(loaded)); branch.set(taskId, structuredClone(loaded));
        this.original.set(taskId, structuredClone(loaded)); this.tasks.set(taskId, structuredClone(loaded));
        this.committed.set(taskId, structuredClone(loaded));
        return structuredClone(loaded);
      };
      if (key === 'updateTask') return async (taskId: string, payload: Record<string, unknown>) => {
        const task = branch.get(taskId);
        if (!task) throw new Error('待办快照中不存在该任务');
        const next = { ...task, ...structuredClone(payload) } as TickTickTask;
        branch.set(taskId, next); return structuredClone(next);
      };
      if (key === 'createTask') return async (payload: Record<string, unknown>) => {
        const task = { ...structuredClone(payload), id: `draft-${randomUUID()}`, status: 0 } as TickTickTask;
        branch.set(task.id, task); return structuredClone(task);
      };
      if (key === 'deleteTask') return async (_projectId: string, taskId: string) => { branch.delete(taskId); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return {
      api,
      claimDates: (ids: Iterable<string>) => { for (const taskId of ids) claims.add(taskId); },
      reject: () => {
        for (const [taskId, task] of branch) {
          const before = base.get(taskId);
          if (!before) continue;
          const owners = this.owners.get(taskId) ?? new Map<string, SchedulingRuleId>();
          for (const key of fields) if (!same(task[key], before[key]) && !owners.has(ruleGroup(id, key))) owners.set(ruleGroup(id, key), id);
          this.owners.set(taskId, owners);
        }
      },
      accept: () => {
        const conflicts: NonNullable<SchedulingRuleResult['conflicts']> = [];
        let matched = 0;
        for (const [taskId, task] of branch) {
          const before = base.get(taskId);
          if (!before) { this.tasks.set(taskId, task); this.created.add(taskId); this.createdBy.set(taskId, id); matched++; continue; }
          const changed = fields.filter(key => !same(task[key], before[key]));
          if (!changed.length && !claims.has(taskId)) continue;
          const owners = this.owners.get(taskId) ?? new Map<string, SchedulingRuleId>();
          const next = structuredClone(this.tasks.get(taskId)!);
          for (const key of changed) {
            // Same-day abandonment is a user decision, above configurable rules.
            // Preserve the provider's next occurrence and its scheduling notes.
            if (this.protectedDateTaskIds.has(taskId) && (dateFields.has(key)
              || (key === 'content' || key === 'desc') && changed.some(field => dateFields.has(field)))) continue;
            if (key === 'tags') {
              const hidden = (tags: string[] | undefined) => (tags ?? []).filter(isHiddenTag);
              const nonHidden = (tags: string[] | undefined) => (tags ?? []).filter(t => !isHiddenTag(t));
              let hiddenTags = hidden(next.tags);
              if (!same(hidden(task.tags), hidden(before.tags))) {
                const owner = owners.get('hidden');
                if (owner && owner !== id) conflicts.push({ taskId, winner: owner, field: 'hidden' });
                else { hiddenTags = withHiddenTag([], hidden(task.tags).length > 0); owners.set('hidden', id); }
              }
              const other = same(nonHidden(task.tags), nonHidden(before.tags)) ? nonHidden(next.tags) : nonHidden(task.tags);
              next.tags = [...other, ...hiddenTags];
              continue;
            }
            const dateOwner = owners.get('date');
            if ((key === 'content' || key === 'desc') && id !== 'template-content' && dateOwner && dateOwner !== id
              && changed.some(key => key === 'dueDate' || key === 'startDate')) {
              conflicts.push({ taskId, winner: dateOwner, field: 'date' }); continue;
            }
            const owner = owners.get(ruleGroup(id, key));
            // Eye-drop deduplication consumes the day's slots produced by always-today.
            // Only a real alignment can be refined, never a failed rule's protected date.
            const alignedEyeDrop = id === 'eye-drops' && owner === 'always-today' && dateFields.has(key)
              && !this.datesConfirmed(taskId);
            // A final constraint may refine a compatible date proposal. Keep its
            // source rule as a write dependency, including on verification failure.
            const refinement = owner && dateFields.has(key) && refineDateOwners.has(owner);
            if (owner && owner !== id && !alignedEyeDrop && !refinement) { conflicts.push({ taskId, winner: owner, field: group(key) }); continue; }
            if (refinement) this.requireRule(owner!, [taskId]);
            Object.assign(next, { [key]: task[key] }); owners.set(ruleGroup(id, key), id);
          }
          if (claims.has(taskId) && !this.protectedDateTaskIds.has(taskId) && !owners.has('date')) owners.set('date', id);
          this.tasks.set(taskId, next); this.owners.set(taskId, owners); matched++;
        }
        for (const taskId of base.keys()) if (!branch.has(taskId)) {
          const owners = this.owners.get(taskId);
          const owner = id === 'template-content' && owners && [...owners.keys()].every(key => key === 'hidden')
            ? undefined : owners?.values().next().value;
          if (owner) conflicts.push({ taskId, winner: owner, field: 'task' });
          else { this.tasks.delete(taskId); if (this.created.delete(taskId)) this.createdBy.delete(taskId); else this.removed.set(taskId, id); matched++; }
        }
        return { matched, conflicts };
      },
    };
  }
  async commit(options?: {
    order: SchedulingRuleId[];
    allowed: (id: SchedulingRuleId) => boolean;
    beforeUpdate?: (task: TickTickTask) => Promise<void>;
    afterRule: (id: SchedulingRuleId) => Promise<void>;
    failed: (ids: SchedulingRuleId[], error: unknown) => void;
  }) {
    const changed = this.values().filter(task => !this.created.has(task.id) && fields.some(k => !same(task[k], this.original.get(task.id)?.[k])));
    const allowed = (id: SchedulingRuleId | undefined) => !id || !options || options.allowed(id);
    const ownerIds = (id: string) => [...new Set([...this.owners.get(id)?.values() ?? [], ...this.requiredRules.get(id) ?? []])];
    const validState = (fresh: TickTickTask, original: TickTickTask) => pending(fresh) && pending(original) && !hasNewTaskCompletion(fresh, original)
      || !pending(original) && same(fresh.status, original.status) && same(fresh.completedTime, original.completedTime)
        && ownerIds(original.id).every(id => id === 'template-content' || id === 'moving-date'
          || original.status === 2 && (id === 'trips' || id === 'wishes'));
    const verify = (fresh: TickTickTask | undefined, expected: TickTickTask, original: TickTickTask, phase: 'before' | 'after') => {
      const differences = !fresh ? ['task'] : [
        ...(!validState(fresh, original) ? ['status'] : []),
        ...(fresh.id !== expected.id || fresh.projectId !== expected.projectId ? ['identity'] : []),
        ...fields.filter(key => !persistedField(key, fresh[key], expected[key])),
      ];
      if (differences.length) {
        if (differences.includes('items')) logChecklistDifference(fresh?.items, expected.items);
        throw new RuleTaskVerificationError(phase, differences);
      }
    };
    const fail = (ids: SchedulingRuleId[], error: unknown) => { if (!options) throw error; options.failed(ids, error); };
    const rank = (id?: SchedulingRuleId) => id ? options?.order.indexOf(id) ?? 0 : 0;
    const commitAt = (id: string) => Math.max(0, ...ownerIds(id).map(rank), rank(this.createdBy.get(id)));
    const eligibleTask = (task: TickTickTask) => {
      const result = structuredClone(task), original = this.original.get(task.id);
      if (!original) return result;
      const owners = this.owners.get(task.id);
      for (const key of fields) if (!allowed(owners?.get(group(key)))) Object.assign(result, { [key]: original[key] });
      if ([...this.requiredRules.get(task.id) ?? []].some(rule => !allowed(rule))) {
        for (const key of [...dateFields, 'content', 'desc']) Object.assign(result, { [key]: original[key as keyof TickTickTask] });
      }
      if (owners?.has('template-items') && allowed(owners.get('template-items')) && !allowed(owners.get('date'))) {
        result.items = task.items?.map(item => {
          const old = original.items?.find(candidate => candidate.id === item.id);
          return { ...item, startDate: old?.startDate, isAllDay: old?.isAllDay, timeZone: old?.timeZone };
        });
      }
      if (!allowed(owners?.get('hidden'))) result.tags = [...(result.tags ?? []).filter(t => !isHiddenTag(t)),
        ...(original.tags?.filter(isHiddenTag) ?? [])];
      return result;
    };
    const validated = new Set<string>();
    for (const task of [...changed, ...[...this.removed.keys()].map(id => this.original.get(id)!)]) {
      try {
        const fresh = await this.source.getTask(task.projectId, task.id), original = this.original.get(task.id)!;
        verify(fresh, original, original, 'before');
        validated.add(task.id);
      } catch (error) { fail([...ownerIds(task.id), ...this.removed.has(task.id) ? [this.removed.get(task.id)!] : []], error); }
    }
    let updated = 0;
    const removalDepth = (taskId: string) => {
      const seen = new Set<string>();
      for (let id: string | undefined = taskId; id; id = this.original.get(id)?.parentId) {
        if (seen.has(id)) throw new Error('待删除任务存在循环父子关系');
        seen.add(id);
      }
      return seen.size;
    };
    // TickTick may cascade parent deletion. Verify/delete children first so a
    // cascade cannot make an untouched child's later verification fail.
    const removals = [...this.removed].sort(([a], [b]) => removalDepth(b) - removalDepth(a));
    const remaining = new Set(this.created), writes = new Set(changed.map(t => t.id));
    const stages = options?.order ?? [undefined];
    for (let index = 0; index < stages.length; index++) {
      const ready = () => [...remaining].find(id => (!options || commitAt(id) <= index) && !remaining.has(this.tasks.get(id)?.parentId ?? ''));
      let id: string | undefined;
      while ((id = ready())) {
        const task = this.tasks.get(id)!;
        remaining.delete(id);
        if (!allowed(this.createdBy.get(id))) continue;
        try {
          if (task.parentId?.startsWith('draft-') && !this.realIds.has(task.parentId)) throw new Error('母任务未创建');
          if (task.parentId) {
            const parent = await this.source.getTask(task.projectId, this.resolveIds(task.parentId));
            if (!parent || !pending(parent)) throw new Error('母任务已完成或不可用，停止补建子任务');
          }
          const payload: Record<string, unknown> = this.resolveIds({ projectId: task.projectId, ...Object.fromEntries(fields.filter(k => task[k] !== undefined).map(k => [k, task[k]])) });
          const saved = await this.source.createTask(payload);
          if (!saved?.id || saved.id.startsWith('draft-')) throw new Error('新待办创建结果未确认');
          this.realIds.set(id, saved.id);
          const confirmed = await this.source.getTask(saved.projectId ?? task.projectId, saved.id);
          // Only newly introduced checklist entries may receive server-assigned IDs.
          const assigned = assignedChecklistIds(payload.items as TickTickTask['items'], confirmed?.items);
          if (assigned.items) payload.items = assigned.items;
          const differences = !confirmed ? ['task'] : [
            ...(!pending(confirmed) ? ['status'] : []),
            ...fields.filter(key => payload[key] !== undefined && !persistedField(key, confirmed[key], payload[key])),
          ];
          if (differences.length) {
            if (differences.includes('items')) logChecklistDifference(confirmed?.items, payload.items as TickTickTask['items']);
            throw new RuleTaskVerificationError('after', differences);
          }
          for (const [requested, actual] of assigned.ids) this.realIds.set(requested, actual);
          this.committed.set(saved.id, confirmed);
          for (const entry of this.pendingSaves) if (entry.rule === this.createdBy.get(id)) await entry.save(); updated++; this.writeCounts.set(this.createdBy.get(id)!, (this.writeCounts.get(this.createdBy.get(id)!) ?? 0) + 1);
        } catch (error) { fail([this.createdBy.get(id)!], error); }
      }
      for (const taskId of [...writes]) {
        if (options && commitAt(taskId) > index) continue;
        writes.delete(taskId);
        if (!validated.has(taskId)) continue;
        const task = eligibleTask(this.tasks.get(taskId)!);
        const original = this.original.get(taskId)!;
        if (!fields.some(k => !same(task[k], original[k]))) continue;
        try {
          const fresh = await this.source.getTask(task.projectId, task.id);
          verify(fresh, original, original, 'before');
          const payload = this.resolveIds({ id: task.id, projectId: task.projectId,
            ...Object.fromEntries(fields.filter(k => task[k] !== undefined).map(k => [k, task[k]])) });
          await options?.beforeUpdate?.(task);
          await this.source.updateTask(task.id, payload);
          const saved = await this.source.getTask(task.projectId, task.id);
          const assigned = assignedChecklistIds(task.items, saved?.items, original.items);
          verify(saved, { ...task, items: assigned.items }, original, 'after');
          for (const [requested, actual] of assigned.ids) this.realIds.set(requested, actual);
          this.committed.set(taskId, saved); updated++;
          for (const owner of ownerIds(taskId).filter(allowed)) this.writeCounts.set(owner, (this.writeCounts.get(owner) ?? 0) + 1);
        } catch (error) { fail(ownerIds(taskId), error); }
      }
      for (const [taskId, owner] of removals) {
        if (options && owner !== stages[index] || !allowed(owner) || !validated.has(taskId)) continue;
        try {
          const original = this.original.get(taskId)!;
          const fresh = await this.source.getTask(original.projectId, taskId);
          verify(fresh, original, original, 'before');
          if (!pending(fresh)) throw new RuleTaskVerificationError('before', ['status']);
          await this.source.deleteTask(original.projectId, taskId);
          let remainingTask: TickTickTask | undefined;
          try { remainingTask = await this.source.getTask(original.projectId, taskId); }
          catch (error) { if (!(error instanceof Error) || !/\b404\b/.test(error.message)) throw error; }
          if (remainingTask) {
            // TickTick can keep returning the soft-deleted record by ID. A
            // successful DELETE is confirmed against both live collections;
            // absence from just one query (notably Inbox) is not sufficient.
            const [project, active] = await Promise.all([
              this.source.getProjectData(original.projectId), this.source.filterTasks(undefined, [0]),
            ]);
            if (!Array.isArray(project?.tasks) || !Array.isArray(active)
              || project.project && project.project.id !== original.projectId
              || [...project.tasks, ...active].some(task => task.id === taskId)) {
              throw new Error('待办删除结果未确认');
            }
          }
          this.committed.delete(taskId); updated++;
          this.writeCounts.set(owner, (this.writeCounts.get(owner) ?? 0) + 1);
        }
        catch (error) { fail([owner], error); }
      }
      if (options) await options.afterRule(stages[index]!);
    }
    if (remaining.size) throw new Error('新待办存在循环父子关系');
    // A failed generation branch must not publish unresolved temporary IDs.
    for (const entry of this.pendingSaves) if (allowed(entry.rule)) {
      try { await entry.save(); } catch (error) { fail([entry.rule], error); }
    }
    return updated;
  }
}
