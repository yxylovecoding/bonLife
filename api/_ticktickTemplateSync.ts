import { kv } from './_accountKv.js';
import { randomBytes } from 'node:crypto';
import { movingInstanceRoots, movingTaskTitle, movingTaskClosed, syncMovingInstance, type MovingTreeState } from './_ticktickMovingInstances.js';
import { readAllTickTickTasks, canonicalStageTitle, relativeStageDate, updateRoutineTaskDate, calendarDateInTimeZone, type TickTickTask, type TickTickApi } from './_ticktickTrips.js';

type Shared = { title: string; content: string; desc: string; kind: string; items: string[] };
type Pair = { ids: [string, string]; baseline?: Shared };
type State = { movingTrees?: Record<string, MovingTreeState>; departureDates?: Record<string, { suffix: string; date: string }>; pairs: Record<string, Pair>; movingInstances?: Record<string, Record<string, string>> };
const keys = ['🪥漱', '🧴护', '💄妆', '🛀浴', '📷相机', '🧥', '随身背包', '⚪小袋子', '⚫小袋子', '白色行李袋'];
const normalize = (s: string) => s.normalize('NFKC').replace(/[\uFE0E\uFE0F\s]/g, '');
const pinned = (title: string) => /📌[\uFE0E\uFE0F]?\s*$/u.test(title);
const unpin = (title: string) => title.replace(/📌[\uFE0E\uFE0F]?\s*$/u, '').trimEnd();
const prefix = (s: string) => s.match(/^[🎒🧳📦]+/u)?.[0] ?? '';
const packingSuffix = (title: string) => title.match(/\s*(?:（(?:正装|小样)）|\((?:正装|小样)\))\s*$/u)?.[0] ?? '';
const withoutPackingSuffix = (title: string) => title.slice(0, title.length - packingSuffix(title).length);
const packingSpec = (title: string) => packingSuffix(unpin(title)).match(/正装|小样/u)?.[0];
const inferredPackingSpec = (title: string) => packingSpec(title)
  ?? (prefix(title) === '🧳' ? '小样' : prefix(title) === '📦' ? '正装' : undefined);
const specialContainerKey = (key: string) => key === '白色行李袋' || key.startsWith('白色行李袋:');
const shared = (t: TickTickTask, special: boolean, includePinned = false): Shared => ({
  title: special ? '' : withoutPackingSuffix(t.title).slice(prefix(t.title).length), content: t.content ?? '', desc: t.desc ?? '',
  kind: t.kind ?? 'TEXT', items: (t.items ?? []).filter(i => includePinned || !pinned(i.title)).map(i => i.title),
});
const stageKey = (key: string) => key.startsWith('stage:');
const sharedFor = (task: TickTickTask, key: string, includePinned = false): Shared => {
  const value = shared(task, specialContainerKey(key), includePinned);
  return stageKey(key) ? { ...value, title: '', content: '', desc: '', kind: 'CHECKLIST' } : value;
};

