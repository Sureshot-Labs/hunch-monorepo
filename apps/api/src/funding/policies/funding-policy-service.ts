import type { DbQuery } from "../../db.js";
import {
  fetchActiveRuntimePolicy,
  insertRuntimePolicy,
} from "../../repos/runtime-policies.js";
import {
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
import {
  DEFAULT_FUNDING_INTENT_POLICY,
  applyFundingIntentPatch,
  compileFundingIntentPolicy,
  fundingIntentBehaviorSnapshot,
  fundingIntentFromRuntimePolicy,
  validateFundingIntentPolicy,
  type FundingIntentPolicy,
} from "./funding-policy-v2.js";

export type FundingStoredPolicy = FundingRuntimePolicy | FundingIntentPolicy;

export type ResolvedFundingPolicy = Readonly<{
  source: "default" | "db";
  policy: FundingRuntimePolicy;
  storedPolicy: FundingStoredPolicy;
  intentPolicy: FundingIntentPolicy;
  storedVersion: 1 | 2;
  revision: string;
  effectiveAt: Date | null;
  createdAt: Date | null;
  createdBy: string | null;
  invalidStoredPolicy: boolean;
  validationIssues: readonly FundingPolicyValidationIssue[];
}>;

export type PublicResolvedFundingPolicy = Readonly<{
  source: "default" | "db";
  storedVersion: 1 | 2;
  editable: boolean;
  policy: FundingIntentPolicy;
  revision: string;
  effectiveAt: Date | null;
  createdAt: Date | null;
  createdBy: string | null;
  invalidStoredPolicy: boolean;
  validationIssues: readonly FundingPolicyValidationIssue[];
}>;

export type RuntimeFundingPolicyResolution = Pick<
  ResolvedFundingPolicy,
  | "source"
  | "policy"
  | "revision"
  | "effectiveAt"
  | "createdAt"
  | "createdBy"
  | "invalidStoredPolicy"
  | "validationIssues"
>;

export type FundingPolicyResolver = (
  db: DbQuery,
  options?: Readonly<{ asOf?: Date; registry?: FundingStaticRegistry }>,
) => Promise<RuntimeFundingPolicyResolution>;

export type FundingPolicyPreviewInput = Readonly<{
  candidate?: unknown;
  patch?: unknown;
}>;

export type FundingPolicyPreview =
  | Readonly<{
      valid: true;
      current: PublicResolvedFundingPolicy;
      candidate: FundingIntentPolicy;
      candidateRevision: string;
      confirmation: string;
      diff: readonly FundingPolicyDiffEntry[];
      issues: readonly [];
    }>
  | Readonly<{
      valid: false;
      current: PublicResolvedFundingPolicy;
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

function publicResolvedPolicy(
  resolved: ResolvedFundingPolicy,
): PublicResolvedFundingPolicy {
  return {
    source: resolved.source,
    storedVersion: resolved.storedVersion,
    editable: resolved.storedVersion === 2,
    policy: resolved.intentPolicy,
    revision: resolved.revision,
    effectiveAt: resolved.effectiveAt,
    createdAt: resolved.createdAt,
    createdBy: resolved.createdBy,
    invalidStoredPolicy: resolved.invalidStoredPolicy,
    validationIssues: resolved.validationIssues,
  };
}

function defaultResolvedPolicy(
  input: Readonly<{
    effectiveAt: Date | null;
    createdAt: Date | null;
    createdBy: string | null;
    invalidStoredPolicy: boolean;
    storedVersion: 1 | 2;
    validationIssues: readonly FundingPolicyValidationIssue[];
  }>,
): ResolvedFundingPolicy {
  return {
    source: "default",
    policy: compileFundingIntentPolicy(DEFAULT_FUNDING_INTENT_POLICY),
    storedPolicy: DEFAULT_FUNDING_INTENT_POLICY,
    intentPolicy: DEFAULT_FUNDING_INTENT_POLICY,
    storedVersion: input.storedVersion,
    revision: fundingPolicyRevision(DEFAULT_FUNDING_INTENT_POLICY),
    effectiveAt: input.effectiveAt,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    invalidStoredPolicy: input.invalidStoredPolicy,
    validationIssues: input.validationIssues,
  };
}

function storedVersion(input: unknown): 1 | 2 {
  return Boolean(input && typeof input === "object" && "version" in input) &&
    (input as { version?: unknown }).version === 1
    ? 1
    : 2;
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
    return defaultResolvedPolicy({
      effectiveAt: null,
      createdAt: null,
      createdBy: null,
      invalidStoredPolicy: false,
      storedVersion: 2,
      validationIssues: [],
    });
  }

  const metadata = {
    effectiveAt:
      row.effective_at instanceof Date ? row.effective_at : new Date(0),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(0),
    createdBy: row.created_by ?? row.created_by_admin_id,
  };
  if (storedVersion(row.payload) === 2) {
    const validated = validateFundingIntentPolicy(row.payload);
    if (!validated.ok) {
      return defaultResolvedPolicy({
        ...metadata,
        invalidStoredPolicy: true,
        storedVersion: 2,
        validationIssues: validated.issues,
      });
    }
    return {
      source: "db",
      policy: validated.runtimePolicy,
      storedPolicy: validated.policy,
      intentPolicy: validated.policy,
      storedVersion: 2,
      revision: fundingPolicyRevision(validated.policy),
      ...metadata,
      invalidStoredPolicy: false,
      validationIssues: [],
    };
  }

  const validated = validateFundingRuntimePolicy(row.payload, registry);
  if (!validated.ok) {
    return defaultResolvedPolicy({
      ...metadata,
      invalidStoredPolicy: true,
      storedVersion: 1,
      validationIssues: validated.issues,
    });
  }
  return {
    source: "db",
    policy: validated.policy,
    storedPolicy: validated.policy,
    intentPolicy: fundingIntentFromRuntimePolicy(validated.policy),
    storedVersion: 1,
    revision: fundingPolicyRevision(validated.policy),
    ...metadata,
    invalidStoredPolicy: false,
    validationIssues: [],
  };
}

export async function resolveFundingPolicyForAdmin(
  db: DbQuery,
): Promise<PublicResolvedFundingPolicy> {
  return publicResolvedPolicy(await resolveFundingPolicy(db));
}

function invalidPreview(
  current: ResolvedFundingPolicy,
  issues: readonly FundingPolicyValidationIssue[],
): FundingPolicyPreview {
  return {
    valid: false,
    current: publicResolvedPolicy(current),
    candidate: null,
    candidateRevision: null,
    confirmation: null,
    diff: [],
    issues,
  };
}

export async function previewFundingPolicy(
  db: DbQuery,
  input: FundingPolicyPreviewInput,
  options: Readonly<{
    registry?: FundingStaticRegistry;
  }> = {},
): Promise<FundingPolicyPreview> {
  const current = await resolveFundingPolicy(db, options);
  const hasCandidate = Object.prototype.hasOwnProperty.call(input, "candidate");
  const hasPatch = Object.prototype.hasOwnProperty.call(input, "patch");
  if (hasCandidate === hasPatch) {
    return invalidPreview(current, [
      {
        code: "schema_invalid",
        path: "",
        message: "provide exactly one funding policy candidate or patch",
      },
    ]);
  }
  if (hasPatch && current.storedVersion !== 2) {
    return invalidPreview(current, [
      {
        code: "schema_invalid",
        path: "patch",
        message:
          "legacy V1 policy is read-only; create a complete V2 candidate",
      },
    ]);
  }
  const validated = hasPatch
    ? applyFundingIntentPatch(current.intentPolicy, input.patch)
    : validateFundingIntentPolicy(input.candidate);
  if (!validated.ok) return invalidPreview(current, validated.issues);

  const candidateRevision = fundingPolicyRevision(validated.policy);
  return {
    valid: true,
    current: publicResolvedPolicy(current),
    candidate: validated.policy,
    candidateRevision,
    confirmation: fundingPolicyPublishConfirmation({
      currentRevision: current.revision,
      candidateRevision,
    }),
    diff: diffFundingPolicies(
      {
        storedVersion: current.storedVersion,
        ...fundingIntentBehaviorSnapshot(current.intentPolicy),
      },
      {
        storedVersion: 2,
        ...fundingIntentBehaviorSnapshot(validated.policy),
      },
    ),
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
    createdByUserId: string | null;
    createdByAdminId: string | null;
    now?: Date;
  }>,
  options: Readonly<{
    registry?: FundingStaticRegistry;
  }> = {},
): Promise<ResolvedFundingPolicy> {
  await db.query<{ locked: unknown }>(
    "select pg_advisory_xact_lock(hashtext($1)) as locked",
    [FUNDING_POLICY_KEY],
  );

  const current = await resolveFundingPolicy(db, options);
  if (current.revision !== input.expectedCurrentRevision) {
    throw new FundingPolicyPublishError(
      "current_revision_mismatch",
      "funding policy changed after preview",
    );
  }

  const validated = validateFundingIntentPolicy(input.candidate);
  if (!validated.ok) {
    throw new FundingPolicyPublishError(
      "invalid_candidate",
      "funding policy candidate must be a compact V2 policy",
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
    createdByUserId: input.createdByUserId,
    createdByAdminId: input.createdByAdminId,
  });

  return {
    source: "db",
    policy: validated.runtimePolicy,
    storedPolicy: validated.policy,
    intentPolicy: validated.policy,
    storedVersion: 2,
    revision: candidateRevision,
    effectiveAt:
      row.effective_at instanceof Date ? row.effective_at : new Date(0),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(0),
    createdBy: row.created_by ?? row.created_by_admin_id,
    invalidStoredPolicy: false,
    validationIssues: [],
  };
}

export function publishedFundingPolicyForAdmin(
  resolved: ResolvedFundingPolicy,
): PublicResolvedFundingPolicy {
  return publicResolvedPolicy(resolved);
}
