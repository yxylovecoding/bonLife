const readStages = new Set(['outlook-refresh', 'tasks-read', 'completion-history', 'template-read']);
const skipReasons = new Set(['rest-window', 'sleep-window', 'restore-pending', 'disconnected']);
export const actionTimeout = action => action === 'full' || action === 'hourly-replan' ? 320_000
  : action === 'life-periods' ? 80_000 : 150_000;
const stages = new Set([...readStages, 'completion-archive', 'timed-visibility', 'planning', 'finalize']);
// Operational categories only: never emit bodies, URLs, credentials, or provider errors.
function logOrigin(phase, action, started, response, body, error) {
  const type = response?.headers.get('content-type') || '';
  const record = { phase, action, http: response?.status || 0, elapsedMs: Math.max(0, Date.now() - started),
    responseKind: body && typeof body.ok === 'boolean' ? 'application-json'
      : type.includes('application/json') ? 'json' : type.includes('text/html') ? 'html'
        : response ? 'other' : 'none',
    renderOrigin: response?.headers.get('x-render-origin-server') === 'Render' };
  const cache = response?.headers.get('cf-cache-status'), ray = response?.headers.get('cf-ray');
  if (['HIT', 'MISS', 'DYNAMIC', 'BYPASS', 'EXPIRED', 'STALE', 'REVALIDATED', 'UPDATING'].includes(cache)) record.edgeCache = cache;
  if (ray && /^[a-f\d]{16,32}-[A-Z]{3}$/.test(ray)) record.edgeRequest = ray;
  if (typeof body?.rulesComplete === 'boolean') record.rulesComplete = body.rulesComplete;
  if (body?.error) record.applicationError = true;
  if (body?.failure) record.failureStage = stages.has(body.failure.stage) ? body.failure.stage : 'unknown';
  if (error) record.networkError = ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name) ? error.name : 'Error';
  console.info('[scheduler-origin]', JSON.stringify(record));
}
// Render may answer at its edge while the free instance is still asleep. Probe
// the read-only readiness route before sending any business operation. The ten
// second bound fits inside the queue's existing fifteen second lease margin.
async function waitForOrigin(env, attempt, action) {
  const origin = new URL(env.ORIGIN);
  if (!origin.hostname.endsWith('.onrender.com')) return null;
  // A failed health probe has not sent a business operation. Give Render one
  // ordinary page request to wake the free instance, then require health again
  // on the next alarm. A loading page (even HTTP 200) never means ready.
  const wake = attempt.warmups === 1;
  const url = new URL(wake ? '/' : '/healthz', origin);
  url.searchParams.set('_scheduler_probe', String(Date.now()));
  let status = 0;
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'bonbills-scheduler/1.0', 'Cache-Control': 'no-cache',
        Accept: wake ? 'text/html' : 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    const body = await response.json().catch(() => null);
    logOrigin(wake ? 'wakeup' : 'readiness', action, started, response, body);
    if (!wake && status === 200 && body?.ok === true) return null;
  } catch (error) {
    logOrigin(wake ? 'wakeup' : 'readiness', action, started, undefined, undefined, error);
    /* A readiness read is safe to retry; no task operation was sent. */
  }
  return (attempt.warmups || 0) < 12
    ? { outcome: 'retry', counter: 'warmups', delay: 30_000, http: status }
    : { outcome: 'failed', reason: 'origin-not-ready', http: status };
}
// Persist only fixed categories, never provider errors, private records or response bodies.
export function classify(action, status, body, attempt) {
  const fail = reason => ({ outcome: 'failed', reason, http: status });
  const retry = (counter, delay) => ({ outcome: 'retry', counter, delay, http: status });
  if (action === 'monthly-backup') return status === 200 && body?.ok === true
    && /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') && Number.isInteger(body.storedKeys) && body.storedKeys > 0
    ? { outcome: 'success' } : fail('backup-incomplete');
  if (status === 200 && body?.ok === true && body.skipped === 'rest-window') return { outcome: 'skipped', reason: 'rest-window' };
  if (action === 'life-periods') {
    if (status === 200 && body?.ok === true && (body.connected === false ||
        (body.connected === true && typeof body.syncedAt === 'string'))) return { outcome: 'success' };
    return ![401, 403].includes(status) && attempt.retries < 2
      ? retry('retries', 10_000) : fail('period-import');
  }
  // Persisted restoration batches are explicitly safe to continue.
  if ((action === 'full' && status === 202 ||
      ['daily-routine', 'routine-visibility'].includes(action) && status === 200 && body?.ok === true)
      && body?.sleepTags?.complete === false) return retry('batches', 1000);
  if (status === 202 || action === 'hourly-replan' && status === 200 && body?.deferred === true) {
    return attempt.busy < 12 ? retry('busy', 30_000) : fail('busy');
  }
  const safeRead = readStages.has(body?.failure?.stage) || action === 'full' && body?.failure?.stage === 'completion-archive';
  if (['full', 'hourly-replan'].includes(action) && status === 502 && body?.failure?.retryable === true
      && safeRead && attempt.retries < 2) return retry('retries', 30_000 * (attempt.retries + 1));
  // The backend committed/verified independent work. Do not replay it or stop
  // later independent steps merely because a source-dependent rule was held.
  if ([200, 502].includes(status) && body?.rulesComplete === false && body?.partial === true
      && !body.busy && Number.isInteger(body.completedRules) && body.completedRules > 0)
    return { outcome: 'partial', reason: 'rules-incomplete', http: status };
  if (status !== 200 || body?.ok !== true || body.busy || body.error) return fail('incomplete');
  if (typeof body.rulesComplete === 'boolean') return body.rulesComplete ? { outcome: 'success' } : fail('rules-incomplete');
  if (action === 'full') {
    if (!body.dailyPlan || body.laundry?.outlook?.error || body.charging?.outlook?.error || body.hairWash?.outlook?.error) return fail('plan-incomplete');
  } else if (action === 'hourly-replan') {
    if (!body.dailyPlan && !skipReasons.has(body.skipped)) return fail('plan-incomplete');
  } else if (body.connected !== false) {
    if (action === 'reading-visibility' && !body.reading) return fail('visibility-incomplete');
    if (action === 'hair-wash' && (!body.hairWash || !body.reading)) return fail('visibility-incomplete');
    if (['night-routine', 'routine-visibility'].includes(action) && (!body.nightRoutine || !body.exercise)) return fail('visibility-incomplete');
    if (['daily-routine', 'routine-visibility'].includes(action) && body.sleepTags?.complete !== true) return fail('visibility-incomplete');
  }
  return { outcome: 'success' };
}
export async function callAction(action, env, attempt) {
  // Also suppress email steps already persisted by an older deployment.
  if (action === 'daily-email') return { outcome: 'skipped', reason: 'email-cancelled' };
  const backup = action === 'monthly-backup';
  const secret = backup ? env.BACKUP_RUN_SECRET : env.SCHEDULER_RUN_SECRET;
  if (!secret) return { outcome: 'failed', reason: 'missing-run-secret', http: 0 };
  const readiness = await waitForOrigin(env, attempt, action);
  if (readiness) return readiness;
  const url = new URL(backup ? '/api/sync-monthly-backup' : '/api/ticktick-trips', env.ORIGIN);
  if (!backup) {
    url.searchParams.set('scheduler', '1');
    if (action !== 'full') url.searchParams.set('action', action);
  }
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` },
      redirect: 'manual', signal: AbortSignal.timeout(actionTimeout(action)) });
    const body = await response.json().catch(() => null);
    logOrigin('business', action, started, response, body);
    return classify(action, response.status, body, attempt);
  } catch (error) {
    logOrigin('business', action, started, undefined, undefined, error);
    // Only the idempotent archive is safe without a response. Never replay uncertain writes.
    return action === 'life-periods' ? classify(action, 0, null, attempt)
      : { outcome: 'failed', reason: 'response-unknown', http: 0 };
  }
}
