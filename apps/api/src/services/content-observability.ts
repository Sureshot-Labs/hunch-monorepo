import type { DbQuery } from "../db.js";
import { env } from "../env.js";

type RouteMetric = {
  requests: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  totalResponseBytes: number;
  maxResponseBytes: number;
  lastResponseBytes: number;
  durationSamplesMs: number[];
};

const routeMetrics = new Map<string, RouteMetric>();
let revisionConflicts = 0;
let publicationCount = 0;
let publicationLagTotalMs = 0;
let publicationLagMaxMs = 0;
let publicationLagLastMs = 0;
let outboxRetries = 0;
let outboxDeadLetters = 0;
let publicationRetries = 0;
let publicationFailures = 0;
let storageDeletionRetries = 0;
let storageDeletionFailures = 0;
let retentionDeleted = 0;

const MAX_ROUTE_SAMPLES = 512;

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

function routeMetric(route: string): RouteMetric {
  const existing = routeMetrics.get(route);
  if (existing) return existing;
  const created: RouteMetric = {
    requests: 0,
    errors: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastDurationMs: 0,
    totalResponseBytes: 0,
    maxResponseBytes: 0,
    lastResponseBytes: 0,
    durationSamplesMs: [],
  };
  routeMetrics.set(route, created);
  return created;
}

export function recordContentRouteResponse(
  route: string,
  statusCode: number,
  durationMs: number,
  responseBytes: number,
) {
  const metric = routeMetric(route);
  metric.requests += 1;
  if (statusCode >= 500) metric.errors += 1;
  metric.totalDurationMs += durationMs;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
  metric.lastDurationMs = durationMs;
  metric.totalResponseBytes += responseBytes;
  metric.maxResponseBytes = Math.max(metric.maxResponseBytes, responseBytes);
  metric.lastResponseBytes = responseBytes;
  metric.durationSamplesMs.push(durationMs);
  if (metric.durationSamplesMs.length > MAX_ROUTE_SAMPLES) {
    metric.durationSamplesMs.splice(
      0,
      metric.durationSamplesMs.length - MAX_ROUTE_SAMPLES,
    );
  }
}

export function recordContentRevisionConflict() {
  revisionConflicts += 1;
}

export function recordContentPublicationLag(lagMs: number) {
  const bounded = Math.max(0, lagMs);
  publicationCount += 1;
  publicationLagTotalMs += bounded;
  publicationLagMaxMs = Math.max(publicationLagMaxMs, bounded);
  publicationLagLastMs = bounded;
}

export function recordContentOutboxRetry() {
  outboxRetries += 1;
}

export function recordContentOutboxDeadLetter() {
  outboxDeadLetters += 1;
}

export function recordContentPublicationRetry(terminal: boolean) {
  publicationRetries += 1;
  if (terminal) publicationFailures += 1;
}

export function recordContentStorageDeletionRetry(terminal: boolean) {
  storageDeletionRetries += 1;
  if (terminal) storageDeletionFailures += 1;
}

export function recordContentRetention(deleted: number) {
  retentionDeleted += Math.max(0, deleted);
}

export function getContentProcessMetrics() {
  return {
    editor_revision_conflicts_total: revisionConflicts,
    publication_completed_total: publicationCount,
    publication_retries_total: publicationRetries,
    publication_failures_total: publicationFailures,
    publication_lag_ms_last: Math.round(publicationLagLastMs),
    publication_lag_ms_max: Math.round(publicationLagMaxMs),
    publication_lag_ms_average:
      publicationCount === 0
        ? 0
        : Math.round(publicationLagTotalMs / publicationCount),
    outbox_retries_total: outboxRetries,
    outbox_dead_letters_total: outboxDeadLetters,
    storage_deletion_retries_total: storageDeletionRetries,
    storage_deletion_failures_total: storageDeletionFailures,
    retention_rows_deleted_total: retentionDeleted,
    public_routes: [...routeMetrics.entries()].map(([route, metric]) => ({
      route,
      requests_total: metric.requests,
      server_errors_total: metric.errors,
      duration_ms_last: Math.round(metric.lastDurationMs),
      duration_ms_p95_recent: Math.round(
        percentile(metric.durationSamplesMs, 0.95),
      ),
      duration_ms_max: Math.round(metric.maxDurationMs),
      response_bytes_max: metric.maxResponseBytes,
    })),
  };
}

type OperationalRow = {
  database_time: Date | string;
  scheduled_pending: string | number | bigint;
  scheduled_processing: string | number | bigint;
  scheduled_failed: string | number | bigint;
  overdue_publications: string | number | bigint;
  oldest_overdue_seconds: string | number | null;
  outbox_pending: string | number | bigint;
  outbox_retrying: string | number | bigint;
  outbox_dead_lettered: string | number | bigint;
  oldest_outbox_seconds: string | number | null;
  storage_deletion_pending: string | number | bigint;
  storage_deletion_failed: string | number | bigint;
  stale_assets: string | number | bigint;
};

