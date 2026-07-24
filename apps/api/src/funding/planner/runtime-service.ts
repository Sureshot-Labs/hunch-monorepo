import type { Pool } from "@hunch/infra";

import { buildAccountValueReadModel } from "../../account-value/runtime-service.js";
import { lookupHmac } from "../persistence/canonical.js";
import {
  fetchFundingOperationForUser,
  listFundingOperationsForUser,
} from "../persistence/funding-operation-repository.js";
import { PostgresFundingPlanningStore } from "../persistence/funding-planning-repository.js";
import { resolveFundingPolicy } from "../policies/funding-policy-service.js";
import type {
  FundingCommitRequest,
  FundingDestinationOption,
  FundingDiscoveryRequest,
  FundingQuoteRequest,
} from "../domain/types.js";
import { FundingPlanner } from "./planner.js";
import { FundingQuoteService } from "./quote-service.js";
import { FundingOperationService } from "./operation-service.js";
import { FundingPlannerError } from "./money.js";

const SUBJECT_FINGERPRINT_DOMAIN = "hunch:funding:subject:v1:";

function positiveInt(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class FundingPlanningRuntime {
  private readonly planningStore: PostgresFundingPlanningStore;

  constructor(private readonly db: Pool) {
    this.planningStore = new PostgresFundingPlanningStore(db);
  }

  /**
   * WP5 exposes the fail-closed boundary. WP6 will install its side-effect-free
   * PM/Limitless inspection adapters here; until then production returns no
   * invented destination or readiness fact.
   */
  async destinations(): Promise<readonly FundingDestinationOption[]> {
    return [];
  }

  async liquidity(userId: string, request: FundingDiscoveryRequest) {
    const [resolvedPolicy, account] = await Promise.all([
      resolveFundingPolicy(this.db),
      buildAccountValueReadModel({ pool: this.db, userId }),
    ]);
    const planner = new FundingPlanner({
      listDestinations: async () => [],
      resolveMarketContext: async () => null,
      listSources: async () => [],
      store: this.planningStore,
    });
    return planner.discover({
      accountId: userId,
      request,
      policy: resolvedPolicy.policy,
      policyRevision: resolvedPolicy.revision,
      ownershipRevision: account.ownershipEvidenceRevision,
    });
  }

  async quote(userId: string, request: FundingQuoteRequest) {
    const [resolvedPolicy, account] = await Promise.all([
      resolveFundingPolicy(this.db),
      buildAccountValueReadModel({ pool: this.db, userId }),
    ]);
    return new FundingQuoteService({
      db: this.db,
      planningStore: this.planningStore,
    }).quote({
      userId,
      request,
      policy: resolvedPolicy.policy,
      policyRevision: resolvedPolicy.revision,
      ownershipRevision: account.ownershipEvidenceRevision,
    });
  }

  async commit(userId: string, request: FundingCommitRequest) {
    const [resolvedPolicy, account] = await Promise.all([
      resolveFundingPolicy(this.db),
      buildAccountValueReadModel({ pool: this.db, userId }),
    ]);
    const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
    const keyVersion =
      positiveInt(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ?? 1;
    if (!lookupKey) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding subject fingerprint key is not configured",
      );
    }
    return new FundingOperationService({
      db: this.db,
      subjectLookupHmac: (subjectUserId) =>
        lookupHmac(`${SUBJECT_FINGERPRINT_DOMAIN}${subjectUserId}`, lookupKey),
      subjectLookupKeyVersion: keyVersion,
      resolveOwnershipRevision: async (subjectUserId) =>
        (
          await buildAccountValueReadModel({
            pool: this.db,
            userId: subjectUserId,
          })
        ).ownershipEvidenceRevision,
    }).commit({
      userId,
      request,
      policy: resolvedPolicy.policy,
      policyRevision: resolvedPolicy.revision,
      ownershipRevision: account.ownershipEvidenceRevision,
    });
  }

  operation(userId: string, operationId: string) {
    return fetchFundingOperationForUser(this.db, { userId, operationId });
  }

  operations(
    userId: string,
    input: Readonly<{ limit: number; before: Date | null }>,
  ) {
    return listFundingOperationsForUser(this.db, {
      userId,
      limit: input.limit,
      beforeCreatedAt: input.before,
    });
  }
}
