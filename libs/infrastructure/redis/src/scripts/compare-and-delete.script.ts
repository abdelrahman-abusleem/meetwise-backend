export const COMPARE_AND_DELETE_SCRIPT = `
  local storedValue = redis.call('GET', KEYS[1])

  if not storedValue then
    return 0
  end

  if storedValue ~= ARGV[1] then
    return 0
  end

  return redis.call('DEL', KEYS[1])
`;
