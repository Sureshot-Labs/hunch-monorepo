import type {
  ActionValidationContext,
  ActionValidator,
  ValidatedNormalizedAction,
} from "../../funding/domain/contracts.js";
import type { NormalizedAction } from "../../funding/domain/types.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../../funding/persistence/canonical.js";

export const RELAY_ACTION_VALIDATION_REVISION =
  "relay_normalized_action_exact_v1";

/**
 * Quote parsing validates provider calldata/instructions. This second,
 * provider-neutral boundary verifies that the action presented for execution
 * is byte-for-byte the immutable action that was committed.
 */
export class RelayPinnedActionValidator implements ActionValidator {
  readonly validatorId: string;

  constructor(readonly expectedAction: NormalizedAction) {
    if (expectedAction.kind === "signature") {
      throw new Error("Relay signature and authorization actions are disabled");
    }
    this.validatorId =
      expectedAction.kind === "evm_transaction"
        ? "relay_evm_action_v1"
        : "relay_svm_action_v1";
  }

  async validate(
    action: NormalizedAction,
    context: ActionValidationContext,
  ): Promise<ValidatedNormalizedAction> {
    if (action.kind === "signature") {
      throw new Error("Relay signature and authorization actions are disabled");
    }
    if (!canonicalJsonEqual(action, this.expectedAction)) {
      throw new Error("Relay action does not match immutable committed action");
    }
    if (action.networkId !== context.expectedNetworkId) {
      throw new Error("Relay action network does not match committed route");
    }
    const signerWalletId =
      action.kind === "evm_transaction"
        ? action.senderWalletId
        : action.signerWalletId;
    if (signerWalletId !== context.expectedSignerWalletId) {
      throw new Error("Relay action signer does not match committed route");
    }
    if (context.sourceAmount.raw === "0" || context.minimumOutput.raw === "0") {
      throw new Error("Relay committed amounts must be positive");
    }
    return {
      action,
      validatorId: this.validatorId,
      validationRevision: `${RELAY_ACTION_VALIDATION_REVISION}:${canonicalJsonHash(
        this.expectedAction,
      )}`,
      validatedAt: new Date().toISOString(),
    };
  }
}
