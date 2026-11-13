export const SCHEDULING_RULES = [
  ['calendar-travel', 'Outlook 出游', '有效全天出游日程标记为旅；月经和节假日提醒不作为行程。', 'calendar'],
  ['calendar-manual', '手动日历标记', '与 Outlook 同日标记冲突时保留手动选择。', 'calendar'],
  ['calendar-home', 'Outlook 回家', '按已设置的回家标题标记为寄。', 'calendar'],
  ['calendar-intern', 'Outlook 实习', '课日历的实习日程结合实习段、法定工休和出勤覆盖解析。', 'calendar'],
  ['visibility-location', '地点标签显隐', '检查地点子标签：城市与寄／居／旅同时满足才显示，同类标签满足任一即可；否则隐藏。', 'visibility'],
  ['visibility-sleep', '凌晨临时隐藏', '00:00–05:01 隐藏今日事、明日事和今日重要之事；按记录恢复。', 'visibility'],
  ['visibility-reading', '阅读显隐', '阅读及“而阅读📖是另一个🪝”在 20:00–次日 07:01 显示。', 'visibility'],
  ['visibility-hair', '洗头显隐', '洗头在北京时间 20:00 后显示，次日凌晨重新隐藏。', 'visibility'],
  ['visibility-night', '夜间 routine', '按自身开始时刻显隐，并维持高优先级；保留用户 routine 标签。', 'visibility'],
  ['visibility-timed', '具体时刻显隐', '有具体时刻的待办开始前隐藏，到点显示。', 'visibility'],
  ['eye-drops', '眼药水过期项', '今天多条眼药水已到点时，保留最近到期的一条，较早的按原周期顺延。', 'date'],
  ['template-content', '出门与搬家模板内容', '对齐十组模板内容，再同步已有搬家实例；保留标签、父子关系和完成进度。', 'generation'],
  ['moving-date', '搬家阶段日期', '按搬家标题日期安排各阶段和后代，保留原时刻与重复规则。', 'date'],
  ['scene-eligibility', '地点规则', '地点下全部子标签共同决定可执行日期；同类满足任一，城市与寄／居／旅同时满足，子任务使用自身标签。', 'date'],
  ['always-today', '固定今日', '先满足城市与寄／居／旅地点条件，再固定今天；地点不符时移到最近适用日，当天已完成的重复系列保留下一次日期。', 'date'],
  ['swimming', '游泳与经期', '游泳避开经期；需要跟随洗头的游泳安排在可用洗头日。', 'date'],
  ['exercise', '训练轮换', '依据实际完成记录安排滚动训练，遵守完整地点规则与恢复期。', 'date'],
  ['exercise-rollover', '夜间训练顺延', '已错过的训练按原重复规则顺延，游泳仍使用非经期洗头日。', 'date'],
  ['laundry-appointment', '洗衣手动时段', '已有唯一关联的 Outlook 洗衣预约被手动改到同日其他时刻时保留当前日期。', 'date'],
  ['laundry-travel', '出行前洗衣', '洗衣周期目标位于行程内时移到出行前一天；错过时保留等待补做。', 'date'],
  ['laundry', '洗衣天气排期', '依据实际完成周期，在目标日前一天至后两天结合地点、天气和空档选日，缺少可用数据时保留日期。', 'date'],
  ['sprays', '喷雾错开', '香香喷雾与除螨喷雾不同日，已完成记录占用当天，较久未完成者优先。', 'date'],
  ['hair-follow', '洗头日期跟随', '带洗头标签的准备项跟随洗头周期，同时满足自身地点；游泳避开经期。', 'date'],
  ['important', '重要事项预留', '今日未完成的重要事项优先预留时间；与实际日程重叠的时间不重复扣除。', 'selection'],
  ['minimum-interval', '最短重复间隔', 'at-least 任务不到周期目标日不提前补入。', 'selection'],
  ['oldest', '最久未做优先', '无完成记录优先，其余按上次实际完成时间排序；不以最近完成的短任务挤占轮换。', 'selection'],
  ['urgency', '周期与截止紧迫度', '周期到期、截止临近或下一可执行日晚于截止日的任务优先。', 'selection'],
  ['daily-plan', '普通今日事轮换', '按连续空档挑选普通任务。今日事项因时间不足落选时加 hidden，再次入选时恢复。', 'date'],
  ['repeat-date', '长周期日期保留', '满足完整地点规则且属于居／旅时，保留 TickTick 的长周期下一次日期。', 'date'],
  ['scene-date', '最近适用地点日', '按地点下全部子标签查找最近适用日；城市与寄／居／旅同时满足，找不到日期时保留原安排。', 'date'],
  ['trips', '出行模板', '按行程日期生成准备阶段与后代；保留已生成阶段的手动日期。', 'generation'],
  ['wishes', '心愿准备', '独立心愿按截止日前七个自然月生成准备阶段及后代。', 'generation'],
  ['period-reminder', '月经提醒', '预计开始前两天提醒，同一周期已完成后不重复补建。', 'generation'],
  ['vehicle-pickup', '充电次日接车', '充电固定一小时，接车优先调整原待办；缺少时补齐当天、活标签的待办。', 'generation'],
  ['rain-reminder', '雨天关窗', '早晨首轮按 boncal 当天城市查雨，有雨生成最高优先级的 08:00 关窗提醒，同日不重复。', 'generation'],
  ['outlook-laundry', 'Outlook 洗衣', '跟随最终洗衣日期，预约 50 分钟；同日手动改时保留，缺失时查重恢复。', 'outlook'],
  ['outlook-charging', 'Outlook 充电', '与电动车充电待办的开始、结束时间一致。', 'outlook'],
  ['outlook-hair', 'Outlook 洗头', '跟随洗头待办日期，默认 22:00–22:30；同日手动改时保留。', 'outlook'],
  ['outlook-pickup', 'Outlook 接车', '与接电动车待办的开始、结束时间一致。', 'outlook'],
] as const;

