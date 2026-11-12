import { createHash } from 'node:crypto';
import { hasHiddenTag } from './_ticktickHiddenTag.js';
import { kv } from './_accountKv.js';
import { DAILY_PLAN_KEY, estimateTaskMinutes, type DailyPlanState } from './_ticktickDailyPlan.js';
import type { DailyBriefing } from '../src/utils/dailyBriefing.js';
export type { DailyBriefing } from '../src/utils/dailyBriefing.js';
import { decryptTickTickToken, readAllTickTickTasks, routineTaskDate, TICKTICK_CONNECTION_KEY, TickTickOpenApiClient,
  type TickTickConnection, type TickTickTask } from './_ticktickTrips.js';
import { readTrainingSource } from './_lifeTraining.js';
import { readSwimmingCycle } from './_lifeSwimming.js';
import { shanghaiDay } from './_lifeDone.js';
import type { CycleSettings } from '../src/utils/bonLife.js';
import { CYCLE_GUIDANCE, cycleDay } from '../src/utils/lifeCycle.js';
import { isSwimmingTraining, recordedTrainingProjects, rollingTrainingPlan, trainingIdentity, trainingLibrary, type TrainingSource } from '../src/utils/lifeTraining.js';

const addDays = (date: string, count: number) => new Date(Date.parse(`${date}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
const minutesIn = (text: string) => {
  const match = text.match(/(?:^|[^\d])([1-9]\d{0,2})\s*(?:分钟|minutes?|mins?|m)(?![a-z0-9])/i);
  return match ? Math.min(480, Number(match[1])) : null;
};
export function buildTrainingBriefing(today: string, source: TrainingSource, cycle: CycleSettings, periods: string[]) {
  const library = trainingLibrary(source.tasks, source.settings);
  const initial = rollingTrainingPlan(Number(today.slice(0, 4)), Number(today.slice(5, 7)), today, source, cycle, periods, {});
  const last = new Map(initial.coverage.map(({ task, lastCompleted }) => [trainingIdentity(task), lastCompleted]));
  const projected = new Map<string, string>();
  const months = new Map([[today.slice(0, 7), initial]]);
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index);
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, rollingTrainingPlan(Number(date.slice(0, 4)), Number(date.slice(5, 7)), today, source, cycle, periods, {}));
    const record = months.get(month)!.plans.get(date)!;
    const phase = cycleDay(date, cycle, periods);
    const keys = recordedTrainingProjects(record, library);
    const selected = keys.map(key => library.find(task => trainingIdentity(task) === key)!).filter(Boolean);
    const completed = months.get(month)!.completedByDate.get(date);
    const recovery = months.get(month)!.recoveryByDate.get(date);
    const reasons: string[] = [];
    if (recovery) {
      reasons.push(recovery === 'consecutive' ? `${date === today ? '此前主训练已' : '按当前预排主训练将'}连续进行 3 天，安排恢复`
        : '主训练按每 7 天至少休息 2 天的设置安排恢复');
      for (const task of selected.filter(isSwimmingTraining)) reasons.push(completed?.has(trainingIdentity(task))
        ? `${task.name}已完成，不计入主训练轮换与恢复`
        : `${task.name}独立安排，跟随洗头日并避开经期，不受主训练休息影响`);
    }
    else if (record.completed) reasons.push('已完成，保留实际运动记录');
    else if (record.mode !== 'auto') reasons.push('保留你手动安排的内容');
    else if (record.effort === 'rest') reasons.push('你已选择休息');
    else if (record.effort === 'easy' || (phase?.phase === 'menstrual' && phase.day <= 3)) reasons.push('按当前强度与经期设置安排恢复活动');
    else if (selected.length) {
      for (const task of selected) {
        const key = trainingIdentity(task);
        if (completed?.has(key)) reasons.push(`${task.name}已完成，其他项目继续保留`);
        else if (isSwimmingTraining(task)) reasons.push(`${task.name}跟随洗头日并避开经期，可与当天运动并存`);
        else if (projected.has(key)) reasons.push(`${task.name}继续轮换；本次预排已在 ${projected.get(key)} 安排，后续仍按实际完成调整`);
        else reasons.push(last.get(key) ? `${task.name}上次实际完成于 ${last.get(key)}，本轮按最久未练优先`
          : `${task.name}尚无匹配的完成记录，优先补齐轮换项目`);
      }
    } else reasons.push(library.some((task) => task.rotation) ? '当前没有符合设置的项目，留作恢复' : '尚未启用轮换项目');
    if (!record.completed && phase?.phase === 'menstrual') reasons.push('按你的设置，经期内游泳顺延');
    if (!record.completed && record.mode === 'auto' && phase?.phase === 'lateLuteal') reasons.push('按黄体中晚期设置轻量，疲劳或不适时可进一步减量或休息');
    for (const key of keys) if (!completed?.has(key)) projected.set(key, date);
    let minutes = 0;
    if (record.effort !== 'rest' && !/^休息/.test(record.plan)) {
      minutes = selected.length ? selected.reduce((sum, task) => sum + (minutesIn(task.notes) ?? minutesIn(task.name) ?? 45), 0)
        : record.plan.includes('轻松散步 15 分钟') ? 20 : minutesIn(record.plan) ?? 30;
    }
    return { date, phase: phase ? `${phase.estimated ? '预计·' : ''}${CYCLE_GUIDANCE[phase.phase].label}` : '未设置周期',
      plan: record.plan || '暂无安排', minutes, reasons };
  });
}

export function buildTodayBriefing(tasks: TickTickTask[], plan: DailyPlanState | null, today: string): DailyBriefing['today'] {
  const decisions = new Map((plan?.briefing?.date === today ? plan.briefing.selected : []).map((item) => [JSON.stringify([item.projectId, item.id]), item]));
  const order = new Map([...decisions.keys()].map((key, index) => [key, index]));
  const position = (task: TickTickTask) => order.get(JSON.stringify([task.projectId, task.id])) ?? Number.MAX_SAFE_INTEGER;
  return tasks.filter((task) => (task.status ?? 0) === 0 && !task.completedTime && (task.priority ?? 0) < 5
    && routineTaskDate(task) === today && !hasHiddenTag(task)
    && !(task.tags ?? []).some((tag) => ['routine', '不关我事'].includes(tag.normalize('NFKC').trim().toLowerCase())))
    .sort((a, b) => position(a) - position(b))
    .map((task) => {
      const decision = decisions.get(JSON.stringify([task.projectId, task.id]));
      return { title: task.title, minutes: estimateTaskMinutes(task),
        reasons: decision?.title === task.title ? decision.reasons : [task.isAllDay === false ? '按 TickTick 中的原定时间执行'
          : 'TickTick 当前安排在今天；暂无匹配的自动挑选记录'] };
    });
}

export async function readDailyBriefing(now = new Date()): Promise<DailyBriefing> {
  const today = shanghaiDay(now);
  const year = Number(today.slice(0, 4));
  const [connection, saved, source, { cycle, periods }] = await Promise.all([
    kv.get<TickTickConnection>(TICKTICK_CONNECTION_KEY), kv.get<DailyPlanState>(DAILY_PLAN_KEY), readTrainingSource(year),
    readSwimmingCycle([year, Number(addDays(today, 6).slice(0, 4))]),
  ]);
  if (!connection) throw new Error('TickTick 未连接，无法生成每日简报');
  const token = decryptTickTickToken(connection.encryptedToken, (process.env.SYNC_SECRET || '').trim());
  const plan = saved?.connectionId === createHash('sha256').update(token).digest('hex') ? saved : null;
  const api = new TickTickOpenApiClient(token, (process.env.TICKTICK_API_BASE_URL || '').trim() || undefined);
  const tasks = await readAllTickTickTasks(api, [0]);
  const latest = await kv.get<TickTickConnection>(TICKTICK_CONNECTION_KEY);
  if (latest?.encryptedToken.data !== connection.encryptedToken.data) throw new Error('连接已更新，请刷新简报');
  const warnings: string[] = [];
  if (plan?.briefing?.date !== today) warnings.push('今日事尚未完成今天的排期，请先刷新简报');
  if (!source.syncedAt || shanghaiDay(new Date(source.syncedAt)) !== today) warnings.push('运动完成记录尚未更新到今天，请先刷新简报');
  return { date: today, generatedAt: now.toISOString(), planGeneratedAt: plan?.briefing?.generatedAt, ready: !warnings.length, warnings,
    summary: plan?.summary?.date === today ? plan.summary : undefined,
    today: buildTodayBriefing(tasks, plan, today), training: buildTrainingBriefing(today, source, cycle, periods) };
}

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
export function renderDailyBriefing(report: DailyBriefing, email = false) {
  const when = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value));
  const reasons = (values: string[]) => values.map(escapeHtml).join('；');
  const time = (minutes: number) => minutes ? `约 ${minutes} 分钟` : '休息';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${report.date} 每日简报</title>
<style>body{max-width:1000px;margin:40px auto;padding:0 20px;font:14px/1.7 system-ui;color:#333;background:#fafaf7}h1{font-size:24px}h2{font-size:18px;margin-top:32px}table{width:100%;border-collapse:collapse}td,th{padding:12px 10px;text-align:left;border-bottom:1px solid #dedfd8;vertical-align:top}small,p{color:#666}button{background:#596953;color:white;border:0;padding:10px 20px;cursor:pointer}td{white-space:pre-line;overflow-wrap:anywhere}.warning{color:#984921}@media(max-width:600px){th,td{padding:8px 5px;font-size:12px}}</style></head>
<body><main data-briefing-ready="${report.ready}" data-date="${report.date}"><h1>${report.date} · 运动与今日事</h1><p>读取时间：${when(report.generatedAt)} · 北京时间${report.planGeneratedAt ? `<br>今日事排期时间：${when(report.planGeneratedAt)}` : ''}</p>
${email ? '<p><a href="https://www.bonbills.cn/life?view=briefing">查看最新计划</a></p>' : '<form method="post" action="/api/ticktick-trips?action=briefing"><button type="submit">刷新简报</button></form>'}
${report.warnings.map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join('')}
<h2>未来 7 天运动 · ${report.date}—${report.training.at(-1)?.date}</h2><table><thead><tr><th>日期 / 阶段</th><th>运动</th><th>预计用时</th><th>安排原因</th></tr></thead><tbody>${report.training.map((day) => `<tr><td>${day.date}<br><small>${escapeHtml(day.phase)}</small></td><td>${escapeHtml(day.plan)}</td><td>${time(day.minutes)}</td><td>${reasons(day.reasons)}</td></tr>`).join('')}</tbody></table>
<h2>今日事 · ${report.today.length} 项 · 约 ${report.today.reduce((sum, item) => sum + item.minutes, 0)} 分钟</h2>
${report.summary ? `<p>排期时可用时间约 ${report.summary.availableMinutes} 分钟，另有 ${report.summary.importantCount} 项重要事项。</p>` : ''}
${report.today.length ? `<table><thead><tr><th>事项</th><th>预计用时</th><th>入选原因</th></tr></thead><tbody>${report.today.map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${time(item.minutes)}</td><td>${reasons(item.reasons)}</td></tr>`).join('')}</tbody></table>` : '<p>今日事暂无待办。</p>'}
<p>时长均为预估；运动若已在今日事中列出，不重复相加。后续运动会随实际完成和经期记录更新。</p></main></body></html>`;
}
