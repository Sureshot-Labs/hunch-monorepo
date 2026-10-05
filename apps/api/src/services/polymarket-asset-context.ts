import {
  fetchPolymarketAssetBindings,
  buildPolymarketAssetBindings,
  type PolymarketBindingMarketSource,
  type PolymarketAssetBinding,
} from "@hunch/db";
import {
  buildPolymarketAssetContext,
  parsePolymarketAssetContext,
  parsePolymarketMarketAssets,
  readPolymarketIndexedAssets,
  normalizePolymarketAssetId,
  POLYMARKET_PROTOCOL_CONTRACTS,
  type PolymarketAssetContext,
} from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import type { PolymarketMarketInfoRow } from "../repos/polymarket-markets.js";

export class PolymarketAssetContextError extends Error {
  readonly code = "polymarket_asset_context_unavailable";
}

function contextsEqual(left: unknown, right: unknown): boolean {
  const parsedLeft = parsePolymarketAssetContext(left);
  const parsedRight = parsePolymarketAssetContext(right);
  return (
    parsedLeft != null &&
    parsedRight != null &&
    JSON.stringify(parsedLeft) === JSON.stringify(parsedRight)
  );
}

export function polymarketContextFromBinding(
  binding: PolymarketAssetBinding,
): PolymarketAssetContext | null {
  return parsePolymarketAssetContext({
    contextVersion: 1,
    chainId: binding.chain_id,
    marketId: binding.market_id,
    assetId: binding.asset_id,
    protocolVersion: binding.protocol_version,
    assetKind: binding.asset_kind,
    conditionId: binding.condition_id,
    outcomeIndex: binding.outcome_index,
    negRisk: binding.neg_risk,
    positionContract: binding.position_contract,
    exchangeAddress: binding.exchange_address,
    orderDomainVersion: binding.order_domain_version,
    conditionalAssetType: binding.conditional_asset_type,
  });
}

/** A persisted order's identity must outlive the current Gamma projection. */
export function readPolymarketStoredOrderContext(
  payload: unknown,
): PolymarketAssetContext | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const record = payload as Record<string, unknown>;
  if (record.assetContext == null) return null;
  const context = parsePolymarketAssetContext(record.assetContext);
  const tokenId =
    record.tokenId == null ? null : normalizePolymarketAssetId(record.tokenId);
  if (!context || (record.tokenId != null && tokenId !== context.assetId)) {
    throw new PolymarketAssetContextError(
      "Stored Polymarket order context is inconsistent; its ledger cannot be guessed.",
    );
  }
  return context;
}

export function polymarketContextFromMarketInfo(
  market: PolymarketMarketInfoRow | null,
  tokenId: string,
): PolymarketAssetContext | null {
  if (!market) return null;
  const metadata = market.protocol_metadata as Record<string, unknown> | null;
  let protocol = parsePolymarketMarketAssets(metadata?.polymarketProtocol);
  if (!protocol && metadata?.polymarketProtocol == null) {
    // Source refresh can lag the unified projection. Explicit unified version
    // takes precedence; never reuse stale raw v1 IDs after a v2 transition.
    protocol = readPolymarketIndexedAssets({
      version: metadata?.version ?? market.protocol_version,
      positionIds: metadata?.positionIds ?? market.position_ids,
      conditionId: market.condition_id,
      clobTokenIds: market.clob_token_ids,
      outcomes: market.outcomes,
      negRisk: market.neg_risk,
    }).protocol;
  }
  if (!protocol || !protocol.assets.includes(tokenId)) return null;
  return buildPolymarketAssetContext(
    market.unified_market_id ?? `polymarket:${market.polymarket_id}`,
    protocol,
    tokenId,
  );
}

/** Bindings are durable; current market metadata only bootstraps old rows.
 * A token-only collision is a recoverable context-selection error, not license
 * to guess CTF versus PositionManager before funding/signing.
 */
