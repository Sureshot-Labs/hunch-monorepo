import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";

import { isRecord } from "../../lib/type-guards.js";
import { fetchMarketsByTokenIds } from "../../repos/unified-read.js";
import {
  buildRedemptionNotification,
  createNotificationSafe,
} from "../../services/notifications.js";
import type { RedemptionPlan } from "../../services/redemption-plan.js";
import type {
  PositionActionInspectionInput,
  PositionActionReadiness,
  PositionActionResult,
} from "../domain/contracts.js";
import type {
  JsonObject,
  JsonValue,
  NormalizedAction,
} from "../domain/types.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  PreparationContractError,
  type PreparationFactCheck,
} from "../preparation/core-adapter.js";
import { OwnerBoundPositionActionExecutor } from "../preparation/position-action-executor.js";
import { WalletPreparationRuntimeService } from "../preparation/runtime-service.js";
import {
  claimPositionActionSubmission,
  completePositionActionEffect,
  createOrReplayPositionAction,
  failPositionActionEffect,
  fetchPositionActionForUser,
  recordPositionActionPostconditions,
  recordPositionActionReceipt,
  recordPositionActionSubmission,
  type PositionActionSubmissionClaim,
  type StoredPositionAction,
} from "./position-action-repository.js";
import {
  buildRedemptionPositionFacts,
  REDEMPTION_POSITION_REQUIRED_CHECKS,
  type RedemptionRuntimeEvidence,
} from "./redemption-runtime-facts.js";
import { createLimitlessPositionActionVenueDriver } from "./limitless-redemption-driver.js";
import { createPolymarketPositionActionVenueDriver } from "./polymarket-redemption-driver.js";
import {
  PositionActionVenueRegistry,
  type PositionActionVenueDriver,
  type RedemptionMarketContext,
  type StoredPositionContext,
} from "./venue-driver.js";

const POSITION_ACTION_TTL_MS = 45_000;
const ZERO_POSITION_RE = /^0(?:\.0+)?$/;

type CollectedRedemptionEvidence = Readonly<{
  driver: PositionActionVenueDriver;
  evidence: RedemptionRuntimeEvidence;
  executionAddress: string;
  executionMode:
    | "privy_authorization"
    | "privy_delegated"
    | "venue_relayer"
    | "web_client";
  market: RedemptionMarketContext;
  plan: RedemptionPlan;
  position: StoredPositionContext;
}>;

export type PreparedPositionAction = Readonly<{
  actions: readonly NormalizedAction[];
  operation: StoredPositionAction;
  replayed: boolean;
}>;

export class PositionActionRuntimeError extends Error {
  constructor(
    readonly code:
      | "invalid_submission"
      | "market_not_found"
      | "position_not_found"
      | "unsupported_position_action",
    message: string,
  ) {
    super(message);
    this.name = "PositionActionRuntimeError";
  }
}

function normalizeAddress(value: string): string {
  return ethers.getAddress(value).toLowerCase();
}

function jsonObject(value: unknown): JsonObject {
  const parsed = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("position action snapshot must be a JSON object");
  }
  return parsed as JsonObject;
}

function jsonValues(value: readonly unknown[]): readonly JsonValue[] {
  return JSON.parse(JSON.stringify(value)) as JsonValue[];
}

function actionFingerprint(actions: readonly JsonValue[]): string {
  return `position_action_${canonicalJsonHash(actions)}`;
}

