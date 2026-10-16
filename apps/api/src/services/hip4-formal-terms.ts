import { createHash } from "node:crypto";
import {
  hip4EnvironmentSchema,
  hip4OutcomeSchema,
  hip4QuestionSchema,
  type Hip4Environment,
} from "@hunch/shared";

type NativeCalendarToken = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type NativeTermsSource = {
  name: string;
  description: string;
  sideNames: [string, string];
  quoteToken: string | null;
  /** Native venue identifier only; not an inferred deployer/oracle identity. */
  venue: string | null;
  /** Source question, never a display/topic title. Membership is checked below. */
  question: {
    id: number;
    name: string;
    description: string;
    fallbackOutcome: number;
    namedOutcomes: number[];
    settledNamedOutcomes: number[];
  } | null;
};

export type Hip4FormalTermsObservation = {
  version: 1;
  environment: Hip4Environment | null;
  outcome: number | null;
  format:
    | "template_binary_price"
    | "template_binary_price_external"
    | "legacy_price_binary"
    | "unsupported";
  source: NativeTermsSource | null;
  /** Exact parsed values, including unknown and duplicate keys, for review. */
  fields: { key: string; value: string }[];
  observed: {
    perp: string | null;
    underlying: string | null;
    instrument: string | null;
    feed: string | null;
    priceDescription: string | null;
    shortName: string | null;
    threshold: string | null;
    declaredSeconds: number | null;
    timeToken: string | null;
    /** Calendar components only: neither UTC nor window semantics are assumed. */
    calendarToken: NativeCalendarToken | null;
    period: string | null;
  };
  diagnostics: { code: string; field?: string }[];
  /** Material native source only, not read-refresh generation, marks or books. */
  sourceFingerprint: string | null;
  matching: {
    status: "review_required";
    evidence: null;
    missingVerifiedTerms: readonly string[];
  };
};

const requiredVerifiedTerms = [
  "complete_affirmative_question",
  "comparison_and_equality_rule",
  "oracle_and_price_source_definition",
  "observation_timezone_window_and_aggregation",
  "payout_rules",
  "void_and_unavailable_oracle_rules",
] as const;

const emptyObserved = (): Hip4FormalTermsObservation["observed"] => ({
  perp: null,
  underlying: null,
  instrument: null,
  feed: null,
  priceDescription: null,
  shortName: null,
  threshold: null,
  declaredSeconds: null,
  timeToken: null,
  calendarToken: null,
  period: null,
});

function calendarToken(value: string): NativeCalendarToken | null {
  if (!/^\d{8}-\d{4}$/.test(value)) return null;
  const token = {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
    hour: Number(value.slice(9, 11)),
    minute: Number(value.slice(11, 13)),
  };
  // UTC is used only to validate the calendar, not to assign a source timezone.
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:00.000Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso
    ? token
    : null;
}

/**
 * Observe native descriptor fields, not formal resolution truth. The captured
 * template names do not establish their complete rules. In particular, seconds
 * is not an observation window, feed is not an oracle specification, and an
 * observed settlement does not establish a template's future payout/void rules.
 *
 * No complete formal-template adapter is registered here. Adding one requires
 * positively sourced semantics and source-bound question/context verification,
 * not an input flag or an assertion stored in market metadata. The output can
 * support catalog/research context; missing terms restrict matching only and
 * must not be used to block ordinary publication, trading or known-wallet reads.
 * No runtime config, API env, provider, DB or model is imported.
 */