export async function resolvePolymarketAssetContext(
  db: Pool,
  tokenId: string,
  market: PolymarketMarketInfoRow | null,
  requested?: PolymarketAssetContext | null,
  positionContract?: string,
): Promise<PolymarketAssetContext | null> {
  const canonicalTokenId = normalizePolymarketAssetId(tokenId);
  if (!canonicalTokenId)
    throw new PolymarketAssetContextError("Invalid Polymarket asset ID.");
  const selectedLedger = requested?.positionContract ?? positionContract;
  if (
    selectedLedger &&
    ![
      POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens,
      POLYMARKET_PROTOCOL_CONTRACTS.positionManager,
    ].some((ledger) => ledger.toLowerCase() === selectedLedger.toLowerCase())
  )
    throw new PolymarketAssetContextError(
      "Unsupported Polymarket position ledger.",
    );
  if (
    requested &&
    positionContract &&
    requested.positionContract.toLowerCase() !== positionContract.toLowerCase()
  )
    throw new PolymarketAssetContextError(
      "Polymarket position ledger conflicts with its context.",
    );
  const bindings = await fetchPolymarketAssetBindings(
    db,
    canonicalTokenId,
    selectedLedger,
  );
  if (bindings.length > 1)
    throw new PolymarketAssetContextError(
      "Polymarket asset requires its ledger context. Refresh the market before signing.",
    );
  const bound = bindings[0] ? polymarketContextFromBinding(bindings[0]) : null;
  if (bindings.length && !bound)
    throw new PolymarketAssetContextError(
      "Polymarket asset binding is invalid. Refresh before signing.",
    );
  const current = polymarketContextFromMarketInfo(market, canonicalTokenId);
  const resolved =
    bound ??
    (current &&
    (!selectedLedger ||
      current.positionContract.toLowerCase() === selectedLedger.toLowerCase())
      ? current
      : null);
  if (selectedLedger && !resolved)
    throw new PolymarketAssetContextError(
      "Polymarket position ledger is unavailable. Refresh the position before signing.",
    );
  if (requested && (!resolved || !contextsEqual(resolved, requested))) {
    throw new PolymarketAssetContextError(
      "Polymarket asset context changed; refresh before signing.",
    );
  }
  if (
    bound &&
    current &&
    bound.positionContract.toLowerCase() ===
      current.positionContract.toLowerCase() &&
    !contextsEqual(bound, current)
  ) {
    // Immutable identity conflict cannot be repaired by overwriting the binding.
    throw new PolymarketAssetContextError(
      "Polymarket market metadata conflicts with its asset binding.",
    );
  }
  const metadata = market?.protocol_metadata as Record<string, unknown> | null;
  const explicitVersion = metadata?.version ?? market?.protocol_version;
  const positionIds = metadata?.positionIds ?? market?.position_ids;
  if (
    !resolved &&
    ((explicitVersion != null && explicitVersion !== "v1") ||
      (Array.isArray(positionIds) && positionIds.length > 0))
  ) {
    throw new PolymarketAssetContextError(
      "Polymarket protocol metadata is incomplete. Refresh the market before signing.",
    );
  }
  return resolved;
}

export async function resolvePolymarketOrderAssetContext(
  db: Pool,
  tokenId: string,
  market: PolymarketMarketInfoRow | null,
  request: {
    assetContext?: PolymarketAssetContext;
    exchangeAddress?: string | null;
    negRisk?: boolean | null;
  },
): Promise<PolymarketAssetContext | null> {
  const context = await resolvePolymarketAssetContext(
    db,
    tokenId,
    market,
    request.assetContext,
  );
  if (context?.protocolVersion === "v2" && !request.assetContext) {
    throw new PolymarketAssetContextError(
      "This market requires a protocol-aware client. Refresh the app before signing.",
    );
  }
  if (
    context &&
    ((request.exchangeAddress &&
      request.exchangeAddress.toLowerCase() !==
        context.exchangeAddress.toLowerCase()) ||
      (request.negRisk != null && request.negRisk !== context.negRisk))
  ) {
    throw new PolymarketAssetContextError(
      "Polymarket exchange does not match the asset binding. Refresh before signing.",
    );
  }
  return context;
}

export type PolymarketHoldingLedger = {
  contractAddress: string;
  storageContract: string;
  tokenContexts: Map<string, PolymarketAssetContext | null>;
};

/** One bounded batch lookup. Current maps bootstrap pre-migration identities;
 * frozen bindings and stored holding contexts survive generation replacement.
 * Missing legacy provenance stays on its original CTF read path, never PM by
 * uint256 layout heuristics. A positive PM balance requires a real binding.
 */
