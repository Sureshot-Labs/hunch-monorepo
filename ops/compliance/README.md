# Account erasure hardening — backend review

`DELETE /auth/me` previously removed active database records but could leave S3
object versions, public CDN copies and restorable snapshots behind. This branch
purges exact-key object versions, waits for CloudFront invalidation and records
deletion intent outside the database volume before acknowledging it.

This integrates the reviewed account/media erasure branch with the separate
first-iOS-release account safety changes: age confirmation, text/avatar checks
and avatar moderation. Analytics work is excluded.
Existing financial execution/deactivation protections are preserved.
Nothing in this branch deploys infrastructure or deletes production snapshots.

## Resulting behavior

- The API writes a minimal private S3 journal record before the DB transaction.
  It stores only schema version, user UUID and request timestamp. Conditional
  creation is idempotent; a prior record must be read and validated on HTTP 412.
  If the journal cannot be acknowledged, the API returns 503 without DB erasure.
  If the subsequent transaction fails, the recorded request remains actionable.
- The deletion receipt adds `storageDeletionPending: true`. This is deliberately
  conservative: successful DB deletion does not imply completed external cleanup.
- The worker permanently deletes versions and delete markers for the exact
  object key, in bounded turns. Progress does not consume failure retries.
  Neighbouring keys sharing a prefix are never deleted.
- Public keys require `CONTENT_ASSET_CLOUDFRONT_DISTRIBUTION_ID`, including when
  the public URL uses a custom domain. A missing ID fails cleanup rather than
  falsely declaring a cached asset erased. Staging keys need no invalidation.
  The worker persists the invalidation ID and polls until `Completed` without
  spending failure retries. Late remote writes reset the invalidation generation.
- The restore CLI validates the live journal by default. `--apply` reuses the
  existing DB erasure/financial safeguards and requires explicit restore isolation.
  Both modes require `--database-url` and `--expect-database`. After loading
  credentials/content settings it pins that URL before importing the common
  pool, checks `current_database()` before journal access or mutation, and
  configures content runtime before erasing restored staging uploads.
  It initiates no new trade, transfer, payout or withdrawal.
- Newly promoted user-owned media sends
  `Cache-Control: public, max-age=0, s-maxage=300, must-revalidate`: browsers
  revalidate and shared caches may retain it for five minutes. The worker still
  invalidates CloudFront. CMS-owned immutable media keeps its original policy.
  Existing year-fresh browser copies cannot be recalled by changing this code.

## Infrastructure update received — 23 October 2026

The backend/infra owner reports the private journal bucket is created in
`eu-north-1`, both required environment variables are present in `/opt/hunch/.env`,
and `hunch-prod-ec2-role` has journal, exact content-version erasure and CloudFront
permissions. The SDK uses the role credential chain; static AWS keys are not
required. These are owner-reported infrastructure results, not a live deletion
verification from this checkout. Code has not yet been deployed.

The DLM description now matches the applied template exactly:
`Daily Hunch tagged-volume snapshots - maximum 30 days.`
Snapshot automation and journal expiry remain **DISABLED**; old manual snapshots
remain intact. Do not enable journal expiry before every restorable older backup
has been addressed. The private report/applied template are on the infra owner's
machine; their full contents have not been independently compared here.

## First-release retention rules

Selected on 23 October 2026 for the public-document drafts:

| Record                                               | Rule                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Account/profile/posts/avatar                         | While needed for the active account, until deletion; no expiry just because a post is old                                                       |
| Accepted account deletion                            | Public access removed promptly; active-system/provider account cleanup within 30 days                                                           |
| Routine snapshots                                    | Maximum 30 days from creation; up to another 30 days after active-system erasure, at most 60 days from the request in the longest ordinary case |
| Minimal erasure journal                              | 90 days from the request, outliving every restorable backup                                                                                     |
| Identifiable routine technical/request/security logs | Maximum 30 days; volume limits may remove them earlier                                                                                          |
| Identifiable usage analytics                         | Scheduled cleanup at 395 days, matching the existing cleanup target                                                                             |
| Support/moderation cases                             | Up to 12 months after closure; unnecessary personal information is also covered by account deletion                                             |
| Specific legal holds                                 | Only the records and duration necessary for the particular obligation/claim                                                                     |

These are target release rules, not a claim that current production already
enforces them. Docker size/count limits already exist on develop; they do not
enforce 30 days. A time-based log policy, mailbox/case retention and reliable
analytics cleanup must be verified before publishing these promises.

## Activation order

1. Validate the CloudFormation change set using the actual API/worker roles,
   content bucket and distribution. The JSON template is prepared for review;
   no AWS validation/change set has been executed locally.
