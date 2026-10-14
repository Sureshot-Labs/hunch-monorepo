import { hip4RawUnits, parseHip4Coin } from "@hunch/shared";
import { hip4AccountFillSchema } from "./hip4-account-contract.js";
import { hip4SignedAmount } from "./hip4-account-projection.js";

type Fill = ReturnType<typeof hip4AccountFillSchema.parse>;
export function hip4BasisFillFingerprint(value: unknown): string | null {
  try {
    const fill = hip4AccountFillSchema.parse(value);
    const signed = (value: string, decimals: number) =>
      hip4RawUnits(value.replace(/^-/, ""), decimals) *
      (value.startsWith("-") ? -1n : 1n);
    return JSON.stringify([
      hip4RawUnits(fill.px, 8).toString(),
      hip4RawUnits(fill.sz, 5).toString(),
      fill.side,
      signed(fill.startPosition, 5).toString(),
      fill.dir,
      signed(fill.fee, 8).toString(),
      fill.feeToken,
      fill.hash.toLowerCase(),
    ]);
  } catch {
    return null;
  }
}
export type Hip4BasisReason =
  | "verified"
  | "history_incomplete"
  | "opening_basis_unknown"
  | "position_mismatch"
  | "ambiguous_execution_sequence"
  | "unsupported_economic_event"
  | "execution_identity_conflict"
  | "unknown_fee_asset";
export type Hip4PositionBasis = {
  coin: string;
  quantity: string;
  costBasis: string | null;
  realizedSinceAnchor: string | null;
  anchorTime: number | null;
  reason: Hip4BasisReason;
};

/** A qualified current-position basis, NOT all-time wallet PnL. Exact provider
 * startPosition chains anchor at zero; external movements/unknown transforms
 * break the chain. Never seed holdings from these calculations: reconcile to
 * the independently observed complete native balance snapshot instead.
 *
 * Basis includes charged BUY fees (builderFee is already included in fee).
 * Partial disposals release weighted-average basis at 13 decimal places, with
 * the rounding remainder kept in the lot and released on its final disposal.
 */
