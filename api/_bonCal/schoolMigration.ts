import { kv } from '../_accountKv.js';
import { isOwnerScope } from '../_accountScope.js';
import type { AppConfig, SchoolPeriod } from '../../src/models/types.js';
import { BEIJING } from '../../src/utils/internship.js';
import { NANJING } from '../../src/utils/schoolPeriods.js';

// Owner-provided history. Registered accounts keep their own configuration.
export const OWNER_SCHOOL_PERIODS: SchoolPeriod[] = [
  { id: 'school-nanjing-202109', city: NANJING, startMonth: '2021-09', endMonth: '2025-06' },
  { id: 'school-beijing-202509', city: BEIJING, startMonth: '2025-09', endMonth: '2028-06' },
];

const compareAndSet = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

export async function migrateOwnerSchoolPeriods(state: unknown): Promise<unknown> {
  if (!isOwnerScope()) return state;
  let current = state;
  for (let attempt = 0; attempt < 3; attempt++) {
    const config = (current as { config?: Partial<AppConfig> } | null)?.config;
    if (!config || Object.prototype.hasOwnProperty.call(config, 'schoolPeriods')) return current;
    const next = { ...current as object, config: { ...config, schoolPeriods: OWNER_SCHOOL_PERIODS } };
    // Compare the full snapshot so a concurrent setting edit is never overwritten.
    if (await kv.eval(compareAndSet, ['app-config'], [JSON.stringify(current), JSON.stringify(next)]) === 1) return next;
    current = await kv.get('app-config');
  }
  return current;
}
