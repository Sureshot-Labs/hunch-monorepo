# Authenticated iOS onboarding, APNs and trader rankings

18 October 2026. Implementation prepared in this repository and `hunch-ios`.
Apple credentials/capability, production migration/deployment and a real-device
delivery smoke are **not performed** by this change.

## Product scope

Guest access/routing is unchanged. Interest-driven Home ranking remains a
separate stage. Existing interest storage, profile writes, Passkey linking and
canonical onboarding progress are reused.

Notification choices are account preferences. Defaults are market resolution,
followed Hunches and new markets on; big moves off. No preference row means no
native push subscription. The app asks for OS permission only after an explicit
Continue/Enable action. Denial may finish onboarding with
`not_applicable/capability_unavailable`; it never claims delivery permission.
Save/registration errors remain retryable and explicit Skip remains available.

| Topic               | Actual source and behavior                                                                                                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `market_resolution` | Existing `position_resolved` notifications, which already check visible owned holdings. The existing notifications row is committed before asynchronous native fanout.                                                                                                                                                      |
| `followed_hunches`  | New verified user-thesis publication; follow must predate publication. Hidden/invalidated content, inactive/suspended authors and blocks are rechecked before delivery.                                                                                                                                                     |
| `new_markets`       | One daily roundup at **12:00 UTC**, containing up to three newly added active Polymarket/Limitless markets from the preceding UTC day. No interest ranking or historical catch-up.                                                                                                                                          |
| `big_moves`         | Owned, visible positive positions; a fresh canonical YES midpoint moves by at least **10 percentage points** versus the existing 24-hour reference. Missing/crossed/stale prices produce no signal. At most one queued signal per account/market in a rolling **24 hours**; current ownership is checked again before send. |

The 24-hour reference is `unified_token_change_24h.avg_mid_24h`, matching the
existing indexed price-history basis. The actual `bucket_24h` must match the
hourly 24-hour reference within the existing two-hour baseline tolerance;
a freshly updated cache cannot revive old history. It is a probability difference, not a
relative percentage return. Positions use the existing contract-aware identity
lookup, including Polymarket asset binding.

## API

All personal endpoints use the existing Hunch bearer/session/CSRF middleware.
GET is private/no-store; mutations reject owner IDs in request bodies.

- `GET /users/me/notification-preferences` → version, revision, enabled and four topics.
- `PUT /users/me/notification-preferences` → expectedRevision and full choices.
  Accepted retries are idempotent; a stale different choice returns 409 with
  canonical `preferences`. Category/master opt-in timestamps prevent old jobs
  becoming a notification backlog after re-enabling a topic.
- `PUT /users/me/push-devices/:id` → token, sandbox/production environment and
  OS authorization state. `id` is an installation UUID kept in native Keychain.
  Account/session come from middleware. The transaction locks and rechecks the
  active session against concurrent logout. After potentially waiting writes it
  rechecks the session deadline using wall time, so transaction-start `now()`
  cannot authorize a session that expired behind a lock. Reassignment invalidates old jobs.
- `DELETE /users/me/push-devices/:id` → remove only the current account/session's binding.
- `GET /users/rankings?limit=&cursor=` → independent Best traders page, using
  the existing profile shape with nullable compact `statistics`.
- Existing `/users/suggestions` and connection lists now include nullable
  compact cached statistics in one query, without per-row profile API calls.

Devices are bound to an active, unexpired authenticated session. Delivery
rechecks session, account, device generation, topic/authorization and source
visibility. iOS stops APNs registration and clears delivered notifications on
account exit/change, suppresses wrong-account foreground banners and validates
notification destinations against the signed-in account. Taps open the market;
digest/missing targets open Discovery. Account deletion clears devices,
preferences, cooldowns and trader data; source devices/preferences do not move
to the target of an account merge.

## Durable delivery and statistics

Migration 0282 adds preferences, devices, source events, the delivery queue,
cooldowns and resumable cursors. Source triggers enqueue a reference only;
they never call Apple or fan out to all followers in a publishing transaction.
0283 adds concurrent source/ownership indexes. 0284 adds trader caches and
immutable ranking snapshots. 0285 adds nonrepeating registration identities and
keeps overdue authors' queue priority when a Hunch changes. There is no historical million-author migration
backfill: the worker seeds distinct authors with a resumable index skip-scan.
0286 removes cache creation from the AFTER-thesis trigger. Every mutation appends
an independent UUID invalidation signal without a user foreign key. Writers do
not lock shared per-author cache/marker rows after locking theses. Before
calculating statistics, the worker drains at most 100 signals: ordered user `NO KEY UPDATE` locks, marker removal, then eligible cache
insertion, in one transaction. Deleted/suspended owners are discarded, failed
promotion rolls back the marker removal, and lifecycle cleanup removes pending
markers. This avoids acquiring a user FK after locking a thesis, including proof
invalidation, moderation and multi-statement merge writers. A late producer
commit leaves its independent signal for the next worker iteration; a committed
signal during calculation keeps the author due. No financial writer needs a new lock.