export function projectHip4PositionBasis(input: {
  positions: readonly { coin: string; quantity: string }[];
  fills: readonly unknown[];
  ledger: readonly { time: number; delta: Record<string, unknown> }[];
  quoteLedgerToken: string;
  observedTime: number;
  // Exhausted provider-visible ranges, not a claim about its older retention.
  coveredFrom: number | null;
  coveredThrough: number | null;
  gaps: readonly number[];
  incomplete: boolean;
  conflicts?: Readonly<Record<string, number>>;
}): Hip4PositionBasis[] {
  const byCoin = new Map<string, Fill[]>();
  const identities = new Map<string, string>();
  const conflicted = new Map<string, number>();
  for (const value of input.fills) {
    const parsed = hip4AccountFillSchema.safeParse(value);
    if (!parsed.success) {
      // Missing source evidence cannot silently disappear from an accounting
      // range. Reader marks the entire range incomplete before calling here.
      return input.positions.map((position) =>
        unknown(position, "history_incomplete"),
      );
    }
    const fill = parsed.data;
    if (fill.time > input.observedTime) continue;
    const key = `${fill.time}:${fill.coin}:${fill.tid}:${fill.oid}`;
    // Deliberately not hash-only: a merge has two real legs, and a hash can
    // contain independent executions. A repeated exact provider fact is replay.
    const fingerprint = hip4BasisFillFingerprint(fill);
    if (fingerprint == null)
      return input.positions.map((position) =>
        unknown(position, "history_incomplete"),
      );
    const previous = identities.get(key);
    if (previous != null) {
      if (previous !== fingerprint)
        conflicted.set(
          fill.coin,
          Math.max(fill.time, conflicted.get(fill.coin) ?? 0),
        );
      continue;
    }
    identities.set(key, fingerprint);
    const bucket = byCoin.get(fill.coin) ?? [];
    bucket.push(fill);
    byCoin.set(fill.coin, bucket);
  }
  return input.positions.map((position) => {
    const coin = `#${position.coin.slice(1)}`;
    if (!position.coin.startsWith("+"))
      return unknown(position, "opening_basis_unknown");
    parseHip4Coin(coin);
    if (
      input.incomplete ||
      input.coveredFrom == null ||
      input.coveredThrough == null ||
      input.coveredThrough < input.observedTime
    )
      return unknown(position, "history_incomplete");
    const fills = (byCoin.get(coin) ?? []).sort((a, b) => a.time - b.time);
    let quantity: bigint | null = null;
    let basis: bigint | null = null;
    let realized = 0n;
    let anchor: number | null = null;
    let reason: Hip4BasisReason = "opening_basis_unknown";
    const invalidate = (why: Hip4BasisReason) => {
      quantity = null;
      basis = null;
      anchor = null;
      realized = 0n;
      reason = why;
    };
    for (let index = 0; index < fills.length; ) {
      const time = fills[index].time;
      const group: Fill[] = [];
      while (index < fills.length && fills[index].time === time)
        group.push(fills[index++]);
      // Same-millisecond fills are ordered by the reported position chain, not
      // by tid (which is a hash, not an execution sequence number).
      while (group.length) {
        const isZeroBuy = (fill: Fill) =>
          fill.dir === "Buy" &&
          fill.side === "B" &&
          /^-?0(?:\.0+)?$/.test(fill.startPosition);
        let matches = group.filter((fill) => {
          if (fill.startPosition.startsWith("-")) return false;
          const start = hip4RawUnits(fill.startPosition, 5);
          return quantity != null
            ? start === quantity
            : start === 0n && fill.dir === "Buy" && fill.side === "B";
        });
        if (
          matches.length === 0 &&
          quantity != null &&
          group.filter(isZeroBuy).length === 1
        ) {
          // A proven later zero restarts only current-lot accounting. Missing
          // earlier closing/transfer facts still prevent all-time PnL.
          invalidate("position_mismatch");
          matches = group.filter(isZeroBuy);
        }
        if (matches.length !== 1) {
          invalidate(
            matches.length > 1
              ? "ambiguous_execution_sequence"
              : reason === "opening_basis_unknown"
                ? reason
                : "position_mismatch",
          );
          // A later timestamp with an explicit zero-position BUY can recover.
          break;
        }
        const fill = matches[0];
        group.splice(group.indexOf(fill), 1);
        const size = hip4RawUnits(fill.sz, 5);
        const gross = hip4RawUnits(fill.px, 8) * size;
        const fee =
          hip4RawUnits(fill.fee.replace(/^-/, ""), 8) *
          (fill.fee.startsWith("-") ? -1n : 1n) *
          100_000n;
        if (
          !size ||
          !["Buy", "Sell", "Settlement"].includes(fill.dir) ||
          (fill.dir === "Buy" ? fill.side !== "B" : fill.side !== "A")
        ) {
          invalidate("unsupported_economic_event");
          break;
        }
        if (fill.feeToken !== "USDC") {
          invalidate("unknown_fee_asset");
          break;
        }
        if (quantity == null) {
          quantity = 0n;
          basis = 0n;
          anchor = time;
          realized = 0n;
        }
        if (basis == null) break;
        if (fill.dir === "Buy") {
          if (gross + fee < 0n) {
            invalidate("unsupported_economic_event");
            break;
          }
          quantity += size;
          basis += gross + fee;
        } else {
          if (size > quantity || quantity === 0n) {
            invalidate("position_mismatch");
            break;
          }
          const released = (basis * size) / quantity;
          realized += gross - fee - released;
          basis -= released;
          quantity -= size;
        }
        reason = "verified";
        if (quantity === 0n) {
          // Next position is a new lot, not all-time realized performance.
          quantity = null;
          basis = null;
          anchor = null;
          realized = 0n;
          reason = "opening_basis_unknown";
        }
      }
    }
    if (basis == null || anchor == null || quantity == null)
      return unknown(position, reason);
    const anchorTime = anchor;
    const conflictThrough = Math.max(
      conflicted.get(coin) ?? -1,
      input.conflicts?.[coin] ?? -1,
    );
    if (conflictThrough >= anchorTime)
      return unknown(position, "execution_identity_conflict");
    if (quantity !== hip4RawUnits(position.quantity, 5))
      return unknown(position, "position_mismatch");
    if (
      anchorTime < input.coveredFrom ||
      input.gaps.some(
        (time) => time >= anchorTime && time <= input.observedTime,
      )
    )
      return unknown(position, "history_incomplete");
    // Cash funding does not change side-token basis. Transfers of uncertain
    // assets, transformations and future ledger kinds are not assumed neutral.
    if (
      input.ledger.some(
        (entry) =>
          entry.time >= anchorTime &&
          entry.time <= input.observedTime &&
          !isBasisNeutralLedger(entry.delta, input.quoteLedgerToken),
      )
    )
      return unknown(position, "unsupported_economic_event");
    return {
      coin: position.coin,
      quantity: position.quantity,
      costBasis: hip4SignedAmount(basis, 13),
      realizedSinceAnchor: hip4SignedAmount(realized, 13),
      anchorTime,
      reason: "verified",
    };
  });
}

function unknown(
  position: { coin: string; quantity: string },
  reason: Hip4BasisReason,
): Hip4PositionBasis {
  return {
    coin: position.coin,
    quantity: position.quantity,
    costBasis: null,
    realizedSinceAnchor: null,
    anchorTime: null,
    reason,
  };
}

function isBasisNeutralLedger(
  delta: Record<string, unknown>,
  quoteLedgerToken: string,
) {
  if (
    [
      "deposit",
      "withdraw",
      "internalTransfer",
      "accountClassTransfer",
    ].includes(String(delta.type))
  )
    return true;
  // Exact native quote identity, not a symbol-only guess about another token.
  return (
    ["send", "spotTransfer"].includes(String(delta.type)) &&
    delta.token === quoteLedgerToken
  );
}
