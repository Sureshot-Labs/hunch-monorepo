import type { PoolClient } from "pg";

import { resolveWalletIntelRefreshPolicy } from "./runtime-policies.js";

type Queryable = Pick<PoolClient, "query">;

export type WalletTrackingSubjectVenue = "polymarket" | "limitless" | "kalshi";

export type WalletTrackingSubjectSource =
  | "whale"
  | "recent_top_holder"
  | "signal_candidate";

export type WalletTrackingSubjectInput = {
  walletId: string;
  venue: WalletTrackingSubjectVenue;
  source: WalletTrackingSubjectSource;
  priority?: number | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  selectedAt?: Date | null;
};

function normalizePriority(priority: number | null | undefined): number {
  if (priority == null || !Number.isFinite(priority)) return 100;
  return Math.max(0, Math.min(10_000, Math.trunc(priority)));
}

function normalizeSubjectKey(subject: WalletTrackingSubjectInput): string {
  return `${subject.walletId}:${subject.venue}:${subject.source}`;
}

export async function upsertWalletTrackingSubjects(
  client: Queryable,
  subjects: WalletTrackingSubjectInput[],
): Promise<number> {
  if (subjects.length === 0) return 0;

  const deduped = new Map<string, WalletTrackingSubjectInput>();
  for (const subject of subjects) {
    const key = normalizeSubjectKey(subject);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, subject);
      continue;
    }
    if (
      normalizePriority(subject.priority) > normalizePriority(existing.priority)
    ) {
      deduped.set(key, subject);
    }
  }

  let upserted = 0;
  for (const subject of deduped.values()) {
    const result = await client.query(
      `
        insert into wallet_tracking_subjects (
          wallet_id,
          venue,
          source,
          status,
          priority,
          reason,
          metadata,
          last_selected_at
        ) values ($1, $2, $3, 'active', $4, $5, $6::jsonb, $7)
        on conflict (wallet_id, venue, source)
        do update set
          status = 'active',
          priority = excluded.priority,
          reason = excluded.reason,
          metadata = coalesce(wallet_tracking_subjects.metadata, '{}'::jsonb)
            || coalesce(excluded.metadata, '{}'::jsonb),
          last_selected_at = greatest(
            coalesce(wallet_tracking_subjects.last_selected_at, 'epoch'::timestamptz),
            coalesce(excluded.last_selected_at, 'epoch'::timestamptz)
          ),
          updated_at = now()
      `,
      [
        subject.walletId,
        subject.venue,
        subject.source,
        normalizePriority(subject.priority),
        subject.reason ?? null,
        JSON.stringify(subject.metadata ?? {}),
        subject.selectedAt ?? new Date(),
      ],
    );
    upserted += result.rowCount ?? 0;
  }
  return upserted;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

export async function resolveWalletTrackingSubjectsEnabled(
  client: Queryable,
): Promise<boolean> {
  const policy = await resolveWalletIntelRefreshPolicy(client);
  return parseBoolean(policy.effective.autoTrackedWalletEnabled) === true;
}
