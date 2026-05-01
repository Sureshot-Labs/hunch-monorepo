import { isRecord } from "./type-guards.js";

export type MetadataRecord = Record<string, unknown>;

export function parseMetadata(input: unknown): MetadataRecord | null {
  if (!input) return null;
  if (isRecord(input)) return input;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function pickString(
  obj: MetadataRecord | null,
  key: string,
): string | undefined {
  const value = normalizeString(obj?.[key]);
  return value ?? undefined;
}

function pickFirstMetadataString(
  metadata: unknown,
  keys: readonly string[],
): string | null {
  const obj = parseMetadata(metadata);
  if (!obj) return null;
  for (const key of keys) {
    const value = normalizeString(obj[key]);
    if (value) return value;
  }
  return null;
}

export function resolveEventDescription(
  description: unknown,
  metadata: unknown,
): string | null {
  return (
    normalizeString(description) ??
    pickFirstMetadataString(metadata, [
      "description",
      "subtitle",
      "subTitle",
      "sub_title",
    ])
  );
}

export function resolveMarketDescription(
  description: unknown,
  metadata: unknown,
): string | null {
  return (
    normalizeString(description) ??
    pickFirstMetadataString(metadata, [
      "description",
      "rulesPrimary",
      "rules_primary",
      "rulesSecondary",
      "rules_secondary",
      "subtitle",
      "subTitle",
      "sub_title",
      "yesSubTitle",
      "yes_sub_title",
      "noSubTitle",
      "no_sub_title",
      "earlyCloseCondition",
      "early_close_condition",
    ])
  );
}
