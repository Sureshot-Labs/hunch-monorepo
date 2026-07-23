import type { DbQuery } from "../../db.js";
import {
  fetchActiveRuntimePolicy,
  insertRuntimePolicy,
} from "../../repos/runtime-policies.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  FUNDING_POLICY_KEY,
  PRODUCTION_FUNDING_REGISTRY,
  diffFundingPolicies,
  fundingPolicyPublishConfirmation,
  fundingPolicyRevision,
  validateFundingRuntimePolicy,
  type FundingPolicyDiffEntry,
  type FundingPolicyValidationIssue,
  type FundingRuntimePolicy,
  type FundingStaticRegistry,
} from "./funding-policy.js";

export type ResolvedFundingPolicy = Readonly<{
  source: "default" | "db";
  policy: FundingRuntimePolicy;
  revision: string;
  effectiveAt: Date | null;
  createdAt: Date | null;
  createdBy: string | null;
  invalidStoredPolicy: boolean;
  validationIssues: readonly FundingPolicyValidationIssue[];
}>;

export type FundingPolicyPreview =
  | Readonly<{
      valid: true;
      current: ResolvedFundingPolicy;
      candidate: FundingRuntimePolicy;
      candidateRevision: string;
      confirmation: string;
      diff: readonly FundingPolicyDiffEntry[];
      issues: readonly [];
    }>
  | Readonly<{
      valid: false;
      current: ResolvedFundingPolicy;
      candidate: null;
      candidateRevision: null;
      confirmation: null;
      diff: readonly [];
      issues: readonly FundingPolicyValidationIssue[];
    }>;

export type FundingPolicyPublishErrorCode =
  | "invalid_candidate"
  | "current_revision_mismatch"
  | "candidate_revision_mismatch"
  | "confirmation_mismatch";

export class FundingPolicyPublishError extends Error {
  readonly code: FundingPolicyPublishErrorCode;
  readonly issues: readonly FundingPolicyValidationIssue[];

  constructor(
    code: FundingPolicyPublishErrorCode,
    message: string,
    issues: readonly FundingPolicyValidationIssue[] = [],
  ) {
    super(message);
    this.name = "FundingPolicyPublishError";
    this.code = code;
    this.issues = issues;
  }
}

export async function resolveFundingPolicy(
  db: DbQuery,
  options: Readonly<{
    asOf?: Date;
    registry?: FundingStaticRegistry;
  }> = {},
): Promise<ResolvedFundingPolicy> {
  const registry = options.registry ?? PRODUCTION_FUNDING_REGISTRY;
  const row = await fetchActiveRuntimePolicy(
    db,
    FUNDING_POLICY_KEY,
    options.asOf,
  );
  if (!row) {
    return {
      source: "default",
      policy: DEFAULT_FUNDING_RUNTIME_POLICY,
      revision: fundingPolicyRevision(DEFAULT_FUNDING_RUNTIME_POLICY),
      effectiveAt: null,
      createdAt: null,
      createdBy: null,
      invalidStoredPolicy: false,
      validationIssues: [],
    };
  }

  const validated = validateFundingRuntimePolicy(row.payload, registry);
  if (!validated.ok) {
    return {
      source: "default",
      policy: DEFAULT_FUNDING_RUNTIME_POLICY,
      revision: fundingPolicyRevision(DEFAULT_FUNDING_RUNTIME_POLICY),
      effectiveAt:
        row.effective_at instanceof Date ? row.effective_at : new Date(0),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(0),
      createdBy: row.created_by,
      invalidStoredPolicy: true,
      validationIssues: validated.issues,
    };
  }

  return {
    source: "db",
    policy: validated.policy,
    revision: fundingPolicyRevision(validated.policy),
    effectiveAt:
      row.effective_at instanceof Date ? row.effective_at : new Date(0),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(0),
    createdBy: row.created_by,
    invalidStoredPolicy: false,
    validationIssues: [],
  };
}

export async function previewFundingPolicy(
  db: DbQuery,
  candidateInput: unknown,
  options: Readonly<{
    registry?: FundingStaticRegistry;
  }> = {},
): Promise<FundingPolicyPreview> {
  const registry = options.registry ?? PRODUCTION_FUNDING_REGISTRY;
  const current = await resolveFundingPolicy(db, { registry });
  const validated = validateFundingRuntimePolicy(candidateInput, registry);
  if (!validated.ok) {
    return {
      valid: false,
      current,
      candidate: null,
      candidateRevision: null,
      confirmation: null,
      diff: [],
      issues: validated.issues,
    };
  }
  const candidateRevision = fundingPolicyRevision(validated.policy);
  return {
    valid: true,
    current,
    candidate: validated.policy,
    candidateRevision,
    confirmation: fundingPolicyPublishConfirmation({
      currentRevision: current.revision,
      candidateRevision,
    }),
    diff: diffFundingPolicies(current.policy, validated.policy),
    issues: [],
  };
}

export async function publishFundingPolicy(
  db: DbQuery,
  input: Readonly<{
    candidate: unknown;
    expectedCurrentRevision: string;
    candidateRevision: string;
    confirmation: string;
    createdBy: string | null;
    now?: Date;
  }>,
  options: Readonly<{
    registry?: FundingStaticRegistry;
  }> = {},
): Promise<ResolvedFundingPolicy> {
  const registry = options.registry ?? PRODUCTION_FUNDING_REGISTRY;
  await db.query<{ locked: unknown }>(
    "select pg_advisory_xact_lock(hashtext($1)) as locked",
    [FUNDING_POLICY_KEY],
  );

  const current = await resolveFundingPolicy(db, { registry });
  if (current.revision !== input.expectedCurrentRevision) {
    throw new FundingPolicyPublishError(
      "current_revision_mismatch",
      "funding policy changed after preview",
    );
  }

  const validated = validateFundingRuntimePolicy(input.candidate, registry);
  if (!validated.ok) {
    throw new FundingPolicyPublishError(
      "invalid_candidate",
      "funding policy candidate is invalid",
      validated.issues,
    );
  }

  const candidateRevision = fundingPolicyRevision(validated.policy);
  if (candidateRevision !== input.candidateRevision) {
    throw new FundingPolicyPublishError(
      "candidate_revision_mismatch",
      "funding policy candidate does not match preview revision",
    );
  }

  const expectedConfirmation = fundingPolicyPublishConfirmation({
    currentRevision: current.revision,
    candidateRevision,
  });
  if (input.confirmation !== expectedConfirmation) {
    throw new FundingPolicyPublishError(
      "confirmation_mismatch",
      "funding policy confirmation does not match the current diff",
    );
  }

  const now = input.now ?? new Date();
  const row = await insertRuntimePolicy(db, {
    policyKey: FUNDING_POLICY_KEY,
    effectiveAt: now,
    payload: validated.policy,
    createdBy: input.createdBy,
  });

  return {
    source: "db",
    policy: validated.policy,
    revision: candidateRevision,
    effectiveAt:
      row.effective_at instanceof Date ? row.effective_at : new Date(0),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(0),
    createdBy: row.created_by,
    invalidStoredPolicy: false,
    validationIssues: [],
  };
}
