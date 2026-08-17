import { randomUUID } from "node:crypto";

import { tx, type Pool } from "@hunch/infra";

import { getContentServiceRuntime } from "../content-service-runtime.js";
import {
  deleteStoredContentObject,
  isContentStorageConfigured,
  reclaimStaleContentAssetUploads,
} from "./content-assets.js";
import {
  isContentRevalidationConfigured,
  notifyContentRevalidation,
  type ContentRevalidationEvent,
  type ContentRevalidationPayload,
} from "./content-revalidation.js";
import {
  recordContentOutboxDeadLetter,
  recordContentOutboxRetry,
  recordContentPublicationLag,
  recordContentPublicationRetry,
  recordContentRetention,
  recordContentStorageDeletionRetry,
} from "./content-observability.js";
import { promoteContentRoute } from "./content-routes.js";

type WorkerLogger = {
  info: (bindings: unknown, message?: string) => void;
  warn: (bindings: unknown, message?: string) => void;
};

type PublicationJobRow = {
  id: string | number | bigint;
  article_id: string;
  version_id: string;
  run_at: Date | string;
  attempts: number;
};

type ScheduledVersionRow = {
  id: string;
  slug: string;
  tag_slugs: string[];
  featured: boolean;
  created_by_admin_id: string | null;
};

type OutboxRow = {
  id: string | number | bigint;
  payload: unknown;
  attempts: number;
};

type StorageDeletionJobRow = {
  id: string | number | bigint;
  storage_key: string;
  attempts: number;
};

const REVALIDATION_EVENTS = new Set<ContentRevalidationEvent>([
  "article_updated",
  "article_published",
  "article_unpublished",
  "article_archived",
]);

function parseOutboxPayload(value: unknown): ContentRevalidationPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid content outbox payload");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.event !== "string" ||
    !REVALIDATION_EVENTS.has(payload.event as ContentRevalidationEvent) ||
    typeof payload.articleId !== "string" ||
    (payload.versionId !== null && typeof payload.versionId !== "string") ||
    typeof payload.slug !== "string" ||
    (payload.previousSlug !== null &&
      typeof payload.previousSlug !== "string") ||
    typeof payload.occurredAt !== "string"
  ) {
    throw new Error("Invalid content outbox payload fields");
  }
  return payload as ContentRevalidationPayload;
}

