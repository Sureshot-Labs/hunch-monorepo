# Hyperliquid HIP-4 integration: backend development specification

## Status, scope, and evidence

This is the backend source-of-truth specification for `hip-next`, researched on
2026-10-05. It is a development plan, not an assertion that HIP trading, funding,
matching, or wallet intelligence is implemented or production-ready.

| Repository             | Branch / immutable reference                                         |
| ---------------------- | -------------------------------------------------------------------- |
| Backend baseline       | `main` / `origin/main`: `2ade5f71c3131a6b758c24e308dd4e8ddd11f571`   |
| Frontend baseline      | `main` / `origin/main`: `3321fc06dc0889e045f9fe57882a11496c26522b`   |
| Old backend prototype  | `hip`: `dce2d7cd`, June 2026                                         |
| Old frontend prototype | `hip`: `d29c056d`, June 2026                                         |
| New work               | Both repositories: `hip-next`, created from the above main baselines |

Read the companion [frontend specification](../../Hunch_App/docs/hyperliquid-hip4-integration.md)
for client contracts, product surfaces, and user interaction tests. Paths in this
document refer to this repository unless another repository is named. Historical
paths prefixed with `hip:` exist on the pinned old branch, not necessarily here.
Use `git show dce2d7cd:<path>` to inspect them without switching branches.

For compact source tables, domain paths beginning `account-value/`, `funding/`,
`lib/`, `repos/`, `routes/` or `services/`, and API entrypoint filenames, are
relative to `apps/api/src/`. Paths beginning `apps/`, `packages/` or `docs/`
are repository-relative. A filename mentioned beside a full path denotes a
sibling in that named domain, not a new top-level module.

Evidence labels used below:

- **Current code:** inspected at the pinned main baseline.
- **Historical code:** inspected at the pinned prototype; useful reference, not current support.
- **Protocol documentation:** official provider documentation inspected on the research date; not a live route or account test.
- **Required design:** proposed Hunch behavior, to implement and test.
- **Unverified:** needs a bounded, separately authorized read-only probe, fixture, or implementation test.

Only documentation is changed in this task. No application code, schema, secrets,
policies, production records, transactions, paid requests, commits, or deployment
are included. Public documentation was read; no live quote, exchange action, or
production financial inspection was performed for this specification.

### Product boundary

HIP means **HIP-4 outcome/prediction markets**, not Hyperliquid perpetual trading.
Support user-authorized market and limit buys/sells, cancellation, portfolio,
history, automatic settlement accounting, account balances, deposits,
withdrawals, and cross-venue funding where an exact executable capability exists.

Telegram must open the ordinary web/Mini App user review and signing flow. Do
**not** add unattended HIP order execution, agent approval, or HIP Privy managed
trading policies. Interactive signing by an embedded Privy wallet in the app is
distinct from autonomous server signing and remains in scope.

Parity means a truthful equivalent of each existing venue feature, not copying
inapplicable mechanics: HIP automatic settlement is not ERC20 redemption;
IOC is not FOK; HyperCore is not an EVM chain merely because its accounts look
like EVM addresses. Unsupported functionality must be explicit, not silently
represented as zero balances, successful actions, or missing positions.

## 1. What to retain from the old branch

The old prototype includes an indexer, private trade routes, signing/rounding,
account sync, funding UI, and deployment wiring. It predates the current durable
funding and account-value architecture. Do not cherry-pick it wholesale.

| Historical source                                      | Retain as reference                                                   | Required replacement / reconciliation                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `hip:apps/indexer-hyperliquid/src/mappers.ts`          | Outcome/side encoding, standalone/question grouping, metadata parsing | Current templates, settlement fractions, network isolation, terminal states                |
| `hip:apps/indexer-hyperliquid/src/bootstrap.ts`        | Snapshot pagination/refresh structure                                 | Current bulk writer, trade rollups, atomic generations, no false lifetime USD volume       |
| `hip:apps/indexer-hyperliquid/src/wsMarket.ts`         | Bounded subscriptions, reconnect and heartbeat                        | Current hot-token selection, public trades, backlog diagnostics, authoritative REST repair |
| `hip:apps/indexer-hyperliquid/src/market-data.ts`      | Book normalization, stale data handling                               | Current quote validation, book completeness and snapshot provenance                        |
| `hip:apps/indexer-hyperliquid/src/hyperliquid-repo.ts` | Raw and unified mapping skeleton                                      | New migration numbers, settlement/tombstones, retention references, current DB helpers     |
| `hip:apps/api/src/services/hyperliquid-trading.ts`     | Action shapes, order IDs, rounding and signing examples               | Durable attempts, SDK goldens, per-signer nonce admission, exact fees and account modes    |
| `hip:apps/api/src/routes/hyperliquid-private.ts`       | Endpoint use cases                                                    | Current auth, funding/preparation/consumer contracts, safe result classification           |
| `hip:apps/api/src/lib/hyperliquid-access.ts`           | Historical rollout restriction                                        | Existing lifecycle and exact capability gates; no separate permanent feature framework     |
| `hip:apps/api/src/hyperliquid-trading-tests.ts`        | Historical protocol cases                                             | New fixtures and full recovery/concurrency/regression matrix                               |
| `hip:docs/hyperliquid-venue-readiness.md`              | Original indexer rationale                                            | Stale readiness claims must not be interpreted as current main support                     |

Historical indexer tests are `bootstrap-tests.ts`, `mappers-tests.ts`,
`market-data-tests.ts`, `run-mode-tests.ts`, and `wsMarket-tests.ts` under the old
indexer. These are scenario inputs, not proof that a modern integration passes.
The old migration numbers `0157`/`0158` are occupied in current main: never reuse
them. The frontend `origin/hyperliquid` branch also contains unrelated merged
development; its July tip does not establish that HIP was completed in July.

### Concrete prototype hazards to avoid

| ID  | Historical behavior / consequence                                                                                                    | Required design                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| H01 | `/order` marks every exchange exception rejected after storing submitted; an accepted request with a lost response becomes retryable | Persist submission admission first; timeouts/disconnects stay ambiguous; reconcile the same `cloid`/attempt                             |
| H02 | Class-transfer/withdraw handlers return `ok: true`, submitted after an unclassified HTTP-200 payload                                 | Decode nested protocol errors; distinguish authorization, submission, acceptance, debit and destination credit                          |
| H03 | Fill identity prefers transaction `hash`; multiple fills sharing a hash can collide in execution uniqueness                          | Use scoped provider fill identity, including `tid` where supplied; replay and dual-fill fixtures                                        |
| H04 | Net historical executions seed positions, while only nonzero live balances overwrite them                                            | Authoritative complete snapshots can flatten balances; settlement ledger handles payout; incomplete history cannot resurrect a position |
| H05 | Position token lookup expects `#...`; outcome metadata also names tokens `+...`                                                      | Central metadata-backed coin/token/asset normalization; verify actual balance payloads                                                  |
| H06 | Local nonce map and user-scoped Redis keys permit the same signer to race across processes or user aliases                           | Atomic signer/environment-scoped admission; persist nonce with attempt and signed payload                                               |
| H07 | Money assumes six decimals; Relay/Core representations can use eight                                                                 | Separate ERC20, provider quote and protocol token units; integer conversions with explicit rounding                                     |
| H08 | Spot and perp fields are summed without account abstraction mode                                                                     | Mode-aware cash collection; no double counting or spending margin collateral                                                            |
| H09 | Fills query covers only a recent window                                                                                              | Preserve completeness/cursors; incomplete history is not all-time PnL or zero positions                                                 |
| H10 | Indexer upserts alone do not fully close missing/settled markets                                                                     | Explicit snapshot generation and terminal reconciliation; omission in a failed fetch is not settlement                                  |
| H11 | Testnet/mainnet share asset/coin IDs and raw keys                                                                                    | Isolated test DB/Redis and environment-scoped identities before any testnet writes                                                      |
| H12 | `volume_total = sum(candle.v)` uses bounded base-share volume                                                                        | Do not label this lifetime USD notional; publish units and coverage, build correct deduped trade aggregates                             |

