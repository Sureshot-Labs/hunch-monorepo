# Content CMS production audit

Status: backend/admin/landing implementation complete; production API redeploy and authenticated staging QA required

Date: 2026-07-29

Scope: `hunch-monorepo`, `hunch-admin`, and `hunch-landing`

## Decision

The first Markdown-based content CRUD implementation was not safe to deploy as
the production blog CMS. It was replaced before its migration was applied. The
backend described below is the implemented foundation for the admin and landing
applications.

This verdict is deliberately narrower than “the whole blog is live.” The
backend, admin, and all document renderers pass their local production gates,
but the live API is still serving a revision without content routes. Publishing
remains fail-closed until that backend is redeployed and the signed
revalidation and real object-storage/CDN flows pass authenticated staging
certification.

The production design is:

- content APIs and admin authorization remain in `hunch-monorepo`;
- content uses a separately bounded PostgreSQL pool and supports a dedicated
  `CONTENT_DATABASE_URL` for hard isolation from the trading database;
- the landing remains read-only and reads the public API only on a Next.js
  cache miss;
- article drafts are mutable, while published and scheduled versions are
  immutable;
- media bytes are uploaded directly to object storage and PostgreSQL stores
  only verified asset metadata and references;
- scheduled publication and Next.js revalidation use durable jobs and an
  outbox rather than synchronous webhooks in admin requests;
- article bodies use a versioned, strictly validated block document. Raw HTML,
  MDX, executable JavaScript, and arbitrary iframe markup are not content.

## Measured findings

The audit used PostgreSQL 16 with 50,000 synthetic articles and 30 near-limit
documents of approximately 462 KB each. Timings are from a local warm database
and are not production latency predictions. Scan shape, buffer use, payload
size, and storage growth are deterministic findings.

| Scenario                       |                  Audited implementation |          Corrected query/DTO |
| ------------------------------ | --------------------------------------: | ---------------------------: |
| Exact slug lookup              | 12.9 ms, 8,334 buffers, sequential scan |          0.083 ms, 4 buffers |
| First public page              |                      22.5 ms, full scan |                     0.093 ms |
| Tag-filtered page              |        52.1 ms, 45k `unnest` executions |                     0.109 ms |
| First admin page               |                      12.2 ms, full scan |                     0.114 ms |
| Thirteen full list rows        |                                 5.87 MB |    3.7 KB summary projection |
| 180 saves of one large article |               83 MB of revision storage | no revision rows on autosave |
| Twenty-six revision snapshots  |                                   11 MB |  metadata-only revision list |

### Implemented backend verification at 100,000 articles

The replacement backend was then measured on PostgreSQL 16 with 100,000
published articles and 30 public documents of 897,920 JSONB bytes. These are
local warm/steady-state timings; they validate plan shape and bounded work, not
production network latency.

| Implemented query                        | Execution | Buffers / result                                        |
| ---------------------------------------- | --------: | ------------------------------------------------------- |
| Exact current slug, normal document      |  0.126 ms | 13 buffers, three PK index scans                        |
| Exact current slug, 898 KB document      |  0.370 ms | 12 buffers, no sequential scan                          |
| First public page, 13 summaries          |  0.336 ms | publication index + 13 version PK lookups               |
| Rare tag page after vacuum               |  7.284 ms | GIN bitmap scan, 100 matching heap rows                 |
| First admin page, 26 summaries           |  0.539 ms | draft-order index, no document projection               |
| Full-text search after GIN-first rewrite |  1.074 ms | 39 buffers; previous ordered-filter plan was 310.652 ms |
| Article index, 1,001 rows                | 13.572 ms | publication index + version PK lookups                  |
| Serialized 13-row public SQL payload     |       n/a | 8,552 bytes                                             |

The full-text result is especially important: PostgreSQL initially preferred
the draft ordering index and filtered all 100,000 rows to satisfy `ORDER BY`
and `LIMIT`. Materializing GIN candidates before ordering reduced the measured
execution from 310.652 ms and 14,795 buffers to 1.074 ms and 39 buffers.

The final public list, public detail, normal admin list, admin search, tag list,
and article-index plans contain no sequential scan of the article, draft,
version, or route tables. Large document columns are absent from list and
version-summary SQL projections rather than being removed only at the DTO
layer.