2. Create the separate private journal bucket and scoped IAM permissions. It
   must not be the public content bucket or a CloudFront origin. Set
   `ACCOUNT_ERASURE_JOURNAL_BUCKET` and
   `CONTENT_ASSET_CLOUDFRONT_DISTRIBUTION_ID` in the API/worker environment.
   The API needs journal Put/Get; the worker needs version listing/deletion and
   invalidation Create/Get. If both run under one role, attach both policies.
3. Apply `packages/db/migrations/0289_content_erasure_invalidation.sql` before
   deploying the API/worker. It adds nullable CDN fields without a volatile-default
   rewrite or whole-table backfill. It does not depend on migration 0288.
4. Deploy through the normal process. Verify the content worker is enabled and
   reconcile Privy deletion jobs. Test a controlled account end to end: API/DB,
   S3 versions/markers, CloudFront `Completed` and public profile/media removal.
   Recheck old completed jobs: completion under the old worker did not prove
   permanent version erasure. Verify no live asset uses a key before requeuing it.
5. Review volumes tagged `HunchBackup=personal-data`, activate the prepared daily
   DLM policy and verify actual expiry. The template starts **DISABLED** to avoid
   applying an unreviewed destructive retention policy to the wrong volume.
   Older manual snapshots/AMI dependencies need an explicit retirement plan;
   a new DLM policy does not manage them. Keep journal expiry disabled until all
   older restorable copies have been retired and the backup horizon is verified.
   Then enable the template's 90-day journal expiry and monitor lifecycle progress.
6. Verify the selected log, support/case and analytics periods before removing
   draft status from the public documents. No promise of a 30-day log maximum
   follows merely from the already-merged Docker size limits.

## Restore procedure

Keep API/public traffic and financial/social workers stopped. Restore into an
isolated DB, apply current migrations and grant the restore operator List/Get
access only to the live journal's `account-erasure/v1/` prefix. Do not overwrite
the live journal with a restored copy.

Set `HUNCH_RESTORED_DATABASE_URL` to the isolated restored DB's connection URL.
Specify its exact name separately; never use the live production DB. The optional
`--env-file` loads normal credentials/content settings, then the CLI overrides
only `DATABASE_URL` with the explicit restore target and prevents `env.ts` from
loading the repository `.env` again. Its isolation acknowledgement must already
be present in the invoking environment, not supplied by that file.

Validate without DB mutation first:

```sh
node apps/api/dist/account-erasure-replay.js \
  --env-file /opt/hunch/.env \
  --database-url "$HUNCH_RESTORED_DATABASE_URL" \
  --expect-database hunch_restore_20261023
```

After confirming isolation and reviewing the dry run:

```sh
ACCOUNT_ERASURE_RESTORE_ISOLATED=true node apps/api/dist/account-erasure-replay.js \
  --env-file /opt/hunch/.env \
  --database-url "$HUNCH_RESTORED_DATABASE_URL" \
  --expect-database hunch_restore_20261023 \
  --apply
```

The CLI checks pages of 100 records and reuses `AuthService.deleteUser`.
After replay, reconcile erasure/provider/storage queues with financial execution
still stopped. Confirm deleted public accounts/media stay absent before reopening
traffic. Repeat safely after interruption.

## Verification

The initial `f7000ddd` verification passed 16 workspace build targets, five
regression files and 15 SQL plans. Review corrections add real-entrypoint replay
tests and actual asset-promotion cache checks. The route fixture now exercises
the real journal with only the SDK boundary replaced, without `mock.module` or
a Node-only child-process flag. Node and Bun use their own executable.

Replay coverage exercises conflicting ambient/env-file DB URLs, actual connected
DB mismatch before journal access, URL/name mismatch, missing explicit target,
missing isolation acknowledgement, read-only dry run, invalid journal identity,
and the real `AuthService.deleteUser` staging cleanup path with configured TTL.
The same harness runs from source and compiled JavaScript. The SQL fixture now
plans the constant `current_database()` identity check as well (16 plans total).

Review follow-up verification passes on 23 October 2026:

- Full workspace build: 16/16 targets (14 cached, API and finance-worker rebuilt).
- Node 24.13.0 and Bun 1.4.4: 7/7 selected source regression files each.
- Compiled JavaScript replay CLI: all seven scenarios under each runtime,
  including real account/staging erasure with fake DB/AWS boundaries.
- PostgreSQL 16.15: 1m storage jobs and 16 EXPLAIN ANALYZE/BUFFERS plans under
  each runtime. The added identity check is a Result node, 0.013 ms with zero
  shared-buffer accesses in the last run. No production SQL was executed.
- Changed TS ESLint, scoped Prettier, `git diff --check`, CloudFormation JSON
  and the exact applied DLM description/disabled snapshot state.

