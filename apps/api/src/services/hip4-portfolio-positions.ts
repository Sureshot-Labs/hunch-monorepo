import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  hip4Identity,
  hip4RawUnits,
  hip4ReadMarketSchema,
  parseHip4Coin,
  type Hip4Environment,
  type Hip4ReadMarket,
} from "@hunch/shared";
import {
  hip4AccountObservationSchema,
  hip4PositionAccountingSchema,
  type Hip4AccountObservation,
} from "../schemas/hip4-account.js";
import {
  compareUnsignedDecimals,
  multiplyUnsignedDecimals,
  unitPriceFromRawEstimate,
} from "../account-value/decimal.js";
import { hip4SignedAmount } from "./hip4-account-projection.js";
import { readHip4Policy } from "./hip4-repository.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import type { z } from "zod";
import type { hip4PortfolioCoverageSchema } from "../schemas/position-read.js";
import type { Hip4PortfolioPosition } from "../schemas/position-read.js";
export type { Hip4PortfolioPosition } from "../schemas/position-read.js";

/** Portfolio reads share the existing account facts. They do not create a
 * second position ledger, infer holdings from fills, or call a provider. */
export const HIP4_PORTFOLIO_ACCOUNTS_SQL = `
  select distinct lower(wallet_row.wallet_address) as account_address,
    snapshot_row.observation, snapshot_row.history->'positionAccounting' as accounting
  from user_wallets wallet_row
  join users owner_row on owner_row.id=wallet_row.user_id and owner_row.is_active
  left join hip4_account_snapshots snapshot_row
    on snapshot_row.environment=$2
      and snapshot_row.account_address=lower(wallet_row.wallet_address)
  where wallet_row.user_id=$1 and wallet_row.wallet_type='ethereum'
    and wallet_row.is_verified
    and lower(wallet_row.wallet_address)=any($3::text[])
  order by account_address`;

export const HIP4_PORTFOLIO_MARKETS_SQL = `
  select read_row.read_model from hip4_read_markets read_row
  where read_row.environment=$1 and read_row.market_id=any($2::text[])`;

