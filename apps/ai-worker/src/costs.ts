import { randomUUID } from "node:crypto";
import type { EmbeddingGeneration } from "@hunch/embeddings";
import type { EmbeddingStore } from "./store.js";

const PREFIX = "ai:embed:control:";
type Scope = "build" | "live";
export type CostReservation = { id: string; scope: Scope; amount: number };
const nano = (usd: number) => {
  if (!Number.isFinite(usd) || usd < 0)
    throw new Error("embedding_invalid_cost");
  const value = Math.ceil(usd * 1e9);
  if (!Number.isSafeInteger(value)) throw new Error("embedding_invalid_cost");
  return value;
};

/** One aggregate ledger and only in-flight reservations per generation. Old
 * mixed build/live estimates remain immutable diagnostic history, not actuals. */
export class EmbeddingCosts {
  constructor(private readonly store: EmbeddingStore) {}
  private keys(g: EmbeddingGeneration) {
    return [`${PREFIX}cost-v2:${g.id}`, `${PREFIX}cost-v2-pending:${g.id}`];
  }
  async initialize(g: EmbeddingGeneration, serving: boolean) {
    await this.store.fenced(
      `if redis.call('HEXISTS',KEYS[2],'version')==0 then
 local old=redis.call('GET',KEYS[4]) or '0'
 redis.call('HSET',KEYS[2],'version','2','legacyEstimate',old,
  'legacyActual',redis.call('GET',KEYS[5]) or '0',
  'legacyUnknown',redis.call('GET',KEYS[6]) or 'false',
  'buildLegacy',ARGV[2]=='1' and '0' or old)
end
-- After lease handoff, a request may have been charged. Move its reservation
-- to unknown exactly once; never refund an interrupted HTTP call.
local pending=redis.call('HGETALL',KEYS[3])
for i=1,#pending,2 do
 local item=cjson.decode(pending[i+1])
 if item.owner~=ARGV[1] then
  redis.call('HINCRBY',KEYS[2],item.scope..'Reserved',-item.nano)
  redis.call('HINCRBY',KEYS[2],item.scope..'Unknown',item.nano)
  redis.call('HDEL',KEYS[3],pending[i])
 end
end
return 1`,
      [
        ...this.keys(g),
        `${PREFIX}budget:${g.id}`,
        `${PREFIX}actual-cost:${g.id}`,
        `${PREFIX}unknown-cost:${g.id}`,
      ],
      [serving ? "1" : "0"],
    );
  }
  async reserve(
    g: EmbeddingGeneration,
    amount: number,
    limit: number | null,
  ): Promise<CostReservation> {
    await this.initialize(g, limit === null);
    const reservation = {
      id: randomUUID(),
      scope: limit === null ? ("live" as const) : ("build" as const),
      amount,
    };
    const result = await this.store.fenced(
      `local used=0
for _,suffix in ipairs({'Actual','Unknown','Reserved','Legacy'}) do
 used=used+tonumber(redis.call('HGET',KEYS[2],ARGV[3]..suffix) or '0')
end
if tonumber(ARGV[5])>=0 and used+tonumber(ARGV[4])>tonumber(ARGV[5]) then return 0 end
redis.call('HINCRBY',KEYS[2],ARGV[3]..'Reserved',ARGV[4])
redis.call('HSET',KEYS[3],ARGV[2],cjson.encode({scope=ARGV[3],nano=tonumber(ARGV[4]),owner=ARGV[1]}))
return 1`,
      this.keys(g),
      [
        reservation.id,
        reservation.scope,
        String(nano(amount)),
        String(limit === null ? -1 : nano(limit)),
      ],
    );
    if (Number(result) !== 1) throw new Error("generation_budget_exhausted");
    return reservation;
  }
  async settle(
    g: EmbeddingGeneration,
    reservation: CostReservation,
    actual: number | null,
  ) {
    await this.store.fenced(
      `local raw=redis.call('HGET',KEYS[3],ARGV[2])
if not raw then return 0 end
local item=cjson.decode(raw)
if item.owner~=ARGV[1] then return redis.error_reply('embedding_lease_lost') end
redis.call('HINCRBY',KEYS[2],item.scope..'Reserved',-item.nano)
if ARGV[3]=='unknown' then
 redis.call('HINCRBY',KEYS[2],item.scope..'Unknown',item.nano)
else
 redis.call('HINCRBY',KEYS[2],item.scope..'Actual',ARGV[3])
end
redis.call('HDEL',KEYS[3],ARGV[2]); return 1`,
      this.keys(g),
      [reservation.id, actual === null ? "unknown" : String(nano(actual))],
    );
  }
  async read(g: EmbeddingGeneration, serving: boolean) {
    await this.initialize(g, serving);
    const raw = (await this.store.redis.sendCommand([
      "HGETALL",
      this.keys(g)[0],
    ])) as string[];
    const fields = Object.fromEntries(
      Array.from({ length: raw.length / 2 }, (_, i) => [
        raw[i * 2],
        raw[i * 2 + 1],
      ]),
    );
    const usd = (field: string) => Number(fields[field] ?? 0) / 1e9;
    const scope = (name: Scope) => {
      const knownActualUsd = usd(`${name}Actual`);
      const unknownUsd = usd(`${name}Unknown`) + usd(`${name}Legacy`);
      const reservedUsd = usd(`${name}Reserved`);
      return {
        knownActualUsd,
        unknownUsd,
        reservedUsd,
        spentUsd: knownActualUsd + unknownUsd,
        actualUsd: unknownUsd || reservedUsd ? null : knownActualUsd,
      };
    };
    return {
      accountingVersion: 2 as const,
      build: scope("build"),
      maintenance: scope("live"),
      legacy: {
        estimatedUsd: usd("legacyEstimate"),
        knownActualUsd: Number(fields.legacyActual ?? 0),
        hasUnknown: fields.legacyUnknown === "true",
        attributedToBuildUsd: usd("buildLegacy"),
      },
    };
  }
}