### SQL defects

1. The unique index was on `lower(slug)`, while the detail query used
   `slug = $1`. PostgreSQL could not use the expression index.
2. Publication order was indexed using
   `coalesce(scheduled_for, published_at)`, but queried using a different
   `CASE` expression.
3. The tag GIN index could not serve `unnest(tags)` plus `lower(...)`.
4. The unfiltered admin list had no matching `(updated_at, id)` index.
5. Full-text search was combined with leading-wildcard `ILIKE` through `OR`,
   frequently turning an indexed search into a sequential scan.
6. Public list, admin list, and revision list fetched large document payloads
   that the caller did not need.

### Write amplification defects

The prototype stored a full JSONB snapshot on every update. A five-second
autosave interval creates 180 snapshots in only fifteen minutes. In the audit,
that consumed 83 MB for one article, before accounting for WAL, indexes, and
vacuum pressure.

The production rule is:

- browser recovery is written locally on every change;
- server autosave updates exactly one mutable draft row;
- unchanged content hashes produce no database write;
- immutable snapshots are created only for publish, schedule, explicit
  checkpoint, and a bounded low-frequency recovery checkpoint policy;
- revision lists never include their document snapshots.

### Editorial correctness defects

The prototype used one row for both draft and public content. Editing a
published article therefore changed the live article without another publish
operation. Restoring a revision had the same problem.

The production model keeps one draft and immutable versions. Publishing
atomically moves a public pointer to a newly created version. Restoring a
version copies it into the draft and does not affect the public pointer.

### Scheduling and cache defects

The prototype sent revalidation when an article was scheduled, before it was
public, and had no durable action at the actual due time. Failed webhooks were
only logged.

The production model stores a scheduled immutable version and an indexed job.
At the due time a worker publishes that exact version and inserts an outbox
event in the same transaction. A dispatcher retries the signed revalidation
request with idempotency and exponential backoff.

## Production data model

| Relation                        | Responsibility                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `content_articles`              | Stable identity, workflow state, public/scheduled version pointers, public ordering data |
| `content_article_drafts`        | Exactly one mutable document and metadata row per article                                |
| `content_article_versions`      | Immutable publish, schedule, and checkpoint snapshots                                    |
| `content_routes`                | Reserved, current, and redirect slugs with database-enforced uniqueness                  |
| `content_assets`                | Quarantine/verifying/ready/failed/deleted media metadata                                 |
| `content_asset_usages`          | Draft/version asset references, updated by set difference                                |
| `content_publication_jobs`      | Indexed due-time publication jobs                                                        |
| `content_outbox`                | Durable, idempotent cache invalidation events                                            |
| `content_storage_deletion_jobs` | Durable deletion of quarantine and retired objects                                       |
| `content_audit_events`          | Actor-attributed workflow/media history that survives target deletion                    |

Actor admin IDs are recorded as UUID values but are intentionally not foreign
keys. A dedicated content database cannot reference `admin_accounts` in the
application database. Authorization remains enforced by the existing admin
middleware before a content transaction begins.

## Block document contract

Every document has a schema version and ordered blocks. Every block has a
stable UUID, a type, its own version, and type-specific validated data.

```json
{
  "schemaVersion": 1,
  "blocks": [
    {
      "id": "dd92b625-bce7-44b2-a2a0-25d1269fa466",
      "type": "heading",
      "version": 1,
      "data": { "level": 2, "content": [] }
    }
  ]
}
```

The initial newsroom catalog covers:

- paragraphs, leads, headings, bullet/number/task lists;
- block quotes, pull quotes, citations, footnotes, and references;
- code, equations, accessible tables, and generic charts;
- callouts, corrections/disclosures, dividers, details/accordions, and
  definition lists;
- key takeaways, FAQs, timelines, pros/cons, metrics, and stat grids;
- images, galleries, comparison images, video, audio, and files;
- provider-based social/video/data embeds;
- link cards, CTAs, related articles, automatic table of contents, author and
  newsletter blocks;
- Hunch market, event, odds, probability, and comparison blocks;
- constrained responsive groups and two-column layout.