export type SchedulingRuleId = typeof SCHEDULING_RULES[number][0];
export interface SchedulingRuleGroup { id: string; name: string; rules: SchedulingRuleId[] }
export interface SchedulingRuleConfig {
  version: number;
  order: SchedulingRuleId[];
  predecessors: Partial<Record<SchedulingRuleId, SchedulingRuleId[]>>;
  /** Older clients/configurations have no groups; reads migrate without changing priority. */
  groups?: SchedulingRuleGroup[];
  names?: Partial<Record<SchedulingRuleId, string>>;
  tags?: Partial<Record<SchedulingRuleId, string[]>>;
  removed?: SchedulingRuleId[];
}
export interface SchedulingRuleResult {
  id: SchedulingRuleId;
  status: 'success' | 'failed' | 'skipped';
  matched: number;
  updated: number;
  reason?: string;
  /** A successful rule may commit an independent subset while preserving these tasks. */
  deferred?: number;
  conflicts?: { taskId: string; winner: SchedulingRuleId; field: string }[];
}
export interface SchedulingRun {
  version: number;
  generatedAt: string;
  scope: 'full' | 'hourly' | 'visibility';
  order: SchedulingRuleId[];
  results: SchedulingRuleResult[];
  groups?: SchedulingRuleGroup[];
  names?: Partial<Record<SchedulingRuleId, string>>;
  calendar?: { state: 'fresh' | 'unavailable' | 'saved'; checkedAt: string; provider?: 'outlook' | 'google' };
}
export const ruleIds = SCHEDULING_RULES.map(rule => rule[0]);
export const ruleTitle = (id: SchedulingRuleId, config?: Pick<SchedulingRuleConfig, 'names'>) => config?.names?.[id] ?? SCHEDULING_RULES.find(rule => rule[0] === id)?.[1] ?? id;
export const activeRuleOrder = (config: SchedulingRuleConfig) => config.order.filter(id => !config.removed?.includes(id));
const defaultPredecessors: SchedulingRuleConfig['predecessors'] = { 'moving-date': ['template-content'], 'outlook-pickup': ['vehicle-pickup'] };
export const defaultRuleConfig = (): SchedulingRuleConfig => ({ version: 0, order: [...ruleIds], predecessors: structuredClone(defaultPredecessors) });

