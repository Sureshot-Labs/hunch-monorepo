import type { PoolClient } from "@hunch/infra";

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
  const { rows } = await client.query<{ blocked: boolean }>(
    `
      select exists (
        select 1
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
          and operation.status not in (
            'completed',
            'refunded',
            'failed',
            'cancelled'
          )
      ) as blocked
    `,
    [input.userId, venueBindingOptionId],
  );
  if (rows[0]?.blocked) {
    throw new PolymarketFundingPredecessorUnresolvedError();
  }
}
