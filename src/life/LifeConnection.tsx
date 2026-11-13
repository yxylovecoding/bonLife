import { useEffect, useRef, useState } from 'react';
import { lifeRequest } from './client';
import OutlookWriteControl from '../components/OutlookWriteControl';
import GoogleCalendarControl from '../components/GoogleCalendarControl';

export default function LifeConnection({ year, connected, onChanged, onClose }: {
  year: number; connected: boolean; onChanged: (connected: boolean) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function change(method: 'PUT' | 'DELETE') {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await lifeRequest(method, method === 'PUT' ? { url, year } : undefined);
      setUrl(''); onChanged(method === 'PUT'); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '连接失败，请重试'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="life-dialog" aria-labelledby="life-outlook-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="persistent-form" onSubmit={(event) => { event.preventDefault(); void change('PUT'); }}>
      <div className="persistent-form-body">
        <div className="life-editor-heading"><h2 id="life-outlook-title">Outlook</h2></div>
        <OutlookWriteControl />
        <GoogleCalendarControl />
      <div className="life-editor-heading"><h3>日历订阅</h3><span>{connected ? '已连接' : '未连接'}</span></div>
      <label className="life-connection-label" htmlFor="life-ics">日历 · ICS 订阅链接</label>
      <input id="life-ics" type="password" autoComplete="off" spellCheck={false} value={url} disabled={busy}
        placeholder="https://outlook…/calendar.ics" onChange={(event) => setUrl(event.target.value)} />
      <a className="life-help" href="https://outlook.live.com/calendar/0/options/calendar/SharedCalendars" target="_blank" rel="noreferrer">Outlook 日历设置 ↗</a>
      {error && <p className="life-error" role="alert">{error}</p>}
      </div>
      <div className="life-editor-actions">
        {connected && <button type="button" disabled={busy} onClick={() => void change('DELETE')}>断开</button>}
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="life-primary" disabled={busy || !url.trim()}>{busy ? '连接中…' : connected ? '更新连接' : '连接'}</button>
      </div>
    </form>
  </dialog>;
}
