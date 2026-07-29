# Content CMS backend

The content service is the source of truth for the Hunch blog. It provides a
strict block-document contract, isolated PostgreSQL access, direct object-store
uploads, editorial workflow, immutable publication versions, scheduled
publication, signed draft previews, and durable Next.js revalidation.

The design and SQL findings behind this implementation are recorded in
[`content-cms-production-audit.md`](./content-cms-production-audit.md).

## Safe deployment order

1. Optionally create a dedicated PostgreSQL database and set
   `CONTENT_DATABASE_URL`. Without it, content uses `DATABASE_URL` through its
   own bounded pools.
   Production logs this fallback without rejecting startup.
2. Configure object storage and `CONTENT_PREVIEW_SECRET`.
3. Keep `CONTENT_PUBLISHING_ENABLED=false`.
4. Deploy the backend. The deploy scripts run the normal migrations and then
   `pnpm migrate:content`.
5. Verify `GET /health/content`, `GET /content/articles`, and
   `GET /admin/content/operations`.
6. Deploy the admin block editor and create drafts.
7. Deploy the landing renderer, `/blog`, sitemap/feed support, preview bridge,
   and signed revalidation route.
8. Set `CONTENT_REVALIDATE_URL`, `CONTENT_REVALIDATE_SECRET`,
   `CONTENT_RENDERER_CONTRACT_ID=hunch-content-document-v1`, and
   `CONTENT_PUBLISHING_ENABLED=true`, then redeploy the API.

Publishing is fail-closed by default so a backend-first rollout cannot expose a
document schema that the landing does not yet render. Draft creation, editing,
review, checkpoints, media, and preview remain available while publishing is
disabled.

## Configuration

| Variable                                 | Default        | Purpose                                           |
| ---------------------------------------- | -------------- | ------------------------------------------------- |
| `CONTENT_DATABASE_URL`                   | `DATABASE_URL` | Optional dedicated content PostgreSQL connection  |
| `CONTENT_DB_PUBLIC_POOL_MAX`             | `2`            | Public-read connections per API replica           |
| `CONTENT_DB_ADMIN_POOL_MAX`              | `2`            | Admin/editor connections per API replica          |
| `CONTENT_DB_WORKER_POOL_MAX`             | `1`            | Scheduler/outbox connections per API replica      |
| `CONTENT_DB_PUBLIC_STATEMENT_TIMEOUT_MS` | `750`          | Public SQL circuit breaker                        |
| `CONTENT_DB_ADMIN_STATEMENT_TIMEOUT_MS`  | `2500`         | Admin SQL circuit breaker                         |
| `CONTENT_DB_WORKER_STATEMENT_TIMEOUT_MS` | `5000`         | Worker SQL circuit breaker                        |
| `CONTENT_DB_LOCK_TIMEOUT_MS`             | `750`          | Maximum lock wait                                 |
| `CONTENT_PUBLISHING_ENABLED`             | `false`        | Allows immediate/scheduled publication            |
| `CONTENT_REQUIRE_APPROVAL`               | `true`         | Requires approval before publication              |
| `CONTENT_RENDERER_CONTRACT_ID`           | empty          | Exact backend/landing renderer contract gate      |
| `CONTENT_WORKER_ENABLED`                 | `true`         | Runs the durable scheduler and outbox dispatcher  |
| `CONTENT_WORKER_POLL_MS`                 | `5000`         | Worker polling interval                           |
| `CONTENT_WORKER_BATCH_SIZE`              | `10`           | Maximum jobs and outbox events per tick           |
| `CONTENT_WORKER_MAX_ATTEMPTS`            | `8`            | Retry/dead-letter boundary                        |
| `CONTENT_RETENTION_DAYS`                 | `180`          | Operational history retention                     |
| `CONTENT_AUDIT_RETENTION_DAYS`           | `730`          | Audit event retention                             |
| `CONTENT_PREVIEW_SECRET`                 | empty          | 32+ character HMAC secret for draft previews      |
| `CONTENT_REVALIDATE_URL`                 | empty          | Landing revalidation webhook URL                  |
| `CONTENT_REVALIDATE_SECRET`              | empty          | 32+ character HMAC secret shared with the landing |
| `CONTENT_REVALIDATE_TIMEOUT_MS`          | `5000`         | Webhook timeout                                   |
| `CONTENT_ASSET_S3_ENDPOINT`              | empty          | Checksum-capable S3 endpoint                      |
| `CONTENT_ASSET_S3_REGION`                | `auto`         | Object-store region                               |
| `CONTENT_ASSET_S3_BUCKET`                | empty          | Private upload bucket                             |
| `CONTENT_ASSET_S3_ACCESS_KEY_ID`         | empty          | Object-store access key                           |
| `CONTENT_ASSET_S3_SECRET_ACCESS_KEY`     | empty          | Object-store secret                               |
| `CONTENT_ASSET_S3_FORCE_PATH_STYLE`      | `true`         | S3 path-style compatibility                       |
| `CONTENT_ASSET_PUBLIC_BASE_URL`          | empty          | CDN/public asset origin                           |
| `CONTENT_ASSET_UPLOAD_TTL_SEC`           | `900`          | Signed PUT lifetime, 60-3600 seconds              |

