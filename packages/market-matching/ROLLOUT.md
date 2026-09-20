# Jev matching: rollout and rollback

The matcher is part of the normal backend deployment on push to `main`.
Deployment updates code; the runtime policy independently controls paid work and
consumer activation.

## Defaults and ownership

The existing `market_matching` runtime policy is the only operational control
plane. The admin editor is **App → Arbitrage → Jev Market Matching**, using the
existing permissions, effective time and version history. Save the current full
policy before editing; overrides replace the previous snapshot, not merge patches.

All producer/consumer switches default to false. The initial daily budget is $1;
an administrator can set another nonnegative finite amount, including above $2.
The independent request guard defaults to 5,000 attempts/day, including retries.
It is an abuse/traffic guard, not a conversion of dollars into tokens. Actual
charges plus outstanding reservations must fit the budget. Raising the request
guard does not raise the dollar budget. Lazy demand has its own smaller share.

The matcher independently samples up to 300 seeds every 15 minutes: 75 indexed
trending, 75 Limitless historical-volume, 60 feed/movers, 45 map sidebars and 45
whale-activity markets, before deduplication. It reads existing product APIs;
it does not modify, depend on or run from the API cache-warming job. Browser GETs
do not enqueue inference. Venue lifecycle/full-indexing eligibility still applies.

## Prepare the release

1. Review the backend, frontend, admin and public-agent changes.
   Build their normal release artifacts. The backend application Dockerfile includes
   both new workspace package manifests. Do not change venue lifecycle policies.
2. Verify migrations through `0261_market_matching.sql` on disposable PostgreSQL 16.
   The migration creates empty tables, with no historical-data fail-fast assertions.
   Normal backend deployment runs migrations before stopping application services;
   a migration failure leaves the currently running API and workers online.
3. Deploy API before clients that read `/matching/config`; deploy admin and clients
   with all matching policy switches still false. Existing sources remain selected.
   Invalid matching policy is an error, not permission to silently use AGG.
4. Merge backend `develop` into `main` and push through the normal release process.
   Compose starts **one `market-matcher` service**, with these service-owned settings:

   ```text
   HUNCH_SECRET_BUNDLES=aws-sm:/hunch/prod/shared,aws-sm:/hunch/prod/ai
   MATCHING_DISCOVERY_API_URL=http://api:3001
   node packages/config/dist/run-with-secrets.js apps/market-matcher/dist/main.js run
   ```

   The bundles must provide `DATABASE_URL` and `OPENROUTER_API_KEY`. Do not load
   wallet/Privy/API secrets into this sidecar. The first rollout validates and
   gracefully replaces the known standalone container after migrations succeed.
   Later deployments update the Compose service normally, allowing 120 seconds
   for shutdown. Deployment verifies a fresh worker heartbeat, no restarts and
   the same image ID as API. Disabled policy keeps the loop healthy and idle.
   The matcher has its own loop; no second cron is needed. Missing product API configuration is
   reported in selector status and leaves only the two bounded DB seed sources.

## Shadow operation and switching

1. Run the bootstrapped entrypoint with `status`. Confirm the effective policy,
   zero/expected queue and budget, and no model/cost halt. `report` summarizes
   evaluation counts and cost. Neither command runs inference.
2. In the policy editor enable only `workerEnabled: true`; keep all consumers and
   `lazyEnabled` false. Keep the measured initial limits ($1 and 5,000 attempts/day).
   `run` notices policy changes without a restart. `scan` does bounded discovery
   without inference; `run-once` processes one bounded iteration, not the backlog.
3. Inspect the worker logs, `market_matching_state` selector counts/failures, daily
   `market_matching_budget`, job age/errors, and approved/reviewed evaluations.
   Compare actual product coverage and reject reasons. Native quotes are separate:
   a missing price must not invalidate a link or make an instrument executable.
4. Enable consumers separately in the same policy: `alternativesEnabled`,
   `eventsEnabled`, `clustersEnabled`, `telegramEnabled`, `signalsEnabled`,
   `agentsEnabled`. Their source decisions are independent. `similarEnabled` is a
   separate optional recommendation boost; leave it false initially. The app and agent
   clients read `/matching/config`; the app refreshes it every 30 seconds.
   Explicit agent `--source agg` remains an intentional legacy selection.
5. Keep `lazyEnabled` false initially. Enabling it later still requires authenticated
   POST demand, rate limits, actor quotas, deduplication, cooldown and its reserved
   queue/budget share. It never bypasses the common daily budget.

