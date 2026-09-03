import { tx, type Pool } from "@hunch/infra";

import {
  fetchFundingOperationForUser,
  FundingPersistenceError,
  type FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import {
  projectedFundingLifecycleInTransaction,
  recordFundingOperationCancellationDecisionInTransaction,
  recordSafeFundingActionCancellationsInTransaction,
  releaseFundingReservationForAbandonedTradeInTransaction,
} from "../persistence/funding-evidence-repository.js";
import { reduceFundingOperationInTransaction } from "./funding-reducer.js";

export function isSafelyCancellableStepLessIngress(
  input: Readonly<{
    operation: Pick<
      FundingOperationRow,
      "planKind"
    >;
    stepCount: number;
    lifecycle: Readonly<{
      status: "awaiting_external_funds" | string;
      safety: Readonly<{ cancelAllowed: boolean }>;
    }>;
  }>,
): boolean {
  return (
    input.stepCount === 0 &&
    input.operation.planKind === "direct_external_handoff" &&
    input.lifecycle.status === "awaiting_external_funds" &&
    input.lifecycle.safety.cancelAllowed
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

async function releaseCancelledTelegramHandoffInTransaction(input: {
  client: Parameters<typeof reduceFundingOperationInTransaction>[0];
  now: Date;
  operationId: string;
  userId: string;
}): Promise<void> {
  await input.client.query(
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
    [input.operationId, input.now],
  );
  await cancelLinkedTelegramV2HandoffIntentInTransaction(input);
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
    const candidate = await fetchFundingOperationForUser(client, input);
    if (!candidate) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding operation was not found for authenticated user",
      );
    }
    // The unlocked owner-scoped read resolves the cancellation target. Lock
    // linked intents first to match the sealed handoff claim, then lock and
    // revalidate the operation before touching steps or reservations.
    await client.query(
      `select intent.id
         from telegram_trade_intents intent
        where intent.user_id = $1
          and intent.funding_operation_id = $2
        order by intent.id
        for update`,
      [input.userId, input.operationId],
    );
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
    const lifecycle = await projectedFundingLifecycleInTransaction(client, {
      operationId: input.operationId,
      now,
    });
    // Materialize the facts before returning a terminal/ready compatibility
    // response.  Stored operation status is intentionally never the branch
    // selector here.
    if (lifecycle.safety.terminal) {
      await reduceFundingOperationInTransaction(client, {
        operationId: input.operationId,
        now,
      });
      const terminal = await fetchFundingOperationForUser(client, input);
      if (!terminal) {
        throw new FundingPersistenceError(
          "operation_not_found",
          "funding operation disappeared after terminal lifecycle reduction",
        );
      }
      if (terminal.status === "cancelled") {
        await releaseCancelledTelegramHandoffInTransaction({
          client,
          now,
          operationId: input.operationId,
          userId: input.userId,
        });
      }
      return terminal;
    }

    if (
      lifecycle.status === "ready" &&
      lifecycle.progressStage === "ready_for_consumer"
    ) {
      await reduceFundingOperationInTransaction(client, {
        operationId: input.operationId,
        now,
      });
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

    if (!lifecycle.safety.cancelAllowed) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding operation may have external effects and must reconcile before cancellation",
      );
    }
    const cancellationFacts =
      await recordSafeFundingActionCancellationsInTransaction(client, {
        operationId: input.operationId,
        now,
      });
    if (cancellationFacts.unsafeStepIds.length > 0) {
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding action changed while recording cancellation",
      );
    }
    if (cancellationFacts.cancelledStepIds.length === 0) {
      if (
        !isSafelyCancellableStepLessIngress({
          operation,
          stepCount: lifecycle.actions.length,
          lifecycle,
        })
      ) {
        throw new FundingPersistenceError(
          "invalid_state_transition",
          "funding operation has no safely cancellable action",
        );
      }
      await recordFundingOperationCancellationDecisionInTransaction(client, {
        operationId: operation.id,
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
      await releaseCancelledTelegramHandoffInTransaction({
        client,
        now,
        operationId: input.operationId,
        userId: input.userId,
      });
    }
    return cancelled;
  });
}
