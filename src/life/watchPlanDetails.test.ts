import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchPlanDetails } from './watchPlanDetails';
import { accountFetch } from '../utils/authClient';

vi.mock('../utils/authClient', () => ({ accountFetch: vi.fn() }));
const fetch = vi.mocked(accountFetch);
const plan = { date: '2026-11-13', generatedAt: '2026-11-13T00:00:00Z', selected: [] };
const response = (details: unknown = plan, status = 200) => new Response(JSON.stringify({ details }), { status });
let watcher: ReturnType<typeof watchPlanDetails> | undefined;
let page: EventTarget & { visibilityState: string };
let tab: EventTarget;
const callbacks = () => ({ onStart: vi.fn(), onDetails: vi.fn(), onError: vi.fn(), onSettled: vi.fn(), onExpired: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
  fetch.mockReset(); fetch.mockImplementation(async () => response());
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  tab = new EventTarget();
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', Object.assign(tab, { setInterval, clearInterval }));
});
afterEach(() => { watcher?.dispose(); watcher = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

it('打开读取，云端异步完成后通过轮询读取新快照，显式刷新也立即读取', async () => {
  const events = callbacks(); watcher = watchPlanDetails(events);
  await vi.advanceTimersByTimeAsync(0);
  expect(events.onDetails).toHaveBeenLastCalledWith(plan);
  expect(fetch).toHaveBeenCalledWith('/api/ticktick-trips?action=plan-details', expect.objectContaining({ cache: 'no-store' }));
  const latest = { ...plan, generatedAt: '2026-11-13T00:00:20Z' };
  fetch.mockImplementation(async () => response(latest));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(events.onDetails).toHaveBeenLastCalledWith(latest);
  watcher.refresh(); await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('跟踪本次 Orche 的云端状态，没有快照的失败也返回给页面', async () => {
  let id: string | undefined = 'manual-one';
  const progress = { state: 'running', message: 'Orchestrate 排期中…' };
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ details: null, progress })));
  const events = { ...callbacks(), getJobId: () => id, onProgress: vi.fn() };
  watcher = watchPlanDetails(events); await vi.advanceTimersByTimeAsync(0);
  expect(fetch.mock.calls[0][0]).toContain('jobId=manual-one');
  expect(events.onProgress).toHaveBeenLastCalledWith(progress, 'manual-one');
  const failed = { state: 'failed', message: 'Orchestrate 未完成：Outlook 日历读取失败' };
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ details: null, progress: failed })));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(events.onProgress).toHaveBeenLastCalledWith(failed, 'manual-one');
  expect(events.onDetails).toHaveBeenLastCalledWith(null);
  id = undefined;
  watcher.refresh(); await vi.advanceTimersByTimeAsync(0);
  expect(fetch.mock.calls.at(-1)![0]).not.toContain('jobId');
});

it('页面隐藏时暂停读取，返回页面和聚焦均刷新，关闭后移除监听和定时器', async () => {
  watcher = watchPlanDetails(callbacks()); await vi.advanceTimersByTimeAsync(0);
  page.visibilityState = 'hidden';
  await vi.advanceTimersByTimeAsync(60_000); expect(fetch).toHaveBeenCalledTimes(1);
  page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(2);
  tab.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  watcher.dispose();
  page.dispatchEvent(new Event('visibilitychange')); tab.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(60_000); expect(fetch).toHaveBeenCalledTimes(3);
});

it('上海跨天后移除昨天的详情，即使旧响应晚到也不显示昨日任务', async () => {
  vi.setSystemTime(new Date('2026-11-13T15:59:50Z'));
  const events = callbacks(); watcher = watchPlanDetails(events);
  await vi.advanceTimersByTimeAsync(0); expect(events.onDetails).toHaveBeenLastCalledWith(plan);
  await vi.advanceTimersByTimeAsync(30_000); expect(events.onDetails).toHaveBeenLastCalledWith(null);
  expect(events.onError).not.toHaveBeenCalled();
});

it('慢请求不重叠，关闭后丢弃迟到结果', async () => {
  let resolve!: (value: Response) => void;
  fetch.mockImplementation(() => new Promise(done => { resolve = done; }));
  const events = callbacks(); watcher = watchPlanDetails(events);
  tab.dispatchEvent(new Event('focus')); watcher.refresh();
  await vi.advanceTimersByTimeAsync(20_000); expect(fetch).toHaveBeenCalledTimes(1);
  watcher.dispose();
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  resolve(response()); await vi.advanceTimersByTimeAsync(0);
  expect(events.onDetails).not.toHaveBeenCalled(); expect(events.onSettled).not.toHaveBeenCalled();
});

it('读取失败显示错误，下轮可恢复；401 沿用登录失效处理', async () => {
  fetch.mockImplementationOnce(async () => response(null, 500));
  const events = callbacks(); watcher = watchPlanDetails(events);
  await vi.advanceTimersByTimeAsync(0);
  expect(events.onError).toHaveBeenCalledWith('排期详情读取失败');
  await vi.advanceTimersByTimeAsync(30_000); expect(events.onDetails).toHaveBeenLastCalledWith(plan);
  fetch.mockImplementationOnce(async () => response(null, 401)); watcher.refresh();
  await vi.advanceTimersByTimeAsync(0); expect(events.onExpired).toHaveBeenCalledOnce();
  expect(events.onDetails).toHaveBeenLastCalledWith(null);
});
