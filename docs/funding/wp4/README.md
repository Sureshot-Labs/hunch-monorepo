# Funding WP4 implementation tracker

Status: **implemented and verified locally; not committed or deployed**

Date: 2026-07-23  
Branch: `unibalance`

## Objective

WP4 connects the provider-neutral WP1 contracts and WP3 durable reconciliation
boundary to a pinned Relay integration without activating funding creation. It
also isolates legacy bridge reconciliation identities from any future fallback
creation adapter.

WP4 does not implement destination selection, placement, Intent Liquidity,
planner APIs, wallet execution, or a local product UI. Those remain WP5–WP7.

## Delivered implementation

### Relay client and DTO boundary

- `RelayClient` owns Quote v2, Status v3, and Requests v2 transport.
- Requests v2 wire rows use official `id` plus ISO-or-numeric `updatedAt`;
  Relay-local normalization maps `id` to the internal `requestId` without
  leaking the provider DTO into shared funding code.
- The API origin is pinned to `https://api.relay.link`; runtime configuration
  cannot redirect the Relay credential to another host.
- Requests have bounded timeouts and response sizes. HTTP errors expose only
  status/retryability and never include the API key or provider body.
- The timeout covers connection, headers, and bounded response-body streaming;
  a peer cannot keep the worker waiting indefinitely after returning headers.
- Pinned Zod schemas and all raw Relay DTO types remain under
  `apps/api/src/funding-providers/relay/`.
- Canonical Hunch network/asset mappings cover only the WP0 rehearsal routes:
  Polygon, Base, and Solana, including Relay Solana chain ID `792703809`.
- Quote normalization is exact-input only and produces provider-neutral
  `ProviderQuoteCandidate` plus `NormalizedAction` values.
- Quote references and action IDs expose only one-way fingerprints. Raw
  request IDs are returned solely for encrypted persistence.

### Action and economics validation

- Existing WP0 live-rehearsal EVM and Solana validators are the provider-shape
  boundary. They verify exact chain, currency, amount, sender, recipient,
  request/check correlation, contract/program, calldata selector, spender,
  signer, account set, refund path, and minimum output.
- EVM transaction data accepts the exact observed executable field set only.
  Polygon native routing additionally pins the inner sequential-swap parameter
  envelope; EVM-to-Solana routing pins the Mayan target, order output, nested
  selector sequence, and unique Solana-recipient binding. Single-field target,
  selector, amount, envelope, and recipient mutations fail closed.
- `RelayPinnedActionValidator` is the final execution boundary. The action
  presented for execution must exactly equal the immutable normalized action
  that was committed.
- Signature/authorization actions are rejected.
- `authorizationList`, `depositFeePayer`, gasless, subsidy, and top-up
  capabilities are rejected individually by field presence.
- Relay fee normalization retains non-overlapping `gas`, `relayer`, and `app`
  totals. `relayerGas + relayerService` must equal `relayer`; the breakdown is
  not emitted as additional charge. Unknown fee shapes and nonzero subsidy fail
  closed.
- Quote expiry is capped locally, never exceeds the caller deadline, and is
  rechecked after the provider response so a slow request cannot return an
  already-expired executable candidate.

### Strict Relay Deposit Address

- The adapter always requests `tradeType=EXACT_INPUT`,
  `useDepositAddress=true`, `strict=true`, and an explicit `refundTo`.
- Initial executable scope is deliberately narrower than Relay's total
  capability: native EVM input, controlled-wallet sender, and the same verified
  user-owned source as refund location.
- Open/variable mode, exchange/manual sender mode, CEX refund assumptions,
  app-controlled refund, Privy-to-Relay composition, destination calldata, and
  address reuse are rejected.
- The response must bind the exact source, destination, amount, sender,
  recipient, deposit address, request ID, and status-check URL.
- The deposit transfer contains exactly one item and exactly the five expected
  fields (`chainId`, `from`, `to`, `value`, `data`); unknown executable fields,
  extra items, conflicting address fields, and an output below the caller floor
  fail closed.
