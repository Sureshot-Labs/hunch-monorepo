import { randomBytes } from "node:crypto";

import type {
  PythSolUsdCacheFence,
  PythSolUsdCacheWriteResult,
  PythSolUsdLastKnownStore,
  PythSolUsdPriceRecord,
} from "./pyth-sol-usd-price-adapter.js";
import { compareUnsignedDecimals } from "./decimal.js";

type LastKnownRedisClient = Readonly<{
  eval: (
    script: string,
    options: Readonly<{
      keys: string[];
      arguments: string[];
    }>,
  ) => Promise<unknown>;
  invalidate?: () => void;
}>;

const LUA_VALIDATORS = `
local function redis_type(key)
  local reply = redis.call("TYPE", key)
  if type(reply) == "table" then return reply["ok"] end
  return reply
end

local function valid_generation(value)
  return type(value) == "string"
    and string.len(value) == 32
    and string.match(value, "^[0-9a-f]+$") ~= nil
end

local function valid_uint(value, max_length, allow_zero)
  if type(value) ~= "string" or string.len(value) == 0 or string.len(value) > max_length then
    return false
  end
  if string.match(value, "^%d+$") == nil then return false end
  if string.len(value) > 1 and string.sub(value, 1, 1) == "0" then return false end
  if not allow_zero and value == "0" then return false end
  return true
end

local function price_payload_digest(publish, unit_price, as_of, confidence)
  if type(publish) ~= "string"
    or type(unit_price) ~= "string"
    or type(as_of) ~= "string"
    or type(confidence) ~= "string" then
    return nil
  end
  return redis.sha1hex(
    publish .. string.char(0)
      .. unit_price .. string.char(0)
      .. as_of .. string.char(0)
      .. confidence
  )
end

local function valid_stored_price(key, publish)
  local unit_price = redis.call("HGET", key, "unitPriceUsd")
  local as_of = redis.call("HGET", key, "asOf")
  local confidence = redis.call("HGET", key, "confidence")
  local payload_digest = redis.call("HGET", key, "payloadSha1")
  return (confidence == "high" or confidence == "medium" or confidence == "low")
    and type(unit_price) == "string"
    and string.len(unit_price) > 0
    and string.len(unit_price) <= 128
    and type(as_of) == "string"
    and string.len(as_of) > 0
    and string.len(as_of) <= 64
    and payload_digest == price_payload_digest(
      publish,
      unit_price,
      as_of,
      confidence
    )
end
`;

const READ_FENCE_SCRIPT = `${LUA_VALIDATORS}
-- pyth-sol-usd-read-fence-v3
local key_type = redis_type(KEYS[1])
if key_type ~= "none" and key_type ~= "hash" then
  redis.call("DEL", KEYS[1])
  key_type = "none"
end

local state = redis.call("HGET", KEYS[1], "state")
local generation = redis.call("HGET", KEYS[1], "generation")
local schema = redis.call("HGET", KEYS[1], "schema")
local account = redis.call("HGET", KEYS[1], "account")
local feed_id = redis.call("HGET", KEYS[1], "feedId")
local metadata_valid = schema == "3"
  and valid_generation(generation)
  and (state == "empty" or state == "price" or state == "quarantine")
  and account == ARGV[2]
  and feed_id == ARGV[3]

if not metadata_valid then
  state = "empty"
  generation = ARGV[1]
  redis.call("DEL", KEYS[1])
  redis.call(
    "HSET",
    KEYS[1],
    "schema", "3",
    "state", state,
    "generation", generation,
    "account", ARGV[2],
    "feedId", ARGV[3]
  )
end

local now_seconds = tonumber(redis.call("TIME")[1])
local maximum_future_skew = tonumber(ARGV[4])
if state == "quarantine" then
  local barrier = redis.call("HGET", KEYS[1], "barrierSeconds")
  if not valid_uint(barrier, 16, true)
    or tonumber(barrier) > now_seconds + maximum_future_skew then
    barrier = "0"
  end
  return { "quarantine", generation, barrier, "", "", "", "" }
end

if state == "price" then
  local publish = redis.call("HGET", KEYS[1], "publishTimeSeconds")
  if not valid_uint(publish, 16, false)
    or tonumber(publish) > now_seconds + maximum_future_skew
    or not valid_stored_price(KEYS[1], publish) then
    publish = "0"
  end
  return {
    "price",
    generation,
    "0",
    publish,
    redis.call("HGET", KEYS[1], "unitPriceUsd") or "",
    redis.call("HGET", KEYS[1], "asOf") or "",
    redis.call("HGET", KEYS[1], "confidence") or ""
  }
end

return { "empty", generation, "0", "0", "", "", "" }
`;