The prototype's custom MessagePack/signing encoder is not an independent oracle.
Use it only to compare with official SDK-generated goldens. Do not restore old
money movement inside browser order hooks or old bridge success assumptions.

## 2. Current protocol contracts and changes since the prototype

### Environment and market envelope

HIP-4 documentation describes fully collateralized outcome markets, automatic
payout, dual YES/NO books, and an initial mainnet BTC daily market series. A side
can settle fractionally; a binary UI cannot infer its winner from local expiry.
[HIP-4 overview](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-4-outcome-markets)

The separate permissionless deployment specification is explicitly **testnet-only**.
It describes templates, questions, deployer fee scales and builder fees on buys
as well as sells. The overview instead describes initial zero trading fees and
sell-side builder support. Do not collapse these into one mainnet fee promise.
[HIP-4 deployer actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-4-deployer-actions)

| Contract                  | Mainnet / verified document envelope                              | Hunch implementation rule                                                                    |
| ------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Initial series            | Limited initial recurring markets, not arbitrary event coverage   | Index only returned market instances; do not invent sports/political coverage                |
| Template/deployer markets | Documented testnet envelope; mainnet availability unverified here | Preserve template/deployer metadata; enable only for verified environment                    |
| Settlement                | Protocol-reported fraction, not a client-calculated outcome       | Store fraction and provenance; derive YES/NO payout from that fact                           |
| Recurrence                | Each new expiry is a new market instance                          | Stable series relationship; separate token, market, order and matching identity per instance |
| Mainnet fees              | Conflicting feature envelopes in separate docs                    | Versioned fee capability from observed metadata/fee response; no global zero-fee assumption  |

Contract specifications describe recurring deployment and resolution sources.
Capture the exact underlying, comparator, observation time, price source and
resolution terms; do not match a HyperCore mark-price condition to an unrelated
external exchange price rule.
[Contract specifications](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications)

### Identity, decimals and order construction

Official outcome encoding is `10 * outcomeIndex + sideIndex`, with side 0/1,
coin `#<encoding>`, token name `+<encoding>`, and order asset
`100000000 + encoding`.
[Asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)

Required normalized identity fields: Hunch venue, environment, market instance,
outcome index, side index, order asset ID, coin, token name/token index, quote
token identity, size decimals, price precision and metadata revision. Existing
`hyperliquid:<assetId>` prototype IDs are not enough to isolate testnet.

`spotMeta` and `outcomeMeta` provide token/outcome metadata; `settledOutcome`
provides settlement information. Read token decimals instead of assigning all
protocol amounts the ERC20 USDC six-decimal unit.
[Spot info endpoints](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)

Price/size formatting must obey spot precision and significant-figure rules,
using metadata `szDecimals`. Strip invalid trailing zeros before signing.
[Tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)

Required quote math uses exact decimal strings/integer units. Quantize first,
then validate actual signed notional/size. Buy fee-inclusive debit and sell
token debit must reflect those final quantities. Do not inherit Polymarket's
five-share or marketable-buy minimum, Limitless fee math, or a universal `$10`
HIP minimum. Actual outcome minimum and supported precision remain a live-fixture
requirement.

GTC, IOC and ALO are documented time-in-force modes. IOC may partially fill;
it must not be presented or retried as FOK. Conditional/perp-only order types
are outside the first release unless outcome support is independently proven.
[Order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types)

### Signing, nonce, and response semantics

Hyperliquid uses distinct L1 and user-signed action schemes. Field ordering,
serialization, decimal formatting and environment affect signatures; local
signature recovery alone is not a proof of a valid exchange action.
[Signing](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing)

Nonces are scoped to the signing address, not the Hunch user or logical wallet
label. The protocol tracks a bounded nonce set/time window; shared signers need
atomic allocation and replay protection across API instances.
[Nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)

The exchange accepts `oid`/`cloid` cancellation and reports nested action errors.
HTTP 200 alone is not success. User-signed transfers do not automatically share
the L1 `expiresAfter` semantics.
[Exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)

Required design: allocate a nonce under the real signing-address/environment
scope; bind it to one immutable admitted action and retain enough information
to reconcile it. Requoting an uncertain transfer/order must not replace that
nonce or `cloid`. User rejection before submission, proved by the current lease
and submission boundary, is terminal non-submission; unknown external/provider
submission is not. An unknown order lookup by itself cannot release exposure.

### Account modes and fees

Current account abstraction supports standard, unified and portfolio-margin
behavior. In unified modes, legacy perp account views are not interchangeable
with complete spot cash information. Do not change a user's account mode to
make an integration simpler.
[Account abstraction modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes)

Generic builder documentation requires master authorization for builder fee
approval and describes eligibility and rate units. This does not prove that a
particular HIP market accepts a builder on either side. Account for builder
authorization separately from funding approval and order signing.
[Builder codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes)

Builder eligibility also requires a Standard-mode builder account with at least
100 USDC perps account value. This is a Hunch builder capability dependency,
not a minimum user's order/deposit size. Test ineligible/revoked builder support
without fabricating collected revenue or silently increasing user debit.

The fees page describes opening versus closing/settlement fees and mint/burn
volume treatment, unlike a simple uniform spot notional fee. Outcome maker
rebates are not supported. Treat this as another current documented envelope
to verify against the selected environment, not proof of a universal mainnet rate.
[Fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)

Required fee components: venue/protocol fee, deployer fee if applicable, Hunch
builder fee if supported/authorized, funding provider fee, forwarding fee,
source gas/sponsorship and account activation. Keep trading fee and transfer
fee separate. Persist charged fill fees; do not compute realized PnL from a
quote estimate or charge a fallback fee a second time.

Initially keep builder fees disabled unless mainnet support and exact approval/
charged-fee semantics are proved. Preserve reported fee and builder-fee fields
without double addition. Outcome transformations (`userOutcome` split/merge/
negate) are separate optional actions, not prerequisites for buying/selling or
automatic settlement; do not misroute them into ERC20 redemption or funding.

### Funding changes that can simplify Hunch

Hyperliquid now recommends CCTP; its legacy Arbitrum bridge is deprecated and
has a dangerous minimum-deposit rule. The old direct Bridge2 path is therefore
not the default new design.
[USDC integration](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/usdc)

