# Hyperliquid HIP-4 integration: backend development specification

## Status, scope, and evidence

This is the backend source-of-truth specification for `hip-next`, updated and
rechecked on 2026-10-12. It is a development plan, not an assertion that HIP
trading, funding, matching, or wallet intelligence is implemented or production-ready.

Start with section 12 for evidence gates, section 11 for implementation order,
then the owned domain section and companion client contract. Section 13 records
the implemented P0 read-contract foundation and passive P1 canary. Financial
capabilities remain off and require their listed proof. Sections 16–18 record
P1 acceptance and the latest P0 evidence; earlier acceptance notes are dated history.

| Repository             | Branch / immutable reference                                                |
| ---------------------- | --------------------------------------------------------------------------- |
| Backend baseline       | `main` / `origin/main`: `a430729ed5ac028b8124198b4dec758221dbb0fc`          |
| Frontend baseline      | `main` / `origin/main`: `044163ba060620512ceb8ba2affd2b9cd5a00b92`          |
| Old backend prototype  | `hip`: `dce2d7cd`, June 2026                                                |
| Old frontend prototype | `hip`: `d29c056d`, June 2026                                                |
| Synchronized branches  | Backend `hip-next`: merge `7b3ed928`; frontend `hip-next`: merge `537910fb` |