export async function loadPolymarketHoldingLedgers(
  db: Pick<Pool, "query">,
  assetIds: readonly string[],
): Promise<PolymarketHoldingLedger[]> {
  const tokens = [
    ...new Set(
      assetIds
        .map(normalizePolymarketAssetId)
        .filter((id): id is string => id != null),
    ),
  ];
  if (!tokens.length) return [];
  const { rows: bindings } = await db.query<PolymarketAssetBinding>(
    `select chain_id, position_contract, asset_id, market_id, protocol_version,
      asset_kind, condition_id, outcome_index, neg_risk, exchange_address,
      order_domain_version, conditional_asset_type
     from polymarket_asset_bindings where chain_id = 137 and asset_id = any($1::text[])`,
    [tokens],
  );
  const { rows: currentMarkets } =
    await db.query<PolymarketBindingMarketSource>(
      `select distinct market_row.id, market_row.venue, market_row.condition_id,
      market_row.clob_token_ids, market_row.outcomes, market_row.metadata
     from unified_markets market_row
     join unified_tokens token_row on token_row.market_id = market_row.id
     where market_row.venue = 'polymarket' and token_row.token_id = any($1::text[])`,
      [tokens],
    );
  const { rows: stored } = await db.query<{
    token_id: string;
    position_contract: string;
    asset_context: unknown;
  }>(
    `select distinct token_id, position_contract, asset_context from positions
     where venue = 'polymarket' and token_id = any($1::text[])`,
    [tokens],
  );
  const ledgers = new Map<string, PolymarketHoldingLedger>();
  const add = (
    tokenId: string,
    contractAddress: string,
    context: PolymarketAssetContext | null,
  ) => {
    if (!tokens.includes(tokenId)) return;
    const contract = contractAddress.toLowerCase();
    const storageContract =
      contract === POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase()
        ? ""
        : contract;
    const ledger = ledgers.get(contract) ?? {
      contractAddress: contract,
      storageContract,
      tokenContexts: new Map<string, PolymarketAssetContext | null>(),
    };
    const existing = ledger.tokenContexts.get(tokenId);
    if (existing && context && !contextsEqual(existing, context))
      throw new PolymarketAssetContextError(
        "Holding provenance conflicts with its frozen asset binding.",
      );
    ledger.tokenContexts.set(tokenId, existing ?? context);
    ledgers.set(contract, ledger);
  };
  for (const binding of bindings) {
    const context = polymarketContextFromBinding(binding);
    if (!context)
      throw new PolymarketAssetContextError("Holding binding is invalid.");
    add(binding.asset_id, binding.position_contract, context);
  }
  for (const market of currentMarkets)
    for (const binding of buildPolymarketAssetBindings(market)) {
      // Never let a newer projection replace a durable identity.
      if (
        bindings.some(
          (old) =>
            old.asset_id === binding.asset_id &&
            old.position_contract === binding.position_contract,
        )
      )
        continue;
      add(
        binding.asset_id,
        binding.position_contract,
        polymarketContextFromBinding(binding),
      );
    }
  for (const holding of stored) {
    const contract =
      holding.position_contract ||
      POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens;
    const parsedContext = parsePolymarketAssetContext(holding.asset_context);
    if (holding.asset_context != null && !parsedContext)
      throw new PolymarketAssetContextError(
        "Stored holding context is malformed.",
      );
    const context =
      parsedContext ??
      ledgers
        .get(contract.toLowerCase())
        ?.tokenContexts.get(holding.token_id) ??
      null;
    if (
      context &&
      (context.assetId !== holding.token_id ||
        context.positionContract.toLowerCase() !== contract.toLowerCase())
    )
      throw new PolymarketAssetContextError(
        "Stored holding ledger is inconsistent.",
      );
    if (holding.position_contract && !context)
      throw new PolymarketAssetContextError(
        "Stored V2 holding is missing its frozen context.",
      );
    add(holding.token_id, contract, context);
  }
  for (const token of tokens)
    if (
      ![...ledgers.values()].some((ledger) => ledger.tokenContexts.has(token))
    )
      add(token, POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens, null);
  return [...ledgers.values()].sort((a, b) =>
    a.contractAddress.localeCompare(b.contractAddress),
  );
}
