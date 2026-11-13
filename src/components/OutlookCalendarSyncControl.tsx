import { tagMeta } from '../data/mockData';
import GoogleCalendarControl from './GoogleCalendarControl';
import type { useOutlookCalendarSync } from '../hooks/useOutlookCalendarSync';
import type { OutlookConflictPolicy } from '../utils/outlookCalendar';

const BUTTON: React.CSSProperties = { border: '1px solid #dadce0', borderRadius: 7, background: '#fff', color: '#1a73e8', cursor: 'pointer', fontSize: 11, padding: '4px 7px' };
const INPUT: React.CSSProperties = { width: '100%', minWidth: 0, border: '1px solid #dadce0', borderRadius: 7, padding: '6px 8px', fontSize: 12, boxSizing: 'border-box' };

export default function OutlookCalendarSyncControl({ sync }: { sync: ReturnType<typeof useOutlookCalendarSync> }) {
  const {
    yearMonth, connected, loaded, busy, editing, setEditing,
    playUrl, setPlayUrl, classUrl, setClassUrl, sources, setSources, policy, setPolicy,
    preview, setPreview, message, syncedAt, projected, changes, run,
  } = sync;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span role="status" style={{ fontSize: 12, color: message ? '#ea4335' : '#5f6368' }}>
          Outlook · {busy ? '同步中…' : !loaded ? '加载中…' : message ? '同步失败' : !connected ? '未连接' : syncedAt ? `已同步 ${syncedAt}` : '已连接'}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {connected ? <>
            <button type="button" disabled={busy} onClick={() => void run('sync')} style={BUTTON}>同步本月</button>
            <button type="button" disabled={busy} onClick={() => void run('disconnect')} style={{ ...BUTTON, border: 'none', color: '#5f6368' }}>断开</button>
          </> : <button type="button" disabled={busy} onClick={() => setEditing((value) => !value)} aria-expanded={editing} style={BUTTON}>{editing ? '收起' : '连接'}</button>}
        </div>
      </div>
      {editing && !connected && (
        <form onSubmit={(event) => { event.preventDefault(); void run(preview ? 'connect' : 'preview'); }} style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <label style={{ fontSize: 11, color: '#5f6368' }}>玩 · ICS
            <input type="password" autoComplete="off" disabled={busy} aria-label="玩日历 ICS 链接" value={playUrl} onChange={(event) => { setPlayUrl(event.target.value); setPreview(null); }} style={{ ...INPUT, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 11, color: '#5f6368' }}>课 · ICS
            <input type="password" autoComplete="off" disabled={busy} aria-label="课日历 ICS 链接" value={classUrl} onChange={(event) => { setClassUrl(event.target.value); setPreview(null); }} style={{ ...INPUT, marginTop: 4 }} />
          </label>
          {sources.map((source, index) => (
            <label key={index} style={{ fontSize: 11, color: '#5f6368' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{source.name} · {source.kind === 'class' || source.kind === 'work' ? '课/干' : '玩/日历'} · ICS</span>
                <button type="button" onClick={() => setSources(sources.filter((_, i) => i !== index))} style={{ ...BUTTON, border: 'none', color: '#ea4335', padding: 0, height: 'auto' }}>删除</button>
              </div>
              <input type="password" autoComplete="off" disabled={busy} aria-label={`${source.name} ICS 链接`} value={source.url} onChange={(event) => {
                const next = [...sources];
                next[index] = { ...next[index], url: event.target.value };
                setSources(next);
                setPreview(null);
              }} style={{ ...INPUT, marginTop: 4 }} />
            </label>
          ))}
          <button type="button" disabled={busy} onClick={() => {
            const name = prompt('请输入新日历名称', '日历');
            if (!name) return;
            const kind = confirm('是否使用“课/干”规则（识别实习标签）？') ? 'work' : 'calendar';
            setSources([...sources, { name, url: '', kind }]);
          }} style={{ ...BUTTON, justifySelf: 'start' }}>+ 新增订阅源</button>
          <label style={{ fontSize: 11, color: '#5f6368' }}>日常标记冲突时
            <select disabled={busy} aria-label="Outlook 同步优先级" value={policy} onChange={(event) => setPolicy(event.target.value as OutlookConflictPolicy)} style={{ ...INPUT, marginTop: 4 }}>
              <option value="manual">保留手动标记</option><option value="outlook">以 Outlook 为准</option>
            </select>
          </label>
          {preview && <div style={{ fontSize: 11, color: '#5f6368' }}>
            <div style={{ marginBottom: 6 }}>{yearMonth} · {changes.length ? `待更新 ${changes.length} 天` : '暂无待更新日期'}</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', maxHeight: 180, overflowY: 'auto' }}>
              {changes.map((day) => <span key={day} style={{ padding: '3px 6px', background: '#f1f3f4', borderRadius: 6 }}>
                {day.slice(5).replace('-', '/')} · {projected?.[day] ? tagMeta[projected[day]].label : '未标记'}
              </span>)}
            </div>
          </div>}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <a href="https://support.microsoft.com/en-us/outlook/share-your-calendar-in-outlook-com" target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#5f6368' }}>获取订阅链接 ↗</a>
            <button type="submit" disabled={busy || (!playUrl.trim() && !classUrl.trim())} style={BUTTON}>{preview ? '连接并同步' : '预览本月'}</button>
          </div>
        </form>
      )}
      {message && <div role="alert" style={{ marginTop: 6, fontSize: 11, color: '#ea4335' }}>{message}</div>}
      {connected && <GoogleCalendarControl />}
    </div>
  );
}
