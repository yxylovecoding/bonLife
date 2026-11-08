import { ruleTitle } from '../utils/schedulingRules';
import type { TickTickPlanDetails } from '../utils/tickTickPlanDetails';

const minuteText = (value: number) => `${Number(value.toFixed(1))} 分钟`;
const when = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
export default function LifePlanDetails({ plan }: { plan: TickTickPlanDetails }) {
  const b = plan.breakdown;
  const plannedMinutes = plan.selected.reduce((sum, task) => sum + task.minutes, 0);
  const importantTotalMinutes = b ? b.important.reduce((sum, task) => sum + task.minutes, 0) : 0;
  const importantOccupiedMinutes = b?.importantOccupiedMinutes ?? importantTotalMinutes;
  return <div className="life-plan-details" id="life-plan-details" role="region" aria-label="排期详情">
    <p className="life-plan-meta">{when.format(new Date(plan.generatedAt))} 排期快照 · 北京时间</p>
    {plan.rules && <details className="life-plan-collapsible"><summary>规则执行 · 配置 v{plan.rules.version}</summary>
      <ol className="life-plan-tasks">{plan.rules.results.map(result => <li key={result.id}>
        <div><span>{ruleTitle(result.id, plan.rules)}</span><span>{result.status === 'success' ? `完成 · ${result.matched} 项` : result.status === 'failed' ? '失败' : '跳过'}</span></div>
        {result.reason && <p>{result.reason}</p>}
        {!!result.conflicts?.length && <p>冲突采用：{[...new Set(result.conflicts.map(conflict => ruleTitle(conflict.winner, plan.rules)))].join('、')}</p>}
      </li>)}</ol>
    </details>}
    {b ? <section aria-label="剩余可排期时间">
        <dl className="life-plan-ledger">
          <div className="life-plan-time"><dt>可排期时间</dt><dd>{minuteText(b.windowMinutes)}</dd></div>
        </dl>
        <details className="life-plan-collapsible">
          <summary><span>Outlook 日程 · 共 {b.calendarEvents?.length ?? 0} 项 · 占用可排期时间 {minuteText(b.occupiedMinutes)}</span></summary>
          {b.calendarEvents?.length ? <ul className="life-plan-tasks">{b.calendarEvents.map((event, index) => <li key={`${event.start}:${event.title}:${index}`}>
            <div><span>{event.title || '未命名日程'}</span><span>{minuteText((Date.parse(event.end) - Date.parse(event.start)) / 60_000)}</span></div>
            <p>{time.format(new Date(event.start))}—{time.format(new Date(event.end))}</p>
          </li>)}</ul> : <p className="life-plan-meta">暂无 Outlook 日程。</p>}
        </details>
        <dl className="life-plan-ledger">
          <div className="life-plan-time life-plan-time-after-calendar"><dt>扣除日程后剩余</dt><dd>{minuteText(b.freeMinutes)}</dd></div>
        </dl>
        <details className="life-plan-collapsible">
          <summary><span>今日重要之事 · 共 {b.important.length} 项 · {importantOccupiedMinutes === importantTotalMinutes ? '约' : '另需'} {minuteText(importantOccupiedMinutes)}</span></summary>
          {b.important.length ? <ul className="life-plan-tasks">{b.important.map(task => <li key={`${task.projectId}:${task.id}`}>
            <div><span>{task.title}</span><span>{minuteText(task.minutes)}</span></div>
          </li>)}</ul> : <p className="life-plan-meta">本次没有未完成的重要事项。</p>}
        </details>
        <dl className="life-plan-ledger">
          <div className="life-plan-time life-plan-time-after-important"><dt>扣除今日重要之事后剩余</dt><dd>{b.freeAfterImportantMinutes === undefined ? '—' : minuteText(b.freeAfterImportantMinutes)}</dd></div>
          <div className="life-plan-subtotal"><dt>本轮可新增安排</dt><dd>{minuteText(b.newTaskCapacityMinutes)}</dd></div>
        </dl>
      </section> : <p className="life-plan-meta">暂无时间明细，Orchestrate 完成后可查看。</p>}
    <section aria-label="排入今日事的任务"><h3>排入今日事 · {plan.selected.length} 项 · 约 {minuteText(plannedMinutes)}</h3>
      {plan.selected.length ? <ul className="life-plan-tasks">{plan.selected.map(task => <li key={`${task.projectId}:${task.id}`}>
        <div><span>{task.title}</span><span>{minuteText(task.minutes)}</span></div>
      </li>)}</ul> : <p className="life-plan-meta">本次没有安排普通今日事。</p>}
    </section>
  </div>;
}
