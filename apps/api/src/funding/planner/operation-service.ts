import type { Pool } from "@hunch/infra";

import type { FundingCommitRequest } from "../domain/types.js";
import {
  FundingPersistenceError,
  commitFundingOperation,
  fetchFundingQuoteForUser,
  type FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import { resolveFundingPolicy } from "../policies/funding-policy-service.js";
import { FundingPlannerError } from "./money.js";

export class FundingOperationService {
  constructor(
    private readonly dependencies: Readonly<{
      db: Pool;
      subjectLookupHmac: (userId: string) => string;
      subjectLookupKeyVersion: number;
      resolveOwnershipRevision: (userId: string) => Promise<string>;
      revalidateWithdrawalRecipient?: (
        db: Pick<Pool, "query">,
        input: Readonly<{ userId: string; recipientId: string }>,
      ) => Promise<void>;
      fetchQuote?: typeof fetchFundingQuoteForUser;
      commitOperation?: typeof commitFundingOperation;
      resolvePolicy?: typeof resolveFundingPolicy;
      now?: () => Date;
    }>,
  ) {}

  async commit(
    input: Readonly<{
      userId: string;
      request: FundingCommitRequest;
      policy: FundingRuntimePolicy;
      policyRevision: string;
      ownershipRevision: string;
    }>,
  ): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>> {
    if (input.policy.creationMode !== "on" || !input.policy.gates.commit) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding operation commit is disabled",
      );
    }
    const quote = await (
      this.dependencies.fetchQuote ?? fetchFundingQuoteForUser
    )(this.dependencies.db, {
      userId: input.userId,
      quoteId: input.request.quoteId,
    });
    if (!quote) {
      throw new FundingPersistenceError(
        "quote_not_found",
        "funding quote was not found for authenticated user",
      );
    }
    const withdrawal = quote.planSnapshot.operation.purpose === "withdrawal";
    const externalRecipientId =
      quote.planSnapshot.operation.externalRecipientId;
    if (withdrawal !== Boolean(externalRecipientId)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "withdrawal purpose and external recipient binding differ",
      );
    }
    if (
      withdrawal &&
      (!input.policy.gates.withdrawalExecution ||
        !this.dependencies.revalidateWithdrawalRecipient)
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "withdrawal execution is disabled or lacks recipient revalidation",
      );
    }
    if (
      quote.policyVersion !== input.policy.version ||
      quote.policyRevision !== input.policyRevision
    ) {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "funding policy changed before commit",
      );
    }
    if (
      quote.planSnapshot.operation.supportMetadata?.ownershipRevision !==
      input.ownershipRevision
    ) {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "wallet ownership facts changed before commit",
      );
    }
    return (this.dependencies.commitOperation ?? commitFundingOperation)(
      this.dependencies.db,
      {
        userId: input.userId,
        quoteId: input.request.quoteId,
        consentToken: input.request.consentToken,
        idempotencyKey: input.request.idempotencyKey,
        plan: quote.planSnapshot,
        subjectLookupHmac: this.dependencies.subjectLookupHmac(input.userId),
        subjectLookupKeyVersion: this.dependencies.subjectLookupKeyVersion,
        now: this.dependencies.now?.() ?? new Date(),
        verifyCurrentFacts: async (client, lockedQuote) => {
          const currentPolicy = await (
            this.dependencies.resolvePolicy ?? resolveFundingPolicy
          )(client);
          if (
            currentPolicy.policy.creationMode !== "on" ||
            !currentPolicy.policy.gates.commit ||
            (withdrawal && !currentPolicy.policy.gates.withdrawalExecution) ||
            currentPolicy.policy.version !== lockedQuote.policyVersion ||
            currentPolicy.revision !== lockedQuote.policyRevision
          ) {
            throw new FundingPersistenceError(
              "quote_invalidated",
              "funding policy changed while committing the quote",
            );
          }
          const currentOwnershipRevision =
            await this.dependencies.resolveOwnershipRevision(input.userId);
          if (currentOwnershipRevision !== input.ownershipRevision) {
            throw new FundingPersistenceError(
              "quote_invalidated",
              "wallet ownership facts changed while committing the quote",
            );
          }
          if (withdrawal && externalRecipientId) {
            await this.dependencies.revalidateWithdrawalRecipient?.(client, {
              userId: input.userId,
              recipientId: externalRecipientId,
            });
          }
        },
      },
    );
  }
}
