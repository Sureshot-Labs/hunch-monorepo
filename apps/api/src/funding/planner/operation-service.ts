import type { Pool, PoolClient } from "@hunch/infra";

import type { FundingCommitRequest } from "../domain/types.js";
import {
  FundingPersistenceError,
  commitFundingOperation,
  fetchFundingQuoteForUser,
  type FundingCommitPlan,
  type FundingOperationRow,
  type FundingQuoteCommitScope,
  type StoredFundingQuote,
} from "../persistence/funding-operation-repository.js";

function sameFundingQuoteCommitScope(
  left: FundingQuoteCommitScope | null,
  right: FundingQuoteCommitScope | null,
): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "receive_receipt_review_v1") {
    return (
      right.kind === "receive_receipt_review_v1" &&
      left.ownerChannel === right.ownerChannel &&
      left.receiveSessionId === right.receiveSessionId &&
      left.receiptId === right.receiptId
    );
  }
  return (
    right.kind === "telegram_app_handoff_v2" &&
    left.handoffId === right.handoffId &&
    left.tradeIntentId === right.tradeIntentId
  );
}
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import {
  isWithdrawalPurpose,
  withdrawalBindingMatches,
} from "../domain/withdrawal-binding.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingPolicy,
  type FundingPolicyResolver,
} from "../policies/funding-policy-service.js";
import { FundingPlannerError } from "./money.js";

type FundingOperationCommitInput = Readonly<{
  userId: string;
  request: FundingCommitRequest;
  policy: FundingRuntimePolicy;
  policyRevision: string;
  ownershipRevision: string;
  commitScope?: FundingQuoteCommitScope;
}>;

export type PreparedFundingOperationCommit = Readonly<{
  input: FundingOperationCommitInput;
  quote: StoredFundingQuote;
  externalRecipientId: string | null;
  withdrawal: boolean;
}>;

export class FundingOperationService {
  constructor(
    private readonly dependencies: Readonly<{
      db: Pool;
      subjectLookupHmac: (userId: string) => string;
      subjectLookupKeyVersion: number;
      revalidateWithdrawalRecipient?: (
        db: Pick<Pool, "query">,
        input: Readonly<{ userId: string; recipientId: string }>,
      ) => Promise<void>;
      verifySourceCommit?: (
        client: PoolClient,
        input: Readonly<{
          userId: string;
          operation: FundingCommitPlan["operation"];
        }>,
      ) => Promise<void>;
      fetchQuote?: typeof fetchFundingQuoteForUser;
      commitOperation?: typeof commitFundingOperation;
      resolvePolicy?: FundingPolicyResolver;
      now?: () => Date;
    }>,
  ) {}

  async prepare(
    input: FundingOperationCommitInput,
  ): Promise<PreparedFundingOperationCommit> {
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
    const frozenScope = quote.commitScope;
    const requestedScope = input.commitScope ?? null;
    if (!sameFundingQuoteCommitScope(frozenScope, requestedScope)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "funding quote must be committed through its frozen owner boundary",
      );
    }
    const externalRecipientId =
      quote.planSnapshot.operation.externalRecipientId;
    const withdrawal = isWithdrawalPurpose(
      quote.planSnapshot.operation.purpose,
    );
    if (
      !withdrawal &&
      (input.policy.creationMode !== "on" || !input.policy.gates.commit)
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding operation commit is disabled",
      );
    }
    if (
      !withdrawalBindingMatches(
        quote.planSnapshot.operation.purpose,
        externalRecipientId,
      )
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "withdrawal purpose and external recipient binding differ",
      );
    }
    if (withdrawal && !this.dependencies.revalidateWithdrawalRecipient) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "withdrawal recipient revalidation is unavailable",
      );
    }
    if (
      !withdrawal &&
      (quote.policyVersion !== input.policy.contractVersion ||
        quote.policyRevision !== input.policyRevision)
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
    return { externalRecipientId, input, quote, withdrawal };
  }

  async commitPrepared(
    prepared: PreparedFundingOperationCommit,
    commitOperation = this.dependencies.commitOperation ??
      commitFundingOperation,
  ): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>> {
    const { externalRecipientId, input, quote, withdrawal } = prepared;
    return commitOperation(this.dependencies.db, {
      userId: input.userId,
      quoteId: input.request.quoteId,
      consentToken: input.request.consentToken,
      idempotencyKey: input.request.idempotencyKey,
      plan: quote.planSnapshot,
      subjectLookupHmac: this.dependencies.subjectLookupHmac(input.userId),
      subjectLookupKeyVersion: this.dependencies.subjectLookupKeyVersion,
      now: this.dependencies.now?.() ?? new Date(),
      verifyCurrentFacts: async (client, lockedQuote) => {
        if (!withdrawal) {
          await lockFundingPolicyForTransaction(client);
          const currentPolicy = await (
            this.dependencies.resolvePolicy ?? resolveFundingPolicy
          )(client);
          if (
            currentPolicy.runtime.creationMode !== "on" ||
            !currentPolicy.runtime.gates.commit ||
            currentPolicy.runtime.contractVersion !==
              lockedQuote.policyVersion ||
            currentPolicy.revision !== lockedQuote.policyRevision
          ) {
            throw new FundingPersistenceError(
              "quote_invalidated",
              "funding policy changed while committing the quote",
            );
          }
        }
        await this.dependencies.verifySourceCommit?.(client, {
          userId: input.userId,
          operation: lockedQuote.planSnapshot.operation,
        });
        if (withdrawal && externalRecipientId) {
          await this.dependencies.revalidateWithdrawalRecipient?.(client, {
            userId: input.userId,
            recipientId: externalRecipientId,
          });
        }
      },
    });
  }

  async commit(
    input: FundingOperationCommitInput,
  ): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>> {
    return this.commitPrepared(await this.prepare(input));
  }
}
