# Account erasure hardening — backend review

`DELETE /auth/me` previously removed active database records but could leave S3
object versions, public CDN copies and restorable snapshots behind. This branch
purges exact-key object versions, waits for CloudFront invalidation and records
deletion intent outside the database volume before acknowledging it.

Scope is account/media erasure, recovery, tests and reviewable AWS configuration.
It contains no age confirmation, content classifier, moderation UI or iOS changes.
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
  It initiates no new trade, transfer, payout or withdrawal.

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

Run `node apps/api/dist/account-erasure-replay.js` to validate records without
DB mutation. Then set `ACCOUNT_ERASURE_RESTORE_ISOLATED=true` and run it with
`--apply`. The CLI checks pages of 100 records and reuses `AuthService.deleteUser`.
After replay, reconcile erasure/provider/storage queues with financial execution
still stopped. Confirm deleted public accounts/media stay absent before reopening
traffic. Repeat safely after interruption.

## Verification

Local verification passes: all 16 workspace build targets; five unit/route/worker
regression files (erasure SDK, API ordering/503, worker progress, existing content
and Privy reconciliation); changed TypeScript ESLint; and the fenced PostgreSQL
16.15 test with one million storage jobs and 15 EXPLAIN ANALYZE/BUFFERS plans.

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

CloudFormation JSON parsing passes; AWS change-set/IAM/CDN validation and an
actual isolated backup restore remain rollout checks.

Primary references: [S3 versions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html),
[CloudFront invalidation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html).