export async function publishDueContentVersions(
  pool: Pool,
  limit: number,
  workerId = `scheduler:${process.pid}:${randomUUID()}`,
  logger?: WorkerLogger,
): Promise<number> {
  await pool.query(
    `
      update content_publication_jobs
      set
        status = 'pending',
        locked_at = null,
        locked_by = null,
        run_at = least(run_at, now()),
        last_error = coalesce(last_error, 'reclaimed after stale processing lock')
      where status = 'processing'
        and locked_at < now() - interval '2 minutes'
    `,
  );
  let completed = 0;
  for (let index = 0; index < limit; index += 1) {
    let publicationLagMs: number | null = null;
    const job = await tx(pool, async (db) => {
      const { rows } = await db.query<PublicationJobRow>(
        `
          select id, article_id, version_id, run_at, attempts
          from content_publication_jobs
          where status = 'pending'
            and run_at <= now()
            and attempts < $1
          order by run_at, id
          for update skip locked
          limit 1
        `,
        [getContentServiceRuntime().workerMaxAttempts],
      );
      const job = rows[0];
      if (!job) return null;
      const { rows: claimedRows } = await db.query<PublicationJobRow>(
        `
          update content_publication_jobs
          set
            status = 'processing',
            attempts = attempts + 1,
            locked_at = now(),
            locked_by = $2,
            last_error = null
          where id = $1
          returning id, article_id, version_id, run_at, attempts
        `,
        [job.id, workerId],
      );
      return claimedRows[0];
    });
    if (!job) break;

    try {
      const didPublish = await tx(pool, async (db) => {
        // All article mutations take locks in article -> job order. Keeping the
        // scheduler on that same order avoids cancel/publish deadlocks.
        const { rows: articleRows } = await db.query<{
          published_version_id: string | null;
          scheduled_version_id: string | null;
          archived_at: Date | string | null;
        }>(
          `
          select published_version_id, scheduled_version_id, archived_at
          from content_articles
          where id = $1
          for update
        `,
          [job.article_id],
        );
        const article = articleRows[0];
        const { rows: jobRows } = await db.query<{ status: string }>(
          `
            select status
            from content_publication_jobs
            where id = $1 and locked_by = $2
            for update
          `,
          [job.id, workerId],
        );
        if (jobRows[0]?.status !== "processing") return false;
        if (
          !article ||
          article.archived_at ||
          article.scheduled_version_id !== job.version_id
        ) {
          await db.query(
            `
            update content_publication_jobs
            set
              status = 'cancelled',
              completed_at = now(),
              locked_at = null,
              locked_by = null
            where id = $1
          `,
            [job.id],
          );
          return false;
        }
        const { rows: versionRows } = await db.query<ScheduledVersionRow>(
          `
          select id, slug, tag_slugs, featured, created_by_admin_id
          from content_article_versions
          where id = $1 and article_id = $2
        `,
          [job.version_id, job.article_id],
        );
        const version = versionRows[0];
        if (!version) {
          throw new Error("Scheduled content version not found");
        }
        const previousSlug = await promoteContentRoute(
          db,
          job.article_id,
          version.slug,
          () =>
            new Error(
              `Scheduled slug ${version.slug} is owned by another article`,
            ),
        );
        const publishedAt = new Date();
        publicationLagMs =
          publishedAt.getTime() - new Date(job.run_at).getTime();
        await db.query(
          `
          update content_articles
          set
            editorial_status = 'approved',
            published_version_id = $2,
            scheduled_version_id = null,
            published_slug = $3,
            published_tag_slugs = $4,
            published_featured = $5,
            first_published_at = coalesce(first_published_at, $6),
            published_at = $6,
            scheduled_for = null,
            published_by_admin_id = $7,
            updated_by_admin_id = $7
          where id = $1
        `,
          [
            job.article_id,
            version.id,
            version.slug,
            version.tag_slugs,
            version.featured,
            publishedAt,
            version.created_by_admin_id,
          ],
        );
        await db.query(
          `
          update content_publication_jobs
          set status = 'completed', completed_at = now(), locked_at = null, locked_by = null
          where id = $1
        `,
          [job.id],
        );
        await db.query(
          `
          insert into content_audit_events (
            action, article_id, version_id, actor_admin_id,
            metadata
          ) values (
            'article.scheduled_publication_completed', $1, $2, $3,
            $4::jsonb
          )
        `,
          [
            job.article_id,
            version.id,
            version.created_by_admin_id,
            JSON.stringify({
              scheduledFor: new Date(job.run_at).toISOString(),
            }),
          ],
        );
        const event = article.published_version_id
          ? "article_updated"
          : "article_published";
        await db.query(
          `
          insert into content_outbox (
            event_type, article_id, version_id, dedupe_key, payload
          ) values ($1, $2, $3, $4, $5::jsonb)
          on conflict (dedupe_key) do nothing
        `,
          [
            event,
            job.article_id,
            version.id,
            `publish:${version.id}`,
            JSON.stringify({
              event,
              articleId: job.article_id,
              versionId: version.id,
              slug: version.slug,
              previousSlug,
              occurredAt: publishedAt.toISOString(),
            }),
          ],
        );
        return true;
      });
      if (didPublish) {
        completed += 1;
        if (publicationLagMs != null) {
          recordContentPublicationLag(publicationLagMs);
        }
      }
    } catch (error) {
      const terminal =
        job.attempts >= getContentServiceRuntime().workerMaxAttempts;
      recordContentPublicationRetry(terminal);
      const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
      await pool.query(
        `
          update content_publication_jobs
          set
            status = case when attempts >= $3 then 'failed' else 'pending' end,
            run_at = case
              when attempts >= $3 then run_at
              else now() + ($4::text || ' seconds')::interval
            end,
            locked_at = null,
            locked_by = null,
            completed_at = case when attempts >= $3 then now() else null end,
            last_error = $5
          where id = $1 and status = 'processing' and locked_by = $2
        `,
        [
          job.id,
          workerId,
          getContentServiceRuntime().workerMaxAttempts,
          String(delaySeconds),
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : "Unknown publication failure",
        ],
      );
      logger?.warn(
        { publicationJobId: String(job.id), terminal, error },
        "Scheduled content publication failed",
      );
    }
  }
  return completed;
}

async function claimOutboxEvent(
  pool: Pool,
  workerId: string,
): Promise<OutboxRow | null> {
  return tx(pool, async (db) => {
    await db.query(
      `
        update content_outbox
        set locked_at = null, locked_by = null
        where processed_at is null
          and dead_lettered_at is null
          and locked_at < now() - interval '2 minutes'
      `,
    );
    const { rows } = await db.query<OutboxRow>(
      `
        select id, payload, attempts
        from content_outbox
        where processed_at is null
          and dead_lettered_at is null
          and locked_at is null
          and available_at <= now()
        order by available_at, id
        for update skip locked
        limit 1
      `,
    );
    const row = rows[0];
    if (!row) return null;
    await db.query(
      `
        update content_outbox
        set locked_at = now(), locked_by = $2, attempts = attempts + 1
        where id = $1
      `,
      [row.id, workerId],
    );
    return { ...row, attempts: row.attempts + 1 };
  });
}

