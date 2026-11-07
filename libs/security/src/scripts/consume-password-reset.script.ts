export const CONSUME_PASSWORD_RESET_SCRIPT = `
  local storedValue = redis.call('GET', KEYS[1])

  if not storedValue then
    return 0
  end

  local decoded, record = pcall(cjson.decode, storedValue)

  if not decoded or type(record) ~= 'table' or type(record.tokenHash) ~= 'string' then
    return 0
  end

  if record.tokenHash ~= ARGV[1] then
    return 0
  end

  return redis.call('DEL', KEYS[1])
`;
