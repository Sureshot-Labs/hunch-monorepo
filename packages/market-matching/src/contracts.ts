import { createHash } from "node:crypto";
import {
  DEFAULT_MARKET_MATCHING_POLICY,
  MATCHING_SUPPORTED_VENUES,
  type MarketMatchingPolicy,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  parseVenueLifecyclePolicy,
  venueHasLifecycleCapability,
  venueHasIndexerMode,
  type VenueLifecyclePolicy,
} from "@hunch/shared";
import { fetchActiveRuntimePolicy, type RuntimePolicyQuery } from "@hunch/db";

// Evidence revisions, not product releases or runtime-policy schema versions.
// Decision-affecting changes invalidate old approvals; operational budget edits do not.
export const POLICY_VERSION = "matching-v3-source-links";
export const PROMPT_VERSION = "matching-evidence-v3";
export const EXPECTED_MODEL = "typesafe/jev-1.13-20260917";
export const SUPPORTED_VENUES: readonly string[] = MATCHING_SUPPORTED_VENUES;
export type EntityKind = "event" | "contract";
export type Outcome = {
  id: string;
  label: string;
  side: "YES" | "NO" | null;
  tokenId: string | null;
};
export type Contract = {
  id: string;
  eventId: string;
  venue: string;
  event: string;
  selection: string;
  question: string;
  rules: string[];
  parentRules: string;
  eventMembers: { id: string; selection: string }[];
  contextDates: {
    closeTime: string;
    expirationTime: string;
    eventEndDate: string;
  };
  outcomes: Outcome[];
  status: string;
  eventStatus: string;
  provenance: Record<string, string>;
  blockers: string[];
  fingerprint: string;
};
export type EventContract = {
  id: string;
  venue: string;
  title: string;
  rules: string;
  status: string;
  children: { id: string; fingerprint: string; selection: string }[];
  fingerprint: string;
};
export type MarketRow = Record<string, unknown> & {
  id: string;
  event_id: string;
  venue: string;
};
export type Answer = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export function outcomeCandidates(
  a: {
    selection: string;
    event?: string;
    question?: string;
    outcomes: Pick<Outcome, "label" | "side">[];
  },
  b: { selection: string; outcomes: Pick<Outcome, "label" | "side">[] },
) {
  const question = sharedBoundQuestion(a, b);
  const selectedClaim = (c: typeof a) => question ?? c.selection;
  const claim = (c: typeof a, o: Pick<Outcome, "label" | "side">) =>
    o.side === "YES"
      ? selectedClaim(c)
      : o.side === "NO"
        ? `NOT (${selectedClaim(c)})`
        : o.label;
  return a.outcomes.flatMap((left, i) =>
    b.outcomes.flatMap((right, j) => {
      const selected = claim(a, left);
      return selected === claim(b, right) &&
        !/\b(other|neither|draw|tie)\b/i.test(selected)
        ? [
            {
              key: `outcome_${i}_${j}`,
              leftIndex: i,
              rightIndex: j,
              claim: selected,
            },
          ]
        : [];
    }),
  );
}
// Only an explicit single-slot event template or a standalone question can prove
// flat/group binding. Generic child questions must not erase year/office context.
function boundQuestion(c: {
  selection: string;
  event?: string;
  question?: string;
}): string | null {
  const format = (text: string) =>
    clean(text)
      .replace(/\s+\?/g, "?")
      .replace(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/g,
        "$1 $2 $3",
      );
  const event = format(c.event ?? ""),
    selection = format(c.selection);
  const question = format(c.question || (event === selection ? selection : ""));
  if (!question) return null;
  if (event === selection && selection === question) return question;
  if ((event.match(/_{2,}/g) ?? []).length !== 1) return null;
  return format(event.replace(/_{2,}/, selection)) === question
    ? question
    : null;
}
function sharedBoundQuestion(
  a: Parameters<typeof boundQuestion>[0],
  b: Parameters<typeof boundQuestion>[0],
): string | null {
  const question = boundQuestion(a);
  return question && question === boundQuestion(b) ? question : null;
}
/** Ignore presentation-only whitespace; never erase numbers, operators or punctuation. */
function comparableRule(text: string): string {
  return clean(text)
    .replace(/\(\s*(https?:\/\/[^\s()]+)\s*\)/g, "($1)")
    .replace(/(\b\d{1,2}:\d{2})\s+(AM|PM)\b/g, "$1$2");
}
export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function anchorDestination(attributes: string): string {
  // Whole-attribute tokens prevent data-href or quoted title text from shadowing href.
  const attribute =
    /\s+([^\s=<>"'`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  const destinations: string[] = [];
  let position = 0;
  while (position < attributes.length) {
    if (/^\s*\/?\s*$/.test(attributes.slice(position))) break;
    attribute.lastIndex = position;
    const match = attribute.exec(attributes);
    if (!match) return `unparsed anchor ${attributes}`;
    position = attribute.lastIndex;
    if (match[1].toLowerCase() === "href")
      destinations.push(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return [...new Set(destinations)].join(" | ");
}
export function clean(value: unknown): string {
  return typeof value === "string"
    ? value
        // Settlement sources can exist only in href. Removing the destination
        // would hide a material rule change from both inference and fingerprints.
        .replace(
          /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
          (_link, attributes: string, label: string) => {
            const destination = anchorDestination(attributes);
            return destination && clean(label) !== clean(destination)
              ? `${label} (${destination})`
              : label;
          },
        )
        .replace(/<a\b([^>]*)>/gi, (_link, attributes: string) => {
          const destination = anchorDestination(attributes);
          return destination ? ` (${destination}) ` : " ";
        })
        .replace(
          /<\/?(?:p|br|div|span|a|strong|em|b|i|ul|ol|li|h[1-6])(?:\s[^<>]*|\s*\/?)>/gi,
          " ",
        )
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
export function normalizeContract(row: MarketRow): Contract {
  const metadata = record(row.metadata);
  const tokens = array(row.tokens).map(record);
  const rules = [
    ...new Set(
      [row.description, metadata.rulesPrimary, metadata.rulesSecondary]
        .map(clean)
        .filter(Boolean),
    ),
  ];
  const labels = array(row.outcomes).map(clean);
  const outcomes: Outcome[] = labels.map((label) => {
    const upper = label.toUpperCase();
    const side = upper === "YES" || upper === "NO" ? upper : null;
    // Stable instrument identity, never array position. Ambiguous token labels fail closed.
    const matches = tokens.filter(
      (t) => clean(t.outcome_side).toUpperCase() === (side ?? upper),
    );
    const tokenId = matches.length === 1 ? clean(matches[0].token_id) : null;
    return {
      id: tokenId
        ? `${row.id}:token:${tokenId}`
        : side
          ? `${row.id}:side:${side}`
          : "",
      label,
      side,
      tokenId,
    };
  });
  const parentRules = clean(row.event_description);
  const eventMembers = array(row.event_members)
    .map(record)
    .map((member) => ({
      id: clean(member.id),
      selection: clean(member.selection),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const blockers: string[] = [];
  if (!rules.length) blockers.push("missing_rules");
  if (
    rules.some((rule) =>
      /\b(listed candidates|these candidates|among the candidates|expiration time|closing time|market closes|creation of (?:this|the) market|market creation)\b/i.test(
        rule,
      ),
    )
  )
    blockers.push("implicit_context_requires_review");
  if (!clean(row.title) || !clean(row.event_title))
    blockers.push("missing_context");
  if (
    outcomes.length < 2 ||
    outcomes.some((o) => !o.id) ||
    new Set(outcomes.map((o) => o.id)).size !== outcomes.length
  )
    blockers.push("ambiguous_outcome_identity");
  if (
    parentRules &&
    !rules.some((rule) => comparableRule(rule) === comparableRule(parentRules))
  )
    blockers.push("unresolved_parent_rules");
  if (
    rules.some((x) =>
      /\b(attachment|attached rules|see (?:the )?(?:full|additional) rules|for (?:the )?(?:full|additional) rules)\b/i.test(
        x,
      ),
    )
  )
    blockers.push("external_rules_required");
  if (/\b(other|neither|draw|tie)\b/i.test(clean(row.title)))
    blockers.push("special_selection_requires_review");
  const value = {
    id: row.id,
    eventId: row.event_id,
    venue: row.venue,
    event: clean(row.event_title),
    selection: clean(row.title),
    question: clean(metadata.question),
    rules,
    parentRules,
    eventMembers,
    // Venue schedule changes invalidate evidence even while both rows stay ACTIVE.
    // These are catalog timestamps, not substitutes for the settlement rules.
    contextDates: {
      closeTime: canonicalDate(row.close_time),
      expirationTime: canonicalDate(row.expiration_time),
      eventEndDate: canonicalDate(row.event_end_date),
    },
    outcomes,
    status: clean(row.matching_status ?? row.status),
    eventStatus: clean(row.event_status),
    provenance: {
      rules:
        "unified_markets.description + metadata.rulesPrimary/rulesSecondary",
      parentRules: "unified_events.description",
      normalizer: POLICY_VERSION,
    },
    blockers,
  };
  return { ...value, fingerprint: hash(value) };
}
function canonicalDate(value: unknown): string {
  if (value == null) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : clean(value);
}
export function normalizeEvent(
  row: Record<string, unknown>,
  children: Contract[],
): EventContract {
  const value = {
    id: String(row.id),
    venue: String(row.venue),
    title: clean(row.title),
    rules: clean(row.description),
    status: clean(row.matching_status ?? row.status),
    children: children
      .map((c) => ({
        id: c.id,
        fingerprint: c.fingerprint,
        selection: c.selection,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { ...value, fingerprint: hash(value) };
}
export async function readPolicy(
  db: RuntimePolicyQuery,
): Promise<VenueLifecyclePolicy> {
  const row = await fetchActiveRuntimePolicy(db, "venue_lifecycle");
  if (!row) return DEFAULT_VENUE_LIFECYCLE_POLICY;
  const policy = parseVenueLifecyclePolicy(row.payload);
  if (!policy) throw new Error("invalid_venue_lifecycle");
  return policy;
}
export function eligible(policy: VenueLifecyclePolicy, venue: string): boolean {
  return (
    SUPPORTED_VENUES.includes(venue) &&
    venueHasLifecycleCapability(policy, venue, "discovery") &&
    venueHasIndexerMode(policy, venue, "full")
  );
}
export function approveContract(
  a: Contract,
  b: Contract,
  answer: Answer,
  model: string,
  outcomeAnswers?: Record<string, Answer>,
  matching: MarketMatchingPolicy = DEFAULT_MARKET_MATCHING_POLICY,
): {
  approved: boolean;
  blockers: string[];
  mapping: { left: string; right: string }[];
} {
  const blockers = [...a.blockers, ...b.blockers];
  if (
    a.status !== "ACTIVE" ||
    b.status !== "ACTIVE" ||
    a.eventStatus !== "ACTIVE" ||
    b.eventStatus !== "ACTIVE"
  )
    blockers.push("inactive");
  // Exact context binding is deliberately stricter than the model's semantic judgment.
  if (a.event !== b.event && !sharedBoundQuestion(a, b))
    blockers.push("context_requires_review");
  if (
    JSON.stringify(a.rules.map(comparableRule)) !==
    JSON.stringify(b.rules.map(comparableRule))
  )
    blockers.push("rules_require_review");
  if (
    a.selection === b.selection &&
    a.question &&
    b.question &&
    a.question !== b.question
  )
    blockers.push("question_requires_review");
  if (model !== EXPECTED_MODEL) blockers.push("model_drift");
  const binary = (c: Contract) =>
    c.outcomes.length === 2 &&
    c.outcomes.some((o) => o.side === "YES") &&
    c.outcomes.some((o) => o.side === "NO");
  if (
    binary(a) &&
    binary(b) &&
    (answer.choice !== "equivalent" ||
      !(answer.probabilities.equivalent >= matching.contractProbability) ||
      !(answer.confidence >= matching.contractConfidence))
  )
    blockers.push("contract_model_gate");
  const candidates = outcomeCandidates(a, b);
  const mapping = candidates.flatMap((c) => {
    const decision =
      outcomeAnswers?.[c.key] ??
      (a.selection === b.selection &&
      a.outcomes.length === 2 &&
      b.outcomes.length === 2
        ? answer
        : undefined);
    if (
      !decision ||
      decision.choice !== "equivalent" ||
      !(decision.probabilities.equivalent >= matching.contractProbability) ||
      !(decision.confidence >= matching.contractConfidence)
    )
      return [];
    return [
      { left: a.outcomes[c.leftIndex].id, right: b.outcomes[c.rightIndex].id },
    ];
  });
  if (!mapping.length) blockers.push("model_gate_or_no_matching_claim");
  if (
    new Set(mapping.map((x) => x.left)).size !== mapping.length ||
    new Set(mapping.map((x) => x.right)).size !== mapping.length
  )
    blockers.push("ambiguous_outcome_mapping");
  return {
    approved: !blockers.length,
    blockers: [...new Set(blockers)],
    mapping: !blockers.length ? mapping : [],
  };
}