export function stageChecklistPairs(tasks: TickTickTask[], rootId: string, saved: State): Record<string, Pair> {
  const moving = tasks.filter(task => /^搬家模[板版]$/.test(task.title.trim()));
  if (moving.length !== 1) throw new Error('搬家模板缺失或重名');
  const sides = [rootId, moving[0].id].map(id => tasks.filter(task => task.parentId === id));
  const result: Record<string, Pair> = {};
  for (const name of new Set(sides[0].map(task => canonicalStageTitle(task.title)))) {
    const matches = sides.map(side => side.filter(task => canonicalStageTitle(task.title) === name));
    if (matches.some(side => side.length === 0) || matches.some(side => side.some(task => pinned(task.title)))) continue;
    if (matches.some(side => side.length !== 1)) throw new Error(`模板阶段“${name}”有多个匹配`);
    const key = `stage:${name}`, ids: [string, string] = [matches[0][0].id, matches[1][0].id];
    const old = saved.pairs[key];
    result[key] = { ids, ...(old && JSON.stringify(old.ids) === JSON.stringify(ids) ? { baseline: old.baseline } : {}) };
  }
  return result;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const version = (t: TickTickTask) => JSON.stringify(t);
const modified = (t: TickTickTask) => Date.parse((t as TickTickTask & { modifiedTime?: string }).modifiedTime ?? '');

export function movingDepartureDate(title: string, today: string): string | null {
  const match = /搬家-.+-(?:(\d{4})[.-])?(\d{1,2})[.](\d{1,2})$/.exec(title.trim());
  if (!match || !match[3]) return null;
  const date = `${match[1] || today.slice(0, 4)}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  if (!Number.isFinite(Date.parse(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new Error(`搬家标题日期无效：${title}`);
  return date;
}

export function templatePairs(tasks: TickTickTask[], rootId: string, saved: State): Record<string, Pair> {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const moving = tasks.filter(t => /^搬家模[板版]$/.test(t.title.trim()));
  if (!byId.has(rootId) || moving.length !== 1) throw new Error('模板同步：出门或搬家模板缺失／重名');
  const roots = [rootId, moving[0].id];
  const children = roots.map(root => tasks.filter(t => t.parentId && byId.get(t.parentId)?.parentId === root));
  return Object.fromEntries(keys.flatMap(key => {
    const old = saved.pairs[key];
    const previous = Object.entries(saved.pairs).filter(([name]) => name === key || name.startsWith(`${key}:`));
    const matchesCategory = (task: TickTickTask, side: number) => {
      if (previous.some(([, pair]) => pair.ids[side] === task.id)) return true;
      const title = normalize(withoutPackingSuffix(unpin(task.title)));
      return key === '白色行李袋'
        ? side === 0 ? /^🧳【[⚪🤍]】$/.test(title) : /^(?:📦|🧳)$/.test(title)
        : title.includes(key);
    };
    const candidates = children.map((list, side) => list.filter(task => matchesCategory(task, side)));
    // A labelled category opts into independent full-size/sample pairs. Never
    // reuse the legacy cross-container association while the second side is
    // still being populated, or a later sync could overwrite the wrong kit.
    if (candidates.some(list => list.some(task => packingSpec(task.title)))) {
      return ['正装', '小样'].flatMap(spec => {
        const matches = candidates.map(list => list.filter(task => inferredPackingSpec(task.title) === spec));
        if (matches.some(list => list.some(task => pinned(task.title)))) return [];
        if (matches.some(list => list.length > 1)) throw new Error(`模板同步：${key}（${spec}）有多个匹配`);
        if (matches.some(list => list.length === 0)) return [];
        const name = `${key}:${spec}`, ids: [string, string] = [matches[0][0].id, matches[1][0].id];
        const prior = saved.pairs[name] ?? old;
        const baseline = prior && equal(prior.ids, ids) && prior.baseline
          ? { ...prior.baseline, title: withoutPackingSuffix(prior.baseline.title), items: prior.baseline.items.filter(title => !pinned(title)) }
          : undefined;
        return [[name, { ids, ...(baseline ? { baseline } : {}) }]];
      });
    }
    if (candidates.some(list => list.some(task => pinned(task.title)))) {
      // A private legacy category may exist on only one side; do not require its counterpart.
      return [];
    }
    const ids = children.map((list, side) => {
      if (old && list.some(t => t.id === old.ids[side])) return old.ids[side];
      const matches = candidates[side];
      if (matches.length !== 1) throw new Error(`模板同步：${key} 缺失或有多个匹配`);
      return matches[0].id;
    }) as [string, string];
    return [[key, { ids, ...(old && equal(old.ids, ids) ? { baseline: old.baseline ? { ...old.baseline, items: old.baseline.items.filter(title => !pinned(title)) } : undefined } : {}) }]];
  }));
}

async function writeShared(api: TickTickApi, task: TickTickTask, value: Shared, key: string, includePinned = false) {
  const current = await api.getTask(task.projectId, task.id);
  if (!current || version(current) !== version(task)) throw new Error('待办在同步期间发生修改，请重试');
  const remaining = [...(task.items ?? [])];
  const items = value.items.map((title, index) => {
    const found = remaining.findIndex(i => i.title === title);
    const item = found >= 0 ? remaining.splice(found, 1)[0] : { id: randomBytes(12).toString('hex'), status: 0 };
    return { ...item, title, sortOrder: index };
  });
  if (!includePinned) {
    (task.items ?? []).forEach((item, index) => {
      if (pinned(item.title)) items.splice(Math.min(index, items.length), 0, { ...item, sortOrder: index });
    });
    items.forEach((item, index) => { item.sortOrder = index; });
  }
  const payload: Record<string, unknown> = { id: task.id, projectId: task.projectId };
  for (const field of ['title', 'content', 'desc', 'kind', 'items', 'parentId', 'isAllDay', 'startDate', 'dueDate', 'timeZone', 'reminders', 'tags', 'repeatFlag', 'repeatFrom', 'priority', 'sortOrder'] as const)
    if (task[field] !== undefined) payload[field] = task[field];
  if (stageKey(key)) Object.assign(payload, { items, ...(items.length ? { kind: 'CHECKLIST' } : {}) });
  else Object.assign(payload, { content: value.content, desc: value.desc, kind: value.kind, items,
    title: specialContainerKey(key) ? task.title : prefix(task.title) + value.title + packingSuffix(task.title) });
  await api.updateTask(task.id, payload);
  const verified = await api.getTask(task.projectId, task.id);
  if (!verified || !equal(sharedFor(verified, key, includePinned), value) || prefix(verified.title) !== prefix(task.title)
    || packingSuffix(verified.title) !== packingSuffix(task.title)
    || verified.parentId !== task.parentId
    || stageKey(key) && ['title', 'content', 'desc'].some(field => verified[field as keyof TickTickTask] !== task[field as keyof TickTickTask]))
    throw new Error('模板同步回读校验失败');

}

// Caller holds the shared TickTick write lock. Only template text is shared;
// stage dates, parent links, tags, progress and each container prefix stay local.
export async function syncTickTickTemplates(api: TickTickApi, rootId: string, connectionId: string,
  options: { mode?: 'content' | 'dates'; deferState?: (save: () => Promise<unknown>) => void; resolveIds?: (value: unknown) => unknown;
    completedTasks?: TickTickTask[]; requireCompletionHistory?: boolean } = {}) {
  const pendingSnapshots = new Map<string, unknown>();
  const save = async (key: string, value: unknown) => {
    const snapshot = structuredClone(value);
    if (options.deferState) {
      const registered = pendingSnapshots.has(key);
      pendingSnapshots.set(key, snapshot);
      if (registered) return;
      options.deferState(async () => {
        const snapshot = options.resolveIds ? options.resolveIds(pendingSnapshots.get(key)) : pendingSnapshots.get(key);
        if (key === storageKey) {
          const latest = await kv.get<State>(key), next = snapshot as State;
          return kv.set(key, options.mode === 'dates' ? { ...latest, pairs: latest?.pairs ?? {}, departureDates: next.departureDates }
            : { ...next, departureDates: latest?.departureDates ?? next.departureDates });
        }
        const latest = await kv.get<Record<string, unknown>>(key), next = snapshot as Record<string, unknown>;
        return kv.set(key, options.mode === 'dates' ? { ...latest, rootId, syncedAt: next.syncedAt, dateUpdated: next.dateUpdated, managedTaskIds: next.managedTaskIds, schedules: next.schedules }
          : { ...latest, ...next, dateUpdated: latest?.dateUpdated ?? 0, managedTaskIds: latest?.managedTaskIds ?? [], schedules: latest?.schedules ?? [] });
      });
    } else await kv.set(key, snapshot);
  };
  const storageKey = `ticktick:template-pairs:v1:${connectionId}:${rootId}`;
  const saved = await kv.get<State>(storageKey) ?? { pairs: {} };
  const tasks = await readAllTickTickTasks(api, [0, 2]);
  const pairs = options.mode === 'dates' ? {} : { ...templatePairs(tasks, rootId, saved), ...stageChecklistPairs(tasks, rootId, saved) };
  const byId = new Map(tasks.map(t => [t.id, t]));
  let updated = 0;
  const conflicts: string[] = [];
  for (const [key, pair] of Object.entries(pairs)) {
    const pairTasks = await Promise.all(pair.ids.map(id => api.getTask(byId.get(id)!.projectId, id)));
    if (pairTasks.some(t => !t)) throw new Error('模板任务已变化，请重试');
    if (pairTasks.some(task => pinned(task.title))) throw new Error('模板专属标记在同步期间发生变化，请重试');
    const values = pairTasks.map(t => sharedFor(t, key));
    let source = 0;
    if (stageKey(key) && !pair.baseline) {
      // Newly covered stages bootstrap by combining existing ordinary entries;
      // a newer edit of the stage note must not erase the other side's checklist.
      const items = [...values[0].items];
      const counts = new Map<string, number>();
      for (const title of values[1].items) {
        const count = (counts.get(title) ?? 0) + 1; counts.set(title, count);
        if (items.filter(item => item === title).length < count) items.push(title);
      }
      const value = { ...values[0], items };
      for (let side = 0; side < 2; side++) if (!equal(values[side], value)) {
        await writeShared(api, pairTasks[side], value, key); updated++;
      }
      pair.baseline = value; saved.pairs[key] = pair;
      await save(storageKey, saved);
      continue;
    }
    if (!equal(values[0], values[1])) {
      const changed = values.map(v => !pair.baseline || !equal(v, pair.baseline));
      if (changed[0] !== changed[1]) source = changed[0] ? 0 : 1;
      else {
        const times = pairTasks.map(modified);
        if (!times.every(Number.isFinite) || times[0] === times[1]) {
          if (pair.baseline) { conflicts.push(key); continue; }
          source = 0; // bon approved travel as the initial fallback on 2026-11-01.
        } else source = times[0] > times[1] ? 0 : 1;
      }
      const target = 1 - source, task = pairTasks[target], value = values[source];
      const fresh = await api.getTask(task.projectId, task.id);
      const sourceFresh = await api.getTask(pairTasks[source].projectId, pairTasks[source].id);
      if (version(fresh) !== version(task) || version(sourceFresh) !== version(pairTasks[source])) throw new Error('模板在同步期间发生修改，请重试');
      await writeShared(api, task, value, key);
      updated++;
    }
    pair.baseline = values[source];
    saved.pairs[key] = pair;
    await save(storageKey, saved);
  }
  if (conflicts.length) throw new Error(`模板内容有冲突且没有可比较的修改时间：${conflicts.join('、')}；需指定首次来源`);
  // Moving instances follow the resolved templates one way. They never feed
  // trip-specific text back into the reusable templates.
  let instanceUpdated = 0, instanceMatched = 0, dateUpdated = 0;
  const managedTaskIds: string[] = [];
  const schedules: { title: string; departureDate: string; stages: { title: string; date: string; tasks: number }[] }[] = [];
  saved.departureDates ??= {};
  saved.movingInstances ??= {};
  const movingRoots = movingInstanceRoots(tasks);
  if (movingRoots.length && options.mode !== 'dates' && options.requireCompletionHistory && !options.completedTasks)
    throw new Error('搬家完成记录未确认，暂停补建');
  const instanceSync = [];
  saved.movingTrees ??= {};
  const movingTemplate = tasks.find(task => /^搬家模[板版]$/.test(task.title.trim()));
  for (const root of options.mode === 'dates' ? [] : movingRoots) {
    if (!movingTemplate) throw new Error('搬家模板缺失');
    const tree = saved.movingTrees[root.id] ??= { name: root.title, taskIds: {}, itemIds: {} };
    // A specification migration replaces the active category pair, but legacy
    // instance IDs still belong to its original moving-template task.
    const legacyTaskIds = Object.fromEntries(Object.entries(saved.movingInstances[root.id] ?? {})
      .flatMap(([key, id]) => {
        const pair = saved.pairs[key] ?? pairs[key];
        return pair ? [[pair.ids[1], id]] : [];
      }));
    const parsed = movingDepartureDate(root.title, calendarDateInTimeZone(new Date().toISOString())!);
    const previous = saved.departureDates[root.id];
    const departureDate = previous?.suffix === root.title.trim().split('-').at(-1) ? previous.date : parsed;
    const result = await syncMovingInstance({ api, tasks, templateRoot: movingTemplate, root, state: tree,
      legacyTaskIds, departureDate, completedTasks: options.completedTasks, persist: () => save(storageKey, saved) });
    instanceSync.push(result); instanceMatched += result.matched; instanceUpdated += result.updated;
  }
  // Apply dates after text synchronization, using fresh tasks to retain new content.
  for (const root of options.mode === 'content' ? [] : movingRoots) {
    if (movingTaskClosed(root, tasks)) continue;
    const today = calendarDateInTimeZone(new Date().toISOString())!;
    const parsed = movingDepartureDate(root.title, today);
    if (!parsed) continue;
    const suffix = root.title.trim().split('-').at(-1)!;
    const previous = saved.departureDates[root.id];
    const departureDate = previous?.suffix === suffix ? previous.date : parsed;
    const stages = tasks.filter(t => t.parentId === root.id && !movingTaskClosed(t, tasks));
    const planned = stages.map(stage => {
      const date = relativeStageDate(movingTaskTitle(stage.title), departureDate);
      const descendants = [stage];
      const visited = new Set([stage.id]);
      for (let i = 0; i < descendants.length; i++) {
        for (const child of tasks.filter(t => t.parentId === descendants[i].id)) {
          if (visited.has(child.id)) throw new Error('搬家子任务存在循环关联');
          visited.add(child.id); descendants.push(child);
        }
      }
      return { stage, date, descendants };
    });
    const freshRoot = await api.getTask(root.projectId, root.id);
    if (!freshRoot || freshRoot.title !== root.title) throw new Error('搬家标题日期已变化，请重试');
    saved.departureDates[root.id] = { suffix, date: departureDate };
    await save(storageKey, saved);
    managedTaskIds.push(root.id);
    for (const { date, descendants } of planned) for (const task of descendants) {
      if (movingTaskClosed(task, tasks)) continue;
      const fresh = await api.getTask(task.projectId, task.id);
      if (!fresh || fresh.parentId !== task.parentId) throw new Error('搬家子任务层级已变化，请重试');
      if (await updateRoutineTaskDate(api, fresh, date, true, true)) dateUpdated++;
      managedTaskIds.push(task.id);
    }
    schedules.push({ title: root.title, departureDate, stages: planned.map(p => ({ title: p.stage.title, date: p.date, tasks: p.descendants.length })) });
  }
  const stageChecklists = Object.entries(pairs).filter(([key]) => stageKey(key)).map(([key, pair]) => ({ stage: key.slice(6), items: pair.baseline?.items ?? [] }));
  const result = { instanceSync, instanceCreated: instanceSync.reduce((sum, instance) => sum + instance.created, 0), stageChecklists, matched: Object.keys(pairs).length, updated, movingInstances: movingRoots.length, instanceMatched, instanceUpdated, dateUpdated, managedTaskIds, schedules };
  await save('ticktick:template-sync-status:v1', { ...result, rootId, syncedAt: new Date().toISOString(),
    instanceTitles: movingRoots.map(root => root.title) });
  return result;
}
