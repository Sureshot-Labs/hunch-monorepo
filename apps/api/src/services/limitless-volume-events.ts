import type { Pool } from "@hunch/infra";
import { insertVolumeEventsWithMultiplier } from "./rewards-multiplier.js";

const LIMITLESS_VOLUME_SOURCE_PREFIX = "limitless:";

export function normalizeLimitlessVolumeSourceId(
  sourceId: string | null | undefined,
): string | null {
  const trimmed = sourceId?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(LIMITLESS_VOLUME_SOURCE_PREFIX)
    ? trimmed
    : `${LIMITLESS_VOLUME_SOURCE_PREFIX}${trimmed}`;
}

export async function recordLimitlessVolumeEvent(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string | null;
    sourceId: string | null | undefined;
    notionalUsd: number | null | undefined;
    createdAt: Date | null | undefined;
  },
): Promise<number> {
  const sourceId = normalizeLimitlessVolumeSourceId(inputs.sourceId);
  if (!sourceId) return 0;
  if (
    inputs.notionalUsd == null ||
    !Number.isFinite(inputs.notionalUsd) ||
    inputs.notionalUsd <= 0
  ) {
    return 0;
  }

  const createdAt =
    inputs.createdAt && !Number.isNaN(inputs.createdAt.getTime())
      ? inputs.createdAt
      : new Date();
  const result = await insertVolumeEventsWithMultiplier(pool, {
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "limitless",
    sourceType: "order",
    events: [
      {
        sourceId,
        notionalUsd: inputs.notionalUsd,
        createdAt,
      },
    ],
  });
  return result.inserted;
}