export async function getContentOperationalStatus(db: DbQuery) {
  const { rows } = await db.query<OperationalRow>(
    `
      select
        now() as database_time,
        (select count(*) from content_publication_jobs where status = 'pending') as scheduled_pending,
        (select count(*) from content_publication_jobs where status = 'processing') as scheduled_processing,
        (select count(*) from content_publication_jobs where status = 'failed') as scheduled_failed,
        (
          select count(*) from content_publication_jobs
          where status = 'pending' and run_at <= now()
        ) as overdue_publications,
        (
          select extract(epoch from now() - min(run_at))
          from content_publication_jobs
          where status = 'pending' and run_at <= now()
        ) as oldest_overdue_seconds,
        (
          select count(*) from content_outbox
          where processed_at is null and dead_lettered_at is null
        ) as outbox_pending,
        (
          select count(*) from content_outbox
          where processed_at is null and dead_lettered_at is null and attempts > 0
        ) as outbox_retrying,
        (
          select count(*) from content_outbox where dead_lettered_at is not null
        ) as outbox_dead_lettered,
        (
          select extract(epoch from now() - min(created_at))
          from content_outbox
          where processed_at is null and dead_lettered_at is null
        ) as oldest_outbox_seconds,
        (
          select count(*) from content_storage_deletion_jobs
          where status in ('pending', 'processing')
        ) as storage_deletion_pending,
        (
          select count(*) from content_storage_deletion_jobs where status = 'failed'
        ) as storage_deletion_failed,
        (
          select count(*) from content_assets
          where (status = 'verifying' and updated_at < now() - interval '10 minutes')
             or (status = 'pending' and created_at < now() - interval '24 hours')
        ) as stale_assets
    `,
  );
  const row = rows[0];
  return {
    configuration: {
      publishingEnabled: env.contentPublishingEnabled,
      workerEnabled: env.contentWorkerEnabled,
      revalidationConfigured: Boolean(
        env.contentRevalidateUrl && env.contentRevalidateSecret,
      ),
      previewConfigured: Boolean(env.contentPreviewSecret),
      storageConfigured: Boolean(
        env.contentAssetS3Endpoint &&
        env.contentAssetS3Bucket &&
        env.contentAssetPublicBaseUrl,
      ),
    },
    database: {
      ready: true,
      time:
        row.database_time instanceof Date
          ? row.database_time.toISOString()
          : new Date(row.database_time).toISOString(),
    },
    scheduler: {
      pending: Number(row.scheduled_pending),
      processing: Number(row.scheduled_processing),
      failed: Number(row.scheduled_failed),
      overdue: Number(row.overdue_publications),
      oldestOverdueSeconds:
        row.oldest_overdue_seconds == null
          ? null
          : Number(row.oldest_overdue_seconds),
    },
    outbox: {
      pending: Number(row.outbox_pending),
      retrying: Number(row.outbox_retrying),
      deadLettered: Number(row.outbox_dead_lettered),
      oldestPendingSeconds:
        row.oldest_outbox_seconds == null
          ? null
          : Number(row.oldest_outbox_seconds),
      retriesSinceStart: outboxRetries,
    },
    storageDeletion: {
      pending: Number(row.storage_deletion_pending),
      failed: Number(row.storage_deletion_failed),
    },
    assets: { staleUploads: Number(row.stale_assets) },
    editor: { revisionConflictsSinceStart: revisionConflicts },
    publication: {
      completedSinceStart: publicationCount,
      lagMs: {
        last: Math.round(publicationLagLastMs),
        max: Math.round(publicationLagMaxMs),
        average:
          publicationCount === 0
            ? 0
            : Math.round(publicationLagTotalMs / publicationCount),
      },
    },
    publicRoutes: [...routeMetrics.entries()].map(([route, metric]) => ({
      route,
      requestsSinceStart: metric.requests,
      serverErrorsSinceStart: metric.errors,
      durationMs: {
        last: Math.round(metric.lastDurationMs),
        p95Recent: Math.round(percentile(metric.durationSamplesMs, 0.95)),
        max: Math.round(metric.maxDurationMs),
        average:
          metric.requests === 0
            ? 0
            : Math.round(metric.totalDurationMs / metric.requests),
      },
      responseBytes: {
        last: metric.lastResponseBytes,
        max: metric.maxResponseBytes,
        average:
          metric.requests === 0
            ? 0
            : Math.round(metric.totalResponseBytes / metric.requests),
      },
    })),
  };
}