export function projectHip4PortfolioPositions(input: {
  userId: string;
  address: string;
  environment: Hip4Environment;
  observation: unknown;
  accounting?: unknown;
  markets: ReadonlyMap<string, Hip4ReadMarket>;
  snapshotMaxAgeMs: number;
  now: number;
}): Hip4PortfolioPosition[] {
  const observation = hip4AccountObservationSchema.parse(input.observation);
  const observedTime = Date.parse(observation.observedAt);
  const snapshotUntil = observedTime + input.snapshotMaxAgeMs;
  const fresh = observedTime <= input.now && snapshotUntil > input.now;
  const accounting = hip4PositionAccountingSchema.safeParse(
    input.accounting,
  ).data;
  const basisByCoin = new Map(
    accounting?.observedAt === observation.observedAt
      ? accounting.positions.map(
          (position) => [position.coin, position] as const,
        )
      : [],
  );
  return observation.positions.map((position) => {
    const displaySize = Number(position.quantity);
    if (!Number.isFinite(displaySize))
      throw new Error("hip4_position_size_unrepresentable");
    const parsed = parseHip4Coin(`#${position.coin.slice(1)}`);
    const identity = hip4Identity(input.environment, parsed.outcome);
    const side = identity.sides[parsed.sideIndex];
    if (
      !position.coin.startsWith("+") ||
      position.sideIndex !== parsed.sideIndex ||
      position.marketId !== identity.marketId ||
      position.tokenId !== side.tokenId
    )
      throw new Error("hip4_position_identity_conflict");
    const candidate = input.markets.get(identity.marketId);
    // Retain the holding even when metadata disappeared or is incompatible.
    const market =
      candidate?.environment === input.environment &&
      candidate.marketId === identity.marketId &&
      candidate.outcome === parsed.outcome
        ? candidate
        : null;
    const marketSide = market?.sides.find(
      (item) =>
        item.sideIndex === parsed.sideIndex &&
        item.tokenId === side.tokenId &&
        item.coin === side.coin,
    );
    const value: Hip4PortfolioPosition["valuation"] = {
      markPrice: null,
      marketValue: null,
      source: null,
      observedAt: null,
      validUntil: null,
    };
    // A final payout values only a still-observed holding. It does not assert
    // that settlement cash arrived or that historical PnL is known.
    if (
      fresh &&
      market?.quoteToken === "USDC" &&
      marketSide &&
      market.settlement &&
      marketSide.payout != null &&
      Date.parse(market.settlement.observedAt) <= input.now
    ) {
      value.markPrice = marketSide.payout;
      value.source = "official_payout";
      value.observedAt = market.settlement.observedAt;
      value.validUntil = new Date(snapshotUntil).toISOString();
    } else if (
      fresh &&
      market?.quoteToken === "USDC" &&
      market.status === "observed" &&
      market.coverage.metadata === "fresh" &&
      Date.parse(market.fetchedAt) <= input.now &&
      market.metadataValidUntil &&
      Date.parse(market.metadataValidUntil) > input.now &&
      marketSide?.bookState === "fresh" &&
      marketSide.bookAt &&
      Date.parse(marketSide.bookAt) <= input.now &&
      marketSide.bookValidUntil &&
      Date.parse(marketSide.bookValidUntil) > input.now &&
      marketSide.bid != null &&
      marketSide.ask != null &&
      compareUnsignedDecimals(marketSide.bid, marketSide.ask) <= 0
    ) {
      value.markPrice = marketSide.bid;
      value.source = "book_bid";
      value.observedAt = marketSide.bookAt;
      value.validUntil = new Date(
        Math.min(
          snapshotUntil,
          Date.parse(marketSide.bookValidUntil),
          Date.parse(market.metadataValidUntil),
        ),
      ).toISOString();
    }
    if (value.markPrice != null)
      value.marketValue = multiplyUnsignedDecimals(
        position.quantity,
        value.markPrice,
      );
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          input.environment,
          input.address.toLowerCase(),
          position.tokenId,
        ]),
      )
      .digest("hex");
    const basis = basisByCoin.get(position.coin);
    const costBasis =
      basis?.reason === "verified" && basis.quantity === position.quantity
        ? basis.costBasis
        : null;
    const averagePriceRaw =
      costBasis == null
        ? null
        : unitPriceFromRawEstimate({
            raw: hip4RawUnits(position.quantity, 5).toString(),
            decimals: 5,
            estimatedValue: costBasis,
            outputScale: 13,
          });
    const pnl =
      costBasis != null && value.marketValue != null
        ? hip4SignedAmount(
            hip4RawUnits(value.marketValue, 13) - hip4RawUnits(costBasis, 13),
            13,
          )
        : null;
    return {
      id: `hyperliquid:${id}`,
      userId: input.userId,
      walletAddress: input.address.toLowerCase(),
      venue: "hyperliquid",
      tokenId: position.tokenId,
      side: "LONG",
      size: displaySize,
      sizeRaw: position.quantity,
      averagePrice: averagePriceRaw == null ? null : Number(averagePriceRaw),
      averagePriceRaw,
      costBasisRaw: costBasis,
      basisReason: basis?.reason ?? "history_incomplete",
      unrealizedPnl: pnl == null ? null : Number(pnl),
      unrealizedPnlRaw: pnl,
      realizedPnl: null,
      lastUpdatedAt: observation.observedAt,
      instrument: {
        environment: input.environment,
        marketId: identity.marketId,
        outcome: parsed.outcome,
        sideIndex: parsed.sideIndex,
        coin: position.coin,
      },
      observation: {
        state: fresh ? "fresh" : "stale",
        validUntil: new Date(snapshotUntil).toISOString(),
      },
      valuation: value,
      marketSummary:
        market && marketSide
          ? {
              eventId: market.eventId,
              title: market.title,
              eventTitle: market.eventTitle,
              outcomeLabel: marketSide.label,
              expiry: market.expiry,
              status: market.status,
            }
          : null,
      capabilities: { sell: false, redeem: false, hide: false },
    };
  });
}

export type Hip4PortfolioRead = {
  positions: Hip4PortfolioPosition[];
  coverage: z.infer<typeof hip4PortfolioCoverageSchema>;
};

/** Internal shared facts for Portfolio and Account Value, never a public DTO. */
export type Hip4OwnedPortfolioRead = Hip4PortfolioRead & {
  environment: Hip4Environment | null;
  snapshotMaxAgeMs: number;
  accounts: { address: string; observation: Hip4AccountObservation | null }[];
};

/** Call only after the route's read-access authorization. SQL independently
 * rechecks current ownership: funder aliases and caller-supplied wallets cannot
 * read an account merely because another venue accepted that address. */