export function parseHip4FormalTerms(input: {
  environment: unknown;
  nativeOutcome: unknown;
  nativeQuestion?: unknown;
}): Hip4FormalTermsObservation {
  const environment = hip4EnvironmentSchema.safeParse(input.environment);
  const spec = hip4OutcomeSchema.safeParse(input.nativeOutcome);
  const result: Hip4FormalTermsObservation = {
    version: 1,
    environment: environment.success ? environment.data : null,
    outcome: spec.success ? spec.data.outcome : null,
    format: "unsupported",
    source: null,
    fields: [],
    observed: emptyObserved(),
    diagnostics: [],
    sourceFingerprint: null,
    matching: {
      status: "review_required",
      evidence: null,
      missingVerifiedTerms: [...requiredVerifiedTerms],
    },
  };
  const diagnostic = (code: string, field?: string) => {
    result.diagnostics.push(field ? { code, field } : { code });
  };
  if (!environment.success) diagnostic("invalid_native_environment");
  if (!spec.success) {
    diagnostic("invalid_native_outcome");
    return result;
  }
  const native = spec.data;
  const source: NativeTermsSource = {
    name: native.name,
    description: native.description,
    sideNames: [native.sideSpecs[0].name, native.sideSpecs[1].name],
    quoteToken: native.quoteToken ?? null,
    venue: native.venue ?? null,
    question: null,
  };
  if (input.nativeQuestion != null) {
    const parent = hip4QuestionSchema.safeParse(input.nativeQuestion);
    if (!parent.success) diagnostic("invalid_native_question");
    else if (
      parent.data.fallbackOutcome !== native.outcome &&
      !parent.data.namedOutcomes.includes(native.outcome) &&
      !parent.data.settledNamedOutcomes?.includes(native.outcome)
    )
      diagnostic("native_question_membership_mismatch");
    else
      source.question = {
        id: parent.data.question,
        name: parent.data.name,
        description: parent.data.description,
        fallbackOutcome: parent.data.fallbackOutcome,
        namedOutcomes: [...parent.data.namedOutcomes],
        settledNamedOutcomes: [...(parent.data.settledNamedOutcomes ?? [])],
      };
  }
  result.source = source;
  const values = new Map<string, string[]>();
  for (const part of native.description.split("|")) {
    const colon = part.indexOf(":");
    if (colon <= 0 || !part.slice(0, colon).trim()) {
      if (part.trim()) diagnostic("unparsed_native_description_segment");
      continue;
    }
    const key = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    result.fields.push({ key, value });
    const previous = values.get(key);
    if (previous) previous.push(value);
    else values.set(key, [value]);
  }
  const unique = (key: string): string | null => {
    const entries = values.get(key);
    return entries?.length === 1 && entries[0] ? entries[0] : null;
  };
  for (const [key, entries] of values) {
    if (entries.length > 1) diagnostic("duplicate_native_field", key);
    if (entries.some((value) => !value)) diagnostic("empty_native_field", key);
  }
  if (native.name === "template:binaryPrice")
    result.format = "template_binary_price";
  else if (native.name === "template:binaryPriceExternal")
    result.format = "template_binary_price_external";
  else if (unique("class") === "priceBinary")
    result.format = "legacy_price_binary";
  else diagnostic("unsupported_native_template");

  if (result.format !== "unsupported") {
    const legacy = result.format === "legacy_price_binary";
    const external = result.format === "template_binary_price_external";
    const allowed = new Set(
      legacy
        ? ["class", "underlying", "expiry", "targetPrice", "period"]
        : external
          ? [
              "feed",
              "instrument",
              "priceDescription",
              "seconds",
              "shortName",
              "threshold",
              "time",
            ]
          : ["perp", "priceDescription", "seconds", "threshold", "time"],
    );
    for (const key of values.keys())
      if (!allowed.has(key)) diagnostic("unrecognized_native_field", key);
    for (const field of allowed)
      if (!unique(field))
        diagnostic("missing_or_ambiguous_native_field", field);
    const thresholdKey = legacy ? "targetPrice" : "threshold";
    const threshold = unique(thresholdKey);
    if (threshold && !/^(0|[1-9]\d*)(\.\d+)?$/.test(threshold))
      diagnostic("invalid_native_threshold", thresholdKey);
    else result.observed.threshold = threshold;
    const seconds = unique("seconds");
    if (seconds) {
      if (!/^[1-9]\d*$/.test(seconds) || !Number.isSafeInteger(Number(seconds)))
        diagnostic("invalid_native_seconds", "seconds");
      else result.observed.declaredSeconds = Number(seconds);
    }
    const timeKey = legacy ? "expiry" : "time";
    const time = unique(timeKey);
    result.observed.timeToken = time;
    result.observed.calendarToken = time ? calendarToken(time) : null;
    if (time && !result.observed.calendarToken)
      diagnostic("invalid_native_calendar_token", timeKey);
    for (const field of [
      "perp",
      "underlying",
      "instrument",
      "feed",
      "priceDescription",
      "shortName",
      "period",
    ] as const)
      result.observed[field] = unique(field);
    diagnostic("formal_native_template_semantics_unverified");
  }
  if (environment.success)
    result.sourceFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          environment: environment.data,
          outcome: native.outcome,
          source,
        }),
      )
      .digest("hex");
  return result;
}