All five object-store endpoint/bucket/credential/public-origin values must be
configured together. Revalidation URL and secret must also be configured
together. Production webhook, storage, and CDN URLs must use HTTPS. Secrets
belong in the existing runtime secret mechanism, not in git.

Manual migration commands:

```bash
pnpm migrate
pnpm migrate:content
```

The content migration runner has a separate migration table, checksum
verification, and advisory lock. It is safe to run repeatedly.

## Storage and publication model

- `content_articles` stores stable identity, workflow state, and public or
  scheduled version pointers.
- `content_article_drafts` stores exactly one mutable row per article.
- `content_article_versions` stores immutable `checkpoint`, `scheduled`, and
  `published` snapshots.
- `content_routes` reserves every slug and preserves old-slug redirects.
- `content_assets` stores quarantine/verifying/ready/failed/deleted state and
  verified metadata, never media bytes.
- `content_asset_usages` provides explicit draft/version asset references.
- `content_publication_jobs` stores indexed, durable scheduled work.
- `content_outbox` stores idempotent revalidation events and retry state.
- `content_storage_deletion_jobs` durably removes staging and retired objects.
- `content_audit_events` stores actor-attributed editorial and media actions.

An unchanged autosave compares the canonical content hash and performs zero
writes. A changed autosave updates the one draft row and only the changed asset
usage references. It never inserts a version. Repeated explicit checkpoints of
the same content return the existing checkpoint instead of creating duplicate
rows.

Editing or restoring a published article changes only the draft. Public reads
continue to resolve the immutable published version until another publish.

An article containing a `relatedArticles` block resolves at most twelve unique
published IDs in one `id = any(uuid[])` query. It never performs one query per
card. Unpublished, archived, and self-references are omitted; the configured
order is preserved. Related list-cover assets are folded into the article's
single asset batch. A 50,000-row PostgreSQL 16 gate measured this related batch
at 0.082 ms of warm database execution using the article and version indexes.

## Permissions

- `content:read`: article/version/asset reads, operations status, preview token.
- `content:write`: create/edit, review submission, checkpoints, restore, media.
- `content:publish`: approve, publish, schedule, cancel schedule, unpublish,
  archive.

`sadmin` and `admin` receive all three permissions. `viewer` receives
`content:read`; `analyst` receives none. Admin routes use the existing bearer
session and CSRF enforcement.

## Block document contract

Every document and block is versioned. Block IDs are stable UUIDs used by the
editor, validation errors, media usages, and future migrations.

```json
{
  "schemaVersion": 1,
  "blocks": [
    {
      "id": "dd92b625-bce7-44b2-a2a0-25d1269fa466",
      "type": "heading",
      "version": 1,
      "data": {
        "level": 2,
        "content": [{ "type": "text", "text": "How markets work" }]
      }
    }
  ]
}
```

Limits are 500 blocks, 1,000,000 serialized bytes, and 1.5 MB at the HTTP body
boundary. Heading level 1 is the article title; body headings are H2-H4.

