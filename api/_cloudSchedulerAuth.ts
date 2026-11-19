import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
const actions = new Set(['', 'hourly-replan', 'life-periods', 'night-routine', 'daily-routine', 'routine-visibility', 'hair-wash', 'reading-visibility']);
// Independent credential created for this scheduler. It cannot authorize other APIs.
export function cloudSchedulerAuthOk(req: VercelRequest) {
  const secret = process.env.CLOUD_SCHEDULER_RUN_SECRET?.trim();
  const action = req.query?.action ?? '';
  if (!secret || req.query?.scheduler !== '1' || typeof action !== 'string'
    || !(req.method === 'GET' && actions.has(action) || req.method === 'POST' && action === 'orche-failure-task')) return false;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(Uint8Array.from(actual), Uint8Array.from(expected));
}
