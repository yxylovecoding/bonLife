import { apiFetch } from '../utils/authClient';
import type { BonCalContext } from './state';

let revision: string | undefined;
export function bonCalRevision() { return revision; }
export function acceptBonCalRevision(value: unknown) { if (typeof value === 'string') revision = value; }
export async function readBonCalContext(startDate: string, endDate: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ action: 'context', startDate, endDate });
  const response = await apiFetch(`/api/outlook-calendar?${params}`, { signal, cache: 'no-store' });
  const result = await response.json() as BonCalContext & { error?: string };
  if (!response.ok) throw new Error(result.error || '日历读取失败');
  return result;
}
