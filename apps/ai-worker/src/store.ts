import { randomUUID } from "node:crypto";
import { EmbeddingCosts } from "./costs.js";
import { getEmbedStreamKey } from "@hunch/infra";
import {
  embeddingKey,
  embeddingIndex,
  embeddingVectorBuffer,
  type EmbeddingGeneration,
  type EmbeddingSource,
} from "@hunch/embeddings";

export type RedisCommands = {
  get(key: string): Promise<string | null>;
  sendCommand(args: (string | Buffer)[]): Promise<unknown>;
};
export const CONTROL = "ai:embed:control:";
export const STREAM = getEmbedStreamKey();
export const GROUP = process.env.AI_EMBED_GROUP || "ai-embedder";
export const DLQ = "ai:embed:dead";
const LEASE = `${CONTROL}lease`;
const TTL = 172800;
const CACHE_BATCH = 100;
type EmbeddingMetadata = [string | null, string | null, string | null, number];
export type CachedEmbeddingCommit = { source: EmbeddingSource; hash: string };
const COMMIT_LUA = `
local function cache_valid(key,hash,generation,legacy)
 local version=redis.call('HGET',key,'embedding_version')
 return redis.call('HSTRLEN',key,'embedding')==4096 and redis.call('HGET',key,'text_hash')==hash and (version==generation or (legacy=='1' and version and string.find(version,'^intfloat/e5%-large%-v2@')==1))
end
local function commit(key,eligible,status,venue,hash,generation,bytes,timestamp,legacy,market_type)
 if eligible=='1' then
  if string.len(bytes)>0 then
   redis.call('HSET',key,'embedding',bytes,'text_hash',hash,'embedding_version',generation)
  elseif not cache_valid(key,hash,generation,legacy) then
   return redis.error_reply('embedding_cache_changed')
  end
  redis.call('HSET',key,'status','ACTIVE','venue',venue,'updated_at',timestamp,'embedding_version',generation,'market_type',market_type)
  if redis.call('TTL',key)<86400 then redis.call('EXPIRE',key,172800) end
 elseif status=='CLOSED' and redis.call('EXISTS',key)==1 then
  if redis.call('HGET',key,'status')~='CLOSED' then redis.call('HSET',key,'status','CLOSED') end
  local ttl=redis.call('TTL',key)
  if ttl<0 or ttl>172800 then redis.call('EXPIRE',key,172800) end
 else redis.call('UNLINK',key) end
 return 1
end`;
export function record(value: unknown): Record<string, unknown> {
  const xs = value as unknown[];
  return Object.fromEntries(
    Array.from({ length: xs.length / 2 }, (_, i) => [
      String(xs[2 * i]),
      xs[2 * i + 1],
    ]),
  );
}
export function compareStreamId(a: string, b: string): number {
  const [at, as] = a.split("-").map(BigInt),
    [bt, bs] = b.split("-").map(BigInt);
  return at === bt ? (as === bs ? 0 : as < bs ? -1 : 1) : at < bt ? -1 : 1;
}

