export const ISSUE_PASSWORD_RESET_SCRIPT = `
  local storedValue = redis.call('GET', KEYS[1])

  if not storedValue then
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
    return 1
  end

  local decodeSucceeded, storedData = pcall(cjson.decode, storedValue)

  if not decodeSucceeded then
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
    return 1
  end

  local storedRequestId = storedData.requestId
  local storedTimestamp = tonumber(storedData.requestTimestamp)

  local newRequestId = ARGV[2]
  local newTimestamp = tonumber(ARGV[3])

  if storedRequestId == newRequestId then
    local incoming = cjson.decode(ARGV[1])
    if storedData.tokenHash ~= incoming.tokenHash then return 0 end
    return 2
  end

  if storedTimestamp > newTimestamp then
    return 0
  end

  if storedTimestamp == newTimestamp and storedRequestId > newRequestId then
    return 0
  end

  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])

  return 1
`;
