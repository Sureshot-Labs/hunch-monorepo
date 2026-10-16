import {
  hip4Identity,
  hip4ReadMarketSchema,
  type Hip4Environment,
} from "@hunch/shared";

/** Explicit source facts, not a model-generated equivalence assertion. Missing
 * formal terms leave a market in review; display titles never fill these fields.
 * This first adapter covers scalar threshold contracts, not arbitrary templates.
 */
export type MatchingResolutionEvidence = {
  version: 1;
  kind: "scalar_threshold";
  question: string;
  underlying: string;
  comparator: ">" | ">=" | "<" | "<=" | "=";
  threshold: string;
  observationTime: string;
  timeZone: string;
  oracle: string;
  priceSource: string;
  payoutRules: string;
  voidRules: string;
};

export type Hip4MatchingEvidence = {
  version: 1;
  source: "native_formal_terms";
  environment: Hip4Environment;
  outcome: number;
  /** Original, unmodified source description, also present in the catalog. */
  sourceDescription: string;
  /** Native identifiers; null means absent, never inferred from a title. */
  template: string | null;
  deployer: string | null;
  resolution: MatchingResolutionEvidence;
};

export type Hip4MatchingIdentity = {
  environment: Hip4Environment;
  marketId: string;
  outcome: number;
  expiry: string;
  tokens: [string, string];
};

/** Decision provenance, deliberately outside the stable native instance key. */
export type Hip4MatchingProvenance = {
  template: string | null;
  deployer: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const resolutionKeys = [
  "version",
  "kind",
  "question",
  "underlying",
  "comparator",
  "threshold",
  "observationTime",
  "timeZone",
  "oracle",
  "priceSource",
  "payoutRules",
  "voidRules",
] as const;

/** Pure parser shared by fixture and ingestion adapters. A successful parse is
 * only well-formed evidence: original rules/context, model and publication gates
 * must still pass. Producers must derive it from verified native formal terms.
 */
export function parseMatchingResolutionEvidence(
  value: unknown,
): MatchingResolutionEvidence | null {
  const row = record(value);
  if (
    Object.keys(row).length !== resolutionKeys.length ||
    Object.keys(row).some(
      (key) => !resolutionKeys.includes(key as (typeof resolutionKeys)[number]),
    ) ||
    row.version !== 1 ||
    row.kind !== "scalar_threshold" ||
    ![">", ">=", "<", "<=", "="].includes(text(row.comparator)) ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(text(row.threshold)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      text(row.observationTime),
    )
  )
    return null;
  const instant = new Date(String(row.observationTime));
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().replace(".000Z", "Z") !==
      String(row.observationTime).replace(".000Z", "Z")
  )
    return null;
  const fields = Object.fromEntries(
    resolutionKeys
      .filter((key) => key !== "version")
      .map((key) => [key, text(row[key])]),
  );
  if (Object.values(fields).some((field) => !field || field.length > 20_000))
    return null;
  return {
    ...fields,
    version: 1,
    observationTime: instant.toISOString(),
  } as MatchingResolutionEvidence;
}

export function normalizeHip4MatchingInput(input: {
  id: string;
  eventId: string;
  title: string;
  eventTitle: string;
  description: string;
  question: string;
  expiry: string;
  labels: string[];
  tokens: { tokenId: string; side: string }[];
  metadata: Record<string, unknown>;
}): {
  identity: Hip4MatchingIdentity | null;
  provenance: Hip4MatchingProvenance | null;
  resolution: MatchingResolutionEvidence | null;
  outcomes: { tokenId: string; label: string; side: "YES" | "NO" }[];
  blockers: string[];
} {
  const blockers: string[] = [];
  const parsed = hip4ReadMarketSchema.safeParse(input.metadata.hip4);
  const envelope = record(input.metadata.hip4Matching);
  const resolution = parseMatchingResolutionEvidence(envelope.resolution);
  if (!parsed.success)
    return {
      identity: null,
      provenance: null,
      resolution,
      outcomes: [],
      blockers: ["hip4_native_metadata_missing_or_invalid"],
    };
  const market = parsed.data;
  const identity = hip4Identity(market.environment, market.outcome);
  if (
    input.id !== identity.marketId ||
    market.marketId !== identity.marketId ||
    input.eventId !== market.eventId ||
    input.title !== text(market.title) ||
    input.eventTitle !== text(market.eventTitle) ||
    !market.expiry ||
    input.expiry !== market.expiry ||
    text(market.description) !== input.description
  )
    blockers.push("hip4_instance_identity_mismatch");
  if (
    Object.keys(envelope).length !== 8 ||
    !Object.keys(envelope).every((key) =>
      [
        "version",
        "environment",
        "outcome",
        "sourceDescription",
        "template",
        "deployer",
        "resolution",
        "source",
      ].includes(key),
    ) ||
    envelope.version !== 1 ||
    envelope.source !== "native_formal_terms" ||
    envelope.environment !== market.environment ||
    envelope.outcome !== market.outcome ||
    text(envelope.sourceDescription) !== input.description ||
    ![envelope.template, envelope.deployer].every(
      (value) => value === null || (typeof value === "string" && !!text(value)),
    )
  )
    blockers.push("hip4_resolution_provenance_missing_or_invalid");
  if (!resolution) blockers.push("hip4_resolution_terms_missing_or_invalid");
  else if (!input.question || resolution.question !== input.question)
    blockers.push("hip4_original_question_mismatch");
  const outcomes = identity.sides.map((side, index) => {
    const native = market.sides.find((row) => row.sideIndex === side.sideIndex);
    const claimSide = index === 0 ? "YES" : "NO";
    if (
      !native ||
      native.tokenId !== side.tokenId ||
      native.coin !== side.coin ||
      native.assetId !== side.assetId ||
      native.tokenName !== side.tokenName ||
      text(native.label) !== input.labels[index] ||
      input.tokens.filter(
        (token) => token.tokenId === side.tokenId && token.side === claimSide,
      ).length !== 1
    )
      blockers.push("hip4_native_side_identity_mismatch");
    return {
      tokenId: side.tokenId,
      label: text(native?.label),
      side: claimSide as "YES" | "NO",
    };
  });
  if (
    input.labels.length !== 2 ||
    input.tokens.length !== 2 ||
    new Set(input.labels).size !== 2
  )
    blockers.push("hip4_native_side_identity_mismatch");
  return {
    identity: market.expiry
      ? {
          environment: market.environment,
          marketId: identity.marketId,
          outcome: market.outcome,
          expiry: market.expiry,
          tokens: [identity.sides[0].tokenId, identity.sides[1].tokenId],
        }
      : null,
    provenance: {
      template: text(envelope.template) || null,
      deployer: text(envelope.deployer) || null,
    },
    resolution,
    outcomes: blockers.includes("hip4_native_side_identity_mismatch")
      ? []
      : outcomes,
    blockers: [...new Set(blockers)],
  };
}