Schema version 1 supports:

- paragraph, lead, heading, bullet/number/task list;
- quote, pull quote, citation, references, footnotes;
- code, equation, accessible table, generic chart;
- callout, article notice/correction/disclosure, divider, details;
- definition list, key takeaways, FAQ, timeline, pros/cons;
- metric, stat grid, image, gallery, image comparison;
- uploaded video, audio, and file;
- allowlisted provider embed and rich link card;
- CTA, related articles, table of contents, author card, newsletter;
- Hunch market/event cards, odds table, probability chart, market comparison;
- constrained responsive two-column layout.

Rich text supports explicit marks, hard breaks, and HTTP(S) links. Raw HTML,
MDX, scripts, event handlers, and arbitrary iframes are not valid content.
Embed providers are restricted to YouTube, Vimeo, X, Instagram, TikTok,
Bluesky, Reddit, Spotify, SoundCloud, Apple Podcasts, Flourish, Datawrapper,
and Google Maps. The provider must match the canonical HTTPS hostname. The API
does not fetch user-supplied embed URLs.

Uploaded video with audio requires either a captions asset or transcript;
uploaded audio requires a transcript. Autoplay video must be muted. This keeps
accessibility requirements in the publish contract instead of relying on an
editor reminder.

## Article shape and SEO

The draft and every immutable version contain:

- slug, title, excerpt, locale, featured state;
- structured author, optional category, and structured tags;
- block document;
- independent `listCover`, `heroImage`, and `socialImage` placements;
- SEO title/description, canonical override, extended robots policy, Open Graph,
  and Twitter overrides;
- derived plain text, word count, reading time, and heading outline.

Image placements contain an asset ID, alt/decorative state, optional caption
and credit, focal point, crop, and presentation. Reusing one source asset is
allowed, but the three article roles are never implicitly coupled.

Publication requires a title, excerpt, list cover, non-empty document, valid
heading hierarchy, accessible image alternatives, ready assets of compatible
kinds, and dimensions for the social image. A supplied social image must be at
least 600x315 and approximately 1.91:1. The approval endpoint performs the same
structural and asset checks before changing editorial state.

The backend owns the SEO data contract and integrity. The Next.js landing owns
semantic HTML, metadata output, JSON-LD, canonical routing, sitemap/feed,
internal links, and crawler-visible status codes.

## Public API

### `GET /content/articles`

Returns summary-only published cards. It never selects or returns the article
document. The response also contains one deduplicated `assets` array resolving
the ready list-cover IDs to CDN URLs and verified media metadata, so the
landing never performs one asset request per card.

Query parameters:

- `limit`: 1-50, default 12;
- `cursor`: opaque keyset cursor;
- `tag`: optional exact normalized tag slug.

### `GET /content/articles/:slug`

Returns the immutable public article plus a deduplicated `assets` array for its
list, hero, social, author, and body media references. Responses include
shared-cache headers, `ETag` based on the version ID, and `Last-Modified`. Matching
`If-None-Match` returns 304.

An old slug returns HTTP 308 plus `redirectTo`. The landing must translate that
to its public `/blog/<slug>` route. Reserved, unpublished, archived, and
unknown slugs return 404.

### `GET /content/articles-index`

Returns cursor-paginated `id`, slug, title, publication/update time, list-cover
placement, and resolved list-cover URL. `limit` is 1-1000. This is the source
for sitemap, feed, and static-path generation; it does not return documents or
unused metadata.

### `GET /content/preview`

Requires `x-hunch-content-preview-token`. It returns the exact mutable draft
revision encoded by a short-lived token, with `Cache-Control: private,
no-store` and `X-Robots-Tag: noindex, nofollow, noarchive`. The token expires
when its TTL elapses or immediately when that draft revision changes.

The landing preview page should receive the token from the admin, call this
endpoint server-side using the header, and never put the token in public cache
keys, analytics, or client logs.

## Admin article API

