import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type Client } from '@libsql/client';
import { createTursoKv } from './_tursoKv';
import { initializeTursoSchema } from './_tursoSchema';
import { readBonCalInputs } from './_bonCal/repository';
import sync from './sync';

const state = vi.hoisted(() => ({ kv: undefined as ReturnType<typeof createTursoKv> | undefined }));
vi.mock('./_accountKv.js', () => ({ kv: new Proxy({}, { get: (_target, key) => state.kv![key as keyof typeof state.kv] }) }));
vi.mock('./_auth.js', () => ({ authOk: async () => true }));
let client: Client;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  await initializeTursoSchema(client);
  state.kv = createTursoKv(client);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); client.close(); });

it('loads the saved ledger without holiday providers or unrelated calendar adapters', async () => {
  const ledger = { expenseItems: [{ id: 'bill', amount: 100 }], hasOverride: true };
  await state.kv!.mset({
    'bill-details': ledger,
    'calendar-tags': { tagMap: { '2026-11-13': 'home' } },
    'app-config': { config: { schoolPeriods: [], internshipPeriods: [
      { startDate: '2026-01-01', endDate: '2026-12-31', rules: { workweek: 'statutory' } },
    ] } },
  });
  const external = vi.fn(() => { throw new Error('startup must not fetch providers'); });
  vi.stubGlobal('fetch', external);
  const adapters = vi.spyOn(state.kv!, 'hgetall');
  const transactions = vi.spyOn(client, 'transaction');
  let body: any;
  const res = { setHeader: vi.fn(), status: vi.fn(() => res), json: vi.fn(value => { body = value; return res; }) };
  await sync({ method: 'GET', headers: {} } as VercelRequest, res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(body['bill-details']).toEqual(ledger);
  expect(body['calendar-tags'].tagMap).toEqual({ '2026-11-13': 'home' });
  expect(transactions.mock.calls.length).toBeLessThanOrEqual(12);
  expect(external).not.toHaveBeenCalled();
  expect(adapters).not.toHaveBeenCalled();
  expect(body.bonCalRevision).toBe((await readBonCalInputs()).revision);
});
