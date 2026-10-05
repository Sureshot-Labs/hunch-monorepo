/** Polygon proxy addresses, verified against the published protocol on 2026-10-05.
 * This registry describes asset identity, not permission to execute a trade.
 */
export const POLYMARKET_PROTOCOL_CONTRACTS = {
  chainId: 137,
  collateral: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  exchangeV2: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRiskExchangeV2: "0xe2222d279d744050d28e00520010520000310F59",
  positionManager: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
  exchangeV3: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
  router: "0x12121212006e4CD160D18e3f00711DA5c3372600",
  binaryModule: "0x1000008dD9001B968442c1000017eaE6E0dA00Ba",
  negRiskModule: "0x200000900045e3B6259600682756002200028933",
} as const;

export type PolymarketProtocolVersion = "v1" | "v2";
export type PolymarketOrderDomainVersion = "2" | "3";

function polymarketProtocolIdentity(
  version: PolymarketProtocolVersion,
  negRisk: boolean,
) {
  const contracts = POLYMARKET_PROTOCOL_CONTRACTS;
  const isV2 = version === "v2";
  return {
    assetKind: isV2 ? ("position_manager" as const) : ("ctf" as const),
    positionContract: isV2
      ? contracts.positionManager
      : contracts.conditionalTokens,
    exchangeAddress: isV2
      ? contracts.exchangeV3
      : negRisk
        ? contracts.negRiskExchangeV2
        : contracts.exchangeV2,
    orderDomainVersion: isV2 ? ("3" as const) : ("2" as const),
    conditionalAssetType: isV2
      ? ("CONDITIONAL-V2" as const)
      : ("CONDITIONAL" as const),
  };
}

export function normalizePolymarketAssetId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  // Bound work before BigInt, including malformed upstream strings.
  if (value.length > 78) return null;
  const assetId = BigInt(value);
  return assetId < 1n << 256n ? assetId.toString() : null;
}

export function polymarketV2ConditionIdToBytes31(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{62}00$/.test(value)) {
    throw new Error("Polymarket V2 condition ID must be right-padded bytes31.");
  }
  return value.slice(0, -2).toLowerCase() as `0x${string}`;
}

/** Ids.sol's Polygon enum is zero, not the EVM chain ID. This decoder binds
 * exact-amount Router calls to a supported binary/neg-risk position; it never
 * derives a generation from an arbitrary decimal token ID. */
export function polymarketV2PositionIdentity(context: PolymarketAssetContext): {
  conditionId: `0x${string}`;
  moduleId: 1 | 2;
  moduleAddress: string;
  positionId: bigint;
} {
  if (context.protocolVersion !== "v2")
    throw new Error("PositionManager identity requires a V2 asset context.");
  const conditionId = polymarketV2ConditionIdToBytes31(context.conditionId);
  const condition = BigInt(context.conditionId);
  const moduleId = context.negRisk ? 2 : 1;
  const arity = (condition >> 104n) & 0xffffn;
  const conditionIndex = (condition >> 8n) & 0xffffn;
  const reserved = (condition >> 40n) & ((1n << 64n) - 1n);
  if (
    condition >> 248n !== BigInt(moduleId) ||
    ((condition >> 24n) & 0xffffn) !== 0n ||
    reserved !== 0n ||
    (moduleId === 1 && (arity !== 0n || conditionIndex !== 0n)) ||
    (moduleId === 2 && (arity === 0n || conditionIndex > arity))
  )
    throw new Error("Unsupported or inconsistent V2 position module identity.");
  const positionId = condition | BigInt(context.outcomeIndex);
  if (normalizePolymarketAssetId(context.assetId) !== positionId.toString())
    throw new Error("V2 asset ID does not match its condition and outcome.");
  return {
    conditionId,
    moduleId,
    moduleAddress:
      moduleId === 1
        ? POLYMARKET_PROTOCOL_CONTRACTS.binaryModule
        : POLYMARKET_PROTOCOL_CONTRACTS.negRiskModule,
    positionId,
  };
}

function readArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type PolymarketMarketAssets = {
  protocolVersion: PolymarketProtocolVersion;
  assetKind: "ctf" | "position_manager";
  conditionId: string;
  assets: readonly [string, string];
  outcomes: readonly [string, string];
  positionContract: string;
  exchangeAddress: string;
  orderDomainVersion: PolymarketOrderDomainVersion;
  conditionalAssetType: "CONDITIONAL" | "CONDITIONAL-V2";
  negRisk: boolean;
};