Circle describes HyperCore balances as protocol credits backed by native USDC
in its HyperEVM `CoreDepositWallet`, with CCTP deposit/withdrawal support.
It documents sponsored Arbitrum deposits, new-account activation behavior and
testnet-recipient restrictions. This is a different contract from Polymarket's
Deposit Wallet. Check activation and forwarding costs per actual path; do not
apply one fee/minimum to all deposits.
[Circle HyperCore integration](https://developers.circle.com/cctp/concepts/cctp-on-hypercore)

Circle's Arbitrum example selects perp destination `0` versus spot
`4294967295`; its sample forwarding charge is not a Hunch-wide fixed fee.
This illustrates why a destination account address alone is insufficient.
Do not copy testnet addresses into production or infer Relay's internals from
this example.
[Circle Arbitrum-to-HyperCore guide](https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore)

Relay documents HyperCore chain ID `1337`, distinct from HyperEVM `999`; Core
currency IDs are not 20-byte ERC20 addresses. Its guide has eight-decimal USDC
quote examples and separate spot/perp IDs. Withdrawals require `protocolVersion:
v2` and nonce-mapping authorization followed by `SendAsset`, bound to the same
nonce. Domain-chain overrides must be applied consistently before freezing the
action.
[Relay Hyperliquid support](https://docs.relay.link/references/api/api_guides/hyperliquid-support)

Every `/quote/v2` request requires an API key from October 2, 2026; `/quote`
requests with a referrer also require authentication. Keep the key server-side.
[Relay API keys](https://docs.relay.link/references/api/api-keys)

| Representation                 | Documented identity / units                                          | Required interpretation                                              |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Relay native Core perps USDC   | `1337`, `0x00000000000000000000000000000000`; example raw decimals 8 | Not an ERC20 address or guaranteed HIP trading location              |
| Relay native Core spot USDC    | `1337`, `0x6d1e7cde53ba9467b783cb7c530ce054`                         | Resolve current currency decimals and DEX binding                    |
| HyperEVM / Arbitrum ERC20      | Different networks/contracts, ERC20 metadata                         | Never substitute their receipt for Core credit                       |
| Hunch AssetRef / AssetLocation | New native network/account identity required                         | Keep metadata precision and amount units attached through every step |

The provider guide is evidence for these formats, not proof of a live route.
Use its chain-override example only for signing-domain consistency; never change
an immutable action after review to satisfy a wallet chain prompt.

The current Hunch Relay client already supplies `x-api-key`. The missing work
is native Core capability/validation/execution/evidence, not merely adding a
chain to an EVM list. First signature acceptance does not move funds; the
actual transfer submission has a distinct ambiguity boundary.

Documented Relay changes since July include `includeProtocolData`, Requests v3,
v2 deprecation, new submission/route-error codes, removed swap execution API,
nullable amount fields, and manual-refund outcomes. Do not port old SDK payloads
or removed endpoint names. Upgrade a dependency only after checking the actual
Hunch client usage; this integration is not a justification for unrelated SDK
or schema churn.
[Relay changelog](https://docs.relay.link/changelog)

### Existing Requests v2 dependency and scoped v3 migration

Current `funding-providers/relay/client.ts` `requestsByDepositAddress()` still
calls `/requests/v2`. `schemas.ts` parses its wire rows into internal request
observations; `reconciliation.ts` uses deposit-address discovery to find child
requests, including repeated/late payments. This is a real current dependency,
not merely an old SDK example. The existing `/intents/status/v3` call is a
different API; it does not migrate this discovery path.

Requests v2 is deprecated, progressively throttled, and scheduled for retirement
on 2026-11-24. Requests API version and Relay Protocol v2 are independent.
Use a scoped migration of the HTTP discovery endpoint, filters/pagination and
wire normalization, not SDK-wide churn or a path-only replacement. V3 uses
changed transaction/route fields, nullable failures/amounts and additional status
semantics; old schemas must not silently drop financial observations.
[Requests v3 migration](https://docs.relay.link/references/api/api_guides/migrating-to-requests-v3)

Before depending on native HIP receive/recovery, pin current v3 fixtures and
verify exact deposit-address filtering, child discovery, ordering, cursor/limit
coverage and API-key behavior. Keep a stable internal observation type and
provider-reference identity. Test old operations, multiple/late deposits,
partial pages, tied timestamps, submitted/no-output, nullable amounts, failed/
refunded requests and replay. Missing a page is not no payment, and a discovery
error must not close an ambiguous debit. Preserve bounded retries and budgets
for existing EVM/SVM consumers while migrating their shared discovery path.

No authoritative dated Hyperliquid release history was established here for
every feature. These are current documented contracts, **not a fabricated claim
that they all shipped after July**.

## 3. Current-main venue participation map

Each row is a required development touchpoint, not permission to widen every
enum indiscriminately. Distinguish public reads, interactive writes, maintenance
and autonomous execution.

| Domain              | Current owners / gap                                                                                                    | HIP requirement                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Lifecycle           | `packages/shared/src/venue-lifecycle.ts`; HIP unreleased/off; active enables automation                                 | Interactive capability plus independent autonomous exclusion; exit-only preserves reads/repair |
| API schema          | `apps/api/src/schemas/common.ts`, `order-types.ts`                                                                      | Add public/account/trade types only when their implementation exists                           |
| Public discovery    | `repos/unified-read.ts`, `routes/events.ts`, `routes/markets.ts`                                                        | Remove explicit HIP exclusion in proven read paths; correct ranking units and coverage         |
| Live data           | `lib/hot-tokens.ts`, routes prices/SSE, shared writers                                                                  | Register HIP hot keys/stream keys and inferVenue; maintain bounded fanout                      |
| Charts/trades       | Event/market candles and `routes/trades.ts`                                                                             | Real source-labelled historical series and trade normalization; validate event/token IDs       |
| Account value       | `account-value/known-asset-catalog.ts`, `runtime-service.ts`, `ownership-resolver.ts`, `cash-availability-projector.ts` | HyperCore account binding, mode-aware locks/cash, freshness/completeness                       |
| Positions           | `repos/positions-repo.ts`, `order-types.ts`, collectors                                                                 | Storage allowance exists; read/valuation/settlement support does not                           |
| Orders/executions   | `repos/orders-repo.ts`, `repos/executions-repo.ts`, `repos/unified-orders.ts`, `routes/positions.ts`                    | Venue schemas, scoped IDs, replay-safe fills, cancellation and recovery                        |
| Funding policy      | `funding/policies/funding-policy.ts`, `funding-policy-v2.ts`                                                            | Core locations/routes/signers/observers; compile only supported capabilities                   |
| Preparation         | `funding/preparation/runtime-service.ts`, `core-adapter.ts`                                                             | HIP trading destination and non-money readiness; class transfer is explicit funding            |
| Shortfall / Max     | `funding/planner/market-buy-suggestion.ts`, `trade-shortfall-preflight.ts`, `source-reservation-capacity.ts`            | HIP fee-inclusive budget adapter and exact destination units; bidirectional capacity           |
| Relay               | `funding-providers/relay/`                                                                                              | Native Core currency/DEX/signature contracts, not relaxed EVM validation                       |
| Durable execution   | `funding/execution/operation-action-runtime.ts`, `operation-execution-preflight.ts`                                     | Exact signed-action executor/lease/report/evidence protocol                                    |
| Trade attempts      | `funding/persistence/funding-trade-attempt-repository.ts`                                                               | New scoped HIP execution path, DB constraint, same attempt/consumer lifecycle                  |
| Settlement/actions  | `funding/position-actions/venue-driver.ts`                                                                              | No fake conditional-token driver; automatic settlement observer/accounting                     |
| Fees/rewards        | `repos/fee-policy.ts`, `services/rewards.ts`, fees/reconciliation                                                       | Supported builder collection and observed charged fees; no unearned rewards                    |
| Matching            | `packages/market-matching/`, `apps/market-matcher/`, shared matching policy                                             | Current Jev pipeline and explicit venue allowlists; exact resolution semantics                 |
| Intel/research      | `wallet-intel-refresh.ts`, `services/wallet-intel-*`, `services/holder-research*.ts`                                    | Known-wallet data first; coverage-qualified holder/trader intelligence                         |
| Signals/map         | `services/signal-matching.ts`, `services/signal-bot-*`, `ai-map-*`                                                      | Source and delivery capability distinct from automated execution                               |
| Telegram            | `services/telegram-app-handoff-v2*`, repository, Mini App links                                                         | Explicit user web handoff; reject HIP execution for autonomous `telegram_bot` actors           |
| Retention/admin/ops | retention selectors, admin schemas, compose/build, cron                                                                 | Protect new raw/ledger references; operational visibility and safe cleanup                     |
| Public tools        | Separate `hunch-agent-tools-public` client/schema                                                                       | Extend read-only venue schemas after actual API support; never expose execution                |

The matrix is grounded in current source searches, not an assumption that adding
`hyperliquid` to the shared venue list automatically updates every consumer.

### Lifecycle and authorization trap

`active` currently sets every lifecycle capability true, including `automation`.
Backend `services/venue-lifecycle.ts` also uses an explicit `LIVE_INTEL_VENUES`
list without HIP. Funding policy currently rejects active HIP entries, while
its v2 catalog recognizes only Polymarket/Limitless and generates managed/internal
signer paths for every funding venue.

Required design: add the smallest explicit user-interactive HIP capability,
preserve existing defaults for all other venues, and prohibit HIP autonomous
trading in actual executor/policy authorization. Do not use lifecycle alone as
signing permission. Do not enable server-managed HIP profiles by mechanically
adding a venue to `FUNDING_VENUE_IDS`. Unreleased read-only canary requires an
explicit internal read path, not accidentally public unrestricted discovery.

## 4. Public indexer, market identity, and live data

### Metadata and lifecycle

Implement a sidecar-safe protocol client plus pure mappers, then integrate with
current DB/Redis helpers. Do not transitively import API-wide required secrets
from an indexer entrypoint. Use optional sidecar-owned config and existing
runtime secret bootstrap for that process.

Current WebSocket docs include `outcomeMetaUpdates` for creation/settlement
notifications. Use it to reduce metadata lag, with REST generation repair on
reconnect; stream delivery is not a complete durable history.
[WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)

Required raw snapshot fields include environment, fetched-at/generation,
outcome/question/template/deployer identity, description/side names, expiry,
quote-token metadata, fee capability and settlement provenance. Keep original
metadata alongside normalized fields for reprocessing.

The prototype understood legacy `class:priceBinary|underlying|expiry|...` text.
Current template descriptions cannot be normalized exclusively by that parser.
Standalone outcomes need not have a question. Question fallback/other outcomes
must not be presented as unrelated independent binaries. Distinguish actual
tradable side tokens from question grouping.

An expired market is not necessarily settled. A temporary metadata omission is
not a deletion. Close buys when protocol orderability ends, retain sells/cancels
only if actually permitted, and update resolved status from a settlement fact.
Store fractional payout, terminal timestamps and raw source; never silently
convert an unavailable settlement lookup into a loss.

### Price, trade, candle and ranking pipelines

Build BBO/L2 with timestamp, precision, completeness and stale/error distinction.
Validate supported coin identity before subscriptions. Bounded hot-set selection,
REST repair, backoff, heartbeats and queue age must be observable.

Current feed/discovery often uses `unified_market_trade_24h` and
`unified_event_trade_24h`, not just `unified_markets.volume_24h`.
The old rolling-day metadata write does not establish current ranking parity.
Ingest canonical deduped public trades into supported aggregate generations or
explicitly mark ranking coverage limited. Never use candle base volume as USD
lifetime volume, infer liquidity from token supply, or convert missing OI to zero.

Current `unified_last_trade` uses `(token_id, ts)` as primary key and has no
provider `tid`; multiple HIP trades can share a timestamp. Choose a collision-safe
provider event ledger/ingestion key and aggregate from it. Do not perturb timestamps
to fake uniqueness. Handle replay, REST overlap, WS duplicates and dual-side
representation without doubling notional or manufacturing trades.

Historical candles and fills are bounded upstream. Public info docs limit recent
candle history and user fill retention; requests can return partial coverage.
[Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)

Persist start/end/coverage and cursor watermarks. A DB series can supplement
provider history, but its source and coverage must remain explicit. Do not call
a recent-window estimate all-time history. Preserve the recent invalid-event-ID
guards when adding HIP candlesticks.

### Persistence, retention and performance

Centralize weighted protocol request budgets across API, indexer, finance and
intel workers: documented limits are shared per IP and include bounded WS user
streams and address-specific action limits. Prioritize cancellation/financial
reconciliation over speculative research refresh. Do not open one unlimited
user stream per tracked wallet or repeatedly replay accepted actions to repair
read-side lag.
[Rate and user limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)

Use bounded batch writes, consistent token/event membership updates and existing
source generation contracts. Snapshot publication must not expose half-written
market/side mappings. Avoid holding a single unbounded transaction while doing
remote requests. Track fetch/map/write/token-sync/queue durations separately.

Any new raw market, token, order, fill, settlement or intel reference must update
`market-retention-selector.ts`, `market-source-retention.ts`, matching retention
and applicable cleanup reports before hard deletion is possible. Protect user
ledger/history references. Validate SQL on disposable PostgreSQL matching the
deployment major; production-scale plans matter beyond empty fixtures.

Use new migration numbers and tolerant historical backfills. No data-dependent
`RAISE EXCEPTION` rollout guards: production stops services before migrations.
Read-only production facts, if later authorized, must establish migration scope
before deployment, not discover it while the API is stopped.

## 5. Account ownership and spendable cash

### Required binding

Keep these separate: Hunch user, linked controller wallet, HyperCore account
owner, action signer, environment, account abstraction mode, spot/perp DEX and
settlement asset location. A verified linked controller does not authorize an
arbitrary requested account address, agent, vault, or subaccount.

Reuse `funding/domain/types.ts` AssetLocation and VenueAccountBinding. Model
HyperCore as a native network/account location, not `evm:1337`, Arbitrum USDC,
or HyperEVM USDC. Proposed names such as `hypercore:mainnet` are design names,
not existing accepted API values; decide the final canonical ID once and propagate
through server/client schemas and persistence.

Extend address canonicalization specifically for EVM-shaped HyperCore accounts
without weakening Solana or EVM asset validation. Currency IDs may have a
different format from account addresses. Do not pass a Core token identifier
through `getAddress()` or an ERC20 RPC reader.

### Balance projection

Required projection separates asset total, venue/order holds, Hunch reservations,
submitted debits, outgoing/incoming claims, withdrawable capacity, and fresh
session-executable cash. A portfolio valuation is not available funding.

Standard accounts may need a user-authorized spot/perp class transfer. Unified
accounts must not sum duplicate account views; portfolio-margin accounts require
the protocol's risk-aware transferable capacity, not `total - hold` guessed as
free collateral. If that capacity cannot be verified, disable that **specific
spend path** with a recoverable reason; continue truthful reads and supported
account modes. Never change modes or move collateral silently.

External disconnected accounts can remain visible as owned assets but cannot
contribute session-signable funding capacity. Embedded wallet hydration is a
readiness state, not a demand to install/connect an external wallet. Do not
charge the user twice or hide an existing valid embedded source because a
previously selected external signer is disconnected.

Portfolio margin can introduce borrowing. Hunch must not finance an outcome
buy from automatic borrow capacity without separate product/consent support,
which is outside this scope. Positively owned verified transferable cash is
the limit, not a protocol-reported maximum that includes borrowing.
[Portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin)

A fresh owned-cash snapshot is **not** an enforceable no-borrow guarantee.
Other account activity or margin changes can consume cash before submission,
and a resting GTC can execute later. For portfolio-margin mode, require a
verified protocol-enforced no-borrow property for the actual action throughout
its lifetime; no such per-order switch was established here. If that property
cannot be proved, leave the affected HIP Buy/funding-source write capability
disabled, even when the snapshot looks affordable. Keep reads, inbound credit
and other independently safe capabilities available. A practical recovery is
selecting an already eligible owned account, not silently changing this account's
mode or permitting debt. Recheck account mode at server admission and test
mode/cash changes after quote, concurrent external activity and resting orders.

Canonical destination credit must identify the exact Core owner, environment,
asset, DEX/account context, amount and route correlation. A larger account
balance after several concurrent deposits is not alone exact transfer attribution.
Reconcile through a supported ledger/receipt; retain aggregate balance as
corroboration, not a substitute for scoped credit proof.

## 6. Relay, deposits, withdrawals, and automatic shortfalls

### Existing architecture to extend

Current owners:

- Policy/capabilities: `funding/policies/funding-policy.ts` and `funding-policy-v2.ts`.
- Planning/destinations: `funding/planner/runtime-service.ts`, `destination-adapters.ts`, `production-source-planner.ts`.
- Preparation: `funding/preparation/core-adapter.ts`, `runtime-service.ts`, venue drivers.
- Provider: `funding-providers/relay/mappings.ts`, `schemas.ts`, `wallet-adapter.ts`, `action-validator.ts`, `operation-plan.ts`, `reconciliation.ts`.
- Execution: `funding/execution/operation-action-runtime.ts`, `action-report.ts`, step receipts and submission contracts.
- Evidence: `funding/reconciliation/owned-route-destination-observer.ts`, `owned-wallet-asset-balance.ts` and provider observations.
- Durable state: operation/segment/step attempts, observations, reservations, leases and reconciliation jobs.

Current Relay supports EVM/SVM mappings and rejects signature/authorization
actions. Keep those safety checks. Add a narrowly typed Core action validator,
executor and receipt observer; do not make all provider-signature payloads legal.
Native Core sources also cannot enter the EVM/SVM balance/transaction readers.

### Required route and action validation

Validate source/destination environment, currency and units, owner/recipient,
DEX, exact amount, fee/debit cap, expiry, provider request reference, protocol
version, allowed action type, typed-data domain, verifying contract, message,
submission endpoint and nonce relationship. Do not blindly execute arbitrary
URLs/calldata returned by a provider. Preserve encrypted provider references and
redacted diagnostics.

Relay nonce authorization and actual Core transfer are separate steps in one
durable operation. Persist their shared relationship before signing. Local
cancel, signature rejection or browser loss between them must not invent a
debit, and must not leave a harmless authorization reservation forever. After
the value-moving submission boundary, retain ambiguity and reconcile exact
source/destination facts before releasing capacity or retrying.

Do not generically resubmit a new quote/nonce to fix `NO_SWAP_ROUTES_FOUND`.
An unsupported exact route is not a provider outage, account loss, or proof
that every smaller amount fails. Return specific capability/insufficient-funds
diagnostics and check bounded smaller-buy advice through existing planner paths.

### Bidirectional cross-venue parity

| Use case                              | Required path                                                            | What must be proven before advertising it                                                |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Existing owned EVM/Solana asset → HIP | Existing source executor → exact Relay/Core destination                  | Route quote, signer eligibility, units, gas/fee cap, exact Core credit                   |
| Limitless Base USDC → HIP buy         | Owned Base source → verified Core trading destination                    | Source availability, destination mode/DEX, funded trade consumer identity                |
| Polymarket pUSD → HIP buy             | Supported exact relayer transfer back to controller, then ordinary route | Deposit Wallet allowlist/ownership and controller receipt; no nested arbitrary execution |
| HIP cash → Polymarket buy             | Core source → verified destination pUSD/account preparation              | Core transferable capacity, both signatures, exact pUSD destination and consumer         |
| HIP cash → Limitless buy              | Core source → owned Base USDC trading account                            | Canonical Base receipt, fees, minimum and same approved buy intent                       |
| HIP cash → user withdrawal            | Core source → chosen supported destination                               | Exact receive amount/debit cap, ownership/recipient, destination receipt                 |
| Multiple Hunch balances → HIP         | Existing composite planner/reservations                                  | No duplicated cash, all source steps admitted, aggregate exact destination capacity      |
| Partial funding then abandoned buy    | Preserve completed money movement, expire unused consumer safely         | Funds remain owned/usable; no historical order resurrection                              |

These are desired route families, not a declaration every chain/token/amount
is live-supported. Activate only the subset confirmed by exact quote fixtures
and observers. The unsupported subset stays clearly labelled without blocking
unrelated working routes. Kalshi remains on its current exit-only/DFlow policy;
do not revive its legacy indexer or new-exposure funding as collateral work.

Polymarket Deposit Wallet is factory-controlled: no direct arbitrary `execute`
or standing third-party allowance. Follow the workspace constraint even if a
generic Relay EVM route appears to offer a shortcut.

### Automatic shortfall and Max/Half/Reduce

Extend one venue-budget adapter, not another HIP-only funding coordinator.
`market-buy-suggestion.ts` currently allows two venues and six-decimal collateral;
add native HIP budget/precision deliberately rather than changing a number.

Required invariant:

```text
available executable destination cash
  + conservatively verified net source-route capacity
  >= actual rounded order debit + applicable trading fees
```

Capacity must already subtract holds, reservations, pending debits and transfer
costs, and exclude unavailable external signers. For limit orders validate
maximum reserved spend; for IOC account for bounded execution price, slippage,
depth and partial fills. The quote and consumer intent must carry identical
asset/raw units, market instance, side, controller/account binding and revision.

Max is a constrained budget calculation, not total portfolio dollars divided
by price. Half/Reduce round down to executable lot precision. A new minimum
must never increase a user input beyond the verified budget. A smaller quote
has a smaller fee allowance; do not retain the old larger order's fee budget.
An unavailable check is not the same as proved insufficient funds.

Recheck stale routes only before signing/submission, within the current consent
and exact debit cap. If funding succeeds but the approved buy expires, preserve
cash and require fresh review; no automatic refund, second transfer or new order.
Auto-shortfall means guided funding within a user-approved app intent, not
autonomous Telegram HIP trading.

### Receive sessions and deposits

Use token-first receive sessions and canonical receive records. Methods
(connected wallet, external transfer, card if actually supported) come from
the server session's precise capability, not a static HIP card or chain list.
Do not publish a HyperCore address as a generic ERC20 deposit address/QR.

If ingress first receives on an existing supported chain and later converts
to Core, represent both stages. A confirmed ingress payment remains received
when the next leg fails; recovery must not ask the user to pay again. Preserve
late/multiple-receipt handling, exact consent, source attribution and dust
semantics of the current receive lifecycle.

### Withdrawal and automatic repair

Quote receive amount and maximum debit separately, including protocol/provider
fees and any applicable activation cost. Source capacity is mode-aware and
must not spend collateral needed elsewhere. A provider accepted withdrawal
is not a canonical destination receipt.

Implement automatic bounded evidence polling/repair for lost reports and
accepted-but-unobserved outcomes using the current lease/job model. A signing
lease can expire to proven non-submission; an expired quote alone cannot prove
that submitted money never moved. No indefinite manual-review dead end for
recoverable deterministic facts; no blind reservation release on unknown results.

## 7. Orders, durable recovery, executions, settlement and PnL

### Trade API contract

Proposed HIP API should mirror the existing architecture: read quote, prepare
exact immutable action, admit a durable attempt, user-sign, submit, observe and
sync. The old endpoint names are references, not frozen public API contracts.
Regenerate OpenAPI consumers only after the server contract is validated.

Quote includes environment/market revision, token/side, rounded size/price,
TIF/orderability, debit asset/raw cap, fee breakdown, balance/context revision,
expiry, depth/staleness and exact validation reason. Prepare binds signer/owner,
nonce, `cloid`, action fingerprint, market and funding consumer.

Use current `funding-trade-attempt-repository.ts` states (`claimed`,
`submission_started`, `accepted`, `ambiguous`, `definitive_failure`) and extend
its execution-path schema/DB check for HIP. The new name is to be decided, not
an existing accepted value. Also cover **direct** trades without preceding
funding; do not leave a second weaker submission path.

Persist admission and ambiguity before the actual exchange submission boundary.
Same intent across duplicate clicks/tabs/reloads returns the same admitted
attempt/nonce/`cloid`, subject to current lease semantics. Never treat any
frontend HTTP 400/500 text as proven exchange rejection. Backend terminal
errors require definitive classified evidence.

### Cancel and partial fills

Cancel exact account/environment/order identity, with canonical `oid` or `cloid`.
Cancellation acceptance does not undo already matched fills. A GTC order's
unfilled remainder can hold cash after initial placement; reconcile protocol
holds with the Hunch reservation lifecycle without double subtracting them.

An IOC partial fill is a real partial execution, not a failed no-fill order.
Record fills first, remaining order state second, and release only unspent
capacity after final evidence. Late fills/cancel races and dual-book fills
must be idempotent. Never count both a primary and equivalent dual record twice.

### Position and PnL accounting

Canonical fills require environment, account, order reference, `tid`/provider
identity, timestamp, token side, signed size/price, cost/proceeds, fee asset/raw
amount and source payload fingerprint. Transaction hash is supporting evidence,
not necessarily a unique execution key.

Documented `WsFill.builderFee` is already included in `fee`. Store both for
attribution but subtract the charged fee once. Add an explicit builder-present
fixture rather than relying only on a generic fee-total test.
[WebSocket fill contract](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)

Use authoritative complete balance snapshots plus canonical executions and
settlement events. Missing/incomplete history cannot prove a zero position;
an explicit zero in a complete fresh snapshot can flatten one. Bound provider
pagination/cursor repair and preserve full-history completeness.

Fills and final settlement alone are not a complete cost-basis ledger. Read
supported native non-funding ledger events (`userNonFundingLedgerUpdates`)
alongside account snapshots; normalize transfers, split/mint, merge/burn and
negate before assigning proceeds or opening cost. External transformations may
occur even when Hunch offers no transformation button. For the documented
testnet question-expansion envelope, newly distributed outcome shares to
existing fallback-YES holders also require an explicit basis treatment. Never
label them an ordinary cash-funded buy or a deposit. Where ledger attribution
is unavailable, keep balance reads but qualify PnL/analytics as incomplete.

Preserve time-boundary overlap and stable event IDs when paginating. Advancing
only to `lastTimestamp + 1` can lose distinct events at the same timestamp.
Test repeated observations, external transfers/transformations, fractional
settlement, expansion distributions and missing basis separately from fills.

Automatic settlement records payout, fractional resolution, extinguished size,
cost basis released and fee treatment exactly once. Do not reuse ERC20 redeem
execution. `funding/position-actions/venue-driver.ts` is conditional-token
oriented; add the appropriate observer/accounting boundary, not a fake contract.

Required formulas use actual ledger facts:

```text
realized PnL = realized sale/settlement proceeds - released cost basis - charged fees
unrealized PnL = current position mark value - remaining cost basis
```

Ensure existing account PnL conventions do not subtract already-net proceeds
fees again. Funding between owned accounts is neither realized profit nor a new
deposit to Hunch. In-transit value must not count at both endpoints. Keep PnL
unknown/partial when cost-basis or valuation coverage is incomplete. Historical
imports may require qualified estimates, not silently authoritative all-time PnL.

### Fees and rewards integration

Extend current fee schemas/storage only for a proven HIP collection mode.
Do not map testnet deployer/builder behavior into mainnet revenue assumptions.
Master builder approval must bind the intended builder and max fee explicitly;
declining it must have a defined product path, not hidden permission escalation.

Rewards follow recorded eligible executions and actual fee economics, not quote
generation, repeated syncs, cancelled orders or internal class transfers. Replayed
fills and settlement credits must not issue duplicate rewards/notifications.

## 8. Telegram: web handoff, not policy-driven HIP trading

Current `services/telegram-app-handoff-v2-contract.ts` and
`repos/telegram-app-handoff-v2-direct-trade-repository.ts` constrain trade venues
and execution kinds. The handoff store already binds Hunch/TG identity, opaque
token, TTL, policy/quote/plan fingerprints and consumed/claimed lifecycle.
Extend the browser contract explicitly; do not assume it is a generic string
venue that can safely auto-submit HIP.

Bind environment, exact market instance/side/order type, account/controller,
size/debit cap, revision and expiry. The browser must show current review and
obtain the user's signature through the same durable admission path. A market
link or routing cookie is not signing consent. Account switches/expired plans
require a new valid review rather than a hidden new order.

`services/api-trading-service.ts` has bot-oriented names, but its executor
registry also serves interactive app Funding/MiniApp quotes, preparation and
submission. A user-interactive HIP adapter may share this durable service;
reject HIP execution for `telegram_bot` actors at the actual authorization
boundary rather than excluding HIP from the entire common registry. Read-only
quotes or signal delivery do not grant autonomous execution permission.
Keep HIP excluded from `services/signal-bot-trading-policy.ts`, autonomous
profile generation and
`funding/execution/telegram-trade-shortfall-activation.ts` server bot activation.
Signal delivery can include HIP web CTAs without granting bot execution.
Interactive app funding from/to HIP is allowed only through its explicit,
user-approved operation; direct HIP Privy policy trading is out of scope.

## 9. Market matching, signals, research and wallet intelligence

### Current matching, not retired aggregation

Use `packages/market-matching` (including `src/jev.ts`), `apps/market-matcher`
and `packages/shared/src/market-matching-policy.ts`. The supported venue policy
currently includes only Polymarket/Limitless. Do not build against historical
aggregation docs or bypass current quotas/pair-generation validation.

Add HIP in candidate generation, metadata normalization, pair keys/cache
generations, API schemas and frontend demand **after** fixture validation.
Candidate similarity is not confirmed market equivalence. Compare underlying,
threshold/comparator, observation time/timezone, oracle/price source, payout,
side orientation, recurrence instance, settlement/void rules and question scope.
Reject or downgrade uncertain pairs, including apparently identical BTC daily
titles resolving from different prices/times. Keep original explanations and
confidence/provenance available.

Include returned template metadata/deployer in matching input where relevant.
New recurring markets must invalidate relevant candidates without reusing
expired-instance matches. Preserve current policy budgets, rate limits, work
leases, TTLs and generation-compatibility checks.

### Map, embeddings and signals

Generic AI-worker eligibility uses discovery lifecycle, but the indexer must
enqueue the correct invalidations/embedding work. Update explicit venue CLI
parsers such as `ai-embed-backfill` only where supported. Map build/search/signals
must see valid HIP metrics, not fake liquidity/lifetime volume. Embeddings or AI
similarity do not replace resolution-rule matching.

Separate HIP as signal **source**, matched delivery **target**, and automated
execution target. Telegram/channel/X publication requires market availability,
current matching/delivery policy, canonical URL and valid evidence. HIP delivery
must use web review CTAs; no bot Buy button suggesting unsupported execution.
Publication skips, unavailable holders and budget limits must be observable.
Do not modify existing model choices/budgets as collateral to adding a venue.

### Wallet/trader intelligence: feasible first slice

Current `LIVE_INTEL_VENUES`, wallet-intel refresh/filter/schema paths and
holder-research eligibility exclude HIP. Public read APIs can potentially inspect
known accounts, fills/orders and balances; that is not an authoritative global
list of outcome holders or their cost basis.

First implement known-wallet tracking with explicit endpoint coverage, environment,
timestamps and replay-safe activity. Preserve account-role distinction and exact
outcome side. Keep spot balances, outcome positions and perpetual positions
separate. Do not treat a perp liquidation, deposit or class transfer as an outcome
trade signal.

Participant discovery/global holder ranking needs a separately verified provider
or complete indexed ledger. Prove that its fields reveal the needed participants;
do not assume public trade `tid`/hash supplies wallet identities. Documented WS
trade `users` can seed an observed trader cohort, and identity includes time,
coin and `tid`; this does not enumerate all holders. A top-holders
endpoint, global holder completeness and historical outcome cost basis were not
verified in this task. Until then show limited tracked-wallet coverage or omit
the unsupported ranking, not fabricate concentrations or historical edge.

Realized edge, win rate, ROI, holder concentration and PnL require correct outcomes,
fees, fractional settlement and history completeness. Retain hedge/market-maker
filters and evidence freshness. Add HIP to `services/holder-research-jev.ts` and
research data loaders only when those data prerequisites exist. Missing research
evidence should not block unrelated valid user-authorized trading.

## 10. Schema, dependencies, admin, tools and operations

### Storage and API compatibility

`0205_positions_hyperliquid_storage.sql` permits position storage, but current
position reads/valuation still exclude HIP. Orders, executions, credentials,
fee-share schemas and funded trade execution paths have separate constraints.
Inspect each actual schema before designing migrations; broad venue search is
an inventory aid, not proof that every enum should be changed.

New fields should be additive/versioned. Old clients must not interpret an
unsupported Core action as EVM/Solana or disappear its value from totals. Keep
network/environment in cache and ledger identity. If existing public IDs must
remain compatible, isolate testnet instead of silently changing historical IDs.

### Dependency decisions

| Dependency                          | Role                                              | Decision before implementation                                                                           |
| ----------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Official Hyperliquid SDK/reference  | Signature and protocol goldens                    | Audit current support/version; prefer verified bindings over custom encoder; no private keys in fixtures |
| Existing `viem` / decimal utilities | User EIP-712 signing and exact decimal conversion | Extend existing owners; do not install a second generic wallet framework                                 |
| Existing Relay HTTP client          | Quotes, provider references/status                | Extend native Core contracts; SDK adoption is optional, not required for simple typed HTTP               |
| Circle CCTP contracts               | Documented alternative funding substrate          | Reference only unless Relay cannot satisfy a required route; no parallel custom bridge by default        |
| Existing PostgreSQL/Redis           | Durable operation, nonce admission, market data   | Schema/index design and isolated real-PG tests; no process-local financial fallback                      |
| Privy                               | Interactive embedded signing                      | Verify supported typed-data/prompt flow; no new autonomous HIP policies                                  |

No dependency was installed for this documentation task. Audit licenses, package
exports, sidecar-safe import graph, Node/Bun runtime and lockfile impact before
adding one. Do not import API environment/config globally into indexers/workers
just to reuse a protocol helper.

### Admin and public tools

Admin must expose HIP lifecycle, exact route/signer capabilities, snapshot freshness,
indexer health, attempts, settlement/accounting and bounded recovery diagnostics.
Do not create a new manual review workflow as the only escape from a recoverable
signature timeout. Keep admin authorization and financial repair auditing.

The public `hunch-agent-tools-public` repository has its own venue list/schema;
add HIP research endpoints only after underlying API support is truthful. Public
tools remain read-only. OpenAPI/agent-card/LLM metadata and URLs must not advertise
buy execution or exhaustive holder intelligence that does not exist.

### Deployment and observability

Add indexer workspace/build/compose/image entrypoints only in the implementation
phase. Inspect both long-lived containers and installed cron/systemd tasks for
account sync, intel, AI and reconciliation. Record environment, run generation,
fetch/write lag, rate-limit/retry counts and canonical coverage. Redact signatures,
API keys, encrypted/plain provider references and RPC URLs.

Metrics must distinguish quote refusals, insufficient capacity, unsupported exact
route, user rejected signature, definitive exchange rejection, ambiguous submission,
accepted/resting/partial fill, pending settlement and missing accounting observation.
Use existing cost/budget and request timing attribution. Do not hide a completed
run behind a stale error or treat absent paid calls as model failures.

Kill switch blocks new exposure while preserving reads, cancellation, withdrawal,
existing-order repair and settlement accounting. Do not strand owned HIP funds
because discovery or matching is disabled.

## 11. Implementation sequence and proof obligations

| Phase | Deliverable                                               | Exit evidence                                                                                                        |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P0    | Read-only protocol fixtures and capability decisions      | Mainnet/testnet differences, exact token units, mode/fee/minimum contracts, Relay routes and receipt fields verified |
| P1    | Public indexer/read contracts                             | Isolated canary; stable identities; correct trades/metrics; terminal lifecycle; bounded performance                  |
| P2    | Owned account and ledger projection                       | Mode-aware available cash; zero/partial snapshots; settlement and PnL; no duplicate value                            |
| P3    | Durable Core funding/withdrawals                          | Both directions, both signatures, exact debit/credit, cancel/unknown recovery; no manual dead end                    |
| P4    | Interactive trade adapter and server submission           | Direct/funded GTC/IOC/ALO supported subset, fees, nonce/cloid concurrency, fills/cancel/settlement                   |
| P5    | Web/MiniApp handoff and all public surfaces               | Three device contexts, explicit signing, autonomous HIP remains excluded                                             |
| P6    | Matching, tracked-wallet intelligence and signal delivery | Rule-equivalence fixtures, bounded coverage/budgets, truthful holder limitations and web CTA                         |
| P7    | Gradual activation                                        | Full build/tests, migration compatibility, exit-only recovery and observed canary before production exposure         |

P0 read-only evidence cannot demonstrate actual signing/submission recovery.
Use deterministic local/provider-response fixtures plus authorized testnet execution
only in a later approved test phase. Real-money production orders are not implicit
in this document. Do not require perfect global historical coverage to release
working bounded features; block only a concretely unsafe financial path.

### Required fixture/test matrix

| Category         | Cases that must be exercised                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata         | Legacy/new templates; standalone/no question; question fallback; fractional settlement; recurring rollover; unknown quote token                |
| Identity         | Mainnet/testnet collisions; coin `#` vs token `+`; account case; raw provider currency vs ERC20; same timestamp different trades               |
| Market data      | Fresh/stale/empty/error book; depth shortage; WS gap/replay; candle history limit; absent metrics not zero                                     |
| Amounts          | Rounded exact min boundary; one raw unit below; five significant figures; lot dust; 6↔8 conversions; fee-inclusive cap; no input increase      |
| Account modes    | Standard spot/perp; unified; portfolio-margin unsupported capacity; no automatic mode change; open-order holds; concurrent transfers           |
| Funding          | Every activated source/destination family; no route; wrong currency/DEX/owner; provider expiry; partial composite funding; source fee/gas      |
| Core signatures  | Nonce mapping then SendAsset; rejection/close at each stage; inconsistent domains; foreign payload; lease expiry; late signature               |
| Trade recovery   | Duplicate tabs/processes; accepted response lost; definitive nested reject; unknown order; same nonce/cloid replay; direct and funded paths    |
| Orders/fills     | IOC no fill/partial/full; GTC resting/partial/cancel; fill/cancel race; dual records; one hash multiple tids; reward dedup                     |
| Settlement/PnL   | Automatic payout credit; fractional payouts; complete-zero position; partial snapshot; historical gaps; transfers not profit; fees not doubled |
| Receive/withdraw | First account activation; destination credit lag; ingress paid then downstream failed; wrong/multiple/late receipt; no second payment          |
| Telegram         | Exact user/TG/account scope; expiry; launch duplicates; review without consent; MiniApp closes after signing; no HIP autonomous profile        |
| Matching/intel   | Same topic different oracle/time; side inversion; new recurrence; no public holder source; partial-history qualification; budget skip          |
| Operations       | Exit-only repair; stale jobs; restart/missing report; bounded polling; token/membership generations; retention protects user history           |
| Existing venues  | All existing EVM/Safe/Deposit Wallet/Solana funding and Polymarket/Limitless trading paths unchanged; Kalshi exit-only preserved               |

Fixtures must identify their origin: official SDK golden, sanitized actual read-only
payload, synthetic boundary or historical Hunch request. Do not label synthetic
quotes as tested executable routes or commit user balances/secrets/signatures.
Historical requests from production require explicit scope, read-only transactions,
timeouts and redaction, even where standing read permission exists.

For future code readiness run targeted protocol/funding/account/matching suites,
real PostgreSQL migrations/integration tests, TypeScript/lint and the **full
workspace build**. Current root commands include `pnpm test:fast`, `pnpm
test:matching`, `pnpm test:finance-worker`, `pnpm typecheck`, `pnpm lint`, and
`pnpm build`; integration database selection must use the repository's explicit
database URL/name guard. If local pnpm version fetching blocks build, use the
documented local Turbo fallback, not an automatic install/purge. See workspace
AGENTS for deployment-equivalent verification. These are future code gates,
not checks claimed to have passed for an unimplemented feature.

## 12. Open decisions and verification record

Before financial activation, resolve:

1. Exact mainnet outcome metadata, minimum notional/lot precision, fee and builder
   capability, and zero/one/fractional settlement payloads.
2. Core USDC raw units/token IDs for each activated spot/perp/unified route,
   mode-aware withdrawable capacity and exact account activation cost semantics.
3. Actual Relay route availability, amount limits/fees and signer contracts for
   each advertised direction; exact canonical Core credit/debit attribution.
4. Official SDK support/golden vectors, action types, nonce ownership and role
   restrictions for linked controllers; no autonomous agent approval.
5. Complete-enough fill/ledger coverage and current mainnet settlement observations;
   no false all-time PnL claims or flattened positions from partial data.
6. Canonical Hunch network/environment IDs, compatible storage strategy and
   current deployed schema facts before writing tolerant migrations.
7. Global holder/participant data source, if any; otherwise explicitly limited
   known-wallet tracking and research capability.

These are localized capability prerequisites. They are not permission to add
unrelated blocking guards or to rewrite all working venue paths.

### Completed documentation verification — October 5, 2026

- Root inspection verified the current/pinned historical source references,
  repository-relative paths and companion links, and checked material protocol
  claims against primary Hyperliquid, Circle and Relay documentation.
- Three independent document reviewers were started without conversation
  history or prior findings. Review 1 gave documentation GO with refinements
  on builder eligibility, non-trade cost-basis events, observed-wallet coverage
  and fee deduplication; those refinements were incorporated.
- Review 2 withheld GO over portfolio-margin borrowing guarantees and identified
  the existing Requests v2 dependency. Root independently confirmed both issues
  and corrected the capability requirements and scoped v3 migration plan.
- Review 3 reviewed the corrected specifications and source/protocol contracts:
  **GO for development-reference documentation only**, no material blocker.
  Root verified and incorporated its two precision notes about Relay API-key
  scope and the shared interactive/bot executor registry.
- Both new documents pass scoped Markdown lint and Prettier checks. The full
  frontend Markdown command still reports the pre-existing second H1 in
  `Hunch_App/AGENTS.md` (`MD025`); that unrelated file was not changed.

At completion of the documentation review, only these two documentation files
were added, unstaged, on `hip-next` based on the recorded main refs. No
application code, dependency, schema, production setting or operational
automation was changed during that review; no commit/push/deploy occurred.
No live route, signing, financial execution, migration or build was performed.
This record verifies the specification, **not implementation or deployment
readiness**. The open decisions and future test/build requirements remain real.