Text supports explicit inline marks and safe links. Heading level 1 belongs to
the article title and is not a body block.

The catalog is extensible through block and provider registries. Unknown block
types may be retained during a future migration, but cannot be published until
the public renderer declares support for their version.

## Media model

Article versions have independent placements for:

- `listCover`: blog cards and related article lists;
- `heroImage`: the main image inside the article;
- `socialImage`: per-article Open Graph and Twitter sharing media.

Each placement contains an asset ID, alternative text, optional caption and
credit, focal point, crop, and presentation settings. A source asset may be
reused, but the roles are never implicitly coupled.

Body media and galleries also reference assets by ID. Base64 payloads and
unverified arbitrary HTML are rejected. A publish operation verifies that all
referenced assets exist, are ready, have compatible media kinds, and satisfy
required accessibility metadata.

Embed blocks store a provider, canonical URL, normalized resource identifier,
aspect ratio, and caption. They never store provider scripts or arbitrary
iframe HTML. Provider resolution must use an allowlist, private-network SSRF
protection, response size limits, and short timeouts.

## SEO ownership

The backend owns content integrity and the SEO data contract:

- slug, title, excerpt, locale, author, category, and tags;
- SEO title/description, canonical override, extended robots policy;
- Open Graph title/description and social image;
- Twitter title/description overrides;
- publish and modified timestamps;
- derived plain text, word count, reading time, and heading outline;
- publish validation for heading hierarchy, assets, alternative text, links,
  embeds, and renderer compatibility.

The Next.js landing owns output and crawlability:

- server-rendered semantic article HTML;
- `generateMetadata`, canonical, robots, Open Graph, and Twitter tags;
- `BlogPosting`, `BreadcrumbList`, author, and applicable FAQ structured data;
- blog/article sitemap entries, sitemap splitting, RSS/Atom, internal links,
  related articles, and old-slug HTTP 308 redirects;
- cache tags, ISR fallback, signed on-demand revalidation, and no-index draft
  previews.

The landing now generates article metadata, robots directives, sitemap entries,
and feeds. Its header and footer logos link to `/`.

## Admin editor requirements

The admin implementation must provide:

- metadata-only article lists with status, author, category, publication, and
  scheduling information;
- a block canvas with slash insertion, drag handles, keyboard movement, URL
  paste conversion, media drop/paste, and gallery reordering;
- inline rich-text controls and a side inspector for Article, Block, and SEO;
- independent list, hero, and social media controls;
- desktop/mobile, search snippet, and social sharing previews;
- local recovery, visible autosave state, undo/redo, and a useful optimistic
  conflict workflow;
- heading, alternative text, link, embed, and renderer warnings;
- review, approval, scheduling, publishing, archive, and restore flows;
- metadata-only version history with snapshot detail loaded on demand;
- a lazy-loaded editor route so editor code does not inflate the entire admin
  bundle.

## Admin implementation checkpoint (2026-07-29)

`hunch-admin` now implements the editor contract against the deployed content
API:

- a lazy-loaded `/content` catalog and `/content/:articleId` editor;
- Lexical-backed inline rich text for paragraphs, leads, headings, table cells,
  captions, quotes, transcripts, and other rich fields;
- bold, italic, underline, strike, inline code, highlight, super/subscript,
  safe links, automatic URL conversion, footnote references, and local
  undo/redo;
- `dnd-kit` pointer, touch, and keyboard sorting for the versioned top-level
  block array, with handle-only activation and screen-reader announcements;
- dedicated form editors for every schema-v1 block type, including nested
  multi-block columns without destructive truncation;
- direct checksum-verified object-storage uploads, drag/drop and paste upload,
  MIME/size preflight, paginated media browsing, and resolved selected assets;
- independent list-cover, hero, and social-image controls;
- article, author, category, tags, SEO, robots, Open Graph, Twitter, search, and
  social-preview controls;
- debounced serialized autosave, optimistic revision conflicts, unload guards,
  and bounded IndexedDB recovery (ten most recent local drafts);
- review, approval, immutable scheduling, publish, unpublish, archive,
  checkpoint, lazy version inspection, and checkpoint-before-restore flows;