| Operation                             | Observed execution time | Access path                         |
| ------------------------------------- | ----------------------- | ----------------------------------- |
| Enqueue/reopen (four cases)           | 0.073–2.847 ms          | Unique storage-key conflict arbiter |
| Reclaim stale processing jobs         | 0.130 ms                | Existing reclaim partial index      |
| Sparse/resumed selection              | 0.014–0.022 ms          | Existing pending partial index      |
| Claim/poll/progress/completion writes | 0.006–0.458 ms          | Primary key                         |
| Generic / empty-tail selection        | 0.069 / 0.635 ms        | Existing pending partial index      |

Generated plans live in ignored `build/compliance/erasure-sql-plans.json` and can
be reproduced with `account-erasure-sql-integration-tests.ts` using an explicit
local disposable PostgreSQL 16 URL/name through the repository test runner.
The migration is applied to the million-row fixture before query checks. This is
synthetic local evidence, not production performance or AWS verification.

The review checkout uses an independent copy of installed dependencies, with
workspace links rebound to this checkout. pnpm warns that cloned install metadata
has a changed workspace structure; no automatic install/purge is allowed during
build. The lockfile adds only the CloudFront client; a clean frozen-lockfile
install remains the normal CI/deployment step. In this pnpm runtime the checked
non-installing build command is:

```sh
pnpm_config_verify_deps_before_run=warn PNPM_CONFIG_PM_ON_FAIL=ignore ./node_modules/.bin/turbo run build --env-mode=loose
```

CloudFormation JSON parsing passes. The owner reports AWS prerequisites applied;
runtime role/env adoption, a controlled account erasure and an actual isolated
backup restore remain rollout checks. Old completed storage jobs need individual
live-reference verification before any repair; no mass requeue is implemented.
Clean frozen-lockfile installation and a deploy-equivalent Docker build are not
established by the local build with copied dependencies.

Primary references: [S3 versions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html),
[CloudFront invalidation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html).

## iOS account safety integration

- `POST /auth/me/age-confirmation` accepts only
  `{ "isAtLeast18": true, "policyVersion": 1 }`. It stores the first declaration
  timestamp/version, never a birth date. Existing sessions do not fabricate a
  declaration; account erasure clears it.
- Profile fields, theses and comments are checked before writing. Public reads
  also mask matching legacy text. The local rules cover selected English/Russian
  obscenity, slurs and direct threats, with NFKC/zero-width normalization.
  Reports and moderator reasons remain uncensored evidence; reports and human
  review are still needed for content outside these rules.
- User-owned avatar uploads require explicit AI-check permission, JPEG/PNG and
  at most 5,000,000 bytes. SHA-256-verified bytes are sent to AWS Rekognition in
  `eu-west-1`. Only a successful check permits public promotion; provider failure
  leaves the upload private and retryable. Version/ETag conditions bind the check
  to the promoted object. Administrators completing user-owned uploads follow
  the same checks. CMS media retain their existing policy.
- `remove_avatar` atomically clears the reviewed current avatar, marks its owned
  asset deleted, enqueues storage cleanup and records the moderation decision.
  The expected avatar URL rejects a stale moderator preview. The profile edit
  marker prevents the next provider login from resurrecting the removed photo.
  The current admin Social screen presents this action alongside suspension.

The original account-safety checkout and the deletion branch were combined by
individual changes; `new-analytics` was not merged. The first-release native
sign-in disclosure and consent flow are maintained in the iOS repository.

### Additional rollout steps

1. Review the `AvatarSafetyAccess` template policy with the API role. It grants
   only `rekognition:DetectModerationLabels`, constrained to `eu-west-1`.
   Primary S3/journal storage remains in `eu-north-1`. This template change does
   not apply IAM permissions or AWS settings. Check the provider arrangements
   and AI-service data-use settings before enabling real uploads.
2. Apply migrations `0288_account_age_confirmation.sql`,
   `0289_content_erasure_invalidation.sql` and `0290_avatar_moderation_action.sql`
   under the normal migration procedure. Do not run the restore CLI against the
   live production database.
3. Deploy backend/admin with the reviewed journal/CDN prerequisites, then verify
   one controlled account: age declaration, accepted/rejected avatar, stale
   moderation preview, avatar removal, account deletion, S3 versions and
   CloudFront `Completed`. This local integration does not deploy any service.

Local verification evidence is kept outside source control. The combined safety
and erasure SQL fixtures use an isolated PostgreSQL 16 cluster with one million
users, assets and storage jobs. They check age idempotency/inactive accounts,
atomic avatar removal, storage progress and sparse/resumed/generic queue plans.
AWS end-to-end checks and production rollout remain separate.
