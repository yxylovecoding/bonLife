import { createHash } from 'node:crypto';
import type { StorageOperation } from './_storageScriptIds.js';
import type { StorageTransaction } from './_tursoTransaction.js';
import { WELL_KINDS, type WellDay, type WellEdit, type WellEntries } from '../src/utils/lifeWell.js';
import { EMPTY_MAKEUP } from '../src/utils/lifeMakeup.js';

const json = (raw: string) => JSON.parse(raw);
const photoValue = (raw: string) => raw.startsWith('"') ? String(json(raw)) : raw;
const validator = (photo: string) => `photo-v2-${createHash('sha1').update(photo).digest('hex')}`;
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

// Ports of the project's finite set of Redis scripts. The caller provides one
// primary transaction, so checks and writes cannot race another request.
export async function runStorageOperation(tx: StorageTransaction, operation: StorageOperation, keys: string[], args: string[]): Promise<unknown> {
  const [key, second, third, fourth] = keys;
  switch (operation) {
    case 'release-lock':
      return await tx.get(key) === args[0] ? tx.remove(key) : 0;
    case 'renew-outlook-lock':
      return await tx.get(key) === args[0] ? tx.expire(key, 180) : 0;
    case 'release-email': {
      const raw = await tx.get(key);
      return raw && json(raw).attempt === args[0] ? tx.remove(key) : 0;
    }
    case 'compare-set':
      if (await tx.get(key) !== args[0]) return 0;
      await tx.set(key, args[1]); return 1;
    case 'save-periods':
    case 'save-outlook-done':
    case 'save-training': {
      const connection = await tx.get(key);
      if (!connection) return 0;
      const data = json(connection);
      if ((operation === 'save-training' ? data.encryptedToken?.data : data.id) !== args[0]) return 0;
      const raw = await tx.get(second);
      const previous = raw ? json(raw) : null;
      if (operation === 'save-periods') {
        if (previous ? previous.requestedAt !== Number(args[3]) : Number(args[3]) !== 0) return -1;
      } else if (previous && previous.requestedAt > Number(args[operation === 'save-training' ? 2 : 1])) return 0;
      await tx.set(second, args[operation === 'save-training' ? 1 : 2]); return 1;
    }
    case 'save-done': {
      const connection = await tx.get(key);
      if (!connection || json(connection).encryptedToken?.data !== args[0]) return 0;
      await tx.hset(second, Object.fromEntries(json(args[1]).map((item: { id: string }) => [item.id, JSON.stringify(item)])));
      await tx.hset(fourth, json(args[3]));
      const previous = await tx.get(third);
      if (!previous || json(previous) < args[2]) await tx.set(third, JSON.stringify(args[2]));
      return 1;
    }
    case 'read-make-quota': {
      const entry = await tx.key(key);
      if (!entry) return [0, 0];
      if (entry.kind !== 'zset') throw new Error('Storage type mismatch');
      const { rows } = await tx.query('SELECT score FROM storage_zset WHERE key=? AND score>? ORDER BY score,member', [key, Number(args[0])]);
      return [rows.length, rows.length >= 200 ? Number(rows[rows.length - 200].score) : 0];
    }
    case 'reserve-make': {
      await tx.ensureKind(key, 'zset');
      await tx.query('DELETE FROM storage_zset WHERE key=? AND score<=?', [key, Number(args[0]) - 2_764_800_000]);
      const count = await tx.query('SELECT COUNT(*) AS count FROM storage_zset WHERE key=?', [key]);
      if (Number(count.rows[0].count) >= 200) return 0;
      await tx.query(`INSERT INTO storage_zset(key,member,score) VALUES (?,?,?)
        ON CONFLICT(key,member) DO UPDATE SET score=excluded.score`, [key, args[1], Number(args[0])]);
      await tx.expire(key, 2_764_800); return 1;
    }
    case 'save-clothes': {
      const receipt = await tx.get(second);
      if (receipt) {
        const previous = json(receipt);
        return previous.signature !== args[6] ? [-3, ''] : [1, JSON.stringify(previous.value)];
      }
      const raw = await tx.hget(key, args[0]);
      if ((raw ? json(raw).revision : '') !== args[1]) return [0, raw ?? ''];
      for (const check of json(args[5])) {
        const item = await tx.hget(third, check.id);
        const value = item ? json(item) : null;
        if (!value || value.deleted || !['可穿', '待洗'].includes(value.status) || value.revision !== check.revision) return [-2, ''];
      }
      if (fourth !== undefined && fourth !== '') {
        if (args[4] !== '') await tx.set(fourth, args[4], { nx: true });
        else if (!await tx.key(fourth)) return [-1, ''];
      }
      await tx.hset(key, { [args[0]]: args[3] });
      await tx.set(second, JSON.stringify({ signature: args[6], value: json(args[3]) }), { ex: 2_592_000 });
      return [1, args[3]];
    }
    case 'save-well': {
      const [date, mutation, payload, signature] = args;
      const edit: WellEdit = json(payload);
      const readDay = async (): Promise<WellDay> => {
        const entries = {} as WellEntries;
        for (const kind of WELL_KINDS) {
          const raw = await tx.hget(key, `${kind}:${date}`);
          entries[kind] = raw ? json(raw) : { text: '', revision: '' };
          delete entries[kind].makeup;
        }
        const shared = await tx.hget(key, `makeup:${date}`);
        return { entries, makeup: shared ? json(shared).makeup : { ...EMPTY_MAKEUP } };
      };
      const current = await readDay();
      const receipt = await tx.get(third);
      if (receipt) return [receipt === signature ? 1 : -1, JSON.stringify(current)];
      if (WELL_KINDS.some(kind => edit.entries[kind] && edit.entries[kind]!.revision !== current.entries[kind].revision)
        || edit.makeup && edit.makeup.revision !== current.makeup.revision) return [0, JSON.stringify(current)];
      for (const kind of WELL_KINDS) {
        const entry = edit.entries[kind];
        if (!entry) continue;
        const next = { ...entry, revision: mutation };
        if (kind !== 'mood' && next[kind] === undefined) Object.assign(next, { [kind]: current.entries[kind][kind] });
        const field = `${kind}:${date}`;
        await tx.hset(key, { [field]: JSON.stringify(next) });
        if (kind === 'eyes' || kind === 'discomfort') await tx.hset(second, { [field]: JSON.stringify(next) });
      }
      if (edit.makeup) await tx.hset(key, { [`makeup:${date}`]: JSON.stringify({ text: '', revision: mutation,
        makeup: { ...edit.makeup, revision: mutation } }) });
      await tx.set(third, signature, { ex: 2_592_000 });
      return [1, JSON.stringify(await readDay())];
    }
    case 'save-life-entry': {
      const raw = await tx.hget(key, args[0]);
      const current = raw ? json(raw) : { revision: '', text: '' };
      const makeupKey = args[5];
      const shared = makeupKey ? await tx.hget(key, makeupKey) : null;
      let makeup = shared ? json(shared).makeup : undefined;
      const decorated = (value: string) => {
        if (!makeup) return value;
        return JSON.stringify({ ...(value ? json(value) : { revision: '', text: '' }), makeup });
      };
      if (current.revision === args[2]) return [1, decorated(raw ?? '')];
      if (current.revision !== args[1]) return [0, decorated(raw ?? '')];
      let encoded = args[3];
      if (!['cycle', 'skin-settings'].includes(args[4])) {
        const next = json(encoded);
        if (next.makeup && makeupKey) {
          if (next.makeup.revision !== (makeup?.revision ?? '')) return [0, decorated(raw ?? '')];
          if (!makeup || next.makeup.face !== makeup.face || next.makeup.eyes !== makeup.eyes) {
            makeup = { ...next.makeup, revision: args[2] };
            await tx.hset(key, { [makeupKey]: JSON.stringify({ text: '', revision: args[2], makeup }) });
          }
        }
        delete next.makeup;
        for (const field of ['skin', 'eyes', 'discomfort', 'body', 'training']) {
          if (next[field] === undefined) next[field] = current[field];
        }
        encoded = JSON.stringify(next);
      }
      await tx.hset(key, { [args[0]]: encoded });
      if (second !== undefined) await tx.hset(second, { [args[0]]: encoded });
      return [1, decorated(encoded)];
    }
    case 'read-photo': {
      const raw = await tx.get(key);
      if (!raw) return ['', ''];
      const photo = photoValue(raw);
      const etag = photo.startsWith('{') ? json(photo).validator : validator(photo);
      return [etag, json(args[0]).some((tag: string) => tag === `"${etag}"` || tag === '*') ? '' : photo];
    }
    case 'compress-photo':
    case 'migrate-photo': {
      const raw = await tx.get(key);
      if (raw === null) return [-1, 0];
      const compress = operation === 'compress-photo';
      if (raw.startsWith('{')) return [compress ? -3 : 0, 0];
      const photo = photoValue(raw);
      if (compress && (bytes(args[1]) >= bytes(raw) || photo === args[1])) return [0, 0];
      if (validator(photo) !== args[0]) return [-2, 0];
      await tx.set(key, args[1], { keepTtl: true });
      return [1, Math.max(0, bytes(raw) - bytes(args[1]))];
    }
    case 'wear-page': {
      // Filter in SQL: old history does not traverse the database/API boundary.
      const entry = await tx.key(key);
      if (!entry) return [];
      if (entry.kind !== 'hash') throw new Error('Storage type mismatch');
      const condition = args[1] === 'day' ? `json_extract(value,'$.date')=?`
        : `COALESCE(json_extract(value,'$.kind'),'')<>'styled' AND json_extract(value,'$.date')<=?`;
      const result = await tx.query(`WITH records AS (
        SELECT value,json_extract(value,'$.date') AS date FROM storage_hash WHERE key=? AND ${condition}
      ), days AS (SELECT DISTINCT date FROM records ORDER BY date DESC LIMIT 30)
      SELECT value FROM records WHERE date >= (SELECT MIN(date) FROM days)`, [key, args[0]]);
      return result.rows.map(row => row.value);
    }
    case 'photo-sizes': {
      // Resolve references and measure bytes in SQL, never download image bodies.
      const result = await tx.query(`WITH live_hash AS (
        SELECT h.key,h.value FROM storage_hash h JOIN storage_keys k ON k.key=h.key
        WHERE h.key IN (?,?) AND k.kind='hash' AND (k.expires_at IS NULL OR k.expires_at>?)
      ), ids AS (
        SELECT json_extract(value,'$.photoId') AS id FROM live_hash WHERE key=?
        UNION SELECT json_extract(item.value,'$.photoId') FROM live_hash h,json_each(h.value,'$.items') item WHERE h.key=?
      ) SELECT ids.id,length(CAST(k.value AS BLOB)) AS bytes FROM ids JOIN storage_keys k ON k.key=?||ids.id
      WHERE typeof(ids.id)='text' AND ids.id<>'' AND ids.id NOT GLOB '*[^a-zA-Z0-9-]*'
        AND k.kind='string' AND (k.expires_at IS NULL OR k.expires_at>?)
        AND length(CAST(k.value AS BLOB))>? AND substr(k.value,1,1)<>'{'`,
      [key, second, tx.now, key, second, third, tx.now, Number(args[0])]);
      return result.rows.map(row => [row.id, Number(row.bytes)]);
    }
  }
}
