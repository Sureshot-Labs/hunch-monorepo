import { tx, type Pool } from "@hunch/infra";

import {
  fetchFundingOperationForUser,
  FundingPersistenceError,
  type FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import { releaseFundingReservationForAbandonedTradeInTransaction } from "../persistence/funding-evidence-repository.js";
import { reduceFundingOperationInTransaction } from "./funding-reducer.js";

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
      return released;
    }

    await client.query(
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
    if (unsafe.rows[0]?.unsafe) {
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
      throw new FundingPersistenceError(
        "invalid_state_transition",
        "funding operation has no safely cancellable action",
      );
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
    return cancelled;
  });
}
