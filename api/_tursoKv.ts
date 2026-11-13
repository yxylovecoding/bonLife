import type { Client, Transaction } from '@libsql/client';
import { decodeStorage, encodeStorage } from './_storageCodec.js';
import { storageOperation } from './_storageScriptIds.js';
import { runStorageOperation } from './_tursoOperations.js';
import { StorageTransaction } from './_tursoTransaction.js';

type SetOptions = { nx?: boolean; xx?: boolean; ex?: number; px?: number; keepTtl?: boolean };

function transientNetworkError(error: unknown): boolean {
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const value = current as { name?: string; message?: string; code?: string; cause?: unknown };
    if (value.code && codes.has(value.code) || value.name === 'TypeError' && value.message === 'fetch failed') return true;
    current = value.cause;
  }
  return false;
}

export function createTursoKv(client: Client, clock = Date.now) {
  // A local libSQL connection cannot nest transactions. Also reduce contention
  // among parallel saves in one function; the database serializes other clients.
  let pending: Promise<unknown> = Promise.resolve();
  let nextCleanup = 0;
  function transaction<T>(work: (tx: StorageTransaction) => Promise<T>, write = true): Promise<T> {
    const run = pending.catch(() => {}).then(async () => {
      for (let attempt = 0; ; attempt++) {
        let sql: Transaction | undefined;
        let phase: 'opening' | 'working' | 'committing' = 'opening';
        try {
          sql = await client.transaction(write ? 'write' : 'read');
          phase = 'working';
          const now = clock();
          const cleanup = write && now >= nextCleanup;
          if (cleanup) {
            // Bound reclamation work. Expiry is enforced on every read regardless
            // of when these physical rows are removed.
            await sql.batch([
              `DELETE FROM storage_hash WHERE key IN (SELECT key FROM storage_keys WHERE expires_at<=${Math.trunc(now)} ORDER BY expires_at LIMIT 256)`,
              `DELETE FROM storage_zset WHERE key IN (SELECT key FROM storage_keys WHERE expires_at<=${Math.trunc(now)} ORDER BY expires_at LIMIT 256)`,
              `DELETE FROM storage_keys WHERE key IN (SELECT key FROM storage_keys WHERE expires_at<=${Math.trunc(now)} ORDER BY expires_at LIMIT 256)`,
            ]);
          }
          const result = await work(new StorageTransaction(sql, now));
          phase = 'committing';
          await sql.commit();
          if (cleanup) nextCleanup = now + 3_600_000;
          return result;
        } catch (error) {
          if (sql && !sql.closed) await sql.rollback().catch(() => {});
          // Work touches only this SQL transaction. Before COMMIT is sent,
          // closing/rolling back makes a fresh transaction safe, including INCR.
          // Never replay a write after an ambiguous COMMIT response.
          if (attempt >= 2 || write && phase === 'committing' || !transientNetworkError(error)) {
            if (transientNetworkError(error)) console.error('[turso-transaction-failure]', JSON.stringify({ write, phase }));
            throw error;
          }
          console.warn('[turso-transaction-retry]', JSON.stringify({ write, phase, attempt: attempt + 1 }));
        } finally { sql?.close(); }
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    });
    pending = run;
    return run;
  }
  return {
    get: <T = unknown>(key: string) => transaction(async tx => decodeStorage<T | null>(await tx.get(key)), false),
    set: <T>(key: string, value: T, options: SetOptions = {}) => transaction(tx => {
      if (Object.keys(options).some(option => !['nx', 'xx', 'ex', 'px', 'keepTtl'].includes(option))
        || options.nx && options.xx || options.ex !== undefined && options.px !== undefined) throw new Error('Unsupported storage SET options');
      return tx.set(key, encodeStorage(value), options);
    }),
    del: (...keys: string[]) => transaction(async tx => {
      let removed = 0;
      for (const key of keys) removed += await tx.remove(key);
      return removed;
    }),
    incr: (key: string) => transaction(async tx => {
      const raw = await tx.get(key);
      if (raw !== null && !/^-?(0|[1-9]\d*)$/.test(raw)) throw new Error('Storage value is not an integer');
      const next = BigInt(raw ?? '0') + 1n;
      if (next > 9223372036854775807n || next < -9223372036854775808n) throw new Error('Storage increment overflow');
      await tx.set(key, String(next), { keepTtl: true });
      return Number(next);
    }),
    mget: <T extends unknown[]>(...keys: string[]) => transaction(async tx => {
      return (await tx.mget(keys)).map(value => decodeStorage(value)) as T;
    }, false),
    mset: (values: Record<string, unknown>) => transaction(async tx => {
      for (const [key, value] of Object.entries(values)) await tx.set(key, encodeStorage(value));
      return 'OK' as const;
    }),
    hget: <T = unknown>(key: string, field: string) => transaction(async tx => decodeStorage<T | null>(await tx.hget(key, field)), false),
    hgetall: <T>(key: string) => transaction(async tx => {
      const values = await tx.hvalues(key);
      return values.length ? Object.fromEntries(values.map(([field, value]) => [field, decodeStorage(value)])) as T : null;
    }, false),
    hset: (key: string, values: Record<string, unknown>) => transaction(tx => tx.hset(key,
      Object.fromEntries(Object.entries(values).map(([field, value]) => [field, encodeStorage(value)])))),
    hdel: (key: string, ...fields: string[]) => transaction(tx => tx.hdel(key, fields)),
    eval: <TArgs extends unknown[], TResult = unknown>(script: string, keys: string[], args: TArgs) => {
      const operation = storageOperation(script);
      const write = !['read-photo', 'photo-sizes', 'wear-page', 'read-make-quota'].includes(operation);
      return transaction(async tx => decodeStorage<TResult>(await runStorageOperation(tx, operation, keys, args.map(encodeStorage))), write);
    },
  };
}