function transactionHash(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return /^0x[a-fA-F0-9]{64}$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function postconditionsFromChecks(
  checks: readonly PreparationFactCheck[],
): readonly JsonValue[] {
  return jsonValues(
    checks.flatMap((check) =>
      check.postcondition ? [check.postcondition] : [],
    ),
  );
}

function publicResult(operation: StoredPositionAction): PositionActionResult {
  const status =
    operation.status === "completed"
      ? "completed"
      : operation.status === "failed" || operation.status === "cancelled"
        ? "failed"
        : operation.status === "reconcile_required" ||
            operation.postconditionStatus === "failed" ||
            operation.postconditionStatus === "unavailable"
          ? "reconcile_required"
          : "in_progress";
  return {
    status,
    submissionFingerprint: operation.submissionFingerprint,
    reasonCodes:
      status === "reconcile_required" ? ["operation_reconcile_required"] : [],
  };
}

export class PositionActionRuntimeService {
  private readonly preparation: WalletPreparationRuntimeService;
  private readonly venueDrivers: PositionActionVenueRegistry;

  constructor(
    private readonly db: Pool,
    private readonly clock: () => Date = () => new Date(),
    venueDrivers: readonly PositionActionVenueDriver[] = [
      createPolymarketPositionActionVenueDriver(),
      createLimitlessPositionActionVenueDriver(),
    ],
  ) {
    this.preparation = new WalletPreparationRuntimeService(db, clock);
    this.venueDrivers = new PositionActionVenueRegistry(venueDrivers);
  }

  private venueDriver(venueId: string): PositionActionVenueDriver {
    if (!this.venueDrivers.has(venueId)) {
      throw new PositionActionRuntimeError(
        "unsupported_position_action",
        `owner-bound redemption is unavailable for venue ${venueId}`,
      );
    }
    return this.venueDrivers.require(venueId);
  }

  private async loadPosition(
    userId: string,
    positionRef: string,
  ): Promise<StoredPositionContext> {
    const { rows } = await this.db.query<{
      id: string;
      size_raw: string;
      token_id: string;
      venue: string;
      wallet_address: string | null;
    }>(
      `
        select
          id,
          size::text as size_raw,
          token_id,
          venue,
          wallet_address
        from positions
        where user_id = $1
          and id = $2
          and position_scope = 'own'
        limit 1
      `,
      [userId, positionRef],
    );
    const row = rows[0];
    if (!row || !row.wallet_address) {
      throw new PositionActionRuntimeError(
        "position_not_found",
        "owned position was not found",
      );
    }
    this.venueDriver(row.venue);
    return {
      id: row.id,
      sizeRaw: row.size_raw,
      tokenId: row.token_id,
      venueId: row.venue,
      walletAddress: ethers.getAddress(row.wallet_address),
    };
  }

  private async loadMarket(
    position: StoredPositionContext,
  ): Promise<RedemptionMarketContext> {
    const rows = await fetchMarketsByTokenIds(this.db, {
      tokenIds: [position.tokenId],
      venue: position.venueId,
      includeTop: false,
    });
    const exact = rows.filter(
      (row) =>
        row.venue === position.venueId && row.token_id === position.tokenId,
    );
    if (exact.length !== 1) {
      throw new PositionActionRuntimeError(
        "market_not_found",
        exact.length > 1
          ? "position token maps to multiple canonical markets"
          : "position token does not map to a canonical market",
      );
    }
    const exactMarket = exact[0];
    if (!exactMarket) {
      throw new PositionActionRuntimeError(
        "market_not_found",
        "canonical position market disappeared",
      );
    }
    const outcome = exactMarket.side?.toUpperCase();
    if (outcome !== "YES" && outcome !== "NO") {
      throw new PositionActionRuntimeError(
        "market_not_found",
        "position outcome could not be resolved to a canonical market side",
      );
    }
    return this.venueDriver(position.venueId).buildMarketContext(
      exactMarket,
      outcome,
    );
  }

  private async collectEvidence(
    userId: string,
    positionRef: string,
  ): Promise<CollectedRedemptionEvidence> {
    const position = await this.loadPosition(userId, positionRef);
    const driver = this.venueDriver(position.venueId);
    const market = await this.loadMarket(position);
    const ownerPreparation = await this.preparation.resolveOwnerPreparation({
      accountId: userId,
      venueId: position.venueId,
      ownerAddress: position.walletAddress,
      marketContextId: market.marketId,
      marketClass: market.marketClass,
    });
    const preparation = ownerPreparation.frozen.preparation;
    const plan = await driver.buildPlan({ market, position });
    const operatorApproved = await driver.inspectOperatorApproval({
      market,
      ownerAddress: position.walletAddress,
      plan,
      signerAddress: ownerPreparation.wallet.walletAddress,
      userId,
    });
    const executionProfile = driver.resolveExecutionProfile({
      executionMode: preparation.executionMode,
      ownerAddress: position.walletAddress,
      topology: preparation.topology,
    });
    const now = this.clock();
    return {
      driver,
      position,
      market,
      plan,
      executionAddress: ownerPreparation.wallet.walletAddress,
      executionMode: preparation.executionMode,
      evidence: {
        conditionalTokensAddress: driver.conditionalTokensAddress(),
        expiresAt: new Date(
          now.getTime() + POSITION_ACTION_TTL_MS,
        ).toISOString(),
        observedAt: now.toISOString(),
        operatorApproved,
        ownerBinding: preparation.binding,
        ownerMatchesBinding:
          normalizeAddress(preparation.binding.accountRef) ===
          normalizeAddress(position.walletAddress),
        plan,
        positionRef: position.id,
        topology: preparation.topology,
        topologySupported: executionProfile.topologySupported,
        unsupportedTopologyReason: executionProfile.unsupportedReason,
        externalHandoff: executionProfile.externalHandoff,
        venueId: position.venueId,
        walletInternal: ownerPreparation.wallet.isInternalWallet,
      },
    };
  }

  private executor(
    adapterId: string,
    collect: () => Promise<CollectedRedemptionEvidence>,
    capture?: (collected: CollectedRedemptionEvidence) => void,
  ): OwnerBoundPositionActionExecutor {
    return new OwnerBoundPositionActionExecutor(
      adapterId,
      REDEMPTION_POSITION_REQUIRED_CHECKS,
      async () => {
        const collected = await collect();
        capture?.(collected);
        return buildRedemptionPositionFacts(collected.evidence);
      },
      async (input) => ({
        status: "reconcile_required",
        submissionFingerprint: input.submissionFingerprint,
        reasonCodes: ["operation_reconcile_required"],
      }),
      this.clock,
    );
  }

  async inspect(
    userId: string,
    input: Omit<PositionActionInspectionInput, "accountId">,
  ): Promise<PositionActionReadiness> {
    if (input.action !== "redeem") {
      throw new PositionActionRuntimeError(
        "unsupported_position_action",
        "this runtime currently supports owner-bound redemption only",
      );
    }
    const driver = this.venueDriver(input.venueId);
    return this.executor(driver.adapterId, () =>
      this.collectEvidence(userId, input.positionRef),
    ).inspect({ ...input, accountId: userId });
  }

  async prepare(
    userId: string,
    input: Omit<PositionActionInspectionInput, "accountId"> &
      Readonly<{
        expectedInspectionRevision: string;
        idempotencyKey: string;
      }>,
  ): Promise<PreparedPositionAction> {
    if (input.action !== "redeem") {
      throw new PositionActionRuntimeError(
        "unsupported_position_action",
        "this runtime currently supports owner-bound redemption only",
      );
    }
    let captured: CollectedRedemptionEvidence | null = null;
    const driver = this.venueDriver(input.venueId);
    const correlationId = `position_action_${canonicalJsonHash({
      idempotencyKey: input.idempotencyKey,
      userId,
    }).slice(0, 32)}`;
    const executor = this.executor(
      driver.adapterId,
      () => this.collectEvidence(userId, input.positionRef),
      (collected) => {
        captured = collected;
      },
    );
    const actions = await executor.prepare({
      accountId: userId,
      action: input.action,
      actionOperationId: correlationId,
      venueId: input.venueId,
      positionRef: input.positionRef,
      ownerBindingId: input.ownerBindingId,
      expectedInspectionRevision: input.expectedInspectionRevision,
    });
    const collected = captured as CollectedRedemptionEvidence | null;
    if (!collected) {
      throw new PreparationContractError(
        "evidence_invalid",
        "position action evidence was not captured during preparation",
      );
    }
    const facts = buildRedemptionPositionFacts(collected.evidence);
    const digest = `position_action_${canonicalJsonHash({
      actions,
      bindingId: collected.evidence.ownerBinding.bindingId,
      plan: collected.plan,
      positionRef: collected.position.id,
    })}`;
    const created = await createOrReplayPositionAction(this.db, {
      userId,
      marketId: collected.market.marketId,
      venueId: collected.position.venueId,
      action: "redeem",
      positionRef: collected.position.id,
      ownerBindingId: collected.evidence.ownerBinding.bindingId,
      ownerAddress: collected.position.walletAddress,
      executionWalletId: collected.evidence.ownerBinding.executionWalletId,
      executionAddress: collected.executionAddress,
      executionMode: collected.executionMode,
      inspectionRevision: input.expectedInspectionRevision,
      actionDigest: digest,
      idempotencyKey: input.idempotencyKey,
      status:
        collected.executionMode === "privy_delegated"
          ? "prepared"
          : "awaiting_user",
      planSnapshot: jsonObject({
        plan: collected.plan,
        marketClass: collected.market.marketClass,
        marketId: collected.market.marketId,
        outcome: collected.market.outcome,
        tokenId: collected.position.tokenId,
      }),
      evidenceSnapshot: jsonObject({
        ...facts.evidence,
        ownerBinding: collected.evidence.ownerBinding,
      }),
      normalizedActions: jsonValues(actions),
      postconditions: postconditionsFromChecks(facts.checks),
    });
    return {
      actions,
      operation: created.operation,
      replayed: created.replayed,
    };
  }

  async operation(
    userId: string,
    operationId: string,
  ): Promise<StoredPositionAction | null> {
    return fetchPositionActionForUser(this.db, { userId, operationId });
  }

  async claimSubmission(
    userId: string,
    operationId: string,
  ): Promise<PositionActionSubmissionClaim> {
    const operation = await fetchPositionActionForUser(this.db, {
      userId,
      operationId,
    });
    if (!operation) {
      throw new PositionActionRuntimeError(
        "position_not_found",
        "position action operation was not found",
      );
    }
    return claimPositionActionSubmission(this.db, {
      userId,
      operationId,
      canonicalActionFingerprint: actionFingerprint(
        operation.normalizedActions,
      ),
      executorId: `position-action:${operation.executionMode}`,
    });
  }

  async reportSubmission(
    userId: string,
    input: Readonly<{
      attemptNumber: number;
      errorCode: string | null;
      operationId: string;
      outcome: "ambiguous" | "failed" | "not_broadcast" | "submitted";
      submissionFingerprint: string | null;
    }>,
  ): Promise<StoredPositionAction> {
    const txHash = transactionHash(input.submissionFingerprint);
    if (
      (input.outcome === "submitted" && !txHash) ||
      ((input.outcome === "failed" || input.outcome === "not_broadcast") &&
        input.submissionFingerprint != null)
    ) {
      throw new PositionActionRuntimeError(
        "invalid_submission",
        "position action submission report has an invalid transaction reference",
      );
    }
    return recordPositionActionSubmission(this.db, {
      userId,
      operationId: input.operationId,
      attemptNumber: input.attemptNumber,
      outcome: input.outcome,
      submissionFingerprint: txHash,
      errorCode: input.errorCode,
    });
  }

  private async finishEffects(
    operation: StoredPositionAction,
  ): Promise<StoredPositionAction> {
    let current = operation;
    if (current.status !== "completed" || !current.submissionFingerprint) {
      return current;
    }
    current = await completePositionActionEffect(this.db, {
      userId: current.userId,
      operationId: current.id,
      effectKind: "activity",
      evidence: {
        projection: "position_action_operations",
        transactionHash: current.submissionFingerprint,
      },
    });
    const plan = isRecord(current.planSnapshot.plan)
      ? current.planSnapshot.plan
      : null;
    const payoutRaw =
      typeof plan?.expectedPayoutRaw === "string"
        ? plan.expectedPayoutRaw
        : null;
    const notification = await createNotificationSafe(
      this.db,
      {
        ...buildRedemptionNotification({
          userId: current.userId,
          venue: current.venueId,
          amountUsd:
            payoutRaw && /^(0|[1-9][0-9]*)$/.test(payoutRaw)
              ? Number(payoutRaw) / 1_000_000
              : null,
          marketId: current.marketId,
          tokenId:
            typeof current.planSnapshot.tokenId === "string"
              ? current.planSnapshot.tokenId
              : null,
          txHash: current.submissionFingerprint,
          walletAddress: current.ownerAddress,
        }),
        replaceExisting: true,
      },
      undefined,
      { publish: false },
    );
    if (!notification) {
      return failPositionActionEffect(this.db, {
        userId: current.userId,
        operationId: current.id,
        effectKind: "notification",
        errorCode: "redemption_notification_failed",
      });
    }
    return completePositionActionEffect(this.db, {
      userId: current.userId,
      operationId: current.id,
      effectKind: "notification",
      evidence: {
        dedupeKey: `redemption:${current.submissionFingerprint}`,
      },
    });
  }

  async reconcile(
    userId: string,
    operationId: string,
  ): Promise<PositionActionResult> {
    let operation = await fetchPositionActionForUser(this.db, {
      userId,
      operationId,
    });
    if (!operation) {
      throw new PositionActionRuntimeError(
        "position_not_found",
        "position action operation was not found",
      );
    }
    if (operation.status === "completed") {
      operation = await this.finishEffects(operation);
      return publicResult(operation);
    }
    if (operation.status === "failed" || operation.status === "cancelled") {
      return publicResult(operation);
    }
    const txHash = transactionHash(operation.submissionFingerprint);
    if (!operation.broadcastMayHaveOccurred || !txHash) {
      return {
        status: operation.broadcastMayHaveOccurred
          ? "reconcile_required"
          : "in_progress",
        submissionFingerprint: operation.submissionFingerprint,
        reasonCodes: operation.broadcastMayHaveOccurred
          ? ["operation_reconcile_required"]
          : [],
      };
    }
    const driver = this.venueDriver(operation.venueId);
    const plan = isRecord(operation.planSnapshot.plan)
      ? (operation.planSnapshot.plan as RedemptionPlan)
      : null;
    if (!plan) {
      return {
        status: "reconcile_required",
        submissionFingerprint: operation.submissionFingerprint,
        reasonCodes: ["operation_reconcile_required"],
      };
    }
    const receipt = await driver.observeReceipt({
      ownerAddress: operation.ownerAddress,
      plan,
      transactionHash: txHash,
    });
    if (!receipt) return publicResult(operation);
    operation = await recordPositionActionReceipt(this.db, {
      userId,
      operationId,
      receipt: receipt.succeeded ? "success" : "reverted",
      receiptEvidence: receipt.evidence,
      errorCode: receipt.succeeded ? null : "position_action_reverted",
    });
    if (!receipt.succeeded) return publicResult(operation);
    const expected =
      receipt.expectedPayoutRaw &&
      /^(0|[1-9][0-9]*)$/.test(receipt.expectedPayoutRaw)
        ? BigInt(receipt.expectedPayoutRaw)
        : null;
    const actual =
      receipt.actualPayoutRaw &&
      /^(0|[1-9][0-9]*)$/.test(receipt.actualPayoutRaw)
        ? BigInt(receipt.actualPayoutRaw)
        : null;
    if (expected == null || actual == null || actual < expected) {
      operation = await recordPositionActionPostconditions(this.db, {
        userId,
        operationId,
        status: "unavailable",
        errorCode: "redemption_payout_unverified",
      });
      return publicResult(operation);
    }
    operation = await completePositionActionEffect(this.db, {
      userId,
      operationId,
      effectKind: "collateral_refresh",
      evidence: {
        actualPayoutRaw: actual.toString(),
        expectedPayoutRaw: expected.toString(),
        transactionHash: txHash,
      },
    });
    try {
      await driver.refreshPositions({
        db: this.db,
        userId,
        walletAddress: operation.ownerAddress,
      });
    } catch {
      operation = await failPositionActionEffect(this.db, {
        userId,
        operationId,
        effectKind: "position_refresh",
        errorCode: "redemption_position_refresh_failed",
      });
      operation = await recordPositionActionPostconditions(this.db, {
        userId,
        operationId,
        status: "unavailable",
        errorCode: "redemption_position_refresh_failed",
      });
      return publicResult(operation);
    }
    operation = await completePositionActionEffect(this.db, {
      userId,
      operationId,
      effectKind: "position_refresh",
      evidence: {
        positionRef: operation.positionRef,
        transactionHash: txHash,
      },
    });
    const refreshed = await this.loadPosition(userId, operation.positionRef);
    operation = await recordPositionActionPostconditions(this.db, {
      userId,
      operationId,
      status: ZERO_POSITION_RE.test(refreshed.sizeRaw)
        ? "satisfied"
        : "unavailable",
      errorCode: ZERO_POSITION_RE.test(refreshed.sizeRaw)
        ? null
        : "redemption_position_not_reconciled",
    });
    operation = await this.finishEffects(operation);
    return publicResult(operation);
  }
}
