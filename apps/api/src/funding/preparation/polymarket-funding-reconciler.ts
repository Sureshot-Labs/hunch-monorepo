import { tx, type Pool, type PoolClient } from "@hunch/infra";

import { isRecord } from "../../lib/type-guards.js";
import type { PolymarketFundingPlan } from "../../services/polymarket-funding-router.js";
import type {
  AssetRef,
  JsonValue,
  VenueAccountBinding,
} from "../domain/types.js";
import {
  allocateFundingObservationInTransaction,
  FundingPersistenceError,
} from "../persistence/funding-operation-repository.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  verifyPolymarketFundingPostconditions,
  type PolymarketFundingObservation,
} from "./polymarket-funding-followup.js";
import { observePolymarketFundingRuntime } from "./runtime-service.js";
import type { FundingPostconditionDriver } from "./postcondition-driver.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type PolymarketFundingPostconditionTarget = Readonly<{
  operationId: string;
  userId: string;
  stepId: string;
  attemptId: string;
  stepState: "submitted" | "succeeded";
  binding: VenueAccountBinding;
  plan: PolymarketFundingPlan;
  before: PolymarketFundingObservation;
  destinationAsset: AssetRef;
  signerAddress: string;
  receiptRefCiphertext: string;
  receiptRefLookupHmac: string;
  lookupKeyVersion: number;
  ledgerHeight: string | null;
  blockHash: string | null;
  finalizedAt: Date;
}>;

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      `Polymarket funding evidence lacks ${key}`,
    );
  }
  return value;
}

function nullableStringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  if (value === null) return null;
  return stringField(record, key);
}

function parseFundingPlan(value: unknown): PolymarketFundingPlan {
  if (!isRecord(value)) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Polymarket funding plan is not an object",
    );
  }
  return {
    depositWallet: stringField(value, "depositWallet"),
    routerAddress: stringField(value, "routerAddress"),
    routerNonce: stringField(value, "routerNonce"),
    requiredRaw: stringField(value, "requiredRaw"),
    depositAvailableRaw: stringField(value, "depositAvailableRaw"),
    depositUsdceAmountRaw: stringField(value, "depositUsdceAmountRaw"),
    totalAmountRaw: stringField(value, "totalAmountRaw"),
    pUsdAmountRaw: stringField(value, "pUsdAmountRaw"),
    signerUsdceAmountRaw: stringField(value, "signerUsdceAmountRaw"),
    usdceAmountRaw: stringField(value, "usdceAmountRaw"),
    calldata: stringField(value, "calldata"),
  };
}

function parseBefore(value: unknown): PolymarketFundingObservation {
  if (!isRecord(value)) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Polymarket funding pre-state is not an object",
    );
  }
  return {
    routerNonceRaw: nullableStringField(value, "routerNonceRaw"),
    depositPusdRaw: nullableStringField(value, "depositPusdRaw"),
    clobPusdRaw: nullableStringField(value, "clobPusdRaw"),
    observedAt: stringField(value, "observedAt"),
  };
}

function parseAsset(value: unknown): AssetRef {
  if (
    !isRecord(value) ||
    typeof value.networkId !== "string" ||
    typeof value.assetId !== "string" ||
    typeof value.decimals !== "number"
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Polymarket funding destination asset is invalid",
    );
  }
  return {
    networkId: value.networkId,
    assetId: value.assetId,
    decimals: value.decimals,
  };
}

function parseBinding(value: unknown): VenueAccountBinding {
  if (
    !isRecord(value) ||
    !isRecord(value.settlementLocation) ||
    !isRecord(value.settlementLocation.asset) ||
    !isRecord(value.settlementLocation.details)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Polymarket funding venue binding is invalid",
    );
  }
  const signingMode = stringField(value, "signingMode");
  if (
    signingMode !== "web_client" &&
    signingMode !== "privy_authorization" &&
    signingMode !== "privy_delegated"
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Polymarket funding venue signing mode is invalid",
    );
  }
  return {
    bindingId: stringField(value, "bindingId"),
    venueId: stringField(value, "venueId"),
    controllerWalletId: stringField(value, "controllerWalletId"),
    executionWalletId: stringField(value, "executionWalletId"),
    accountRef: stringField(value, "accountRef"),
    settlementLocation: {
      kind: stringField(value.settlementLocation, "kind"),
      locationId: stringField(value.settlementLocation, "locationId"),
      accountId: stringField(value.settlementLocation, "accountId"),
      asset: parseAsset(value.settlementLocation.asset),
      details: value.settlementLocation.details as JsonRecord,
    },
    signingMode,
  };
}

