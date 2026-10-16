// Pure public known-wallet projections. No provider, DB, API env, owned-account
// service or financial executor. Collection belongs to wallet-intel-refresh.
import { createHash } from "node:crypto";
import {
  hip4EnvironmentSchema,
  hip4Identity,
  parseHip4Coin,
  type Hip4Environment,
} from "@hunch/shared";
import {
  hip4AccountAbstractionSchema,
  hip4AccountFillSchema,
  hip4AccountRoleSchema,
} from "./hip4-account-contract.js";
import {
  projectHip4Account,
  projectHip4Execution,
} from "./hip4-account-projection.js";
import { projectHip4OpenOrders } from "./hip4-open-orders.js";
import { normalizeUnsignedDecimal } from "../account-value/decimal.js";

export const HIP4_WALLET_INTEL_CHAINS = [
  "hypercore:mainnet",
  "hypercore:testnet",
] as const;
export type Hip4WalletIntelChain = (typeof HIP4_WALLET_INTEL_CHAINS)[number];
export type Hip4WalletIntelIdentity = {
  environment: Hip4Environment;
  chain: Hip4WalletIntelChain;
  address: string;
};

/** These wallet keys match hip4Identity.network. Funding assets deliberately use
 * hyperliquid:mainnet/testnet instead: never substitute one namespace for another.
 */
export function hip4WalletIntelIdentity(
  environment: Hip4Environment,
  address: string,
): Hip4WalletIntelIdentity {
  hip4EnvironmentSchema.parse(environment);
  const normalized = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized) || /^0x0{40}$/.test(normalized))
    throw new Error("invalid_tracked_account");
  return {
    environment,
    chain: hip4Identity(environment, 0).network as Hip4WalletIntelChain,
    address: normalized,
  };
}

export type Hip4TrackedEndpointFailure =
  | "budget_exhausted"
  | "timeout"
  | "http_error"
  | "transport_error"
  | "invalid_response"
  | "response_too_large"
  | "unsupported_account_role"
  | "activity_schema_pending_index_repair"
  | "not_requested";
export type Hip4TrackedEndpointObservation =
  | { available: true; observedAt: string; value: unknown }
  | {
      available: false;
      attemptedAt: string;
      reason: Hip4TrackedEndpointFailure;
    };
export type Hip4TrackedEndpointCoverage = {
  source: string;
  status: "available" | "partial" | "unavailable";
  observedAt: string | null;
  reason: string | null;
};

export type Hip4KnownWalletCoverage = {
  version: 1;
  scope: "known_wallet_only";
  environment: Hip4Environment;
  chain: Hip4WalletIntelChain;
  accountAddress: string;
  accountRole: string;
  positions: Hip4TrackedEndpointCoverage;
  openOrders: Hip4TrackedEndpointCoverage;
  fills: Hip4TrackedEndpointCoverage & {
    completeHistory: false;
    providerCapped: boolean;
    returnedStart: string | null;
    returnedEnd: string | null;
    invalidRows: number;
    conflictingIdentities: number;
    excludedRows: Record<
      "non_outcome" | "settlement" | "merge_outcome" | "unknown_native_kind",
      number
    >;
  };
  globalHolders: {
    status: "unavailable";
    reason: "no_verified_global_holder_source";
  };
  historicalPerformance: {
    status: "unavailable";
    reason: "unproven_history_and_cost_basis";
  };
};

export type Hip4TrackedFillActivity = {
  sourceEventKey: string;
  venue: "hyperliquid";
  identity: Hip4WalletIntelIdentity;
  marketId: string;
  tokenId: string;
  outcomeSide: "YES" | "NO";
  action: "BUY" | "SELL";
  occurredAt: string;
  deltaShares: string;
  price: string;
  sizeUsd: string | null;
  quoteNotional: string;
  quoteToken: string | null;
  fee: string;
  feeToken: string;
  builderFee: string | null;
  /** A provider-reported field, not reconstructed or all-time realized PnL. */
  reportedClosedPnl: string;
  orderId: string;
  tradeId: string;
  transactionHash: string;
  startPosition: string;
  isTaker: boolean;
  clientOrderId: string | null;
  twapId: string | null;
};

export type Hip4TrackedFillResult =
  | { kind: "trade"; activity: Hip4TrackedFillActivity }
  | {
      kind: "non_trade";
      reason:
        | "non_outcome"
        | "settlement"
        | "merge_outcome"
        | "unknown_native_kind";
    };

