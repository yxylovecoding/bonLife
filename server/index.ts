import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Keep the existing handlers and account scopes; only the hosting adapter changes.
const routes = {
  auth: () => import('../api/auth.js'),
  sync: () => import('../api/sync.js'),
  'sync-monthly-backup': () => import('../api/sync-monthly-backup.js'),
  'latest-bill-attachment': () => import('../api/latest-bill-attachment.js'),
  'market-chart': () => import('../api/market-chart.js'),
  'market-search': () => import('../api/market-search.js'),
  'usd-rate': () => import('../api/usd-rate.js'),
  holidays: () => import('../api/holidays.js'),
  'boncv-profile': () => import('../api/boncv-profile.js'),
  'outlook-calendar': () => import('../api/outlook-calendar.js'),
  'ticktick-trips': () => import('../api/ticktick-trips.js'),
  ping: () => import('../api/ping.js'),
};
const rewrites: Record<string, string> = {
  bonlife: 'bonlife', bonclothes: 'bonclothes', 'notion-readinglist': 'notion-readinglist',
};
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const publicRoot = await realpath(fileURLToPath(new URL('../dist/', import.meta.url)));
const maxBodyBytes = 4_500_000;

function responseAdapter(res: ServerResponse) {
  const response = Object.assign(res, {
    status(code: number) { res.statusCode = code; return response; },
    json(value: unknown) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
      return response;
    },
    send(value: string | Buffer) {
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type',
        typeof value === 'string' ? 'text/html; charset=utf-8' : 'application/octet-stream');
      res.end(value);
      return response;
    },
    redirect(code: number | string, location?: string) {
      res.statusCode = typeof code === 'number' ? code : 307;
      res.setHeader('Location', typeof code === 'string' ? code : location!);
      res.end();
      return response;
    },
  });
  return response as unknown as VercelResponse;
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((accept, reject) => {
    let size = 0, rejected = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        if (!rejected) { rejected = true; chunks.length = 0; reject(new Error('body-too-large')); }
      } else if (!rejected) chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => { if (!rejected) accept(size ? Buffer.concat(chunks).toString('utf8') : undefined); });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request-aborted')));
  });
}

const server = createServer(async (req, rawResponse) => {
  const res = responseAdapter(rawResponse);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz' && ['GET', 'HEAD'].includes(req.method || '')) {
      return res.status(200).json({ ok: true });
    }
    if ((req.headers.host || '').split(':')[0].toLowerCase() === 'bonbills.cn') {
      return res.redirect(308, `https://www.bonbills.cn${url.pathname}${url.search}`);
    }
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      const rewrite = Object.hasOwn(rewrites, name) ? rewrites[name] : undefined;
      const route = rewrite ? 'outlook-calendar' : name;
      if (!Object.hasOwn(routes, route)) return res.status(404).json({ error: 'not found' });
      const contentLength = Number(req.headers['content-length'] || 0);
      if (contentLength > maxBodyBytes) { req.resume(); return res.status(413).json({ error: '请求过大' }); }
      const query: Record<string, string | string[]> = Object.create(null);
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        query[key] = values.length === 1 ? values[0] : values;
      }
      if (rewrite) query.app = rewrite;
      const request = Object.assign(req, { query, body: await readBody(req) }) as VercelRequest;
      const module = await routes[route as keyof typeof routes]();
      await module.default(request, res);
      if (!res.writableEnded) res.end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method || '')) return res.status(405).json({ error: 'method not allowed' });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return res.status(400).json({ error: 'invalid path' }); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) {
      return res.status(404).json({ error: 'not found' });
    }
    let file = resolve(publicRoot, `.${pathname}`);
    if (file !== publicRoot && !file.startsWith(publicRoot + sep)) return res.status(404).json({ error: 'not found' });
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      // Browser navigation gets the SPA; missing assets must not return HTML.
      if (extname(pathname)) return res.status(404).json({ error: 'not found' });
      file = resolve(publicRoot, 'index.html'); info = await stat(file);
    }
    file = await realpath(file);
    if (!file.startsWith(publicRoot + sep)) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    res.setHeader('Cache-Control', file.startsWith(resolve(publicRoot, 'assets') + sep)
      ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(file), rawResponse);
  } catch (error) {
    if (res.writableEnded || rawResponse.destroyed) return;
    if (res.headersSent) { rawResponse.destroy(); return; }
    const large = error instanceof Error && error.message === 'body-too-large';
    // Never log request bodies, cookies, secrets, provider URLs or error payloads.
    if (!large) console.error('HTTP request failed');
    res.status(large ? 413 : 500).json({ error: large ? '请求过大' : '服务暂不可用' });
  }
});
server.requestTimeout = 30_000;
// Render's proxy can reuse an upstream connection for 75 seconds. Node's
// five-second default can close it before reuse and surface as a gateway 502.
// Keep the request/body deadline separate from idle connection lifetime.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 120_000;
server.listen(Number(process.env.PORT || 8000), '0.0.0.0', () => {
  const address = server.address();
  console.log(`BonBills HTTP server ready:${typeof address === 'object' && address ? address.port : ''}`);
  if (process.env.BON_RAIN_REPLAY?.trim()) {
    void import('../api/_rainReminderReplay.js').then(({ runRainReminderReplay }) =>
      runRainReminderReplay(process.env.BON_RAIN_REPLAY, value => console.info('[rain-reminder-replay]', JSON.stringify(value))))
      .catch(() => console.error('[rain-reminder-replay]', JSON.stringify({ phase: 'failed', reason: '补跑未确认，不自动重试' })));
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