function initialGroups(order: SchedulingRuleId[]): SchedulingRuleGroup[] {
  const sections = ['日历场景', '待办显隐', '模板整理', '任务排期', '待办生成', 'Outlook 日程'];
  const section = (id: SchedulingRuleId) => {
    const index = ruleIds.indexOf(id);
    return index < 4 ? 0 : index < 10 ? 1 : index < 13 ? 2 : index < 30 ? 3 : index < 35 ? 4 : 5;
  };
  const groups: SchedulingRuleGroup[] = [], counts = new Map<number, number>();
  let previous = -1;
  for (const id of order) {
    const current = section(id);
    if (current !== previous) {
      const count = (counts.get(current) ?? 0) + 1; counts.set(current, count);
      groups.push({ id: `group-${current}-${count}`, name: sections[current] + (count > 1 ? `（${count}）` : ''), rules: [] });
      previous = current;
    }
    groups[groups.length - 1].rules.push(id);
  }
  return groups.length ? groups : [{ id: 'group-empty', name: '规则', rules: [] }];
}

function stableTopology<T extends string>(ids: T[], parents: (id: T) => T[], title: (id: T) => string, prefix: string): T[] {
  const visited = new Set<T>(), visiting: T[] = [];
  const visit = (id: T) => {
    if (visited.has(id)) return;
    const cycle = visiting.indexOf(id);
    if (cycle >= 0) throw new Error(`${prefix}：${[...visiting.slice(cycle), id].map(title).join(' → ')}`);
    visiting.push(id); parents(id).filter(p => ids.includes(p)).forEach(visit);
    visiting.pop(); visited.add(id);
  };
  ids.forEach(visit);
  const result: T[] = [];
  while (result.length < ids.length) {
    const next = ids.find(id => !result.includes(id) && parents(id).every(p => !ids.includes(p) || result.includes(p)));
    if (next === undefined) throw new Error('规则依赖无法排序');
    result.push(next);
  }
  return result;
}

function normalizeGroups(raw: SchedulingRuleConfig, config: SchedulingRuleConfig): SchedulingRuleGroup[] {
  if (raw.groups === undefined) return initialGroups(activeRuleOrder(config));
  if (!Array.isArray(raw.groups) || !raw.groups.length || raw.groups.length > 64) throw new Error('规则分组无效');
  const groups: SchedulingRuleGroup[] = [], groupIds = new Set<string>(), names = new Set<string>(), assigned = new Set<SchedulingRuleId>();
  for (const value of raw.groups) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)
      || groupIds.has(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 30
      || names.has(value.name.trim().toLowerCase()) || !Array.isArray(value.rules)) throw new Error('分组名称须为 1–30 字且不能重复');
    groupIds.add(value.id); names.add(value.name.trim().toLowerCase());
    for (const id of value.rules) {
      if (!ruleIds.includes(id) || assigned.has(id) || config.removed?.includes(id)) throw new Error('分组包含未知、重复或已删除规则');
      assigned.add(id);
    }
    groups.push({ id: value.id, name: value.name.trim(), rules: [...value.rules] });
  }
  if (raw.order.some(id => !config.removed?.includes(id) && !assigned.has(id))) throw new Error('每条规则都必须归入一个分组');
  // New catalogue entries follow their nearest existing neighbour; saved groups stay intact.
  for (const id of activeRuleOrder(config).filter(id => !assigned.has(id))) {
    const index = config.order.indexOf(id), next = config.order.slice(index + 1).find(candidate => assigned.has(candidate));
    const previous = config.order.slice(0, index).reverse().find(candidate => assigned.has(candidate));
    const target = groups.find(group => group.rules.includes((next ?? previous)!)) ?? groups[0];
    target.rules.splice(next && target.rules.includes(next) ? target.rules.indexOf(next) : target.rules.length, 0, id); assigned.add(id);
  }
  const owner = new Map(groups.flatMap(group => group.rules.map(id => [id, group.id] as const)));
  const parents = (groupId: string) => [...new Set(groups.find(group => group.id === groupId)!.rules.flatMap(id =>
    (config.predecessors[id] ?? []).map(parent => owner.get(parent)!).filter(parent => parent !== groupId)))];
  const order = stableTopology(groups.map(group => group.id), parents, id => groups.find(group => group.id === id)!.name, '分组循环依赖，无法整组执行');
  return order.map(id => {
    const group = groups.find(group => group.id === id)!;
    return { ...group, rules: stableTopology(group.rules, id => config.predecessors[id] ?? [], id => ruleTitle(id, config), '循环依赖') };
  });
}

