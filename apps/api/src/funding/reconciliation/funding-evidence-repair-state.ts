import { canonicalJsonHash } from "../persistence/canonical.js";

/** Bump when receipt interpretation changes; never infer a new execution envelope. */
export const FUNDING_EVIDENCE_REPAIR_REVISION = "funding_evidence_repair_v1";

export type FundingReceiptMatchingMask = Readonly<{
  chain: boolean;
  from: boolean;
  to: boolean;
  calldata: boolean;
  value: boolean;
}>;

export type FundingEvidenceRepairProbe = Readonly<{
  outcome: "intrinsic_mismatch" | "observed";
  status: string;
  matchingMask?: FundingReceiptMatchingMask;
}>;

export type FundingReceiptPollOptions = Readonly<{
  skipSourceKeys?: readonly string[];
  /** Background acquisition must not re-reduce a byte-identical observation. */
  skipUnchanged?: boolean;
}>;

export type FundingEvidenceRepairState = Readonly<{
  formatVersion: 1;
  evaluatorRevision: string;
  state: "requested" | "waiting_evidence" | "technical_retry";
  generation: number;
  processedGeneration: number;
  inputDigest: string | null;
  reason: "new_evidence" | "unchanged_evidence" | "verification_unavailable";
  requestKeys: Readonly<Record<string, number>>;
  sourceProbes: Readonly<Record<string, FundingEvidenceRepairProbe>>;
  lastProbe: FundingEvidenceRepairProbe | null;
  retryStartedAt: string | null;
  retryCount: number;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const digestPattern = /^[a-f0-9]{64}$/;
const receiptStatuses = new Set([
  "pending",
  "confirmed",
  "finalized",
  "failed",
  "mismatch",
  "reorged",
]);

/** Whitelist diagnostics: no reference, address, calldata, URL, or provider error. */
export function sanitizeFundingEvidenceRepairProbe(
  value: unknown,
): FundingEvidenceRepairProbe | null {
  const candidate = record(value);
  if (!candidate || !receiptStatuses.has(String(candidate.status))) return null;
  const mask = record(candidate.matchingMask);
  const matchingMask =
    mask &&
    ["chain", "from", "to", "calldata", "value"].every(
      (key) => typeof mask[key] === "boolean",
    )
      ? {
          chain: mask.chain as boolean,
          from: mask.from as boolean,
          to: mask.to as boolean,
          calldata: mask.calldata as boolean,
          value: mask.value as boolean,
        }
      : undefined;
  const intrinsic =
    candidate.outcome === "intrinsic_mismatch" &&
    candidate.status === "mismatch" &&
    matchingMask !== undefined &&
    Object.values(matchingMask).some((matches) => !matches);
  return {
    outcome: intrinsic ? "intrinsic_mismatch" : "observed",
    status: String(candidate.status),
    ...(matchingMask ? { matchingMask } : {}),
  };
}

export function parseFundingEvidenceRepairState(
  value: unknown,
): FundingEvidenceRepairState | null {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.formatVersion !== 1 ||
    !["requested", "waiting_evidence", "technical_retry"].includes(
      String(candidate.state),
    ) ||
    !Number.isSafeInteger(candidate.generation) ||
    Number(candidate.generation) < 0 ||
    !Number.isSafeInteger(candidate.processedGeneration) ||
    Number(candidate.processedGeneration) < 0 ||
    Number(candidate.processedGeneration) > Number(candidate.generation) ||
    typeof candidate.evaluatorRevision !== "string"
  )
    return null;
  const requestKeys: Record<string, number> = {};
  for (const [key, generation] of Object.entries(
    record(candidate.requestKeys) ?? {},
  )) {
    if (
      digestPattern.test(key) &&
      Number.isSafeInteger(generation) &&
      Number(generation) >= 0
    )
      requestKeys[key] = Number(generation);
  }
  const sourceProbes: Record<string, FundingEvidenceRepairProbe> = {};
  for (const [key, probe] of Object.entries(
    record(candidate.sourceProbes) ?? {},
  )) {
    const safe = sanitizeFundingEvidenceRepairProbe(probe);
    if (digestPattern.test(key) && safe) sourceProbes[key] = safe;
  }
  return {
    formatVersion: 1,
    evaluatorRevision: candidate.evaluatorRevision,
    state: candidate.state as FundingEvidenceRepairState["state"],
    generation: Number(candidate.generation),
    processedGeneration: Number(candidate.processedGeneration),
    inputDigest:
      typeof candidate.inputDigest === "string" &&
      digestPattern.test(candidate.inputDigest)
        ? candidate.inputDigest
        : null,
    reason:
      candidate.reason === "verification_unavailable"
        ? "verification_unavailable"
        : candidate.reason === "new_evidence"
          ? "new_evidence"
          : "unchanged_evidence",
    requestKeys,
    sourceProbes,
    lastProbe: sanitizeFundingEvidenceRepairProbe(candidate.lastProbe),
    retryStartedAt:
      typeof candidate.retryStartedAt === "string" &&
      Number.isFinite(Date.parse(candidate.retryStartedAt))
        ? candidate.retryStartedAt
        : null,
    retryCount:
      Number.isSafeInteger(candidate.retryCount) &&
      Number(candidate.retryCount) >= 0
        ? Number(candidate.retryCount)
        : 0,
  };
}

