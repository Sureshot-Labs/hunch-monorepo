import type { PoolClient } from "@hunch/infra";

import {
  allocateFundingObservationInTransaction,
  wakeFundingReconciliationInTransaction,
  type FundingObservationInsert,
  type FundingObservationRow,
} from "../persistence/funding-operation-repository.js";

export type FundingObservationDiscoverySource =
  | "webhook"
  | "polling"
  | "chain_rpc"
  | "venue_api";

/**
 * Every observation source uses this allocation-and-wake boundary. Discovery
 * source is support metadata only; it cannot change transfer identity,
 * canonicality, finality, or reducer behavior.
 */
export async function ingestFundingObservationInTransaction(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    discoverySource: FundingObservationDiscoverySource;
    observation: FundingObservationInsert;
    dueAt?: Date;
    priority?: number;
  }>,
): Promise<
  Readonly<{ observation: FundingObservationRow; replayed: boolean }>
> {
  const result = await allocateFundingObservationInTransaction(client, {
    ...input.observation,
    metadata: {
      ...(input.observation.metadata ?? {}),
      discoverySource: input.discoverySource,
    },
  });
  await wakeFundingReconciliationInTransaction(client, {
    operationId: input.observation.operationId,
    dueAt: input.dueAt,
    priority: input.priority,
  });
  return result;
}
