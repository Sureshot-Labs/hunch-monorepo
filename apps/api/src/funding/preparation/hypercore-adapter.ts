import { hip4Identity } from "@hunch/shared";
import type { Hip4AccountObservation } from "../../schemas/hip4-account.js";
import type { ApiTradeMarket } from "../../services/api-trading-market-repo.js";
import { hip4PortfolioPositionId } from "../../services/hip4-portfolio-positions.js";
import {
  hypercoreRecipientCashCapacity,
  hypercoreOrderCashCapacity,
} from "../domain/hypercore-cash-capacity.js";
import { isHypercoreMainnetUsdc } from "../domain/hypercore-identity.js";
import {
  PreparationContractError,
  PurposeAwareWalletPreparationAdapter,
  type VenuePreparationFactsInspector,
} from "./core-adapter.js";

/** Funding a verified recipient does not require an existing positive balance
 * or trading authority. Missing/default is a receive-only empty account, not
 * evidence of Standard mode or permission to spend native funds. */
export function hypercoreFundingBalance(input: {
  observation: Hip4AccountObservation;
  environment: "mainnet" | "testnet";
  snapshotMaxAgeMs: number;
  now: number;
}): { totalRaw: string; lockedRaw: string; topology: string } {
  const capacity = hypercoreRecipientCashCapacity(input);
  if (capacity.known) {
    return {
      totalRaw: capacity.totalRaw,
      lockedRaw: capacity.lockedRaw,
      topology: capacity.topology,
    };
  }
  throw new PreparationContractError(
    capacity.reason === "stale_snapshot"
      ? "evidence_stale"
      : "preparation_unavailable",
    "Native funding recipient requires fresh supported account facts",
  );
}

/** The indexed market identifies the instrument, not execution authority.
 * Fresh price/fees/share capacity remain the quote and submission boundaries.
 * Ignore presentation-only acceptingOrders=false, never terminal status. */
export function hypercorePreparationMarket(
  market: ApiTradeMarket | null,
  now: number,
) {
  const match = /^hyperliquid:mainnet:outcome:(0|[1-9]\d*)$/u.exec(
    market?.id ?? "",
  );
  if (!market || market.venue !== "hyperliquid" || !match)
    throw new PreparationContractError(
      "evidence_invalid",
      "Native preparation requires the canonical market",
    );
  const identity = hip4Identity("mainnet", Number(match[1]));
  const deadlines = [market.close_time, market.expiration_time]
    .filter((value) => value != null)
    .map((value) => new Date(value).getTime());
  if (
    market.token_yes !== identity.sides[0].tokenId ||
    market.token_no !== identity.sides[1].tokenId ||
    market.status !== "ACTIVE" ||
    !Number.isFinite(now) ||
    deadlines.some((value) => !Number.isFinite(value) || value <= now)
  )
    throw new PreparationContractError(
      "preparation_unavailable",
      "Native market identity or active state is unavailable",
    );
  return {
    ...identity,
    validUntil: deadlines.length ? Math.min(...deadlines) : null,
  };
}

/** Candidate selection only, not proof of holdings or execution authority.
 * Reject another wallet's opaque position reference before account IO; the
 * canonical market and fresh observed position are still checked separately. */
export function hypercorePositionReferenceMatchesWallet(input: {
  address: string;
  tokenIds: readonly string[];
  positionActionRef: string | null;
}): boolean {
  return input.tokenIds.some(
    (tokenId) =>
      hip4PortfolioPositionId("mainnet", input.address, tokenId) ===
      input.positionActionRef,
  );
}

/** Preparation binds SELL to the selected observed holding, never a legacy
 * six-decimal position or another controller. It does not reserve shares or
 * attest lending/remaining executable capacity; fresh native admission does. */
export function hypercorePreparationPosition(input: {
  observation: Hip4AccountObservation;
  address: string;
  market: ReturnType<typeof hypercorePreparationMarket>;
  positionActionRef: string | null;
}) {
  const candidates = input.observation.positions.filter(
    (position) =>
      hip4PortfolioPositionId("mainnet", input.address, position.tokenId) ===
      input.positionActionRef,
  );
  const position = candidates[0];
  if (
    candidates.length !== 1 ||
    position.marketId !== input.market.marketId ||
    !input.market.sides.some(
      (side) =>
        side.tokenId === position.tokenId &&
        side.sideIndex === position.sideIndex &&
        side.tokenName === position.coin,
    )
  )
    throw new PreparationContractError(
      "binding_mismatch",
      "SELL preparation requires the selected wallet's exact observed position",
    );
  return position;
}

export function hypercorePreparationBalance(
  input: Parameters<typeof hypercoreFundingBalance>[0],
  purpose: string,
) {
  if (purpose === "fund" || purpose === "buy")
    return hypercoreFundingBalance(input);
  const capacity = hypercoreOrderCashCapacity(input);
  if (!capacity.known)
    throw new PreparationContractError(
      capacity.reason === "stale_snapshot"
        ? "evidence_stale"
        : "preparation_unavailable",
      "Native trading requires fresh supported spot cash evidence; refresh and retry",
    );
  return {
    totalRaw: capacity.totalRaw,
    lockedRaw: capacity.lockedRaw,
    topology:
      input.observation.mode === "default"
        ? "native_qualified_default_spot"
        : "native_standard_spot",
  };
}

export function hypercorePreparationRequirements(
  purpose: string,
  marketClass: string | null,
): readonly string[] | null {
  if (marketClass != null && marketClass !== "hip4") return null;
  if (purpose === "fund") return ["binding_owned", "native_recipient_observed"];
  if (purpose === "buy" || purpose === "sell")
    return [
      "binding_owned",
      purpose === "buy" ? "native_recipient_observed" : "native_spot_account",
      "market_context_resolved",
      ...(purpose === "sell" ? ["native_position_observed"] : []),
    ];
  return null;
}

export class HypercoreWalletPreparationAdapter extends PurposeAwareWalletPreparationAdapter {
  constructor(inspectFacts: VenuePreparationFactsInspector, clock: () => Date) {
    super(
      "hypercore-wallet-preparation-v1",
      async (input) => {
        if (
          input.binding.venueId !== "hyperliquid" ||
          !isHypercoreMainnetUsdc(input.binding.settlementLocation.asset)
        )
          throw new PreparationContractError(
            "binding_mismatch",
            "Native funding binding is invalid",
          );
        return inspectFacts(input);
      },
      ({ purpose, marketClass }) =>
        hypercorePreparationRequirements(purpose, marketClass),
      clock,
    );
  }
}
