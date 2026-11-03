import { createHash } from "node:crypto";
import {
  DATA_API_ADMISSION as limits,
  type DataApiAdmissionBackend,
  type DataApiAdmissionReply,
  type DataApiFeedback,
  type DataApiLane,
  type DataApiPermit,
} from "./polymarket-data-api-admission.js";

/** One atomic origin-wide state: no wallet/token/query/cursor data in Redis.
 * Redis TIME avoids skew between the API and cron containers. Stale completions
 * cannot close a newer circuit; only one half-open probe is admitted.
 */
export const DATA_API_ADMISSION_SCRIPT = `
local input = cjson.decode(ARGV[1])
local config = cjson.decode(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1])*1000 + math.floor(tonumber(clock[2])/1000)
if ARGV[3] ~= '' then now = tonumber(ARGV[3]) end
local raw = redis.call('GET',KEYS[1])
local host = raw and cjson.decode(raw) or {nextAt=0,families={}}
local state = host.families[input.family]
if not state then
 state={epoch=0,failures=0,blockedUntil=0,nextAt=0,probe='',leases={}}
 host.families[input.family]=state
end
local function save()
 redis.call('SET',KEYS[1],cjson.encode(host),'PX',math.max(config.stateTtlMs,state.blockedUntil-now+60000))
end
if input.op == 'acquire' then
 for id,lease in pairs(state.leases) do if lease.expiresAt <= now then state.leases[id]=nil end end
 if state.probe ~= '' and not state.leases[state.probe] then state.probe='' end
 if state.blockedUntil > now then save(); return {'cooldown',state.blockedUntil-now} end
 if state.probe ~= '' then save(); return {'probe',math.max(1,state.leases[state.probe].expiresAt-now)} end
 local wait=math.max(host.nextAt,state.nextAt)-now
 if wait > 0 then save(); return {'wait',wait} end
 local count=0;local background=0
 for _,lease in pairs(state.leases) do count=count+1;if lease.background then background=background+1 end end
 if count >= config.concurrency or (input.lane == 'background' and background >= config.backgroundConcurrency) then save();return {'wait',50} end
 state.leases[input.id]={expiresAt=now+input.leaseMs,background=input.lane=='background'}
 if state.failures > 0 then state.probe=input.id end
 host.nextAt=now+config.generalSpacingMs;state.nextAt=now+config.endpointSpacingMs
 save();return {'admitted',state.epoch}
end
if input.op == 'extend' then
 if now+input.retryAfterMs > state.blockedUntil then state.blockedUntil=now+input.retryAfterMs;state.failures=math.max(1,state.failures);state.epoch=state.epoch+1 end
 save();return {'finished',math.max(0,state.blockedUntil-now)}
end
if not state.leases[input.id] then return {'finished',math.max(0,state.blockedUntil-now)} end
state.leases[input.id]=nil
if input.kind == 'limited' then
 if input.epoch == state.epoch or state.failures == 0 then state.failures=math.min(16,state.failures+1) end
 state.epoch=state.epoch+1
 local backoff=math.min(config.maxBackoffMs,config.baseBackoffMs*2^(state.failures-1))
 state.blockedUntil=math.max(state.blockedUntil,now+math.max(input.retryAfterMs,math.ceil(backoff*(1+input.jitter/1000))))
elseif input.epoch == state.epoch and state.probe == input.id then
 if input.kind == 'success' then state.failures=0;state.blockedUntil=0;state.epoch=state.epoch+1
 else state.blockedUntil=now+config.baseBackoffMs end
end
if state.probe == input.id then state.probe='' end
save();return {'finished',math.max(0,state.blockedUntil-now)}
`;

export interface DataApiRedis {
  eval(
    script: string,
    input: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

export class RedisDataApiAdmissionBackend implements DataApiAdmissionBackend {
  constructor(
    private readonly redis: DataApiRedis,
    private readonly prefix = "poly-data-api:admission:v1:",
    private readonly testClock?: () => number,
  ) {}
  private async call(
    permit: DataApiPermit,
    input: object,
  ): Promise<[string, number]> {
    const key =
      this.prefix + createHash("sha256").update(permit.origin).digest("hex");
    const result = await this.redis.eval(DATA_API_ADMISSION_SCRIPT, {
      keys: [key],
      arguments: [
        JSON.stringify({ ...permit, ...input }),
        JSON.stringify(limits),
        this.testClock ? String(this.testClock()) : "",
      ],
    });
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      typeof result[0] !== "string" ||
      !Number.isSafeInteger(Number(result[1])) ||
      Number(result[1]) < 0
    )
      throw new Error("Invalid Polymarket admission coordinator response");
    return [result[0], Number(result[1])];
  }
  async acquire(
    input: DataApiPermit & { lane: DataApiLane; now: number },
  ): Promise<DataApiAdmissionReply> {
    const [kind, value] = await this.call(input, {
      op: "acquire",
      lane: input.lane,
      leaseMs: Math.max(1, input.expiresAt - input.now),
    });
    if (kind === "admitted") return { kind, epoch: value };
    if (kind === "wait") return { kind, retryAfterMs: value };
    if (kind === "cooldown" || kind === "probe")
      return {
        kind: "cooldown",
        retryAfterMs: value,
        basis: kind === "probe" ? "probe" : "upstream",
      };
    throw new Error("Invalid Polymarket admission decision");
  }
  async finish(
    permit: DataApiPermit,
    feedback: DataApiFeedback,
  ): Promise<number> {
    const [kind, wait] = await this.call(permit, { op: "finish", ...feedback });
    if (kind !== "finished")
      throw new Error("Invalid Polymarket admission completion");
    return wait;
  }
  async extendCooldown(
    permit: DataApiPermit,
    retryAfterMs: number,
  ): Promise<void> {
    await this.call(permit, { op: "extend", retryAfterMs });
  }
}
