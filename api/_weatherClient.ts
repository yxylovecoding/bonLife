export class WeatherRequestError extends Error {
  constructor(readonly kind: 'http' | 'timeout' | 'network' | 'json' | 'schema', readonly status?: number, readonly code?: string) {
    super('天气服务暂不可用');
  }
}

export function weatherFailureDetails(error: unknown) {
  return error instanceof WeatherRequestError ? { kind: error.kind, status: error.status, code: error.code } : { kind: 'unknown' };
}

export async function upstream(url: URL) {
  let result: Response;
  try { result = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error' }); }
  catch (error) {
    const rawCode = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
    const code = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].find(value => value === rawCode);
    const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) || code?.includes('TIMEOUT') || code === 'ETIMEDOUT';
    throw new WeatherRequestError(timeout ? 'timeout' : 'network', undefined, code);
  }
  if (!result.ok) throw new WeatherRequestError('http', result.status);
  try { return await result.json(); }
  catch (error) { throw new WeatherRequestError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'json'); }
}
