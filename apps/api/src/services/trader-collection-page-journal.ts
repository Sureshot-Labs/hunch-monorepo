import { createHash } from "node:crypto";
import { deflateRaw, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import type { ReadPage } from "./trader-collection-source.js";
import { PolymarketDataApiV2Error } from "./polymarket-data-api-v2.js";
import { units } from "./trader-collection-ledger.js";

type Page = Awaited<ReturnType<ReadPage>>;
// Bound both Redis storage and replay CPU, independently of ranking thresholds.
const bytesPerWallet = 4 * 1024 * 1024,
  decodedBytesPerWallet = 24 * 1024 * 1024,
  pagesPerWallet = 384,
  bytesPerPage = 512 * 1024;
const pack = promisify(deflateRaw),
  unpack = promisify(inflateRaw);
const digest = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
// Private and generation-specific. Neither opaque cursors nor wallet addresses are keys.
export const journalKey = (
  prefix: string,
  venue: string,
  id: string,
  address: string,
  end: number,
) => prefix + "pages:v1:" + digest([venue, id, address.toLowerCase(), end]);

export const SAVE_PAGE = `if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end
if tonumber(redis.call('TIME')[1])>=tonumber(ARGV[2]) then return -1 end
if ARGV[3]=='seal' then
  redis.call('HSETNX',KEYS[2],'inventoryThrough',ARGV[5])
elseif ARGV[3]=='invalidate' then
  local stream=string.sub(ARGV[4],3)
  local prefix='p:'..stream..':'
  local bytes,pages=0,0
  -- This is one bounded wallet hash, never a keyspace scan. Retired cursor
  -- versions must not exhaust the quota of the replacement stream.
  for _,field in ipairs(redis.call('HKEYS',KEYS[2])) do
    if string.sub(field,1,string.len(prefix))==prefix then
      bytes=bytes+redis.call('HSTRLEN',KEYS[2],field)
      pages=pages+redis.call('HDEL',KEYS[2],field)
    end
  end
  redis.call('HINCRBY',KEYS[2],'bytes',-bytes)
  redis.call('HINCRBY',KEYS[2],'pages',-pages)
  redis.call('HINCRBY',KEYS[2],'decoded',-tonumber(redis.call('HGET',KEYS[2],'d:'..stream) or '0'))
  redis.call('HDEL',KEYS[2],'d:'..stream)
  redis.call('HINCRBY',KEYS[2],ARGV[4],1)
else
  if redis.call('HEXISTS',KEYS[2],ARGV[4])==1 then return 0 end
  local bytes=tonumber(redis.call('HGET',KEYS[2],'bytes') or '0')+string.len(ARGV[5])
  local decoded=tonumber(redis.call('HGET',KEYS[2],'decoded') or '0')+tonumber(ARGV[6])
  if bytes>${bytesPerWallet} or decoded>${decodedBytesPerWallet} or tonumber(redis.call('HGET',KEYS[2],'pages') or '0')>=${pagesPerWallet} then return -2 end
  redis.call('HSET',KEYS[2],ARGV[4],ARGV[5],'bytes',bytes,'decoded',decoded)
  redis.call('HINCRBY',KEYS[2],'d:'..string.sub(ARGV[4],3,66),ARGV[6])
  redis.call('HINCRBY',KEYS[2],'pages',1)
end
redis.call('EXPIREAT',KEYS[2],ARGV[2])
return 1`;

export type PageStore = {
  get(field: string): Promise<string | null | undefined>;
  write(
    mode: "invalidate" | "page" | "seal",
    field: string,
    value: string,
    decodedBytes: number,
  ): Promise<number>;
};
const columns = {
  positions: [
    "proxy_wallet",
    "condition_id",
    "token_id",
    "outcome_index",
    "outcome",
    "current_size",
    "total_size",
    "realized_pnl",
    "unrealized_pnl",
    "total_cost_usdc",
    "entry_cost_usdc",
    "entry_fees_usdc",
    "first_entry_at",
    "last_event_at",
    "redeemable",
    "status",
  ],
  activity: [
    "proxy_wallet",
    "type",
    "timestamp",
    "condition_id",
    "token_id",
    "outcome_index",
    "side",
    "size",
    "usdc_size",
    "outcome",
    "transaction_hash",
    "is_combo",
  ],
  resolutions: ["condition_id", "status", "resolved_at", "payouts"],
} as const;
export class PageContinuation extends Error {}
export class JournalUnavailable extends Error {}
export class WalletPageJournal {
  private versions = new Map<string, string>();
  private live = 0;
  saved = 0;
  replayed = 0;
  constructor(
    private store: PageStore,
    private address: string,
    private clock = () => Math.floor(Date.now() / 1000),
  ) {}
  private async write(
    mode: "invalidate" | "page" | "seal",
    key: string,
    value: string,
    decodedBytes = 0,
  ) {
    const result = await this.store
      .write(mode, key, value, decodedBytes)
      .catch(() => {
        throw new JournalUnavailable();
      });
    if (result === -2) throw Error("wallet_page_capacity");
    if (result !== 0 && result !== 1) throw new JournalUnavailable();
    return result;
  }
  // The provider has keyset cursors, not a cross-status MVCC snapshot. Freeze
  // an upper bound AFTER all position streams end, including on restart.
  async inventoryThrough(end: number) {
    const get = () =>
      this.store.get("inventoryThrough").catch(() => {
        throw new JournalUnavailable();
      });
    let raw = await get();
    if (raw == null) {
      await this.write(
        "seal",
        "inventoryThrough",
        String(Math.max(end, this.clock())),
      );
      raw = await get();
    }
    const through = Number(raw);
    if (!raw || !Number.isSafeInteger(through) || through < end)
      throw new JournalUnavailable();
    return through;
  }
  async page(
    read: ReadPage,
    ep: Parameters<ReadPage>[0],
    params: Record<string, string>,
    cursor: string | null,
    signal: AbortSignal,
    budget?: { fetched: number; limit: number },
  ): Promise<Page> {
    signal.throwIfAborted();
    const stream = digest([
      ep,
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    const get = (k: string) =>
      this.store.get(k).catch(() => {
        throw new JournalUnavailable();
      });
    const version =
      this.versions.get(stream) ?? (await get("v:" + stream)) ?? "0";
    this.versions.set(stream, version);
    const key = "p:" + stream + ":" + digest([version, cursor]);
    const cached = await get(key);
    signal.throwIfAborted();
    if (cached != null) {
      this.replayed++;
      return JSON.parse(
        (
          await unpack(Buffer.from(cached, "base64"), {
            maxOutputLength: bytesPerPage,
          })
        ).toString(),
      ) as Page;
    }
    if (this.live >= 90 || (budget && budget.fetched >= budget.limit))
      throw new PageContinuation();
    this.live++;
    if (budget) budget.fetched++;
    let p: Page;
    try {
      p = await read(ep, params, cursor, signal);
    } catch (err) {
      if (
        cursor &&
        err instanceof PolymarketDataApiV2Error &&
        err.reason === "invalid_cursor"
      ) {
        await this.write("invalidate", "v:" + stream, "");
        this.versions.delete(stream);
      }
      throw err;
    }
    const expected =
      ep === "resolutions" ? new Set(params.condition.split(",")) : null;
    if (
      !p.data.every((r) =>
        expected
          ? typeof r.condition_id === "string" &&
            expected.has(r.condition_id.toLowerCase())
          : typeof r.proxy_wallet === "string" &&
            r.proxy_wallet.toLowerCase() === this.address.toLowerCase(),
      )
    )
      throw Error(expected ? "resolution_mismatch" : "owner_mismatch");
    if (p.nextCursor && p.nextCursor === cursor) throw Error("repeated_cursor");
    if (ep === "resolutions" && p.nextCursor)
      throw Error("invalid_resolution_batch");
    for (const r of p.data) {
      if (
        ep === "activity" &&
        params.condition &&
        String(r.condition_id).toLowerCase() !== params.condition
      )
        throw Error("condition_mismatch");
      if (
        ep === "activity" &&
        params.limit !== "1" &&
        (typeof r.timestamp !== "number" ||
          !Number.isSafeInteger(r.timestamp) ||
          r.timestamp < Number(params.start) ||
          r.timestamp > Number(params.end))
      )
        throw Error("invalid_activity_timestamp");
      const validAsset =
        typeof r.condition_id === "string" &&
        /^0x[0-9a-f]{64}$/i.test(r.condition_id) &&
        typeof r.token_id === "string" &&
        /^\d{1,78}$/.test(r.token_id) &&
        (r.outcome_index === 0 || r.outcome_index === 1);
      if (!validAsset) continue; // Unknown identity is handled as a gap by the evaluator.
      if (ep === "positions") {
        const shares = units(r.current_size),
          pnl = units(r.realized_pnl);
        units(r.unrealized_pnl);
        if (
          r.total_cost_usdc != null &&
          r.entry_cost_usdc != null &&
          r.entry_fees_usdc != null
        ) {
          units(r.total_cost_usdc);
          units(r.entry_cost_usdc);
          units(r.entry_fees_usdc);
        }
        if (
          shares > 0n &&
          pnl === 0n &&
          r.total_size != null &&
          !r.redeemable &&
          r.status !== "REDEEMABLE" &&
          r.status !== "REDEEMABLE_LOST"
        )
          units(r.total_size);
      } else if (
        ep === "activity" &&
        params.limit !== "1" &&
        r.is_combo !== true &&
        (r.type === "REDEEM" ||
          (r.type === "TRADE" &&
            /^0x[0-9a-f]{64}$/i.test(String(r.transaction_hash))))
      ) {
        units(r.size);
        units(r.usdc_size);
      }
    }
    const page = {
      nextCursor: p.nextCursor,
      data: p.data.map((row) =>
        Object.fromEntries(
          columns[ep]
            .filter((k) => row[k] !== undefined)
            .map((k) => [k, row[k]]),
        ),
      ),
    };
    const body = JSON.stringify(page);
    const bytes = Buffer.byteLength(body);
    if (bytes > bytesPerPage) throw Error("wallet_page_capacity");
    const compressed = (await pack(body, { level: 1 })).toString("base64");
    this.saved += await this.write("page", key, compressed, bytes);
    return page;
  }
}
