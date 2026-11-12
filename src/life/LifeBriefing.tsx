import { useEffect, useState } from 'react';
import type { DailyBriefing } from '../utils/dailyBriefing';
import { accountFetch } from '../utils/authClient';

const when = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value));
const duration = (minutes: number) => minutes ? `约 ${minutes} 分钟` : '休息';

export default function LifeBriefing({ onExpired }: { onExpired: () => void }) {
  const [report, setReport] = useState<DailyBriefing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void accountFetch('/api/ticktick-trips?action=briefing&format=json', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) { onExpired(); return; }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '简报读取失败');
        if (!controller.signal.aborted) setReport(data);
      }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '简报读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [onExpired]);
  async function refresh() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await accountFetch('/api/ticktick-trips?action=briefing&format=json', { method: 'POST' });
      if (response.status === 401) { onExpired(); return; }
      const data = await response.json();
      if (response.status === 202) throw new Error('已有同步正在运行，请稍后刷新');
      if (!response.ok) throw new Error(data.error || '简报更新失败');
      setReport(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '简报更新失败'); }
    finally { setBusy(false); }
  }
  return <main className="life-shell life-briefing" data-date={report?.date} data-briefing-ready={Boolean(report?.ready && !busy && !error)}>
    <header className="life-header"><h1>每日简报</h1><div className="life-header-actions"><a href="/life?kind=training">运动</a>
      <button disabled={busy} onClick={() => void refresh()}>{busy ? '更新中…' : '刷新简报'}</button></div></header>
    {error && <p className="life-error" role="alert">{error}</p>}
    {!report && busy && <p role="status">正在读取运动与今日事…</p>}
    {report && <>
      <p className="life-briefing-meta">{report.date} · 北京时间 · 读取于 {when(report.generatedAt)}<br />
        {report.planGeneratedAt && `今日事排期时间：${when(report.planGeneratedAt)}`}</p>
      {report.warnings.map((warning) => <p className="life-error" key={warning}>{warning}</p>)}
      <h2>未来 7 天运动</h2><div className="life-briefing-table"><table><thead><tr><th>日期 / 阶段</th><th>运动</th><th>预计用时</th><th>安排原因</th></tr></thead>
        <tbody>{report.training.map((day) => <tr key={day.date}><td>{day.date}<br /><small>{day.phase}</small></td><td>{day.plan}</td><td>{duration(day.minutes)}</td><td>{day.reasons.join('；')}</td></tr>)}</tbody></table></div>
      <h2>今日事 · {report.today.length} 项 · 约 {report.today.reduce((sum, item) => sum + item.minutes, 0)} 分钟</h2>
      {report.summary && <p className="life-briefing-meta">排期时可用时间约 {report.summary.availableMinutes} 分钟，另有 {report.summary.importantCount} 项重要事项。</p>}
      {report.today.length ? <div className="life-briefing-table"><table><thead><tr><th>事项</th><th>预计用时</th><th>入选原因</th></tr></thead>
        <tbody>{report.today.map((item, index) => <tr key={`${index}:${item.title}`}><td>{item.title}</td><td>{duration(item.minutes)}</td><td>{item.reasons.join('；')}</td></tr>)}</tbody></table></div> : <p>今日事暂无待办。</p>}
      <p className="life-briefing-meta">时长均为预估；运动若已在今日事中列出，不重复相加。后续运动会随实际完成和经期记录更新。</p>
    </>}
  </main>;
}
