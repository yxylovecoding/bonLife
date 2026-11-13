import type { Transaction, InValue } from '@libsql/client';

export type StoredKey = { key: string; kind: 'string' | 'hash' | 'zset'; value: string | null; expiresAt: number | null };

// All mutating methods run inside a primary write transaction. Expired keys
// behave as absent; replacement also clears stale hash/zset members.
export class StorageTransaction {
  constructor(readonly sql: Transaction, readonly now = Date.now()) {}
  async key(key: string): Promise<StoredKey | null> {
    const { rows } = await this.sql.execute({ sql: `SELECT key,kind,value,expires_at FROM storage_keys
      WHERE key=? AND (expires_at IS NULL OR expires_at>?)`, args: [key, this.now] });
    const row = rows[0];
    return row ? { key, kind: row.kind as StoredKey['kind'], value: row.value as string | null,
      expiresAt: row.expires_at === null ? null : Number(row.expires_at) } : null;
  }
  async get(key: string) {
    const entry = await this.key(key);
    if (entry && entry.kind !== 'string') throw new Error('Storage type mismatch');
    return entry?.value ?? null;
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    const values = new Map<string, string | null>();
    const unique = [...new Set(keys)];
    // Keep one snapshot, while bounding SQLite's parameter count. MGET treats
    // non-string and expired keys as missing and preserves order/duplicates.
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      const { rows } = await this.sql.execute({
        sql: `SELECT key,value FROM storage_keys WHERE kind='string'
          AND (expires_at IS NULL OR expires_at>?) AND key IN (${chunk.map(() => '?').join(',')})`,
        args: [this.now, ...chunk],
      });
      for (const row of rows) values.set(String(row.key), row.value as string | null);
    }
    return keys.map(key => values.get(key) ?? null);
  }
  async remove(key: string) {
    const exists = Boolean(await this.key(key));
    await this.sql.batch([
      { sql: 'DELETE FROM storage_hash WHERE key=?', args: [key] },
      { sql: 'DELETE FROM storage_zset WHERE key=?', args: [key] },
      { sql: 'DELETE FROM storage_keys WHERE key=?', args: [key] },
    ]);
    return Number(exists);
  }
  async set(key: string, value: string, options: { nx?: boolean; xx?: boolean; ex?: number; px?: number; keepTtl?: boolean } = {}) {
    const previous = await this.key(key);
    if (options.nx && previous || options.xx && !previous) return null;
    if (options.ex !== undefined && (!Number.isFinite(options.ex) || options.ex <= 0)
      || options.px !== undefined && (!Number.isFinite(options.px) || options.px <= 0)) throw new Error('Invalid storage expiry');
    const expiry = options.ex !== undefined ? this.now + options.ex * 1000 : options.px !== undefined ? this.now + options.px
      : options.keepTtl ? previous?.expiresAt ?? null : null;
    // A Redis SET replaces any previous type and clears TTL unless requested.
    await this.sql.batch([
      { sql: 'DELETE FROM storage_hash WHERE key=?', args: [key] },
      { sql: 'DELETE FROM storage_zset WHERE key=?', args: [key] },
      { sql: `INSERT INTO storage_keys(key,kind,value,expires_at) VALUES (?,'string',?,?)
        ON CONFLICT(key) DO UPDATE SET kind='string',value=excluded.value,expires_at=excluded.expires_at`, args: [key, value, expiry] },
    ]);
    return 'OK' as const;
  }
  async expire(key: string, seconds: number) {
    if (!await this.key(key)) return 0;
    await this.sql.execute({ sql: 'UPDATE storage_keys SET expires_at=? WHERE key=?', args: [this.now + seconds * 1000, key] });
    return 1;
  }
  async ensureKind(key: string, kind: 'hash' | 'zset') {
    const existing = await this.key(key);
    if (existing) { if (existing.kind !== kind) throw new Error('Storage type mismatch'); return; }
    await this.remove(key);
    await this.sql.execute({ sql: 'INSERT INTO storage_keys(key,kind,value,expires_at) VALUES (?,?,NULL,NULL)', args: [key, kind] });
  }
  async hget(key: string, field: string) {
    const existing = await this.key(key);
    if (!existing) return null;
    if (existing.kind !== 'hash') throw new Error('Storage type mismatch');
    const { rows } = await this.sql.execute({ sql: 'SELECT value FROM storage_hash WHERE key=? AND field=?', args: [key, field] });
    return rows[0]?.value as string | undefined ?? null;
  }
  async hvalues(key: string) {
    const existing = await this.key(key);
    if (!existing) return [];
    if (existing.kind !== 'hash') throw new Error('Storage type mismatch');
    const { rows } = await this.sql.execute({ sql: 'SELECT field,value FROM storage_hash WHERE key=?', args: [key] });
    return rows.map(row => [String(row.field), String(row.value)] as const);
  }
  async hset(key: string, fields: Record<string, string>) {
    const entries = Object.entries(fields);
    if (!entries.length) return 0;
    await this.ensureKind(key, 'hash');
    let added = 0;
    for (let offset = 0; offset < entries.length; offset += 100) {
      const chunk = entries.slice(offset, offset + 100);
      const found = await this.sql.execute({ sql: `SELECT COUNT(*) AS count FROM storage_hash WHERE key=? AND field IN (${chunk.map(() => '?').join(',')})`,
        args: [key, ...chunk.map(([field]) => field)] });
      added += chunk.length - Number(found.rows[0].count);
      await this.sql.execute({ sql: `INSERT INTO storage_hash(key,field,value) VALUES ${chunk.map(() => '(?,?,?)').join(',')}
        ON CONFLICT(key,field) DO UPDATE SET value=excluded.value`, args: chunk.flatMap(([field, value]) => [key, field, value]) });
    }
    return added;
  }
  async hdel(key: string, fields: string[]) {
    const entry = await this.key(key);
    if (!entry || !fields.length) return 0;
    if (entry.kind !== 'hash') throw new Error('Storage type mismatch');
    let removed = 0;
    for (const field of fields) {
      removed += (await this.sql.execute({ sql: 'DELETE FROM storage_hash WHERE key=? AND field=?', args: [key, field] })).rowsAffected;
    }
    const remaining = await this.sql.execute({ sql: 'SELECT 1 FROM storage_hash WHERE key=? LIMIT 1', args: [key] });
    if (!remaining.rows.length) await this.remove(key);
    return removed;
  }
  async query(sql: string, args: InValue[] = []) { return this.sql.execute({ sql, args }); }
}
