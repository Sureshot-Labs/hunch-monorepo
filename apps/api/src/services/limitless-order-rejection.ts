import crypto from "node:crypto";

import { isRecord } from "../lib/type-guards.js";

const MAX_DEPTH = 6;
const MAX_NODES = 160;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 500;
const MAX_ARRAY_ENTRIES = 8;
const MAX_OBJECT_ENTRIES = 20;
const MAX_EVIDENCE_BYTES = 4_096;

const MESSAGE_KEYS = new Set([
  "detail",
  "description",
  "error",
  "errors",
  "message",
  "messages",
  "reason",
  "reasons",
]);
const SECRET_KEY_PATTERN =
  /authorization|cookie|credential|hmac|password|secret|signature|token/i;

type JsonPrimitive = boolean | number | string | null;
export interface LimitlessSanitizedObject {
  readonly [key: string]: LimitlessSanitizedValue;
}
export type LimitlessSanitizedValue =
  | JsonPrimitive
  | readonly LimitlessSanitizedValue[]
  | LimitlessSanitizedObject;

export type LimitlessRejectionKind =
  | "allowance"
  | "authentication"
  | "fok_no_fill"
  | "network_or_lost_response"
  | "opaque_response"
  | "signature"
  | "transient_balance_or_indexing"
  | "transient_http"
  | "validation";

export type LimitlessOrderRejectionDecision = Readonly<{
  disposition: "ambiguous" | "definitive_failure" | "fok_no_fill";
  errorCode: string;
  failDirectHandoff: boolean;
  kind: LimitlessRejectionKind;
  mayRetrySubmission: false;
  releaseFundingReservation: boolean;
  requiresStatusReconciliation: boolean;
  retryableAfterReconciliation: boolean;
}>;

export type LimitlessOrderRejectionEvidence = Readonly<{
  digest: string;
  messages: readonly string[];
  payload: LimitlessSanitizedValue;
  providerCode: string | null;
  status: number | null;
  truncated: boolean;
}>;