export async function dispatchContentOutbox(
  pool: Pool,
  limit: number,
  workerId: string,
  logger: WorkerLogger,
): Promise<number> {
  if (!isContentRevalidationConfigured()) return 0;
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const event = await claimOutboxEvent(pool, workerId);
    if (!event) break;
    try {
      const payload = parseOutboxPayload(event.payload);
      const result = await notifyContentRevalidation(payload);
      if (!result.ok) {
        throw new Error(result.error);
      }
      await pool.query(
        `
          update content_outbox
          set processed_at = now(), locked_at = null, locked_by = null, last_error = null
          where id = $1 and locked_by = $2
        `,
        [event.id, workerId],
      );
      processed += 1;
    } catch (error) {
      recordContentOutboxRetry();
      const terminal =
        event.attempts >= getContentServiceRuntime().workerMaxAttempts;
      if (terminal) recordContentOutboxDeadLetter();
      const delaySeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
      await pool.query(
        `
          update content_outbox
          set
            available_at = case
              when attempts >= $3 then available_at
              else now() + ($4::text || ' seconds')::interval
            end,
            locked_at = null,
            locked_by = null,
            dead_lettered_at = case when attempts >= $3 then now() else null end,
            last_error = $5
          where id = $1 and locked_by = $2
        `,
        [
          event.id,
          workerId,
          getContentServiceRuntime().workerMaxAttempts,
          String(delaySeconds),
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : "Unknown error",
        ],
      );
      logger.warn(
        { outboxId: String(event.id), terminal, error },
        "Content revalidation delivery failed",
      );
    }
  }
  return processed;
}

async function claimStorageDeletion(
  pool: Pool,
  workerId: string,
): Promise<StorageDeletionJobRow | null> {
  return tx(pool, async (db) => {
    await db.query(
      `
        update content_storage_deletion_jobs
        set status = 'pending', locked_at = null, locked_by = null
        where status = 'processing'
          and locked_at < now() - interval '2 minutes'
      `,
    );
    const { rows } = await db.query<StorageDeletionJobRow>(
      `
        select id, storage_key, attempts
        from content_storage_deletion_jobs
        where status = 'pending'
          and locked_at is null
          and available_at <= now()
          and attempts < $1
        order by available_at, id
        for update skip locked
        limit 1
      `,
      [getContentServiceRuntime().workerMaxAttempts],
    );
    const row = rows[0];
    if (!row) return null;
    await db.query(
      `
        update content_storage_deletion_jobs
        set
          status = 'processing',
          attempts = attempts + 1,
          locked_at = now(),
          locked_by = $2,
          last_error = null
        where id = $1
      `,
      [row.id, workerId],
    );
    return { ...row, attempts: row.attempts + 1 };
  });
}

export async function dispatchContentStorageDeletions(
  pool: Pool,
  limit: number,
  workerId: string,
  logger: WorkerLogger,
): Promise<number> {
  if (!isContentStorageConfigured()) return 0;
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const job = await claimStorageDeletion(pool, workerId);
    if (!job) break;
    try {
      await deleteStoredContentObject(job.storage_key);
      await pool.query(
        `
          update content_storage_deletion_jobs
          set
            status = 'completed',
            completed_at = now(),
            locked_at = null,
            locked_by = null,
            last_error = null
          where id = $1 and locked_by = $2
        `,
        [job.id, workerId],
      );
      processed += 1;
    } catch (error) {
      const terminal =
        job.attempts >= getContentServiceRuntime().workerMaxAttempts;
      recordContentStorageDeletionRetry(terminal);
      const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
      await pool.query(
        `
          update content_storage_deletion_jobs
          set
            status = case when attempts >= $3 then 'failed' else 'pending' end,
            available_at = case
              when attempts >= $3 then available_at
              else now() + ($4::text || ' seconds')::interval
            end,
            completed_at = case when attempts >= $3 then now() else null end,
            locked_at = null,
            locked_by = null,
            last_error = $5
          where id = $1 and locked_by = $2
        `,
        [
          job.id,
          workerId,
          getContentServiceRuntime().workerMaxAttempts,
          String(delaySeconds),
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : "Unknown object deletion error",
        ],
      );
      logger.warn(
        { storageDeletionJobId: String(job.id), terminal, error },
        "Content object deletion failed",
      );
    }
  }
  return processed;
}

