// Keep the Lua and Turso port equivalent: validate every version before any write.
export const SAVE_WELL = `
  local date = ARGV[1]
  local mutation = ARGV[2]
  local edit = cjson.decode(ARGV[3])
  local kinds = {'skin', 'eyes', 'discomfort', 'mood'}
  local function readDay()
    local entries = {}
    for _, kind in ipairs(kinds) do
      local raw = redis.call('hget', KEYS[1], kind .. ':' .. date)
      entries[kind] = raw and cjson.decode(raw) or {text = '', revision = ''}
      entries[kind].makeup = nil
    end
    local shared = redis.call('hget', KEYS[1], 'makeup:' .. date)
    local makeup = shared and cjson.decode(shared).makeup or {face = cjson.null, eyes = cjson.null, revision = ''}
    return {entries = entries, makeup = makeup}
  end
  local current = readDay()
  local receipt = redis.call('get', KEYS[3])
  if receipt then
    if receipt ~= ARGV[4] then return {-1, cjson.encode(current)} end
    return {1, cjson.encode(current)}
  end
  for _, kind in ipairs(kinds) do
    if edit.entries[kind] and edit.entries[kind].revision ~= current.entries[kind].revision then
      return {0, cjson.encode(current)}
    end
  end
  if edit.makeup and edit.makeup.revision ~= current.makeup.revision then return {0, cjson.encode(current)} end
  if edit.entries.eyes or edit.entries.discomfort then
    local indexType = redis.call('type', KEYS[2]).ok
    if indexType ~= 'none' and indexType ~= 'hash' then return redis.error_reply('Storage type mismatch') end
  end
  for _, kind in ipairs(kinds) do
    if edit.entries[kind] then
      local next = edit.entries[kind]
      if kind ~= 'mood' and next[kind] == nil then next[kind] = current.entries[kind][kind] end
      next.revision = mutation
      local encoded = cjson.encode(next)
      redis.call('hset', KEYS[1], kind .. ':' .. date, encoded)
      if kind == 'eyes' or kind == 'discomfort' then redis.call('hset', KEYS[2], kind .. ':' .. date, encoded) end
    end
  end
  if edit.makeup then
    edit.makeup.revision = mutation
    redis.call('hset', KEYS[1], 'makeup:' .. date, cjson.encode({text = '', revision = mutation, makeup = edit.makeup}))
  end
  redis.call('set', KEYS[3], ARGV[4], 'EX', 2592000)
  return {1, cjson.encode(readDay())}
`;