async function loadTarget(
  db: Pick<Pool, "query">,
  operationId: string,
): Promise<PolymarketFundingPostconditionTarget | null> {
  const { rows } = await db.query<{
    operation_id: string;
    user_id: string;
    step_id: string;
    attempt_id: string;
    step_state: PolymarketFundingPostconditionTarget["stepState"];
    venue_binding_snapshot: JsonRecord;
    requested_destination_amount: JsonRecord;
    support_metadata: JsonRecord;
    action_validation_result: JsonRecord;
    receipt_ref_ciphertext: string;
    receipt_ref_lookup_hmac: string;
    lookup_key_version: number;
    ledger_height: string | null;
    block_hash: string | null;
    finalized_at: Date;
  }>(
    `
      select
        operation.id as operation_id,
        operation.user_id,
        step.id as step_id,
        attempt.id as attempt_id,
        step.state as step_state,
        operation.venue_binding_snapshot,
        operation.requested_destination_amount,
        operation.support_metadata,
        step.action_validation_result,
        attempt.receipt_ref_ciphertext,
        attempt.receipt_ref_lookup_hmac,
        attempt.lookup_key_version,
        receipt.ledger_height,
        receipt.block_hash,
        receipt.finalized_at
      from funding_operations operation
      join funding_operation_steps step
        on step.operation_id = operation.id
       and step.step_kind = 'venue_preparation'
      join funding_operation_step_attempts attempt
        on attempt.step_id = step.id
       and attempt.outcome in ('submitted', 'ambiguous')
       and attempt.broadcast_may_have_occurred
      join funding_step_receipt_observations receipt
        on receipt.attempt_id = attempt.id
       and receipt.status = 'finalized'
       and receipt.action_match
       and receipt.canonical
       and receipt.finalized_at is not null
      where operation.id = $1
        and operation.plan_kind = 'venue_preparation'
        and operation.support_metadata->>'preparationKind'
          = 'polymarket_funding_router'
        and operation.status not in (
          'completed',
          'refunded',
          'failed',
          'cancelled'
        )
        and step.state in ('submitted', 'succeeded')
        and not exists (
          select 1
          from funding_observations observation
          where observation.operation_id = operation.id
            and observation.kind = 'venue_readiness'
            and observation.canonical
            and observation.finality_status = 'finalized'
        )
      order by attempt.attempt_number desc
      limit 1
    `,
    [operationId],
  );
  const row = rows[0];
  if (!row) return null;
  const metadata = row.support_metadata;
  const requested = row.requested_destination_amount;
  return {
    operationId: row.operation_id,
    userId: row.user_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    stepState: row.step_state,
    binding: parseBinding(row.venue_binding_snapshot),
    plan: parseFundingPlan(metadata.fundingPlan),
    before: parseBefore(metadata.before),
    destinationAsset: parseAsset(requested.asset),
    signerAddress: stringField(row.action_validation_result, "signerAddress"),
    receiptRefCiphertext: row.receipt_ref_ciphertext,
    receiptRefLookupHmac: row.receipt_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
    ledgerHeight: row.ledger_height,
    blockHash: row.block_hash,
    finalizedAt: row.finalized_at,
  };
}

