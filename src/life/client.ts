import { requestWithRetry } from '../utils/requestWithRetry';
import { accountFetch } from '../utils/authClient';
import { LIFE_KINDS, parseLifeEdit, type LifeEntry, type LifeKind } from '../utils/bonLife';
import { parseSymptomNames, type SymptomNames } from '../utils/lifeSymptoms';
import type { WellDay } from '../utils/lifeWell';

export class LifeError extends Error {
  constructor(message: string, public status: number, public current?: LifeEntry, public currentWell?: WellDay) { super(message); }
}

export async function lifeRequest<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(Object.entries(body ?? {}).map(([key, value]) => [key, String(value)]));
  return requestWithRetry(async (requestSignal) => {
    const response = await accountFetch(`/api/bonlife${method === 'GET' ? `?${query}` : ''}`, {
      method, signal: requestSignal,
      headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
    if (!response.ok || !result || typeof result !== 'object') {
      throw new LifeError(result?.error || '服务暂不可用，请重试', response.status, result?.current, result?.currentWell);
    }
    return result;
  }, { signal, retry: method === 'GET', timeoutMessage: '连接超时，请重试', networkMessage: '网络连接失败，请重试' });
}

export interface LifeDraft extends LifeEntry { date: string; kind: LifeKind; mutationId: string; symptomNames?: SymptomNames }
export function draftKey(owner: string) { return `bonlife:draft:v1:${encodeURIComponent(owner)}`; }
type DraftDate = Pick<LifeDraft, 'date' | 'kind'>;
function datedDraftKey(owner: string, draft: DraftDate) { return `${draftKey(owner)}:${draft.kind}:${draft.date}`; }
function sameDraft(left: DraftDate | null, right: DraftDate) { return left?.date === right.date && left.kind === right.kind; }
export function saveDraft(owner: string, draft: LifeDraft) {
  const value = JSON.stringify(draft);
  localStorage.setItem(datedDraftKey(owner, draft), value);
  localStorage.setItem(draftKey(owner), value);
}
export function removeDraft(owner: string, draft: DraftDate) {
  localStorage.removeItem(datedDraftKey(owner, draft));
  if (sameDraft(readDraft(owner), draft)) localStorage.removeItem(draftKey(owner));
}
export function readDraft(owner: string, date?: DraftDate): LifeDraft | null {
  try {
    const value = JSON.parse((date && localStorage.getItem(datedDraftKey(owner, date))) || localStorage.getItem(draftKey(owner)) || 'null') as LifeDraft | null;
    if (!value || !LIFE_KINDS.includes(value.kind) || (date && !sameDraft(value, date))) return null;
    parseLifeEdit(value);
    if (value.symptomNames !== undefined) {
      if (value.kind !== 'eyes' && value.kind !== 'discomfort') return null;
      parseSymptomNames(value.symptomNames, value.kind);
    }
    return value;
  } catch { return null; }
}