## Pause or roll back

- Pause paid work: set `workerEnabled: false`. The next operation stops; in-flight
  publication rechecks the policy. The in-flight provider request may already
  have incurred a charge. Existing evidence and consumer settings are preserved.
- Roll back a consumer: set its `*Enabled` field false. Its legacy source is
  explicitly selected where one exists; event alternatives become disabled.
  To roll back everything, disable the worker, lazy demand and every consumer.
  Do not delete matching tables, historical decisions or AGG credentials.
- A malformed policy fails closed. Restore the last valid full policy through
  the editor/history. Environment `MATCHING_*_ENABLED=false` remains an emergency
  kill switch; setting it true cannot override a disabled policy.
- A returned model-version or cost drift latches a halt. Investigate the saved
  evidence, calibrate the changed provider behavior and perform an explicitly
  reviewed reset. Raising a budget or toggling the worker must not clear that halt.

## Meaning of quality and related markets

An event link groups a real-world question; it does not authorize contract or
outcome substitution. Only explicit approved outcome mappings can be executable,
and only through a supported native quote adapter. Named outcomes with unsupported
instruments remain informational. Partial event coverage is shown explicitly.

The existing Redis embeddings pipeline remains the candidate source for
`/markets/:id/similar`. The separate `similarEnabled` policy defaults to false.
When enabled, at most three existing candidates can move up on a current Jev
`related` event decision meeting .95 probability/.90 confidence and a compatible
child selection. It preserves membership and cosine scores, checks model/revision,
snapshot freshness and venue lifecycle on reads (including embedding-cache hits),
and makes no inference calls. Failure leaves the embedding result unchanged.
`different`, `inverse`, missing information and weak `related` do not qualify.
No embeddings worker or index changes. The actual sample had zero qualifying
related decisions: utility is not yet demonstrated and the default remains off.

## Prices and release/evidence versions

Native alternative reads include explicit execution offers from current YES/NO
orderbook tops. API market alternatives and matched-cluster reads pass bounded
visible market IDs to the existing hot-token/price-refresh mechanism. The browser
polls alternatives every 15 seconds regardless of the cached source, so an open
AGG view can observe a policy switch, and native arbitrage every 30 seconds
while visible. Telegram native search also hands alternatives to refresh. Missing/stale prices do
not delete links, and stale or unsupported offers cannot become executable. A
first read of a cold Polymarket market may legitimately have no usable price until
the existing refresh worker catches up. Do not widen freshness to hide this.

This is product **v1**; the runtime-policy schema is **version 1**. Internal
`matching-v3-source-links` and `matching-evidence-v3` identify the interpretation/request revision
used by local experiments. They invalidate old approvals after semantic changes;
they are not deployed product versions or browser-cache versions. The provider
model is separately pinned. Budget/source edits do not invalidate paid evidence.

Before broad source switching, use [SCALE-VALIDATION.md](SCALE-VALIDATION.md) and
[AGG-DISAGREEMENTS.md](AGG-DISAGREEMENTS.md). AGG is a comparator, not ground truth.
The local release is suitable for disabled rollout/shadow verification; matching
AGG's complete production coverage has not been demonstrated.

## Same-venue matching, inverse contracts and another venue

Keep `sameVenueEnabled: false` initially. Enabling it permits distinct same-venue
candidate pairs under the existing budget and strict gates; disabling hides their
links on reads. API/MCP can return these links, but current Smart Buy presents one
row per venue and the live arbitrage verifier requires different venues. This
optional path has controlled SQL tests, not a live calibration. Self links are
excluded at admission, queue, worker and resolver boundaries.

Inverse answers remain review-only. Explicit reversed outcome mappings are
supported by consumer direction handling and covered by synthetic tests. The legacy
Telegram YES-price picker excludes inverse/partial mappings. There
is no manual approval endpoint or permission to promote an inverse answer alone.

For a new venue, first implement/verify its unified indexer metadata (original
question, event membership, complete settlement rules, stable token/outcome IDs),
then native quote/execution adapters and lifecycle capabilities. Add the venue to
`MATCHING_SUPPORTED_VENUES` in shared policy and the application's venue types.
The registry drives matching policy, product-ID extraction and eligibility.
Reuse the common queue, schema, budgets, request builder and resolver. Add captured
normalization/rule/quote regressions and a separate calibration before selecting
the venue in production policy. Policy alone cannot enable unimplemented adapters.