Delivery workers claim bounded batches with `SKIP LOCKED` and a lease; APNs
transport uses HTTPS/HTTP2, ES256 provider JWTs, the correct device environment,
`apns-topic=trade.hunch.app`, alert type, expiration and a stable delivery ID.
Transient/429/server/provider-auth failures retry with capped backoff; invalid
devices deactivate only their captured registration identity, including after
delete/recreate of the same installation UUID. Queue insertion takes all recipient
user locks in UUID order before device/FK locks; Big moves takes that same account
lock before touching cooldown. These are `NO KEY UPDATE` locks: they serialize
native/account writers while allowing a merge's third-party FK `KEY SHARE` checks.
Eligibility is re-read after the account lock, and eligible devices are locked in
UUID order against concurrent token transfer. Source cursor, enqueue and cooldown
commit together. A cooldown is written only when at least one device delivery was
actually inserted, so an open Apple permission prompt or expired session does not
consume the day's signal. Delivery rechecks market close/expiry as well as ownership.
Cooldown retention locks candidates with `SKIP LOCKED` and rechecks age, preserving
concurrent renewals.
Retries after an ambiguous network failure are at-least-once; APNs acceptance
does not prove display on a device. No raw device tokens, private keys or
notification content are logged. Completed jobs/source events retain seven
days; pending messages expire after 24 hours; cleanup is bounded and indexed.
Source generation, ranking, cleanup and delivery isolate failures by stage;
a failed source or housekeeping operation does not skip the other topics or
already queued delivery. Worker database statements have a 10-second timeout
and connection acquisition is bounded to five seconds. Recovery on the next
cycle is covered by a fault-injection test.

Trader statistics reuse `SocialService.profileStatistics` and its exact runtime
window/minimum sample, including unresolved, fractional, void and invalidated
groups. Zero win rate stays `"0"`; an insufficient sample stays null. Cache and
snapshot compatibility uses a dedicated algorithm/window/minimum-sample revision;
unrelated social policy changes keep both the ranking and its cursors valid.
Ordinary refresh becomes due after 15 minutes. A policy transition promotes at most
100 cache rows per worker iteration through a durable UUID cursor, including legacy
cache hashes and policy reversion; it does not wait for the ordinary due time.
Snapshots publish immediately when the bounded top-1000 result changes, including
empty/partial-cache recovery. Identical results keep the five-minute cadence.
A separate refresh loop processes bounded 50-author batches, at most four
authors concurrently, draining full batches without the push loop's five-second
pause. Seeding failures do not prevent refresh. Snapshots and connection lists
retain last-known statistics from compatible statistics rules while refresh catches up;
an author does not disappear merely because their cache is over an hour old.
A public ranking
contains up to 1,000 eligible traders, ordered by win rate, resolved sample,
then identity; each cursor stays on one snapshot for up to an hour. Current
viewer/self, blocks and inactive/suspended authors are filtered on each read.
Expired cursors return `trader_ranking_expired` and can restart explicitly.
Statistics may lag a freshly resolved profile while the background refresh runs.
Relevant statistics-rule changes invalidate old cursors and never relabel old
calculations as new-policy results. Seed and snapshot publication lock their user
owners in UUID order before derived-row writes and recheck active/public eligibility,
so concurrent lifecycle cleanup cannot recreate an inactive account's trader rows.
At an empty seed tail the cursor resets to null and pauses for one day. The next
bounded scan revisits earlier UUIDs, including authors skipped while suspended
and missing cache rows; it does not remain pinned to the old maximum UUID.

## Activation runbook

1. Apply migrations **0282 → 0283 → 0284 → 0285 → 0286** before deploying the API/worker image. 0283
   is deliberately nontransactional because it builds concurrent indexes.
2. Deploy the API/worker image. Provide `DATABASE_URL` in
   `/hunch/prod/native-onboarding-worker` (or the explicitly selected equivalent
   secret bundle), then run the worker with the optional Compose
   `native-onboarding` profile. The new service is not started implicitly by
   an existing deployment. Ranking/fanout/retention work with
   `HUNCH_APNS_DELIVERY_ENABLED=false`; Apple keys are not required in this mode
   and it sends no Apple requests.
3. In Apple Developer, enable Push Notifications for App ID `trade.hunch.app`
   and regenerate/download the required signing profiles. Create an APNs
   authentication key with permission for this topic and required environments.