/** This context travels intact from quote through signing and recovery. The
 * token number alone is not a ledger identity across protocol generations.
 */
export type PolymarketAssetContext = {
  contextVersion: 1;
  chainId: 137;
  marketId: string;
  assetId: string;
  protocolVersion: PolymarketProtocolVersion;
  assetKind: PolymarketMarketAssets["assetKind"];
  conditionId: string;
  outcomeIndex: 0 | 1;
  negRisk: boolean;
  positionContract: string;
  exchangeAddress: string;
  orderDomainVersion: PolymarketOrderDomainVersion;
  conditionalAssetType: PolymarketMarketAssets["conditionalAssetType"];
};

export function buildPolymarketAssetContext(
  marketId: string,
  protocol: PolymarketMarketAssets,
  assetId: string,
): PolymarketAssetContext {
  const outcomeIndex = protocol.assets.indexOf(assetId);
  if (outcomeIndex !== 0 && outcomeIndex !== 1) {
    throw new Error("Polymarket asset does not belong to this market binding.");
  }
  const context: PolymarketAssetContext = {
    contextVersion: 1,
    chainId: 137,
    marketId,
    assetId,
    protocolVersion: protocol.protocolVersion,
    assetKind: protocol.assetKind,
    conditionId: protocol.conditionId,
    outcomeIndex,
    negRisk: protocol.negRisk,
    positionContract: protocol.positionContract,
    exchangeAddress: protocol.exchangeAddress,
    orderDomainVersion: protocol.orderDomainVersion,
    conditionalAssetType: protocol.conditionalAssetType,
  };
  if (context.protocolVersion === "v2") polymarketV2PositionIdentity(context);
  return context;
}

export function parsePolymarketAssetContext(
  value: unknown,
): PolymarketAssetContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  const assetId = normalizePolymarketAssetId(context.assetId);
  if (
    context.contextVersion !== 1 ||
    context.chainId !== 137 ||
    !assetId ||
    typeof context.marketId !== "string" ||
    !context.marketId.startsWith("polymarket:") ||
    (context.outcomeIndex !== 0 && context.outcomeIndex !== 1) ||
    typeof context.negRisk !== "boolean" ||
    (context.protocolVersion !== "v1" && context.protocolVersion !== "v2") ||
    typeof context.conditionId !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(context.conditionId)
  )
    return null;
  try {
    if (context.protocolVersion === "v2")
      polymarketV2ConditionIdToBytes31(context.conditionId);
    const canonical: PolymarketAssetContext = {
      contextVersion: 1,
      chainId: 137,
      marketId: context.marketId,
      assetId,
      protocolVersion: context.protocolVersion,
      conditionId: context.conditionId.toLowerCase(),
      outcomeIndex: context.outcomeIndex,
      negRisk: context.negRisk,
      ...polymarketProtocolIdentity(context.protocolVersion, context.negRisk),
    };
    for (const key of ["positionContract", "exchangeAddress"] as const) {
      if (
        typeof context[key] !== "string" ||
        context[key].toLowerCase() !== canonical[key].toLowerCase()
      )
        return null;
    }
    for (const key of [
      "assetKind",
      "orderDomainVersion",
      "conditionalAssetType",
    ] as const) {
      if (context[key] !== canonical[key]) return null;
    }
    if (canonical.protocolVersion === "v2")
      polymarketV2PositionIdentity(canonical);
    return canonical;
  } catch {
    return null;
  }
}

/** Explicit Gamma version wins even when both ID fields are present.
 * Missing metadata requires refresh by the caller, never a guessed generation.
 * Native combo/non-binary execution is deliberately outside this resolver.
 */
