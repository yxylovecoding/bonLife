import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { validateOutlookUrl } from './provider.js';

// Owner-only, read-only diagnostics. Neither provider URLs/bodies nor arbitrary
// exception messages cross this boundary. Every socket still verifies Outlook TLS.
const safeCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
function code(error: unknown) {
  const value = (error as { code?: string })?.code;
  return value && safeCodes.has(value) ? value : 'network';
}
export function publicIpv4(value: string) {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
}
async function publicDns(host: string, provider: 'google' | 'cloudflare') {
  const started = Date.now();
  try {
    const base = provider === 'google' ? 'https://dns.google/resolve' : 'https://cloudflare-dns.com/dns-query';
    const response = await fetch(`${base}?name=${host}&type=A`, {
      headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { provider, ms: Date.now() - started, http: response.status, addresses: [] as string[] };
    const data = await response.json();
    const addresses = Array.isArray(data?.Answer) ? data.Answer
      .filter((item: { type?: number; data?: unknown }) => item.type === 1 && typeof item.data === 'string' && publicIpv4(item.data))
      .map((item: { data: string }) => item.data).slice(0, 16) as string[] : [];
    return { provider, ms: Date.now() - started, addresses };
  } catch { return { provider, ms: Date.now() - started, error: 'dns-unavailable', addresses: [] as string[] }; }
}
function probeTls(host: string, address: string, options: tls.ConnectionOptions = {}) {
  return new Promise<{ address: string; ms: number; phase: string; error?: string }>(resolve => {
    const started = Date.now();
    let phase = 'tcp', finished = false;
    const socket = tls.connect({ host: address, port: 443, servername: host, rejectUnauthorized: true, ...options });
    const finish = (error?: string) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      resolve({ address, ms: Date.now() - started, phase, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => finish('ETIMEDOUT'), 5_000);
    socket.once('connect', () => { phase = 'tls'; });
    socket.once('secureConnect', () => { phase = 'ready'; finish(); });
    socket.once('error', error => finish(code(error)));
  });
}
function probeCalendar(url: string, address?: string, options: tls.ConnectionOptions = {}) {
  return new Promise<Record<string, unknown>>(resolve => {
    const started = Date.now();
    let finished = false;
    const request = https.get(url, {
      agent: false, family: 4, ...(address ? { lookup: (_host: string, _options: unknown, callback: (error: null, address: string, family: number) => void) => callback(null, address, 4) } : {}), ...options,
      signal: AbortSignal.timeout(12_000), headers: { Accept: 'text/calendar' },
    }, response => {
      const http = response.statusCode;
      if (http !== 200) { response.destroy(); finish({ http }); return; }
      let bytes = 0, prefix = '', suffix = '';
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4_000_000) { request.destroy(); finish({ http, error: 'size-limit' }); return; }
        if (prefix.length < 100) prefix += chunk.toString('utf8').slice(0, 100 - prefix.length);
        suffix = (suffix + chunk.toString('utf8')).slice(-100);
      });
      response.once('end', () => finish({ http, bytes, calendar: prefix.includes('BEGIN:VCALENDAR') && suffix.includes('END:VCALENDAR') }));
      response.once('error', error => finish({ http, error: code(error) }));
    });
    function finish(result: Record<string, unknown>) {
      if (finished) return;
      finished = true; resolve({ address, ms: Date.now() - started, ...result });
    }
    request.once('error', error => finish({ error: code(error) }));
  });
}
export function probeCurl(url: string): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    // Feed URL on stdin, never argv, a shell, logs, redirects or output metadata.
    const child = execFile('curl', ['--disable', '--config', '-', '--silent', '--ipv4', '--proto', '=https',
      '--max-time', '15', '--max-filesize', '4000000', '--output', '/dev/null',
      '--write-out', '%{http_code} %{remote_ip} %{time_connect} %{time_appconnect} %{size_download}'],
    { timeout: 17_000, maxBuffer: 4096 }, (error, stdout) => {
      const parts = stdout.trim().split(/\s+/);
      resolve({ client: 'curl', http: /^\d{3}$/.test(parts[0]) ? Number(parts[0]) : 0,
        address: publicIpv4(parts[1] ?? '') ? parts[1] : undefined,
        connectSeconds: Number(parts[2]) || 0, tlsSeconds: Number(parts[3]) || 0,
        bytes: Number(parts[4]) || 0, ...(error ? {
          error: error.code === 'ENOENT' ? 'client-unavailable' : 'request-failed',
          ...(typeof error.code === 'number' ? { exitCode: error.code } : {}),
        } : {}) });
    });
    child.stdin?.end(`url = ${JSON.stringify(url)}\n`);
  });
}
export async function diagnoseOutlookSource(value: string) {
  const url = validateOutlookUrl(value), host = new URL(url).hostname;
  const started = Date.now();
  const curlPromise = probeCurl(url);
  const [system, google, cloudflare] = await Promise.all([
    Promise.race([lookup(host, { all: true }).then(addresses => ({ addresses })),
      new Promise<{ addresses: { address: string; family: number }[] }>(resolve => {
        const timer = setTimeout(() => resolve({ addresses: [] }), 5_000); timer.unref();
      })]).catch(() => ({ addresses: [] })), publicDns(host, 'google'), publicDns(host, 'cloudflare'),
  ]);
  const addresses = [...new Set([...system.addresses.map(item => item.address), ...google.addresses, ...cloudflare.addresses])]
    .filter(publicIpv4).slice(0, 24);
  const connections = await Promise.all(addresses.map(address => probeTls(host, address)));
  const ready = connections.filter(item => item.phase === 'ready' && !item.error).slice(0, 2);
  const selected = connections.find(item => item.phase === 'tls')?.address ?? addresses[0];
  const alternate = new URL(url); alternate.hostname = 'outlook.com';
  const [reads, tls12, x25519, alpn, alternateRead, curl] = await Promise.all([
    Promise.all(ready.map(item => probeCalendar(url, item.address))),
    selected ? probeCalendar(url, selected, { maxVersion: 'TLSv1.2' }) : null,
    selected ? probeCalendar(url, selected, { ecdhCurve: 'X25519' }) : null,
    selected ? probeCalendar(url, selected, { ALPNProtocols: ['http/1.1'] }) : null,
    host === 'outlook.live.com' ? probeCalendar(alternate.href) : null, curlPromise,
  ]);
  return { host, runtime: process.version, ms: Date.now() - started, dns: { system: system.addresses, google, cloudflare },
    connections, reads, clients: { tls12, x25519, alpn, outlookCom: alternateRead, curl } };
}
