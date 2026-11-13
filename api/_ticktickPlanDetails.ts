import { createHash } from 'node:crypto';
import { currentTickTickPlan } from '../src/utils/tickTickPlanDetails.js';
import { kv } from './_accountKv.js';
import { DAILY_PLAN_KEY, type DailyPlanState } from './_ticktickDailyPlan.js';
import { decryptTickTickToken, TICKTICK_CONNECTION_KEY, type TickTickConnection } from './_ticktickTrips.js';

// A read-only snapshot: opening details never reruns the scheduler or edits tasks.
export async function readTickTickPlanDetails() {
  const [connection, saved] = await Promise.all([
    kv.get<TickTickConnection>(TICKTICK_CONNECTION_KEY), kv.get<DailyPlanState>(DAILY_PLAN_KEY),
  ]);
  if (!connection || !saved?.briefing) return null;
  const token = decryptTickTickToken(connection.encryptedToken, (process.env.SYNC_SECRET || '').trim());
  return saved.connectionId === createHash('sha256').update(token).digest('hex') ? currentTickTickPlan(saved.briefing) : null;
}
