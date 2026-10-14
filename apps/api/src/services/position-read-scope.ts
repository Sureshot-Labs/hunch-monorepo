import type { PositionPnlSummary } from "../repos/positions-repo.js";
import type { Hip4PortfolioRead } from "./hip4-portfolio-positions.js";

const legacyVenues = ["polymarket", "kalshi", "limitless"] as const;
export function positionReadScope(input: {
  venue?: string;
  venues?: readonly string[];
}) {
  // Match the existing venue-list precedence. Never turn a HIP-only scope
  // into an unfiltered legacy lookup by dropping the unknown venue.
  const requested = input.venues?.length
    ? input.venues
    : input.venue
      ? [input.venue]
      : null;
  return {
    legacyVenues: legacyVenues.filter(
      (venue) => !requested || requested.includes(venue),
    ),
    hyperliquid: !requested || requested.includes("hyperliquid"),
  };
}

export function unavailableHip4PositionRead(): Hip4PortfolioRead {
  return {
    positions: [],
    coverage: {
      state: "unavailable",
      policyRevision: null,
      accounts: 0,
      missingAccounts: 0,
      staleAccounts: 0,
      unresolvedBalances: 0,
      missingCostBasis: 0,
      unpricedPositions: 0,
    },
  };
}

export function mergePositionPnlSummary(
  legacy: PositionPnlSummary,
  hip4?: Hip4PortfolioRead,
) {
  if (!hip4 || hip4.coverage.state === "disabled") return legacy;
  const coverage = hip4.coverage;
  // A current zero balance does not prove zero historical realized PnL. Until
  // economic history is accounted for, an owned HIP account leaves all-time
  // realized PnL unknown even when its current snapshot is flat.
  const historyUnknown =
    coverage.accounts > 0 || coverage.state === "unavailable";
  const currentUnknown =
    coverage.state === "unavailable" ||
    coverage.missingAccounts > 0 ||
    coverage.staleAccounts > 0 ||
    coverage.unresolvedBalances > 0 ||
    coverage.missingCostBasis > 0 ||
    hip4.positions.some((position) => position.costBasisRaw == null);
  const valuationUnknown =
    currentUnknown ||
    coverage.unpricedPositions > 0 ||
    hip4.positions.some((position) => position.unrealizedPnl == null);
  const costBasis =
    legacy.unrealizedCostBasisCurrent +
    hip4.positions.reduce(
      (sum, position) => sum + Number(position.costBasisRaw ?? 0),
      0,
    );
  const pnl =
    legacy.unrealizedPnlCurrent +
    hip4.positions.reduce(
      (sum, position) => sum + (position.unrealizedPnl ?? 0),
      0,
    );
  const invalidTotal = !Number.isFinite(costBasis) || !Number.isFinite(pnl);
  return {
    ...legacy,
    positionsCount: legacy.positionsCount + hip4.positions.length,
    openPositionsCount:
      legacy.openPositionsCount +
      hip4.positions.filter(
        (position) => position.marketSummary?.status !== "settled",
      ).length,
    realizedPnlAllTime: historyUnknown ? null : legacy.realizedPnlAllTime,
    unrealizedCostBasisCurrent:
      currentUnknown || invalidTotal ? null : costBasis,
    unrealizedPnlCurrent: valuationUnknown || invalidTotal ? null : pnl,
    unrealizedPnlPercentCurrent:
      valuationUnknown || invalidTotal || costBasis <= 0
        ? null
        : (pnl / costBasis) * 100,
  };
}

export const EMPTY_LEGACY_POSITION_PNL: PositionPnlSummary = {
  openPositionsCount: 0,
  positionsCount: 0,
  realizedPnlAllTime: 0,
  unrealizedCostBasisCurrent: 0,
  unrealizedPnlCurrent: 0,
  unrealizedPnlPercentCurrent: null,
};