/** Missing IDs are new catalogue entries; unknown IDs are never silently executed. */
export function readRuleConfig(value: unknown): SchedulingRuleConfig {
  if (value === null || value === undefined) value = defaultRuleConfig();
  if (!value || typeof value !== 'object') throw new Error('规则配置无效');
  const raw = value as SchedulingRuleConfig;
  if (!Number.isSafeInteger(raw.version) || raw.version < 0 || !Array.isArray(raw.order)
    || raw.order.some(id => !ruleIds.includes(id)) || new Set(raw.order).size !== raw.order.length
    || !raw.predecessors || typeof raw.predecessors !== 'object' || Array.isArray(raw.predecessors)) throw new Error('规则配置无效');
  if (raw.removed !== undefined && (!Array.isArray(raw.removed) || raw.removed.some(id => !ruleIds.includes(id)) || new Set(raw.removed).size !== raw.removed.length)) throw new Error('已删除规则无效');
  const removed = [...raw.removed ?? []];
  if (raw.names !== undefined && (!raw.names || typeof raw.names !== 'object' || Array.isArray(raw.names))) throw new Error('规则名称无效');
  const names: SchedulingRuleConfig['names'] = {};
  for (const [id, name] of Object.entries(raw.names ?? {})) {
    if (!ruleIds.includes(id as SchedulingRuleId) || typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error('规则名称须为 1–40 字');
    names[id as SchedulingRuleId] = name.trim();
  }
  if (raw.tags !== undefined && (!raw.tags || typeof raw.tags !== 'object' || Array.isArray(raw.tags))) throw new Error('规则标签无效');
  const tags: NonNullable<SchedulingRuleConfig['tags']> = {};
  for (const [id, values] of Object.entries(raw.tags ?? {})) {
    if (!ruleIds.includes(id as SchedulingRuleId) || !Array.isArray(values)
      || values.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 30)) throw new Error('规则标签须为 1–30 字');
    const unique = [...new Set(values.map(tag => tag.trim()))];
    if (unique.length > 20) throw new Error('每条规则最多 20 个标签');
    if (unique.length) tags[id as SchedulingRuleId] = unique;
  }
  const order = [...raw.order];
  for (const id of ruleIds) {
    if (order.includes(id)) continue;
    const next = ruleIds.slice(ruleIds.indexOf(id) + 1).find(candidate => order.includes(candidate));
    order.splice(next ? order.indexOf(next) : order.length, 0, id);
  }
  const predecessors: SchedulingRuleConfig['predecessors'] = {};
  for (const [key, values] of Object.entries(raw.predecessors)) {
    const id = key as SchedulingRuleId;
    if (!ruleIds.includes(id) || !Array.isArray(values) || values.some(p => !ruleIds.includes(p))
      || new Set(values).size !== values.length) throw new Error('前序规则无效');
    if (values.includes(id)) throw new Error(`${ruleTitle(id)}不能将自己设为前序`);
    const removedParent = values.find(parent => removed.includes(parent));
    if (!removed.includes(id) && removedParent) throw new Error(`「${ruleTitle(id, { names })}」仍绑定已删除的「${ruleTitle(removedParent, { names })}」，请先解除前序`);
    predecessors[id] = [...values];
  }
  for (const id of ruleIds) if (!raw.order.includes(id) && defaultPredecessors[id]) predecessors[id] = defaultPredecessors[id]!.filter(parent => !removed.includes(parent));
  const config: SchedulingRuleConfig = { version: raw.version, order, predecessors, names, tags, removed };
  config.order = topologicalRules(config);
  config.groups = normalizeGroups(raw, config);
  config.order = [...config.groups.flatMap(group => group.rules), ...removed];
  return config;
}

