import { privateJson } from './_privateCache.js';
import { withAccountScope } from './_accountRoute.js';
import { isOwnerScope } from './_accountScope.js';
import { authOk } from './_auth.js';
import { kv } from './_accountKv.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { MONTHLY_BACKUP_INDEX_KEY, type MonthlyBackupIndexEntry } from './_monthlyBackup.js';
import { mergeRecoveredMonthlyInvestmentState, restoreMonthlyInvestmentState } from './_restoreMonthlyInvestment.js';
import { SYNC_STORE_KEYS, type SyncPayload } from './_syncKeys.js';
import { BonCalConflict, readBonCalInputs, readBonCalView, repairBonCalStorage, saveBonCalUpload, withCalendarWriteLock } from './_bonCal/repository.js';
import { migrateOwnerSchoolPeriods } from './_schoolPeriodsMigration.js';

const AUGUST_INVESTMENT_RECOVERY_MARKER = 'sync-recovery:2026-08-investment:2026-09-03-v1';
const AUGUST_INVESTMENT_MERGE_MARKER = 'sync-recovery:2026-08-investment:2026-09-03-v2';

interface MonthlyBackup {
  data?: SyncPayload;
}

async function restoreAugustInvestmentFromLatestBackup(currentState: unknown) {
  const completed = await kv.get(AUGUST_INVESTMENT_RECOVERY_MARKER);
  if (completed) return currentState;

  const index = await kv.get<MonthlyBackupIndexEntry[]>(MONTHLY_BACKUP_INDEX_KEY);
  const entries = Array.isArray(index)
    ? [...index].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    : [];
  for (const entry of entries) {
    const backup = await kv.get<MonthlyBackup>(entry.key);
    const restored = restoreMonthlyInvestmentState(
      currentState,
      backup?.data?.['monthly-records'],
      '2026-08',
    );
    if (!restored.restored) continue;
    const restoredAt = new Date().toISOString();
    await kv.set(`${AUGUST_INVESTMENT_RECOVERY_MARKER}:before`, {
      createdAt: restoredAt,
      data: currentState,
    });
    await kv.set('monthly-records', restored.state);
    await kv.set(AUGUST_INVESTMENT_RECOVERY_MARKER, {
      restoredAt,
      source: entry.key,
    });
    return restored.state;
  }
  return currentState;
}

async function mergeAugustInvestmentFromPreRestoreState(currentState: unknown) {
  const completed = await kv.get(AUGUST_INVESTMENT_MERGE_MARKER);
  if (completed) return currentState;

  const previous = await kv.get<{ data?: unknown }>(`${AUGUST_INVESTMENT_RECOVERY_MARKER}:before`);
  const merged = mergeRecoveredMonthlyInvestmentState(currentState, previous?.data, '2026-08');
  const mergedAt = new Date().toISOString();
  if (merged.merged) {
    await kv.set(`${AUGUST_INVESTMENT_MERGE_MARKER}:before`, { createdAt: mergedAt, data: currentState });
    await kv.set('monthly-records', merged.state);
  }
  await kv.set(AUGUST_INVESTMENT_MERGE_MARKER, {
    mergedAt,
    merged: merged.merged,
    selectedRecoveryGroups: merged.selectedRecoveryGroups ?? [],
  });
  return merged.state;
}

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!await authOk(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.method === 'GET') {
    await repairBonCalStorage();
    const values = await Promise.all(SYNC_STORE_KEYS.map((k) => kv.get(k)));
    const result: SyncPayload = {};
    let hasAny = false;
    SYNC_STORE_KEYS.forEach((k, i) => {
      if (values[i] !== null && values[i] !== undefined) {
        result[k] = values[i];
        hasAny = true;
      }
    });
    if (isOwnerScope() && result['app-config']) {
      result['app-config'] = await migrateOwnerSchoolPeriods(result['app-config']);
    }
    if (isOwnerScope() && result['monthly-records']) {
      result['monthly-records'] = await restoreAugustInvestmentFromLatestBackup(result['monthly-records']);
      result['monthly-records'] = await mergeAugustInvestmentFromPreRestoreState(result['monthly-records']);
    }
    const canonical = await readBonCalView();
    return privateJson(req, res, { ...result, 'calendar-tags': canonical.calendar, 'trip-tags': canonical.tripSettings,
      ...(hasAny ? { 'app-config': canonical.rawConfig } : {}), bonCalRevision: canonical.revision });
  }

  if (req.method === 'PUT') {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as SyncPayload & { bonCalRevision?: string };
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
    try {
      const canonical = await saveBonCalUpload(body, typeof body.bonCalRevision === 'string' ? body.bonCalRevision : undefined);
      await Promise.all(SYNC_STORE_KEYS.filter((k) => k in body && !['calendar-tags', 'trip-tags', 'app-config'].includes(k)).map(k => kv.set(k, body[k])));
      return res.status(200).json({ ok: true, bonCalRevision: canonical.revision, calendar: canonical.calendar, config: canonical.config, tripSettings: canonical.tripSettings });
    } catch (error) {
      if (error instanceof BonCalConflict) return res.status(409).json({ error: error.message });
      throw error;
    }
  }

  return res.status(405).json({ error: 'method not allowed' });
}

export default withAccountScope(handler);
