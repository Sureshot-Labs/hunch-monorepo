import { createHash } from "node:crypto";
import {
  hip4Identity,
  hip4RawUnits,
  parseHip4Coin,
  type Hip4Environment,
} from "@hunch/shared";
import {
  hip4AccountFillSchema,
  hip4SpotAccountStateSchema,
} from "./hip4-account-contract.js";
import {
  hip4AccountObservationSchema,
  type Hip4AccountExecution,
} from "../schemas/hip4-account.js";
import {
  formatUnsignedDecimal,
  multiplyUnsignedDecimals,
  normalizeUnsignedDecimal,
} from "../account-value/decimal.js";

export function hip4SignedAmount(raw: bigint, decimals: number) {
  return `${raw < 0n ? "-" : ""}${formatUnsignedDecimal(raw < 0n ? -raw : raw, decimals)}`;
}

function canonicalSignedDecimal(value: string) {
  const unsigned = normalizeUnsignedDecimal(value.replace(/^-/, ""));
  return unsigned === "0"
    ? "0"
    : `${value.startsWith("-") ? "-" : ""}${unsigned}`;
}

export function projectHip4Account(input: {
  environment: Hip4Environment;
  observedAt: string;
  role: "user" | "missing";
  mode:
    | "default"
    | "disabled"
    | "dexAbstraction"
    | "unifiedAccount"
    | "portfolioMargin";
  state: unknown;
  quote: { tokenId: string; index: number; weiDecimals: number };
}) {
  const state = hip4SpotAccountStateSchema.parse(input.state);
  if (input.quote.weiDecimals !== 8)
    throw new Error("unsupported_quote_precision");
  const cashRows = state.balances.filter(
    (row) => row.token === input.quote.index && row.coin === "USDC",
  );
  if (cashRows.length > 1) throw new Error("duplicate_quote_balance");
  const cash = cashRows[0];
  const total = cash?.total ?? "0";
  const held = cash?.hold ?? "0";
  const unheld =
    !total.startsWith("-") && !held.startsWith("-")
      ? hip4RawUnits(total, 8) - hip4RawUnits(held, 8)
      : null;
  const riskMode =
    input.mode === "portfolioMargin" || state.portfolioMarginEnabled === true;
  const missingDebtFacts =
    input.mode === "unifiedAccount" && cash?.borrowed == null;
  const cashOwned =
    !riskMode &&
    !missingDebtFacts &&
    ["disabled", "unifiedAccount"].includes(input.mode) &&
    unheld != null &&
    unheld >= 0n &&
    !(cash?.borrowed && hip4RawUnits(cash.borrowed, 8) > 0n);
  const positions = [];
  const unresolvedBalances = [];
  const seen = new Set<string>();
  for (const row of state.balances) {
    if (!row.coin.startsWith("+") && !row.coin.startsWith("o")) continue;
    // oN encodes outcome-wide bookkeeping, not a proven YES/NO side token.
    if (!row.coin.startsWith("+")) {
      // The provider retains fully zero bookkeeping rows after settlement.
      // They stay in raw balances, but cannot make current holdings partial.
      // Nonzero/unknown bookkeeping semantics still require explicit coverage.
      if (
        ![row.total, row.hold, row.entryNtl].every(
          (value) => canonicalSignedDecimal(value) === "0",
        )
      )
        unresolvedBalances.push(row.coin);
      continue;
    }
    const parsed = parseHip4Coin(`#${row.coin.slice(1)}`);
    if (seen.has(row.coin)) throw new Error("duplicate_outcome_balance");
    seen.add(row.coin);
    const quantity = hip4RawUnits(row.total, 5);
    const hold = hip4RawUnits(row.hold, 5);
    if (hold > quantity) throw new Error("invalid_position_hold");
    if (quantity === 0n) continue;
    const identity = hip4Identity(input.environment, parsed.outcome);
    positions.push({
      coin: row.coin,
      marketId: identity.marketId,
      tokenId: identity.sides[parsed.sideIndex].tokenId,
      sideIndex: parsed.sideIndex,
      quantity: row.total,
      held: row.hold,
      reportedEntryNotional: row.entryNtl,
      costBasis: null,
      realizedPnl: null,
      unrealizedPnl: null,
    });
  }
  return hip4AccountObservationSchema.parse({
    observedAt: input.observedAt,
    role: input.role,
    mode: input.mode,
    cash: {
      assetId: input.quote.tokenId,
      decimals: 8,
      total,
      held,
      unheld:
        unheld != null && unheld >= 0n ? hip4SignedAmount(unheld, 8) : null,
      ownedCash:
        cashOwned && unheld != null ? hip4SignedAmount(unheld, 8) : null,
      availableAfterMaintenance:
        state.tokenToAvailableAfterMaintenance?.find(
          ([index]) => index === input.quote.index,
        )?.[1] ?? null,
      borrowed: cash?.borrowed ?? null,
      supplied: cash?.supplied ?? null,
      spendable: null,
      canTrade: false,
    },
    balances: state.balances.map((row) => ({
      coin: row.coin,
      total: row.total,
      held: row.hold,
      reportedEntryNotional: row.entryNtl,
    })),
    positions,
    unresolvedBalances,
  });
}

export function projectHip4Execution(
  environment: Hip4Environment,
  address: string,
  input: unknown,
): Hip4AccountExecution {
  const fill = hip4AccountFillSchema.parse(input);
  const identity = hip4Identity(environment, parseHip4Coin(fill.coin).outcome);
  const grossNotional = multiplyUnsignedDecimals(fill.px, fill.sz);
  const gross = hip4RawUnits(grossNotional, 13);
  const fee =
    hip4RawUnits(fill.fee.replace(/^-/, ""), 8) *
    (fill.fee.startsWith("-") ? -1n : 1n) *
    100_000n;
  const quoteCash =
    fill.feeToken === "USDC"
      ? fill.dir === "Buy"
        ? -gross - fee
        : ["Sell", "Settlement"].includes(fill.dir)
          ? gross - fee
          : null
      : null;
  return {
    id: createHash("sha256")
      .update(
        `${environment}:${address.toLowerCase()}:${fill.time}:${fill.coin}:${fill.tid}:${fill.oid}`,
      )
      .digest("hex"),
    marketId: identity.marketId,
    coin: fill.coin,
    time: fill.time,
    orderId: String(fill.oid),
    tradeId: String(fill.tid),
    transactionHash: fill.hash.toLowerCase(),
    reportedClosedPnl: canonicalSignedDecimal(fill.closedPnl),
    kind: fill.dir,
    side: fill.side,
    price: normalizeUnsignedDecimal(fill.px),
    quantity: normalizeUnsignedDecimal(fill.sz),
    grossNotional,
    fee: canonicalSignedDecimal(fill.fee),
    feeToken: fill.feeToken,
    builderFee:
      fill.builderFee == null
        ? null
        : normalizeUnsignedDecimal(fill.builderFee),
    netQuoteCash: quoteCash == null ? null : hip4SignedAmount(quoteCash, 13),
    source: "hyperliquid_user_fills",
  };
}
