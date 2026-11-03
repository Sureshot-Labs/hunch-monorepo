import type { Pool } from "@hunch/infra";
import {
  buildPolymarketAssetBindings,
  type PolymarketAssetBinding,
  type PolymarketBindingMarketSource,
} from "@hunch/db";
import { normalizePolymarketAssetId } from "@hunch/shared";

type Db = Pick<Pool, "query">;
export const WALLET_INTEL_CATALOG_SQL_BATCH = 1000;
export type DiscoveryMarketHint = {
  tokenId: string;
  conditionIds?: readonly string[];
};

// Every branch starts with exact tokens/conditions and existing indexes. No
// history/catalog walk, upstream hydration, or arbitrary first-N market cutoff.
export const WALLET_INTEL_MARKET_SCOPE_SQL = `
 with wanted_tokens as materialized (select unnest($1::text[]) as token_id),
 wanted_hints as materialized (
   select * from unnest($2::text[],$3::text[]) as hint_row(token_id,condition_id)
 ), matches as (
   select wanted_row.token_id as requested_token_id,market_row.id
   from wanted_tokens wanted_row join unified_tokens token_row
     on token_row.token_id=wanted_row.token_id and token_row.venue='polymarket'
   join unified_markets market_row on market_row.id=token_row.market_id and market_row.venue='polymarket'
   union
   select wanted_row.token_id,market_row.id
   from wanted_tokens wanted_row join unified_market_tokens token_row
     on token_row.token_id=wanted_row.token_id and token_row.venue='polymarket'
   join unified_markets market_row on market_row.id=token_row.market_id and market_row.venue='polymarket'
   union
   select wanted_row.token_id,market_row.id
   from wanted_tokens wanted_row join polymarket_asset_bindings binding_row
     on binding_row.chain_id=137 and binding_row.asset_id=wanted_row.token_id
   join unified_markets market_row on market_row.id=binding_row.market_id and market_row.venue='polymarket'
   union
   select hint_row.token_id,market_row.id
   from wanted_hints hint_row join unified_markets market_row
     on market_row.condition_id=hint_row.condition_id and market_row.venue='polymarket'
 )
 select matched_row.requested_token_id,market_row.id,market_row.venue,
   market_row.condition_id,market_row.clob_token_ids,market_row.outcomes,
   jsonb_strip_nulls(jsonb_build_object('polymarketProtocol',market_row.metadata->'polymarketProtocol',
     'version',market_row.metadata->'version','positionIds',market_row.metadata->'positionIds',
     'negRisk',market_row.metadata->'negRisk')) as metadata
 from matches matched_row join unified_markets market_row on market_row.id=matched_row.id`;

export const WALLET_INTEL_SCOPE_BINDINGS_SQL = `
 select binding_row.* from polymarket_asset_bindings binding_row
 join unified_markets market_row on market_row.id=binding_row.market_id and market_row.venue='polymarket'
 where binding_row.chain_id=137 and binding_row.asset_id=any($1::text[])`;

export const WALLET_INTEL_SCOPE_REPAIR_SQL = `
 insert into polymarket_asset_bindings(chain_id,position_contract,asset_id,market_id,
   protocol_version,asset_kind,condition_id,outcome_index,neg_risk,exchange_address,
   order_domain_version,conditional_asset_type)
 select candidate_row.* from jsonb_to_recordset($1::jsonb) as candidate_row(
   chain_id integer,position_contract text,asset_id text,market_id text,
   protocol_version text,asset_kind text,condition_id text,outcome_index smallint,
   neg_risk boolean,exchange_address text,order_domain_version text,conditional_asset_type text
 ) join unified_markets market_row on market_row.id=candidate_row.market_id
   and market_row.venue='polymarket' and market_row.condition_id=candidate_row.condition_id
 order by candidate_row.position_contract,candidate_row.asset_id
 on conflict do nothing returning asset_id`;

function bindingKey(binding: PolymarketAssetBinding): string {
  return `${binding.position_contract}:${binding.asset_id}`;
}
function bindingIdentity(binding: PolymarketAssetBinding): string {
  return JSON.stringify([
    binding.market_id,
    binding.condition_id,
    binding.outcome_index,
    binding.protocol_version,
    binding.position_contract,
    binding.asset_kind,
    binding.exchange_address,
    binding.order_domain_version,
    binding.conditional_asset_type,
    binding.neg_risk,
  ]);
}

/** Complete means coverage of existing Hunch markets, not every external
 * market. Only a valid API condition hint plus zero local matches proves that
 * an unknown token is outside scope. Missing/conflicting local provenance must
 * remain pending, never become a zero or a fabricated full-wallet success.
 */
