import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { kv } from './_accountKv.js';
import { readRuleConfig, ruleTitle, type SchedulingRuleConfig, type SchedulingRuleId, type SchedulingRuleResult, type SchedulingRun } from '../src/utils/schedulingRules.js';
import { withActiveRule, withRulePolicy } from './_rulePolicy.js';

export const RULE_CONFIG_KEY = 'ticktick:rules:v1';
export const RULE_RUN_KEY = 'ticktick:rules:last-run:v1';
export const PLAN_RUN_KEY = 'ticktick:rules:last-plan-run:v1';
export class RuleDeferredError extends Error {
  constructor(reason = '日程订阅不可用，保留原安排') { super(reason); }
}
const CONFIG_LOCK = 'ticktick:rules:write-lock:v1';
export async function readSchedulingRules() {
  const stored = await kv.get(RULE_CONFIG_KEY);
  const config = readRuleConfig(stored);
  if (!stored) {
    const { decryptOutlookConnection } = await import('./_outlookCalendar.js');
    const { OUTLOOK_CONNECTION_KEY } = await import('./_outlookSync.js');
    const connection = await kv.get<{ encrypted: string }>(OUTLOOK_CONNECTION_KEY);
    let outlookFirst = false;
    try { outlookFirst = Boolean(connection && decryptOutlookConnection(connection.encrypted, (process.env.SYNC_SECRET || '').trim()).policy === 'outlook'); } catch { /* A broken source is reported by its rule, not by configuration reads. */ }
    if (outlookFirst) {
      config.order = config.order.filter(id => id !== 'calendar-manual');
      config.order.splice(config.order.indexOf('calendar-intern') + 1, 0, 'calendar-manual');
      return readRuleConfig({ ...config, groups: undefined });
    }
  }
  return config;
}
export class RuleConfigError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export async function saveSchedulingRules(value: unknown) {
  let next: SchedulingRuleConfig;
  try { next = readRuleConfig(value); } catch (error) { throw new RuleConfigError((error as Error).message); }
  const token = randomUUID();
  if (!await kv.set(CONFIG_LOCK, token, { nx: true, ex: 30 })) throw new RuleConfigError('规则正在保存，请重试', 409);
  try {
    const previous = await readSchedulingRules();
    if (previous.version !== next.version) throw new RuleConfigError('规则已在其他页面更新，请重新读取后修改', 409);
    next.version++;
    await kv.set(RULE_CONFIG_KEY, next);
    return next;
  } finally {
    await kv.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", [CONFIG_LOCK], [token]);
  }
}

export function schedulingRuleFailureReason(error: unknown): string {
  if (error instanceof RuleDeferredError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message === 'boncal 当天城市未确认' || message === '当天降雨预报未确认') return message;
  if (message === '待办快照中不存在该任务') return '已关联待办不在本轮快照中，已保留原安排';
  const status = message.match(/^TickTick (\d{3})\b/)?.[1];
  if (status) return `TickTick 读取失败（HTTP ${status}），已保留原安排`;
  if (message.startsWith('无法识别模板阶段') || message.includes('需要按整天设置')) return '模板阶段日期无法识别，已保留原安排';
  return error instanceof Error && /^(排期来源暂不可用|地点读取失败，保留当前显隐|模板范围未确认|模板暂不可用|经期来源暂不可用|存在多个洗头来源|数据未刷新|来源未确认|Outlook 订阅读取失败|眼药水重复规则不支持安全跳过，保留原任务|眼药水下一次日期无法确认，保留原任务|眼药水待办已变化，停止跳过|眼药水跳过结果未确认)$/.test(error.message) ? error.message : '本规则未完成，已保留受影响安排';
}

export type RuleHandler = () => Promise<Partial<Pick<SchedulingRuleResult, 'matched' | 'updated' | 'reason' | 'conflicts' | 'deferred'>> | void>;
export async function executeRuleGraph(config: SchedulingRuleConfig, scope: SchedulingRun['scope'], handlers: Partial<Record<SchedulingRuleId, RuleHandler>>,
  options: { save?: boolean; afterRule?: (id: SchedulingRuleId, successful: boolean) => Promise<void> } = {}) {
  config = readRuleConfig(config);
  const run: SchedulingRun = { version: config.version, scope, generatedAt: new Date().toISOString(), order: [...config.order], groups: structuredClone(config.groups), names: { ...config.names }, results: [] };
  const unavailable = new Set<SchedulingRuleId>();
  await withRulePolicy(config, async () => {
    for (const id of config.order) {
      // Resolved async handlers otherwise form an uninterrupted microtask chain.
      // Let health checks and other requests run between independent rule stages.
      await yieldToRequests();
      const failedParent = (config.predecessors[id] ?? []).find(parent => unavailable.has(parent));
      if (config.removed?.includes(id) || failedParent || !handlers[id]) {
        unavailable.add(id);
        run.results.push({ id, status: 'skipped', matched: 0, updated: 0,
          reason: config.removed?.includes(id) ? '已删除，不执行' : failedParent ? `前序「${ruleTitle(failedParent, config)}」未完成` : '不在本次执行范围' });
        await options.afterRule?.(id, false);
        continue;
      }
      const started = Date.now();
      console.info('[scheduling-rule]', JSON.stringify({ id, phase: 'start', scope }));
      try {
        const result = await withActiveRule(id, handlers[id]!);
        if (result?.deferred) unavailable.add(id);
        await options.afterRule?.(id, true);
        run.results.push({ id, status: 'success', matched: 0, updated: 0, ...result });
      } catch (error) {
        unavailable.add(id);
        console.warn('[scheduling-rule-failure]', JSON.stringify({ id, reason: schedulingRuleFailureReason(error) }));
        await options.afterRule?.(id, false);
        run.results.push({ id, status: error instanceof RuleDeferredError ? 'skipped' : 'failed', matched: 0, updated: 0, reason: schedulingRuleFailureReason(error) });
      } finally { console.info('[scheduling-rule]', JSON.stringify({ id, phase: 'end', scope, elapsedMs: Date.now() - started })); }
    }
  }, unavailable);
  if (options.save !== false) await kv.set(RULE_RUN_KEY, run);
  return run;
}
