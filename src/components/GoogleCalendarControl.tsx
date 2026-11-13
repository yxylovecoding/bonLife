import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/authClient';

interface Status { connected: boolean; syncedAt?: string; error?: string }
export default function GoogleCalendarControl() {
  const alive = useRef(true);
  const [status, setStatus] = useState<Status>();
  const [url, setUrl] = useState(''), [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function request(method: 'GET' | 'PUT' | 'DELETE') {
    setBusy(true); setError('');
    try {
      const response = await apiFetch('/api/outlook-calendar?app=google', {
        method, signal: AbortSignal.timeout(60_000),
        ...(method === 'PUT' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, secret }) } : {}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '连接失败');
      if (alive.current) { setStatus(data); setUrl(''); setSecret(''); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '连接失败'); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void request('GET'); return () => { alive.current = false; }; }, []);
  return <details className="schedule-outlook"><summary>Google 备用日历 · {status?.connected ? '已连接' : status ? '未连接' : error ? '读取失败' : '加载中…'}</summary>
    {status?.syncedAt && <p>上次读取 {new Date(status.syncedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>}
    {status?.connected ? <button type="button" disabled={busy} onClick={() => void request('DELETE')}>断开备用</button> : <>
      <label className="life-connection-label">连接地址<input type="password" autoComplete="off" value={url} disabled={busy}
        onChange={event => setUrl(event.target.value)} /></label>
      <label className="life-connection-label">连接密钥<input type="password" autoComplete="off" value={secret} disabled={busy}
        onChange={event => setSecret(event.target.value)} /></label>
      <button type="button" disabled={busy || !url || !secret} onClick={() => void request('PUT')}>{busy ? '连接中…' : '连接备用'}</button>
    </>}
    {(error || status?.error) && <p className="life-error" role="alert">{error || status?.error}</p>}
  </details>;
}
