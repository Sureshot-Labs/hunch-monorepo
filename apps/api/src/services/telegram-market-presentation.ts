import { z } from "zod";

import {
  buildMarketSideCopyPair,
  cleanPublicMarketText,
  type MarketSideCopyInput,
} from "./market-side-copy.js";

const cleanText = (value: string | null | undefined): string | null => {
  return cleanPublicMarketText(value);
};

const presentationPositionSchema = z
  .object({
    canonicalLabel: z.string().trim().min(1).max(160),
    shortLabel: z.string().trim().min(1).max(64),
    aliases: z.array(z.string().trim().min(1).max(160)).max(20),
  })
  .strict();

export const telegramMarketPresentationOverrideSchema = z
  .object({
    version: z.literal(1),
    reviewStatus: z.literal("approved"),
    subject: z.string().trim().min(1).max(320),
    predicate: z.string().trim().min(1).max(320),
    threshold: z.string().trim().min(1).max(120).nullable(),
    deadline: z.string().trim().min(1).max(120).nullable(),
    positions: z
      .object({
        YES: presentationPositionSchema,
        NO: presentationPositionSchema,
      })
      .strict(),
    provenance: z
      .object({
        reviewedBy: z.string().uuid(),
        reviewedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export const telegramMarketPresentationDraftSchema =
  telegramMarketPresentationOverrideSchema.omit({
    reviewStatus: true,
    provenance: true,
  });

export type TelegramMarketPresentationOverrideV1 = z.infer<
  typeof telegramMarketPresentationOverrideSchema
>;

export type TelegramMarketPresentationV1 = {
  version: 1;
  source: "approved_override" | "derived_market_side_copy" | "safe_fallback";
  subject: string;
  predicate: string;
  threshold: string | null;
  deadline: string | null;
  positions: Record<
    "YES" | "NO",
    {
      canonicalLabel: string;
      shortLabel: string;
      aliases: string[];
    }
  >;
};

export const telegramMarketPresentationSchema = z
  .object({
    version: z.literal(1),
    source: z.enum([
      "approved_override",
      "derived_market_side_copy",
      "safe_fallback",
    ]),
    subject: z.string().trim().min(1).max(320),
    predicate: z.string().trim().min(1).max(320),
    threshold: z.string().trim().min(1).max(120).nullable(),
    deadline: z.string().trim().min(1).max(120).nullable(),
    positions: z
      .object({
        YES: presentationPositionSchema,
        NO: presentationPositionSchema,
      })
      .strict(),
  })
  .strict();

export type TelegramMarketPresentationInput = Omit<
  MarketSideCopyInput,
  "side"
> & {
  closeTime?: string | null;
  expirationTime?: string | null;
  metadata?: unknown;
};

export type ResolvedTelegramMarketPresentation = {
  diagnostics: Array<"alias_conflict" | "invalid_override" | "safe_fallback">;
  presentation: TelegramMarketPresentationV1;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readTelegramMarketPresentationOverride(metadata: unknown): {
  invalid: boolean;
  value: TelegramMarketPresentationOverrideV1 | null;
} {
  const root = asRecord(metadata);
  const hunch = asRecord(root?.hunch);
  const raw = hunch?.telegramPresentationV1;
  if (raw == null) return { invalid: false, value: null };
  const parsed = telegramMarketPresentationOverrideSchema.safeParse(raw);
  return parsed.success
    ? { invalid: false, value: parsed.data }
    : { invalid: true, value: null };
}

export function resolvePersistedOrCurrentTelegramMarketPresentation(
  input: TelegramMarketPresentationInput & {
    marketMetadata?: unknown;
    metrics?: Record<string, unknown> | null;
  },
): TelegramMarketPresentationV1 {
  const persisted = telegramMarketPresentationSchema.safeParse(
    input.metrics?.telegramPresentation,
  );
  if (persisted.success) return persisted.data;
  return resolveTelegramMarketPresentation({
    ...input,
    metadata: input.marketMetadata ?? input.metadata,
  }).presentation;
}

function normalizedKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function uniqueLabels(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned) continue;
    const key = normalizedKey(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function hasAliasConflict(
  override: TelegramMarketPresentationOverrideV1,
): boolean {
  const yes = new Set(
    uniqueLabels([
      override.positions.YES.canonicalLabel,
      override.positions.YES.shortLabel,
      ...override.positions.YES.aliases,
    ]).map(normalizedKey),
  );
  return uniqueLabels([
    override.positions.NO.canonicalLabel,
    override.positions.NO.shortLabel,
    ...override.positions.NO.aliases,
  ]).some((label) => yes.has(normalizedKey(label)));
}

function derivedPresentation(
  input: TelegramMarketPresentationInput,
): TelegramMarketPresentationV1 {
  const copies = buildMarketSideCopyPair(input);
  const eventTitle = cleanText(input.eventTitle);
  const marketTitle = cleanText(input.marketTitle);
  const subject = eventTitle ?? marketTitle ?? "This market";
  const predicate =
    marketTitle && normalizedKey(marketTitle) !== normalizedKey(subject)
      ? marketTitle
      : subject;
  const source =
    eventTitle || marketTitle ? "derived_market_side_copy" : "safe_fallback";
  return {
    version: 1,
    source,
    subject,
    predicate,
    threshold: copies.YES.winCondition ?? copies.NO.winCondition,
    deadline: cleanText(input.closeTime) ?? cleanText(input.expirationTime),
    positions: {
      YES: {
        canonicalLabel: copies.YES.sideLabel,
        shortLabel: copies.YES.buttonLabel,
        aliases: uniqueLabels([
          copies.YES.rawOutcomeLabel,
          copies.YES.priceLabel,
          copies.YES.sideLabel,
        ]),
      },
      NO: {
        canonicalLabel: copies.NO.sideLabel,
        shortLabel: copies.NO.buttonLabel,
        aliases: uniqueLabels([
          copies.NO.rawOutcomeLabel,
          copies.NO.priceLabel,
          copies.NO.sideLabel,
        ]),
      },
    },
  };
}

function safeRawPresentation(
  input: TelegramMarketPresentationInput,
): TelegramMarketPresentationV1 {
  const marketTitle = cleanText(input.marketTitle);
  const eventTitle = cleanText(input.eventTitle);
  const proposition = marketTitle ?? eventTitle ?? "This market";
  return {
    version: 1,
    source: "safe_fallback",
    subject: eventTitle ?? proposition,
    predicate: proposition,
    threshold: null,
    deadline: cleanText(input.closeTime) ?? cleanText(input.expirationTime),
    positions: {
      YES: {
        canonicalLabel: `YES on ${proposition}`,
        shortLabel: "YES",
        aliases: [],
      },
      NO: {
        canonicalLabel: `NO on ${proposition}`,
        shortLabel: "NO",
        aliases: [],
      },
    },
  };
}

export function resolveTelegramMarketPresentation(
  input: TelegramMarketPresentationInput,
): ResolvedTelegramMarketPresentation {
  const parsed = readTelegramMarketPresentationOverride(input.metadata);
  if (parsed.value && !hasAliasConflict(parsed.value)) {
    return {
      diagnostics: [],
      presentation: {
        version: 1,
        source: "approved_override",
        subject: parsed.value.subject,
        predicate: parsed.value.predicate,
        threshold: parsed.value.threshold,
        deadline: parsed.value.deadline,
        positions: parsed.value.positions,
      },
    };
  }

  if (parsed.value && hasAliasConflict(parsed.value)) {
    return {
      diagnostics: ["alias_conflict", "safe_fallback"],
      presentation: safeRawPresentation(input),
    };
  }

  const presentation = derivedPresentation(input);
  return {
    diagnostics: [
      ...(parsed.invalid ? (["invalid_override"] as const) : []),
      ...(presentation.source === "safe_fallback"
        ? (["safe_fallback"] as const)
        : []),
    ],
    presentation,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTelegramPresentationAliases(
  text: string,
  presentation: TelegramMarketPresentationV1,
): string {
  let normalized = text;
  const protectedLabels = uniqueLabels(
    (["YES", "NO"] as const).map(
      (side) => presentation.positions[side].canonicalLabel,
    ),
  );
  const placeholders: Array<{ label: string; token: string }> = [];
  let nextPlaceholderCodePoint = 0xe000;
  for (const label of protectedLabels) {
    normalized = normalized.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegExp(label)}(?![\\p{L}\\p{N}])`,
        "giu",
      ),
      (matched) => {
        let token = String.fromCodePoint(nextPlaceholderCodePoint++);
        while (text.includes(token) || normalized.includes(token)) {
          token = String.fromCodePoint(nextPlaceholderCodePoint++);
        }
        placeholders.push({ label: matched, token });
        return token;
      },
    );
  }
  for (const side of ["YES", "NO"] as const) {
    const position = presentation.positions[side];
    const aliases = uniqueLabels(position.aliases)
      .filter(
        (alias) =>
          normalizedKey(alias) !== normalizedKey(position.canonicalLabel),
      )
      .sort((left, right) => right.length - left.length);
    for (const alias of aliases) {
      normalized = normalized.replace(
        new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(alias)}(?![\\p{L}\\p{N}])`,
          "giu",
        ),
        position.canonicalLabel,
      );
    }
  }
  for (const { label, token } of placeholders) {
    normalized = normalized.split(token).join(label);
  }
  return normalized;
}