const COMMIT_PRICE_SCRIPT = `${LUA_VALIDATORS}
-- pyth-sol-usd-commit-price-v3
local now_seconds = tonumber(redis.call("TIME")[1])
local maximum_future_skew = tonumber(ARGV[8])
local candidate_publish = ARGV[2]
if not valid_uint(candidate_publish, 16, false)
  or tonumber(candidate_publish) > now_seconds + maximum_future_skew then
  return 0
end

if redis_type(KEYS[1]) ~= "hash"
  or redis.call("HGET", KEYS[1], "schema") ~= "3"
  or redis.call("HGET", KEYS[1], "account") ~= ARGV[6]
  or redis.call("HGET", KEYS[1], "feedId") ~= ARGV[7]
  or redis.call("HGET", KEYS[1], "generation") ~= ARGV[1] then
  return 0
end

local state = redis.call("HGET", KEYS[1], "state")
if state == "quarantine" then
  local barrier = redis.call("HGET", KEYS[1], "barrierSeconds")
  if not valid_uint(barrier, 16, true)
    or tonumber(barrier) > now_seconds + maximum_future_skew then
    barrier = "0"
  end
  if tonumber(candidate_publish) <= tonumber(barrier) then return 0 end
elseif state == "price" then
  local current_publish = redis.call("HGET", KEYS[1], "publishTimeSeconds")
  if valid_uint(current_publish, 16, false)
    and tonumber(current_publish) <= now_seconds + maximum_future_skew
    and valid_stored_price(KEYS[1], current_publish) then
    if tonumber(candidate_publish) < tonumber(current_publish) then return 0 end
    if candidate_publish == current_publish then
      local identical = redis.call("HGET", KEYS[1], "unitPriceUsd") == ARGV[3]
        and redis.call("HGET", KEYS[1], "asOf") == ARGV[4]
        and redis.call("HGET", KEYS[1], "confidence") == ARGV[5]
      if identical then return 2 end
      -- The candidate was freshly decoded from the fully verified Pyth
      -- account after reading this exact generation. Replacing a divergent
      -- same-publish payload repairs malformed display fields without letting
      -- an old generation cross a quarantine fence.
    end
  end
elseif state ~= "empty" then
  return 0
end

redis.call("DEL", KEYS[1])
redis.call(
  "HSET",
  KEYS[1],
  "schema", "3",
  "state", "price",
  "generation", ARGV[1],
  "account", ARGV[6],
  "feedId", ARGV[7],
  "publishTimeSeconds", candidate_publish,
  "unitPriceUsd", ARGV[3],
  "asOf", ARGV[4],
  "confidence", ARGV[5],
  "payloadSha1", price_payload_digest(ARGV[2], ARGV[3], ARGV[4], ARGV[5])
)
return 1
`;

const QUARANTINE_SCRIPT = `${LUA_VALIDATORS}
-- pyth-sol-usd-quarantine-v3
local now_seconds = tonumber(redis.call("TIME")[1])
local maximum_future_skew = tonumber(ARGV[6])
local barrier = valid_uint(ARGV[3], 16, true) and ARGV[3] or "0"

if redis_type(KEYS[1]) == "hash"
  and redis.call("HGET", KEYS[1], "schema") == "3"
  and redis.call("HGET", KEYS[1], "account") == ARGV[4]
  and redis.call("HGET", KEYS[1], "feedId") == ARGV[5] then
  local current_state = redis.call("HGET", KEYS[1], "state")
  local current_clock = nil
  if current_state == "price" then
    current_clock = redis.call("HGET", KEYS[1], "publishTimeSeconds")
  elseif current_state == "quarantine" then
    current_clock = redis.call("HGET", KEYS[1], "barrierSeconds")
  end
  if valid_uint(current_clock, 16, true)
    and tonumber(current_clock) <= now_seconds + maximum_future_skew
    and tonumber(current_clock) > tonumber(barrier) then
    barrier = current_clock
  end
end

redis.call("DEL", KEYS[1])
redis.call(
  "HSET",
  KEYS[1],
  "schema", "3",
  "state", "quarantine",
  "generation", ARGV[1],
  "account", ARGV[4],
  "feedId", ARGV[5],
  "barrierSeconds", barrier,
  "reason", ARGV[2],
  "createdAtRedisSeconds", tostring(now_seconds)
)
return 1
`;

