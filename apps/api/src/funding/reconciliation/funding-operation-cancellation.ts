import { tx, type Pool } from "@hunch/infra";

import {
  fetchFundingOperationForUser,
  FundingPersistenceError,
  transitionFundingOperationInTransaction,
  type FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import { releaseFundingReservationForAbandonedTradeInTransaction } from "../persistence/funding-evidence-repository.js";
import { reduceFundingOperationInTransaction } from "./funding-reducer.js";

export function isSafelyCancellableStepLessIngress(
  input: Readonly<{
    operation: Pick<
      FundingOperationRow,
      "planKind" | "progressStage" | "status"
    >;
    stepCount: number;
    hasUnsafeExternalEffects: boolean;
  }>,
): boolean {
  return (
    !input.hasUnsafeExternalEffects &&
    input.stepCount === 0 &&
    input.operation.planKind === "direct_external_handoff" &&
    input.operation.status === "awaiting_external_funds" &&
    input.operation.progressStage === "source_action"
  );
}

/**
 * A v2 handoff owns the original Telegram Buy intent even though the generic
 * operation is executed by the Mini App. Once cancellation is proven safe at
 * the operation boundary, close that Buy in the same transaction so `/execute`
 * can never resurrect client actions for a cancelled intent.
 */
async function cancelLinkedTelegramV2HandoffIntentInTransaction(input: {
  client: Parameters<typeof reduceFundingOperationInTransaction>[0];
  now: Date;
  operationId: string;
  userId: string;
}): Promise<void> {
  await input.client.query(
    `update telegram_trade_intents intent
        set status = 'cancelled',
            error_code = 'funding_cancelled',
            error_message = 'Funding was cancelled before money moved. The Buy was cancelled.',
            result = coalesce(intent.result, '{}'::jsonb)
              || jsonb_build_object(
                'appHandoffFundingCancellation',
                jsonb_build_object(
                  'operationId', $1::uuid,
                  'cancelledAt', $3::timestamptz,
                  'version', 2
                )
              ),
            updated_at = $3::timestamptz
      where intent.user_id = $2::uuid
        and intent.funding_operation_id = $1::uuid
        and intent.status = 'funding'
        and intent.delivery_mode = 'app_handoff'
        and intent.result->'appHandoffExecution'->>'version' = '2'`,
    [input.operationId, input.userId, input.now],
  );
}

export async function cancelFundingOperationForUser(
  pool: Pool,
  input: Readonly<{
    userId: string;
    operationId: string;
    now?: Date;
  }>,
): Promise<FundingOperationRow> {
  return tx(pool, async (client) => {
    await client.query(
      `
        select id
        from funding_operations
        where id = $1 and user_id = $2
        for update
      `,
      [input.operationId, input.userId],
    );
    const operation = await fetchFundingOperationForUser(client, input);
    if (!operation) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding operation was not found for authenticated user",
      );
    }
    const now = input.now ?? new Date();
    if (
      operation.status === "completed" ||
      operation.status === "refunded" ||
      operation.status === "failed" ||
      operation.status === "cancelled"
    ) {
      return operation;
    }

    if (
      operation.status === "ready" &&
      operation.progressStage === "ready_for_consumer"
    ) {
      const reservationResult = await client.query<{ id: string }>(
        `
          select id
          from balance_reservations
          where user_id = $1
            and operation_id = $2
            and mode = 'settled_for_consumer'
            and state = 'active'
          order by id
          for update
        `,
        [input.userId, input.operationId],
      );
      if (reservationResult.rows.length !== 1) {
        throw new FundingPersistenceError(
          "invalid_state_transition",
          "ready funding operation does not have one releasable consumer reservation",
        );
      }
      const reservation = reservationResult.rows[0];
      if (!reservation) {
        throw new FundingPersistenceError(
          "invalid_state_transition",
          "ready funding reservation disappeared",
        );
      }
      await releaseFundingReservationForAbandonedTradeInTransaction(client, {
        userId: input.userId,
        link: {
          operationId: input.operationId,
          reservationId: reservation.id,
        },
        outcomeReason: "trade_abandoned",
        now,
      });
      const released = await fetchFundingOperationForUser(client, input);
      if (!released) {
        throw new FundingPersistenceError(
          "operation_not_found",
          "funding operation disappeared after reservation release",
        );
      }
      await cancelLinkedTelegramV2HandoffIntentInTransaction({
        client,
        now,
        operationId: input.operationId,
        userId: input.userId,
      });
      return released;
    }

    const steps = await client.query<{ id: string }>(
      `
        select id
        from funding_operation_steps
        where operation_id = $1
        order by ordinal
        for update
      `,
      [input.operationId],
    );
    const unsafe = await client.query<{ unsafe: boolean }>(
      `
        select exists (
          select 1
          from funding_operation_steps step
          left join funding_operation_step_attempts attempt
            on attempt.step_id = step.id
          where step.operation_id = $1
            and (
              step.state not in ('planned', 'action_required')
              or attempt.id is not null
            )
        ) or exists (
          select 1
          from funding_observations observation
          where observation.operation_id = $1
        ) as unsafe
      `,
      [input.operationId],
    );
    const hasUnsafeExternalEffects = unsafe.rows[0]?.unsafe === true;
    if (hasUnsafeExternalEffects) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding operation may have external effects and must reconcile before cancellation",
      );
    }
    const cancelledSteps = await client.query(
      `
        update funding_operation_steps
        set state = 'cancelled',
            updated_at = $2
        where operation_id = $1
          and state in ('planned', 'action_required')
      `,
      [input.operationId, now],
    );
    if ((cancelledSteps.rowCount ?? 0) === 0) {
      if (
        !isSafelyCancellableStepLessIngress({
          operation,
          stepCount: steps.rowCount ?? 0,
          hasUnsafeExternalEffects,
        })
      ) {
        throw new FundingPersistenceError(
          "invalid_state_transition",
          "funding operation has no safely cancellable action",
        );
      }
      await transitionFundingOperationInTransaction(client, {
        operationId: operation.id,
        scope: { kind: "user", userId: input.userId },
        expectedVersion: operation.version,
        expectedState: {
          status: operation.status,
          stage: operation.progressStage,
        },
        nextState: { status: "cancelled", stage: "terminal" },
        now,
      });
    }
    await reduceFundingOperationInTransaction(client, {
      operationId: input.operationId,
      now,
    });
    const cancelled = await fetchFundingOperationForUser(client, input);
    if (!cancelled) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding operation disappeared after cancellation",
      );
    }
    if (cancelled.status === "cancelled") {
      await client.query(
        `update telegram_funding_authorization_reservations
            set status = 'released',
                resolved_at = $2,
                resolution_evidence = resolution_evidence || jsonb_build_object(
                  'operationStatus', 'cancelled',
                  'operationId', $1::text,
                  'reason', 'cancelled_before_broadcast'
                ),
                updated_at = $2
          where funding_operation_id = $1::uuid
            and status = 'reserved'`,
        [input.operationId, now],
      );
      await cancelLinkedTelegramV2HandoffIntentInTransaction({
        client,
        now,
        operationId: input.operationId,
        userId: input.userId,
      });
    }
    return cancelled;
  });
}
