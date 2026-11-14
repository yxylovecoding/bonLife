import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise the built artifact through real HTTP without production credentials.
const deno = process.argv[2];
const child = spawn(deno || process.execPath, deno
  ? ['run', '--allow-all', 'dist-server/index.js'] : ['dist-server/index.js'], {
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    PORT: '0', NODE_ENV: 'production', RENDER: 'true',
    SYNC_SECRET: 'isolated-migration-smoke-test',
    CLOUD_SCHEDULER_RUN_SECRET: 'isolated-scheduler-smoke-test',
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stderr.on('data', data => { output += data; });
try {
  const port = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 20_000);
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/HTTP server ready:(\d+)/);
      if (match) { clearTimeout(timeout); accept(Number(match[1])); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Startup failed (${code}): ${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  let checks = 0;
  async function check(path, expected, options = {}) {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    assert.equal(response.status, expected, `${path}: ${await response.clone().text()}`);
    checks++;
    return response;
  }
  assert.deepEqual(await (await check('/healthz', 200)).json(), { ok: true });
  // Render reuses upstream connections for up to 75 seconds. Exercise reuse
  // beyond Node's default 5-second idle timeout against the deployed artifact.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const probe = () => new Promise((accept, reject) => {
      const req = request(base + '/healthz', { agent }, response => {
        response.resume();
        response.once('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            accept({ socket: req.socket, keepAlive: response.headers['keep-alive'] });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error('Keep-alive probe timed out')));
      req.once('error', reject); req.end();
    });
    const first = await probe();
    await delay(7000);
    const second = await probe();
    assert.ok(second.socket === first.socket, 'Render upstream connection must survive the default Node idle window');
    assert.ok(Number(first.keepAlive?.match(/timeout=(\d+)/)?.[1]) > 75, 'Advertised keep-alive must exceed Render proxy reuse');
    checks++;
  } finally { agent.destroy(); }
  // Fetch may normalize Host, so use raw HTTP to exercise canonical-domain routing.
  await new Promise((accept, reject) => {
    const req = request(base + '/life?view=briefing', { headers: { Host: 'bonbills.cn' } }, response => {
      response.resume();
      response.once('end', () => {
        try {
          assert.equal(response.statusCode, 308);
          assert.equal(response.headers.location, 'https://www.bonbills.cn/life?view=briefing');
          checks++; accept();
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
  const index = await check('/', 200);
  const html = await index.text();
  assert.match(html, /<html/);
  for (const path of ['/log', '/clothes', '/life/calendar']) assert.equal(await (await check(path, 200)).text(), html);
  const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  const js = await check(asset, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.equal(await (await check(asset, 200, { method: 'HEAD' })).text(), '');
  for (const path of ['/assets/missing.js', '/.env', '/package.json', '/api/_storage', '/api/missing']) await check(path, 404);
  const auth = await check('/api/auth', 200);
  assert.deepEqual(await auth.json(), { authenticated: false });
  assert.match(auth.headers.get('cache-control'), /no-store/);
  await check('/api/auth', 415, { method: 'POST', body: '{}' });
  await check('/api/auth', 403, { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  await check('/api/auth', 400, { method: 'POST', headers: { Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: '{}' });
  const logout = await check('/api/auth', 200, { method: 'DELETE' });
  assert.match(logout.headers.get('set-cookie'), /HttpOnly/);
  assert.match(logout.headers.get('set-cookie'), /Secure/);
  for (const path of ['/api/sync', '/api/sync-monthly-backup', '/api/ticktick-trips',
    '/api/latest-bill-attachment', '/api/boncv-profile', '/api/outlook-calendar',
    '/api/bonlife', '/api/bonclothes', '/api/notion-readinglist']) await check(path, 401);
  for (const action of ['routine-visibility', 'reading-visibility', 'hair-wash']) {
    const result = await (await check(`/api/ticktick-trips?scheduler=1&action=${action}`, 200,
      { headers: { Authorization: 'Bearer isolated-scheduler-smoke-test' } })).json();
    assert.deepEqual(result, result.skipped === 'rest-window' ? { ok: true, skipped: 'rest-window' }
      : { ok: true, rulesComplete: true, skipped: 'included-in-full' });
  }
  // Rewrites may not be overridden by caller-supplied app selectors.
  await check('/api/bonlife?app=write', 401);
  await check('/api/market-search', 400);
  await check('/api/market-chart?source=invalid', 400);
  await check('/api/holidays?year=invalid', 400);
  await check('/api/usd-rate', 405, { method: 'POST' });
  await check('/api/auth', 413, { method: 'POST', body: 'x'.repeat(4_500_001) });
  await new Promise((accept, reject) => {
    const req = request(base + '/api/auth', { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, response => {
      response.resume();
      response.once('end', () => { try { assert.equal(response.statusCode, 413); checks++; accept(); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.end(Buffer.alloc(4_500_001, 120));
  });
  console.log(`${deno ? 'Deno' : 'Node'} deployed-artifact HTTP checks passed: ${checks}`);
} finally {
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
  if (child.exitCode === null) await once(child, 'exit');
  clearTimeout(kill);
}