export function normalizeHip4KnownWalletFill(input: {
  identity: Hip4WalletIntelIdentity;
  value: unknown;
  observedAt: string;
  quoteTokensByMarket?: ReadonlyMap<string, string>;
}): Hip4TrackedFillResult {
  const identity = hip4WalletIntelIdentity(
    input.identity.environment,
    input.identity.address,
  );
  if (identity.chain !== input.identity.chain)
    throw new Error("tracked_account_environment_mismatch");
  const row = input.value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || typeof row.coin !== "string")
    throw new Error("invalid_tracked_fill");
  if (!row.coin.startsWith("#"))
    return { kind: "non_trade", reason: "non_outcome" };
  const fill = hip4AccountFillSchema.parse(row);
  const now = Date.parse(input.observedAt);
  if (!Number.isFinite(now) || fill.time > now || /^0(?:\.0+)?$/.test(fill.sz))
    throw new Error("invalid_tracked_fill_time_or_size");
  if (fill.dir !== "Buy" && fill.dir !== "Sell")
    return {
      kind: "non_trade",
      reason:
        fill.dir === "Settlement"
          ? "settlement"
          : fill.dir === "Merge Outcome"
            ? "merge_outcome"
            : "unknown_native_kind",
    };
  if ((fill.dir === "Buy") !== (fill.side === "B"))
    throw new Error("tracked_fill_action_mismatch");
  const execution = projectHip4Execution(
    identity.environment,
    identity.address,
    fill,
  );
  const parsed = parseHip4Coin(fill.coin);
  const native = hip4Identity(identity.environment, parsed.outcome);
  return {
    kind: "trade",
    activity: {
      sourceEventKey: execution.id,
      venue: "hyperliquid",
      identity,
      marketId: native.marketId,
      tokenId: native.sides[parsed.sideIndex].tokenId,
      outcomeSide: parsed.sideIndex === 0 ? "YES" : "NO",
      action: fill.dir === "Buy" ? "BUY" : "SELL",
      occurredAt: new Date(fill.time).toISOString(),
      deltaShares:
        fill.dir === "Buy" ? execution.quantity : `-${execution.quantity}`,
      price: execution.price,
      sizeUsd:
        input.quoteTokensByMarket?.get(native.marketId) === "USDC"
          ? execution.grossNotional
          : null,
      quoteNotional: execution.grossNotional,
      quoteToken: input.quoteTokensByMarket?.get(native.marketId) ?? null,
      fee: execution.fee,
      feeToken: execution.feeToken,
      builderFee: execution.builderFee,
      reportedClosedPnl: execution.reportedClosedPnl,
      orderId: execution.orderId,
      tradeId: execution.tradeId,
      transactionHash: execution.transactionHash,
      startPosition: `${fill.startPosition.startsWith("-") && !/^0(?:\.0+)?$/.test(fill.startPosition.slice(1)) ? "-" : ""}${normalizeUnsignedDecimal(fill.startPosition.replace(/^-/, ""))}`,
      isTaker: fill.crossed,
      clientOrderId: fill.cloid?.toLowerCase() ?? null,
      twapId: fill.twapId == null ? null : String(fill.twapId),
    },
  };
}

export function hip4TrackedFillFingerprint(activity: Hip4TrackedFillActivity) {
  // Quote metadata can arrive later, but native financial fill facts cannot be
  // silently rewritten by replay. Derived USD marks are not provider identity.
  const { sizeUsd: _sizeUsd, quoteToken: _quoteToken, ...native } = activity;
  return createHash("sha256").update(JSON.stringify(native)).digest("hex");
}

function endpointCoverage(
  observation: Hip4TrackedEndpointObservation,
  source: string,
): Hip4TrackedEndpointCoverage {
  return observation.available
    ? {
        source,
        status: "available",
        observedAt: observation.observedAt,
        reason: null,
      }
    : {
        source,
        status: "unavailable",
        observedAt: null,
        reason: observation.reason,
      };
}

/** Independent endpoint failures preserve independently valid current facts.
 * No zero-fill history, global concentration or historical edge is fabricated.
 */
