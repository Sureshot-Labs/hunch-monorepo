import type { DbQuery } from "../db.js";
import { isSignalBotQuoteFresh } from "./signal-bot-delivery-policy.js";
import { createSignalDeliveryRef } from "./signal-delivery-attribution.js";
import { parseTelegramMarketIdentityV1 } from "./signal-publication-contract.js";
import type {
  SignalBotDeliveryPreparationReason,
  SignalBotFollowthroughCandidateRow,
  SignalBotFollowthroughStats,
  SignalBotNote,
  SignalBotTelegramClient,
  TelegramInlineKeyboard,
} from "./signal-bot-contracts.js";
import {
  parsePersistedXEditorialDraft,
  X_EDITORIAL_CONTENT_PROFILE,
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

export type SignalBotXEditorialPublicationResult =
  | { status: "already_sent" | "blocked" | "sent" }
  | { blockedChat: boolean; status: "retry" }
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
  url.searchParams.set("utm_source", "telegram_signal_bot");
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
  return {
    facts,
    kind: input.kind,
    marketId: note.marketId ?? identity?.marketId ?? note.id,
    noteId: note.id,
    recentOpenings: input.recentOpenings,
    selectedSide: input.selectedSide,
    sourceUrls: [marketUrl, ...external.urls].filter(isSafeHttpUrl).slice(0, 3),
  };
}

function validateInitialSource(input: {
  kind: "initial" | "research_update";
  note: SignalBotNote;
  now?: Date;
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
  const asOfMs = Date.parse(price.asOf);
  const nowMs = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(asOfMs) ||
    asOfMs > nowMs ||
    !isSignalBotQuoteFresh(asOfMs, nowMs)
  ) {
    return "stale_price_snapshot";
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
    noteId: input.candidate.thread_root_note_id,
    recentOpenings: input.recentOpenings,
    selectedSide: input.stats.signalSide as "NO" | "YES",
    sourceUrls: [marketUrl].filter(isSafeHttpUrl),
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

function buildKeyboard(
  sourceUrls: string[] | undefined,
): TelegramInlineKeyboard | undefined {
  const urls = [...new Set((sourceUrls ?? []).filter(isSafeHttpUrl))].slice(
    0,
    3,
  );
  if (urls.length === 0) return undefined;
  return {
    inline_keyboard: [
      urls.map((url, index) => ({
        text: index === 0 ? "Market" : `Source ${index}`,
        url,
      })),
    ],
  };
}

async function recordMessage(input: {
  baselineAt: string;
  chatId: string;
  db: DbQuery;
  insertId: string;
  messageId: number | null;
  messageKind: XEditorialMessageKind;
  metrics: unknown;
  noteId: string;
  threadRootNoteId: string;
}): Promise<boolean> {
  try {
    await input.db.query(
      `
        insert into signal_bot_messages (
          id,
          chat_id,
          note_id,
          thread_root_note_id,
          message_kind,
          telegram_message_id,
          reply_to_message_id,
          baseline_at,
          sent_at,
          metrics
        )
        values ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::jsonb)
        on conflict (chat_id, note_id, message_kind)
        do update set
          telegram_message_id = excluded.telegram_message_id,
          reply_to_message_id = excluded.reply_to_message_id,
          baseline_at = excluded.baseline_at,
          sent_at = excluded.sent_at,
          metrics = excluded.metrics
      `,
      [
        input.insertId,
        input.chatId,
        input.noteId,
        input.threadRootNoteId,
        input.messageKind,
        input.messageId,
        null,
        input.baselineAt,
        new Date().toISOString(),
        JSON.stringify(input.metrics),
      ],
    );
    return true;
  } catch (error) {
    if (isMissingSignalBotMessagesTable(error)) return false;
    console.warn("[signal-bot] failed to record X editorial delivery", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
      messageKind: input.messageKind,
      noteId: input.noteId,
    });
    return false;
  }
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
  if (
    existing?.telegram_message_id != null &&
    existingMetrics.status === "sent"
  ) {
    return { status: "already_sent" };
  }
  const persistedDraft = parsePersistedXEditorialDraft(
    existingMetrics.editorialDraftV1,
  );
  let draft: XEditorialDraftV1;
  if (
    persistedDraft?.marketId === input.source.marketId &&
    persistedDraft.selectedSide === input.source.selectedSide
  ) {
    draft = persistedDraft;
  } else {
    try {
      draft = await input.composer({ source: input.source });
    } catch (error) {
      await recordMessage({
        ...input,
        insertId: existing?.id ?? createSignalDeliveryRef(),
        messageId: null,
        metrics: {
          contentProfile: X_EDITORIAL_CONTENT_PROFILE,
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : String(error),
          status: "compose_failed",
        },
      });
      return { blockedChat: false, status: "retry" };
    }
  }
  const baseMetrics = {
    contentProfile: X_EDITORIAL_CONTENT_PROFILE,
    editorialDraftV1: draft,
  };
  if (draft.status === "blocked" || !draft.postText) {
    await recordMessage({
      ...input,
      insertId: existing?.id ?? createSignalDeliveryRef(),
      messageId: null,
      metrics: { ...baseMetrics, status: "skipped" },
    });
    return { status: "blocked" };
  }
  const prepared = await recordMessage({
    ...input,
    insertId: existing?.id ?? createSignalDeliveryRef(),
    messageId: null,
    metrics: { ...baseMetrics, status: "prepared" },
  });
  if (!prepared) return { blockedChat: false, status: "retry" };
  const result = await input.telegram.sendMessage({
    chat_id: input.chatId,
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(input.source.sourceUrls),
    text: draft.postText,
  });
  if (!result.ok) {
    await recordMessage({
      ...input,
      insertId: existing?.id ?? createSignalDeliveryRef(),
      messageId: null,
      metrics: {
        ...baseMetrics,
        error: result.message.slice(0, 500),
        status: "send_failed",
      },
    });
    return {
      blockedChat: result.error === "blocked_or_missing",
      status: "retry",
    };
  }
  await recordMessage({
    ...input,
    insertId: existing?.id ?? createSignalDeliveryRef(),
    messageId: result.messageId,
    metrics: { ...baseMetrics, status: "sent" },
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
