import { kv } from './_accountKv.js';
import { OUTLOOK_CONNECTION_KEY, OUTLOOK_READ_STATUS_KEY, type OutlookConnection } from './_outlookSync.js';
import { decryptOutlookConnection } from './_outlookCalendar.js';
import { LIFE_CONNECTION_KEY, periodsKey, type LifeConnection } from './_bonLife.js';
import { outlookWriteStatus } from './_outlookWrite.js';
import { outlookStatusError } from './_outlookStatus.js';

export interface OutlookConnectionSummary {
  id: string; name: string; kind: 'subscription' | 'period' | 'write'; connected: boolean;
  syncedAt?: string; error?: string; retryAt?: string;
}
export async function readOutlookConnections(): Promise<OutlookConnectionSummary[]> {
  const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
  const [connection, life, period, snapshots, write, readStatus, periodStatus] = await Promise.all([
    kv.get<OutlookConnection>(OUTLOOK_CONNECTION_KEY), kv.get<LifeConnection>(LIFE_CONNECTION_KEY),
    kv.get<{ connectionId: string; syncedAt?: string }>(periodsKey(year)), kv.get<{ connectionId: string; requestedAt: number }>('outlook:calendar-snapshots:v1'),
    outlookWriteStatus().catch(() => null),
    kv.get<{ connectionId: string; error?: string }>(OUTLOOK_READ_STATUS_KEY),
    kv.get<{ connectionId: string; error?: string }>('bonlife:period-read-status:v1'),
  ]);
  const result: OutlookConnectionSummary[] = [];
  if (connection) {
    try {
      const input = decryptOutlookConnection(connection.encrypted, (process.env.SYNC_SECRET || '').trim());
      input.sources.forEach((source, index) => result.push({ id: `subscription-${index}`, name: source.name, kind: 'subscription', connected: true,
        error: readStatus?.connectionId === connection.id && readStatus.error ? '订阅暂时读取失败，请重试' : undefined,
        ...(snapshots?.connectionId === connection.id && snapshots.requestedAt ? { syncedAt: new Date(snapshots.requestedAt).toISOString() } : {}) }));
    } catch { result.push({ id: 'subscription', name: '日历订阅', kind: 'subscription', connected: true, error: '连接信息暂不可用' }); }
  } else result.push({ id: 'subscription', name: '日历订阅', kind: 'subscription', connected: false });
  const google = await (await import('./_googleCalendar.js')).googleCalendarStatus();
  if (google.connected) result.push({ id: 'google', name: 'Google 备用日历', kind: 'subscription', connected: google.connected,
    syncedAt: google.syncedAt, error: google.error });
  result.push({ id: 'period', name: '日历 · 经期订阅', kind: 'period', connected: Boolean(life),
    error: life && periodStatus?.connectionId === life.id && periodStatus.error ? '经期订阅暂时读取失败，请重试' : undefined,
    ...(life && period?.connectionId === life.id ? { syncedAt: period.syncedAt } : {}) });
  result.push({ id: 'write', name: write?.calendarName ? `${write.calendarName} · 日程写入` : 'Outlook 日程写入', kind: 'write',
    connected: Boolean(write?.connected), syncedAt: write?.lastSyncAt, retryAt: write?.retryAt,
    error: write?.error ? ['Make 免费额度保护已暂停写入', '免费额度已释放，等待下次同步'].includes(write.error) ? write.error : outlookStatusError(write.error)
      : (!write ? '连接状态暂不可用' : write.connected && !write.enabled ? '尚未选择写入日历' : undefined) });
  return result;
}
