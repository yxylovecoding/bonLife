import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import LoginPage from '../pages/LoginPage';
import InstallApp from '../components/InstallApp';
import { appIdentity, isLifeApp, APP_LINKS } from '../utils/apps';
import { requestSession, restoreSession, type SessionStatus } from '../utils/authClient';
import './life.css';

const LifeCalendar = lazy(() => import('./LifeCalendar'));
const LifeBriefing = lazy(() => import('./LifeBriefing'));
const LifeOrche = lazy(() => import('./LifeOrche'));

let sessionPromise: ReturnType<typeof restoreSession> | undefined;

export default function BonLife() {
  const { kind } = appIdentity(window.location.hostname, window.location.pathname);
  const app = isLifeApp(kind) ? kind : 'log';
  const [session, setSession] = useState<SessionStatus>();
  const [status, setStatus] = useState<'loading' | 'login' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const checking = useRef(false);
  const expired = useCallback(() => setStatus('login'), []);
  useEffect(() => {
    let active = true;
    sessionPromise ??= restoreSession();
    void sessionPromise.then((session) => {
      if (!active) return;
      setSession(session);
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
        const actual = await requestSession();
        if (!actual.authenticated || actual.accountId !== session?.accountId || actual.username !== session?.username) {
          setStatus('login');
        } else if (actual.orcheJobId !== session?.orcheJobId) {
          setSession(actual);
        }
      } catch { /* Keep unsaved text during a transient outage. */ }
      finally { checking.current = false; }
    };
    const onStorage = (event: StorageEvent) => { if (event.key?.endsWith('logout-at') || event.key === 'bonbills-auth-changed-at') void check(); };
    window.addEventListener('focus', check);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('focus', check); window.removeEventListener('storage', onStorage); };
  }, [status, session?.accountId, session?.username, session?.orcheJobId]);

  return <div className="bonlife">
    {status === 'loading' ? <main className="life-loading" role="status">加载中…</main>
      : status === 'login' ? <><LoginPage title={APP_LINKS[app].name} icon="/bonlife.svg" allowRegistration={app !== 'orche'} /><div className="app-login-install"><InstallApp app={app} /></div></>
      : status === 'error' ? <main className="life-loading"><p role="alert">{error}</p><button onClick={() => window.location.reload()}>重试</button></main>
      : app === 'orche' ? <LifeOrche owner={session?.accountId === 'legacy'} jobId={session?.orcheJobId} onExpired={expired} />
      : app === 'log' && new URLSearchParams(window.location.search).get('view') === 'briefing' ? <LifeBriefing onExpired={expired} />
      : <LifeCalendar app={app} owner={session?.username || 'legacy'} onExpired={expired} />}
  </div>;
}