- role-aware read-only mode for `content:read` without `content:write`;
- client-side validation for the document limits, embed provider/host pairing,
  nested layouts, stable IDs, dangling footnotes, heading hierarchy, media
  accessibility, canonical URL ownership, and common publication requirements.

The implementation follows the interaction architecture documented by
[Payload rich text](https://payloadcms.com/docs/rich-text/overview),
[Payload official Lexical features](https://payloadcms.com/docs/rich-text/official-features),
and [Payload blocks](https://payloadcms.com/docs/fields/blocks), but does not
embed Payload itself. Payload's packages are coupled to Payload field/server
configuration, while Hunch already has a strict independent content contract.
Hunch therefore uses Lexical directly for inline editing and stable
[`@dnd-kit/sortable`](https://docs.dndkit.com/presets/sortable) for the outer
schema array; Lexical's top-level draggable plugin is experimental.

The admin release still has one explicit staging gate:

1. authenticated staging browser QA, including pointer and keyboard drag,
   mobile overflow, upload CORS, autosave, revision conflict, and workflow
   smoke tests against the deployed API.

The landing renderer, metadata, sitemap/feed, private preview bridge, and
signed revalidation endpoint are implemented and pass local production gates.
`VITE_CONTENT_PUBLISHING_ENABLED=true` must still be enabled only together
with the backend renderer-contract gate after staging smoke tests.

Snapshot market/event mode remains intentionally unselectable for new blocks
until a backend snapshot resolver exists. Existing snapshot documents remain
readable and can be switched back to live mode. The editor never fabricates a
market snapshot client-side.

## Production acceptance gates

| Gate                              | Result       | Evidence                                                                                                 |
| --------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| Migrations on clean PostgreSQL 16 | Pass         | Six migrations apply; CI applies them twice to verify checksums and idempotency                          |
| Public/admin query plans          | Pass         | 100k audit above; reproducible CI and latest local gate use 50k rows                                     |
| Bounded media-reference SQL       | Pass         | 1 and 500 references both execute 11 SQL commands; usages use set-based `unnest`                         |
| Optimistic concurrency            | Pass         | Two simultaneous edits produce one success and one revision conflict                                     |
| Scheduler concurrency             | Pass         | Two workers publish one version once; cancel/publish races complete without deadlock                     |
| Durable scheduler failure         | Pass         | A forced route conflict persists attempt count and error, then backs off                                 |
| Immutable/owned versions          | Pass         | Update trigger and composite FKs are exercised against PostgreSQL                                        |
| Public/draft separation           | Pass         | Editing and restoring do not change the live immutable version before republish                          |
| Media quarantine lifecycle        | Pass locally | AWS SDK test covers signed PUT, checksum/HEAD, magic bytes, immutable copy, failure, and deferred delete |
| Real storage/CDN behavior         | Staging gate | Verify provider checksum headers, CORS, CDN `nosniff`, private staging, and lifecycle policy             |
| Landing renderer/revalidation     | Pass locally | All 43 blocks, SEO, preview, feed/sitemap, and HMAC tests pass; signed staging delivery remains required |

The latest reproducible 50,000-row PostgreSQL 16 run produced:

| Query                    | Execution time | Index path                            |
| ------------------------ | -------------: | ------------------------------------- |
| Public first page        |       0.207 ms | publication index + version PK        |
| Public page at 80% depth |       0.186 ms | keyset publication index + version PK |
| Public detail            |       0.046 ms | route, article, and version PKs       |
| Related articles (12)    |       0.082 ms | article PK + version ownership index  |
| Admin first page         |       0.381 ms | draft-order index + PKs               |
| Rare full-text search    |       0.102 ms | GIN search index                      |

These are local warm timings, not a latency promise. Their purpose is to prove
bounded plan shape. CI now seeds 50,000 rows and uses intentionally much looser
thresholds (75-300 ms), so it catches sequential-scan regressions without
depending on runner speed.

The clean CI runner builds the complete API workspace dependency closure with
`pnpm --filter "api^..." run build` before typechecking. This prevents local
`dist` artifacts from hiding missing `@hunch/contracts` or `@hunch/db` builds.

## Load containment and timeout rationale

Content does not share a connection pool with trading traffic. Production
requires `CONTENT_DATABASE_URL`; each API instance opens at most two public,
two admin, and one worker connection. Capacity planning is therefore explicit:
`API replica count × 5`, plus one temporary migration connection, must fit the
content database connection budget.

The database budgets are 750 ms for public reads, 2.5 seconds for admin work,
and 5 seconds for workers. The 750 ms value is not an estimate that a normal
query needs almost a second: indexed queries above use less than 1 ms of local
database execution. It is a circuit breaker. A regressed plan is cancelled and
returned as retryable HTTP 503 instead of occupying a connection for 30
seconds. Lock waits are separately capped at 750 ms, idle transactions at
5-10 seconds, and JIT is disabled for these short queries. Values remain
configurable for measured production conditions.

Public reads perform no analytics, view-counter, or cache-bookkeeping writes.
An unchanged autosave writes no rows. A changed autosave updates one draft and
set-differences asset usages; it does not create a version. Checkpoints are
capped at 100 per article. Processed operational rows are deleted in bounded,
advisory-locked batches after 180 days, audit events after 730 days, and
orphaned cancelled scheduled snapshots after their job history expires.

`relatedArticles` adds no work when absent. When present it adds one indexed,
bounded query for at most twelve UUIDs and then reuses the existing asset batch;
there is no N+1 card lookup. The Next data cache and durable revalidation outbox
keep this path off the database for normal cached traffic.

## Failure and recovery model

- Publication claims are committed durably before work starts. Stale claims
  are reclaimed, retries back off, and terminal failures remain visible.
- Revalidation uses a transactional outbox, deterministic dedupe keys, bounded
  retries, and a dead-letter state. Admin publishing never waits on Vercel.
- Object deletion is an idempotent durable job. A database transaction never
  depends on an S3 delete succeeding synchronously.
- Uploads stay under a non-public staging prefix until size, MIME, provider
  SHA-256, magic bytes, and image dimensions are verified. Failed or abandoned
  uploads are reclaimed.
- `/health/content` proves that the isolated database is migrated through the
  expected schema. `/admin/content/operations` exposes overdue work, dead
  letters, failed deletions, stale uploads, route p95, and publication lag.
- Migrations take a session advisory lock, a 5-second lock timeout, and a
  5-minute statement timeout. A lock conflict fails deployment instead of
  waiting indefinitely.

Before enabling publishing, run the media flow against the real provider,
verify a real signed revalidation delivery, and configure alerts for any failed
publication, dead-lettered outbox event, failed storage deletion, stale upload,
sustained overdue job, or database timeout.

The implemented media contract uses
[AWS S3 checksum semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html).
Cloudflare R2 was explicitly checked during this audit and is not claimed as
compatible: its current
[S3 matrix](https://developers.cloudflare.com/r2/api/s3/api/) lacks
full-object SHA-256 and checksum-aware `CopyObject`. Supporting R2 safely
requires a separate streaming verification worker or R2 Worker adapter;
silently trusting client metadata is not an acceptable substitute.

## Deployment order

1. Deploy the content database schema and backend APIs.
2. Verify the empty public API and background worker health.
3. Deploy the admin block editor and create draft content.
4. Deploy `/blog`, article rendering, preview, sitemap/feed, and the signed
   revalidation endpoint.
5. Configure the revalidation secret and enable publishing.

The backend may be deployed before the two frontends, but content publication
must remain operationally disabled with `CONTENT_PUBLISHING_ENABLED=false`
until the landing renderer supports the document schema being published.

### Current deployment handoff

During the 2026-07-29 release check, `https://api.hunch.trade/health` returned
ready, but both `/health/content` and `/content/articles?limit=1` returned 404.
That response can only come from an API revision that has not registered the
content routes. The landing build is deliberately independent of upstream
availability, but publishing must stay disabled until a backend redeploy makes
both endpoints return the documented contract and the signed staging webhook
has been observed end to end. The first two content-enabled deploy runs failed
before deployment because their clean runners built only `@hunch/infra`; the
workflow now builds the complete API workspace dependency closure before its
lint and typecheck gate.
