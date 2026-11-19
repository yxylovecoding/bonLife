import { useCallback, useEffect, useRef, useState } from 'react';
import LoginPage from '../pages/LoginPage';
import InstallApp from '../components/InstallApp';
import { appIdentity, isLifeApp, APP_LINKS } from '../utils/apps';
import { requestSession, restoreSession } from '../utils/authClient';
import LifeCalendar from './LifeCalendar';
import LifeBriefing from './LifeBriefing';
import './life.css';

let sessionPromise: ReturnType<typeof restoreSession> | undefined;

export default function BonLife() {
  const { kind } = appIdentity(window.location.hostname, window.location.pathname);
  const app = isLifeApp(kind) ? kind : 'log';
  const [owner, setOwner] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'login' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const checking = useRef(false);
  const expired = useCallback(() => setStatus('login'), []);
  useEffect(() => {
    let active = true;
    sessionPromise ??= restoreSession();
    void sessionPromise.then((session) => {
      if (!active) return;
      setOwner(session.username || 'legacy');
      setStatus(session.authenticated ? 'ready' : 'login');
    }).catch(() => { if (active) { setError('暂时无法连接，请重试'); setStatus('error'); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    const check = async () => {
      if (checking.current) return;
      checking.current = true;
      try {
        const session = await requestSession();
        if (!session.authenticated || (session.username || 'legacy') !== owner) setStatus('login');
      } catch { /* Keep unsaved text during a transient outage. */ }
      finally { checking.current = false; }
    };
    const onStorage = (event: StorageEvent) => { if (event.key?.endsWith('logout-at') || event.key === 'bonbills-auth-changed-at') void check(); };
    window.addEventListener('focus', check);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('focus', check); window.removeEventListener('storage', onStorage); };
  }, [status, owner]);

  return <div className="bonlife">
    {status === 'loading' ? <main className="life-loading" role="status">加载中…</main>
      : status === 'login' ? <><LoginPage title={APP_LINKS[app].name} icon="/bonlife.svg" /><div className="app-login-install"><InstallApp app={app} /></div></>
      : status === 'error' ? <main className="life-loading"><p role="alert">{error}</p><button onClick={() => window.location.reload()}>重试</button></main>
      : app === 'log' && new URLSearchParams(window.location.search).get('view') === 'briefing' ? <LifeBriefing onExpired={expired} />
      : <LifeCalendar app={app} owner={owner!} onExpired={expired} />}
  </div>;
}
