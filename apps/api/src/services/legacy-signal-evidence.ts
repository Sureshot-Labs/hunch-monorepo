import {
  selectTelegramSignalEvidence,
  type SignalEvidenceMetricV1,
} from "./holder-research-signal-evidence.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isSignalEvidenceMetric(
  value: unknown,
): value is SignalEvidenceMetricV1 {
  const row = asRecord(value);
  const measurement = asRecord(row.measurement);
  return (
    typeof row.id === "string" &&
    typeof row.kind === "string" &&
    typeof row.scope === "string" &&
    typeof row.asOf === "string" &&
    (measurement.kind === "scalar" || measurement.kind === "range")
  );
}

function parseCompactUsd(value: string): number | null {
  const match = value.trim().match(/^\$([0-9][0-9,.]*)([KMB])?$/i);
  if (!match?.[1]) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const multiplier =
    match[2]?.toUpperCase() === "B"
      ? 1_000_000_000
      : match[2]?.toUpperCase() === "M"
        ? 1_000_000
        : match[2]?.toUpperCase() === "K"
          ? 1_000
          : 1;
  return amount * multiplier;
}

function baseEvidence(input: {
  asOf: string;
  id: string;
  kind: SignalEvidenceMetricV1["kind"];
  scope: SignalEvidenceMetricV1["scope"];
}): Pick<
  SignalEvidenceMetricV1,
  "id" | "kind" | "scope" | "asOf" | "quality" | "source"
> {
  return {
    id: input.id,
    kind: input.kind,
    scope: input.scope,
    asOf: input.asOf,
    quality: "estimated",
    source: {
      kind: "legacy_credential_copy",
      label: "Legacy holder research",
      url: null,
    },
  };
}

export function parseLegacySignalEvidence(input: {
  asOf: string;
  bullets: string[];
}): SignalEvidenceMetricV1[] {
  const rows: SignalEvidenceMetricV1[] = [];
  for (const [index, bullet] of input.bullets.entries()) {
    const trackRecord = bullet.match(
      /^Up (\$[0-9][0-9,.]*(?:[KMB])?)(?: combined)? over the last (\d+) days?$/i,
    );
    const trackRecordUsd = trackRecord?.[1]
      ? parseCompactUsd(trackRecord[1])
      : null;
    if (trackRecordUsd != null && trackRecord?.[2]) {
      rows.push({
        ...baseEvidence({
          asOf: input.asOf,
          id: `legacy:track_record:${index}`,
          kind: "track_record",
          scope: "representative_wallet",
        }),
        measurement: { kind: "scalar", value: trackRecordUsd, unit: "usd" },
        horizonDays: Number(trackRecord[2]),
        sampleSize: null,
        context: null,
      });
      continue;
    }

    const volume = bullet.match(
      /^Traded (\$[0-9][0-9,.]*(?:[KMB])?) over the last (\d+) days?$/i,
    );
    const volumeUsd = volume?.[1] ? parseCompactUsd(volume[1]) : null;
    if (volumeUsd != null && volume?.[2]) {
      rows.push({
        ...baseEvidence({
          asOf: input.asOf,
          id: `legacy:volume:${index}`,
          kind: "volume",
          scope: "representative_wallet",
        }),
        measurement: { kind: "scalar", value: volumeUsd, unit: "usd" },
        horizonDays: Number(volume[2]),
        sampleSize: null,
        context: null,
      });
      continue;
    }

    const conviction = bullet.match(
      /^([0-9]+) strong wallets? on the same side$/i,
    );
    if (conviction?.[1]) {
      rows.push({
        ...baseEvidence({
          asOf: input.asOf,
          id: `legacy:conviction:${index}`,
          kind: "conviction",
          scope: "wallet_cluster",
        }),
        measurement: {
          kind: "scalar",
          value: Number(conviction[1]),
          unit: "wallets",
        },
        horizonDays: null,
        sampleSize: Number(conviction[1]),
        context: null,
      });
      continue;
    }

    const capital = bullet.match(
      /^(\$[0-9][0-9,.]*(?:[KMB])?) tracked by strong wallets$/i,
    );
    const capitalUsd = capital?.[1] ? parseCompactUsd(capital[1]) : null;
    if (capitalUsd != null) {
      rows.push({
        ...baseEvidence({
          asOf: input.asOf,
          id: `legacy:capital:${index}`,
          kind: "capital",
          scope: "wallet_cluster",
        }),
        measurement: { kind: "scalar", value: capitalUsd, unit: "usd" },
        horizonDays: null,
        sampleSize: null,
        context: null,
      });
    }
  }
  return rows;
}

export function resolvePersistedSignalEvidence(input: {
  createdAt: string;
  holderCredentialBullets: string[];
  metrics?: unknown;
}): SignalEvidenceMetricV1[] {
  const metrics = asRecord(input.metrics);
  const persisted = Array.isArray(metrics.signalEvidence)
    ? metrics.signalEvidence.filter(isSignalEvidenceMetric)
    : [];

  // Versioned notes are typed-only. An intentionally empty typed snapshot must
  // never be reinterpreted through the legacy prose parser.
  const rows =
    metrics.signalEvidenceVersion === 1
      ? persisted
      : parseLegacySignalEvidence({
          asOf: input.createdAt,
          bullets: input.holderCredentialBullets,
        });
  return selectTelegramSignalEvidence(rows);
}
