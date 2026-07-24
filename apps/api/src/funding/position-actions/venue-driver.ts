import type { Pool } from "@hunch/infra";

import type { MarketByTokenRow } from "../../repos/unified-read.js";
import { fetchEmbeddedEthereumTransactionReceipt } from "../../services/embedded-ethereum.js";
import type { RedemptionPlan } from "../../services/redemption-plan.js";
import type {
  FundingReasonCode,
  JsonObject,
  PreparationExecutionMode,
} from "../domain/types.js";
import { sumErc20TransfersTo } from "../execution/evm-erc20-receipt.js";

export type StoredPositionContext = Readonly<{
  id: string;
  sizeRaw: string;
  tokenId: string;
  venueId: string;
  walletAddress: string;
}>;

export type RedemptionMarketContext = Readonly<{
  adapterAddress: string | null;
  conditionId: string | null;
  isNegRisk: boolean;
  marketClass: string;
  marketId: string;
  outcome: "NO" | "YES";
  row: MarketByTokenRow;
}>;

export type RedemptionExecutionProfile = Readonly<{
  topologySupported: boolean;
  unsupportedReason: FundingReasonCode;
  externalHandoff: Readonly<{
    handoffKind: string;
    payload: JsonObject;
  }> | null;
}>;

export type PositionActionReceiptObservation = Readonly<{
  succeeded: boolean;
  expectedPayoutRaw: string | null;
  actualPayoutRaw: string | null;
  evidence: JsonObject;
}>;

export interface PositionActionVenueDriver {
  readonly adapterId: string;
  readonly venueId: string;

  buildMarketContext(
    row: MarketByTokenRow,
    outcome: "NO" | "YES",
  ): RedemptionMarketContext;

  buildPlan(
    input: Readonly<{
      market: RedemptionMarketContext;
      position: StoredPositionContext;
    }>,
  ): Promise<RedemptionPlan>;

  inspectOperatorApproval(
    input: Readonly<{
      market: RedemptionMarketContext;
      ownerAddress: string;
      plan: RedemptionPlan;
      signerAddress: string;
      userId: string;
    }>,
  ): Promise<boolean | null>;

  resolveExecutionProfile(
    input: Readonly<{
      executionMode: PreparationExecutionMode;
      ownerAddress: string;
      topology: string;
    }>,
  ): RedemptionExecutionProfile;

  conditionalTokensAddress(): string;

  observeReceipt(
    input: Readonly<{
      ownerAddress: string;
      plan: RedemptionPlan;
      transactionHash: string;
    }>,
  ): Promise<PositionActionReceiptObservation | null>;

  refreshPositions(
    input: Readonly<{
      db: Pool;
      userId: string;
      walletAddress: string;
    }>,
  ): Promise<void>;
}

export class PositionActionVenueRegistry {
  private readonly byVenueId: ReadonlyMap<string, PositionActionVenueDriver>;

  constructor(drivers: readonly PositionActionVenueDriver[]) {
    const byVenueId = new Map<string, PositionActionVenueDriver>();
    for (const driver of drivers) {
      const venueId = driver.venueId.trim();
      if (!/^[a-z0-9][a-z0-9:_-]{1,159}$/.test(venueId)) {
        throw new Error(`invalid position-action venue ID: ${driver.venueId}`);
      }
      if (byVenueId.has(venueId)) {
        throw new Error(`duplicate position-action venue driver: ${venueId}`);
      }
      byVenueId.set(venueId, driver);
    }
    this.byVenueId = byVenueId;
  }

  has(venueId: string): boolean {
    return this.byVenueId.has(venueId);
  }

  require(venueId: string): PositionActionVenueDriver {
    const driver = this.byVenueId.get(venueId);
    if (!driver) {
      throw new Error(`unsupported position-action venue: ${venueId}`);
    }
    return driver;
  }
}

function expectedPayout(plan: RedemptionPlan): bigint | null {
  const raw = plan.expectedPayoutRaw ?? plan.payoutAmountRaw ?? null;
  return raw && /^(0|[1-9][0-9]*)$/.test(raw) ? BigInt(raw) : null;
}

export function createEvmPositionActionReceiptObserver(
  chainId: number,
): PositionActionVenueDriver["observeReceipt"] {
  return async (input) => {
    const receipt = await fetchEmbeddedEthereumTransactionReceipt({
      chainId,
      txHash: input.transactionHash,
    });
    if (!receipt) return null;
    const expected = expectedPayout(input.plan);
    const payoutToken =
      typeof input.plan.payoutTokenAddress === "string"
        ? input.plan.payoutTokenAddress
        : null;
    const actual =
      receipt.succeeded && expected != null && payoutToken
        ? sumErc20TransfersTo({
            logs: receipt.logs,
            recipient: input.ownerAddress,
            tokenAddress: payoutToken,
          })
        : null;
    return {
      succeeded: receipt.succeeded,
      expectedPayoutRaw: expected?.toString() ?? null,
      actualPayoutRaw: actual?.toString() ?? null,
      evidence: {
        blockNumber: receipt.blockNumber,
        transactionHash: receipt.transactionHash,
      },
    };
  };
}