function withDeadline<T>(
  operation: Promise<T>,
  fallback: T,
  deadlineMs: number,
  onDeadline?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      try {
        onDeadline?.();
      } finally {
        resolve(fallback);
      }
    }, deadlineMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function generation(): string {
  return randomBytes(16).toString("hex");
}

function canonicalUint(value: unknown, options?: { allowZero?: boolean }) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  return options?.allowZero || value !== "0" ? value : null;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function parsePriceRecord(input: {
  asOf: unknown;
  confidence: unknown;
  publish: unknown;
  unitPriceUsd: unknown;
}): PythSolUsdPriceRecord | null {
  try {
    const publishTime = canonicalUint(input.publish);
    const asOf = canonicalIso(input.asOf);
    if (
      !publishTime ||
      typeof input.unitPriceUsd !== "string" ||
      input.unitPriceUsd.length > 128 ||
      compareUnsignedDecimals(input.unitPriceUsd, "0") <= 0 ||
      !asOf ||
      Math.floor(Date.parse(asOf) / 1_000).toString() !== publishTime ||
      (input.confidence !== "high" &&
        input.confidence !== "medium" &&
        input.confidence !== "low")
    ) {
      return null;
    }
    return {
      unitPriceUsd: input.unitPriceUsd,
      asOf,
      confidence: input.confidence,
    };
  } catch {
    // Corrupt display fields are ignored while the generation remains usable
    // for a subsequent freshly validated CAS repair.
    return null;
  }
}

function parseFence(value: unknown): PythSolUsdCacheFence | null {
  const fields = stringArray(value);
  if (!fields) return null;
  const [
    state,
    fenceGeneration,
    barrier,
    publish,
    unitPriceUsd,
    asOf,
    confidence,
  ] = fields;
  if (!fenceGeneration || !/^[0-9a-f]{32}$/.test(fenceGeneration)) return null;
  if (state === "empty") {
    return {
      state,
      generation: fenceGeneration,
      barrierSeconds: null,
      price: null,
    };
  }
  if (state === "quarantine") {
    const barrierSeconds = canonicalUint(barrier, { allowZero: true });
    return barrierSeconds
      ? {
          state,
          generation: fenceGeneration,
          barrierSeconds,
          price: null,
        }
      : null;
  }
  if (state !== "price") return null;
  return {
    state,
    generation: fenceGeneration,
    barrierSeconds: null,
    price: parsePriceRecord({ asOf, confidence, publish, unitPriceUsd }),
  };
}

function writeResult(value: unknown): PythSolUsdCacheWriteResult {
  return value === 1 || value === 2 ? "accepted" : "rejected";
}

function invalidateClient(client: LastKnownRedisClient | null): void {
  try {
    client?.invalidate?.();
  } catch {
    // Invalidating a disposable display-cache lane is best-effort.
  }
}

function createClientDeadlineGuard(): Readonly<{
  attach: (client: LastKnownRedisClient) => boolean;
  expire: () => void;
  invalidate: () => void;
}> {
  let activeClient: LastKnownRedisClient | null = null;
  let expired = false;
  let invalidated = false;
  const invalidate = () => {
    if (!activeClient || invalidated) return;
    invalidated = true;
    invalidateClient(activeClient);
  };
  return {
    attach: (client) => {
      activeClient = client;
      if (expired) invalidate();
      return !expired;
    },
    expire: () => {
      expired = true;
      invalidate();
    },
    invalidate,
  };
}

