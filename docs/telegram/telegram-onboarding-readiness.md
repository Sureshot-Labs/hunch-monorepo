# Telegram onboarding readiness v1

Backend implementation and read-only investigation, 9 September 2026.

## Production evidence

The inspected API image was `hunch-backend:f6755c2`, started at
03:14:14 UTC. It includes the Receive identity fix from `3231bfe8` but does
not yet expose `status.onboarding`.

The active Telegram policy was `always`, handoff v2. Normalization deliberately
disables automatic bot enrollment in this mode.

For account `30443c9f-32bd-41b9-b965-5767df67db7b`, intents
`346113bd-de6a-45f3-b7a8-6234bbbaa837` (07:12:43 UTC) and
`53629e7a-06ae-4d2c-be49-3b13b55c31c2` (07:17:17 UTC) recorded
`fundingReasonCodes: ["destination_unavailable"]` with `app_handoff`
delivery and no trading authorization. Neither submitted a Buy. Verified
internal EVM and Solana wallets existed. Venue credential records were first
created at 07:24:55–07:24:58 UTC, after those failures.

Filtered API logs also contain three `destination_ambiguous` Deposit failures
around 07:08–07:16 UTC. Those log entries do not identify the account; timing
alone does not prove that all three belong to this user.

Production queries and logs were read-only. No funding state, reservation,
authorization, transaction, deployment or production policy was changed.

## Cause and changes

Polymarket `fund` preparation included CLOB visibility and Router readiness /
allowances. New receiving wallets could therefore fail destination selection
before trading credentials existed. `fund` now requires owned, supported,
deployed wallet identity, fresh RPC evidence and observed collateral, including
zero. Buy retains its CLOB, credentials, Router, exchange and quote checks.
Conversion source adapters retain their exact transaction and approval checks.
This change is not permission to wrap, trade or spend on a status request.

One read-only readiness projection now drives the public status contract and
the Welcome delivery check. It uses existing managed identity, funding
destination/preparation and Solana Receive-menu checks, without creating a
session, requesting a Relay quote, installing a signer or sending funds.

- `mini_app`: `always/v2`, independent of bot preferences/authorization.
- `account_only`: explicit opt-out outside `always`; verifies Receive only.
- `bot`: additionally verifies the exact current controller's enabled
  authorization and ready signer. An unfunded venue is not itself a failure.
- Missing venue/class evidence cannot be treated as successful partial coverage.
- Controller/link and policy revision are rechecked before returning ready.
- Initial incomplete preparation is pending for at most 60 seconds from linking;
  then it is blocked with a retry instruction. A fresh successful inspection
  can recover it without an enable/disable cycle.

First-login signing/provisioning stays in the existing frontend
`AuthPolymarketWalletBootstrap` and managed claim/finalize mechanisms. The status
endpoint does not replace these jobs or bypass user signatures.

New links in `always` no longer auto-request bot access. Existing preferences,
including explicit opt-ins/opt-outs, are preserved. There is no migration.

Welcome waits for the same readiness, preserving outbox deduplication and
current-link checks. Setup waiting retries every 60 seconds for up to 24 hours
without consuming Telegram send attempts; old terminal welcomes are not revived.
The signal-bot uses one bounded background delivery task so venue RPC cannot
block callback polling. The sidecar calls an authenticated internal API endpoint
and does not import API-only runtime secrets.

Unresolved Buy preparation now displays a retryable failure instead of a
permanently working-looking card. `fundingReasonCodes` remain available. Deposit
destination ambiguity now instructs the user to finish wallet setup in Hunch,
without demanding Bot trading or exposing an unverified address.

## API and rollout

Authenticated `GET /telegram/bot-trading/status` preserves existing fields and
adds the schema/OpenAPI field:

```ts
status.onboarding = {
  version: 1,
  state: "pending" | "ready" | "blocked",
  mode: "mini_app" | "bot" | "account_only",
  policyRevision: string,
  walletAddress: string | null, // verified internal EVM controller
  walletChain: "ethereum",
  reasonCode: string | null,
  message: string | null, // at most 240 characters
};
```

For ready, the address is non-null and reason/message are null. This is setup
readiness, not a guarantee that a particular amount, market or route executes.
Current Buy quotes, fees, funding and authorization checks still apply.

Deploy backend first, then the companion frontend contract. This task changes
no frontend files. No manual DB cleanup is required for this fix. The code has
not been committed, pushed or deployed by the agent.

## Verification and remaining live check

Local verification covers:

- New zero-balance account, no bot authorization, readiness recovery without a
  toggle, ownership ambiguity, changed controller/policy and missing class.
- Enabled Solana Receive with no wallet fails closed; disabled Solana routes
  do not require a Solana wallet.
- Public HTTP response serialization retains policy/status fields; internal
  Welcome uses the same result and rejects a foreign link.
- Real PostgreSQL 16 parses/executes new readiness and Welcome deferral SQL;
  deferred Welcome sends once after readiness, creates no funding operation or
  trading authorization. Test changes roll back in a disposable database.
- Existing Receive integration, including retained SOL/USDC ownership and
  delivery; existing Telegram claim/finalize and trade lifecycle regressions.
- Funding unit regressions preserve Buy/conversion safeguards after separating
  Receive requirements; signal-bot callback regressions remain covered.

Passed: 67/67 funding unit files, 261/261 signal-bot checks, targeted Deposit,
Welcome, preferences and readiness unit tests, and three PostgreSQL 16
integration suites (readiness/HTTP/Welcome, Receive, trading lifecycle).
API TypeScript, changed-file ESLint, Prettier and `git diff --check` passed.

External readiness observations in integration tests are fixtures, not live
Privy/RPC execution. After rollout, verify a fresh Telegram login, ready status,
retained SOL/USDC receive address and user-signed Buy preparation without Bot
trading. Do not infer live end-to-end success from local tests alone.