/** Every worker mutation is fenced by the current unique lease value. */
export class EmbeddingStore {
  readonly token = randomUUID();
  readonly costs = new EmbeddingCosts(this);
  constructor(readonly redis: RedisCommands) {}
  async acquire() {
    return (
      (await this.redis.sendCommand([
        "SET",
        LEASE,
        this.token,
        "NX",
        "PX",
        "60000",
      ])) === "OK"
    );
  }
  async fenced(
    script: string,
    keys: string[] = [],
    args: (string | Buffer)[] = [],
  ) {
    const result = await this.redis.sendCommand([
      "EVAL",
      `if redis.call('GET',KEYS[1]) ~= ARGV[1] then return redis.error_reply('embedding_lease_lost') end\n${script}`,
      String(keys.length + 1),
      LEASE,
      ...keys,
      this.token,
      ...args,
    ]);
    return result;
  }
  async renew() {
    await this.fenced("return redis.call('PEXPIRE',KEYS[1],60000)");
  }
  async release() {
    await this.fenced("return redis.call('DEL',KEYS[1])");
  }
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.sendCommand(["GET", key]);
    return raw ? (JSON.parse(String(raw)) as T) : null;
  }
  async put(key: string, value: unknown) {
    await this.fenced(
      "return redis.call('SET',KEYS[2],ARGV[2])",
      [key],
      [JSON.stringify(value)],
    );
  }
  async ack(ids: string[]) {
    if (ids.length)
      await this.fenced(
        "return redis.call('XACK',KEYS[2],ARGV[2],unpack(ARGV,3))",
        [STREAM],
        [GROUP, ...ids],
      );
  }
  async metadata(generation: EmbeddingGeneration, source: EmbeddingSource) {
    return (await this.metadataMany(generation, [source]))[0];
  }
  async metadataMany(
    generation: EmbeddingGeneration,
    sources: EmbeddingSource[],
  ): Promise<EmbeddingMetadata[]> {
    const result: EmbeddingMetadata[] = [];
    for (let offset = 0; offset < sources.length; offset += CACHE_BATCH) {
      const keys = sources
        .slice(offset, offset + CACHE_BATCH)
        .map((source) => embeddingKey(generation, source.kind, source.id));
      result.push(
        ...((await this.redis.sendCommand([
          "EVAL_RO",
          "local out={};for i,key in ipairs(KEYS) do local m=redis.call('HMGET',key,'text_hash','embedding_version','status');m[4]=redis.call('HSTRLEN',key,'embedding');out[i]=m end;return out",
          String(keys.length),
          ...keys,
        ])) as EmbeddingMetadata[]),
      );
    }
    return result;
  }
  async commitCachedMany(
    generation: EmbeddingGeneration,
    items: CachedEmbeddingCommit[],
  ) {
    for (let offset = 0; offset < items.length; offset += CACHE_BATCH) {
      const batch = items.slice(offset, offset + CACHE_BATCH);
      const keys = batch.flatMap(({ source }) => [
        embeddingKey(generation, source.kind, source.id),
        `${CONTROL}failure:${generation.id}:${source.kind}:${source.id}`,
      ]);
      await this.fenced(
        `${COMMIT_LUA}
local items=cjson.decode(ARGV[2])
-- Validate every cached vector before any writes. Never acknowledge an expired,
-- replaced or incompatible vector based on earlier batched metadata alone.
for i,item in ipairs(items) do
 if item.eligible=='1' and not cache_valid(KEYS[2+(i-1)*2],item.hash,ARGV[3],ARGV[5]) then return redis.error_reply('embedding_cache_changed') end
end
for i,item in ipairs(items) do
 commit(KEYS[2+(i-1)*2],item.eligible,item.status,item.venue,item.hash,ARGV[3],'',ARGV[4],ARGV[5],item.market_type)
 redis.call('UNLINK',KEYS[3+(i-1)*2])
 redis.call('ZREM',KEYS[#KEYS],item.retry_member)
end
return #items`,
        [...keys, `${CONTROL}retry-due`],
        [
          JSON.stringify(
            batch.map(({ source, hash }) => ({
              eligible: source.eligible ? "1" : "0",
              status: source.status,
              venue: source.venue,
              hash,
              market_type: source.marketType ?? "",
              retry_member: JSON.stringify([
                generation.id,
                source.kind,
                source.id,
              ]),
            })),
          ),
          generation.id,
          String(Date.now()),
          generation.legacy ? "1" : "0",
        ],
      );
    }
  }
  async commit(
    generation: EmbeddingGeneration,
    source: EmbeddingSource,
    hash: string,
    vector?: number[],
  ) {
    const bytes = vector
      ? embeddingVectorBuffer(vector, generation)
      : Buffer.alloc(0);
    await this.fenced(
      `${COMMIT_LUA}\nreturn commit(KEYS[2],unpack(ARGV,2))`,
      [embeddingKey(generation, source.kind, source.id)],
      [
        source.eligible ? "1" : "0",
        source.status,
        source.venue,
        hash,
        generation.id,
        bytes,
        String(Date.now()),
        generation.legacy ? "1" : "0",
        source.marketType ?? "",
      ],
    );
  }
  async reserve(
    generation: EmbeddingGeneration,
    amount: number,
    limit: number | null,
  ) {
    return this.costs.reserve(generation, amount, limit);
  }
  async spent(generation: EmbeddingGeneration) {
    const { build } = await this.costs.read(generation, false);
    return build.spentUsd + build.reservedUsd;
  }
  async dead(
    kind: string,
    id: string,
    generation: string,
    code: string,
    attempts: number,
  ) {
    await this.fenced(
      "return redis.call('XADD',KEYS[2],'MAXLEN','~','10000','LIMIT','1000','*','entity_type',ARGV[2],'entity_id',ARGV[3],'generation',ARGV[4],'error',ARGV[5],'attempts',ARGV[6])",
      [DLQ],
      [kind, id, generation, code.slice(0, 200), String(attempts)],
    );
  }
  async ensureIndex(generation: EmbeddingGeneration, kind: "event" | "market") {
    const index = embeddingIndex(generation, kind);
    try {
      const info = record(await this.redis.sendCommand(["FT.INFO", index]));
      const attrs = info.attributes as unknown[][];
      const vector = attrs.map(record).find((a) => a.attribute === "embedding");
      if (Number(vector?.dim) !== generation.dimensions)
        throw new Error("embedding_index_dimension_mismatch");
      return;
    } catch (error) {
      if (!/Unknown index|no such index/i.test(String(error))) throw error;
    }
    // Index creation is idempotent; no existing key/index is modified.
    await this.fenced(
      `return redis.call('FT.CREATE',KEYS[2],'ON','HASH','PREFIX','1',ARGV[2],
      'SCHEMA','venue','TAG','status','TAG','market_type','TAG','updated_at','NUMERIC','embedding','VECTOR','HNSW','6','TYPE','FLOAT32','DIM','1024','DISTANCE_METRIC','COSINE')`,
      [index],
      [embeddingKey(generation, kind, "")],
    );
  }
  async prune() {
    // Snapshot diagnostics before discarding old historical failures. Never replay old payloads.
    const len = Number(await this.redis.sendCommand(["XLEN", DLQ]));
    await this.fenced(
      "return redis.call('SET',KEYS[2],ARGV[2],'NX')",
      [`${CONTROL}dlq-before-retention`],
      [JSON.stringify({ at: new Date().toISOString(), length: len })],
    );
    if (len) {
      await this.fenced(
        "return redis.call('XTRIM',KEYS[2],'MINID','~',ARGV[2],'LIMIT','1000')",
        [DLQ],
        [`${Date.now() - 7 * 86400000}-0`],
      );
      await this.fenced(
        "return redis.call('XTRIM',KEYS[2],'MAXLEN','~','10000','LIMIT','1000')",
        [DLQ],
      );
    }
    // A group's oldest pending entry is the retention floor; never trim unread data.
    const groups = (await this.redis.sendCommand([
      "XINFO",
      "GROUPS",
      STREAM,
    ])) as unknown[][];
    let floor: string | null = null;
    for (const raw of groups) {
      const group = record(raw);
      const pending = (await this.redis.sendCommand([
        "XPENDING",
        STREAM,
        String(group.name),
      ])) as unknown[];
      const candidate =
        Number(pending[0]) > 0
          ? String(pending[1])
          : String(group["last-delivered-id"]);
      if (!floor || compareStreamId(candidate, floor) < 0) floor = candidate;
    }
    if (floor && floor !== "0-0")
      await this.fenced(
        "return redis.call('XTRIM',KEYS[2],'MINID','~',ARGV[2],'LIMIT','1000')",
        [STREAM],
        [floor],
      );
  }
  async activate(
    expectedActive: EmbeddingGeneration,
    desired: EmbeddingGeneration,
    expectedReconcile: string,
  ) {
    return (
      Number(
        await this.fenced(
          `local old=redis.call('GET',KEYS[2])
if old and cjson.decode(old).id~=ARGV[2] then return 0 end
if (redis.call('GET',KEYS[4]) or '0')~=ARGV[5] then return 0 end
redis.call('SET',KEYS[2],ARGV[3]); redis.call('SET',KEYS[3],ARGV[4]); return 1`,
          [
            `${CONTROL}active`,
            `${CONTROL}retired:${expectedActive.id}`,
            `${CONTROL}reconcile`,
          ],
          [
            expectedActive.id,
            JSON.stringify(desired),
            String(Date.now()),
            expectedReconcile,
          ],
        ),
      ) === 1
    );
  }
}

export const EMBEDDING_TTL_SEC = TTL;
