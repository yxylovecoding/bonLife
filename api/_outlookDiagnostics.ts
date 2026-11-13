import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { validateOutlookUrl } from './_outlookCalendar.js';

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
function probeTls(host: string, address: string) {
  return new Promise<{ address: string; ms: number; phase: string; error?: string }>(resolve => {
    const started = Date.now();
    let phase = 'tcp', finished = false;
    const socket = tls.connect({ host: address, port: 443, servername: host, rejectUnauthorized: true });
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
function probeCalendar(url: string, address: string) {
  return new Promise<Record<string, unknown>>(resolve => {
    const started = Date.now();
    let finished = false;
    const request = https.get(url, {
      agent: false, family: 4, lookup: (_host, _options, callback) => callback(null, address, 4),
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
export async function diagnoseOutlookSource(value: string) {
  const url = validateOutlookUrl(value), host = new URL(url).hostname;
  const started = Date.now();
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
  const reads = await Promise.all(ready.map(item => probeCalendar(url, item.address)));
  return { host, ms: Date.now() - started, dns: { system: system.addresses, google, cloudflare }, connections, reads };
}