export function projectHip4KnownWalletIntel(input: {
  identity: Hip4WalletIntelIdentity;
  role: unknown;
  abstraction: unknown;
  roleFailure?: Hip4TrackedEndpointFailure;
  abstractionFailure?: Hip4TrackedEndpointFailure;
  quote: { tokenId: string; index: number; weiDecimals: number };
  positions: Hip4TrackedEndpointObservation;
  openOrders: Hip4TrackedEndpointObservation;
  fills: Hip4TrackedEndpointObservation;
  quoteTokensByMarket?: ReadonlyMap<string, string>;
}) {
  const identity = hip4WalletIntelIdentity(
    input.identity.environment,
    input.identity.address,
  );
  if (identity.chain !== input.identity.chain)
    throw new Error("tracked_account_environment_mismatch");
  const role = hip4AccountRoleSchema.safeParse(input.role);
  const mode = hip4AccountAbstractionSchema.safeParse(input.abstraction);
  const roleSupported =
    role.success && ["user", "missing"].includes(role.data.role);
  const coverage: Hip4KnownWalletCoverage = {
    version: 1,
    scope: "known_wallet_only",
    environment: identity.environment,
    chain: identity.chain,
    accountAddress: identity.address,
    accountRole: role.success ? role.data.role : "unknown",
    positions: endpointCoverage(
      input.positions,
      "hyperliquid_spot_clearinghouse_state",
    ),
    openOrders: endpointCoverage(
      input.openOrders,
      "hyperliquid_frontend_open_orders",
    ),
    fills: {
      ...endpointCoverage(input.fills, "hyperliquid_user_fills"),
      completeHistory: false,
      providerCapped: false,
      returnedStart: null,
      returnedEnd: null,
      invalidRows: 0,
      conflictingIdentities: 0,
      excludedRows: {
        non_outcome: 0,
        settlement: 0,
        merge_outcome: 0,
        unknown_native_kind: 0,
      },
    },
    globalHolders: {
      status: "unavailable",
      reason: "no_verified_global_holder_source",
    },
    historicalPerformance: {
      status: "unavailable",
      reason: "unproven_history_and_cost_basis",
    },
  };
  if (!roleSupported || !mode.success) {
    for (const endpoint of [
      coverage.positions,
      coverage.openOrders,
      coverage.fills,
    ]) {
      endpoint.status = "unavailable";
      endpoint.reason = !role.success
        ? (input.roleFailure ?? "invalid_response")
        : !roleSupported
          ? "unsupported_account_role"
          : (input.abstractionFailure ?? "unknown_account_abstraction");
      endpoint.observedAt = null;
    }
    return {
      identity,
      positions: [],
      openOrders: [],
      activities: [],
      activityObservations: [] as Hip4TrackedFillActivity[],
      canReplacePreviousPositions: false,
      coverage,
    };
  }
  let positions: ReturnType<typeof projectHip4Account>["positions"] = [];
  let canReplacePreviousPositions = false;
  if (input.positions.available) {
    try {
      const observation = projectHip4Account({
        environment: identity.environment,
        observedAt: input.positions.observedAt,
        role: role.data.role as "user" | "missing",
        mode: mode.data,
        state: input.positions.value,
        quote: input.quote,
      });
      positions = observation.positions;
      canReplacePreviousPositions = observation.unresolvedBalances.length === 0;
      if (!canReplacePreviousPositions) {
        coverage.positions.status = "partial";
        coverage.positions.reason = "unresolved_outcome_balances";
      }
    } catch {
      coverage.positions = {
        ...coverage.positions,
        status: "unavailable",
        reason: "invalid_response",
        observedAt: null,
      };
    }
  }
  let openOrders: ReturnType<typeof projectHip4OpenOrders>["items"] = [];
  if (input.openOrders.available) {
    try {
      openOrders = projectHip4OpenOrders(
        identity.environment,
        input.openOrders.value,
        Date.parse(input.openOrders.observedAt),
      ).items;
    } catch {
      coverage.openOrders = {
        ...coverage.openOrders,
        status: "unavailable",
        reason: "invalid_response",
        observedAt: null,
      };
    }
  }
  const byKey = new Map<string, Hip4TrackedFillActivity>();
  const activityObservations: Hip4TrackedFillActivity[] = [];
  const conflicts = new Set<string>();
  if (input.fills.available) {
    const rows = input.fills.value;
    if (!Array.isArray(rows) || rows.length > 2000) {
      coverage.fills.status = "unavailable";
      coverage.fills.reason = "invalid_response";
      coverage.fills.observedAt = null;
    } else {
      // The whole provider page consumes the cap, including spot/perp rows.
      coverage.fills.providerCapped = rows.length === 2000;
      for (const value of rows) {
        try {
          const parsed = normalizeHip4KnownWalletFill({
            identity,
            value,
            observedAt: input.fills.observedAt,
            quoteTokensByMarket: input.quoteTokensByMarket,
          });
          if (parsed.kind !== "trade") {
            coverage.fills.excludedRows[parsed.reason]++;
            continue;
          }
          const activity = parsed.activity;
          activityObservations.push(activity);
          const previous = byKey.get(activity.sourceEventKey);
          if (
            previous &&
            hip4TrackedFillFingerprint(previous) !==
              hip4TrackedFillFingerprint(activity)
          )
            conflicts.add(activity.sourceEventKey);
          else byKey.set(activity.sourceEventKey, activity);
        } catch {
          coverage.fills.invalidRows++;
        }
      }
      for (const key of conflicts) byKey.delete(key);
      coverage.fills.conflictingIdentities = conflicts.size;
      if (
        coverage.fills.providerCapped ||
        coverage.fills.invalidRows ||
        conflicts.size
      ) {
        coverage.fills.status = "partial";
        coverage.fills.reason = conflicts.size
          ? "conflicting_fill_identity"
          : coverage.fills.invalidRows
            ? "invalid_fill_rows"
            : "provider_capped";
      }
    }
  }
  const activities = [...byKey.values()].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      a.sourceEventKey.localeCompare(b.sourceEventKey),
  );
  coverage.fills.returnedStart = activities[0]?.occurredAt ?? null;
  coverage.fills.returnedEnd = activities.at(-1)?.occurredAt ?? null;
  return {
    identity,
    positions,
    openOrders,
    activities,
    activityObservations,
    canReplacePreviousPositions,
    coverage,
  };
}
