import { useState, type FormEvent } from 'react';
import { register, removeLegacyKey, signIn } from '../utils/authClient';

export default function LoginPage({ initialError = '', title = '盘账助手', icon, allowRegistration = true }: {
  initialError?: string; title?: string; icon?: string; allowRegistration?: boolean;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const registering = mode === 'register';

  function switchMode(next: typeof mode) {
    setMode(next);
    setPassword('');
    setConfirmPassword('');
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (registering && password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (registering) await register({ username: username.trim(), password, confirmPassword });
      else await signIn({ username: username.trim(), password });
      removeLegacyKey();
      try { localStorage.setItem('bonbills-auth-changed-at', String(Date.now())); } catch { /* 当前页仍会重新加载 */ }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败，请重试');
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark" aria-hidden="true">
          {icon ? <img src={icon} alt="" width="44" height="44" /> : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="3" width="14" height="18" rx="3" />
            <path d="M9 8h6M9 12h6M9 16h3" />
          </svg>}
        </div>
        <h1 id="login-title">{registering ? '注册账号' : title}</h1>
        <form onSubmit={submit} className="login-form" aria-busy={busy}>
          <label htmlFor="login-username">账号
            <input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
              required maxLength={100} value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label htmlFor="login-password">密码
            <input id="login-password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'}
              required minLength={registering ? 6 : undefined} maxLength={1024} placeholder={registering ? '至少 6 位' : undefined}
              value={password} disabled={busy} aria-invalid={Boolean(error)}
              aria-describedby={error ? 'login-error' : undefined} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {registering && (
            <label htmlFor="login-confirm-password">确认密码
              <input id="login-confirm-password" name="confirmPassword" type="password" autoComplete="new-password"
                required minLength={6} maxLength={1024} value={confirmPassword} disabled={busy}
                aria-invalid={Boolean(error) && password !== confirmPassword}
                aria-describedby={error ? 'login-error' : undefined} onChange={(event) => setConfirmPassword(event.target.value)} />
            </label>
          )}
          {error && <p id="login-error" className="login-error" role="alert">{error}</p>}
          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? (registering ? '注册中…' : '登录中…') : (registering ? '注册并登录' : '登录')}
          </button>
          {allowRegistration && <button type="button" className="login-switch" disabled={busy} onClick={() => switchMode(registering ? 'login' : 'register')}>
            {registering ? '返回登录' : '注册账号'}
          </button>}
        </form>
      </section>
    </main>
  );
}