Read the companion [frontend specification](https://github.com/Sureshot-Labs/Hunch_App/blob/hip-next/docs/hyperliquid-hip4-integration.md)
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

The feature now includes a disabled-by-default passive read implementation;
the June `hip` implementation remains reference material. Documentation and
branch synchronization do not enable HIP. Public documentation can establish wire
contracts, not current account eligibility, executable routes or financial
readiness; those require the scoped evidence in section 12.

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

General spot formatting documents at most five significant price figures and
`8 - szDecimals` price decimal places, with an integer-price exception. Outcome
formatting is different: the pinned official application in section 18 uses
`szDecimals=0`, fixed **five price decimal places**, and outcome-token
`weiDecimals=5`. These are separate from quote-token raw units (observed USDC: 8).
Preserve the dated source of these terms rather than inventing fields in a
`spotMeta` response that does not contain outcome tokens. Strip invalid trailing
zeros before signing; native boundary acceptance is a separate test.
[Tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)

Required quote math uses exact decimal strings/integer units. Quantize first,
then validate actual signed notional/size. Buy fee-inclusive debit and sell
token debit must reflect those final quantities. Do not inherit Polymarket's
five-share or marketable-buy minimum, Limitless fee math, or a universal `$10`
HIP minimum. The official error reference documents a 10-quote-unit spot minimum;
the HIP-specific accepted/rejected boundary remains unobserved. Section 18 now
contains native original BUY orders below $10, not merely partial fills. Do not
apply that generic spot floor to outcomes or infer a new exact floor from the
smallest selected order.

The required minimum proof must identify the tested original order, its exact
integer size and price, the native per-order acceptance/rejection, and the rule's
valuation basis (limit versus reference price, side, opening versus closing).
An explorer transaction's top-level success, an IOC sell floor or the smallest
returned fill cannot establish that predicate.

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
Hunch's allocator coordinates Hunch processes, not unrelated external apps using
the same signer. Test externally advanced nonce state and classify definitive
rejection separately from a response lost after acceptance; never automatically
sign a replacement action for an uncertain original.

### Account modes and fees

Current account abstraction supports standard, unified and portfolio-margin
behavior. In unified modes, legacy perp account views are not interchangeable
with complete spot cash information. Do not change a user's account mode to
make an integration simpler.
[Account abstraction modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes)

Discontinued DEX abstraction and unknown modes must not fall through as Standard.
Preserve qualified reads and explicitly unsupported write capabilities until the
actual mode-specific cash contract is established.

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

The current Circle guide places the one-time account activation charge on the
first outbound action, not an automatic haircut to the first credited deposit.
Represent activation liability separately from observed incoming credit and
forwarding fees. Test new-account withdrawal capacity and small deposits; do
not resurrect the legacy bridge's minimum in the CCTP receive flow.

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
Its legacy `clearinghouseState.withdrawable` balance example does not supersede
Hyperliquid's mode-specific balance contract in section 5. Also keep Relay's
8-decimal quote example distinct from human-readable `SendAsset.amount`.
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

| Domain                 | Current owners / gap                                                                                                    | HIP requirement                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Lifecycle              | `packages/shared/src/venue-lifecycle.ts`; HIP unreleased/off; active enables automation                                 | Interactive capability plus independent autonomous exclusion; exit-only preserves reads/repair |
| API schema             | `apps/api/src/schemas/common.ts`, `order-types.ts`                                                                      | Add public/account/trade types only when their implementation exists                           |
| Public discovery       | `repos/unified-read.ts`, `routes/events.ts`, `routes/markets.ts`                                                        | Remove explicit HIP exclusion in proven read paths; correct ranking units and coverage         |
| Live data              | `lib/hot-tokens.ts`, routes prices/SSE, shared writers                                                                  | Register HIP hot keys/stream keys and inferVenue; maintain bounded fanout                      |
| Charts/trades          | Event/market candles and `routes/trades.ts`                                                                             | Real source-labelled historical series and trade normalization; validate event/token IDs       |
| Account value          | `account-value/known-asset-catalog.ts`, `runtime-service.ts`, `ownership-resolver.ts`, `cash-availability-projector.ts` | HyperCore account binding, mode-aware locks/cash, freshness/completeness                       |
| Positions              | `repos/positions-repo.ts`, `order-types.ts`, collectors                                                                 | Storage allowance exists; read/valuation/settlement support does not                           |
| Orders/executions      | `repos/orders-repo.ts`, `repos/executions-repo.ts`, `repos/unified-orders.ts`, `routes/positions.ts`                    | Venue schemas, scoped IDs, replay-safe fills, cancellation and recovery                        |
| Funding policy         | `funding/policies/funding-policy.ts`, `funding-policy-v2.ts`                                                            | Core locations/routes/signers/observers; compile only supported capabilities                   |
| Preparation            | `funding/preparation/runtime-service.ts`, `core-adapter.ts`                                                             | HIP trading destination and non-money readiness; class transfer is explicit funding            |
| Shortfall / Max        | `funding/planner/market-buy-suggestion.ts`, `trade-shortfall-preflight.ts`, `source-reservation-capacity.ts`            | HIP fee-inclusive budget adapter and exact destination units; bidirectional capacity           |
| Relay                  | `funding-providers/relay/`                                                                                              | Native Core currency/DEX/signature contracts, not relaxed EVM validation                       |
| Durable execution      | `funding/execution/operation-action-runtime.ts`, `operation-execution-preflight.ts`                                     | Exact signed-action executor/lease/report/evidence protocol                                    |
| Trade attempts         | `funding/persistence/funding-trade-attempt-repository.ts`                                                               | New scoped HIP execution path, DB constraint, same attempt/consumer lifecycle                  |
| Settlement/actions     | `funding/position-actions/venue-driver.ts`                                                                              | No fake conditional-token driver; automatic settlement observer/accounting                     |
| Fees/rewards           | `repos/fee-policy.ts`, `services/rewards.ts`, fees/reconciliation                                                       | Supported builder collection and observed charged fees; no unearned rewards                    |
| Matching               | `packages/market-matching/`, `apps/market-matcher/`, shared matching policy                                             | Current Jev pipeline and explicit venue allowlists; exact resolution semantics                 |
| Intel/research         | `wallet-intel-refresh.ts`, `services/wallet-intel-*`, `services/holder-research*.ts`                                    | Known-wallet data first; coverage-qualified holder/trader intelligence                         |
| Signals/map            | `services/signal-matching.ts`, `services/signal-bot-*`, `ai-map-*`                                                      | Source and delivery capability distinct from automated execution                               |
| Theses and Copy        | `schemas/social-trade.ts`, `services/social-instrument.ts`, `social-copy.ts`, `verified-buy*.ts`                        | HIP instrument/evidence adapter and pre-submit attribution; see section 7 social contract      |
| Social reads/lifecycle | `routes/social.ts`, `services/social-service.ts`, `social-policy.ts`, `social-lifecycle.ts`                             | Existing feed/likes/comments/stats and deletion/merge semantics, not a HIP social fork         |
| Telegram               | `services/telegram-app-handoff-v2*`, repository, Mini App links                                                         | Explicit user web handoff; reject HIP execution for autonomous `telegram_bot` actors           |
| Retention/admin/ops    | retention selectors, admin schemas, compose/build, cron                                                                 | Protect new raw/ledger references; operational visibility and safe cleanup                     |
| Public tools           | Separate `hunch-agent-tools-public` client/schema                                                                       | Extend read-only venue schemas after actual API support; never expose execution                |

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
`RAISE EXCEPTION` rollout guards. At this baseline, `ops/deploy-ec2.sh` and
`ops/deploy-ec2-prebuilt.sh` migrate before replacing live app containers. Use
expand/contract changes compatible with both old running readers/writers and
the new image; do not drop a constraint/field that the old image still needs.
Verify the actual deployed script before rollout. Migration locks and partial
schema changes remain availability risks even when old containers stay up.
Authorized read-only production facts or representative restores must establish
legacy-row handling and migration scope before deployment.

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
lease may be retired as non-submitted only with proof that its submission boundary
was never crossed; lease or quote expiry alone cannot prove that money never moved.
No indefinite manual-review dead end for
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

The merged baseline includes `0271_positions_asset_ledger.sql`,
`services/position-market-rows.ts` and ledger-aware position reads. Legacy and
non-Polymarket positions use the empty `position_contract` namespace; Polymarket
V2 uses an actual contract plus frozen `asset_context`. Do not store a HyperCore
account/DEX in that EVM contract field or manufacture a Polymarket asset context.
Agree an additive HIP identity projection, including environment and exact
outcome instance, before altering position uniqueness/read keys. Preserve frozen
position identity when overlaying current prices, resolving a sell, or rolling
to the next recurring market. Round-trip it through authenticated market rows,
portfolio, event positions and share/PnL projections; test legacy Poly and V2
positions with the same token identifier alongside HIP rows.

Canonical fills require environment, account, order reference, `tid`/provider
identity, timestamp, token side, signed size/price, cost/proceeds, fee asset/raw
amount and source payload fingerprint. Transaction hash is supporting evidence,
not necessarily a unique execution key.
The public WS contract defines trade identity using time + coin + `tid`, not
`tid` alone; add environment and account/order scope for private economic fills,
then apply proven primary/dual alias normalization. A repeated WS snapshot and
REST replay must not add to position, verified purchase or rewards twice.

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

### Theses, verified purchases and attributed Copy

HIP ordinary trading and HIP social eligibility are separate capabilities.
Current `schemas/social-trade.ts` accepts only Polymarket, Limitless and Kalshi;
`social-instrument.ts`, `verified-buy-observer.ts` and the exact-reference lookup
in `social-copy.ts` have no HIP path. Adding a venue enum or an order adapter
does not make a purchase publishable or a Copy recoverable.

Extend the existing owners rather than creating another social API:

| Boundary               | Required HIP integration                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instrument             | `social-instrument.ts`, both social schemas, and `social-service.ts` instrument matching; exact environment, outcome token/side, instance generation and expiry       |
| Execution proof        | `verified-buy-evidence.ts`, `verified-buy-observer.ts`, `verified-buy-runtime.ts`; normalize observed economic BUY fills, never quote/request size or HTTP acceptance |
| Pre-submit attribution | `social-copy.ts` and the actual direct/funded submission driver; retain source, idempotency key, prepared fingerprint and scoped `cloid` before submission            |
| Repair                 | `findCopyPurchase`, `recoverCopyPurchaseLinks`, verified-buy leases/backfill; exact references and observation only, no new signature/order                           |
| Read models            | `social-service.ts`, `social-primitives.ts`, `routes/social.ts`; eligibility, thesis snapshot, Copy count, feed and profile statistics                                |
| Lifecycle              | `social-lifecycle.ts`, account delete/merge and retention; preserve economic identity and proof references without retaining private identity unnecessarily           |

**Purchase identity.** Use environment + economic account owner + authoritative
primary order identity as the canonical purchase key; `oid` alone is insufficient.
Before an `oid` exists, retain environment + owner + Hunch `cloid` and the immutable
action fingerprint. Prove their association from provider/order observations.
Primary/dual history records and execution rows are aliases of one economic
order only when the provider evidence establishes that relationship. Never merge
by equal amount/time, transaction hash alone, a Hunch user ID, or title. Pin the
exact serialized key/alias representation in P0 fixtures before schema work.

Aggregate all confirmed partial fills of that one purchase using exact
quantities, gross notional excluding fees/funding, net received shares, charged
fees (unknown remains null), evidence IDs and verifier revision. Normalize dual
book representations to the originally bought instrument; a raw dual-side SELL
is not an unrelated purchase. A later fill revises evidence but not an already
published thesis snapshot. Different orders are never summed to meet eligibility.
Cancelled remainder does not erase sufficient executed BUY notional. Revoked
evidence invalidates the corresponding thesis proof and Copy count through the
existing worker; a transient read failure does not revoke confirmed money.

Do not pass HIP through the existing generic CLOB fallback: its non-Polymarket
canonical key is Limitless-specific. Extend it explicitly or add a small HIP
evidence normalizer feeding `factsFromEvidence`. Those facts currently assume
USD-valued collateral and payout. Support only a proven quote-asset valuation
mapping for publication; a non-USD token amount must not be relabelled USD.
Keep reads/trading available independently of unsupported social valuation.

**Copy contract.** Reuse `sourceRef: { kind: "thesis" | "hunch", id }` and the
existing direct HTTP `copyIdempotencyKey` convention, explicitly mapped to the
internal admitted trade/attribution identity. A Hunch source is the exact published
signal revision, not CONTEXT or the latest note for a market. Copy buys the same
instrument/outcome/generation with a user-selected amount and fresh quote; it
does not copy leverage, account mode, standing permission or the original amount.
Never silently discard `sourceRef` when a path lacks attributed Copy support.

Persist the attribution and submission boundary before broadcasting. The exact
reference remains reserved in all attribution states; lost response, replay and
unknown commit reconcile the same purchase, never place another. Carry the source
and Copy key through shortfall planning, consumer intent, refresh, signing and
final submit in both direct and funded paths. The current funding continuation
must not be assumed to propagate them. A changed source/instrument/amount is a
new consented intent, not an idempotent retry with a reused key.

Source hide/block/suspension before admission prevents new Copy. A later hide
does not prevent observation of an already authorized purchase. Self-Copy is
forbidden; repeated confirmed purchases by the same other user still count as
one copier. Eligibility is indexed and refresh is an explicit bounded job, not
a synchronous scan of wallet history.

Use `social-policy.ts` for the effective revision, publication threshold, text
limits and repair budgets. The initial publication threshold is $10, not a HIP
trade/Copy minimum; handlers, SQL and UI must not duplicate it. Preserve policy
failure, replay-before-new-limits and safe read/hide semantics. Add per-venue
capability checks to `canCopy`, eligibility and admission; global `copyEnabled`
alone cannot advertise a HIP path that is still unimplemented.

Reuse the existing chronological social feed, profiles, likes on theses/Hunches/
comments and flat comments. Preserve typed targets, AI thread root versus viewed
revision, visibility/block filtering, precise cursors and batch hydration. No
new HIP feed, comment tree or inferred historical Copy attribution is needed.
Snapshot thesis return remains separate from author wallet PnL and uses the
existing `feeTreatment: excluded` contract; full portfolio accounting includes
actual fees. Official fractional payout is not two binary wins, and a closed
market without settlement proof stays pending.

Test account merge/keepSource, hard delete/deactivation, ownership reparenting,
unique copier recount, invalidation and retention of market/token/order/fill/AI
references. Keep economic keys independent of mutable Hunch user IDs. Social
disablement must preserve observation of admitted purchases and safe existing
reads; no evidence-repair job may revive an old trade. Reuse the sidecar-safe
policy module without importing API-wide env into the finance worker.

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
Feed canonical official settlement into `services/holder-research-performance.ts`
and calibration, preserving v2 evaluation/coverage semantics. A 0/100-cent mark,
expired contract or absent entry is not an invented binary result or zero return.

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

| Phase | Deliverable                                               | Exit evidence                                                                                                             |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P0    | Read-only protocol fixtures and capability decisions      | Mainnet/testnet differences, exact token units, mode/fee/minimum contracts, Relay routes and receipt fields verified      |
| P1    | Public indexer/read contracts                             | Isolated canary; stable identities; correct trades/metrics; terminal lifecycle; bounded performance                       |
| P2    | Owned account and ledger projection                       | Mode-aware available cash; zero/partial snapshots; settlement and PnL; no duplicate value                                 |
| P3    | Durable Core funding/withdrawals                          | Both directions, both signatures, exact debit/credit, cancel/unknown recovery; no manual dead end                         |
| P4    | Interactive trade adapter and server submission           | Direct/funded GTC/IOC/ALO supported subset, fees, nonce/cloid concurrency, fills/cancel/settlement                        |
| P4S   | Verified theses and attributed Copy                       | Exact purchase/dual aliases, source retained before submit, direct/funded recovery, lifecycle and social read-model tests |
| P5    | Web/MiniApp handoff and all public surfaces               | Three device contexts, explicit signing, autonomous HIP remains excluded                                                  |
| P6    | Matching, tracked-wallet intelligence and signal delivery | Rule-equivalence fixtures, bounded coverage/budgets, truthful holder limitations and web CTA                              |
| P7    | Gradual activation                                        | Full build/tests, migration compatibility, exit-only recovery and observed canary before production exposure              |

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

### Policy and cross-repository acceptance

Product thresholds, enabled capabilities, freshness budgets, retry/backfill
limits and rate budgets belong in their existing runtime policy owners with
validated defaults and an effective revision. Venue protocol constants (asset
encoding, signature field types) and financial identity/consent invariants are
not disableable product knobs. Do not put a second $10 publication threshold or
a guessed trade minimum into HIP SQL, handlers, UI presets or admin forms.

P4S extends `social-tests.ts`, `verified-buy-tests.ts`, the verified-buy integration
and batch suites, `social-copy-concurrency-integration-tests.ts`, social
lifecycle/maintenance/likes suites and finance-worker tests. Add fixtures for
pending-to-verified-to-revoked evidence, partial/cancelled fills, duplicate aliases,
late fills after publication, Copy timeout before/after broadcast, hidden source,
self/repeated copier, mismatched expiry, merge and exact-reference recovery.
No additional tables or a second worker framework are prescribed when the
existing evidence/lease/attribution owners suffice.

Backend owns native identity, exact decimals, capabilities, normalized signatures,
attempt status and social proof. Frontend consumes generated DTOs and owns review,
signing prompts and scoped report replay. Agree these contracts as one versioned
fixture bundle before parallel adapter work. Include error/reason codes and
unknown-field handling; reject only the unsupported write rather than losing an
existing balance. Existing clients and existing-venue regression cases must pass.

P4S may remain disabled while ordinary HIP trading is enabled; this must be
visible in server `canCopy`/eligibility and all client CTAs. P5's social controls
depend on P4S, while ordinary navigation/handoff does not. Research remains a
separate P6 capability and never blocks otherwise safe trading.

## 12. Open decisions and verification record

### Official evidence rechecked on October 11, 2026

The following primary sources were reopened for this revision. Their scope
must travel with fixtures; an example payload is not proof of a live route.

- Market availability and settlement:
  [HIP-4 overview](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-4-outcome-markets),
  [contract specifications](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications),
  [deployer actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-4-deployer-actions).
  Preserve mainnet versus testnet scope.
- Metadata and units:
  [Asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids),
  [spot info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot),
  [precision](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size).
  Separate coin, token, order asset and amount units.
- Signing and execution:
  [signing](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing),
  [nonces](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets),
  [exchange](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint),
  [order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types).
  Separate L1/user-signed actions and uncertain/terminal status.
- Cash and fees:
  [account modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes),
  [portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin),
  [fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees),
  [builders](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes).
  No global zero-fee or no-borrow assumption.
- Streams and history:
  [subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions),
  [info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint),
  [limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).
  Distinguish replay/snapshot, bounded history and fee inclusion.
- Funding:
  [USDC](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/usdc),
  [Circle concepts](https://developers.circle.com/cctp/concepts/cctp-on-hypercore),
  [Circle forwarding](https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore),
  [Relay Core](https://docs.relay.link/references/api/api_guides/hyperliquid-support).
  Credit, activation, forwarding and withdrawal are distinct.
- Relay API lifecycle:
  [API keys](https://docs.relay.link/references/api/api-keys),
  [Requests migration](https://docs.relay.link/references/api/api_guides/migrating-to-requests-v3),
  [changelog](https://docs.relay.link/changelog).
  Upgrade the actual wire parser, not only an endpoint suffix.

### Implementation start and evidence gates

The package is sufficient to start P0 contract/fixture work and the passive P1
indexer slice. It is not a claim that every financial adapter can be implemented
from example values, or that production activation is approved. Open items below
have localized owners and acceptance evidence; they do not block unrelated work.

| Decision                                                    | Owner and first artifact                                                                                                    | Gate                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Canonical Core identity and exact units                     | Shared/API schema owner: versioned identity fixtures, mapping to DB and generated clients                                   | Before persistent HIP rows or financial DTOs                                                                      |
| Outcome metadata, orderability, settlement and fee envelope | Protocol/indexer owner: dated mainnet/testnet metadata and settlement fixtures plus exact validation cases                  | Before enabling that market/environment for writes                                                                |
| Signatures and account-mode safety                          | Trading/funding owners: pinned SDK version/commit goldens, signer/domain/action matrix, nonce and mode-change tests         | Before accepting signatures or submitting; portfolio-margin writes remain off without enforceable no-borrow proof |
| Routes and canonical credit                                 | Relay owner: v3 wire fixtures, quote/actions for each advertised direction, receipt attribution and ambiguous recovery      | Before each source/destination capability is enabled                                                              |
| Ledger and social proof                                     | Account/social owners: fill/dual-order/settlement fixtures, canonical key and aliases, immutable publication/Copy lifecycle | Before complete PnL claims or P4S enablement                                                                      |
| Client parity                                               | Web owner: generated contracts and deterministic desktop/mobile/MiniApp scenarios                                           | Before the corresponding CTA becomes actionable                                                                   |
| Operations                                                  | API/indexer owners: disposable PostgreSQL 16 migrations/plans, mixed-version compatibility, full builds and staged rollback | Before deployment; no production DDL/backfill/live signing implied                                                |

Each fixture records source URL or sanitized provider endpoint, collection date,
environment, SDK/protocol revision if available, semantic scope, expected normalized
output and missing coverage. Revalidate stale dynamic metadata at quote/admission;
do not make October 11 examples permanent runtime constants. Obtain separate
authorization for account-specific/provider-key probes, signed test transactions,
production data, deployment or financial backfills. Public documentation research
in this revision used no keys, account calls or live quotes.

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

### Historical documentation verification — October 5, 2026

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

At completion of the October 5 review, only these two documentation files
were added, unstaged, on `hip-next` based on backend `2ade5f71` and frontend
`3321fc06`. No application code, dependency, schema, production setting or operational
automation was changed during that review; no commit/push/deploy occurred.
No live route, signing, financial execution, migration or build was performed.
This record verifies the specification, **not implementation or deployment
readiness**. The open decisions and future test/build requirements remain real.

### Revision review on October 11, 2026

Three sequential review passes were performed against the synchronized baselines;
these were author reviews, not new independent-agent approvals.

1. Code compatibility: added the missing social proof/Copy boundary, exact aliases,
   current position-ledger owners, lifecycle and policy integration. Kept HIP
   ordinary trading independent of the optional social slice.
2. Provider and operations evidence: rechecked the primary-source register;
   clarified amount precision, first-outbound activation, mode-specific balances,
   external nonce use and mixed-version migration ordering. Conflicting protocol
   fee envelopes remain explicit capability gates rather than guessed defaults.
3. Cross-package consistency: aligned source/key propagation, social recovery,
   labels, shared-versus-snapshot PnL, safe lease expiry, phase dependencies and
   read-only versus financial readiness. Replaced workspace-only companion links
   with repository links and pinned the separate social handoff.

Verdict: **GO to begin implementation with P0 and passive P1**. No unresolved
document contradiction was found in the final pass. Live minima, exact route
availability, signed-action goldens and settlement/economic-fill fixtures remain
the scoped implementation evidence gates above, not claimed completed tests.

Validation: both specifications pass scoped Markdown lint, Prettier and diff
whitespace checks. Existing source paths and local links were checked; proposed
modules are labelled as such. The full backend workspace build passed, 16/16
tasks from cache, on the unchanged application baseline. Full frontend Markdown
lint still reports only the pre-existing `AGENTS.md` second H1 (MD025). No SQL,
application code or runtime policy was changed; no financial/live execution
tests are claimed by this documentation revision.

## 13. Implemented passive slice — October 11–12, 2026

Historical record of the first slice. Section 14 supersedes its read/live/history
coverage and acceptance status; its financial exclusions still apply.

This is an implementation record, distinct from the earlier documentation review.
P0's public read-contract foundation and a passive P1 canary are implemented in
the working tree. This is **not** financial activation or a complete P0 financial
evidence sign-off. No commit, push, deployment or production policy change was
performed for this slice.

### Evidence and contracts

- Sanitized public reads are in `apps/api/src/fixtures/hip4/public-reads.json`.
  Collection: `2026-10-11T22:17:25.162Z`; mainnet/testnet `outcomeMeta`,
  `spotMeta`, selected `l2Book`/`recentTrades`, and mainnet `settledOutcome`.
  No account requests, credentials, signatures or participant addresses are kept.
- Mainnet contains sports templates, standalone outcomes, question members and
  fallback outcomes. Testnet also has custom side labels. The mapper does not
  assume recurring BTC binaries or overwrite native labels with YES/NO.
- The observed USDC metadata has `weiDecimals=8`. Outcome `+...` entries were
  absent from these spot metadata responses: outcome precision remains `null`,
  not a guessed trading size. Binary zero settlement is observed; one/fractional
  settlement and precision boundaries are explicitly synthetic test cases.
- `packages/shared/src/hip4.ts` owns environment-scoped identities, exact units,
  schema version 1, read DTOs and `hip4_read` policy defaults. Full contracts are
  generated offline by `apps/api/src/hip4-openapi.ts` for the canary endpoint.
- Market IDs are `hyperliquid:<environment>:outcome:<index>`; grouped event IDs
  use `question:<index>`. Token IDs retain the environment and encoded side;
  provider coins use `#`, token names use `+`, asset IDs use the protocol offset.
  Legacy identities are not silently reinterpreted.

### Runtime and storage

`apps/api/src/hip4-indexer.ts` is a sidecar-safe entrypoint in the existing API
build artifact, with public protocol code under `services/hip4-*`. It requires
explicit `--database-url` and `--expect-database`, verifies the target, and holds
one session lock per canary DB. `--once` performs one bounded cycle. No service
or deployment automation starts it implicitly.

The existing admin policy API validates the same `hip4_read` schema. Defaults:
disabled, empty outcome allowlist, 60-second polling, six outcomes per cycle,
600 request-weight units per rolling minute, 20 read rows per page. Request
timeout/bytes, freshness, page size, rotation and stream retry/heartbeat limits
are policy-owned. Bad configuration stops provider requests, reports failure,
and is retried; it does not activate fallback defaults. Disable via `enabled:false`.

Admission is atomic in PostgreSQL and shared across environments/processes using
that DB; this is not a claim of coordination across unrelated databases or
services bypassing the client. An eventual deployment must allocate the shared
egress-IP budget across those consumers. Testnet remains a separate canary DB,
never a policy switch against production financial storage.

REST generations repair metadata after coalesced `outcomeMetaUpdates` hints and
reconnects. Stream hints never publish authoritative state. Periodic REST also
works if the stream is unavailable; retry/backoff, heartbeats and bounded
refresh intervals prevent a busy stream from driving unbounded requests.
Cycle diagnostics include policy revision, fetch/map/write duration, oldest
snapshot age, indexed/skipped outcomes, failure reasons and stream state.

Migration `0281_hip4_passive_reads.sql` adds raw/read snapshots, a collision-safe
public-trade ledger, a rotation cursor and request admission state. Publication
atomically includes the event, market and both side mappings. Older generations
cannot replace newer ones; replay is idempotent. Only the primary side's merged
trade stream is ingested; dual records are not summed into fabricated volume.
Expiry triggers an official settlement lookup even while metadata still lists
the outcome. Missing settlement is pending, not LOSS; near-0/1 fractional payouts
are not rounded into binary results. Group-event status remains conservative
when only some members are observed; canary DTOs expose each outcome's state.

### Exposure and remaining coverage

`GET /markets/hyperliquid/canary` requires administrator `analytics:read`, is
`private, no-store`, and only serves the effective environment/allowlist. It
returns policy revision and refresh interval; disabled/config-error/empty states
are distinct. All trade, Copy, funding and automation capabilities are false.
Ordinary discovery stays unreleased; new canary identities do not leak through
legacy market/event/token detail contracts. Existing venue behavior and legacy
owned-record identities are retained.

Books distinguish fresh, stale, empty and failed observations. Recent trades
have observation/window coverage, not a promise of gap-free history. Candles,
aggregate ranking, USD volume and OI are unavailable, not zero. This slice does
not wire HIP into public SSE/hot-token acquisition, charts, research, account
value or financial execution. Those broader surfaces remain gated by their
later phase contracts; there is no inference of P2–P7 readiness.

The frontend companion records generated clients and provider-free desktop/mobile
fixtures. Public financial prerequisites in section 12 (exact executable units,
minimums, mode/fee contracts, Relay receipts and signed-action goldens) remain
localized open evidence gates, not completed tests.

### Verification and review record

- Fifteen protocol/client/route/stream tests pass (`pnpm -F api test:hip4`).
  They include wrong identities, native labels, exact decimals, payout boundaries,
  stale/empty/crossed books, off-policy behavior, coalescing and reconnect repair.
- All migrations through 0281 ran on fresh disposable PostgreSQL 16.2.
  `hip4-integration-tests.ts` covers atomic rollback, replay/ties, frozen official
  results, pagination, malformed policy, rolling shared-budget concurrency and
  recovery, expired-but-listed settlement and cascading derived-data cleanup.
- `hip4-sql-plan-tests.ts` executed generic first/resumed/empty pages against
  20,000 markets and a million-trade ledger. Index scans read 0–4 market rows or
  21 trade rows; observed execution times were below 0.1 ms, not production SLAs.
  The full retention selector and exact disposable delete path also executed.
- A live public mainnet cycle for outcome 11117 succeeded into the disposable DB:
  one market, no failures, 2.45 seconds. No financial requests were made.
- Scoped backend lint/typecheck and the complete 16-package workspace build pass.
  API, finance-worker and matching portions of `test:fast` pass; its final
  Telegram snapshot freshness check fails on pre-existing renderer/snapshot drift
  (interest-signal menu and research footer). The 14 preview behavior tests pass.
  Unrelated snapshots were not regenerated to disguise this limitation.
- Sequential author reviews corrected participant titles, per-trade SQL writes,
  rolling-budget recovery, expired metadata settlement lookup, canary isolation,
  numeric payout rounding, failed-refresh display and provider-free fixtures.
  No independent-agent approval is claimed.

Reproduce DB suites only with explicit `DATABASE_URL` and matching
`HUNCH_TEST_EXPECT_DATABASE` pointing at a disposable PG16 database. Migration
commands must use `--database-url` and `--expect-database`; never rely on a shell
URL override alone. Financial calls, production backfills and rollout still
require separate authorization. See the frontend record for its build limitation.

## 14. Read-only P1 completion patch — October 12, 2026

Implemented on `hip-next`, without commit/push/deploy or production policy writes.
This is read-only infrastructure, **not** completion of financial P0 or P2–P7.

### Correctness and recovery

- Question membership includes named, settled and fallback members. Missing
  membership and incomplete same-ID question context retain the last confirmed
  description/expiry. Cached specs do not refresh metadata provenance.
- REST and WS publication merge book observations independently per side under
  the market transaction lock. Older/equal provider timestamps cannot overwrite
  an accepted book. Trade observations, attempts and official settlement checks
  are also ordered independently of metadata time. Settlement `observedAt`
  remains its first observation; `checkedAt` only advances on a provider check.
- Metadata pair admission is atomic (40 weight units); valid policies start at 40. Optional book/trade failures no longer discard valid metadata. Diagnostics
  distinguish admission denial, HTTP/transport/timeout, invalid identity/payload,
  stale observations and local trade truncation. Last-good values and last
  attempts are separate; ordinary later cycles recover after policy repair.
- `recentTrades` admission no longer depends on the processing limit: reserve
  120 units for the supported 2,000-row response envelope. The official weight
  rule is 20 plus one unit per 20 returned items. This envelope is conservative,
  **not a documented provider maximum**; a response exceeding it is a protocol
  drift diagnostic. Do not use the processing cap as a provider request limit.
  [Official rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)

### Bounded live path

One existing Hyperliquid socket carries metadata hints, L2 for both sides and
primary-side trades. Admin hot demand selects within the effective allowlist;
settled markets do not consume hot slots. REST bootstraps and repairs reconnects,
overflow and invalid messages. No connection per market is created.

New `hip4_read` defaults: `liveEnabled:true` (still subordinate to `enabled:false`),
`maxLiveOutcomes:6`, `streamQueueSize:2000`, `streamFlushMs:1000`,
`subscriptionRefreshMs:15000`, `policyCheckMs:5000`, `hotDemandMaxAgeMs:120000`,
`historyMaxRangeMs:86400000`, `candlePageSize:120`. Subscription rotation is
validated against its maximum hot-set size to bound churn. Existing provider
retry/heartbeat and shared SSE resource limits remain active.

The sidecar accepts optional explicit `--redis-url` (or its own `REDIS_URL`).
Without Redis it still indexes but cannot fan out or read hot demand. Redis
operations have deadlines. DB commit precedes publication; each idle live flush
re-reads committed snapshots to repair lost publication. Failed flushes retain
a gap origin, wake REST repair, and reconnect on the next normal policy check.
Disable closes HIP subscriptions and prevents new provider requests; it does
not delete stored history. Revision/environment changes rebuild the live context.

Existing `/prices/stream` checks `analytics:read` and the effective allowlist for
canary token IDs before cache reads, hot marking or subscribing. Its policy timer
closes invalidated canary streams. Non-HIP streams retain their existing access
rules. Canary response `streamTokenIds` respects the existing SSE token limit.

### History, migration and compatibility

- Protected prefix `/markets/hyperliquid/canary`: list, `/:marketId`,
  `/:marketId/trades`, `/:marketId/candles`. Optional history `policyRevision`
  rejects stale context with 409; market IDs bind environment/outcome/allowlist.
- Trade cursor is versioned and market-bound, ordered by the full descending
  `(time_ms, coin, tid)` tuple. Prices/quantities stay decimal strings.
- `0282_hip4_read_history.sql` adds minute OHLC/share-volume aggregates and
  bounded minute observation/gap buckets. Only newly inserted canonical primary
  trades contribute: replay cannot double volume, late/tied trades order OHLC
  correctly. `0283_hip4_trade_cursor_index.sql` builds the full-tuple index
  concurrently. Published 0281 is unchanged. Both derived tables participate in
  retention counts/deletion and cascade with the read market.
- History explicitly says `source:canonical_primary_trades`, `complete:false`,
  and reports truncated coverage. Missing intervals are unknown, never synthetic
  zero-volume candles. No opposite-side trades are invented. Existing pre-0282
  trades remain readable; this patch does not backfill their missing candles.
- The old snapshot `coverage.candles:"unavailable"` refers to ordinary unified
  candle availability, kept for old-reader compatibility. The new protected
  candles response separately exposes partial native-ledger history. Ranking,
  aggregate USD volume and OI remain unavailable. Public discovery stays off.

### Verification and acceptance limits

- HIP protocol/client/route/stream tests: 27 passing; adjacent admin-auth,
  admin-route, hot selection and trading-static suites: 10/10 files passing.
- Fresh disposable PostgreSQL 16.2: every migration through 0283 applied;
  original and new P1 integration suites pass, including concurrent budget
  admission, metadata/quote ordering, frozen settlement provenance, replay/late
  candles, full-key pagination, gaps, policy disable and commit-before-publish.
- Generic/sparse/resumed/empty SQL plans execute against 20,000 markets,
  1,000,000 trades and 100,000 candle/coverage rows using indexes. Retention SQL
  and deletion execute on disposable fixtures. Measured timings are local only.
- Full workspace build: 16/16; workspace typecheck/lint: 31/31 tasks passing.
- One authorized public read-only WS probe: four subscriptions, four book
  messages and 30 primary trades in eight seconds, no invalid payloads or
  subscription errors. No accounts, credentials or financial actions used.
- Browser → real Next proxy → actual backend admin middleware → isolated
  PG16/Redis: anonymous 401, member 403, admin list/detail/trades/candles 200,
  wrong environment 404, actual SSE open/tick. This used synthetic sessions,
  not a real Privy sign-in. Desktop/mobile fixture visuals were checked twice.
- Sequential author reviews corrected additional component-ordering races,
  settled hot-slot starvation, flush-gap recovery and empty-cache SSE startup.
  These initial passes were not independent-agent approvals. See section 15
  below for subsequent independent review, and frontend section 15 for the
  exact Turbopack gate and remaining full-app authenticated acceptance.

Reproduce with `pnpm -F api test:hip4` and `pnpm -F api test:hip4:db`; use a clean
disposable PG16 target with matching `DATABASE_URL` / `HUNCH_TEST_EXPECT_DATABASE`.
For migrations always pass explicit `--database-url` and `--expect-database`.
The optional `hip4-browser-fixture.ts` is a standalone loopback-only acceptance
harness, not registered in the deployed API. Run with explicit disposable PG16
and Redis URLs, Next proxy target `http://127.0.0.1:3015`, frontend port 3014.
It creates only synthetic test users/policy/market observations. Never expose it
or run it against an ordinary local database. Cleanup the disposable services.

## 15. Independent implementation review — October 12, 2026

Three read-only reviewers started without conversation history. They covered
backend core/SQL, live/auth/recovery, and frontend/contracts respectively,
including committed HIP changes from each branch merge-base and all modified
and untracked implementation files. Corrections were re-reviewed until all
three reported no remaining concrete findings in their scopes. These are code
review verdicts, not deployment authorization or complete P1 acceptance.

Corrected findings:

| Area                     | Defect and correction                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata provenance      | A successful null settlement response refreshed a cached absent spec. Only an actual returned spec can renew that provenance.                                                                           |
| REST fairness            | Six outcomes at the default budget repeatedly denied trade repair to the same tail. The next cycle leads with budget-deferred work; metadata still publishes and a zero-optional-budget cycle advances. |
| Failure diagnostics      | A direct metadata-attempt update raced full snapshot publication. Both writers now use the same per-market lock with monotonic attempt timestamps.                                                      |
| Live rotation            | Retiring hot outcomes lost accepted queue entries. They remain in the drain set through the next flush.                                                                                                 |
| Terminal races           | Settlement could drop queued historical trades or allow an in-flight writer to change terminal books. Trades persist idempotently; the locked repository freezes settled books.                         |
| Sparse history           | Older candles outside the latest time window were unreachable. An indexed nearest-older-bucket lookup makes them pageable without scanning empty windows.                                               |
| Numeric pagination       | Text-cast output labels hijacked unqualified ordering and could skip tied trade IDs such as 9/10. Numeric ordering is qualified; plan tests reuse the exact production SQL.                             |
| Response contract        | Odd freshness limits produced fractional detail refresh intervals and a serialization 500. Detail uses the same integer rounding as list.                                                               |
| Frontend recovery/layout | Closed SSE handshakes recover on successful REST observations; mobile content reserves navigation and safe-area clearance.                                                                              |

Reverification: fresh disposable PostgreSQL 16.2 migrations through 0283;
original and P1 integration suites; actual concurrency barrier for failed
metadata writes; two-cycle budget fairness; numeric tied-ID pagination;
settlement/live interleavings; sparse history. Exact history query plans were
checked with one million trades and 100,000 candles/coverage rows, including
generic, first/resumed/empty and full-history edges. They use index traversal
without Sort nodes; local history-query execution was 0.014–0.078 ms with 3–8
shared buffer hits. Those synthetic timings are not a production SLA.

Full workspace build/typecheck/lint: 47/47 tasks pass. Pure HIP tests: 27 pass;
adjacent regression selection: 10/10 files. Frontend has 1,663 passing tests;
see its section 16 for build/browser acceptance limits. No production reads or
writes, financial calls, commit, push, merge or deploy occurred during this
review.

### Consolidated implementation status and next sequence

This table records the independent-review checkpoint. The subsequent real-login
acceptance and offline P0 evidence are recorded in section 16.

| Phase            | Implemented                                                                                                                                                | Remaining                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P0 read protocol | Public fixtures, scoped native identities, exact conversions, labels and official/fractional payout mapping                                                | Financial precision/minimum, fee/mode, route/receipt and signing capability evidence                |
| P1 backend       | Policy-controlled indexer, atomic storage, bounded live/REST recovery, protected reads/SSE, native trades/candles, explicit incomplete coverage, retention | Operational canary acceptance; no claim of exhaustive history, ranking, aggregate USD volume or OI  |
| P1 frontend      | Internal desktop/mobile cards, local freshness, live quotes, chart/trades, scoped cache/recovery, generated fixture/DTO agreement                          | Exact Turbopack build and real authenticated full-app desktop/mobile acceptance                     |
| P2               | Existing generic Hunch infrastructure is available for reuse                                                                                               | HIP owned-account/position/balance projection, fills/transfers/settlement ledger and reconciliation |
| P3               | Funding/signature contracts documented                                                                                                                     | HIP Core funding/withdrawal implementation and durable ambiguous-result recovery                    |
| P4               | Interactive trade contract documented; capabilities remain false                                                                                           | Prepare/sign/submit, nonce/cloid concurrency, order lifecycle and fill/cancel recovery              |
| P4S              | Existing generic social/verified-buy foundations                                                                                                           | HIP verified purchases, aliases and pre-submit Copy attribution                                     |
| P5               | Internal canary only                                                                                                                                       | Public discovery/event/portfolio and web/MiniApp handoff surfaces                                   |
| P6               | Coverage limitations documented                                                                                                                            | Matching, bounded tracked-wallet research, intelligence and signal delivery                         |
| P7               | Disabled-by-default policy and reversible read controls                                                                                                    | Operational activation, observing the canary and approved rollout                                   |

Next: complete P1 acceptance without enabling public exposure; close the financial
P0 evidence contract; implement P2 read/accounting projection first. Then proceed
P3 → P4 → P4S/P5, with P6 a separate research capability and P7 an explicitly
authorized rollout. Do not infer authority for signatures, production funding,
policy changes or deployment from a code-review GO.

## 16. Real-login P1 acceptance and offline P0 evidence — October 12, 2026

This follow-up starts from backend `51c0fec8` and frontend `f8c40df1` on
`hip-next`. Changes remain uncommitted. No production policy, account mode,
funding, order submission or live signing was changed.

### Implemented and exercised

- The full app now passed real Privy-authenticated inspection through
  `localhost:3000` → Next proxy → local API → isolated PG16/Redis → public
  mainnet data. The user-requested local admin flag stays enabled for continued
  testing; production permissions are untouched. The fixture query flag is absent.
- Desktop and 390/320 px mobile display current bid/ask observations, official
  settlement, recorded trades and minute OHLC. During this acceptance a new
  allowlisted HYPE outcome showed changing quotes without a manual refresh.
  A market with no recorded fills correctly showed empty history, not invented
  candles. Its later official settlement appeared as YES LOSS / NO WIN, after
  the pending interval. New trade arrival itself was not observed in that market.
- Fixed a live-history gap: the latest expanded trades/chart panel now refreshes
  at the server-provided cadence. Collapsed panels do not mount queries; background
  polling is disabled. Older pages do not auto-poll or jump back. User, revision,
  environment and market changes isolate cache and cancel obsolete requests.
- With temporary local page sizes of five trades and two candles, the real BTC
  ledger paged **5 → 5 → 1** without dropping equal-timestamp trades. OHLC and
  share volumes matched SQL. Earlier chart pages remained reachable. Restoring
  normal sizes used a new policy revision; the UI reset its old page context.
- The earlier real-login fault probe stopped only the local indexer, observed
  stale quotes disappear, then resumed it and observed fresh recovery with no
  flush errors. Combined with the current actual-history checks, this closes the
  prior real-Privy/full-app acceptance gap. The separate production-build gate
  subsequently passed in the user's terminal (see the verification table).
- Fixed date-only template deadlines: `YYYYMMDD` is parsed as the exclusive next
  UTC midnight, with calendar validation and no inferred settlement. Date-time
  semantics are unchanged. This follows the provider's
  [date hint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-4-deployer-actions#templates).

### Reproducible P0 evidence

`apps/api/src/fixtures/hip4/protocol-observations-20261012.json` contains four
public `outcomeMeta`/`spotMeta` reads, selected and sanitized at 12:32 UTC.
Mainnet outcome 11553 and testnet 23694 retain different native USDC token IDs,
eight raw-unit decimals and observed fee multipliers. Outcome tokens were absent
from those spot metadata responses: executable outcome precision stays unknown.
Neither a multiplier of 1 nor missing outcome metadata proves a zero fee or an
integer lot size. These are observations, not a forever-current capability cache.

`apps/api/src/fixtures/hip4/signing-sdk-0.24.0.json` adds twenty **offline** goldens
from the [official Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/tree/2fdb18f9517675ea03695a0962bd19eece9c83f0):
L1 direct/expiry/vault/vault-with-expiry, IOC sell, ALO, two-side batch,
cancel-by-OID, cancel-by-cloid and user-signed SendAsset, on both environments.
The generator pins SDK 0.24.0, its release commit and signing-source SHA-256,
plus the signing dependencies. It uses only the SDK's published example key,
synthetic actions and dummy recipients; never fund that key. No request is sent.

Regenerate from the repository root (requires the pinned packages in the uv cache):

```sh
uv run --offline --no-project apps/api/src/fixtures/hip4/generate-signing.py
```

This prints JSON only. Regeneration was compared to the checked-in fixture and
was identical. `hip4-signing-contract-tests.ts`, included in `test:hip4`, independently
verifies digests, signatures, recovered signer, environment and amount sensitivity
with the existing ethers dependency. SDK-produced MessagePack is the oracle;
the old prototype serializer is not used. The `421614` user-signature domain is
not mistaken for the Core environment. This is encoding evidence, **not** a
production signer, executable order, fee/minimum test or Privy-role approval.

### Verification and remaining boundaries

| Check                                         | Result                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure HIP regression + SDK and route contracts | 56/56 pass                                                                                                                                                                         |
| Full backend build/typecheck/lint             | 47/47 workspace tasks pass                                                                                                                                                         |
| Fresh isolated PG16.2                         | Migrations through 0283, original/P1 integration suites pass                                                                                                                       |
| SQL/load checks                               | 20,000 markets, one million trades, 100,000 candles/coverage rows; generic/sparse/first/resumed/empty pages and retention pass                                                     |
| Frontend                                      | 1,668 tests, typecheck, lint and generated contract/fixture agreement pass                                                                                                         |
| Full-app live UI                              | Actual Privy session, desktop/mobile, prices/SSE, history, pagination and scoped policy recovery verified                                                                          |
| Supplemental frontend build                   | Node 20 Webpack passes, with existing Privy/viem dependency warnings                                                                                                               |
| Exact frontend production build               | PASS, user-executed in the normal terminal: Node 20.11.1, Next 16.3.4 Turbopack; compiled in 20.5 s, all 42 pages generated. Supersedes the earlier agent-sandbox `EPERM` failures |

Both changed documents pass Markdown lint. Repository-wide frontend Markdown
lint still reports the pre-existing second H1 in `AGENTS.md`; it was not edited.

The new changes received author review and regression checks, not a new independent
agent verdict. Prior history-free reviews apply to the preceding implementation.

| Phase / evidence                         | Current status                                                                                                     | Concrete next step                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P0 read contract                         | Implemented and tested, including date-only expiry                                                                 | Retain dated fixtures and unknown precision explicitly                                                                                    |
| P0 offline signing                       | Twenty independently checked SDK goldens                                                                           | Reuse these as the oracle for the later production adapter; execution/error recovery remains a separate P3/P4 obligation                  |
| P0 executable precision/minimum and fees | First-party formatting/rate contracts and native fee samples captured in section 18; minimum boundary not observed | Verify the native boundary; do not substitute unsigned gateway acceptance for exchange acceptance                                         |
| P0 account mode / routes / receipt       | Funded unified snapshots and all four exact Relay/native/Base receipt correlations captured in sections 17–18      | Preserve cash/hold/risk capacity separately; owned-cash projection is P2, production credit attribution and recovery are P3/P4            |
| P1 read-only runtime                     | Local acceptance complete, including exact build                                                                   | Keep the canary internal; public activation/deploy remains a separate decision                                                            |
| P2–P7                                    | Not implemented by this patch                                                                                      | Begin owned-account/ledger projection only after its P0 contracts are settled; subsequent writes and activation need their own acceptance |

P1's internal read-only acceptance is complete; P0 financial execution terms are
not fully closed. Trade/Copy/funding capabilities remain false. No additional
migrations, financial SDK runtime or background account scan was introduced.
The scoped, explicitly authorized account/quote follow-up is recorded below.

## 17. Authorized account and Relay contract evidence — October 12, 2026

The user authorized reads for the one connected embedded EVM wallet in the
isolated `hip4_local` database. Five mainnet `/info` reads and eight `/quote/v2`
requests were made, including two pairs clarifying withdrawal wire fields.
The local Relay key stayed server-side. Quote requests can create provider quote
records; no deposit-address mode, signature, transaction broadcast, account-mode
change or money movement occurred. No production database was queried.

`apps/api/src/fixtures/hip4/relay-core-observations-20261012.json` retains selected
wire fields, units and identity-equality results only. User addresses, balances,
request IDs, nonces, transaction calldata and keys are omitted. Tests reconstruct
synthetic aliases from these observations; they are not executable live quotes.

### Findings and implemented compatibility

- `userRole` returned `missing`, while `userAbstraction` returned `default`.
  This is an unregistered account observation, not proof of funded Standard-mode
  behavior. Generic `userFees` returned spot/perp rates but no outcome-specific
  fee fields. Do not derive an outcome fee from those generic rates or promote
  `default` to a confirmed cash mode. The earlier public token observations
  likewise do not prove executable outcome lots/minimums.
- All four Base USDC ↔ Core spot/perps routes returned HTTP 200 and passed the
  existing Relay response schema. Source/destination decimals are 6 ↔ 8. A
  10-USDC Base input quoted 8.778997 Core USDC, with a minimum of 8.603417;
  this is a dated quote, not a fixed fee or a $10 usable trading balance.
  Reverse quotes were available even without funded Core capacity. Quote
  availability must never authorize a debit or substitute for a credit receipt.
- Live nonce mapping uses domain `RelayNonceMapping`, version `2`, EIP-712
  domain chain `1`, and message `chainId: "hyperliquid"`. Do not synthesize that
  message field from the numeric Relay routing chain `1337`.
- The native transaction envelope is `action: { type: "sendAsset", parameters }`,
  not EVM calldata and not an already flattened SDK action. Its envelope nonce,
  parameter nonce and preceding authorization nonce agreed. Spot source uses
  `sourceDex: "spot"`; perps source uses `""`. Both use the actual native USDC
  token ID, with a human decimal amount `"10.000000"`, not raw `1000000000`.
  The observed authorization depositor and SendAsset destination are different
  concepts; do not invent an equality guard between them.
- The transport request type now allows explicit `protocolVersion: "v2"`.
  Existing callers do not acquire a new default. Six offline contract tests
  cover the four observed route shapes, raw/human amounts, SDK EIP-712 field
  compatibility, preservation of native payloads and unchanged legacy requests.
  They neither sign nor execute returned actions. Ordinary Relay runtime,
  fixture and Solana-rehearsal regression suites also pass.
- The pinned SDK's low-level signing helpers pass twenty independent ethers
  goldens. Its high-level `Info` name/asset lookup does not implement outcome
  discovery; adopting `Exchange.order(name)` unchanged is not a HIP adapter.

The live envelope is compared against the [Relay Core guide](https://docs.relay.link/references/api/api_guides/hyperliquid-support)
and the pinned [official SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/tree/2fdb18f9517675ea03695a0962bd19eece9c83f0).
Current responses take precedence over illustrative guide values for wire fields;
any later mismatch must be diagnosed, not silently signed with guessed values.

### Remaining work, without reopening P1

| Item                       | Evidence still needed / implementation boundary                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome precision/minimums | Formatting contract now pinned in section 18; native minimum boundary remains unobserved                                                                                 |
| Outcome fees               | Base formula and selected native settlement arithmetic verified in section 18; ordinary maker sells, rounding and builder execution are later financial acceptance cases |
| Funded account modes       | Funded unified wire snapshots captured in section 18; mode-aware owned-cash projection remains P2, portfolio-margin write support stays disabled                         |
| Core funding receipts      | Four actual route receipt fixtures verified in section 18; production operation attribution, ambiguous recovery and owned-cash projection remain P2/P3                   |
| Live signing/execution     | Separate explicit authorization for testnet signing/submission, with no implicit mainnet funding or permission change                                                    |

P2 can be designed from these concrete contracts, but no native finance route is
enabled by this patch. New P0 findings must not be used as an unrelated blocker
for the already verified internal read-only P1. Both branches stay `hip-next`,
with no commit, push, merge or deployment in this follow-up.

## 18. P0 contract audit and unsigned gateway check — October 12, 2026

### What the preflight actually proved

With separate user permission, eight unsigned requests were sent to QuickNode's
public `/preflight`, using public mainnet outcome 11566 and synthetic prices and
sizes only. No wallet, key, signature or `/exchange` request was used. The selected
responses are in `fixtures/hip4/preflight-observations-20261012.json` under API src.

| Case                                              | Gateway response                             |
| ------------------------------------------------- | -------------------------------------------- |
| 20 units at 0.5; either side                      | Valid; native asset IDs agree with Hunch     |
| 19 units at 0.5 ($9.50)                           | Valid, despite the guide's $10 minimum claim |
| 20.5 units at 0.5                                 | Invalid size; reported `szDecimals: 0`       |
| Price 0.50001 / 0.500001                          | Valid / invalid price                        |
| Price 0.00000001 / 0.000000001, each $10 notional | Both invalid price                           |

Every response reports `isSpot: false` and `estimatedFee: "0.04%"`. These cannot
establish native outcome fee/minimum rules. A successful gateway preflight is
neither an exchange acceptance nor a capacity check without an account.
The [gateway guide](https://www.quicknode.com/guides/hyperliquid/trade-hip-4-prediction-markets-on-hyperliquid)
and its actual validation disagree on the minimum. The request allowance was
exhausted at eight; no automatic retries or signed follow-up were performed.

The existing read mapper retains unknown metadata-supplied outcome precision
and disabled financial capabilities. No runtime dependency on this gateway was
added. Subsequent first-party source inspection and native fills below resolve
the formatting and base-fee questions independently of this gateway.

### First-party precision and fee evidence

`fixtures/hip4/official-ui-contract-20261012.json` records factual rules from the
public [official application asset](https://app.hyperliquid.xyz/assets/config-BCWVmVrl.js),
SHA-256 `0d91d8cf518444ca4be1b210666478f873cd8c1eab6bdd35a9e60aadf4255a51`.
The source was read as text, never executed, without cookies or an account.
The bundle itself is not copied into this repository. Minified function names
identify this exact dated source, not a stable API to import or call.

- `h3` uses integer executable size for `#` coins; `R3` uses five **decimal
  places**, not generic spot significant figures. `vce` uses five outcome-token
  raw-unit decimals. Quote USDC still uses its own metadata precision.
- `m8` selects the user's spot maker/taker rates for outcomes. `h8` applies the
  active referral discount to positive rates; the returned rates already include
  tier/staking. Reapplying the staking discount would understate fees.
- `_8` charges zero on opening. For closing, the combined multiplier is
  `feeScale * (deployerFeeScale + max(1, deployerFeeScale))`. Positive rates receive
  the referral discount; negative maker rates become zero, not rebates.
- If the quote is aligned, the taker protocol share receives the 20% discount,
  not the deployer share. The inspected mainnet aligned list was empty; neither
  that list nor fee multipliers should become permanent application constants.
- Do not copy the UI's missing-multiplier-to-zero fallback into a financial
  adapter. Missing terms mean unknown fees. This is a rate contract, not proof
  of rounded debit, builder fees, supported signing permissions or spendability.

The [native error reference](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses)
documents `MinTradeSpotNtl` at 10 quote units. It does not establish a HIP floor:
the fresh original-order sample below contains smaller native BUY orders.
Scale-order validation in the UI, partial fills and the unsigned gateway are
not substitutes for native boundary evidence. Existing P1 reads remain available
while this financial boundary is investigated.

### Native public fills and transfer evidence

With explicit permission for at most 20 requests and three public participants,
17 requests captured bounded fills/ledger, current fee rates and two official
settlements. `fixtures/hip4/public-account-observations-20261012.json` retains
selected examples, with wallet addresses, hashes and order/trade/client IDs
replaced consistently. No private Hunch account data or complete histories are
stored. Three requests remain unused; there is no automatic account scan.

| Observed case                                                                                       | Consequence for the later financial adapter                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Buy` fills charged zero; `Settlement` charged 0.14% or 0.12768% of payout in the selected accounts | Exact integer arithmetic matches the official UI formula using current spot rates, referral discount and observed fee/deployer scales of 1; do not use a universal fee |
| `Settlement` fills exist even when the non-funding ledger response is empty                         | Reconcile settlement through native fills plus official payout/balance evidence, not a ledger-only search                                                              |
| `Merge Outcome` produces two legs with the same hash/time but different coins and trade IDs         | Do not interpret the transformation as two independent sales or deduplicate only by hash                                                                               |
| One order has two fills of 6 and 7 shares, the same order/client ID, and different trade IDs        | Preserve both partial executions; neither one establishes the original order minimum                                                                                   |
| A `send` has nonzero `nativeTokenFee` but empty `feeToken`                                          | Preserve the unknown denomination; do not reject the record or invent USDC fees                                                                                        |

Opening, settlement and merge are observed; ordinary maker sells, fee rounding
boundaries and builder execution are not. The public transfers establish native
wire shapes, not a correlated Relay destination receipt or this user's funded
capacity. No signature, order, cancellation or transfer was sent.

### Fresh funded snapshots and original orders

The original sample's `recentTrades` seed subsequently returned HTTP 500 twice.
Its scrubbed addresses were not reconstructable, so no account follow-up was
attempted against guessed participants. The user separately authorized a new
sample of at most three public participants and twelve reads. One pass made
**11 requests**: metadata, recent trades, then mode, spot state and historical
orders for each participant. No signatures, private account, faucet or money
movement was involved. Account aliases are local to each fixture, not shared
between the old and new samples.

`fixtures/hip4/public-account-state-20261012.json` preserves selected original
fields from this second sample, collection time, response/selection counts and
the 2,000-history-row cap where reached. All three accounts were funded
`unifiedAccount`. The fixture is deliberately not a full portfolio/history.

- Native original BUY `origSz=22`, `limitPx=0.1539`, `reduceOnly=false` gives
  **$3.3858**, with an `open` historical event. A second original BUY is $4.812.
  This disproves using $10 as a universal HIP floor; it does not establish an
  exact $1 boundary or the currently resting/terminal state of those orders.
- One USDC snapshot reports total `29.9145116`, hold `6.446`, and available
  after maintenance `26.6915116`. Total minus hold is `23.4685116`, a third
  quantity. Do not substitute risk capacity for owned unheld cash. Another
  snapshot has maintenance capacity equal to total despite nonzero hold.
- One client ID occurs on three different native order IDs with different
  timestamps/prices. Preserve native order identities and replacement lineage;
  client ID alone cannot deduplicate all executions.
- The bounded capture selected one event per native order and can retain an
  earlier `open` event. Tests and fixture coverage explicitly disallow treating
  it as current open orders or complete terminal history. A future collector
  must retain distinct `(oid, statusTimestamp, status)` events before reducing
  to latest state; provider truncation must remain explicit.

The pure historical-order parser preserves status time, `origSz` versus remaining
`sz`, native identity and nullable client ID. It does not implement a state
reducer, minimum-order gate or spendable-cash projection. Tests distinguish
actual original-order evidence from partial-fill notional and synthetic examples.

A further 14-read public sample across ten participants found an original
non-reduce-only BUY of **2 shares at 0.57541 ($1.15082)**, with both its `open`
and `filled` events. `fixtures/hip4/original-order-minimum-20261012.json`
retains distinct status events, original size and remaining size; an IOC liquidity
rejection is not relabelled a minimum rejection. No `minTradeNtlRejected` appeared
in that capped sample. A nine-read follow-up using a different recent-trade seed
and seven participants also found no minimum rejection. These are selected,
possibly overlapping samples, not a proof that sub-$1 orders are allowed or
that $1 is the exact current floor. No frontend minimum or backend admission
constant is inferred from the smallest observed order.

`fixtures/hip4/explorer-order-observations-20261012.json` additionally preserves
two original single-order actions from the official public explorer: a BUY of
100 at 0.01 ($1 limit input), and an IOC SELL of 40 at 0.00023 ($0.0092 limit
floor). Their top-level `error` is null, but the response has no per-order
execution result. Neither proves exact admission at $1 or below; the sell can
execute at bids above its limit floor. Tests preserve this distinction and native
asset identities. This evidence narrows the next test, not the minimum constant.

### Correlated completed Relay receipts

`fixtures/hip4/relay-receipts-20261012.json` contains four actual completed public
routes, captured by 22 read-only calls to Relay Requests v3/status, native
`userNonFundingLedgerUpdates`/`spotMeta`, and Base JSON-RPC. This is separate
from the earlier hypothetical quotes. Wallets, hashes and nonces are consistent
aliases within this fixture; public token identities and exact amounts remain.
No signatures, quote submissions, transactions or account changes were made.

| Observed route    | Origin USDC | Destination USDC | Native source/destination DEX |
| ----------------- | ----------: | ---------------: | ----------------------------- |
| Base → Core spot  |      41.952 |        41.923828 | empty → `spot`                |
| Base → Core perps |       14.07 |        14.048591 | empty → empty                 |
| Core spot → Base  |   97.347106 |        97.306611 | `spot` → empty                |
| Core perps → Base |    9.962411 |         9.939005 | empty → empty                 |

For every route, the original native `sendAsset` action matches **one** ledger
record by exact transaction hash, sender, destination, nonce, token, source and
destination DEX, and decimal amount. The amount independently equals Relay's
actual native-side raw amount at eight decimals. The perps route alias remains
the 16-byte zero currency ID; the native action still names the canonical USDC
token. Neither is an EVM address or an interchangeable spot-route identifier.

The Base leg matches the expected owner and exact USDC contract/Transfer topic,
raw amount at six decimals, successful receipt, canonical block hash and a block
height at or below the separately read finalized head. Both Relay status hash
lists are checked with their direction (`inTxHashes` source, `txHashes`
destination). `failReason: "N/A"` does not contradict successful execution.
The first recent sample was not yet Base-finalized; it was not promoted as
finalized evidence. The retained sample deliberately uses older completed
transfers, including the most recent matching spot deposit five days earlier.

The fixture acceptance oracle in `hip4-route-contract-tests.ts` recomputes these
relationships from preserved fields, rather than trusting recorded check booleans.
Counterexamples cover wrong owner/token/amount/nonce/hash/DEX, ambiguous duplicate
ledger records, duplicate/removed Base logs, reverted receipts, non-canonical or
unfinalized blocks, wrong precision and reversed status references. This is a P0
contract oracle, **not** a production funding confirmer or recovery worker.

All four observed native transfers have zero native transfer fees. Do not
extrapolate their amount equality to unknown nonzero-fee cases or count a
correlated transfer as proof of current owned/spendable cash. P2/P3 must still
bind trusted operation/environment/owner context, support recovery, preserve
fees with unknown denomination, and prevent repeated credit. No nearest-time
transaction match or provider `success` shortcut is permitted.

### Account and ledger wire contracts

The broader Polygon/Solana route follow-up below supplements the initial Base
sample; no financial runtime is enabled by any of these evidence collectors.

`services/hip4-account-contract.ts` adds pure, sidecar-safe parsers, exercised by
`hip4-account-contract-tests.ts`. They do not fetch accounts, grant ownership,
compute spendable cash, confirm a receipt, or enable a financial path. Synthetic
`fixtures/hip4/account-contracts.json` is explicitly separate from the actual
unregistered-account observation in section 17.

- Roles preserve agent `data.user` and subaccount `data.master` separately.
  The five documented abstraction values are retained, including legacy
  `dexAbstraction`; `default` is not renamed Standard.
- Spot observations preserve ordinary token-index balances, outcome `+N`/`oN`
  rows without an ordinary token index, escrow, borrowing, and risk-capacity
  fields. Large and signed balances remain decimal strings. Escrow and
  available-after-maintenance are not added to cash or mistaken for permission
  to borrow. An `oN` row does not itself prove a cash payout.
- Ledger parsing distinguishes `send`, `spotTransfer`, `internalTransfer`,
  account-class transfer, deposit and withdraw. Human amounts, source/destination
  DEX, fee fields and nullable legacy nonce remain intact. Unknown event kinds
  remain observable as unsupported; malformed known kinds fail parsing and can
  recover immediately with a complete observation, without a cooldown.
- Fill parsing preserves decimal amounts, native `Settlement` / `Merge Outcome`
  directions, both coin/trade identity and nullable client/TWAP IDs. Unknown future
  directions stay observable; parsing alone never classifies an economic sale.
- Empty fee denomination is accepted as actually observed, even with a nonzero
  native-token fee. It remains unknown rather than becoming a fabricated zero.
- Author review reproduced a schema-union fallback accepting malformed known
  fields on outcome balances (`token: -1`, string token index, numeric `spotHold`,
  negative borrowed amount). One shared balance schema now validates supplied
  fields before allowing the outcome-only absence of a token index. Negative
  cases reject and a corrected observation immediately recovers; genuine tokenless
  outcome rows and unknown extra fields remain readable.

The [official info reference](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
defines roles/modes; the [account-mode guide](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes)
explains why unified/portfolio balances belong to the spot view. Extended wire
fields are cross-checked against the pinned [nktkas SDK source](https://github.com/nktkas/hyperliquid/tree/db80d598f6e4672edc090fe69994ecec97ebc980/src/api/info/_methods),
not presented as live receipt observations. Selected fills/ledger shapes are now
also checked against the sanitized native samples above. The official mode enum additionally
contains `dexAbstraction`, absent from that SDK revision; the parser follows
the official reference instead of copying that omission.

Parsing is not receipt confirmation. The real route fixtures above establish
the selected transfer contracts, not a runtime confirmer. P2/P3 still must bind
the trusted query's owner/environment, resolve a ledger token symbol using exact
native metadata, and correlate the specific action/hash and route. `fee` and
`nativeTokenFee` are not assumed additive; nonzero/unknown transfer-fee treatment
needs explicit evidence before that case can be credited automatically. Source
SendAsset fields and destination receipt fields are distinct. The synthetic
fixtures deliberately do not invent credited-net-amount semantics.

### Polygon and Solana bidirectional evidence

An additional user-authorized read-only pass made 70 bounded requests, followed
by four narrowly scoped receipt-version diagnostic reads. The sanitized results
are `fixtures/hip4/relay-multichain-observations-20261012.json` and
`fixtures/hip4/relay-solana-version-observations-20261012.json`.

| External asset      | Core spot, both directions | Core perps, both directions                 |
| ------------------- | -------------------------- | ------------------------------------------- |
| Polygon native USDC | Quote + completed receipt  | Quote + completed receipt                   |
| Polygon pUSD        | Quote + completed receipt  | Quote + completed receipt                   |
| Solana USDC         | Quote + completed receipt  | Quote + completed receipt after v1 RPC read |

All twelve hypothetical 10-unit EXACT_INPUT quotes returned HTTP 200 and passed
the existing Relay response schema. Selected successful public transfers were
queried over a bounded 30-day window, at most three history rows per route, with
one matching transfer independently inspected per route. Polygon USDC and pUSD
remain distinct exact contracts; Solana USDC uses its canonical mint. Six-place
external raw amounts must not be mistaken for eight-place Core quote units.
Core spot/perps currency IDs and native DEX fields remain distinct.

Each native leg was correlated by exact transaction hash to one ledger update,
owner, nonce, token, DEX and amount. Polygon legs matched successful canonical
finalized receipts and exact-owner ERC-20 logs for the selected token/amount.
Solana legs matched the exact finalized signature and owner/mint-specific raw
pre/post token balance delta; provider `success` alone was not accepted.
The fixtures retain selected fields and capture diagnostics, not the complete
RPC payload; offline tests recompute retained unit/DEX/amount relationships.
These tests supplement, not replace, the fuller Base receipt acceptance oracle.

One Solana → Core perps transfer initially returned RPC `-32015`: its native
transaction version was **1**, unsupported by `maxSupportedTransactionVersion: 0`.
A separate read of that exact public transfer with version 1 returned a finalized
successful receipt and the exact `120140486` raw USDC debit. Both failure and
recovery are retained. An unsupported-version response is missing evidence, not
a zero transfer or a failed funding operation. Later P3 receipt adapters must
cover observed transaction versions with parser/SDK tests; this diagnostic does
not silently widen existing Solana signing, decoding or broadcast capabilities.

Quotes used public sample identities and were never signed or submitted. No
user wallet, Telegram, account permissions or production policy were touched.
These are provider-route and historical-receipt observations, not an end-to-end
Hunch funding test or proof of this user's signer eligibility/current cash.
For Polymarket Deposit Wallet sources the separate supported exact pUSD return
to the controller is still required; Relay route availability does not bypass
the wallet's factory-only execution or the relayer allowlist.

### Protected main-page read integration

The web home now composes the existing admin-only HIP read API into All Markets:
native desktop table rows and mobile market-card primitives, venue filter/URL
state, live prices and details with recorded chart/trades. The source remains
bounded, allowlisted and visibly unranked; absent metrics stay unavailable.
Ordinary public backend discovery still excludes HIP. No public capability,
trading, Copy, funding or production policy is enabled by this frontend change.
Global discovery ranking/search and native event routes remain later P5 work;
P7 activation requires separate authorization. Frontend acceptance is recorded
in its paired integration document.

### Acceptance boundary

P1 remains accepted. Formatting and base-fee rules now have pinned first-party
evidence, selected fee arithmetic is checked against native fills, and funded
unified account/order shapes have actual public observations. All four Base/Core
routes plus twelve Polygon USDC/pUSD and Solana USDC/Core routes have correlated
historical receipt evidence, including the observed Solana v1 recovery. P0 is
not yet fully closed: the exact native minimum boundary remains outstanding.
Implementing owned-cash projection is P2, not an extra P1 gate;
unsupported portfolio-margin writes remain off. Native signing/receipt experiments
require suitable separate permission; additional gateway preflights would not settle this.
No P2 worker, financial endpoint, migration or public DTO changed in this audit.

The expanded HIP suite passes **83/83** tests. Full backend workspace build,
typecheck and lint pass **47/47** tasks after the account-parser review. Both updated
documents pass scoped Markdown lint/format checks. No SQL changed in this audit;
the preceding PG16 acceptance is not replaced by a TypeScript-only assertion.

Before any proposed testnet experiment, note the [official faucet requirement](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet):
the same address must previously have deposited on mainnet. A fresh throwaway
wallet is not a proven free-funding path. No faucet claim, test order or real
deposit was made; do not create a mainnet deposit to work around this requirement.

### 24-hour volume in the home feed

The indexer uses `spotMetaAndAssetCtxs` instead of `spotMeta`, retaining the
metadata pair's 40-unit request weight. Contexts are matched by exact coin;
outcome contexts are not positionally aligned with the spot universe. `volume24h`
contains the primary outcome (side 0) `dayNtlVlm`, its coin, source, observation
time and expiry. The legacy lifetime `volumeUsd` remains null; OI is unavailable.

The public observation `volume-observations-20261012.json` retains complementary
YES/NO trades with the same time/size but different trade IDs. Their notionals
are $24.30617 and $6.69383 for 31 shares. We show $24.30617, matching the official
outcome-list convention and our primary-side trade ledger; summing mirrored
shares or adding both books would change the metric. This is quote turnover,
not lifetime volume or the full collateral represented by complementary books.

`hip4_read.volumeMaxAgeMs` defaults to 300000. Failed/missing/ambiguous context
refreshes retain the last good observation without extending its freshness.
Atomic persistence merges volume and last-attempt timestamps separately from
metadata/books, so an older REST or WS snapshot cannot regress volume. A later
good refresh recovers normally; a reported zero is valid, absence is not zero.

The native home volume column and mobile card explicitly label the value `24h`.
Volume filters use that same displayed metric. Volume alone does not enable
public discovery or invent volume-based global rankings. The subsequent catalog
change below replaces the local four-outcome selection.

Verification for this change: 88 HIP tests and both HIP integration suites on
an isolated PostgreSQL 16 schema passed, including stale volume, failed refresh,
recovery and REST/WS snapshot races. Full workspace build/typecheck/lint passed
47/47 tasks. The local live indexer/API and signed-in desktop/mobile home showed
the observed $24.31 value with a 24h label; absent settled-market contexts stayed
unknown. Frontend typecheck/lint, 1674 tests, generated-contract agreement and
the exact Node 20 Turbopack build passed. No production policy was changed.

### Full read-only catalog and native labels (October 12 follow-up)

`hip4_read.catalogMode` supports `allowlist` (backward-compatible default) and
`all`. In `all` mode the metadata response determines the catalog, not the old
four-outcome sample. `catalogBatchSize` (default 500) bounds local writes per
cycle, not total catalog size. Rotation eventually covers larger catalogs.
Depth, trade repair and live subscriptions retain their separate policy budgets;
metadata and 24h context ingestion still use only the two bulk requests.

Admin authorization and environment checks remain mandatory. List requests use
the existing environment/outcome index and bounded cursor pages. SSE checks that
requested identities exist in the indexed catalog before cache access or hot
demand. Disabling the feature or restoring `allowlist` remains reversible.

Cold rows can show exact-coin `midPx` from the bulk contexts as explicitly
indicative prices with observation expiry. They are not executable quotes,
official results, or synthetic books; null midpoints remain unavailable.
Native template fields map to readable competition/season, participant, award,
policy-decision and IPO titles. Unknown templates use a readable identifier,
never the serialized contract description. Full terms remain in detail.

Local validation discovered 321 current provider outcomes (324 stored including
three historical settled rows). Only local `hip4_local` enables `catalogMode: all`;
production policy is unchanged. Synthetic PG16 coverage checks 120 outcomes,
first/next/empty pages, continuation, exact SSE identities and bounded provider
work. SQL plans also cover the unfiltered catalog using the existing index.
The home feed pages remain provider-ordered; global ranking/search and financial
capabilities are not implied by catalog coverage.

Verification: 91 HIP tests, all four PG16 suites and full workspace
build/typecheck/lint (47/47) passed. The live catalog contains no serialized
field strings in event/market headings. Desktop first/next pages and 390px mobile
cards/details were inspected through the real local session, including recorded
trades/chart and 24h volume. The disposable database was removed after testing;
the local indexer/API remain running. No production or trading action occurred.

### Event-scoped read pages (October 12 follow-up)

The protected HIP list accepts an optional canonical `eventId`, preserving the
same environment, policy revision, allowlist and bounded outcome cursor checks.
Wrong-environment event IDs are rejected before repository access. Frontend event
pages use this filter plus the existing exact-market detail endpoint; no public
event or trading API is implicitly enabled.

The event query starts from the existing unified-market event index and uses a
cardinality-one lateral lookup by canonical market ID. A normal ordered join was
rejected after EXPLAIN showed a sparse event scanning nearly the full HIP catalog.
The final PostgreSQL 16 forced-generic plans, with 20,000 unrelated event markets,
perform three indexed read-model lookups and 12 shared-buffer hits on first,
resumed and empty-tail pages (observed 0.074/0.061/0.037 ms). The inner LIMIT 1
expresses unique market identity, not a product or paging limit. No migration is
required. Existing retention and read-only authorization remain unchanged.

Verification: 92 non-DB HIP tests, the event/catalog integration suite and SQL
plan suite passed against disposable PostgreSQL 16; full workspace build passed
16/16. Both native frontend surfaces were checked with live prices/history and
all eight trading presentation combinations. Final Buy/Sell only shows unavailable;
financial preparation, signing and execution remain absent. This is event/read UI
completion, not a claim that financial P2 is implemented. No production changes.
