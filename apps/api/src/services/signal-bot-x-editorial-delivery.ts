import type { DbQuery } from "../db.js";
import { parseTelegramMarketIdentityV1 } from "./signal-publication-contract.js";
import { buildSignalBotMiniAppEventUrl } from "./signal-bot-mini-app-links.js";
import {
  beginSignalBotMessageDelivery,
  finishSignalBotMessageDelivery,
  reserveSignalBotMessageDelivery,
} from "./signal-bot-message-delivery-ledger.js";
import type {
  SignalBotDeliveryPreparationReason,
  SignalBotFollowthroughCandidateRow,
  SignalBotFollowthroughStats,
  SignalBotNote,
  SignalBotTelegramClient,
} from "./signal-bot-contracts.js";
import {
  parsePersistedXEditorialDraft,
  readXEditorialComposerFailure,
  buildXEditorialSourceDigest,
  X_EDITORIAL_CONTENT_PROFILE,
  type XEditorialComposerFailureCode,
  type XEditorialDraftComposer,
  type XEditorialDraftSource,
  type XEditorialDraftV1,
  type XEditorialMessageKind,
} from "./x-editorial-draft.js";

type SignalBotXEditorialDeliveryRow = {
  id: string;
  metrics: unknown;
  telegram_message_id: string | number | null;
};

export const X_EDITORIAL_MAX_COMPOSE_ATTEMPTS = 3;

type XEditorialComposerOutcome =
  | XEditorialComposerFailureCode
  | "model_blocked"
  | "ready";

export type SignalBotXEditorialPublicationResult =
  | { status: "already_sent" | "delivery_unknown" | "sent" }
  | {
      blockedChat: boolean;
      composerOutcome?: XEditorialComposerOutcome;
      status: "blocked";
    }
  | {
      blockedChat: boolean;
      composerOutcome?: XEditorialComposerFailureCode;
      status: "retry";
    }
  | {
      composerOutcome: XEditorialComposerFailureCode;
      status: "compose_failed";
    }
  | { reason: SignalBotDeliveryPreparationReason; status: "invalid" }
  | { status: "unavailable" };

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function asComposerFailureCode(
  value: unknown,
): XEditorialComposerFailureCode | null {
  return value === "missing_content" ||
    value === "provider_error" ||
    value === "schema_mismatch"
    ? value
    : null;
}

