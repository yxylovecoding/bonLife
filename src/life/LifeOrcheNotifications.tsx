import { useEffect, useState } from 'react';
import { accountFetch } from '../utils/authClient';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const registrationScope = () => location.pathname === '/log' ? '/log' : '/';
const api = '/api/ticktick-trips?action=orche-notifications';

async function notificationSettings(input?: { action: 'status' | 'enable' | 'disable'; endpoint: string }, signal?: AbortSignal) {
  const response = await accountFetch(api, {
    method: input ? 'POST' : 'GET', signal: signal ?? AbortSignal.timeout(20_000),
    headers: input ? { 'Content-Type': 'application/json' } : undefined,
    body: input ? JSON.stringify(input) : undefined,
  });
  const result = await response.json() as { enabled?: boolean; publicKey?: string; error?: string };
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(result.error || '通知设置失败，请重试');
  return result;
}

export default function LifeOrcheNotifications() {
  const [enabled, setEnabled] = useState(false);
  const [checking, setChecking] = useState(supported);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [available, setAvailable] = useState(supported);
  useEffect(() => {
    if (!supported()) return;
    const controller = new AbortController();
    void (async () => {
      const registration = await navigator.serviceWorker.getRegistration(registrationScope());
      const subscription = await registration?.pushManager.getSubscription();
      const settings = await notificationSettings(subscription ? { action: 'status', endpoint: subscription.endpoint } : undefined, controller.signal);
      if (!controller.signal.aborted) {
        setAvailable(settings !== null);
        setEnabled(settings?.enabled === true && Notification.permission === 'granted');
      }
    })().catch(() => { if (!controller.signal.aborted) setError('通知状态暂不可用'); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, []);

  async function toggle() {
    setBusy(true); setError('');
    try {
      if (enabled) {
        const registration = await navigator.serviceWorker.getRegistration(registrationScope());
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await notificationSettings({ action: 'disable', endpoint: subscription.endpoint });
          setEnabled(false);
          await subscription.unsubscribe();
        } else { setEnabled(false); }
        return;
      }
      if (await Notification.requestPermission() !== 'granted') throw new Error('请在系统或浏览器中允许 BonLog 通知');
      const settings = await notificationSettings();
      if (!settings?.publicKey) throw new Error('云端通知暂不可用，请稍后重试');
      await navigator.serviceWorker.register('/bonlog-push.js', { scope: registrationScope() });
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const key = Uint8Array.from(atob(settings.publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const result = await notificationSettings({ action: 'enable', endpoint: subscription.endpoint });
      if (!result?.enabled) throw new Error('通知未启用，请重试');
      setEnabled(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '通知设置失败，请重试'); }
    finally { setBusy(false); }
  }

  return <>
    {available ? <button type="button" disabled={busy || checking} aria-pressed={enabled} onClick={() => void toggle()}>
      {busy ? '正在设置…' : enabled ? '关闭本机失败通知' : '开启失败通知'}
    </button> : !supported() && /iPhone|iPad/.test(navigator.userAgent)
      ? <span>从主屏幕打开 BonLog 后可开启通知</span> : null}
    {error && <span className="life-error" role="status">{error}</span>}
  </>;
}
