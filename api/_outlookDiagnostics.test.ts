import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { diagnoseOutlookSource, publicIpv4 } from './_outlookDiagnostics';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [
  { address: '40.104.20.2', family: 4 }, { address: '127.0.0.1', family: 4 },
]) }));
vi.mock('node:child_process', () => ({ execFile: vi.fn((_file, _args, _options, callback) => {
  queueMicrotask(() => callback(null, '200 40.104.20.2 0.01 0.02 100'));
  return { stdin: { end: vi.fn() } };
}) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('limits probes to public addresses and never returns the subscription or body', async () => {
  const url = 'https://outlook.live.com/owa/calendar/SECRET/calendar.ics';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ Answer: [
    { type: 1, data: '40.104.20.2' }, { type: 1, data: '10.0.0.1' },
  ] }))));
  vi.spyOn(tls, 'connect').mockImplementation(((options: any) => {
    expect(options).toMatchObject({ host: '40.104.20.2', servername: 'outlook.live.com', rejectUnauthorized: true });
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    queueMicrotask(() => { socket.emit('connect'); socket.emit('secureConnect'); }); return socket;
  }) as any);
  vi.spyOn(https, 'get').mockImplementation(((value: string, options: any, callback: any) => {
    expect(new URL(value).pathname).toBe(new URL(url).pathname); expect(options.agent).toBe(false);
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = Object.assign(new PassThrough(), { statusCode: 200 }); callback(response);
      response.end('BEGIN:VCALENDAR\r\nPRIVATE EVENT\r\nEND:VCALENDAR');
    }); return request;
  }) as any);
  const result = await diagnoseOutlookSource(url);
  expect(result.connections).toHaveLength(1);
  expect(result.reads).toEqual([expect.objectContaining({ http: 200, calendar: true })]);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE EVENT|calendar\.ics/);
  expect(fetch).toHaveBeenCalledWith('https://dns.google/resolve?name=outlook.live.com&type=A', expect.anything());
  expect(JSON.stringify(vi.mocked(execFile).mock.calls)).not.toContain('SECRET');
  expect(result.clients.curl).toMatchObject({ http: 200, bytes: 100 });
});
it('rejects arbitrary URLs before DNS, and excludes private IPv4', async () => {
  await expect(diagnoseOutlookSource('http://127.0.0.1/calendar.ics')).rejects.toThrow('订阅链接');
  for (const value of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '::1']) {
    expect(publicIpv4(value)).toBe(false);
  }
});