export function topologicalRules(config: SchedulingRuleConfig): SchedulingRuleId[] {
  return stableTopology(config.order, id => config.predecessors[id] ?? [], id => ruleTitle(id, config), '循环依赖');
}

export function updateRuleGroups(config: SchedulingRuleConfig, groups: SchedulingRuleGroup[], strictOrder = false): SchedulingRuleConfig {
  const order = [...groups.flatMap(group => group.rules), ...config.removed ?? []], next = readRuleConfig({ ...config, groups, order });
  if (strictOrder && (next.order.some((id, index) => id !== order[index]) || next.groups!.some((group, index) => group.id !== groups[index].id)))
    throw new Error('不能越过绑定的前序或后序规则');
  return next;
}

export function assignRuleGroup(config: SchedulingRuleConfig, id: SchedulingRuleId, groupId: string): SchedulingRuleConfig {
  const groups = readRuleConfig(config).groups!;
  if (!groups.some(group => group.id === groupId) || !ruleIds.includes(id)) throw new Error('规则分组无效');
  if (groups.find(group => group.id === groupId)!.rules.includes(id)) return config;
  return updateRuleGroups(config, groups.map(group => ({ ...group,
    rules: [...group.rules.filter(rule => rule !== id), ...(group.id === groupId ? [id] : [])],
  })));
}

export function removeSchedulingRule(config: SchedulingRuleConfig, id: SchedulingRuleId): SchedulingRuleConfig {
  const current = readRuleConfig(config);
  if (!ruleIds.includes(id)) throw new Error('规则无效');
  const dependents = activeRuleOrder(current).filter(rule => current.predecessors[rule]?.includes(id));
  if (dependents.length) throw new Error(`「${dependents.map(rule => ruleTitle(rule, current)).join('、')}」仍绑定「${ruleTitle(id, current)}」，请先解除前序`);
  return updateRuleGroups({ ...current, removed: [...new Set([...current.removed ?? [], id])] },
    current.groups!.map(group => ({ ...group, rules: group.rules.filter(rule => rule !== id) })));
}

export function restoreSchedulingRule(config: SchedulingRuleConfig, id: SchedulingRuleId, groupId: string): SchedulingRuleConfig {
  const current = readRuleConfig(config);
  if (!current.removed?.includes(id) || !current.groups!.some(group => group.id === groupId)) throw new Error('规则分组无效');
  return updateRuleGroups({ ...current, removed: current.removed.filter(rule => rule !== id) },
    current.groups!.map(group => ({ ...group, rules: [...group.rules, ...(group.id === groupId ? [id] : [])] })));
}

export function moveSchedulingRule(config: SchedulingRuleConfig, from: number, to: number): SchedulingRuleConfig {
  const order = [...config.order];
  const [id] = order.splice(from, 1); order.splice(to, 0, id);
  const valid = Object.entries(config.predecessors).every(([child, parents]) => parents!.every(p => order.indexOf(p) < order.indexOf(child as SchedulingRuleId)));
  if (!valid) throw new Error('不能越过绑定的前序或后序规则');
  if (config.groups) {
    const groups = config.groups.map(group => ({ ...group, rules: order.filter(id => group.rules.includes(id)) }));
    if (groups.flatMap(group => group.rules).some((id, index) => id !== order[index])) throw new Error('跨组移动请修改规则分组');
    return updateRuleGroups(config, groups, true);
  }
  return { ...config, order };
}

export function ruleBefore(config: SchedulingRuleConfig, first: SchedulingRuleId, second: SchedulingRuleId) {
  return !config.removed?.includes(first) && !config.removed?.includes(second) && config.order.includes(first) && config.order.includes(second)
    && config.order.indexOf(first) < config.order.indexOf(second);
}