| Method and path                                                | Permission | Purpose                                      |
| -------------------------------------------------------------- | ---------- | -------------------------------------------- |
| `GET /admin/content/operations`                                | read       | DB/worker/backlog/latency snapshot           |
| `GET /admin/content/articles`                                  | read       | Keyset-paginated summary list and GIN search |
| `POST /admin/content/articles`                                 | write      | Create a draft and reserve its slug          |
| `GET /admin/content/articles/:id`                              | read       | Full draft and public/schedule state         |
| `PATCH /admin/content/articles/:id`                            | write      | Optimistic autosave/update                   |
| `POST /admin/content/articles/:id/preview-token`               | read       | Create 60-3600 second preview token          |
| `POST /admin/content/articles/:id/submit-review`               | write      | Draft to in-review                           |
| `POST /admin/content/articles/:id/approve`                     | publish    | Validate and approve                         |
| `POST /admin/content/articles/:id/return-draft`                | write      | Return to draft                              |
| `POST /admin/content/articles/:id/publish`                     | publish    | Publish now or schedule immutable version    |
| `POST /admin/content/articles/:id/cancel-schedule`             | publish    | Atomically cancel pending schedule           |
| `POST /admin/content/articles/:id/unpublish`                   | publish    | Remove the public pointer                    |
| `POST /admin/content/articles/:id/archive`                     | publish    | Hide/archive and cancel schedule             |
| `POST /admin/content/articles/:id/versions`                    | write      | Create deduplicated checkpoint               |
| `GET /admin/content/articles/:id/versions`                     | read       | Metadata-only version history                |
| `GET /admin/content/articles/:id/versions/:versionId`          | read       | Load one snapshot                            |
| `POST /admin/content/articles/:id/versions/:versionId/restore` | write      | Copy snapshot into draft only                |
| `GET /admin/content/articles/:id/audit`                        | read       | Paginated actor/action history               |

Article list query parameters are `limit` 1-100, opaque `cursor`, optional
`status`, and optional `q`. Search uses PostgreSQL full-text GIN candidates
before ordering and loading summary metadata.

Every mutation after create takes a positive `expectedRevision`. A stale value
returns HTTP 409 `content_revision_conflict`. Publish and workflow operations
increment the revision too, preventing a double-click or replay from creating
duplicate versions or jobs.

`publishAt` is an ISO timestamp. A value more than five seconds in the future
creates an immutable scheduled version and one pending job. The worker promotes
that exact version at the due time with `FOR UPDATE SKIP LOCKED`; later draft
edits cannot alter scheduled content.

## Media API

| Method and path                           | Purpose                                 |
| ----------------------------------------- | --------------------------------------- |
| `GET /admin/content/assets`               | Cursor-paginated asset library          |
| `POST /admin/content/assets`              | Create upload intent and signed PUT     |
| `GET /admin/content/assets/:id`           | Asset metadata                          |
| `POST /admin/content/assets/:id/complete` | Verify uploaded object and mark ready   |
| `PATCH /admin/content/assets/:id`         | Edit alt/caption/credit/focal metadata  |
| `DELETE /admin/content/assets/:id`        | Soft-delete and enqueue object deletion |

Upload flow:

1. The admin calculates file size and SHA-256. Both are required.
2. It creates an intent with `kind`, filename, MIME, `expectedByteSize`, and
   required `checksumSha256` plus default accessibility/credit metadata.
3. It uploads bytes directly to the returned signed URL with every returned
   header. Media bytes never pass through the API process.
4. It calls `complete` with byte size and applicable dimensions/duration.
5. The backend claims the row as `verifying`, performs checksum-enabled
   `HEAD`, validates size/MIME/SHA-256, reads a bounded prefix to validate
   magic bytes and image dimensions, and checks pixel-bomb limits.
6. It copies the object from private `content-staging/` to an immutable,
   checksum-bearing `content/` key, verifies the copy, exposes the public URL,
   and enqueues deletion of the staging object after the signed PUT has
   expired. Public copies receive one-year immutable cache metadata.

Limits: images 20 MB, videos 500 MB, audio/files 100 MB. MIME types are
allowlisted per kind. Images support JPEG, PNG, WebP, AVIF, and GIF. In-use
assets cannot be deleted. Drafts may reference pending uploads, but approval
and publication require every referenced asset to be ready.