- The plan records explicit underpayment, overpayment, wrong-asset/wrong-chain,
  refund, and request-plus-child tracking semantics. Wrong asset or chain stops
  automatic progress and enters manual recovery; recovery is explicitly not
  guaranteed.
- All Deposit Address routes remain absent from the runtime policy. The static
  registry entry describes reviewed code; it does not activate a route.

### Status, polling, webhook, and durable reconciliation

- Relay raw status is retained and classified, but every category is
  non-terminal for Hunch accounting.
- Relay `success` requires canonical owned-destination evidence. Relay
  `refund` requires canonical owned-refund evidence. Provider failure remains a
  reconcile/recovery hint.
- Unknown/drifted statuses such as `delayed` or `refunded` remain raw,
  non-terminal, and fail closed.
- Provider request IDs and deposit addresses use AES-256-GCM ciphertext plus a
  separate, domain-separated, versioned HMAC lookup.
- `finance-worker` polls Relay before the shared WP3 reducer. It discovers
  Deposit Address child requests with `includeChildRequests=true`, preserves
  initial-versus-child identity, stores safe status metadata, and wakes the
  same durable reconciliation job.
- Raw provider transaction-reference arrays are not copied into support
  metadata. Only counts and bounded provider failure codes are retained;
  actual transfers still enter through the WP3 observation allocator.
- `/webhooks/relay` captures the original request bytes, verifies
  HMAC-SHA256 over `${timestamp}.${rawBody}` in constant time with the Relay API
  key, enforces a replay window, persists a deterministic delivery fingerprint,
  and enqueues reconciliation.
- The webhook cannot directly mutate terminal operation state. Duplicate
  delivery is idempotent. A bounded durable fingerprint history suppresses
  non-adjacent replay, and provider timestamps suppress stale/out-of-order
  status regression while still waking reconciliation.
- If Relay secrets are absent, live polling and webhook ingestion fail closed
  while the provider-neutral WP3 reducer continues to process existing
  observations.

### Runtime secrets

No key is hard-coded, stored in a fixture, written to a provider row, or sent
to the browser.

| Secret/env key                         | Owner and use                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `RELAY_API_KEY`                        | API secret bundle; Quote/Status/Requests authentication and Relay webhook HMAC verification |
| `CREDENTIALS_ENCRYPTION_KEY`           | Shared secret bundle; AES-256-GCM encryption of provider request IDs and deposit addresses  |
| `FUNDING_REFERENCE_LOOKUP_HMAC_KEY`    | Shared secret bundle; independent lookup HMAC material                                      |
| `FUNDING_REFERENCE_LOOKUP_KEY_VERSION` | Non-secret version selector; defaults to `1`, invalid explicit values fail configuration    |
| `RELAY_REQUEST_TIMEOUT_MS`             | Non-secret bounded HTTP timeout; defaults to 10 seconds                                     |

Local development reads the existing ignored `.env`. Production
`finance-worker` already loads the shared and API AWS Secrets Manager bundles,
so `RELAY_API_KEY` is supplied by the API bundle and the encryption/HMAC keys
by the shared bundle. The route and worker use sidecar-local optional parsing;
they do not import API-wide required-secret configuration.

Relay polling is constructed only when the complete secret set is present.
An explicitly invalid lookup-key version fails configuration instead of
silently falling back to another version.

Relay's official webhook contract uses the same API key as the HMAC secret; a
second invented `RELAY_WEBHOOK_SECRET` is intentionally not introduced.

### External contract revalidation

Official Relay documentation was rechecked read-only on 2026-07-23:

- Quote remains `POST https://api.relay.link/quote/v2`;
- request status remains `GET /intents/status/v3?requestId=...`;
- Deposit Address child discovery remains
  `GET /requests/v2?depositAddress=...&includeChildRequests=true`;
- Requests v2 response rows identify the provider request as `id` (not
  `requestId`) and may return `updatedAt` as an ISO timestamp;
- Relay now also documents `EXACT_OUTPUT` for strict addresses; Hunch v1
  deliberately keeps only the narrower `EXACT_INPUT`, `strict=true`, and
  explicit `refundTo` contract;
