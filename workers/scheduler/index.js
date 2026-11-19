import { manualJob, scheduledJobs } from './schedule.js';
export { SchedulerQueue } from './queue.js';
function queue(env) { return env.SCHEDULER_QUEUE.get(env.SCHEDULER_QUEUE.idFromName('bonbills-production')); }
function enqueue(env, body) {
  return queue(env).fetch('https://scheduler.internal/enqueue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
export default {
  async scheduled(event, env, ctx) {
    // Keep cron delivery tiny; durable alarms own the long-running HTTP calls.
    ctx.waitUntil(enqueue(env, { jobs: scheduledJobs(event.scheduledTime, { monthlyBackup: env.MONTHLY_BACKUP_ENABLED === 'true' }), cronAt: event.scheduledTime })
      .then(response => { if (response.status !== 202) throw new Error('Scheduler enqueue failed'); }));
  },
  async fetch(request, env) {
    if (!env.DISPATCH_SECRET || request.headers.get('Authorization') !== `Bearer ${env.DISPATCH_SECRET}`)
      return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === '/push' && ['GET', 'POST'].includes(request.method)) {
      return queue(env).fetch(new Request('https://scheduler.internal/push', request));
    }
    if (path === '/status' && request.method === 'GET') return queue(env).fetch('https://scheduler.internal/status');
    if (path === '/dispatch' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
      if (!['full', 'hourly'].includes(body?.kind) || !/^[a-zA-Z0-9-]{1,80}$/.test(body?.id || ''))
        return new Response(null, { status: 400 });
      return enqueue(env, { jobs: [manualJob(body.kind, body.id, Date.now())], coalesce: true });
    }
    return new Response(null, { status: 404 });
  },
};
