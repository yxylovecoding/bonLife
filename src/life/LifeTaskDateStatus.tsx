import { useEffect, useRef, useState } from 'react';
import { accountFetch } from '../utils/authClient';

type Task = { id: string; title: string; dueDate?: string; startDate?: string; status?: number; completedTime?: string; tags?: string[]; timeZone?: string };
type Reply = { connected: boolean; today: string; tasks: { snapshot: Task; current: Task; alwaysToday: boolean;
  completedToday: boolean; abandonedToday: boolean; nextSceneDate: string | null }[]; error?: string };
const date = (task: Task) => {
  const value = task.dueDate || task.startDate;
  if (!value) return '无日期';
  try { return new Intl.DateTimeFormat('sv-SE', { timeZone: task.timeZone || 'Asia/Shanghai' }).format(new Date(value)); }
  catch { return value.slice(0, 10); }
};

export default function LifeTaskDateStatus({ onExpired }: { onExpired: () => void }) {
  const [title, setTitle] = useState(''), [data, setData] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function inspect() {
    if (busy || !title.trim()) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setData(null);
    const timeout = window.setTimeout(() => controller.abort(), 65_000);
    try {
      const response = await accountFetch(`/api/ticktick-trips?action=task-status&title=${encodeURIComponent(title.trim())}`,
        { signal: controller.signal, cache: 'no-store' });
      if (response.status === 401) { onExpired(); return; }
      const result = await response.json() as Reply;
      if (!response.ok) throw new Error(result.error || '核对失败');
      setData(result);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '核对失败');
      else setError('读取超时，请重试'); }
    finally { clearTimeout(timeout); setBusy(false); request.current = null; }
  }
  return <details className="schedule-outlook"><summary>待办日期核对</summary>
    <form className="schedule-tag-entry" onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <input aria-label="待办标题" placeholder="待办完整标题" value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} />
      <button disabled={busy || !title.trim()}>{busy ? '读取中…' : '核对'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {data && (!data.connected ? <p>TickTick 未连接</p> : !data.tasks.length ? <p>未找到同名待办</p> : data.tasks.map(item =>
      <div className="schedule-connection" key={item.current.id}>
        <strong>{item.current.title}</strong>
        <p>当前日期 {date(item.current)} · 列表日期 {date(item.snapshot)}</p>
        <p>状态 {item.current.status === 2 ? '已完成' : item.current.status === -1 ? '已放弃' : (item.current.status ?? 0) === 0 ? '未完成' : item.current.status}
          {item.current.completedTime ? ` · 完成时间 ${item.current.completedTime}` : ''}</p>
        <p>标签 {item.current.tags?.join('、') || '无'}</p>
        <p>当天完成保护 {item.completedToday ? '是' : '否'} · 当天放弃保护 {item.abandonedToday ? '是' : '否'}</p>
        {item.alwaysToday && <p>固定今日目标 {item.nextSceneDate || '暂无适用日期'}</p>}
      </div>))}
  </details>;
}