export function resolvePolymarketMarketAssets(market: {
  version?: unknown;
  conditionId?: unknown;
  clobTokenIds?: unknown;
  positionIds?: unknown;
  outcomes?: unknown;
  negRisk?: unknown;
}): PolymarketMarketAssets {
  if (market.version !== "v1" && market.version !== "v2") {
    throw new Error(
      "Polymarket market protocol version is missing or unsupported.",
    );
  }
  if (
    typeof market.conditionId !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(market.conditionId)
  ) {
    throw new Error("Polymarket market condition ID is invalid.");
  }
  if (market.version === "v2") {
    polymarketV2ConditionIdToBytes31(market.conditionId);
  }
  const rawAssets =
    market.version === "v1"
      ? readArray(market.clobTokenIds)
      : Array.isArray(market.positionIds)
        ? market.positionIds
        : null;
  const rawOutcomes = readArray(market.outcomes);
  if (rawAssets?.length !== 2 || rawOutcomes?.length !== 2) {
    throw new Error(
      "Polymarket binary market requires two matched assets and outcomes.",
    );
  }
  const yesAsset = normalizePolymarketAssetId(rawAssets[0]);
  const noAsset = normalizePolymarketAssetId(rawAssets[1]);
  const [yesOutcome, noOutcome] = rawOutcomes;
  if (
    !yesAsset ||
    !noAsset ||
    yesAsset === noAsset ||
    typeof yesOutcome !== "string" ||
    !yesOutcome.trim() ||
    typeof noOutcome !== "string" ||
    !noOutcome.trim()
  ) {
    throw new Error("Polymarket market assets or outcome labels are invalid.");
  }
  if (market.negRisk != null && typeof market.negRisk !== "boolean") {
    throw new Error("Polymarket market negRisk flag is invalid.");
  }
  const protocol: PolymarketMarketAssets = {
    protocolVersion: market.version,
    ...polymarketProtocolIdentity(market.version, market.negRisk === true),
    conditionId: market.conditionId.toLowerCase(),
    assets: [yesAsset, noAsset],
    outcomes: [yesOutcome, noOutcome],
    negRisk: market.negRisk === true,
  };
  if (protocol.protocolVersion === "v2") {
    for (const assetId of protocol.assets) {
      buildPolymarketAssetContext(
        "polymarket:identity-validation",
        protocol,
        assetId,
      );
    }
  }
  return protocol;
}

/** Decode persisted metadata by rebuilding identity, not by trusting addresses
 * copied from JSON. Unknown fields are not permission to use another ledger.
 */
export function parsePolymarketMarketAssets(
  value: unknown,
): PolymarketMarketAssets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  try {
    const resolved = resolvePolymarketMarketAssets({
      version: stored.protocolVersion,
      conditionId: stored.conditionId,
      clobTokenIds: stored.assets,
      positionIds: stored.assets,
      outcomes: stored.outcomes,
      negRisk: stored.negRisk,
    });
    for (const key of [
      "assetKind",
      "positionContract",
      "exchangeAddress",
      "orderDomainVersion",
      "conditionalAssetType",
    ] as const) {
      if (stored[key] !== resolved[key]) return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/** Ingestion compatibility only. Existing Gamma CTF payloads predate version;
 * positionIds without an explicit generation must never be treated as CTF.
 * Invalid binary/condition metadata is retained for diagnostics, not trading.
 */
export function readPolymarketIndexedAssets(market: {
  version?: unknown;
  conditionId?: unknown;
  clobTokenIds?: unknown;
  positionIds?: unknown;
  outcomes?: unknown;
  negRisk?: unknown;
}): { assetIds: string[]; protocol: PolymarketMarketAssets | null } {
  const legacySchema =
    market.version == null &&
    (market.positionIds == null ||
      (Array.isArray(market.positionIds) && market.positionIds.length === 0));
  const version = legacySchema ? "v1" : market.version;
  try {
    const protocol = resolvePolymarketMarketAssets({ ...market, version });
    return { assetIds: [...protocol.assets], protocol };
  } catch {
    // Preserve legacy ingestion (including incomplete placeholder rows). A
    // malformed/unsupported V2 row cannot activate its old clobTokenIds.
    const legacyIds = version === "v1" ? readArray(market.clobTokenIds) : null;
    return {
      assetIds: (legacyIds ?? []).filter(
        (asset): asset is string => typeof asset === "string" && !!asset,
      ),
      protocol: null,
    };
  }
}

/** Payload CLOB-v2 and protocol V2 are different version axes. */
export function validatePolymarketOrderDomainVersion(
  exchangeAddress: string,
  domainVersion: PolymarketOrderDomainVersion,
): void {
  const isV3 =
    exchangeAddress.toLowerCase() ===
    POLYMARKET_PROTOCOL_CONTRACTS.exchangeV3.toLowerCase();
  if (
    (domainVersion !== "2" && domainVersion !== "3") ||
    (domainVersion === "3") !== isV3
  ) {
    throw new Error(
      "Polymarket order domain version does not match the exchange.",
    );
  }
}