export async function runContentRetention(
  pool: Pool,
  batchSize: number,
): Promise<number> {
  const deleted = await tx(pool, async (db) => {
    const { rows: lockRows } = await db.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(434667711) as locked",
    );
    if (!lockRows[0]?.locked) return 0;

    const counts: number[] = [];
    for (const statement of [
      `
        with expired as (
          select id from content_outbox
          where processed_at < now() - $2 * interval '1 day'
          order by processed_at, id
          limit $1
          for update skip locked
        )
        delete from content_outbox target
        using expired
        where target.id = expired.id
      `,
      `
        with expired as (
          select id from content_outbox
          where dead_lettered_at < now() - $2 * interval '1 day'
          order by dead_lettered_at, id
          limit $1
          for update skip locked
        )
        delete from content_outbox target
        using expired
        where target.id = expired.id
      `,
      `
        with expired as (
          select id from content_publication_jobs
          where status in ('completed', 'cancelled', 'failed')
            and completed_at < now() - $2 * interval '1 day'
          order by completed_at, id
          limit $1
          for update skip locked
        )
        delete from content_publication_jobs target
        using expired
        where target.id = expired.id
      `,
      `
        with expired as (
          select id from content_storage_deletion_jobs
          where status in ('completed', 'failed')
            and completed_at < now() - $2 * interval '1 day'
          order by completed_at, id
          limit $1
          for update skip locked
        )
        delete from content_storage_deletion_jobs target
        using expired
        where target.id = expired.id
      `,
      `
        with expired as (
          select version.id
          from content_article_versions version
          where version.kind = 'scheduled'
            and version.created_at < now() - $2 * interval '1 day'
            and not exists (
              select 1 from content_articles article
              where article.published_version_id = version.id
                 or article.scheduled_version_id = version.id
            )
            and not exists (
              select 1 from content_publication_jobs job
              where job.version_id = version.id
            )
          order by version.created_at, version.id
          limit $1
          for update of version skip locked
        )
        delete from content_article_versions target
        using expired
        where target.id = expired.id
      `,
    ]) {
      const result = await db.query(statement, [
        batchSize,
        getContentServiceRuntime().retentionDays,
      ]);
      counts.push(result.rowCount ?? 0);
    }

    const auditResult = await db.query(
      `
        with expired as (
          select id from content_audit_events
          where created_at < now() - $2 * interval '1 day'
          order by created_at, id
          limit $1
          for update skip locked
        )
        delete from content_audit_events target
        using expired
        where target.id = expired.id
      `,
      [batchSize, getContentServiceRuntime().auditRetentionDays],
    );
    counts.push(auditResult.rowCount ?? 0);
    return counts.reduce((total, count) => total + count, 0);
  });
  recordContentRetention(deleted);
  return deleted;
}

export type ContentWorkerPassResult = {
  published: number;
  delivered: number;
  expiredUploads: number;
  deletedObjects: number;
  retainedRows: number;
};

export async function runContentWorkerPass(
  pool: Pool,
  logger: WorkerLogger,
  options: { workerId: string; runRetention: boolean },
): Promise<ContentWorkerPassResult> {
  const config = getContentServiceRuntime();
  if (!config.workerEnabled) {
    return {
      published: 0,
      delivered: 0,
      expiredUploads: 0,
      deletedObjects: 0,
      retainedRows: 0,
    };
  }
  const published = config.publishingEnabled
    ? await publishDueContentVersions(
        pool,
        config.workerBatchSize,
        `${options.workerId}:publication`,
        logger,
      )
    : 0;
  const delivered = await dispatchContentOutbox(
    pool,
    config.workerBatchSize,
    options.workerId,
    logger,
  );
  const expiredUploads = await reclaimStaleContentAssetUploads(
    pool,
    config.workerBatchSize,
  );
  const deletedObjects = await dispatchContentStorageDeletions(
    pool,
    config.workerBatchSize,
    `${options.workerId}:storage`,
    logger,
  );
  const retainedRows = options.runRetention
    ? await runContentRetention(
        pool,
        Math.max(100, config.workerBatchSize * 10),
      )
    : 0;
  const result = {
    published,
    delivered,
    expiredUploads,
    deletedObjects,
    retainedRows,
  };
  if (Object.values(result).some((count) => count > 0)) {
    logger.info(result, "Content worker completed work");
  }
  return result;
}