The provider must return SHA-256 through checksum-enabled `HEAD` and preserve
or generate it on server-side copy. Before production, verify this with the
chosen provider, configure CORS for the exact admin origin and returned PUT
headers, keep `content-staging/` private with an expiry lifecycle, and serve
the public origin without application cookies using
`X-Content-Type-Options: nosniff`.

[AWS S3 `PutObject`](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
and [`CopyObject`](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html)
define the baseline contract. As audited on 2026-07-29, the
[Cloudflare R2 S3 compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/)
does not support full-object SHA-256 or `x-amz-checksum-algorithm` on
`CopyObject`, so R2 must not be configured for this implementation without a
separate streaming verifier/Worker adapter.

## Revalidation outbox

Public changes insert an outbox row in the same transaction as the public
pointer change. Scheduling does not invalidate early; the due-time worker
inserts the event after publication. Missing landing configuration preserves
the backlog instead of dropping events.

The dispatcher sends JSON to `CONTENT_REVALIDATE_URL` with:

- `x-hunch-content-timestamp`: Unix timestamp in seconds;
- `x-hunch-content-signature`: `v1=<hex hmac-sha256>`.

Signed bytes are `<timestamp>.<raw request body>`. The landing must compare the
signature in constant time, reject timestamps outside a short replay window,
and invalidate the blog list plus the new and previous article slugs. Events
contain `event`, `articleId`, nullable `versionId`, `slug`, nullable
`previousSlug`, and `occurredAt`.

Outbox keys are deterministic per immutable version/action. Failed delivery is
unlocked and retried with bounded exponential backoff; terminal events are
dead-lettered instead of retried forever. Admin publication requests never
wait for Vercel revalidation.

## Operations and alerts

`GET /admin/content/operations` returns:

- whether publishing, worker, preview, storage, and revalidation are configured;
- database readiness/time;
- pending/failed/overdue publication jobs and oldest lag;
- pending/retrying outbox events and oldest backlog;
- dead-lettered outbox events, failed storage deletions, and stale uploads;
- publication lag and outbox retries since process start;
- optimistic edit conflicts since process start;
- public content route request count, 5xx count, recent p95 latency, and
  response bytes.

The authenticated global `/metrics` payload also includes process-lifetime
content counters. Public reads never write view or analytics rows.

Normal public SQL is expected to complete far below the 750 ms timeout. The
timeout is a circuit breaker: PostgreSQL cancels a regressed query and the API
returns retryable 503 with `Retry-After: 1`, instead of allowing it to occupy a
connection for tens of seconds. Admin and worker budgets are larger because
they perform bounded writes and maintenance.

## Verification commands

Against a disposable, migrated PostgreSQL 16 database with
`CONTENT_TEST_DATABASE_URL` set:

```bash
pnpm migrate:content
pnpm --filter api test:content
pnpm --filter api test:content:integration
pnpm --filter api test:content:performance
```

The deploy workflow runs migrations twice, typechecking, unit/integration,
concurrency, 500-reference batching, mocked S3 protocol, and SQL-plan gates
before it can build and deploy the backend.

Alert on any failed publication job, sustained overdue count, growing or old
outbox backlog after revalidation is configured, repeated statement timeouts,
and response payload growth near the documented limits.

## Expected errors

- `content_revision_conflict` — stale editor revision, HTTP 409;
- `content_slug_conflict` — slug is reserved/current/redirected, HTTP 409;
- `content_article_not_publishable` — structural validation failed, HTTP 422;
- `content_asset_not_ready` / `content_asset_kind_mismatch` — media validation,
  HTTP 422 (or 413 for size);
- `content_publishing_disabled` — renderer rollout gate, HTTP 503;
- `content_preview_invalid` — invalid HMAC, HTTP 401;
- `content_preview_expired` — TTL elapsed or draft changed, HTTP 410;
- `content_storage_unavailable` / `content_preview_unavailable` — missing
  deployment configuration, HTTP 503.

All admin responses are `no-store`. Public summaries/details use shared-cache
headers, while the landing adds its own Next.js cache tags and ISR policy.
