import { useState } from 'react';
import InstallApp from '../components/InstallApp';
import { APP_LINKS } from '../utils/apps';
import { requestSession } from '../utils/authClient';
import LifeOrcheDetails from './LifeOrcheDetails';
import { useOrchestrate } from './useOrchestrate';

function LoginRun({ jobId, onExpired }: { jobId: string; onExpired: () => void }) {
  const details = useOrchestrate(onExpired, jobId);
  return <LifeOrcheDetails {...details} />;
}

export default function LifeOrche({ owner, jobId, onExpired }: {
  owner: boolean; jobId?: string; onExpired: () => void;
}) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');

  async function logout() {
    setLoggingOut(true);
    setError('');
    try {
      await requestSession({ method: 'DELETE' });
      try { localStorage.setItem('bonlife-logout-at', String(Date.now())); } catch { /* Current page still logs out. */ }
      onExpired();
    } catch { setError('退出失败，请重试'); }
    finally { setLoggingOut(false); }
  }

  return <main className="life-shell">
    <header className="life-header">
      <h1><span className="life-brand-dot" />Orche</h1>
      <div className="life-header-actions">
        <a className="life-hub-link" href={APP_LINKS.log.url}>BonLog</a>
        <InstallApp app="orche" />
        <button onClick={() => void logout()} disabled={loggingOut}>{loggingOut ? '退出中…' : '退出'}</button>
      </div>
    </header>
    {error && <p className="life-error" role="alert">{error}</p>}
    {owner && jobId ? <LoginRun key={jobId} jobId={jobId} onExpired={onExpired} />
      : <p className="life-empty-state" role="status">{owner ? '重新登录以运行 Orche' : '当前账号无法运行 Orche'}</p>}
  </main>;
}
