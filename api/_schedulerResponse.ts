// A scheduler only needs completion flags. Do not transfer plans, calendar URLs or errors.
export function schedulerResponse(body: Record<string, any>) {
  const safe: Record<string, unknown> = {};
  for (const key of ['ok', 'busy', 'deferred', 'connected', 'sent', 'duplicate', 'rulesComplete', 'partial'])
    if (typeof body?.[key] === 'boolean') safe[key] = body[key];
  if (body?.error) safe.error = true;
  if (['rest-window', 'sleep-window', 'restore-pending', 'disconnected', 'included-in-full'].includes(body?.skipped)) safe.skipped = body.skipped;
  if (body?.partial === true && Array.isArray(body.rules?.results))
    safe.completedRules = body.rules.results.filter((rule: { status?: string }) => rule.status === 'success').length;
  if (typeof body?.syncedAt === 'string') safe.syncedAt = body.syncedAt;
  for (const key of ['dailyPlan', 'nightRoutine', 'exercise', 'hairWash', 'reading'])
    if (body?.[key]) safe[key] = {};
  if (body?.sleepTags) safe.sleepTags = { complete: body.sleepTags.complete === true };
  for (const key of ['laundry', 'charging', 'hairWash', 'pickup']) if (body?.[key]?.outlook?.error) safe[key] = { outlook: { error: true } };
  const stages = ['completion-archive', 'outlook-refresh', 'tasks-read', 'completion-history', 'template-read', 'timed-visibility', 'planning', 'finalize'];
  if (body?.failure) safe.failure = { stage: stages.includes(body.failure.stage) ? body.failure.stage : 'unknown', retryable: body.failure.retryable === true };
  return safe;
}