export async function scopeWalletIntelPolymarketTokens(
  db: Db,
  discovered: readonly DiscoveryMarketHint[],
  previousTokenIds: readonly string[],
) {
  const ids = [
    ...new Set([...discovered.map((row) => row.tokenId), ...previousTokenIds]),
  ];
  if (ids.some((id) => normalizePolymarketAssetId(id) !== id))
    throw new Error("Invalid wallet Intel token identity.");
  const hints = discovered.flatMap((row) =>
    [...new Set(row.conditionIds ?? [])].map((conditionId) => ({
      tokenId: row.tokenId,
      conditionId,
    })),
  );
  if (hints.some((row) => !/^0x[a-fA-F0-9]{64}$/.test(row.conditionId)))
    throw new Error("Invalid wallet Intel condition hint.");
  for (const hint of hints) hint.conditionId = hint.conditionId.toLowerCase();
  if (!ids.length)
    return {
      tokenIds: [],
      complete: true,
      summary: {
        scope: "hunch_catalog" as const,
        discoveredTokens: 0,
        inScopeTokens: 0,
        skippedOutsideCatalog: 0,
        pendingTokens: 0,
        repairedBindings: 0,
      },
    };
  const hintsByToken = new Map<string, typeof hints>();
  for (const hint of hints) {
    const entries = hintsByToken.get(hint.tokenId) ?? [];
    entries.push(hint);
    hintsByToken.set(hint.tokenId, entries);
  }
  const sources: Array<
    PolymarketBindingMarketSource & { requested_token_id: string }
  > = [];
  const readBindings = async () => {
    const rows: PolymarketAssetBinding[] = [];
    for (
      let start = 0;
      start < ids.length;
      start += WALLET_INTEL_CATALOG_SQL_BATCH
    )
      rows.push(
        ...(
          await db.query<PolymarketAssetBinding>(
            WALLET_INTEL_SCOPE_BINDINGS_SQL,
            [ids.slice(start, start + WALLET_INTEL_CATALOG_SQL_BATCH)],
          )
        ).rows,
      );
    return rows;
  };
  for (
    let start = 0;
    start < ids.length;
    start += WALLET_INTEL_CATALOG_SQL_BATCH
  ) {
    const chunk = ids.slice(start, start + WALLET_INTEL_CATALOG_SQL_BATCH);
    const chunkHints = chunk.flatMap((id) => hintsByToken.get(id) ?? []);
    sources.push(
      ...(
        await db.query<
          PolymarketBindingMarketSource & { requested_token_id: string }
        >(WALLET_INTEL_MARKET_SCOPE_SQL, [
          chunk,
          chunkHints.map((row) => row.tokenId),
          chunkHints.map((row) => row.conditionId),
        ])
      ).rows,
    );
  }
  const knownMarketTokens = new Set(
    sources.map((row) => row.requested_token_id),
  );
  const frozen = await readBindings();
  const byKey = new Map<string, PolymarketAssetBinding>();
  const ambiguous = new Set<string>();
  const unresolvedSourceTokens = new Set<string>();
  const frozenByKey = new Map(frozen.map((row) => [bindingKey(row), row]));
  const frozenMarketCoverage = new Set(
    frozen.map((row) =>
      JSON.stringify([row.market_id, row.asset_id, row.condition_id]),
    ),
  );
  for (const source of sources) {
    const bindings = buildPolymarketAssetBindings(source);
    if (
      !bindings.length ||
      (source.condition_id != null &&
        bindings.some(
          (row) => row.condition_id !== source.condition_id?.toLowerCase(),
        )) ||
      (!bindings.some((row) => row.asset_id === source.requested_token_id) &&
        !frozenMarketCoverage.has(
          JSON.stringify([
            source.id,
            source.requested_token_id,
            bindings[0]?.condition_id,
          ]),
        ))
    )
      unresolvedSourceTokens.add(source.requested_token_id);
    for (const binding of bindings) {
      if (binding.asset_id !== source.requested_token_id) continue;
      const key = bindingKey(binding),
        existing = byKey.get(key);
      if (existing && bindingIdentity(existing) !== bindingIdentity(binding))
        ambiguous.add(key);
      else byKey.set(key, binding);
    }
  }
  const candidates = [...byKey]
    .filter(([key]) => !ambiguous.has(key) && !frozenByKey.has(key))
    .map(([, row]) => row);
  let repairedBindings = 0;
  for (
    let start = 0;
    start < candidates.length;
    start += WALLET_INTEL_CATALOG_SQL_BATCH
  )
    repairedBindings += (
      await db.query<{ asset_id: string }>(WALLET_INTEL_SCOPE_REPAIR_SQL, [
        JSON.stringify(
          candidates.slice(start, start + WALLET_INTEL_CATALOG_SQL_BATCH),
        ),
      ])
    ).rows.length;
  const after = candidates.length ? await readBindings() : frozen;
  const afterByKey = new Map(after.map((row) => [bindingKey(row), row]));
  const available = new Set(after.map((row) => row.asset_id));
  const conflictingTokens = new Set(
    [...byKey]
      .filter(([key, row]) => {
        const existing = afterByKey.get(key);
        return (
          ambiguous.has(key) ||
          !existing ||
          bindingIdentity(existing) !== bindingIdentity(row)
        );
      })
      .map(([, row]) => row.asset_id),
  );
  const previous = new Set(previousTokenIds),
    hinted = new Set(hints.map((row) => row.tokenId));
  const pending: string[] = [],
    tokenIds: string[] = [],
    skipped: string[] = [];
  for (const id of ids) {
    if (
      available.has(id) &&
      !conflictingTokens.has(id) &&
      !unresolvedSourceTokens.has(id)
    )
      tokenIds.push(id);
    else if (!knownMarketTokens.has(id) && !previous.has(id) && hinted.has(id))
      skipped.push(id);
    else {
      tokenIds.push(id);
      pending.push(id);
    }
  }
  return {
    tokenIds,
    complete: pending.length === 0,
    summary: {
      scope: "hunch_catalog" as const,
      discoveredTokens: discovered.length,
      inScopeTokens: tokenIds.length,
      skippedOutsideCatalog: skipped.length,
      pendingTokens: pending.length,
      repairedBindings,
    },
  };
}