- webhook verification still uses HMAC-SHA256 over
  `${timestamp}.${rawBody}` with the Relay API key.

The Status page still describes `delayed`/`refunded` while its response enum
lists `refund` and omits those values. Hunch therefore preserves unknown raw
statuses and keeps them non-terminal instead of inventing optimistic semantics.

### Legacy provider isolation

- `AcrossLegacyReconciler` identity covers both stored Swap API v1 and
  suggested-fees v1 rows.
- `BungeeLegacyReconciler` covers historical Bungee rows and has no Funding
  Operation creation adapter.
- `DeBridgeDlnLegacyReconciler` is separate from the same-chain legacy
  reconciler.
- Optional `AcrossSwapApiAdapter` and `DeBridgeSameChainAdapter` identities
  have empty new-route allowlists.
- Across suggested-fees, Bungee, and deBridge DLN are explicitly
  reconciliation-only for new Funding Operations.
- Every frozen legacy adapter version resolves to exactly one legacy
  reconciler. Historical `bridge_orders` are not rewritten.

## Static registry and activation boundary

The first reviewed production-component registration now contains:

- Relay Quote v2 and strict Deposit Address adapter identities;
- EVM and SVM action validator identities;
- Relay Status v3 and all legacy reconciler identities;
- owned-refund and owned-destination observation semantics;
- the pinned WP0 Relay fixture IDs.

This is code registration, not product activation:

- default `creationMode` remains `off`;
- default providers and routes remain empty;
- quote, commit, and start-unsubmitted-action gates remain closed;
- the network-executor registry remains empty;
- fallback allowlists remain empty;
- no policy row was published.

Therefore no Relay quote or transaction is reachable from a user product path
until WP5 supplies an exact enabled route and WP6 supplies a reviewed network
executor.

## Verification evidence

Completed locally on 2026-07-23:

- API typecheck and ESLint: pass;
- finance-worker and config typechecks: pass;
- repository format check: pass;
- API fast suite: 27/27 files, including the Relay fixture, EVM, Solana,
  runtime, action mutation, and webhook suites;
- finance-worker suite: 11/11;
- secret-bundle suite: pass;
- legacy compatibility suite: 26/26 assertions;
- focused WP3 + WP4 database integration suite: 2/2 files;
- deterministic Type-1 duplication audit over 28 touched-surface files:
  2.50% duplicate coverage and 1.25% estimated redundancy; the higher Type-2
  similarity is dominated by intentional VM-specific guards and test builders,
  with no abstraction required for WP4.

The Relay database integration test proves:

- committed initial request correlation is encrypted/HMAC-separated;
- Requests v2 discovers exactly one new child and replay discovers none;
- initial and child identities remain distinct and idempotent;
- raw provider transaction-reference arrays are not persisted as support
  metadata;
- signed webhook replay and stale/out-of-order status regression are detected;
- Relay `success` before and after webhook ingestion leaves the operation
  non-terminal without a destination observation;
- cleanup leaves no test operation, quote, request, or user row.

No external Relay request, wallet signature, broadcast, live transfer,
production SQL, policy publication, deployment, commit, or branch change was
performed during WP4 implementation.

Repeatable commands from `hunch-monorepo`:

```bash
pnpm -F api run test:fast
pnpm -F api exec tsx src/test-runner.ts --integration \
  funding-persistence-integration-tests \
  relay/reconciliation-integration-tests
pnpm -F finance-worker run test
pnpm -F @hunch/config run test
pnpm -F api run typecheck
pnpm -F api run lint
pnpm -F finance-worker run typecheck
pnpm format:check
```

## Completion boundary

WP4 is complete as a locally verified provider adapter, strict Deposit Address,
reconciliation, webhook, secret-injection, and compatibility-isolation
milestone.

WP5 is the next product-enabling package. It must implement exact destination
options, placement, Intent Liquidity, deterministic Relay-first single-segment
planning, durable quote/consent APIs, and route economics. Until that work and
WP6 network execution are complete, local user testing of the new Add Funds,
Buy shortfall, or unified funding journey is intentionally unavailable.