export function initialFundingEvidenceRepairState(): FundingEvidenceRepairState {
  return {
    formatVersion: 1,
    evaluatorRevision: FUNDING_EVIDENCE_REPAIR_REVISION,
    state: "requested",
    generation: 0,
    processedGeneration: 0,
    inputDigest: null,
    reason: "new_evidence",
    requestKeys: {},
    sourceProbes: {},
    lastProbe: null,
    retryStartedAt: null,
    retryCount: 0,
  };
}

/** Read-only compatibility fence, not an attempt/deadline gate. Unknown future
 * state must remain untouched until a compatible runtime can interpret it. */
export function fundingEvidenceRepairCompatibleSql(
  operationAlias: string,
): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(operationAlias))
    throw new TypeError("invalid funding operation alias");
  const value = `${operationAlias}.support_metadata->'evidenceRepairV1'`;
  const generation = (
    key: string,
  ) => `(case when jsonb_typeof(${value}->'${key}')='number'
    then (${value}->>'${key}')::numeric between 0 and 9007199254740991
      and (${value}->>'${key}')::numeric=trunc((${value}->>'${key}')::numeric)
    else false end)`;
  return `(not (${operationAlias}.support_metadata ? 'evidenceRepairV1') or (
    ${value}->'formatVersion' = '1'::jsonb
    and ${value}->>'state' in ('requested','waiting_evidence','technical_retry')
    and jsonb_typeof(${value}->'evaluatorRevision')='string'
    and ${generation("generation")}
    and ${generation("processedGeneration")}
    and (case when jsonb_typeof(${value}->'generation')='number'
      and jsonb_typeof(${value}->'processedGeneration')='number'
      then (${value}->>'processedGeneration')::numeric <= (${value}->>'generation')::numeric else false end)
  ))`;
}

/** Internal digest only. The corresponding diagnostic never contains these inputs. */
export function fundingReceiptSourceKey(
  input: Readonly<{
    action: unknown;
    receiptRefLookupHmac: string;
    lookupKeyVersion: number;
    payerRequirement: string;
    actionValidationResult: unknown;
  }>,
): string {
  return canonicalJsonHash({
    action: input.action,
    receiptRefLookupHmac: input.receiptRefLookupHmac,
    lookupKeyVersion: input.lookupKeyVersion,
    payerRequirement: input.payerRequirement,
    actionValidationResult: input.actionValidationResult,
    revision: FUNDING_EVIDENCE_REPAIR_REVISION,
  });
}

export function intrinsicFundingReceiptSourceKeys(
  state: FundingEvidenceRepairState | null,
): readonly string[] {
  if (
    !state ||
    state.evaluatorRevision !== FUNDING_EVIDENCE_REPAIR_REVISION ||
    state.generation > state.processedGeneration
  )
    return [];
  return Object.entries(state.sourceProbes)
    .filter(([, probe]) => probe.outcome === "intrinsic_mismatch")
    .map(([key]) => key);
}
