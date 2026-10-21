import type { createRedisClient } from "@hunch/infra";
import {
  renewHolderResearchRunLock,
  releaseHolderResearchRunLock,
} from "./holder-research-run-lock.js";

export type AgentRedis = ReturnType<typeof createRedisClient>;
export const AGENT_THESES_PREFIX = "ai:agent_theses:v1";
export const AGENT_PREVIEW_PREFIX = `${AGENT_THESES_PREFIX}:preview`;
const TTL = 120_000;

// One atomic reservation across all authors/runs. Redis time defines the sliding window.
// Unknown costs remain reserved. Never expire a reservation at the end of a run.
export const AGENT_RESERVE_SCRIPT = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end
local tm=redis.call('TIME')
local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local old=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',now-86400000)
for _,id in ipairs(old) do redis.call('HDEL',KEYS[3],id); redis.call('HDEL',KEYS[4],id) end
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now-86400000)
if redis.call('HEXISTS',KEYS[3],ARGV[2])==1 then return -3 end
local total=0
for _,value in ipairs(redis.call('HVALS',KEYS[3])) do total=total+tonumber(value) end
if total+tonumber(ARGV[3])>tonumber(ARGV[4]) then return -2 end
redis.call('ZADD',KEYS[2],now,ARGV[2])
redis.call('HSET',KEYS[3],ARGV[2],ARGV[3])
redis.call('HSET',KEYS[4],ARGV[2],ARGV[5])
return 1
`;

export class AgentRunState {
  private lost = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewal: Promise<void> | null = null;
  private recorded = false;
  constructor(
    readonly redis: AgentRedis,
    readonly runId: string,
    readonly prefix: string = AGENT_THESES_PREFIX,
  ) {}
  key(suffix: string) {
    return `${this.prefix}:${suffix}`;
  }
  async acquire(initial?: { key: string; value: string; ttlSeconds: number }) {
    if (
      initial
        ? Number(
            await this.redis.eval(
              `
          if redis.call('EXISTS',KEYS[2])==1 then return 0 end
          if not redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[2]) then return 0 end
          redis.call('SET',KEYS[2],ARGV[3],'EX',ARGV[4]); return 1`,
              {
                keys: [this.key("lock"), initial.key],
                arguments: [
                  this.runId,
                  String(TTL),
                  initial.value,
                  String(initial.ttlSeconds),
                ],
              },
            ),
          ) !== 1
        : (await this.redis.set(this.key("lock"), this.runId, {
            NX: true,
            PX: TTL,
          })) !== "OK"
    )
      return false;
    this.timer = setInterval(() => {
      if (this.renewal || this.lost) return;
      this.renewal = this.assertLease()
        .catch(() => {
          this.lost = true;
        })
        .finally(() => {
          this.renewal = null;
        });
    }, TTL / 3);
    this.timer.unref();
    return true;
  }
  async assertLease() {
    if (this.lost) throw new Error("agent_lease_lost");
    try {
      if (
        !(await renewHolderResearchRunLock({
          redis: this.redis,
          key: this.key("lock"),
          owner: this.runId,
          ttlMs: TTL,
        }))
      )
        throw new Error("agent_lease_lost");
    } catch {
      this.lost = true;
      throw new Error("agent_lease_lost");
    }
  }
  async reserve(
    callId: string,
    reserveUsd: number,
    budgetUsd: number,
    metadata: Record<string, unknown> = {},
  ) {
    await this.assertLease();
    const code = Number(
      await this.redis.eval(AGENT_RESERVE_SCRIPT, {
        keys: [
          this.key("lock"),
          this.key("calls"),
          this.key("costs"),
          this.key("call_details"),
        ],
        arguments: [
          this.runId,
          callId,
          String(Math.ceil(reserveUsd * 1e10)),
          String(Math.floor(budgetUsd * 1e10)),
          JSON.stringify({ ...metadata, reserveUsd }),
        ],
      }),
    );
    if (code !== 1)
      throw new Error(
        code === -2
          ? "agent_budget_exhausted"
          : code === -3
            ? "agent_call_already_reserved"
            : "agent_lease_lost",
      );
  }
  async settle(callId: string, actualUsd: number | null) {
    if (actualUsd === null) return;
    if (!Number.isFinite(actualUsd) || actualUsd < 0)
      throw new Error("invalid_provider_cost");
    // Accounting may complete after lease loss; the unique call reservation still owns this cost.
    await this.redis.eval(
      `
      if redis.call('HEXISTS',KEYS[1],ARGV[1])==0 then return 0 end
      redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])
      local raw=redis.call('HGET',KEYS[2],ARGV[1])
      if raw then local detail=cjson.decode(raw); detail.actualUsd=tonumber(ARGV[3]); redis.call('HSET',KEYS[2],ARGV[1],cjson.encode(detail)) end
      return 1`,
      {
        keys: [this.key("costs"), this.key("call_details")],
        arguments: [
          callId,
          String(Math.ceil(actualUsd * 1e10)),
          String(actualUsd),
        ],
      },
    );
  }
  async saveCursor(cursor: unknown, ownerUserId?: string) {
    await this.assertLease();
    const saved = await this.redis.eval(
      `
      if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      redis.call('SET',KEYS[2],ARGV[2])
      if #KEYS==4 then
        local turn=redis.call('INCR',KEYS[3])
        redis.call('HSET',KEYS[4],ARGV[3],turn)
      end
      return 1`,
      {
        keys: [
          this.key("lock"),
          `${this.prefix}:cursor${ownerUserId ? `:${ownerUserId}` : ""}`,
          ...(ownerUserId
            ? [`${this.prefix}:pool_turn`, `${this.prefix}:pool_owners`]
            : []),
        ],
        arguments: [this.runId, JSON.stringify(cursor), ownerUserId ?? ""],
      },
    );
    if (Number(saved) !== 1) throw new Error("agent_lease_lost");
  }
  async considered(userId: string, marketIds: string[]) {
    const result = await this.redis.eval(
      `
      if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      local tm=redis.call('TIME')
      for i=2,#ARGV do redis.call('ZADD',KEYS[2],tm[1],ARGV[i]) end
      redis.call('ZREMRANGEBYRANK',KEYS[2],0,-10001)
      return 1`,
      {
        keys: [this.key("lock"), `${this.prefix}:considered:${userId}`],
        arguments: [this.runId, ...marketIds],
      },
    );
    if (Number(result) !== 1) throw new Error("agent_lease_lost");
  }
  async record(report: unknown) {
    const value = JSON.stringify(report);
    const multi = this.redis
      .multi()
      .set(`${this.prefix}:run:${this.runId}`, value, {
        EX: 30 * 86400,
      });
    if (!this.recorded)
      multi
        .lPush(`${this.prefix}:runs`, this.runId)
        .lTrim(`${this.prefix}:runs`, 0, 1499);
    await multi.exec();
    this.recorded = true;
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.renewal) await this.renewal;
    await releaseHolderResearchRunLock({
      redis: this.redis,
      key: this.key("lock"),
      owner: this.runId,
    });
  }
}