function buildComposerMetrics(input: {
  attemptCount: number;
  existing: Record<string, unknown>;
  fallbackUsed?: boolean;
  outcome: XEditorialComposerOutcome;
  terminal: boolean;
}): Record<string, unknown> {
  const existingOutcomes = asObject(input.existing.outcomes);
  const outcomes = {
    missing_content: asNonNegativeInteger(existingOutcomes.missing_content),
    model_blocked: asNonNegativeInteger(existingOutcomes.model_blocked),
    provider_error: asNonNegativeInteger(existingOutcomes.provider_error),
    schema_mismatch: asNonNegativeInteger(existingOutcomes.schema_mismatch),
  };
  if (input.outcome in outcomes && input.outcome !== "ready") {
    outcomes[input.outcome as keyof typeof outcomes] += 1;
  }
  return {
    attemptCount: input.attemptCount,
    fallbackUsed: input.fallbackUsed ?? false,
    maxAttempts: X_EDITORIAL_MAX_COMPOSE_ATTEMPTS,
    outcome: input.outcome,
    outcomes,
    retryable:
      !input.fallbackUsed &&
      input.outcome !== "ready" &&
      input.outcome !== "model_blocked" &&
      !input.terminal,
    terminal: input.terminal,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
}

function isMissingSignalBotMessagesTable(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function safeUrlOrUndefined(
  value: string | null | undefined,
): string | undefined {
  return isSafeHttpUrl(value) ? new URL(value).toString() : undefined;
}

function buildOpenMarketUrl(input: {
  appBaseUrl: string;
  eventId: string;
  marketId: string | null;
  side?: "NO" | "YES" | null;
}): string {
  const url = new URL(
    `/events/${encodeURIComponent(input.eventId)}`,
    input.appBaseUrl,
  );
  if (input.marketId) url.searchParams.set("market", input.marketId);
  if (input.side) url.searchParams.set("side", input.side);
  url.searchParams.set("utm_source", "x");
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", "signal_editorial");
  return url.toString();
}

function readExternalResearch(modelMeta: Record<string, unknown>): {
  fact: Record<string, unknown> | null;
  urls: string[];
} {
  const external = asObject(modelMeta.external_research);
  const status = asTrimmedString(external.status);
  if (status !== "ok") return { fact: null, urls: [] };
  const citations = Array.isArray(external.citations)
    ? external.citations
        .map((value) => asObject(value))
        .map((citation) => ({
          publishedAt: asTrimmedString(citation.publishedAt),
          title: asTrimmedString(citation.title),
          url: asTrimmedString(citation.url),
        }))
        .filter(
          (
            citation,
          ): citation is {
            publishedAt: string | null;
            title: string | null;
            url: string;
          } => isSafeHttpUrl(citation.url),
        )
        .slice(0, 3)
    : [];
  return {
    fact: {
      citations: citations.map(({ publishedAt, title, url }) => ({
        publishedAt,
        title,
        url,
      })),
      summary: asTrimmedString(external.summary),
      timing: asTrimmedString(external.timing),
      verdict: asTrimmedString(external.verdict),
    },
    urls: citations.map((citation) => citation.url),
  };
}

function buildInitialSource(input: {
  appBaseUrl: string;
  kind: "initial" | "research_update";
  note: SignalBotNote;
  recentOpenings: string[];
  selectedSide: "NO" | "YES";
  telegramMiniAppLinkBase: string | null;
}): XEditorialDraftSource {
  const note = input.note;
  const identity = note.telegramMarketIdentityV1;
  const price = note.signalPriceSnapshotV1;
  const external = readExternalResearch(note.modelMeta);
  const facts: XEditorialDraftSource["facts"] = [];
  const addFact = (id: string, label: string, value: unknown) => {
    if (value == null) return;
    if (typeof value === "string" && value.trim().length === 0) return;
    facts.push({ id, label, value });
  };
  addFact("market", "Canonical market proposition and selected side", {
    eventTitle: identity?.eventTitle ?? note.eventTitle,
    marketQuestion: identity?.marketQuestion ?? note.marketTitle,
    predicate: identity?.predicate ?? null,
    selectedSide: identity?.selectedSide ?? input.selectedSide,
    selectedSideLabel: identity?.selectedSideLabel ?? note.holderSide,
    subject: identity?.subject ?? note.eventTitle ?? note.marketTitle,
    venue: identity?.venue ?? note.marketVenue,
  });
  addFact("price", "Selected-side signal price", {
    asOf: price?.asOf ?? null,
    displayPrice: price?.displayPrice ?? null,
    displaySide: price?.displaySide ?? null,
  });
  addFact("research_copy", "Quality-gated research thesis", {
    description: note.description,
    headline: note.title,
    rationale: note.rationale,
  });
  addFact("actor", "Tracked trader or group", {
    actorMode: note.holderActorMode,
    clusterOpenPnlUsd: note.holderClusterOpenPnlUsd,
    clusterPnl30dUsd: note.holderClusterPnl30dUsd,
    clusterSharpHolders: note.holderClusterSharpHolders,
    clusterSharpUsd: note.holderClusterSharpUsd,
    displayName:
      note.holderIdentityDisplayName ?? note.holderDisplayName ?? null,
    openPnlUsd: note.holderOpenPnlUsd,
    positionSide: note.holderSide,
    positionUsd: note.holderPositionUsd,
  });
  addFact("credentials", "Verified actor credentials", [
    ...note.holderCredentialBullets,
  ]);
  if (input.kind === "research_update") {
    addFact(
      "research_update",
      "Producer-owned material change since the prior signal",
      note.holderResearchUpdateV1,
    );
  }
  addFact("external_context", "Validated external research", external.fact);
  const marketUrl =
    note.eventId && note.marketId
      ? buildOpenMarketUrl({
          appBaseUrl: input.appBaseUrl,
          eventId: note.eventId,
          marketId: note.marketId,
          side: input.selectedSide,
        })
      : null;
  const miniAppUrl = buildSignalBotMiniAppEventUrl({
    eventId: note.eventId,
    marketId: note.marketId,
    miniAppLinkBase: input.telegramMiniAppLinkBase,
    side: input.selectedSide,
  });
  return {
    facts,
    kind: input.kind,
    marketId: note.marketId ?? identity?.marketId ?? note.id,
    miniAppUrl:
      safeUrlOrUndefined(miniAppUrl) ??
      safeUrlOrUndefined(input.telegramMiniAppLinkBase),
    noteId: note.id,
    recentOpenings: input.recentOpenings,
    selectedSide: input.selectedSide,
    websiteUrl:
      safeUrlOrUndefined(marketUrl) ?? safeUrlOrUndefined(input.appBaseUrl),
  };
}

function validateInitialSource(input: {
  kind: "initial" | "research_update";
  note: SignalBotNote;
  selectedSide: "NO" | "YES";
}): SignalBotDeliveryPreparationReason | null {
  const identity = input.note.telegramMarketIdentityV1;
  if (!identity) return "missing_market_identity";
  if (
    identity.selectedSide !== input.selectedSide ||
    identity.marketId !== input.note.marketId ||
    identity.venue !== input.note.marketVenue
  ) {
    return "identity_mismatch";
  }
  if (input.kind === "research_update" && !input.note.holderResearchUpdateV1) {
    return "missing_update_contract";
  }
  const price = input.note.signalPriceSnapshotV1;
  if (!price) return "missing_price_snapshot";
  if (
    price.displaySide !== input.selectedSide ||
    price.marketId !== input.note.marketId ||
    price.venue !== input.note.marketVenue
  ) {
    return "identity_mismatch";
  }
  return null;
}

function buildFollowthroughSource(input: {
  appBaseUrl: string;
  candidate: SignalBotFollowthroughCandidateRow;
  kind: Extract<
    XEditorialMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  recentOpenings: string[];
  stats: SignalBotFollowthroughStats;
  telegramMiniAppLinkBase: string | null;
}): XEditorialDraftSource {
  const identity = parseTelegramMarketIdentityV1(
    asObject(input.candidate.metrics).telegramMarketIdentityV1,
  );
  const marketUrl = input.candidate.event_id
    ? buildOpenMarketUrl({
        appBaseUrl: input.appBaseUrl,
        eventId: input.candidate.event_id,
        marketId: input.candidate.market_id,
        side: input.stats.signalSide,
      })
    : null;
  const miniAppUrl = buildSignalBotMiniAppEventUrl({
    eventId: input.candidate.event_id,
    marketId: input.candidate.market_id,
    miniAppLinkBase: input.telegramMiniAppLinkBase,
    side: input.stats.signalSide,
  });
  return {
    facts: [
      {
        id: "market",
        label: "Canonical market proposition and selected side",
        value: {
          eventTitle: identity?.eventTitle ?? input.candidate.event_title,
          marketQuestion:
            identity?.marketQuestion ?? input.candidate.market_title,
          predicate: identity?.predicate ?? null,
          selectedSide: input.stats.signalSide,
          selectedSideLabel: identity?.selectedSideLabel ?? null,
          subject:
            identity?.subject ??
            input.candidate.event_title ??
            input.candidate.market_title,
          venue: identity?.venue ?? input.candidate.venue,
        },
      },
      {
        id: "original_signal",
        label: "Original quality-gated signal headline",
        value: input.candidate.title,
      },
      {
        id: "followthrough",
        label: "Computed change since the signal",
        value: input.stats,
      },
    ],
    kind: input.kind,
    marketId: input.candidate.market_id,
    miniAppUrl:
      safeUrlOrUndefined(miniAppUrl) ??
      safeUrlOrUndefined(input.telegramMiniAppLinkBase),
    noteId: input.candidate.thread_root_note_id,
    recentOpenings: input.recentOpenings,
    selectedSide: input.stats.signalSide as "NO" | "YES",
    websiteUrl:
      safeUrlOrUndefined(marketUrl) ?? safeUrlOrUndefined(input.appBaseUrl),
  };
}

async function loadDelivery(input: {
  chatId: string;
  db: DbQuery;
  messageKind: XEditorialMessageKind;
  noteId: string;
}): Promise<SignalBotXEditorialDeliveryRow | null> {
  try {
    const result = await input.db.query<SignalBotXEditorialDeliveryRow>(
      `
        select id::text, telegram_message_id, metrics
        from signal_bot_messages
        where chat_id = $1
          and note_id = $2::uuid
          and message_kind = $3
        limit 1
      `,
      [input.chatId, input.noteId, input.messageKind],
    );
    return result.rows[0] ?? null;
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return null;
    throw error;
  }
}

export async function loadXEditorialInitialRecoveryNoteIds(input: {
  chatId: string;
  db: DbQuery;
  limit?: number;
}): Promise<string[]> {
  try {
    const { rows } = await input.db.query<{ note_id: string }>(
      `
        select note_id::text as note_id
        from signal_bot_messages
        where chat_id = $1
          and telegram_message_id is null
          and message_kind in ('initial', 'research_update')
          and metrics->>'contentProfile' = $2
          and coalesce(metrics->>'status', '') = 'skipped'
          and (
            metrics #>> '{editorialComposerV1,outcome}' in (
              'missing_content', 'provider_error', 'schema_mismatch'
            )
            or metrics #>> '{editorialDraftV1,status}' = 'blocked'
          )
        order by sent_at desc
        limit $3
      `,
      [
        input.chatId,
        X_EDITORIAL_CONTENT_PROFILE,
        Math.max(1, Math.min(5, input.limit ?? 1)),
      ],
    );
    return rows.map((row) => row.note_id);
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return [];
    throw error;
  }
}

async function loadRecentOpenings(input: {
  chatId: string;
  db: DbQuery;
  limit?: number;
}): Promise<string[]> {
  try {
    const result = await input.db.query<{ post_text: string | null }>(
      `
        select metrics #>> '{editorialDraftV1,postText}' as post_text
        from signal_bot_messages
        where chat_id = $1
          and metrics->>'contentProfile' = $2
          and metrics #>> '{editorialDraftV1,status}' = 'ready'
        order by sent_at desc
        limit $3
      `,
      [
        input.chatId,
        X_EDITORIAL_CONTENT_PROFILE,
        Math.max(1, Math.min(20, input.limit ?? 20)),
      ],
    );
    return result.rows
      .map((row) => row.post_text?.trim() ?? "")
      .filter(Boolean);
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return [];
    throw error;
  }
}

function escapeMarkdownV2(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escapeMarkdownV2LinkTarget(value: string): string {
  return value.replace(/([)\\])/g, "\\$1");
}

function buildVisibleLink(
  label: string,
  url: string | undefined,
): string | null {
  if (!isSafeHttpUrl(url)) return null;
  return `${label}: [${escapeMarkdownV2(url)}](${escapeMarkdownV2LinkTarget(url)})`;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const capitalized = `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function clipVisibleText(value: string, maxCharacters = 950): string {
  const characters = Array.from(value.trim());
  if (characters.length <= maxCharacters) return characters.join("");
  const clipped = characters.slice(0, Math.max(1, maxCharacters - 1)).join("");
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary >= maxCharacters * 0.7 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed == null ? 0 : Math.max(0, Math.trunc(parsed));
}

function formatUsd(value: number, options?: { signed?: boolean }): string {
  const absolute = Math.abs(value);
  const amount =
    absolute >= 1_000_000
      ? `$${(absolute / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
      : absolute >= 1_000
        ? `$${(absolute / 1_000).toFixed(1).replace(/\.0$/, "")}K`
        : `$${Math.round(absolute).toLocaleString("en-US")}`;
  if (!options?.signed || value === 0) return amount;
  return value > 0 ? `+${amount}` : `-${amount}`;
}

function formatCents(value: number): string {
  return `${Math.round(value * 100)}¢`;
}

function factValue(source: XEditorialDraftSource, id: string): unknown | null {
  return source.facts.find((fact) => fact.id === id)?.value ?? null;
}

function buildFallbackPost(input: {
  failureCode: XEditorialComposerOutcome;
  source: XEditorialDraftSource;
}): XEditorialDraftV1 {
  const researchCopy = asObject(factValue(input.source, "research_copy"));
  const headline = asTrimmedString(researchCopy.headline);
  const description = asTrimmedString(researchCopy.description);
  const originalSignal = asTrimmedString(
    factValue(input.source, "original_signal"),
  );
  const followthrough = asObject(factValue(input.source, "followthrough"));
  let opening = sentence(headline ?? originalSignal ?? "Market update");
  let body = description ? sentence(description) : "";
  const storyFamily: XEditorialDraftV1["storyFamily"] =
    input.source.kind === "initial" || input.source.kind === "research_update"
      ? "fresh_bet"
      : input.source.kind === "followthrough_stats"
        ? "followthrough"
        : "resolution";
  let usedFactIds = description || headline ? ["research_copy"] : [];

  if (
    input.source.kind !== "initial" &&
    input.source.kind !== "research_update"
  ) {
    const side = input.source.selectedSide;
    const entryPrice = finiteNumber(followthrough.entryPrice);
    const markPrice = finiteNumber(followthrough.markPrice);
    const outcome = asTrimmedString(followthrough.outcome);
    const state = asTrimmedString(followthrough.state);
    const detail: string[] = [];
    if (state === "resolved" && (outcome === "win" || outcome === "loss")) {
      detail.push(`The ${side} side resolved as a ${outcome}`);
    } else if (entryPrice != null && markPrice != null) {
      detail.push(
        `${side} moved from ${formatCents(entryPrice)} to ${formatCents(markPrice)} since the signal`,
      );
    }
    const netFlow = finiteNumber(followthrough.netSignalSideFlowUsd);
    if (netFlow != null && Math.abs(netFlow) >= 1) {
      detail.push(
        netFlow > 0
          ? `Tracked wallets added a net ${formatUsd(netFlow)} on ${side}`
          : `Tracked wallets cut a net ${formatUsd(Math.abs(netFlow))} from ${side}`,
      );
    }
    const added = nonNegativeInteger(followthrough.addedWallets);
    const joined = nonNegativeInteger(followthrough.joinedWallets);
    const trimmed = nonNegativeInteger(followthrough.trimmedWallets);
    const exited = nonNegativeInteger(followthrough.exitedWallets);
    const holding = nonNegativeInteger(followthrough.stillHoldingWallets);
    const activity: string[] = [];
    if (joined > 0) activity.push(`${joined} joined`);
    if (added > 0) activity.push(`${added} added`);
    if (trimmed > 0) activity.push(`${trimmed} trimmed`);
    if (exited > 0) activity.push(`${exited} exited`);
    if (activity.length > 0) {
      detail.push(
        `${activity.join(", ")}${holding > 0 ? `, and ${holding} ${holding === 1 ? "is" : "are"} still holding` : ""}`,
      );
    } else if (holding > 0) {
      detail.push(`${holding} tracked wallets are still holding`);
    }
    const pnl = finiteNumber(
      state === "resolved"
        ? followthrough.estimatedRealizedPnlUsd
        : followthrough.estimatedOpenPnlUsd,
    );
    if (pnl != null && Math.abs(pnl) >= 1) {
      detail.push(
        `Estimated ${state === "resolved" ? "realized" : "open"} PnL is ${formatUsd(pnl, { signed: true })}`,
      );
    }
    body = sentence(detail.join(". "));
    usedFactIds = ["original_signal", "followthrough"];
  }

  const postText = clipVisibleText(
    [opening, body].filter(Boolean).join("\n\n"),
  );
  if (!postText.includes(opening))
    opening = postText.split("\n")[0] ?? postText;
  return {
    characterCount: Array.from(postText).length,
    formatting: opening.length >= 2 ? [{ style: "bold", text: opening }] : [],
    generatedAt: new Date().toISOString(),
    marketId: input.source.marketId,
    model: "deterministic_editorial_fallback_v1",
    postText,
    promptVersion: "x_editorial_prompt_v4",
    safetyFlags: [`composer_fallback:${input.failureCode}`],
    selectedSide: input.source.selectedSide,
    sourceDigest: buildXEditorialSourceDigest(input.source),
    status: "ready",
    storyFamily,
    usedFactIds,
    version: 1,
  };
}

export function buildXEditorialTelegramDraftMessage(input: {
  draft: XEditorialDraftV1;
  miniAppUrl?: string;
  websiteUrl?: string;
}): string {
  const postText = input.draft.postText ?? "";
  const ranges: Array<{
    end: number;
    marker: "*" | "_";
    start: number;
  }> = [];
  for (const span of input.draft.formatting) {
    const start = postText.indexOf(span.text);
    const end = start + span.text.length;
    if (
      start < 0 ||
      span.text.includes("\n") ||
      postText.indexOf(span.text, end) >= 0 ||
      ranges.some((range) => start < range.end && end > range.start)
    ) {
      continue;
    }
    ranges.push({
      end,
      marker: span.style === "bold" ? "*" : "_",
      start,
    });
  }
  ranges.sort((left, right) => left.start - right.start);
  const formattedPost: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    formattedPost.push(escapeMarkdownV2(postText.slice(cursor, range.start)));
    formattedPost.push(
      `${range.marker}${escapeMarkdownV2(postText.slice(range.start, range.end))}${range.marker}`,
    );
    cursor = range.end;
  }
  formattedPost.push(escapeMarkdownV2(postText.slice(cursor)));
  const links = [
    buildVisibleLink("🌐 Website", input.websiteUrl),
    buildVisibleLink("📱 Telegram Mini App", input.miniAppUrl),
  ].filter((line): line is string => line != null);
  return [formattedPost.join(""), ...links].join("\n\n");
}

async function deliverDraft(input: {
  baselineAt: string;
  chatId: string;
  composer: XEditorialDraftComposer;
  db: DbQuery;
  messageKind: XEditorialMessageKind;
  noteId: string;
  source: XEditorialDraftSource;
  telegram: SignalBotTelegramClient;
  threadRootNoteId: string;
}): Promise<SignalBotXEditorialPublicationResult> {
  const existing = await loadDelivery(input);
  const existingMetrics = asObject(existing?.metrics);
  if (existing?.telegram_message_id != null) {
    return { status: "already_sent" };
  }
  const existingDeliveryState = asObject(existingMetrics.deliveryStateV2);
  const existingStatus = asTrimmedString(
    existingDeliveryState.status ?? existingMetrics.status,
  );
  const existingComposerMetrics = asObject(existingMetrics.editorialComposerV1);
  const existingComposerFailure = asComposerFailureCode(
    existingComposerMetrics.outcome,
  );
  const persistedDraft = parsePersistedXEditorialDraft(
    existingMetrics.editorialDraftV1,
  );
  const recoverTerminalSkip =
    existingStatus === "skipped" &&
    (existingComposerFailure != null || persistedDraft?.status === "blocked");
  if (existingStatus === "delivery_unknown") {
    return { status: "delivery_unknown" };
  }
  if (
    existingStatus === "blocked" ||
    (existingStatus === "skipped" && !recoverTerminalSkip)
  ) {
    if (existingStatus === "skipped" && existingComposerFailure != null) {
      return {
        composerOutcome: existingComposerFailure,
        status: "compose_failed",
      };
    }
    return { blockedChat: existingStatus === "blocked", status: "blocked" };
  }
  let draft: XEditorialDraftV1;
  let composerMetrics: Record<string, unknown> = existingComposerMetrics;
  let fallbackMetrics: Record<string, unknown> | null = null;
  if (recoverTerminalSkip) {
    const reason = existingComposerFailure ?? "model_blocked";
    draft = buildFallbackPost({ failureCode: reason, source: input.source });
    composerMetrics = {
      ...existingComposerMetrics,
      fallbackUsed: true,
      outcome: reason,
      retryable: false,
      terminal: false,
      updatedAt: new Date().toISOString(),
    };
    fallbackMetrics = {
      reason,
      recoveredTerminalSkip: true,
      used: true,
      version: 1,
    };
    console.warn("[signal-bot:x-editorial] composer_fallback_recovery", {
      chatId: input.chatId,
      messageKind: input.messageKind,
      noteId: input.noteId,
      reason,
    });
  } else if (
    persistedDraft?.marketId === input.source.marketId &&
    persistedDraft.selectedSide === input.source.selectedSide
  ) {
    draft = persistedDraft;
    composerMetrics =
      Object.keys(existingComposerMetrics).length > 0
        ? existingComposerMetrics
        : buildComposerMetrics({
            attemptCount: Math.max(
              1,
              asNonNegativeInteger(existingComposerMetrics.attemptCount),
            ),
            existing: existingComposerMetrics,
            outcome: draft.status === "blocked" ? "model_blocked" : "ready",
            terminal: draft.status === "blocked",
          });
  } else {
    const attemptCount =
      asNonNegativeInteger(existingComposerMetrics.attemptCount) + 1;
    try {
      draft = await input.composer({ source: input.source });
    } catch (error) {
      const failure = readXEditorialComposerFailure(error);
      draft = buildFallbackPost({
        failureCode: failure.code,
        source: input.source,
      });
      composerMetrics = buildComposerMetrics({
        attemptCount,
        existing: existingComposerMetrics,
        fallbackUsed: true,
        outcome: failure.code,
        terminal: false,
      });
      fallbackMetrics = {
        error: failure.message.slice(0, 500),
        issues: failure.issues.slice(0, 20),
        reason: failure.code,
        used: true,
        version: 1,
      };
      console.warn("[signal-bot:x-editorial] composer_fallback", {
        chatId: input.chatId,
        issues: failure.issues.slice(0, 20),
        messageKind: input.messageKind,
        noteId: input.noteId,
        reason: failure.code,
      });
    }
    if (!fallbackMetrics) {
      if (draft.status === "blocked" || !draft.postText) {
        const blockedDraft = draft;
        draft = buildFallbackPost({
          failureCode: "model_blocked",
          source: input.source,
        });
        fallbackMetrics = {
          reason: "model_blocked",
          safetyFlags: blockedDraft.safetyFlags,
          used: true,
          version: 1,
        };
        console.warn("[signal-bot:x-editorial] composer_fallback", {
          chatId: input.chatId,
          messageKind: input.messageKind,
          noteId: input.noteId,
          reason: "model_blocked",
          safetyFlags: blockedDraft.safetyFlags,
        });
      }
      composerMetrics = buildComposerMetrics({
        attemptCount,
        existing: existingComposerMetrics,
        fallbackUsed: fallbackMetrics != null,
        outcome: fallbackMetrics ? "model_blocked" : "ready",
        terminal: false,
      });
    }
  }
  const baseMetrics = {
    contentProfile: X_EDITORIAL_CONTENT_PROFILE,
    editorialComposerV1: composerMetrics,
    editorialDraftV1: draft,
    ...(fallbackMetrics ? { editorialFallbackV1: fallbackMetrics } : {}),
  };
  const reservation = await reserveSignalBotMessageDelivery({
    baselineAt: input.baselineAt,
    baseMetrics,
    chatId: input.chatId,
    db: input.db,
    messageKind: input.messageKind,
    noteId: input.noteId,
    recoverTerminalSkip,
    replyToMessageId: null,
    threadRootNoteId: input.threadRootNoteId,
  });
  if (reservation.status === "terminal") {
    if (reservation.outcome === "sent") return { status: "already_sent" };
    if (reservation.outcome === "delivery_unknown") {
      return { status: "delivery_unknown" };
    }
    return {
      blockedChat: reservation.outcome === "blocked",
      status: "blocked",
    };
  }
  if (reservation.status !== "acquired") {
    return { blockedChat: false, status: "retry" };
  }
  if (draft.status === "blocked" || !draft.postText) {
    await finishSignalBotMessageDelivery({
      attemptId: reservation.attemptId,
      db: input.db,
      deliveryRef: reservation.deliveryRef,
      expectedStatus: "reserved",
      metrics: baseMetrics,
      status: "skipped",
    });
    return {
      blockedChat: false,
      composerOutcome: "model_blocked",
      status: "blocked",
    };
  }
  const began = await beginSignalBotMessageDelivery({
    attemptId: reservation.attemptId,
    db: input.db,
    deliveryRef: reservation.deliveryRef,
  });
  if (!began) return { blockedChat: false, status: "retry" };
  const result = await input.telegram.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: true,
    parse_mode: "MarkdownV2",
    text: buildXEditorialTelegramDraftMessage({
      draft,
      miniAppUrl: input.source.miniAppUrl,
      websiteUrl: input.source.websiteUrl,
    }),
  });
  if (!result.ok) {
    const status =
      result.error === "ambiguous"
        ? "delivery_unknown"
        : result.error === "blocked_or_missing"
          ? "blocked"
          : "retry";
    await finishSignalBotMessageDelivery({
      attemptId: reservation.attemptId,
      db: input.db,
      deliveryRef: reservation.deliveryRef,
      errorCode: result.error,
      expectedStatus: "sending",
      metrics: baseMetrics,
      nextAttemptAt:
        status === "retry"
          ? new Date(Date.now() + (result.retryAfterSec ?? 60) * 1_000)
          : null,
      status,
    });
    if (status === "delivery_unknown") return { status };
    if (status === "blocked") return { blockedChat: true, status };
    return { blockedChat: false, status };
  }
  await finishSignalBotMessageDelivery({
    attemptId: reservation.attemptId,
    db: input.db,
    deliveryRef: reservation.deliveryRef,
    expectedStatus: "sending",
    messageId: result.messageId,
    metrics: baseMetrics,
    status: "sent",
  });
  return { status: "sent" };
}

export async function publishXEditorialNote(input: {
  appBaseUrl: string;
  baselineAt: string;
  chatId: string;
  composer?: XEditorialDraftComposer;
  db: DbQuery;
  kind: "initial" | "research_update";
  note: SignalBotNote;
  selectedSide: "NO" | "YES";
  telegram: SignalBotTelegramClient;
  telegramMiniAppLinkBase: string | null;
  threadRootNoteId: string;
}): Promise<SignalBotXEditorialPublicationResult> {
  const reason = validateInitialSource(input);
  if (reason) return { reason, status: "invalid" };
  if (!input.composer) return { status: "unavailable" };
  const composer = input.composer;
  const recentOpenings = await loadRecentOpenings(input);
  return deliverDraft({
    ...input,
    composer,
    messageKind: input.kind,
    noteId: input.note.id,
    source: buildInitialSource({ ...input, recentOpenings }),
  });
}

export async function publishXEditorialFollowthrough(input: {
  appBaseUrl: string;
  baselineAt: string;
  candidate: SignalBotFollowthroughCandidateRow;
  composer?: XEditorialDraftComposer;
  db: DbQuery;
  kind: Extract<
    XEditorialMessageKind,
    "followthrough_stats" | "resolved_loss" | "resolved_win"
  >;
  stats: SignalBotFollowthroughStats;
  telegram: SignalBotTelegramClient;
  telegramMiniAppLinkBase: string | null;
}): Promise<SignalBotXEditorialPublicationResult> {
  if (!input.stats.signalSide) {
    return { reason: "non_directional", status: "invalid" };
  }
  if (!input.composer) return { status: "unavailable" };
  const composer = input.composer;
  const chatId = input.candidate.chat_id;
  const recentOpenings = await loadRecentOpenings({
    chatId,
    db: input.db,
  });
  return deliverDraft({
    baselineAt: input.baselineAt,
    chatId,
    composer,
    db: input.db,
    messageKind: input.kind,
    noteId: input.candidate.thread_root_note_id,
    source: buildFollowthroughSource({ ...input, recentOpenings }),
    telegram: input.telegram,
    threadRootNoteId: input.candidate.thread_root_note_id,
  });
}