async function persistSatisfiedPostcondition(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    target: PolymarketFundingPostconditionTarget;
    transactionHash: string;
    after: PolymarketFundingObservation;
    expectedDepositPusdRaw: string;
    checks: Readonly<Record<string, boolean>>;
    now: Date;
  }>,
): Promise<void> {
  await allocateFundingObservationInTransaction(client, {
    operationId: input.target.operationId,
    segmentId: null,
    kind: "venue_readiness",
    networkId: input.target.destinationAsset.networkId,
    assetId: input.target.destinationAsset.assetId,
    txHash: input.transactionHash,
    eventIndex: "venue-readiness",
    fromAddress: input.target.signerAddress,
    toAddress: input.target.plan.depositWallet,
    rawAmount: input.target.plan.totalAmountRaw,
    observedAt: new Date(input.after.observedAt),
    ledgerHeight: input.target.ledgerHeight,
    blockHash: input.target.blockHash,
    finalityStatus: "finalized",
    finalizedAt: input.target.finalizedAt,
    metadata: {
      receiptAttemptId: input.target.attemptId,
      expectedDepositPusdRaw: input.expectedDepositPusdRaw,
      routerNonceBefore: input.target.before.routerNonceRaw,
      routerNonceAfter: input.after.routerNonceRaw,
      depositPusdAfter: input.after.depositPusdRaw,
      clobPusdAfter: input.after.clobPusdRaw,
      checks: input.checks,
    },
  });
  if (input.target.stepState !== "succeeded") {
    const updated = await client.query(
      `
        update funding_operation_steps
        set state = 'succeeded',
            updated_at = $3
        where operation_id = $1
          and id = $2
          and state = 'submitted'
      `,
      [input.target.operationId, input.target.stepId, input.now],
    );
    if (updated.rowCount !== 1) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "Polymarket preparation step changed before postcondition commit",
      );
    }
  }
}

export class PolymarketFundingPostconditionDriver implements FundingPostconditionDriver {
  readonly driverId = "polymarket_funding_router_postcondition_v1";

  constructor(
    private readonly codec: Pick<
      FundingTransactionReferenceCodec,
      "decrypt" | "fingerprint" | "keyVersion"
    >,
    private readonly dependencies: Readonly<{
      loadTarget?: typeof loadTarget;
      observe?: typeof observePolymarketFundingRuntime;
      persistSatisfied?: (
        pool: Pool,
        input: Readonly<{
          target: PolymarketFundingPostconditionTarget;
          transactionHash: string;
          after: PolymarketFundingObservation;
          expectedDepositPusdRaw: string;
          checks: Readonly<Record<string, boolean>>;
          now: Date;
        }>,
      ) => Promise<void>;
    }> = {},
  ) {}

  async pollOperation(
    pool: Pool,
    operationId: string,
    now = new Date(),
  ): Promise<Readonly<{ postconditionsPolled: number }>> {
    const target = await (this.dependencies.loadTarget ?? loadTarget)(
      pool,
      operationId,
    );
    if (!target) return { postconditionsPolled: 0 };
    if (target.lookupKeyVersion !== this.codec.keyVersion) {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Polymarket receipt key version is unavailable",
      );
    }
    const transactionHash = this.codec.decrypt(target.receiptRefCiphertext);
    if (
      this.codec.fingerprint(transactionHash) !== target.receiptRefLookupHmac
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Polymarket receipt reference integrity check failed",
      );
    }
    const after = await (
      this.dependencies.observe ?? observePolymarketFundingRuntime
    )({
      userId: target.userId,
      signerAddress: target.signerAddress,
      depositWallet: target.plan.depositWallet,
    });
    const result = verifyPolymarketFundingPostconditions({
      after,
      before: target.before,
      binding: target.binding,
      canonicalRouterAddress: target.plan.routerAddress,
      plan: target.plan,
      receipt: "success",
    });
    if (
      result.status === "satisfied" &&
      result.expectedDepositPusdRaw &&
      after
    ) {
      const satisfiedInput = {
        target,
        transactionHash,
        after,
        expectedDepositPusdRaw: result.expectedDepositPusdRaw,
        checks: result.checks,
        now,
      };
      if (this.dependencies.persistSatisfied) {
        await this.dependencies.persistSatisfied(pool, satisfiedInput);
      } else {
        await tx(pool, (client) =>
          persistSatisfiedPostcondition(client, satisfiedInput),
        );
      }
    }
    return { postconditionsPolled: 1 };
  }
}
