import { normalizedActionSchema } from "../domain/schemas.js";
import type { NormalizedAction } from "../domain/types.js";
import type { PreparedPositionAction } from "./runtime-service.js";
import type { StoredPositionAction } from "./position-action-repository.js";

export function preparedPositionActionFromStoredOperation(
  operation: StoredPositionAction,
): PreparedPositionAction {
  return {
    actions: normalizedActionSchema
      .array()
      .parse(operation.normalizedActions) as readonly NormalizedAction[],
    // The owner binding freezes the exact wallet ID used by every stored
    // action. Returning a newly discovered wallet beside stored action IDs
    // would break the authorization boundary on an idempotent replay.
    controllerWalletRef: operation.executionWalletId,
    operation,
    replayed: true,
  };
}