4. Add `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` to that worker secret
   bundle, retaining `DATABASE_URL`. The private key stays server-side. PEM newlines may be real
   newlines or escaped `\n`; never put the key into the iOS bundle or Git.
5. Set `HUNCH_APNS_DELIVERY_ENABLED=true` and start/restart
   `native-onboarding-worker`. Misconfigured credentials fail activation or
   produce machine error codes; they do not silently disable user choices.
6. Ship the matching iOS build after API availability. Debug uses the
   development entitlement/sandbox; Release/TestFlight uses production. The
   app's bundle ID, signed entitlement and API device environment must agree.
7. On a physical device, sign in with a dedicated test account, select topics
   and accept the real permission dialog. Trigger a test-account-only known
   source event. Verify foreground/background display and market/Discovery
   taps, then decline permission, disable a topic, log out and change account.
   Confirm these paths stop the old subscription. Do not use production
   broadcast queries or mass notifications as a smoke test.

Apple references: [registering with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
[sending requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).

Rollback: disable/stop the optional worker first, then roll back application
code. Keep additive tables/preferences. Existing web/Telegram delivery remains
independent. Never roll back by deleting account choices or pushing old jobs.
After 0286, retain or restore a worker image that drains the append-only
statistics signals; an older image cannot consume them. Stopping that worker
preserves pending work for restart but pauses statistics updates.

## Verification

Run `test:native-onboarding` and `test:native-onboarding:integration` from the
API package. Integration requires explicit `--database-url` and
`--expect-database`; it creates only a fresh schema in that selected disposable
PostgreSQL 16 database. The scale suite uses one million users, 100,000 trader
summaries/theses/positions, 400,000 follow edges, 50,000 devices and 100,000
queued deliveries plus 100,000 pending statistics signals. It records actual custom/generic `EXPLAIN ANALYZE BUFFERS`
plans in `docs/verification/native-onboarding-sql-scale.json`. This is local
representative-scale evidence, not a production plan/latency claim.

Verified locally on 18 October 2026 after the stabilization fixes:

- Full workspace build/typecheck/lint exited **0**, **47/47** tasks succeeded.
  This includes the complete build rather than only API typecheck.
- The broad API fast suite was run and still stops at the pre-existing
  `@coral-xyz/anchor` named `BN` import in `account-value-tests.ts` under the
  installed Node 24/dependency environment. Running the remaining filters passed
  **63/63** files; only `account-value-tests` and `telegram-account-value-tests`
  filters were excluded. Social/policy/admin-social unit regressions additionally
  passed **3/3** files. No automatic dependency install/purge was performed.
- PostgreSQL 16 integration/race/locking/ranking-policy/SQL-scale/social-lifecycle
  regressions passed **9/9** files. The locking suite contains **28** explicit
  barrier/recovery cases, including merge with a third-party follow FK, active
  keep-source merge, token transfer to a new installation, queued market
  close/expiry and stale delivery lease finish/retry. Real `clearUserSocialData`
  and `mergeUserSocialData` consumers are exercised with isolated fixture tables.
- The final SQL-scale suite was rerun with batch-100 and no-device queue plans,
  first/resumed/empty policy cursors, sparse inactive leaders and an empty policy.
  Evidence contains **224** custom/generic plans on one million users;
  the slowest statement took **548.759 ms**, below the fixture's two-second
  assertion. Sparse ranking returned ten eligible authors from 100,000 summaries
  and measured **102.275 ms** custom / **86.525 ms** generic. These are local
  representative-scale measurements, not production latency claims.
- New trader regressions additionally pass **13/13** lifecycle/promotion cases,
  **2/2** producer-commit/merge cases and **6/6** seed/recovery cases. The producer
  committing after an earlier drain keeps its own signal for the next refresh;
  a multi-statement merge and concurrent hide never share an AFTER-trigger lock.
  The next daily seed revisits authors skipped during suspension.
- New regressions were red before the fixes: native register/enqueue deadlock,
  cooldown without a queued device, unrelated policy invalidation, lifecycle FK
  lock inversion, and delivery after a market deadline. Previous session/logout,
  wall-clock expiry, APNs registration identity, concurrent cooldown retention,
  actual history-bucket and aged-ranking-backlog regressions still pass.
- The actual secrets-wrapper and worker entrypoint were launched with only the
  local test `DATABASE_URL`, an explicitly empty test env file and APNs delivery
  disabled. Both source/ranking loops wrote their expected cursor/snapshot state,
  emitted no stage failures and stopped on SIGTERM with exit **0**. The empty
  env file matters because the secrets wrapper intentionally loads its selected
  env file before runtime bundles.

This verifies prepared source and local behavior. Production migrations,
deployment, Apple capability/keys and the physical-device delivery smoke above
remain required before enabling live native push.
