import type { PoolClient } from "@hunch/infra";

import { loadFundingLifecycleFactsForOperationInTransaction } from "../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "../lifecycle/funding-lifecycle-projector.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";

export class PolymarketFundingPredecessorUnresolvedError extends FundingPersistenceError {
  constructor() {
    super(
      "invalid_operation_state",
      "another Polymarket Funding Router operation is unresolved",
    );
    this.name = "PolymarketFundingPredecessorUnresolvedError";
  }
}

/** Serialize every Polymarket Router commit for one user and venue binding. */
export async function lockPolymarketFundingOperationPredecessor(
  client: PoolClient,
  input: Readonly<{ userId: string; venueBindingOptionId: string }>,
): Promise<void> {
  const venueBindingOptionId = input.venueBindingOptionId.trim();
  if (!venueBindingOptionId) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Polymarket funding route lacks its venue binding",
    );
  }
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `funding-router:${input.userId}:${venueBindingOptionId}`,
  ]);
  const { rows } = await client.query<{ operation_id: string }>(
    `
      select operation.id as operation_id
      from funding_operations operation
      where operation.user_id = $1
        and operation.support_metadata ->> 'preparationKind' =
              'polymarket_funding_router'
        and (
          coalesce(
            operation.support_metadata ->> 'venueBindingOptionId',
            operation.venue_binding_snapshot ->> 'venueBindingOptionId'
          ) = $2
          or coalesce(
            operation.support_metadata ->> 'venueBindingOptionId',
            operation.venue_binding_snapshot ->> 'venueBindingOptionId'
          ) is null
        )
      order by operation.created_at, operation.id
    `,
    [input.userId, venueBindingOptionId],
  );
  const now = new Date();
  for (const row of rows) {
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      client,
      { operationId: row.operation_id, now },
    );
    if (facts && !deriveFundingLifecycle(facts).safety.terminal) {
      throw new PolymarketFundingPredecessorUnresolvedError();
    }
  }
}