export async function readHip4OwnedPortfolio(
  db: Pick<Pool, "query">,
  input: {
    userId: string;
    walletAddresses: readonly string[];
    now?: number;
    marketId?: string;
    eventId?: string;
    tokenIds?: readonly string[];
    minSize?: number;
    search?: string;
  },
): Promise<Hip4OwnedPortfolioRead> {
  const result: Hip4OwnedPortfolioRead = {
    environment: null,
    snapshotMaxAgeMs: 0,
    accounts: [],
    positions: [],
    coverage: {
      state: "ready",
      policyRevision: null,
      accounts: 0,
      missingAccounts: 0,
      staleAccounts: 0,
      unresolvedBalances: 0,
      missingCostBasis: 0,
      unpricedPositions: 0,
    },
  };
  const addresses = [
    ...new Set(
      input.walletAddresses
        .filter((address) => /^0x[0-9a-fA-F]{40}$/.test(address))
        .map((address) => address.toLowerCase()),
    ),
  ];
  if (!addresses.length) return result;
  const [read, account] = await Promise.all([
    readHip4Policy(db, "accountRead"),
    readHip4AccountPolicy(db),
  ]);
  result.coverage.policyRevision = `${read.revision}:${account.revision}`;
  if (!read.policy.enabled || !account.policy.enabled) {
    result.coverage.state = "disabled";
    return result;
  }
  result.environment = read.policy.environment;
  result.snapshotMaxAgeMs = account.policy.snapshotMaxAgeMs;
  const rows = await db.query<{
    account_address: string;
    observation: unknown;
    accounting: unknown;
  }>(HIP4_PORTFOLIO_ACCOUNTS_SQL, [
    input.userId,
    read.policy.environment,
    addresses,
  ]);
  const observed = rows.rows.map((row) => ({
    address: row.account_address,
    accounting: row.accounting,
    observation:
      row.observation == null
        ? null
        : hip4AccountObservationSchema.parse(row.observation),
  }));
  result.accounts = observed;
  const ids = [
    ...new Set(
      observed.flatMap(
        (row) =>
          row.observation?.positions.map((position) => position.marketId) ?? [],
      ),
    ),
  ];
  const marketRows = ids.length
    ? await db.query<{ read_model: unknown }>(HIP4_PORTFOLIO_MARKETS_SQL, [
        read.policy.environment,
        ids,
      ])
    : { rows: [] };
  const markets = new Map<string, Hip4ReadMarket>();
  for (const row of marketRows.rows) {
    const parsed = hip4ReadMarketSchema.safeParse(row.read_model);
    if (parsed.success) markets.set(parsed.data.marketId, parsed.data);
  }
  const now = input.now ?? Date.now();
  for (const row of observed) {
    result.coverage.accounts++;
    if (!row.observation) {
      result.coverage.missingAccounts++;
      continue;
    }
    const timestamp = Date.parse(row.observation.observedAt);
    if (timestamp > now || timestamp + account.policy.snapshotMaxAgeMs <= now)
      result.coverage.staleAccounts++;
    result.coverage.unresolvedBalances +=
      row.observation.unresolvedBalances.length;
    result.positions.push(
      ...projectHip4PortfolioPositions({
        ...input,
        address: row.address,
        environment: read.policy.environment,
        observation: row.observation,
        accounting: row.accounting,
        markets,
        now,
        snapshotMaxAgeMs: account.policy.snapshotMaxAgeMs,
      }),
    );
  }
  const needle = input.search?.trim().toLowerCase();
  result.positions = result.positions.filter(
    (position) =>
      (!input.marketId || position.instrument.marketId === input.marketId) &&
      (!input.eventId ||
        input.marketId ||
        position.marketSummary?.eventId === input.eventId) &&
      (!input.tokenIds || input.tokenIds.includes(position.tokenId)) &&
      // minSize is the common API's numeric display filter, not a financial
      // amount. Exact quantity/value arithmetic continues to use sizeRaw.
      (input.minSize == null || position.size >= input.minSize) &&
      (!needle ||
        [
          position.tokenId,
          position.instrument.marketId,
          position.marketSummary?.title,
          position.marketSummary?.eventTitle,
          position.marketSummary?.outcomeLabel,
        ].some((value) => value?.toLowerCase().includes(needle))),
  );
  result.coverage.missingCostBasis = result.positions.filter(
    (position) => position.costBasisRaw == null,
  ).length;
  result.coverage.unpricedPositions = result.positions.filter(
    (position) => position.valuation.marketValue == null,
  ).length;
  if (
    result.coverage.missingAccounts ||
    result.coverage.staleAccounts ||
    result.coverage.unresolvedBalances ||
    result.coverage.unpricedPositions
  )
    result.coverage.state = "partial";
  return result;
}

export async function readHip4PortfolioPositions(
  db: Pick<Pool, "query">,
  input: Parameters<typeof readHip4OwnedPortfolio>[1],
): Promise<Hip4PortfolioRead> {
  const { positions, coverage } = await readHip4OwnedPortfolio(db, input);
  // Do not expose the other native balances via a position read endpoint.
  return { positions, coverage };
}
