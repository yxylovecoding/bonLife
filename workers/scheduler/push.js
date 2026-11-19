// Empty Web Push messages need VAPID authentication, but no payload encryption.
// The BonLog service worker supplies fixed notification text on the device.
const pushHosts = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(web\.)?push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const json = value => encode(new TextEncoder().encode(JSON.stringify(value)));

export function pushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && url.pathname.length > 1 && pushHosts.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

export async function pushKeys(storage) {
  const saved = await storage.get('push-keys');
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = {
    publicKey: encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  await storage.put('push-keys', keys);
  return keys;
}

export async function sendPush(endpoint, keys) {
  if (!pushEndpoint(endpoint)) return 'expired';
  try {
    const audience = new URL(endpoint).origin;
    const claims = json({ aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, sub: 'https://log.bonbills.cn' });
    const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${claims}`;
    const key = await crypto.subtle.importKey('jwk', keys.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `vapid t=${unsigned}.${encode(new Uint8Array(signature))}, k=${keys.publicKey}`,
        TTL: '3600', Urgency: 'high', Topic: 'bonlog-orche' } });
    if ([404, 410].includes(response.status)) return 'expired';
    if (response.ok) return 'sent';
    console.warn('[orche-push] HTTP', response.status);
    return response.status === 429 || response.status >= 500 ? 'retry' : 'failed';
  } catch {
    console.warn('[orche-push] request failed');
    return 'retry';
  }
}
