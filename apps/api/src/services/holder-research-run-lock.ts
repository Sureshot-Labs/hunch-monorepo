type LockRedis = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};

const RENEW_OWNED_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_OWNED_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export async function renewHolderResearchRunLock(input: {
  redis: LockRedis;
  key: string;
  owner: string;
  ttlMs: number;
}): Promise<boolean> {
  const renewed = await input.redis.eval(RENEW_OWNED_LOCK_SCRIPT, {
    keys: [input.key],
    arguments: [input.owner, String(input.ttlMs)],
  });
  return Number(renewed) === 1;
}

export async function releaseHolderResearchRunLock(input: {
  redis: LockRedis;
  key: string;
  owner: string;
}): Promise<void> {
  await input.redis.eval(RELEASE_OWNED_LOCK_SCRIPT, {
    keys: [input.key],
    arguments: [input.owner],
  });
}