function truncateText(value: string): string {
  const normalized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(
      /\b(?:api[-_ ]?key|authorization|signature|token)\s*[:=]\s*[^\s,;]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)}[redacted]`,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[redacted-jwt]",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= MAX_MESSAGE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function stableDigest(payload: unknown): string {
  let raw: string;
  try {
    raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    raw = String(payload);
  }
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function sanitizePayload(payload: unknown): {
  payload: LimitlessSanitizedValue;
  truncated: boolean;
} {
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number): LimitlessSanitizedValue => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      truncated = true;
      return "[truncated]";
    }
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === "string") {
      const text = truncateText(value);
      if (text.length !== value.replace(/\s+/g, " ").trim().length) {
        truncated = true;
      }
      return text;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) {
      truncated = true;
      return "[circular]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ENTRIES) truncated = true;
      return value
        .slice(0, MAX_ARRAY_ENTRIES)
        .map((entry) => visit(entry, depth + 1));
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_ENTRIES) truncated = true;
    return Object.fromEntries(
      entries
        .slice(0, MAX_OBJECT_ENTRIES)
        .map(([key, entry]) => [
          key,
          SECRET_KEY_PATTERN.test(key) ? "[redacted]" : visit(entry, depth + 1),
        ]),
    );
  };

  return { payload: visit(payload, 0), truncated };
}

function collectMessages(payload: unknown): string[] {
  const messages: string[] = [];
  const seenMessages = new Set<string>();
  const seenObjects = new WeakSet<object>();
  let nodes = 0;

  const add = (value: string) => {
    const message = truncateText(value);
    if (!message || seenMessages.has(message)) return;
    seenMessages.add(message);
    messages.push(message);
  };
  const visit = (value: unknown, depth: number, messageContext: boolean) => {
    if (messages.length >= MAX_MESSAGES || nodes++ >= MAX_NODES) return;
    if (typeof value === "string") {
      if (messageContext || depth === 0) add(value);
      return;
    }
    if (!value || typeof value !== "object" || depth > MAX_DEPTH) return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry, depth + 1, messageContext || depth === 0);
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      const nestedMessageContext =
        messageContext || MESSAGE_KEYS.has(key.toLowerCase());
      visit(entry, depth + 1, nestedMessageContext);
    }
  };
  visit(payload, 0, false);
  return messages;
}

function readProviderCode(payload: unknown): string | null {
  const queue: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: payload },
  ];
  let visited = 0;
  while (queue.length && visited++ < MAX_NODES) {
    const current = queue.shift();
    if (!current || current.depth > MAX_DEPTH) continue;
    if (Array.isArray(current.value)) {
      queue.push(
        ...current.value.map((value) => ({
          depth: current.depth + 1,
          value,
        })),
      );
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const key of ["code", "errorCode", "error_code", "type"]) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      const candidate = current.value[key];
      if (
        (typeof candidate === "string" || typeof candidate === "number") &&
        String(candidate).trim()
      ) {
        return truncateText(String(candidate));
      }
    }
    queue.push(
      ...Object.entries(current.value)
        .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
        .map(([, value]) => ({
          depth: current.depth + 1,
          value,
        })),
    );
  }
  return null;
}

export function parseLimitlessOrderRejection(input: {
  payload: unknown;
  status: number | null;
}): LimitlessOrderRejectionEvidence {
  const sanitized = sanitizePayload(input.payload);
  const evidence: LimitlessOrderRejectionEvidence = {
    digest: stableDigest(sanitized.payload),
    messages: collectMessages(input.payload),
    payload: sanitized.payload,
    providerCode: readProviderCode(input.payload),
    status: input.status,
    truncated: sanitized.truncated,
  };
  if (
    Buffer.byteLength(JSON.stringify(evidence), "utf8") <= MAX_EVIDENCE_BYTES
  ) {
    return evidence;
  }
  const boundedMessages = [...evidence.messages];
  const bounded: LimitlessOrderRejectionEvidence = {
    ...evidence,
    messages: boundedMessages,
    payload: "[truncated: see digest and extracted messages]",
    truncated: true,
  };
  while (
    boundedMessages.length > 0 &&
    Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_EVIDENCE_BYTES
  ) {
    boundedMessages.pop();
  }
  return bounded;
}

function decision(
  input: Pick<
    LimitlessOrderRejectionDecision,
    "disposition" | "errorCode" | "kind" | "retryableAfterReconciliation"
  >,
): LimitlessOrderRejectionDecision {
  const definitive = input.disposition !== "ambiguous";
  return {
    ...input,
    failDirectHandoff: definitive,
    mayRetrySubmission: false,
    releaseFundingReservation: definitive,
    requiresStatusReconciliation: !definitive,
  };
}

export function classifyLimitlessOrderRejection(input: {
  evidence: LimitlessOrderRejectionEvidence;
  orderType: "FOK" | "GTC";
  explicitFokNoFill?: boolean;
}): LimitlessOrderRejectionDecision {
  const { status } = input.evidence;
  const searchable = [input.evidence.providerCode, ...input.evidence.messages]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  // A venue's explicit allowance rejection happens before it accepts or
  // forwards an order.  Do not let the broader "insufficient collateral"
  // balance/indexing heuristic turn this deterministic 4xx into a seven-day
  // reconciliation hold.
  const insufficientAllowance =
    /insufficient (?:collateral )?allowance|(?:collateral )?allowance (?:is )?(?:insufficient|required|missing)/i.test(
      searchable,
    );
  const transientBalanceOrIndexing =
    /insufficient (?:available )?(?:cash|collateral|funds|balance)|balance (?:is )?(?:pending|unavailable|not (?:yet )?(?:available|indexed|updated))|(?:index|indexer|indexing).*(?:delay|lag|pending|sync)|(?:account|balance).*(?:still )?syncing/i.test(
      searchable,
    );

  if (status == null) {
    return decision({
      disposition: "ambiguous",
      errorCode: "limitless_submit_state_unknown",
      kind: "network_or_lost_response",
      retryableAfterReconciliation: false,
    });
  }

  if (insufficientAllowance) {
    return decision({
      disposition: "definitive_failure",
      errorCode: "limitless_trade_allowance_rejected",
      kind: "allowance",
      retryableAfterReconciliation: false,
    });
  }

  if (transientBalanceOrIndexing) {
    return decision({
      disposition: "ambiguous",
      errorCode: "limitless_submit_balance_or_indexing_pending",
      kind: "transient_balance_or_indexing",
      retryableAfterReconciliation: true,
    });
  }

  if ([408, 409, 425, 429].includes(status) || status >= 500) {
    return decision({
      disposition: "ambiguous",
      errorCode: "limitless_submit_state_unknown",
      kind: "transient_http",
      retryableAfterReconciliation: true,
    });
  }

  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|forbidden|authentication (?:failed|required)|invalid api key|permission denied/i.test(
      searchable,
    )
  ) {
    return decision({
      disposition: "definitive_failure",
      errorCode: "limitless_trade_auth_rejected",
      kind: "authentication",
      retryableAfterReconciliation: false,
    });
  }

  if (
    /invalid signature|signature (?:is )?(?:invalid|missing|required|malformed|expired)|failed to (?:recover|verify).*sign/i.test(
      searchable,
    )
  ) {
    return decision({
      disposition: "definitive_failure",
      errorCode: "limitless_trade_signature_rejected",
      kind: "signature",
      retryableAfterReconciliation: false,
    });
  }

  if (
    status === 400 &&
    input.orderType === "FOK" &&
    (input.explicitFokNoFill === true ||
      /(?:not|unable to) fill|no (?:immediate )?(?:match|liquidity)|unmatched|insufficient (?:depth|liquidity)/i.test(
        searchable,
      ))
  ) {
    return decision({
      disposition: "fok_no_fill",
      errorCode: "limitless_trade_no_fill",
      kind: "fok_no_fill",
      retryableAfterReconciliation: false,
    });
  }

  if (
    status === 422 ||
    /validation (?:error|failed)|invalid (?:field|order|parameter|payload|request|value)|malformed|required field|(?:must|should) be|unsupported|not supported|does not belong|out of range|bad request|order (?:has )?expired/i.test(
      searchable,
    )
  ) {
    return decision({
      disposition: "definitive_failure",
      errorCode: "limitless_trade_validation_rejected",
      kind: "validation",
      retryableAfterReconciliation: false,
    });
  }

  return decision({
    disposition: "ambiguous",
    errorCode: "limitless_submit_state_unknown",
    kind: "opaque_response",
    retryableAfterReconciliation: false,
  });
}

export function extractParsedLimitlessMessage(payload: unknown): string | null {
  return collectMessages(payload)[0] ?? null;
}