export function createPythSolUsdLastKnownStore(input: {
  cacheKey: string;
  deadlineMs: number;
  expectedAccount: string;
  expectedFeedId: string;
  getClient: () => Promise<LastKnownRedisClient | null>;
  getQuarantineClient: () => Promise<LastKnownRedisClient | null>;
  maximumFutureSkewSeconds?: number;
}): PythSolUsdLastKnownStore {
  const maximumFutureSkewSeconds = input.maximumFutureSkewSeconds ?? 60;
  let pendingRead: Promise<PythSolUsdCacheFence | null> | null = null;
  let visibleRead: Promise<PythSolUsdCacheFence | null> | null = null;
  let pendingCommit: Readonly<{
    key: string;
    actual: Promise<PythSolUsdCacheWriteResult>;
    visible: Promise<PythSolUsdCacheWriteResult>;
  }> | null = null;

  return {
    readFence: () => {
      if (!pendingRead) {
        const clientGuard = createClientDeadlineGuard();
        const actual = input
          .getClient()
          .then(async (client) => {
            if (!client) return null;
            if (!clientGuard.attach(client)) return null;
            return parseFence(
              await client.eval(READ_FENCE_SCRIPT, {
                keys: [input.cacheKey],
                arguments: [
                  generation(),
                  input.expectedAccount,
                  input.expectedFeedId,
                  maximumFutureSkewSeconds.toString(),
                ],
              }),
            );
          })
          .catch(() => {
            clientGuard.invalidate();
            return null;
          });
        const tracked = actual.finally(() => {
          if (pendingRead === tracked) {
            pendingRead = null;
            visibleRead = null;
          }
        });
        pendingRead = tracked;
        visibleRead = withDeadline(
          tracked,
          null,
          input.deadlineMs,
          clientGuard.expire,
        );
      }
      return visibleRead ?? Promise.resolve(null);
    },
    commitPrice: (request) => {
      const publishTimeSeconds = Math.floor(
        Date.parse(request.price.asOf) / 1_000,
      ).toString();
      if (
        !parsePriceRecord({
          asOf: request.price.asOf,
          confidence: request.price.confidence,
          publish: publishTimeSeconds,
          unitPriceUsd: request.price.unitPriceUsd,
        })
      ) {
        return Promise.resolve("rejected");
      }
      const key = JSON.stringify([request.expectedGeneration, request.price]);
      if (pendingCommit) {
        return pendingCommit.key === key
          ? pendingCommit.visible
          : Promise.resolve("unavailable");
      }
      const clientGuard = createClientDeadlineGuard();
      const actual = input
        .getClient()
        .then(async (client): Promise<PythSolUsdCacheWriteResult> => {
          if (!client) return "unavailable";
          if (!clientGuard.attach(client)) return "unavailable";
          return writeResult(
            await client.eval(COMMIT_PRICE_SCRIPT, {
              keys: [input.cacheKey],
              arguments: [
                request.expectedGeneration,
                publishTimeSeconds,
                request.price.unitPriceUsd,
                request.price.asOf,
                request.price.confidence,
                input.expectedAccount,
                input.expectedFeedId,
                maximumFutureSkewSeconds.toString(),
              ],
            }),
          );
        })
        .catch((): PythSolUsdCacheWriteResult => {
          clientGuard.invalidate();
          return "unavailable";
        });
      const visible = withDeadline(
        actual,
        "unavailable" as const,
        input.deadlineMs,
        clientGuard.expire,
      );
      pendingCommit = { key, actual, visible };
      void actual.finally(() => {
        if (pendingCommit?.actual === actual) pendingCommit = null;
      });
      return visible;
    },
    quarantine: (request) => {
      const clientGuard = createClientDeadlineGuard();
      const actual = input
        .getQuarantineClient()
        .then(async (client): Promise<PythSolUsdCacheWriteResult> => {
          if (!client) return "unavailable";
          if (!clientGuard.attach(client)) return "unavailable";
          return writeResult(
            await client.eval(QUARANTINE_SCRIPT, {
              keys: [input.cacheKey],
              arguments: [
                generation(),
                request.reason,
                request.trustedPublishBarrierSeconds,
                input.expectedAccount,
                input.expectedFeedId,
                maximumFutureSkewSeconds.toString(),
              ],
            }),
          );
        })
        .catch((): PythSolUsdCacheWriteResult => {
          clientGuard.invalidate();
          return "unavailable";
        });
      return withDeadline(
        actual,
        "unavailable" as const,
        input.deadlineMs,
        clientGuard.expire,
      );
    },
  };
}
