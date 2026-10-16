# Hyperliquid HIP-4 integration: backend development specification

## Status, scope, and evidence

This is the backend source-of-truth specification for `hip-next`, updated and
rechecked on 2026-10-16. It records implementation and remaining phased work.
Technical acceptance does not enable financial capabilities or certify
production activation. The current P4S/P5/P6 implementation candidate and local
manual-test boundaries are recorded in section 86; older phase checkpoints are
dated evidence, not the current outstanding-work list.

**Current acceptance:** P3/P4, P4S, P5 and the bounded P6 capability are
technically accepted for the user's scoped manual tests; the current fresh
whole-scope GO count is **2/2**. A disputed tracked fill now
requires an exact source recheck before reuse. Local working-database upgrade,
mounted live reads and authenticated Funding receive-catalog acceptance passed,
separately from disposable PG16 and synthetic browser checks. Funding/Social
were explicitly enabled only in the isolated local stand; automatic execution
remains off. This is not live financial E2E or production activation.

Start with section 12 for evidence gates, section 11 for implementation order,
then the owned domain section and companion client contract. Section 13 records
the implemented P0 read-contract foundation and passive P1 canary. Financial
capabilities remain off and require their listed proof. Sections 16–18 record
P1 acceptance and earlier P0 evidence. Section 19 supersedes their unresolved
BUY-minimum status with the official $1 rule and correlated native execution;
earlier acceptance notes and fixtures remain dated history.
Section 20 records the initial P2 owned-account read implementation on October 13.
Section 21 supersedes its intermediate outstanding-work lists for the current
P2 read integration. Older checkpoints and baseline refs below are dated history.
Section 22 records the historical paused P3/P4 checkpoint. Section 23 records
resumed work and the latest main merges; neither is financial release acceptance.

P3/P4 implementation and acceptance: sections 73–85. **P3/P4 technical
implementation is accepted, with two consecutive fresh, no-history whole-scope
GO reviews (2/2).** Section 85 supersedes earlier dated open-work lists and
review counters; scoped corrections alone were not counted.

The October 15 pause was explicitly lifted. At the P3/P4 checkpoint, backend
`origin/main` at `5ac117fb` was merged as `b2328f8d`. The user subsequently
authorized an intermediate checkpoint commit/push and, after final acceptance,
explicitly requested committing/pushing the accepted snapshot to all `hip-next`
branches. Neither request authorizes merge, deployment, permissions changes or
financial activation. Native funding uses the
existing common catalog, worker and receipt/recovery owners; trading uses the
ordinary Hunch Confirmation, Orders and portfolio surfaces. Financial defaults
remain off. Section 86 records subsequent synchronization and local activation.

| Current slice        | Accepted implementation                                                                                                                                      | Explicit limits / next phase                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared funding       | Native adapters, common catalog/admin controls, joint receive/refund recovery, class-separated cash, frozen lineage, holds and merge-safe reads              | Outbound native source requires current zero-fee capability; unknown sends retain holds; historical accounting cost remains linear           |
| Native order engine  | Frozen sign-only preparations, one-shot submission, cancellation, common consumer/order reads, bounded Check and hot/cold observation repair                 | Provider absence, expiry and cancellation ACK are not proof of non-execution                                                                 |
| HTTP/client contract | Auth/CSRF, generated DTOs, exact sizing, shared readiness/shortfall, Confirmation receipts, portfolio SELL/cancel, immediate consent revocation and recovery | Layered offline browser and real-PG acceptance passed; full production-mounted Review and live funded E2E were not executed                  |
| Telegram             | Native Buy/Sell/custom input, immutable Review, sealed direct/funded handoff into the same app consumer; bounded factual Check                               | Product app handoff only; no autonomous HIP execution or personal Telegram operation                                                         |
| Release              | Cross-workspace tests/builds/lint/contracts, disposable PG16 migrations/recovery/plans, two independent P3/P4 whole-scope GO reviews                         | Current P4S/P5/P6 acceptance is in section 86; P7, production load and separately authorized financial activation/deployment remain separate |

| Repository                      | Branch / immutable reference                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Original backend plan baseline  | `a430729ed5ac028b8124198b4dec758221dbb0fc`                                               |
| Original frontend plan baseline | `044163ba060620512ceb8ba2affd2b9cd5a00b92`                                               |
| Old backend prototype           | `hip`: `dce2d7cd`, June 2026                                                             |
| Old frontend prototype          | `hip`: `d29c056d`, June 2026                                                             |
| Earlier synchronization         | Backend merge `7b3ed928`; frontend merge `537910fb`; latest backend merge recorded above |

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

Current financial-plan decision: ordinary HIP BUY minimum is **1 USDC ($1),
inclusive**, excluding fees. The server-owned `hip4_trading` runtime policy now
defaults to `minimumBuyNotionalUsd: "1.00"` and is exposed in the existing admin
policy editor. It also owns `cancelSignatureTtlMs: 60000`; cancellation validates
its own authorization fields, not the unrelated BUY threshold. This is not
financial activation or a change to `hip4_read`.
Whole-contract rounding can make the smallest purchase
larger than $1. Do not apply this BUY floor to all SELL/close operations. Sections
2, 11 and 19 define calculation, policy and acceptance requirements.

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

User clarification, October 14: the prohibition on touching Telegram refers to
the user's personal account, chats, messages and settings. Repository changes
for **app handoff only** are authorized and required: use the existing Limitless
handoff pattern, with review, confirmation and signing in Hunch. This is part of
P4 acceptance, not an optional automation feature or a reason to postpone the
interactive entry path to P5. Tests must not operate the user's Telegram account.

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
five-share or marketable-buy minimum, Limitless fee math, or the generic spot
10-quote-unit floor. The [official outcome announcement](https://t.me/hyperliquid_api/366)
reduced the normal outcome-order minimum to **1 USDC**. Section 19 corroborates
an original 100-contract BUY at 0.01 with its filled order and exact native fill;
this is not an inference from the smallest partial fill or top-level success.

For ordinary BUY, require final normalized gross order notional of at least
`max(protocolMinimumBuyNotional, effectivePolicy.minimumBuyNotionalUsd)`;
the initial values are both `"1.00"` USDC. Fees, gas and funding costs do not
count toward it. Validate the actual signed order after lot/tick normalization,
not the requested budget or a displayed midpoint. For a limit BUY at price `p`,
the minimum whole-contract quantity is `ceil(effectiveMinimum / p)` using exact
decimal arithmetic. Thus 0.50 needs 2 contracts ($1), 0.415 needs 3 ($1.245), and
0.01 needs 100 ($1). Show that minimum as advice; never increase the user's
budget or order silently. An IOC's final limit/size and bounded debit come from
the executable server quote; do not require every later partial fill or resting
remainder to independently reach $1.

SELL is a separate capability, not the BUY guard with the side flipped. A native
full close below $1 executed with `reduceOnly=false` (section 19); that flag alone
cannot classify close eligibility. Use verified owned quantity, current book,
normalized order and provider result. Do not invent a blanket `$1` SELL floor,
promise all sub-$1 sells will be accepted, or misclassify a minimum rejection as
insufficient funds. Exact negative-boundary and close-exemption cases belong in
P4 admission/recovery tests; they do not block P2 account projection.

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

For outcomes, zero opening **base** fee does not guarantee a zero-cost BUY:
an authorized builder fee can apply on opening, and funding is separate. The
closing rate uses current user spot maker/taker terms, referral discount and
market scales; tier/staking is already reflected in the user rates. Clamp
negative outcome maker rates to zero, not rebates. Section 19 records maker,
taker and settlement evidence and the remaining rounding limitation.
`WsFill.fee` already includes `builderFee`; retain the breakdown without adding
the builder amount twice. Realized accounting uses observed native fees, not
recomputed estimates. A one-atom rounding discrepancy in historical evidence is
not permission to relax a user's maximum debit or silently increase a signed cap.

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
`market-buy-suggestion.ts` now includes a native USDC8 adapter (section 51);
the six-decimal Polymarket/Limitless paths remain unchanged. Market Max uses the
same ordinary Confirmation refinement. Limit-order budget helpers and full
route/browser acceptance remain open; a draft estimate is not verified capacity.

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
expiry, depth/staleness and exact validation reason. Include the effective
financial policy revision, protocol and product BUY minimums, their quote-token
units, effective minimum, integer lot, price tick and price-dependent minimum
quantity. Unknown SELL exemptions remain explicit; no fabricated numeric SELL
floor. Prepare revalidates current terms before immutable admission; policy
changes do not mutate or resubmit an already admitted uncertain action.
Prepare binds signer/owner,
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

As of the October 14 clarification, both backend v2 venue lists and the frontend
`trade-handoff-v2.ts` parser still accept only Polymarket/Limitless. The existing
ordinary market-link encoding can carry canonical HIP event/market IDs, but that
navigation capability is **not** a completed sealed trade handoff. Extend the
existing issuer, sealed contract, browser consumer and durable submission claim
together with P4; do not add HIP to an allowlist before its consumer exists.

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

P4 handoff acceptance must cover direct and funded buys, supported sells, exact
environment/market generation/outcome/amount transfer, fresh app review and user
signature, wrong-account/expired-plan rejection with a usable fresh-review path,
duplicate launch and lost-response recovery without a second order, and explicit
unavailability while the shared venue capability is disabled. Reuse existing
Mini App and external-browser entrypoints and trade presentation. No Telegram
trading automation, independent funding path or new design is required.

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

| Phase | Deliverable                                                  | Exit evidence                                                                                                                     |
| ----- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Read-only protocol fixtures and capability decisions         | Mainnet/testnet differences, exact token units, mode/fee/minimum contracts, Relay routes and receipt fields verified              |
| P1    | Public indexer/read contracts                                | Isolated canary; stable identities; correct trades/metrics; terminal lifecycle; bounded performance                               |
| P2    | Owned account and ledger projection                          | Mode-aware available cash; zero/partial snapshots; settlement and PnL; no duplicate value                                         |
| P3    | Durable Core funding/withdrawals                             | Both directions, both signatures, exact debit/credit, cancel/unknown recovery; no manual dead end                                 |
| P4    | Interactive trade adapter, server submission and app handoff | Direct/funded GTC/IOC/ALO supported subset, fees, nonce/cloid concurrency, fills/cancel/settlement; existing Telegram-to-app flow |
| P4S   | Verified theses and attributed Copy                          | Exact purchase/dual aliases, source retained before submit, direct/funded recovery, lifecycle and social read-model tests         |
| P5    | Complete public-surface parity                               | Three device contexts and public navigation; P4 interactive handoff retained, autonomous HIP remains excluded                     |
| P6    | Matching, tracked-wallet intelligence and signal delivery    | Rule-equivalence fixtures, bounded coverage/budgets, truthful holder limitations and web CTA                                      |
| P7    | Gradual activation                                           | Full build/tests, migration compatibility, exit-only recovery and observed canary before production exposure                      |

P0 read-only evidence cannot demonstrate actual signing/submission recovery.
Use deterministic local/provider-response fixtures plus authorized testnet execution
only in a later approved test phase. Real-money production orders are not implicit
in this document. Do not require perfect global historical coverage to release
working bounded features; block only a concretely unsafe financial path.

### Required fixture/test matrix

| Category         | Cases that must be exercised                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata         | Legacy/new templates; standalone/no question; question fallback; fractional settlement; recurring rollover; unknown quote token                           |
| Identity         | Mainnet/testnet collisions; coin `#` vs token `+`; account case; raw provider currency vs ERC20; same timestamp different trades                          |
| Market data      | Fresh/stale/empty/error book; depth shortage; WS gap/replay; candle history limit; absent metrics not zero                                                |
| Amounts          | $0.99/$1 BUY; one raw unit below; whole lots and five price decimal places; $0.333 full SELL close; 6↔8 conversions; fee-inclusive cap; no input increase |
| Account modes    | Standard spot/perp; unified; portfolio-margin unsupported capacity; no automatic mode change; open-order holds; concurrent transfers                      |
| Funding          | Every activated source/destination family; no route; wrong currency/DEX/owner; provider expiry; partial composite funding; source fee/gas                 |
| Core signatures  | Nonce mapping then SendAsset; rejection/close at each stage; inconsistent domains; foreign payload; lease expiry; late signature                          |
| Trade recovery   | Duplicate tabs/processes; accepted response lost; definitive nested reject; unknown order; same nonce/cloid replay; direct and funded paths               |
| Orders/fills     | IOC no fill/partial/full; GTC resting/partial/cancel; fill/cancel race; dual records; one hash multiple tids; reward dedup                                |
| Settlement/PnL   | Automatic payout credit; fractional payouts; complete-zero position; partial snapshot; historical gaps; transfers not profit; fees not doubled            |
| Receive/withdraw | First account activation; destination credit lag; ingress paid then downstream failed; wrong/multiple/late receipt; no second payment                     |
| Telegram         | Exact user/TG/account scope; expiry; launch duplicates; review without consent; MiniApp closes after signing; no HIP autonomous profile                   |
| Matching/intel   | Same topic different oracle/time; side inversion; new recurrence; no public holder source; partial-history qualification; budget skip                     |
| Operations       | Exit-only repair; stale jobs; restart/missing report; bounded polling; token/membership generations; retention protects user history                      |
| Existing venues  | All existing EVM/Safe/Deposit Wallet/Solana funding and Polymarket/Limitless trading paths unchanged; Kalshi exit-only preserved                          |

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

The agreed ordinary HIP BUY product default is `minimumBuyNotionalUsd: "1.00"`,
represented as an exact decimal string in the future financial policy
owner. Validate positive finite decimal values and resolve one effective policy
revision server-side. A product override can raise the threshold, but cannot
lower the protocol floor; return the effective maximum in the quote. Keep the
protocol rule and its dated provenance separate from the product setting.
Do not add a financial threshold to the read-indexer policy `hip4_read` or a
second client constant. Desktop/mobile, amount advice, Copy, prepare and admin
validation must share that one resolved contract.

Apply this to ordinary BUY and enabled Copy purchases, not deposits/withdrawals,
SELL/close, or partial-fill reconciliation. Social publication still uses the
existing `social` policy (initial $10 executed notional); a valid $1 purchase
does not automatically qualify as a published thesis. No policy override means
the validated default, not an error. Failed policy resolution or an invalid
active revision must produce a recoverable quote/configuration error, not a
silent fallback; reads and reconciliation of existing attempts remain available.

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

1. Revalidate current mainnet outcome metadata and the section 19 ordinary $1
   BUY / integer-lot contract at implementation. Exercise normalization, negative
   boundary and close exceptions in P4; prove the selected fee/builder capability
   and zero/one/fractional settlement handling before enabling the affected writes.
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

| Phase / evidence                         | Current status                                                                                                                  | Concrete next step                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P0 read contract                         | Implemented and tested, including date-only expiry                                                                              | Retain dated fixtures and unknown precision explicitly                                                                                    |
| P0 offline signing                       | Twenty independently checked SDK goldens                                                                                        | Reuse these as the oracle for the later production adapter; execution/error recovery remains a separate P3/P4 obligation                  |
| P0 executable precision/minimum and fees | Section 19 supersedes the initial gap: documented $1 BUY and correlated execution, integer lots, maker/taker/settlement samples | Implement policy-owned minimum; P4 must test negative/close boundaries, fee debit caps and optional builder execution                     |
| P0 account mode / routes / receipt       | Funded unified snapshots and all four exact Relay/native/Base receipt correlations captured in sections 17–18                   | Preserve cash/hold/risk capacity separately; owned-cash projection is P2, production credit attribution and recovery are P3/P4            |
| P1 read-only runtime                     | Local acceptance complete, including exact build                                                                                | Keep the canary internal; public activation/deploy remains a separate decision                                                            |
| P2–P7                                    | Not implemented by this patch                                                                                                   | Begin owned-account/ledger projection only after its P0 contracts are settled; subsequent writes and activation need their own acceptance |

P1's internal read-only acceptance is complete. Section 19 closes the ordinary
BUY-minimum evidence gap, not financial execution acceptance. Trade/Copy/funding
capabilities remain false. No additional
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

| Item                       | Evidence still needed / implementation boundary                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome precision/minimums | Section 19: $1 ordinary BUY and whole lots established; P4 tests negative boundary, normalized IOC admission and sub-$1 closing behavior               |
| Outcome fees               | Section 19 adds ordinary maker/taker evidence; exact rounding and nonzero builder execution remain scoped P4 acceptance, not P2 blockers               |
| Funded account modes       | Funded unified wire snapshots captured in section 18; mode-aware owned-cash projection remains P2, portfolio-margin write support stays disabled       |
| Core funding receipts      | Four actual route receipt fixtures verified in section 18; production operation attribution, ambiguous recovery and owned-cash projection remain P2/P3 |
| Live signing/execution     | Separate explicit authorization for testnet signing/submission, with no implicit mainnet funding or permission change                                  |

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

In this initial sample, opening, settlement and merge are observed; ordinary
maker sells, fee rounding boundaries and builder execution are not. Section 19
adds maker/taker evidence and preserves an observed rounding counterexample.
The public transfers establish native
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
asset identities. That initial capture alone does not establish the minimum;
section 19 adds the official announcement and exact order/fill corroboration.

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
historical receipt evidence, including the observed Solana v1 recovery. At this
earlier checkpoint the native minimum was unresolved; section 19 supersedes that
gap with the documented $1 ordinary BUY and correlated execution. Negative
boundary/close exceptions, exact fee caps and optional builder execution remain
targeted financial implementation tests, not reasons to reopen read-only P1.
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

## 19. Agreed $1 BUY minimum and fee evidence — October 12, 2026

This follow-up supersedes earlier statements that the ordinary HIP minimum is
unknown. It updates the financial plan, not a deployed policy or trading runtime.
No signature, order, cancellation, transfer, permission or production change was
performed. Historical fixtures retain their original observation scope; they are
not retroactively relabelled as stronger evidence.

### Minimum and precision decision

The [official API announcement of September 4](https://t.me/hyperliquid_api/366)
announced a reduction of outcome minimum order notional from $10 to $1. Public
mainnet history now corroborates an original BUY at that exact amount:

| Evidence                                               | Correlated native facts                                                                                                      | Interpretation                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| BUY, block `1176569440`, October 8 at `18:44:53.898Z`  | Coin `#99991`, asset `100099991`, GTC BUY, price `0.01`, original size `100`, `reduceOnly=false`, filled size `100`, fee `0` | Original $1 order and its execution agree, not a $1 fragment of a larger order                                                |
| SELL, block `1176569527`, October 8 at `18:45:00.397Z` | Same coin, IOC SELL, size/start position `100`, limit `0.00304`, executed at `0.00333`, `reduceOnly=false`                   | Full close produced `$0.333` gross, fee `0.00044755`, net `0.33255245`; blanket $1 SELL validation would reject a valid close |

The checks matched transaction/fill hash, asset/coin, direction, original size,
time and order history identity. Top-level explorer success alone was not used.
No controlled negative `0.99999` order was sent, and the universal eligibility
predicate for every sub-$1 close is not proved. Do not invent it from one case.

Use the pinned official-UI precision evidence in section 18: whole executable
contracts, price tick `0.00001` USDC, five outcome-token raw decimals and eight
USDC raw decimals. Raw balance decimals do not permit fractional order lots;
price tick does not prove that endpoint prices zero/one are executable. The
policy/quote calculation is defined once in sections 2 and 11, not in a UI preset.

### Fee contract and limitations

Primary references are the [fees specification](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees),
[HIP-4 deployer actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-4-deployer-actions),
[builder units](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes)
and [native fill schema](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions).
The dated official UI source and its SHA-256 are pinned in section 18.

- Opening base fee is zero; authorized builder and funding costs are separate.
- Closing uses user spot maker/taker rates, already tier/staking-adjusted,
  positive-rate referral discount, and
  `feeScale * (deployerFeeScale + max(1, deployerFeeScale))`. Negative maker rates
  clamp to zero. An aligned quote discounts only the taker protocol share, not
  the deployer share; check current metadata instead of assuming alignment.
- With both scales equal to 1, tier-zero rates and no discounts, the examples
  are maker SELL **0.08%**, taker SELL **0.14%**, and observed settlement **0.14%**
  of gross payout, not profit. These are conditional examples, not policy defaults.
- Missing deployer scale remains unknown. Some sampled deployments omit it and
  have different fees; neither zero nor a universal 2x factor is a safe fallback.
- `builder.f` is in tenths of a basis point (`10` = `0.01%`). Outcome-specific
  builder rules can include BUY; generic spot BUY exclusions are not a substitute.
  The selected fills contain no nonzero builder fee, so builder remains disabled
  until its approval, debit and observed collection path are verified.
- `WsFill.fee` includes `builderFee`. Preserve both fields for attribution but
  count the charged total once. Funding/withdrawal/activation charges stay in the
  route quote, not in the trading rate or the $1 notional.

The bounded public sample used 78 requests across capture/follow-up, 16 public
participants and 23,736 history **status rows** (20,625 HIP rows), not that many
independent orders. Seven histories reached the provider's 2,000-row cap;
511 fills were selected. No private Hunch account payload is part of this evidence.

Of 231 eligible records with known fee terms/scales, exact-decimal floor to eight
USDC places matched 230: 23 BUY, 109 maker SELL, 93 of 94 taker SELL and five
settlements. One taker SELL charged `0.01691711` versus the calculated
`0.01691712`, a one-atom difference. Another 224 records lacked a usable market
snapshot or deployer scale. Current user rates were compared to preceding-day
fills, not frozen historical fee revisions. Therefore this sample does **not**
prove a universal floor-rounding algorithm. Preserve actual fees for accounting;
prove conservative pre-submit debit bounds in P4 without arbitrary buffers or
relaxing consent caps. Source inspection and selected records are evidence, not
production execution/recovery acceptance.

### Actionable next steps and acceptance

1. **P2 first:** implement mode-aware owned cash, positions and settlement ledger
   from the existing proven identities/units. The old unknown-BUY-minimum blocker
   is closed; optional builder and SELL-exemption research do not block reads.
2. **P3:** implement exact route funding/withdrawal and receipt recovery. A $1
   purchase does not imply a $1 bridge route; use each current provider quote's
   minimum, fees and net destination amount without silently enlarging the buy.
3. **P4 shared policy and quote:** implement `minimumBuyNotionalUsd: "1.00"` in
   the financial policy owner, separate protocol provenance, normalized integer
   size/tick, fees, scoped configuration errors and generated client fields.
   Do not change `hip4_read`, social publication thresholds or other venues.
4. **P4 tests:** $0.99 invalid/$1 inclusive; one raw unit below; normalization
   moving notional below $1; prices 0.50/0.415/0.01; policy override/revision;
   fees not satisfying the floor; no silent Max/Half/Copy budget increase;
   partial fills/remainders below $1; the actual $0.333 close with
   `reduceOnly=false`; provider rejection and ambiguous-submit recovery;
   builder included once, missing scales and the one-atom discrepancy.
5. **Web contract:** both surfaces consume the same server policy/quote, show
   the actual price-dependent minimum, preserve normal input editing and unknown
   fees, and retain unavailable final Buy/Sell until financial acceptance.

This update changes only the two planning documents. Financial P2/P3/P4, live
signing and production activation are still unimplemented/unapproved; the $1
decision alone is not a claim that all P0 financial behavior or P2 is complete.

## 20. Initial P2 owned-account reads — October 13, 2026

Implemented an internal account read slice on `hip-next`: actual native balances,
current side-token holdings and a durable journal of observed executions and
non-funding ledger events. This begins P2; global account-value/portfolio inclusion,
complete historical basis and economic transformation/dual alias accounting
remain unfinished. Financial prepare/sign/submit and funding remain unavailable.

### Contracts and storage

- `GET /markets/hyperliquid/canary/account` reads the selected verified linked
  Ethereum-shaped wallet. Existing admin `analytics:read` authorization and exact
  ownership precede every snapshot/history read. Arbitrary addresses, agents,
  vaults and subaccounts are not promoted to owned master accounts.
- `?refresh=1` starts a bounded refresh immediately if no current lease exists.
  A failed refresh releases its lease; late completion cannot overwrite a newer
  claim. Last good observations survive transport/configuration errors.
- `GET /markets/hyperliquid/canary/account/executions` returns decimal strings
  and a full `(time, coin, tid, oid)` keyset cursor, bound to environment, address
  and optional canonical `marketId`. No private provider passthrough payload is
  exposed. It includes transaction hash, reported provider PnL, charged fee and
  builder breakdown; reported PnL is not asserted to be Hunch cost-basis PnL.
- Additive migration `0284` stores account snapshots, current positions,
  executions and ledger observations. Economic owner is environment/address;
  mutable Hunch user IDs are not execution identity. Current wallet ownership
  is rechecked on access. Known markets have real restrictive FKs; unavailable
  metadata keeps canonical identity and can acquire its FK on replay.
- Additive migration `0285` preserves original provider fill JSON and its
  fingerprint alongside normalized facts. Client ID, initial position, maker/
  taker and future fields are retained for later accounting/recovery, without
  exposing a raw passthrough payload. Older facts can remain explicitly without
  source evidence until replay enriches them; no synthetic backfill is applied.
- Retention protects current positions and durable executions by canonical
  market ID, including facts captured before the market was indexed. These
  are protected financial references, not disposable public read derivatives.

Unified/portfolio-margin cash uses `spotClearinghouseState` once. It does not add
legacy perps equity or maintenance/borrow capacity. Total, hold, unheld cash,
reported debt/supply and maintenance capacity remain separate. `ownedCash` is
nullable when the account-mode/debt facts are insufficient; `spendable` is null
and `canTrade` is false throughout this slice. Only a successful complete spot
snapshot replaces current positions. Missing history never seeds a position;
failed refresh never flattens one. Unsupported `oN` bookkeeping balances remain
explicitly unresolved rather than being guessed into a side token.

Recent fills are requested unaggregated (`userFills`, maximum 2,000 responses)
to keep the live tail advancing. The policy lookback limits ingestion; earlier
already captured executions remain in the journal. Ledger range reads are
bounded independently. Provider caps and last successful observation times are
reported; `allTimeComplete: false` is intentional. Fill replay does not duplicate
records. Conflicting identity facts retain the first fact and produce a diagnostic
without dropping valid balance updates. Builder fees are included once in
observed quote cash; unknown fee denomination/transformation semantics stay null.

### Runtime policy and recovery

Pure `hip4_account` policy is registered in the existing administrative policy API:

| Field               | Default     | Purpose                                                                 |
| ------------------- | ----------- | ----------------------------------------------------------------------- |
| `enabled`           | `false`     | Internal account read activation; public HIP reads must also be enabled |
| `snapshotMaxAgeMs`  | `60000`     | Observation freshness and normal polling cadence                        |
| `historyLookbackMs` | `604800000` | Seven-day provider ingestion window, not all-time completeness          |
| `pageSize`          | `30`        | Bounded execution-history pages                                         |
| `leaseMs`           | `120000`    | Recoverable cross-process refresh admission                             |

Account reads use the existing shared IP admission and transport bounds. Role
costs 60, spot-state 2, user fills reserve 120 independently of local filtering,
and the other requests cost 20. One refresh costs at most 242; the one-minute
default leaves capacity for public reads under the local 600-weight policy.
Explicit refresh is not delayed by freshness housekeeping. Effective policies
are rechecked before every provider request, including environment/disable
changes; a malformed active policy produces a configuration failure, not silent
activation with defaults. No product trade minimum is added to this read policy.

### Verification and remaining P2 work

The initial package passes 102 HIP tests, frontend 1,700 tests, typecheck/lint,
full backend workspace tasks and exact Node 20 Turbopack build. PostgreSQL 16
checks cover clean migrations, leases/late completion, replay and conflicts,
failure versus explicit zero, tied timestamps, first/resumed/empty pages,
retention protection and generic indexed plans on 20,000 execution rows.
An additional disposable test uses the real admin middleware, session storage
and linked-wallet lookup: the verified selected wallet succeeds; unauthenticated,
foreign and unverified wallet requests are rejected before the data read.
Recorded public funded snapshots also pass the new projection: both nonzero
side-token holdings survive, while maintenance capacity and unheld cash remain
different values and absent debt facts keep `ownedCash` unknown. This is recorded
wire evidence, not new live funded-account acceptance.

Live local reads of the linked admin account returned `role: missing`,
`mode: default`, cash zero, no positions, and successfully observed empty fills/
ledger. Those are real provider observations. A supplemental public-participant
probe failed at `recentTrades` with a provider HTTP error, so no new nonzero live
account acceptance is claimed. Deterministic browser checks now cover desktop
balance/positions and the mobile execution journal at 390 by 844. They exposed
and fixed a chart SVG-title hydration mismatch and an initially clipped selected
execution tab. History timestamps use explicit UTC, independent of host locale.
The local Next server's self-proxy failure recovered after binding it to
`localhost`; the live account page now requires a renewed Privy session.
Authenticated live desktop/mobile acceptance remains pending. Deterministic
fresh/stale/empty/unavailable presenters and the private API contract are tested.

Next P2 slices: indexed historical repair with gap/watermark accounting; proven
transfer/split/merge/negate/settlement basis and dual economic aliases; global
account-value and portfolio projections; complete current open-order reads;
unlink/delete cache cleanup and linked-owner lifecycle acceptance;
then funded-account live/visual acceptance. Do not declare P2 complete from this
initial read slice or enable P3/P4 actions as a side effect. Local `hip4_account`
was enabled only in `hip4_local`; production remains unchanged. No commit/push.

### Bounded execution-history repair — October 13

Account refresh now reads a bounded `userFillsByTime` page after the existing
live-tail and ledger reads. `hip4_account.historyRepairPagesPerRefresh` defaults
to one (zero pauses only repair; maximum four). Each page reserves the complete
120-weight provider envelope before requesting it. The existing shared budget,
account ownership, native-role check and venue lifecycle remain authoritative.
Base account refresh costs at most 242 weight; the default repair adds up to 120.
Insufficient budget defers repair without erasing a valid balance observation.

The fixed range and inclusive next timestamp persist in the existing account
snapshot's `history.fillRepair`, atomically with accepted executions under the
refresh lease. Restart/retry does not move the range end or skip tied timestamps.
All provider rows determine the page boundary, including non-HIP fills. Replays
use the existing exact execution identity and cannot add phantom positions.
Malformed HIP fills or unordered/out-of-range rows cannot advance the cursor.
Once a range is exhausted, the next scan overlaps its end; changing the lookback
starts a bounded rescan without deleting captured records. Damaged derived
cursors also restart a bounded scan, with a reset counter rather than a permanent
manual-repair requirement.

A full 2,000-row page confined to one millisecond is not pageable by this API.
That millisecond is recorded as `timestamp_saturated` before moving forward.
`historyRepairMaxGapDetails` bounds stored detail (default 32, maximum 100);
the cumulative count and truncation flag survive detail trimming. Transport,
validation and admission failures preserve the retry boundary and last successful
observation. These are provider-observation diagnostics, not cost-basis coverage.

The [official fills-by-time contract](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#retrieve-a-users-fills-by-time)
exposes at most 2,000 fills per page and only the latest 10,000 fills overall.
An exhausted or empty range therefore never establishes all-time completeness.
The web execution list retains limited-history wording and distinguishes pending
repair, failed updates and known gaps, without a new layout.

PG16 tests cover the persisted overlapping boundary, mixed HIP/non-HIP pages,
HTTP failure/recovery, duplicate replay, pause/resume, malformed fills,
timestamp saturation, budget denial/recovery, per-refresh page bounds and native
role rejection. Work currently runs with owned-account refresh, not an autonomous
all-account backfill worker. Non-funding ledger pagination, durable idle-account
scheduling, economic alias/basis accounting and Portfolio integration remain P2
work; this change does not close P2.

### Withdrawal fees and funding integration

Two unsigned Relay quotes on October 13 at 08:45 UTC, Core spot/perps USDC to
Base USDC with exact input 10, returned expected output `9.976977` and minimum
output `9.777438`. The relayer fee was `0.023023` USDC; its gas/service breakdown
was `0.001020` and `0.022002`, respectively. Their sum differs from the total by
`0.000001` USDC (100 raw units at eight decimals). Quoted source gas and app
fees were zero. The
expected/minimum difference is the quote's output floor, not another fee.
These are hypothetical quotes, not submissions or balance-funded execution.
Their `sendAsset` route is distinct from the legacy `withdraw3` bridge, whose
[API documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#initiate-a-withdrawal-request)
still lists a $1 withdrawal fee. Do not add that $1 to every Relay route.

The existing Relay normalizer counts `gas`, `relayer` and `app`, and validates
that `relayerGas + relayerService = relayer`; breakdown fields are not additional
charges. The new quote's tiny discrepancy needs a specific normalization decision
and tests before enabling Core, rather than an arbitrary fee buffer or a claim
that the existing exact check accepts it. The normalizer currently accepts only
the implemented EVM/Solana network mappings,
not Core 1337. P3 must extend the native asset/action/receipt boundary rather than
pretend the current normalizer already supports HIP funding.

For shortfall, use verified executable destination cash plus the conservative
net route output to cover the rounded order debit and applicable trading fee.
Funding 3 USDC means crediting at least 3 after transfer costs, not submitting
3 at the source and ignoring a smaller arrival. Reserve the exact source debit
and separately charged costs once, within user consent and policy fee caps.
Max/Reduce use net route capacity; the $1 BUY floor remains notional only and
does not impose a $1 bridge minimum or authorize increasing the user's Buy.
Account activation and forwarding costs are path-dependent quote/account facts,
not a permanent haircut to each displayed cash balance.

### October 13: common venue policy and native account surfaces

The earlier canary bypass of `venue_lifecycle` is removed. `readHip4Policy`
uses the existing shared venue schema/defaults/capabilities without importing
API-wide environment configuration into the indexer. HIP operational settings
remain subordinate: they control environment, freshness, budgets and bounded
work, but cannot enable an operation denied by the common venue policy.

- Public HIP read routes and their SSE authorization require `discovery`.
- Owned balance and execution reads require `accountRead`, including in
  `exit-only`. Wallet no longer fetches the discovery catalog to authorize an
  account read.
- The REST/WS indexer obeys `indexerMode`. `off` closes its live connection and
  stops new work; `maintenance` repairs existing unresolved markets without
  importing new catalog members; `full` retains catalog ingestion.
- A bounded digest of operational and lifecycle context is the shared revision
  for snapshots, history and SSE. Policy repair recovers on ordinary polling;
  no manual cache purge or refresh-lease reset is required.
- HIP financial and signal capabilities remain false even when lifecycle is
  `active`: Buy/Sell/cancel/redeem and signals are not implemented yet.
  Automation remains unsupported. Other venues' capability behavior is unchanged.

Account polling uses the smaller of snapshot freshness and the existing policy
check interval; it refreshes provider facts only when stale or explicitly
requested. The frontend now uses native Events headers/charts/market rows and
native Wallet presenters. The Core card exposes observed total/held/unheld
amounts without adding them to ready-to-trade or funding totals. P2 basis,
Portfolio aggregation, historical repair and open orders remain outstanding.

Verification on October 13: fresh disposable PG16 migrations through 0285;
the complete HIP database suite, including generic plans, ownership and recovery;
102 HIP unit tests; 1,707 frontend tests; frontend typecheck/lint; exact Node 20
Turbopack build (42 pages); full backend build (16/16). A length-contract test
also covers history requests under `active/maintenance`. Auth integration needs
an explicitly configured isolated Redis as well as its disposable PostgreSQL.

Only the local `hip4_local` venue was switched to `active/full` to preserve
the authorized read testing under the common policy. Its financial capabilities
remain disabled. The live worker observed 327 catalog outcomes and an active
shared stream after restart. Production policy and deployment were not changed.
The renewed browser acceptance could not run because the browser tool refused
navigation from its internal `data:` error page; HTTP availability and PG16
route tests do not substitute for that visual/session check. P2 is not complete.

### October 13: shared Portfolio read API

The ordinary authenticated `GET /positions`, `/positions/by-token` and
`/positions/pnl` paths now accept Hyperliquid in their read venue scope. The
adapter reads the existing account snapshots and current linked, verified EVM
wallet ownership; it does not create a second position ledger, require admin
status, or synchronously request provider history. Shared `accountRead` policy
still applies, including `exit-only`. Mutation/sync venue schemas are unchanged.

- Exact quantities and per-side valuations are decimal strings. Numeric `size`
  remains a compatibility/display field. No complementary-side bid or provider
  `entryNtl` is promoted to verified valuation/basis.
- Missing market metadata preserves the holding with nullable summary/value.
  Stale snapshots retain the observed quantity but not a current valuation.
  Official fractional/zero payouts are values of still-observed holdings, not
  proof of settlement cash arrival or realized PnL.
- Unknown basis and PnL remain `null`. Mixed-venue summary PnL is not presented
  as complete when HIP accounting is missing. A fresh zero current balance does
  not establish zero all-time realized PnL.
- Response coverage distinguishes disabled, ready, partial and unavailable HIP
  reads. A HIP policy/fact error does not erase other venues' positions. A
  Solana-only scope does not depend on HIP policy. Responses are private/no-store.
- The common read schema is separate from execution contracts. HIP records
  explicitly disable Sell/redeem/hide and never acquire a fabricated Polymarket
  asset context. Existing venue-list precedence and legacy frozen fields remain.

Verification: `test:hip4` passes 119 tests; `test:hip4:portfolio:db` passes on
disposable PostgreSQL 16 with real ordinary authentication, current ownership,
lifecycle transitions, invalid-policy recovery responses and OpenAPI schemas.
Owned/empty/market lookups and a generic owned lookup use indexes against 10,000
irrelevant account and market fixtures (14/2/3/9 shared hit blocks in the final
run). Fixture writes in the projection/plan suite roll back. Existing positions
route/repository and metrics/refresh regressions pass; targeted lint and the full
backend workspace build pass (16/16).

This is backend integration, not Portfolio UI acceptance. Frontend generated
contracts, nullable-summary handling, native Portfolio rows/actions and shared
account-value integration must be completed before restarting the local API for
full-app acceptance or releasing this patch. Owned-account refresh scheduling,
non-funding ledger history, open orders and economic basis accounting remain
unfinished P2 work. No production policy, commit, push or deployment was changed.

### October 13: shared Portfolio frontend contract follow-through

The frontend now generates the three position GET contracts from the same
`positionReadRouteSchemas` registered by the real routes and offline OpenAPI.
Venue selection remains optional in both runtime validation and generated
OpenAPI; an added test covers that boundary. Existing mutation contracts are
unchanged. There is no additional SQL or migration in this follow-through.

Native desktop/mobile Portfolio rows consume owned HIP metadata, exact per-side
values and observation deadlines. Unknown PnL remains null through the headline
and cannot be published as a zero-valued share. HIP financial actions remain
disabled. The default All scope includes HIP; dedicated position filtering,
shared account value and ordinary-user refresh scheduling are not complete.

Verification: 120 HIP/backend unit tests and the complete 16-package workspace
build pass. Frontend passes 1,713 tests, typecheck, full ESLint, generated-contract
check and exact Node 20 Turbopack build. Live/visual Portfolio acceptance remains
pending because browser control rejected the current local tab. The API was not
restarted, and no financial action, commit, push or deployment was performed.
These checks do not close P2 or establish funded-account accounting correctness.

### October 13: shared venue and discovery checkpoint

Common venue capabilities now have a typed `/meta/venues` contract. Public HIP
reads, owned-account reads, streams and ingestion use `venue_lifecycle`; the
legacy canary route is retained for compatibility. Protocol/environment and
resource limits remain HIP-specific, not a second product enablement switch.
The frontend consumes this shared policy for its current Wallet and action
integration. Buy, funding and other financial mutations remain unavailable.

Discovery groundwork adds environment-scoped HIP reads and catalogue projection
of existing book and 24-hour volume facts. It does not yet replace the separate
homepage HIP section with the ordinary unified feed end to end. Existing venue
ranking formulas, candidate bounds and indexes are preserved. A HIP-only query
boundary avoids scanning other venues through the global ranking index under a
generic plan; mixed and legacy paths keep their existing fast path.

Disposable PG16 verification covers feed hydration, search, timeout regressions
and 12 custom/generic first/next/empty-page plans. In the representative fixture,
the HIP-only generic plan visits 1,200 HIP rows instead of all 23,309 market rows.
This is bounded local regression evidence, not a production latency guarantee.
Policy-scope tests cover concurrent-read coalescing, expiry and error recovery.

This checkpoint remains incomplete P2 work: full unified homepage integration,
remaining static frontend venue gates, shared account value, normal-user refresh
scheduling, complete ledger/history, verified basis, open orders and renewed
authenticated browser acceptance remain outstanding. Migrations 0284/0285 are
additive and were tested on disposable PG16; no production migration or policy
change is part of this checkpoint.

### October 14: shared Account Value read integration (in progress)

The earlier homepage checkpoint is superseded by the shared-feed changes on
`hip-next`: desktop/mobile home use the ordinary paginated feed and common
server policy, not an injected admin-only HIP section. Native side deadlines
and 24-hour volume labels are preserved without inventing lifetime volume.

`/account/value` and `/account/assets` now consume the same verified owned
snapshots and side valuation projection as `/positions`. The internal shared
reader retains account facts; the public position response still contains only
positions and coverage. The ownership/market SQL and its bounds are unchanged;
Account Value performs no additional provider requests or wallet-history scans.

- Mainnet owned USDC total includes held cash once. `ownedCash` is an unheld
  ownership fact, not total cash: the collector checks the total/held/unheld
  equation and mode/debt evidence before including a USD estimate.
- Borrowed, margin, ambiguous mode, missing, stale and unsupported native assets
  remain explicitly incomplete, not spendable dollars or synthetic zero PnL.
  Testnet balances and positions never enter real-dollar totals.
- Exact side bids and official fractional/zero payouts share Portfolio logic.
  A still-observed position is not proof of settlement cash arrival. Unknown
  basis and realized PnL remain unknown.
- Native cash is a read-only `venue_account` component. It is not inserted into
  executable wallet inventory, cash availability, source bindings or funding
  preferences. Read-only positions have `positionActionRef: null`, not a fake
  actionable UUID; redemption selection explicitly rejects them.
- Account Value/Assets query keys participate in venue-policy invalidation.
  Retryable failures from another wallet cannot restore removed read-only
  balances or replace changed native facts with an old whole-account snapshot.

Verification: disposable PostgreSQL 16 covers ownership, duplicate addresses,
common lifecycle off/exit-only recovery and the public/internal DTO boundary.
On 10,000 irrelevant account and market fixtures, owned/empty/market/generic
lookups use indexes (14/2/3/9 shared hit blocks; 0.083/0.028/0.018/0.070 ms in the
recorded run). This is local regression evidence, not production latency proof.
Backend account/HIP tests, full 16-package build, frontend 1,738 tests, typecheck,
offline contract generation and exact Node 20 Turbopack build pass.

P2 is not closed. Wallet still needs to consume the canonical account components
instead of its separate HIP presentation overlay; normal-user snapshot refresh,
remaining static filters, common execution/ledger history, open orders, verified
basis and authenticated desktop/mobile acceptance remain outstanding. No layout
redesign, migration, commit, push, production change or financial action is part
of this Account Value checkpoint.

### October 14: canonical Wallet and ordinary account refresh

Wallet no longer overlays a selected-address HIP response on the common account
projection. Desktop and mobile use the existing Wallet mapper with the effective
`walletAccess` venues. Native owned total, held/unheld cash, position count and
observation deadline come from the same Account Value components. Distinct owners
are aggregated exactly; a missing or unverified owner does not become a complete
cash total. Testnet units remain outside the mainnet dollar display. This changes
data flow, not the Wallet design or financial capabilities.

The common Account Value hook now drives the existing owned-account read adapter
for all currently verified linked Ethereum owners. Concurrent consumers share
one query scoped by user, owner set and venue-policy revision. Requests are
sequential, abortable and follow server refresh timing. Admission priority rotates
between owners so a constrained shared budget cannot always favor the same first
addresses. Normal polling reuses fresh server observations; explicit Portfolio
repair uses the same adapter with refresh requested. Neither path signs, submits
orders, scans arbitrary wallet history or bypasses server policy/budget/leases.
Display still reads only canonical projections; upstream responses are not a
second balance authority. Funding inventory and available Hunch cash are unchanged.

Verification: 1,744 frontend tests pass, typecheck and targeted ESLint pass, exact
Node 20 Turbopack build succeeds (42 pages), and the full backend workspace build
succeeds (16/16). The real ordinary-auth owned-account integration test passes
again on disposable PostgreSQL 16, including current ownership, lease/replay,
failure recovery, lifecycle and shared Portfolio. No SQL or migration changed.
Desktop/mobile deterministic Wallet checks cover fresh, stale and unavailable;
the local authenticated mobile Wallet also shows the real zero HIP account from
the common projection. The native provider role is `missing`, not a funded-account
acceptance case. No production changes or financial actions were performed.

P2 remains open: remaining Portfolio filters/breakdown, the shared execution
history and open-order surfaces, durable idle-account history scheduling,
ledger/basis accounting and nonzero funded-account acceptance still require work.
The browser read lifecycle is not an autonomous background repair worker.

### October 14: ordinary Portfolio filters and observed History

The regular Portfolio venue filter and breakdown now use effective `accountRead`
capabilities on both surfaces. Native cash and positions enter the same canonical
breakdown once. Missing valuation is nullable, with no fabricated zero percentage.
Policy-off cached rows are filtered immediately. Financial venue schemas and
available-to-spend amounts remain unchanged.

`GET /orders` now includes the immutable HIP execution journal as
`kind: execution`, alongside existing order/swap records. Each fill retains its
exact decimal facts, fee denomination, transaction identity and source. Original
order size/status are not inferred from a fill; `actionRef` is null. The ordinary
History UI renders these records using its existing rows, with explicit limited
coverage. `/orders/:id` resolves the same record. `/orders/open` does not fabricate
open orders from fills; a complete native current-order reader remains pending.

Access requires current verified ownership and common account-read capability;
testnet observations never enter this mainnet history. Unlinked cached fills are
also removed by the frontend before a replacement query returns. The read is local
only. No journal copy into mutable orders, external request, signing or submission
is introduced by these history endpoints. Schemas and generated web contracts now
cover ordinary orders as well as native fields; nullable legacy venues and error
metadata remain compatible.

Review fixed duplicate forced refresh on Portfolio mount and invalidation of
heavy read models for unchanged observations. Consumers share the owner-scoped
poll; manual repair can still force refresh. Changed observations invalidate
Account Value, Positions and History, not the market feed.

SQL review and execution used disposable PostgreSQL 16 with 10,000 owned fills,
30,000 foreign fills, testnet records and a legacy order. A bounded candidate
page per verified owner preserves the common ordering. Measured first/next pages
used 16/23 shared-hit buffers (about 0.18/0.24 ms in that run). Deep offsets and the
exact count still scale with the scoped history: the empty offset-10001 page used
2268 buffers/about 29 ms. These are local fixture measurements, not production
capacity claims or a claim that `LIMIT` bounds the count. Custom/generic plans,
tied times, empty/sparse pages, policy-off and ownership revocation pass.
Existing feed SQL/ranking paths were not changed.

Checks: 1,750 frontend tests, typecheck, full frontend lint, exact Node 20
Turbopack build and backend workspace build 16/16 pass. Ordinary-auth PG16 tests
and legacy orders regressions pass. There is no schema migration in this slice.
P2 is still open: native current orders, durable idle-account refresh/history
repair, ledger/basis accounting and funded-account acceptance remain outstanding.

## 21. Current P2 read integration acceptance — October 14, 2026

This closes the current goal of integrating HIP into ordinary venue mechanisms
with truthful owned balances, positions and execution history. It does **not**
certify production rollout, complete lifetime tax/accounting history, P3 funding
or P4 trading. No financial action is enabled by account-read policy.

| Area                   | Implemented / verified                                                                                                                                    | Explicit boundary                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Access and policy      | Common `venue_lifecycle` / effective capabilities, ordinary verified-wallet auth, user/owner/environment-scoped cache                                     | Compatibility admin canary is optional; no second product activation switch                            |
| Discovery and event UI | Unified indexed market/feed path and existing Hunch event design                                                                                          | This P2 slice does not alter feed SQL/ranking or invalidate the feed on account polling                |
| Wallet / Portfolio     | Canonical Account Value, 4-venue filters/breakdown, native cash/hold, exact side quantities and qualified current marks                                   | Missing/stale/borrowed/unsupported-mode values remain nullable; cash is not a trade authorization      |
| History                | Ordinary `/orders` and `/orders/{id}` expose immutable observed executions, exact amounts/fees, separate `execution` kind                                 | No invented order status/original quantity, action reference or lifetime-completeness claim            |
| Open orders            | Ordinary `/orders/open` consumes independently observed `frontendOpenOrders`; exact original/remaining quantity and expiry                                | No cancel control; fills are never reverse-engineered into current orders                              |
| Idle refresh / repair  | Sidecar-safe finance-worker job; indexed enrolled-owner selection, leases, current owner/policy admission, bounded fill and non-funding-ledger cursors    | Unknown timestamp-saturated intervals are gaps; prior balances survive partial failures                |
| Current accounting     | Proven zero-start BUY anchor, exact position-chain replay, weighted-average remaining basis, charged BUY fee once, partial disposal/fractional settlement | Unknown transforms/transfers, gaps, ambiguous sequence or conflicting evidence give nullable basis/PnL |
| Admin                  | Existing Venue Lifecycle page consumes backend capability ceiling for Hyperliquid                                                                         | No newly enabled signing, funding, buy/sell or redemption                                              |

### Source facts, recovery and accounting scope

Provider snapshots remain authoritative for holdings. Immutable executions and
ledger observations cannot seed a missing balance or resurrect an extinguished
position. Exact execution identity includes time/coin/tid/oid, not a hash alone;
YES/NO legs are not collapsed into one false trade. Source conflicts preserve the
original evidence and mark affected current-lot accounting unknown. A later
unambiguous zero-position BUY can recover that lot without deleting old facts.

`history.positionAccounting` is versioned and bound to the same observation and
exact quantity. Current remaining cost and PnL use integer decimal arithmetic;
partial releases retain the rounding remainder until final disposal. BUY `fee`
already includes builder fees, which are not charged again. An optional derived
read failure rolls back to its savepoint, **not** the valid balance/fill update.
The next normal refresh retries; a row-cap sentinel never produces a truncated
financial sum. Unknown fee currency, split/merge/negate/expansion or uncertain
side-token transfer allocation remain explicitly unsupported, not zero-cost.

Exhausted provider-visible fill and ledger intervals establish current coverage;
this is not proof of all earlier provider history. `realizedSinceAnchor` is
qualified current-lot information, **not** all-time wallet PnL. General Portfolio
realized PnL therefore remains null while lifetime coverage is unknown. Confirmed
current cost may be shown even when its mark is missing; current PnL expires with
the mark. Closed/proposed extreme prices do not become official settlement.

Open-order failures preserve the prior successful list only until its original
deadline. Future observations are not fresh. Changed account observations now
invalidate common open orders as well as Account Value/Positions/History; unchanged
polls do not invalidate those expensive queries. Ordinary policy-off and unlink
remove cached native rows. Re-enable, renewed evidence and explicit refresh recover
without deleting financial facts or waiting for arbitrary housekeeping.

Provider-specific `hip4_account` controls resource/freshness limits, not product
activation: worker interval/batch, repair pages/gap detail, lease and
`accountingMaxRows` (default 20,000). Existing venue lifecycle remains authoritative.
Migration `0286_hip4_account_refresh_due_index.sql` only adds the concurrent due
index; it was executed on isolated PostgreSQL 16, not production.

### Acceptance and repeatable checks

- Backend: 142 HIP/position/lifecycle unit tests; finance-worker 24/24; full
  workspace build 16/16 and changed TypeScript ESLint.
- PostgreSQL 16: `pnpm -C apps/api run test:hip4:p2:db` runs nine suites
  **sequentially**. Supply explicit `DATABASE_URL`, matching
  `HUNCH_TEST_EXPECT_DATABASE` and isolated `REDIS_URL` for real auth rate limiting.
  Tests use synthetic owners/provider responses and no external financial calls.
- Generic accounting plans on rolled-back 10,000 owned + 30,000 foreign rows:
  101-row fill/ledger reads used 12/11 hit buffers; complete 10k reads used
  725/634; empty tails used 3. Local timings were approximately 0.06–3.6 ms.
  Open-order snapshot JSON is materialized once (not decompressed per order).
  Common History deep offsets/exact counts still scale with scoped history;
  no constant-cost claim is made. These are local fixture measurements, not
  production-scale or production-latency certification.
- Frontend: 1,753 tests, typecheck, full lint, exact Node 20 Next/Turbopack build
  (42 pages), generated API/fixture consistency check. Admin: 47 tests, build,
  typecheck and lint.
- Ordinary authenticated desktop/mobile Wallet and Portfolio/Orders/History
  checked locally through the Next proxy, not only the canary. That owned account
  is empty. Nonzero public read evidence is anonymized in
  `apps/api/src/fixtures/hip4/public-p2-read-acceptance-20261014.json`:
  220/43 positions, 162/69 open orders, 2,000 fills each, real fees and MergeOutcome
  observations. It is **not** an owned funded-account browser test. Nonzero
  ordinary-auth read-model behavior is covered separately with disposable fixtures.

Next: P3 exact funding receipts/shortfall/withdrawal economics, then P4
prepare/sign/submit/recovery and live funded end-to-end acceptance under separate
authority. Full lifetime basis allocation across transfers and transformations
needs a separate proven attribution contract before reporting all-time PnL.
No commit, push, merge, deploy, production policy change, Telegram action,
signature or trade is part of this acceptance.

## 22. Paused P3/P4 implementation checkpoint — October 14, 2026

At this historical checkpoint work was paused at the user's request. Preserve this implementation on `hip-next`,
without merging, deploying, changing production policy or enabling financial
capabilities. P3 is partially implemented; P4 interactive order execution is not
implemented. Earlier scoped review approvals do not mean P3/P4 are complete.

### Implemented checkpoint

- Native identity, Standard spot owned-USDC capacity, common reservations and
  post-snapshot source debits. Native quote units are eight decimals; EVM USDC
  destination/source units remain six. Perps refunds have a separate physical
  location and never become spot spending capacity.
- Existing Relay client/planner/action runtime extended with native authorization
  and SendAsset. Immutable action binding, shared signer/nonce admission,
  sign-only preparation, durable submission ambiguity and exact receipt
  reconciliation reuse the common funding operation. An ambiguous transfer is
  never automatically resent with another nonce.
- Core spot to Base USDC, Polygon USDC and Polygon pUSD withdrawal contracts,
  using existing withdrawal policy and shared desktop/mobile Withdraw controls.
  No default funding catalog enablement or production activation is included.
- Base/Polygon USDC to Core spot quote validation and adapter: exact order hash,
  input/output ownership, units, fee bounds, EVM execution and both immutable
  refund locations. This inbound adapter is not yet connected to the production
  source planner or advertised catalog.
- Canonical inbound source debit and reservation protection, including an early
  destination/refund observation before source receipt. A separately confirmed
  exact approve remains cancellable; atomic approve-and-deposit is money-moving.
- Pure refund evidence validation, deliberately not connected to runtime:
  request/order identity, committed refund recipient/location, actual returned
  amount, semantic receipt deduplication, partial coverage and exact final sum.
  Invalid refund-only provider fields cannot break ordinary destination evidence.
- Additive migrations 0287–0291 and generated API contracts. No Telegram-specific
  files, production permissions, signing policies or deployment automation changed.

### Verification and limits

At this checkpoint: 321/321 native funding tests, API typecheck, changed-TypeScript
ESLint and the complete backend workspace build (16/16) pass. Independent final
review approves only the disconnected pure refund boundary after its fixes;
the reviewer ran 124 offline tests and clean-environment imports. Earlier scoped
reviews cover the common action runtime, withdrawal integration, inbound adapter
and source-debit/cancellation behavior, not end-to-end financial readiness.

Migrations and financial SQL were exercised on disposable PostgreSQL 16.2,
including nonce concurrency, admission/recovery, actual common commit/action/
receipt paths, replay, cancellation and reservation release. Generic plans over
50,000 unrelated fixture rows used indexed native-inbound release reads
(held/unstarted/empty: approximately 0.213/0.101/0.087 ms, 21/7/3 local buffers).
These are local fixture measurements, not production-scale certification.
No real transfer, wallet signature, order or production mutation was performed.

### Resume here, in this order

1. Wire exact generic web refund receipts into the existing worker and allocator.
   Do not modify the Telegram-only refund observer. Repair scoped partial-refund
   lifecycle/account-value semantics: one receipt must not complete a multi-part
   refund, erase remaining in-transit value or restore stale source cash.
2. Connect inbound production-source planning, destination readiness and the
   existing catalog only after these paths work. A genuine zero-balance native
   destination must be eligible without pretending its balance is positive.
3. Complete exact Solana routes in both directions, including protocol encoding,
   receipts, units and recovery. Do not treat base58 identity as an EVM hex hash.
4. Keep unsupported account-mode capacity explicit. Do not spend perps margin,
   use automatic borrowing or silently change account mode.
5. Implement P4 through existing trade preparation/attempts, shared nonce
   admission and finance-worker: fee-aware $1 minimum BUY, supported GTC/IOC/ALO,
   sign/server-submit, cancel, fills and ambiguous-result recovery. Do not use a
   fake funding operation as the order coordinator or introduce a new UI.
6. Repeat SQL, regression, browser and independent acceptance checks. Actual
   financial testing and production enablement require separate authorization.

## 23. Resumed P3/P4 — common refund lifecycle contract, October 14, 2026

The user resumed the goal and authorized switching back to `hip-next` and merging
current main branches. Backend merged `origin/main` `ec837e46` as `0eb1e843`;
frontend merged `origin/main` `edd9d388` as `b66f56ad`. Admin `hip-next` already
contains its current `origin/master` `7e835af5`. No push, deployment, production
policy change, Telegram modification, signature or financial execution occurred.
P3 is still partial and P4 execution is not implemented.

### Completed local increment

- New native Relay plans freeze `relay_exact_refund_receipts_v1` in the existing
  immutable refund snapshot. Legacy plans retain their previous lifecycle;
  malformed/future contract markers cannot downgrade to legacy semantics.
- The common lifecycle now separates a canonical partial `refund_credit` from
  proof that the whole refund is complete. Partial evidence keeps reconciliation
  active, blocks new actions and does not release source reservations.
- Completion requires an append-only proof over the exact set of canonical
  finalized observations: frozen request HMAC/key version, validated protocol
  order, physical refund location/owner/DEX, asset/precision and the actual
  post-fee returned amount. The source nominal is not treated as received cash.
- Protocol order binding comes from the validated native action pair or decoded
  EVM deposit, not from a mutable provider label. Independent review found and
  fixed the coherent wrong-order case. A reorged member invalidates completion;
  old proofs cannot hide new receipts or complete a sibling segment.
- The batched lifecycle reader uses its existing operation index. There are no
  new tables, migrations, provider calls or per-operation query loops.

### Verification

- 322 native funding tests, 20 exact-refund unit tests, 12 legacy funding suites,
  API typecheck, changed-TypeScript lint and full backend build (16/16) passed.
- Disposable PostgreSQL 16.2 exercised real commit/allocator/facts/reducer paths,
  partial-to-complete proof append, replay, append-only rejection and reorg.
  The exact changed lifecycle SQL used index scans with 50,000 unrelated segments
  under a generic plan: matching/missing/empty results approximately
  0.035/0.039/0.021 ms. These are fixture measurements, not production benchmarks.
- After the main merge, frontend typecheck, lint, 1776 tests and the exact
  Node 20 Turbopack build (42 pages) passed.
- Independent review gives scoped GO for this contract/lifecycle increment
  after the order-binding fix; it is not runtime, release or P3/P4 acceptance.

### Next boundary and release constraints

The proof writer is not connected to the worker yet. Section 24 records the next
completed increment; the remaining boundaries below still gate financial acceptance:

1. Persist generic web/native refund receipts through the common global allocator
   and append completion proofs only after the exact set is allocated. Preserve
   native destination event identity across credit/refund kinds. Do not modify
   the Telegram-only refund observer.
2. Integrate receive/refund classification with consistent locks; an early EVM
   refund must not be booked as a new external deposit. Watch already recorded
   canonical receipts even when Relay is unavailable; implement scoped
   recanonicalization/replacement without impersonating the legacy observer.
3. Fix exact-route account-value projection: retain the remaining in-transit
   claim after a partial refund, suppress the full debit against an older source
   snapshot, and keep perps refunds separate from spot cash. USDC6/8 conversion
   must be exact; no pUSD peg assumption. Current first-refund replacement logic
   in `account-value/funding-movement-feed.ts` is not yet changed.
4. Continue the remaining inbound planner/readiness/catalog, Solana and P4 steps
   listed in section 22. Native withdrawal routes are injected by the existing
   withdrawal contract independently of the default funding catalog: a disabled
   default catalog alone is **not** a runtime isolation gate. Do not deploy or
   enable this incomplete increment as if the refund recovery were finished.

## 24. Common exact-refund writer and bounded reads — October 14, 2026

This local increment supersedes section 23's unimplemented writer step, not its
release constraints. The goal is active. P3 remains incomplete; P4 real trading
execution has not been implemented. The refund implementation stays uncommitted
on backend `hip-next`. The app-handoff clarification in section 8 also updates
frontend documentation and navigation tests; admin is unchanged.

### Implemented and independently reviewed

- `relay-exact-refund-receipts.ts` allocates exact native/EVM refund observations
  through the existing global economic-event allocator. It revalidates immutable
  request/order/owner/asset/precision/DEX bindings after the operation lock and
  appends completion proof only for the entire canonical refund set.
- Partial receipts survive subsequent bounded polls and empty responses. Native
  evidence retains only whitelisted ledger and unsigned-action fields; it uses
  the existing native destination event identity, not a second refund identity.
- EVM canonical-event quarantine is acquired before the operation lock, matching
  the shared receive allocator's lock order. An already externally allocated
  event cannot be silently reclaimed. Replay neither adds money nor immediately
  wakes another reconciliation cycle.
- `exact-refund-observer.ts` reads only exact references from the validated
  Requests manifest. Native reads rotate exact seconds within the shared HIP
  budget. EVM reads preserve valid sibling receipts if another reference fails.
  RPC reads finish before opening the writer transaction; errors are redacted.
- `relay-exact-refund-runtime.ts` persists settlement and observation diagnostics
  separately, including the resumable native cursor. It imports without API-wide
  secrets. The existing Relay driver now has an optional refund callback after
  status persistence; its legacy success callback is unchanged.
- Known Relay requests retain their original HMAC/version/ciphertext after lookup
  key rotation; only new discoveries use the current lookup key. Exact refund
  binding uses authenticated decrypted identity and preserves the frozen proof
  identity. Two polls after rotation do not create another provider request.

### Verification and limits of the evidence

- 322 native tests, 20 refund-contract tests, 12 legacy unit suites and the
  existing Relay PostgreSQL integration passed. API typecheck, scoped lint,
  sidecar clean-environment imports and full backend build passed.
- Disposable PostgreSQL 16.2 exercised actual inbound Base/Polygon and native
  committed plans with partial 4 + 5.8 refunds, replay, failed sibling reads,
  immutable proof append, lookup rotation and reorg invalidation.
- Generic plans against 50,000 unrelated rows used index scans: exact refund
  context hit/miss/mismatch approximately 0.035/0.019/0.013 ms; Relay known-request
  lookup hit/miss 0.064/0.029 ms. These are local fixture results, not production
  benchmarks. Diagnostic UPDATE access paths were checked without ANALYZE.
- `test:funding:refund-concurrency:db` uses two real PostgreSQL connections and a
  third to assert `pg_blocking_pids` before commit. Disjoint partial writers
  produce exactly 9.8; duplicate writers insert 1 + 0 observations. A refund-first
  receive-claim race observes committed quarantine and short-circuits. This last
  check is **not** full receive-session allocation or a receive-first proof.
  The test requires an explicit disposable DB and retains uniquely named synthetic
  fixtures; no signatures, provider calls or production data are used.
- Independent review passed the disconnected adapter/runtime/callback, rotation
  and concurrency-test scopes. It does not approve worker activation or P3.

### Next implementation boundary

Do not connect the callback to the finance worker until these paths are covered:

1. Early refund-vs-external-receive classification with bounded recovery when
   provider references arrive late, including an eligible receive session and
   both race orders. Do not broaden the Telegram-only observer.
2. Persisted canonical receipt watch independent of Relay availability; narrow
   reorg/re-mining recovery with exact identity, atomic updates, stale-CAS tests
   and compatible additive SQL migration. RPC unavailability is not a reorg.
3. Shared account-value projection must preserve the remaining in-transit claim
   after partial refund and suppress the full source debit against a stale source
   snapshot. EVM inbound needs the same protection as native; perps is not spot
   cash and pUSD must not inherit a USDC conversion assumption.

Then complete common inbound planner/readiness/catalog, Solana directions and P4
through the existing funding/trading infrastructure, including the existing
Telegram-to-app handoff described in section 8. No new financial coordinator,
UI design or Telegram trading automation. Only app-handoff code changes are
authorized; the user's personal Telegram remains untouched. No commit/push/deploy
or live financial action.

## 25. Refund accounting and source snapshot recovery — October 14, 2026

This increment supersedes section 24's unimplemented Account Value item, not the
P3/P4 acceptance status. The common refund callback remains disconnected from
the finance worker. Real interactive trading and sealed Telegram-to-app handoff
remain required P4 work; no Telegram automation or personal-account access.

### Current implementation

- Partial exact refunds reduce only the remaining in-transit claim. Completion
  requires the whole immutable proven receipt set, including actual returned
  amount after fees. Arithmetic zero is not provider completion.
- The full canonical source debit is independently subtracted from older owned
  cash snapshots and cash availability, even after destination/refund completion.
  The new EVM path covers exact Base/Polygon USDC6; the native USDC8 path remains
  shared. No pUSD peg, fee guess or synthetic cash credit is introduced.
- Source validation for new marked legs checks the entire source observation
  set against frozen owner, asset, actual precision, cap and exact reservation.
  Invalid evidence leaves an explicit incomplete-headline diagnostic even when
  an unregistered asset is excluded by valuation policy. A missing reservation
  still fences the exact frozen owned source, not unrelated cash. A normal fresh,
  error-free physical balance after the evidence restores current capacity while
  the historical claim remains unpriced. Invalid timestamps, stale/error
  snapshots and newer sibling evidence cannot clear that fence. Legacy semantics
  are retained; actual evidence assets are never relabeled as USDC.
- Reorged refunds no longer reduce the residual. Their invalidation timestamp
  still fences cached target valuation/capacity until a post-reorg refresh.
  Other confirmed assets remain available. A normal fresh target snapshot clears
  this fence; RPC failure cannot masquerade as a successful refresh.
- Partial/complete credits whose target balance has not refreshed are reported
  as incomplete. Native perps refunds are explicitly unsupported by the current
  spot-only Account Value collector, not advertised as retry-recoverable spot
  cash. Verified perps/unified-mode accounting remains a P3 acceptance gap.
- Migration 0292 adds only a concurrent partial source-tail index; no historical
  data rewrite or data-dependent assertion. It was applied by the actual migrator
  only to disposable PostgreSQL 16.2 `hip4_p34_20261014`.

### Verification boundary

Functional PG16 fixtures cover native, Base and Polygon partial/complete/reorged
refunds, stale snapshots and recovery, wrong source precision/owner/reservation,
mixed source evidence, excessive debits, and raw amounts above JS safe integers.
The database stores raw amounts as text; JSON and bigint retain their precision.

Generic snapshot-tail plans were measured on 400,000 synthetic observations:
native and EVM hit/resumed/empty/sparse cases used indexes, 0–9 local buffers and
approximately 0.02–0.08 ms. Account-value plans also covered 50,000 unrelated
operations and 5,000 fully proven settled legs belonging to one user. The latter
exposed repeated whole-user aggregation (5.6 s); an indexed per-operation LATERAL
aggregate reduced SQL to about 350 ms and read/projection to about 750 ms. Tests
assert work shape rather than a machine-dependent timing deadline. This remains
a linear user-history read, not a constant-time materialized projection; these
are local fixture results, not production performance certification.

Final accounting verification: 348 native/refund tests, API typecheck, scoped
lint and the full 16-package backend build passed. PG16 reruns include the real
loader-to-cash-projector path for mismatched reservations; 13 existing regression
suites also passed. Independent scoped review returned GO after both the
missing-reservation capacity and excluded-invalid-asset headline findings were
fixed, including normal-refresh recovery. This is an accounting-slice verdict,
not worker activation or full P3/P4 acceptance.

Before worker activation, still finish early receive/refund classification and
fair durable recovery, canonical watching/re-mining independent of Relay, native
perps target accounting, and the remaining planner/catalog/Solana paths. No
commit, push, production migration, provider call or live financial action is
authorized by this checkpoint.

## 26. Recorded refund classification — October 14, 2026

This is a verified prerequisite for early receive classification, not a completed
receive/worker integration. The goal remains active; P3/P4 are not complete.

- The new read-only classifier looks up exact Base/Polygon physical receipt keys
  and validates the full frozen request/order/owner/asset/amount and block
  identity. Terminal operations and reorged observations remain visible.
  A missing receipt returns `unmatched`, **not** `external`: the provider observer
  may not have written its evidence yet.
- The joint decision resolver requires explicit decisions for handoff,
  destination and refund. It does not let the first matching role win. Conflicts
  and unresolved evidence remain recoverable; an exact handoff needs provenance,
  not merely an envelope-compatible started attempt. Neither helper is wired
  into the receive observer yet.
- PostgreSQL's existing migration 0195 already rejects a second physical event
  claim regardless of token. Tests retain this invariant, verify the exact
  uniqueness error, and verify that a conflicting incoming token produces a
  conflict while an unaffected sibling remains internal. Reorg tests select
  the explicit transaction hash rather than relying on UUID order at equal
  observation timestamps.
- Five focused tests cover identity conflicts, reorg/recovery, normalized batch
  keys, joint roles and no database reads for unsupported networks. The combined
  native/refund/classification suite passed 353 tests. Disposable PG16 exercises
  the actual Base/Polygon writers before/after partial, complete and reorged
  refunds. Generic exact-lookup plans over 50,000 unrelated operations use index
  scans for hit/miss/empty: approximately 0.079/0.058/0.063 ms and 10/3/0 local
  buffers. These are local fixture measurements, not production benchmarks.
- Independent review gave scoped GO for the disconnected primitives and tests.
  This does not certify allocation concurrency, retry recovery or activation.

Next, finish the pending-candidate pass against bounded source pages: exact
frozen source/refund identity plus a bound money-moving deposit attempt or an
exact source debit. Approval, provider status, quote expiry and cached operation
terminality are not evidence that a refund is impossible. Only matching IDs
need batched lifecycle projection. Persist continuation and fair retry state so
an exhausted page cannot become external or remain an unrepairable blocker.

Before wiring the joint resolver, preserve exact/possible provenance in the
existing handoff classifier and lock all physical keys in deterministic order
before acquiring operation locks. The existing recovery queue must also handle
already-seen events after the scan window closes, without scanning new history,
reopening an old session or reviving an expired Buy. Verify both race orders,
reversed multi-event lock order, backlog fairness and post-window recovery on
real PostgreSQL. The persisted canonical watcher, native perps accounting,
remaining common planner routes and P4 trading/app handoff remain outstanding.

### Immutable source enumeration

`relay-refund-source-candidates.ts` now enumerates source-input reservations in
bounded pages **before** provider, asset or envelope filtering. The existing
deferred plan-shape constraint requires a source-input reservation for each
committed route leg. A wrong asset/location/amount on that reservation therefore
stays visible and becomes an invalid binding rather than a false non-match.
Current operation ownership and the frozen source/refund owners are compared.
Released rows are not dropped. Timestamp cursors retain PostgreSQL microseconds
and use the reservation ID as a tie-breaker; the extra sentinel starts the next
page rather than being skipped. Migration 0293 adds only a concurrent partial
index, applied and checked on the disposable PostgreSQL 16 database.

This reader returns possible immutable relationships, **not** a money-movement
decision. It retains candidates even after refunds settle or become reorged.
There is no `external` result. Final validation still needs bound deposit/debit
facts for **all** matching envelopes, not just those that looked pending on an
earlier page. `scanBefore` is a timestamp bound, not an exported MVCC snapshot:
late historical inserts and ownership changes require revalidation/reset. No
invalidation generation or final-negative proof is claimed by this reader.

The combined native/refund/classification suite now passes 357 tests. Actual
committed Base/Polygon source plans remain candidates before refund, after
completion and after reorg. Generic first/next/empty-user/empty-tail plans on
50,000 unrelated reservations plus 5,000 same-user tied-timestamp sources use
index scans and at most 51 rows at each hydration stage. Local timings were
0.296/0.276/0.074/0.055 ms with 361/359/3/3 buffers. The full 16-package backend
build, API typecheck, scoped lint and formatting passed. The reader remains
disconnected until durable retry, current-fact revalidation and allocation
concurrency are implemented and tested; these checks do not close P3/P4.

### Common receive/refund lock ordering

The real receive-session observer now locks the **entire** recovered/scanned
physical-event batch in the same order as the refund writer, before invoking
classifiers or entering operation-owned allocation. Sorting the processing loop
alone would still allow `event A → operation → event B` to deadlock against
`event B → operation`. Claim, quarantine and prelock share one physical-key
UPSERT; prelock does not overwrite allocation/quarantine or create a receipt.
Conflicting duplicates are validated before scanner deduplication can hide them.
No new migration or funding coordinator was introduced for this change.

Verification includes the real receive-session persistence suite (ordinary
deposits, durable recovery, channel ownership, retained assets and late windows),
361 native/refund/receive unit tests, and PostgreSQL 16 concurrency tests. The
staggered test pauses receive after only A is locked and refund after B but
before operation O: `pg_blocking_pids` proves receive waits on B, while a third
connection can still lock O with `NOWAIT`. Refund then commits and receive
continues. Additional reversed-batch tests cover both starting orders, and
duplicate/disjoint refund writers retain one physical allocation.

Generic insert/replay plans for the actual shared UPSERT on a 50,000-row local
temporary table use the physical-key unique arbiter, one input row and no table
scan: 0.094/0.066 ms, 15/7 local buffers. The common receive regression and full
16-package workspace build passed. This is local verification, not a production
load certificate or proof that refund classification is fully connected.

Source-membership review narrowed the next step: current `mergeUsers` rejects
**any** receive-session evidence, including closed sessions, while user locks
and session foreign keys serialize concurrent creation. Supported route-source
reservations are committed before any external source send; existing stopped
operation repair changes evidence, not source membership. Do not add a generic
generation mechanism for nonexistent mutation paths. Add narrow concurrency
regressions for those invariants; if a future merge or historical-source repair
relaxes them, it must explicitly reset affected scans. Current-fact revalidation,
fair durable retry, exact/possible handoff provenance, the final joint classifier
and post-window known-event repair are still required before refund-worker
activation. P3/P4, actual trading and sealed Telegram-to-app handoff remain open.

### Bound source-action evidence and resumable reads

`relay-refund-source-actions.ts` adds a disconnected reader/classifier for the
existing Base/Polygon USDC-to-HyperCore client actions. It validates the frozen
source owner, exact token/amount/order, normalized action fingerprint and every
attempt's executor/fingerprint. Separate exact approval is not a source send;
an atomic approval+deposit remains money-moving. A cancelled client report or
expired quote cannot erase an issued attempt. Canonical finalized failure is
distinct from an unverified client failure.

Recovery includes the existing server-generated cancellation before action
issuance and closed embedded signing preparations that never reached server
admission. The synthetic cancellation marker is reserved against generic
executor reports. Closed embedded evidence must retain its exact owner and
have no admission fields, broadcast, reference or receipt. None of these
exceptions suppresses an earlier potentially executed attempt.

The reader uses a single-candidate step-ordinal/attempt-number cursor, an extra
sentinel and bounded receipt hydration. Resuming an exhausted step cannot hide
the following unstarted step or the next sentinel. There is no arbitrary total
history cutoff: dense histories can be continued by cursor. Page size comes
from the caller, not a new hardcoded product limit. A partial read explicitly
returns `incomplete`; concatenated mutable facts require a consistent snapshot
and must not be cached as a negative result across retries.

Verification: 371 combined native/refund/classification tests, three existing
embedded/lifecycle/persistence regression entries, API typecheck, scoped lint
and the full 16-package backend build passed. PostgreSQL 16 exercised actual
Base/Polygon committed plans, approval, synthetic cancellation, embedded
prepare→expiry/user-cancel, generic-marker spoof rejection and canonical source
receipts. Generic plans with 50,000 unrelated actions and 10,000 additional
attempts on one selected deposit used indexed ranges: dense first/next pages
read 52/51 attempts, 0.252/0.217 ms and 273/266 local buffers; a two-row resumed
tail took 0.079 ms/18 buffers. The exhausted-step boundary also passed at page
size one. These are local measurements, not production load certification.

Independent review gave a scoped GO after the cancellation, embedded recovery
and pagination fixes. This helper does **not** classify an event as external:
the final decision still requires current canonical source/settlement facts,
coordinated allocation locks, fair durable retries and the joint handoff/
destination/refund decision. Worker activation and P3/P4 acceptance remain open.

### Durable retry of already observed receive events

The existing finance worker now runs a bounded retry pass for the two existing
receive recovery reasons: `receive_session_allocation_unavailable` and
`owned_route_destination_correlation_pending`. It shares the ordinary worker's
batch size and polling delay. It does not scan wallet history, call a provider,
request quotes or resume an old Buy.

Migrations 0294–0297 add retry/binding metadata to canonical events and indexes
for due work and exact immutable receive envelopes. Claiming advances the indexed
due time and issues a new lease token before classification starts. A failed or
crashed claim therefore rotates rather than permanently monopolizing the first
page. The effect and acknowledgement validate the token and frozen target under
the existing scope → physical-event → session/operation lock order.

An unresolved owned destination freezes the selected receive session and start
variant, not whichever session happened to scan it. A bound event can finish
after its observation window without reopening that window, changing its cursor
or transferring it to a newer session. A direct late credit is available for
the existing receipt router; a non-direct credit requires explicit recovery and
does not start conversion or a child funding operation. Proven internal events
do not perform an unnecessary session lookup. Unbound legacy events may use the
normal current-session selector, but an expired unbound event is **not** assigned
an invented historical owner. That narrow legacy repair remains outstanding.

Verification on disposable PostgreSQL 16 includes 70 due events behind 50,000
leased rows, pages 25/25/20/0, crash/reclaim, stale-token rejection, concurrent
`SKIP LOCKED` claims, replay, a successor session and post-window direct/non-direct
recovery. The real receipt router performs zero planning calls for the late
non-direct case. Generic due/empty queries use indexes (0.423/0.027 ms locally).
With 50,000 unrelated completed sessions, bound lookup uses the primary key;
unbound, empty and wrong-decimal lookups use the exact-envelope GIN with full
residual identity/cursor/owner checks (0.044–1.099 ms locally). Malformed legacy
variant JSON does not make the index function fail. These are local regression
measurements, not production performance certification.

Independent review gave scoped GO after removing eager session binding and
adding the actual non-direct router regression. The combined 371 native/refund/
classification tests, 24 finance-worker tests, API typecheck, scoped lint and
the full 16-package backend build pass. The exact-refund reason
is deliberately **not** admitted to this retry queue yet: source continuation,
current source/settlement authority and joint role classification still need to
be connected. P3/P4 remain open, including the required sealed Telegram → app
handoff like Limitless; confirmation and signing belong in the existing app,
not Telegram automation.

### Exact handoff provenance and retry recovery

Deposit Wallet receive classification now distinguishes a possible handoff from
an exact physical transfer. A matching started attempt or unresolved relayer
request is recoverable pending evidence, not permanent internal suppression.
An exact internal result includes the operation and attempt IDs and requires
the existing canonical, action-matched receipt's `handoffEventIndex`; a hash
alone cannot suppress two equal logs during separate single-event retries.
Reorged receipt evidence does not supply that index.

The source read no longer performs a later lifecycle read for each started
attempt. That second snapshot could see a newly completed operation and discard
the attempt selected before its report, incorrectly releasing an internal
transfer as external. All reported outcomes remain eligible for correlation:
client `failed/cancelled` does not prove that a signed action never executed.
Only the existing exact server-created never-issued cancellation marker is
excluded, with matching step fingerprint/executor and no receipt. Its SQL
predicate is shared with the refund source-action reader. Every earlier attempt
remains relevant even when a later attempt has that harmless marker.

Migration 0298 widens the same due index to pending/unavailable handoff evidence.
The canonical receive binding is frozen before scanner advancement. Actual PG16
tests cover post-window exact resolution, a different resolved transaction,
decoder recovery, no additional scans, unchanged cursor/window, no child
conversion, client cancellation/failure, later synthetic cancellation, and real
receipt writer confirmation → reorg. Possible candidate/event ambiguities also
stay retryable: two equal pending logs can later resolve to one exact internal
log and one independent late recovery receipt. The PG regression retries each
log separately after the observation window, without a new scan or child
conversion. Exact-only conflicting proofs retain their conflict diagnostic;
pending evidence does not overwrite invalid-envelope diagnostics.

Independent follow-up review gave scoped GO after this ambiguity recovery fix.
The common receive/action persistence
suites, 371 native/refund/classification tests, API typecheck, scoped lint and
the full 16-package backend build pass.

### Indexed handoff lookup and Safe coverage

The follow-up source query replaces the full user-history lookup with three
indexed paths: the immutable transfer envelope, the current transaction-reference
HMAC, and the observed transaction hash. Migration 0299 supplies a compact
immutable envelope key; 0300 builds concurrent envelope/receipt indexes.
The digest is only an index hint: complete owner, network, token, source,
destination and amount comparisons remain mandatory. Malformed or oversized
legacy fields do not cause casts or index-entry failures. Lateral lookup barriers
prevent generic prepared plans from starting with the user's whole history.

Old-key encrypted references are decoded only for matching envelopes, not for
every historical operation. This deliberately narrows mismatch diagnostics:
a reference whose immutable transfer parameters differ is not proof of that
transfer. A matching immutable envelope remains visible across key rotation;
an exact receipt hash retains mismatch/reorg diagnostics even when the envelope
differs. HMAC matching is per event, avoiding a repeated whole-batch lookup.

Both Deposit Wallet and existing Safe handoffs now participate. The existing
Safe decoder handles controller and owned-wallet destinations. All ordinary
client failed/cancelled reports remain possible provenance. The only additional
exclusion is a closed server-owned Safe preparation with no admission fields,
reference or receipt and with matching step fingerprint/executor. Incomplete,
malformed or legacy metadata is not a never-issued proof. Exact never-issued
exclusions run **before** the candidate sentinel; filtering afterwards would
either strand harmless histories or hide a real later candidate. Independent
review caught that regression, and the corrected PG tests cover 300 synthetic
cancellations/closed preparations both with and without a genuine attempt.

On disposable PostgreSQL 16, the real generic query with 55,001 operations and
55,000 receipts examines 0–7 relation rows, uses 3–27 local buffers and takes
0.218–0.500 ms for sparse hit/miss, wrong owner, rotation, HMAC and receipt cases.
A 32-event batch uses 320 examined rows/1,184 buffers and takes 2.103 ms. These
are local synthetic measurements, not production load certification. Tests
also retain malformed normalized payloads for validation and reject invalid
Safe metadata without SQL exceptions.

Genuine candidate overflow now enters the existing durable retry queue with its
frozen receive target. Tests cover post-window recovery without another scan,
cursor/window changes or a child conversion. Current exact receipts for different
transactions can clear the candidate set; reorg or rebinding immediately restores
possible provenance. No receipt-derived negative is cached across retries.

Independent follow-up review gave scoped GO after the harmless-prefix and
per-event HMAC corrections. The three PG integration suites, 371 native/refund/
classification tests, receive/persistence units, API typecheck, scoped lint and
full 16-package backend build pass. No production data or financial action was
used for these checks.

**Still open:** dense source continuation. A long history of truly matching
envelopes still requires resumable bounded enumeration; the 257-row result
sentinel is not a bound on all examined source rows. This patch does not claim
that case is solved merely because the sparse/indexed cases pass. Historical
already-suppressed rows are not automatically reclassified. Joint refund/
destination/handoff classification and the remaining P3/P4 work are also open.
Passing these focused tests is not a deployment or complete P3/P4 verdict.

### Receive role conflicts and existing retry recovery

The ordinary receive observer now reads both existing roles (internal handoff
and owned route destination) before applying either effect. Two internal claims,
or one internal claim competing with a pending role, enter the existing frozen
receive-target retry queue as `internal_event_classification_conflict`. Migration
0301 extends its concurrent due index; it does not create a second queue.

Actual PG16 tests cover repeated unresolved attempts after the original receive
window, followed by handoff suppression or external late-recovery allocation.
They preserve the original session and observation cursor, create no conversion
child and do not restart an old Buy. Focused independent review gave scoped GO.
The 372 funding/refund/classification tests and the receive integration suite pass.

This is not yet complete three-role refund arbitration or a coherent snapshot of
all mutable financial facts. `operation.version` does not change for every source
attempt or receipt update; Relay status writers also update segments separately.
Dense continuation must not cache mutable negative evidence as an irreversible
exclusion. Exact-refund runtime integration and canonical reorg/remine authority
remain required before P3 completion.

## 27. Telegram app navigation checkpoint — October 14, 2026

The user's Telegram restriction concerns their personal Telegram account and
unattended execution, not the product's Telegram-to-app handoff. HIP must use
the existing user-confirmed app path like other venues. No personal Telegram
access or Telegram API requests were used for this implementation or its tests.

The private market-card issuer can now open a Hyperliquid market through the
existing Mini App `m_` navigation contract. Discovery filters, stored search
sessions and canonical-reference parsing include Hyperliquid. Card reads use
the same current `venue_lifecycle` discovery and environment policy as the public
HIP API, before loading the stored market. No canary allowlist or server-signer
grant is added. Raw IDs and pasted market URLs retain exact event/market identity;
a URL's validated YES/NO selection is preserved, with explicit card context
taking precedence. Ordinary non-HIP trading behavior remains unchanged.

Navigation runs before the bot-reconciliation gate and does not create an
executor, trade intent, funding reservation, consent or signature. The CTA says
"Open market in Hunch", not that an order is confirmed. This is a real navigation
issuer, **not completion of the sealed trading handoff**. The sealed venue lists
remain unchanged until HIP's ordinary P4 consumer can enforce a durable claim,
nonce admission, signing bounds, submission and exact order/fill recovery.

Independent review found and prompted fixes for the rendered filter omission,
custom-scheme parsing of raw HIP IDs, the bot-reconciliation dependency, and
selected-side loss in pasted URLs. Disposable PG16 tests exercise the actual
card issuer and Fastify route with reconciliation both on and off, unauthorized
access rejection, policy off/on recovery, unchanged Limitless fallback and no
trade intents. Frontend Telegram tests pass 183/183. No frontend redesign,
production enablement, commit or push is included in this checkpoint.

Final independent follow-up review gave scoped GO for navigation only. API
typecheck, scoped lint, ten targeted backend suites and the full 16-package
backend build pass. This does not close P3 or the sealed P4 trading handoff.

Follow-up search and navigation review also fixed three concrete integration
gaps: discovery must pass the effective HIP environment, HIP search results must
use the ordinary feed presentation (including quote freshness and independent
YES/NO books), and a warm app route must reset the selected side when the launch
target changes. Mobile also resets its trade-sheet state when `openTrade`
changes. Price ticks do not reset the draft. No separate UI or search ranking
was introduced; HIP volume remains explicitly labelled `24h` and does not become
lifetime volume for the existing total-volume ranking.

Real PG16 search fixtures cover both environments, policy off/on, stale data,
text and browse paths. They exposed an unused environment parameter in exact-ID
hydration; only the unused bind was removed, not the environment restriction in
candidate selection. Generic hydration plans on 20,000 unrelated rows use
indexed market/event lookups for populated and empty pages. Both navigation and
search integration suites pass. The full frontend suite passes 1778 tests;
the warm-route key guard is a source-level test, not a mounted-browser or live
Telegram test. Independent review gives GO for navigation only, not sealed
financial intent transfer or P3/P4 completion.

The October 15 follow-up adds ordinary `b_` ticket links beside the retained
`m_` browse link on active HIP cards. A focused YES/NO yields one review button;
otherwise both choices are explicit. Closed/settled cards retain browsing only.
These links open the existing editable app ticket, not a bot executor or sealed
intent. Suggested buy amounts from the common link contract now reach both HIP
forms without rounding or silently raising the amount. Warm launches with a new
amount reset the initial draft; price ticks do not. `tradeReview` does not yet
auto-open HIP confirmation. The P4 sealed consumer and actual submission remain
unfinished; do not widen its venue lists or claim trading from this navigation.

Verification: actual Fastify/card issuer in rollback-only PG16, policy off/on and
bot-reconciliation off/on; six backend regression suites; frontend 1,779 tests,
typecheck, scoped lint and exact Node 20 Turbopack build (42 pages). Independent
review gave GO for navigation/editable-ticket scope only. No Telegram API or
personal account was accessed and no financial action was performed.

## 28. Exact refund canonical watch — October 14, 2026

The existing finance reconciliation worker now verifies **already recorded**
exact refund receipts independently of Relay availability. This is not activation
of the new-refund discovery/writer path: joint receive/refund source authority is
still required before wiring that callback. No separate queue, executor, product
design or trading permission is introduced.

The watch runs before source/provider refreshes, with the existing normalized
batch limit and a deadline derived from the remaining reconciliation lease,
including claim time. An exhausted provider budget or deadline leaves the cursor
at the last visited receipt; it must not repeatedly starve the second receipt.
Incomplete pages and failed verification persist across the ordinary terminal
watch window. Only a complete fresh successful sweep clears that pending state.
This state controls scheduling, not settlement or spendability.

Base/Polygon verification reuses the exact ERC20 parser: transaction, log, token,
sender, recipient and raw amount must match. A different canonical block at the
old finalized height can invalidate its inclusion; a missing receipt or failed
RPC cannot. Exact re-mining restores the same observation and, atomically, its
quarantined physical-event anchor. Sorted physical-key locks precede operation
locks and raw-snapshot CAS. A concurrent remine makes the old RPC snapshot stale;
ordinary re-reading recovers without overwriting the newer proof. Migration
0302 permits only this narrow exact-refund recovery and retains legacy financial
immutability guards. Migration 0303 adds a concurrent source-pagination index.

Native verification reads the stored exact ledger second again and checks it
against the stored unsigned action, owner, DEX, token and amount. Missing,
truncated or invalid native data remains pending; the implementation does not
claim that absence in an info response proves a HyperCore reorg.

Tests cover partial refunds, replay, outage spanning the terminal window,
budget/deadline continuation, source/Relay timeouts longer than the lease,
stale CAS and re-mining. The real leased reducer retains pending work through
source-RPC failure and an expired source-reorg window; clearing pending restores
the legacy incident stop. Legacy composite/replacement-refund and two-session
writer/receive-lock regression suites remain applicable. All fixtures are local
to disposable PostgreSQL 16; no production state or financial action is used.

This checkpoint does **not** close dense source continuation, joint three-role
classification before allocation, historical suppressed/unbound repair, native
absence authority, inbound catalog/readiness or P4 trading/handoff execution.
The independent review is scoped to this watch, not P3/P4 completion or deploy.

Final checks: 380/380 focused native/refund/classification tests, eight targeted
legacy/sidecar suites, the HIP receipt PG16 suite and three legacy/concurrency
PG16 suites pass. Scoped lint and the full 16-package backend build pass.
On 50,000 synthetic rows, indexed watch pages take 0.340–0.469 ms, empty tails
0.034–0.043 ms; exact physical prelock takes 0.032 ms/5 buffers for a hit and
0.015 ms/3 buffers for a miss. These are isolated local measurements, not
production certification. Already-stopped jobs still use the existing global
evidence-only recovery scan/backoff; the active pending watch uses its own
existing reconciliation job. Neither recovery path starts a historical Buy.

Relay polling and verified webhook status writes now follow the same
operation-first lock order as receipt/reducer writers. A webhook's initial
bounded lookup selects the operation only; identity, replay and stale-status
decisions are re-read after that lock. Provider HTTP and receipt callbacks stay
outside the transaction. Actual two-connection PG16 tests verify that a waiting
writer holds neither request nor segment locks, that a previously fresh webhook
becomes stale when a newer status commits during its wait, and that a subsequent
fresh delivery succeeds. Generic plans on 50,000 isolated fixture rows use the
existing indexes for exact hits, wrong-provider rows and missing references.
This does not turn `operation.version` into a financial-fact revision: negative
attempt/receipt conclusions from an earlier source page still require current
authority before external receive allocation. No broad revision triggers or
new-refund activation were added in this lock-order correction.

## 29. Exact refund reverse lookup — October 14, 2026

The Relay client can now read one bounded `/requests/v3?refundTxHash=...` page
for an already observed Base/Polygon transaction. It validates explicit refund
chain/hash membership, preserves opaque continuation, rejects ambiguous or
malformed rows, strips unrelated fields and coalesces identical in-flight reads.
Completed responses, including empty pages, are not cached. Transport timeout
and response-size limits apply; distinct GET concurrency remains the caller's
responsibility (the client's existing concurrency gate is quote-only).

`relay-refund-order-lookup.ts` resolves a positive provider request through a
two-row, cross-owner collision check on the immutable protocol order ID. New
additive migration 0304 adds a non-unique concurrent expression index without
rewriting or rejecting legacy rows. The existing exact context loader decrypts
the committed request identity and retains its original HMAC/version across
lookup-key rotation. Neither a miss nor an exhausted provider page proves that
an incoming transfer is external: Relay request visibility is not global.

The receipt verifier now rejects an explicit conflicting EVM `refundTo` and
does not sum distinct same-owner/token Transfer logs within one transaction as
one order's return. Replayed identical logs and partial returns in separate
transactions remain supported. Native fallback deliberately keeps its original
source-side `refundTo`; its separately frozen recipient is bound by the native
action and ledger. Different-owner batches remain independent.

These are **read-only correlation primitives, not activation of the new refund
writer**. A single visible request or Transfer log is not exclusive attribution
for a potentially aggregated payment. Joint handoff/destination/refund role
arbitration must happen before allocation, including all stored sibling event
locks. Ambiguous shared transfers need supported per-order attribution; dropping
canonical logs is not a repair. Dense negative-source authority and full P3/P4
acceptance remain open. No historical Buy is resumed by this work.

Evidence: [Relay Requests API](https://docs.relay.link/references/api/get-requests)
documents targeted refund-hash lookup and pagination. The pinned
[RelayDepository contract](https://github.com/relayprotocol/relay-settlement/blob/b2f3e0e5fba9381293f030ef340ffb4872687fcf/packages/depository/packages/ethereum-vm/src/RelayDepository.sol)
uses the withdrawal CallRequest struct hash for `RelayCallExecuted.id`; it must
not be substituted for a deposit/order ID.

Verification: 331 native funding tests pass, including new reverse lookup and
recipient/shared-log regressions; API typecheck, scoped lint and the full
16-package workspace build pass. Disposable PostgreSQL 16 validates migration
0304, actual committed envelopes, HMAC rotation, wrong request/owner and order
collisions. Generic indexed plans on 50,000 synthetic rows measured
0.033–0.059 ms and 2–10 local buffer hits for hit/miss/wrong-provider/collision
cases. The HIP receipt suite and two legacy/concurrency suites pass. These are
local measurements, not production certification. Independent review found no
blocking defect in this disconnected slice; runtime activation is not approved.

## 30. Common inbound planner wiring — October 14, 2026

The production source planner now selects the existing validated native inbound
Relay adapter for Base/Polygon USDC → HyperCore spot USDC. Previously only native
outbound routes selected their adapter; inbound reached the generic EVM/Solana
quote path, which rejected a native destination. Source actions, reservations,
quote budgets, execution boundaries and economic limits remain on the common
funding path. This change does not enable any policy or send transactions.

The exact owned native controller is resolved independently of the EVM source
signer. Primary refund remains the source location; native fallback belongs to
the destination controller. Missing, ambiguous or wrong-network native ownership
rejects the route before provider reads. A zero native balance does not invalidate
an otherwise owned destination. Fee caps round down in source units: USDC6 for
inbound, USDC8 for outbound.

Offline tests exercise actual `ProductionFundingSourcePlanner.discover` for both
chains, including distinct source/destination owners, adjusted source capacity,
request and policy fee limits, slippage, ownership rejection/recovery and route
disablement. Expected-output discovery and the one-shot source-cap exact-input
fallback run through the production planner too: the fallback commits only the
validated source cap and retains its partial minimum output, not the requested
full amount. Provider responses are captured/synthetic; no live transfer is
claimed. Independent review approves this scoped wiring, not activation.

Verification: 333 native funding tests and seven common planner/Relay regression
suites pass. The expanded production inbound tests additionally pass independently
(11/11 in their file); API typecheck, scoped lint/format checks and the full
16-package backend build pass. No SQL changed in this increment, so these checks
do not add new database or live-provider evidence.

Still required: native fund-only preparation/readiness and policy catalog,
joint receive/refund runtime arbitration and repair, supported Solana directions,
and P4 prepare/sign/submit/cancel/reconciliation plus sealed Telegram → app trade
handoff. Ordinary Telegram market navigation/search is implemented (§27); it is
not the sealed financial handoff and does not enable an unattended bot executor.
P3/P4 and the active goal remain incomplete.

## 31. Common native fund preparation — October 15, 2026

The existing `WalletPreparationRuntimeService` now registers a HyperCore
**fund-only** driver after the unchanged Polymarket/Limitless drivers. It uses
the common purpose-aware adapter, canonical Account Value wallet/location
identity and existing owned-account reader; no new funding coordinator, signing
path or UI is added. Production activation remains closed until the outstanding
runtime work below is complete. No policy or permissions were changed.

Funding policy is checked before native account reads and cache reuse. Read,
account and funding revisions scope cached evidence; a policy/environment change
during the native read rejects that result. Disabling native funding does not
make generic Polymarket/Limitless discovery fail. Ordinary refresh can recover;
explicit `forceFresh` bypasses readiness reuse and a failed refresh cannot
resurrect the previous facts. Snapshot observation time is retained and readiness
expires no later than the underlying snapshot.

Known Standard spot cash is usable for this inspection even at zero balance.
A clean observed `missing/default` account is separately represented as an empty
funding recipient, never relabelled Standard or granted spending authority.
Unknown/stale facts, unsupported cash modes and wrong identities are not zero
cash. History-only refresh failures do not invalidate independently fresh cash.
BUY, SELL, withdrawal and redemption do not gain readiness from this driver.

Native availability reads active holds and canonical post-snapshot debits in
one SQL snapshot. It reuses the common started-action hold predicate: quote
expiry cannot free an ambiguous send, while a canonical debit replaces its hold
instead of being subtracted twice. Released historical component aliases cannot
restore cash from an older snapshot; a new snapshot already containing the
debit is not reduced again. Existing active reservation-mode semantics and the
old venues' SQL remain unchanged. No additional migration is needed.

Verification: 342 native funding tests, 34 preparation tests/entrypoints and
seven legacy preparation/policy/planner suites pass. API typecheck, scoped lint
and formatting, and the full 16-package backend build pass. Independent review
identified the reservation-accounting issue above and approved the corrected
fund-only slice. Disposable PostgreSQL 16 tests cover expiry, ambiguous send,
canonical debit, newer snapshots, released aliases, reorg, confirmed/unconfirmed
failure and consumer holds. Generic plans against 400,000 additional observations
and 100,000 additional reservations, with existing production-shaped indexes,
measured 0.191 ms/12 local buffers for a hit, 0.154 ms/7 for an absent physical
location and 0.106 ms/0 for empty input. These are local measurements, not
production certification; no live funding/signing test was performed.

The exact-refund writer now prelocks its complete verified physical-event set
before the operation lock and postpones quarantine until after revalidation.
If a concurrent partial writer changes that set, or its economic/canonical
evidence changes, the transaction throws a typed retry and rolls back every
prelock/effect. It never acquires newly discovered event keys while holding the
operation lock. Runtime reports the retry only after rollback; the next ordinary
reconciliation poll can finish without a cooldown or manual reset. Other
allocation/ownership errors are not converted into benign retries. An unchanged
replay still does not wake the worker.

This lock-order increment passed the actual two-connection PG16 tests, including
rollback of a newly inserted pending canonical row and next-poll completion.
The receipt regression also covers injected same-key anchor, amount, finality,
identity and native-proof changes, with recovery. The 342-test native suite,
scoped lint/format, API typecheck and full 16-package build pass; independent
review gave scoped GO (66 related offline tests passed independently). No new SQL
or migration was needed for that lock-order fix.

The subsequent writer-read change replaces all three whole-operation receipt
reads with exact segment/network/current-manifest lookups. The existing provider
manifest limit (64) is unchanged; two physical witnesses per hash are retained
before metadata filtering, so a collision cannot be hidden by choosing one row.
Completion checks the first N+1 canonical-final receipts of the entire segment
against N distinct proof members, including other networks and identities. This
is a bounded completeness witness, not a lifetime history cap. Partial receipts
remain durable; an omitted historical canonical receipt still prevents a false
completion. Arbitrary rotating-manifest completion is not newly supported.

The common allocator has an optional narrow refund return projection; its
default and every other caller retain the full row. Completion uses the actual
allocated rows, including replayed finality, and appends/reads one proof by its
fingerprint without transferring the whole accumulated audit map through JS.
Malformed/conflicting existing proof entries are not overwritten. PostgreSQL's
JSONB extraction/write cost still depends on the stored audit size; this is not
a constant-cost JSONB claim or a rewrite of lifecycle/history readers.

Migration 0305 adds one concurrent partial index, without historical rewrites or
data-dependent guards. It was applied only to disposable PostgreSQL 16. Generic
plans over 150,000 synthetic rows read at most two rows per referenced hash and
N+1 for the completion witness. A two-hash hit with a deliberately large audit
map took about 2 ms/26 local buffers; missing/empty cases 0.019–0.049 ms, and
single-proof point queries 0.67–1.03 ms. Local tests also cover existing default
projection, absent/malformed/large proof maps, no-op replay, canonical reorgs,
collision witnesses and extra receipts. These are local measurements, not
production performance certification. The 343-test native suite, five common
regression suites and the full workspace build pass. Independent review gave
scoped GO (67 related offline tests); real-schema receipt and concurrency tests
also pass. None of this enables a provider, policy or financial action.

Still required: effective-policy/catalog integration and runtime activation;
joint handoff/destination/refund classification before allocation with current
source authority and bounded repair; supported Solana directions and additional
native cash modes; P4 trading preparation, signing, submission, cancellation and
reconciliation. Telegram must hand off to the existing app trade flow like
Limitless, with exact intent and ordinary confirmation/signing, **not** run a
Hyperliquid auto-trader in the bot. Existing market-navigation links do not close
that sealed financial handoff. P3/P4 and the goal remain incomplete.

## 32. Recorded refunds in the common receive runtime — October 15, 2026

The existing receive observer now reads exact recorded refund evidence before
any receive/destination allocation. A verified recorded refund is suppressed as
an internal transfer, including replay. Handoff, destination and recorded refund
claims are arbitrated together; a conflicting or unresolved competing role does
not win by execution order. Marker-less legacy refunds and unmatched transfers
retain their existing path. A lookup miss is **not** a proof of externality and
does not enable the new-refund worker callback or native funding catalog.

Nonfinal/conflicting recorded evidence uses the same bounded, leased canonical
event retry queue. Migration 0306 extends its concurrent partial index. Retry
retains the frozen receive target after the observation window, without scanning
new history, creating a conversion, or reviving an old Buy. Only exact refund
suppression can transition into these narrowly scoped recovery reasons; other
internal suppressions and allocated events retain their protections.

Independent review caught a recovery interaction: pending classification could
prevent a re-mined refund from updating its block anchor. The watcher and additive
migration 0307 now allow anchor repair in these pending states while preserving
the reason and requiring the existing reorged, exact economic receipt. There are
no historical row rewrites or data-dependent migration assertions.

The PostgreSQL fixture exercises the actual writer/recorded reader/receive path
on Base and Polygon: suppression → watcher reorg → pending receive → expired
retry → watcher remine in another block → suppression. No external receipt is
created. Additional tests cover role conflicts, continuing ordinary deposits,
unresolved retry, legacy compatibility, and generic indexed SQL plans.

The refund writer also checks known competing handoff/destination roles before
effects, using the shared readers. This is positive-evidence arbitration, not
complete receive-first pending-source attribution: legacy negative authority
and the race with publication of a competing role remain unresolved. These must
be closed before discovery activation, followed by the remaining P3 routes/cash
modes and P4 execution.
Final goal acceptance additionally requires **two consecutive independent,
no-history reviews of the complete implementation with GO verdicts**. Scoped
increment reviews are not substitutes; any corrective changes reset that final
acceptance sequence.

## 33. Durable unsigned P4 preparations — October 15, 2026

The protocol-only P4 building blocks now include SDK-ordered MessagePack action
serialization, Agent EIP-712 signing envelopes and signer binding, exact BUY/SELL
rounding and fee/debit bounds, a shared one-shot exchange transport, and strict
single-action reply classification. The funding SendAsset path reuses the same
transport without changing its admission contract. Timeout, malformed response,
ambiguous cancellation and unknown native errors require reconciliation of the
same identity; an ACK or fill summary is not execution/accounting evidence.
There is no automatic retry with a new nonce, cloid or purchase.

Migration 0308 adds `hip4_order_actions` as protocol metadata below the existing
`orders` table. It widens the order venue/TIF checks additively, without validating
or rewriting historical rows. The existing signer/environment nonce namespace
now has an exclusive funding-step OR order-action owner; existing claims remain
immutable. A trade is not represented by a fake FundingOperation, nor is the
reservation-backed `funding_trade_attempts` contract weakened for direct trades.

Internal persistence supports unsigned mainnet BUY/SELL and cancel-by-cloid:

- A prepared order has exact decimal strings, a server-generated cloid, frozen
  amount/fee/policy/account/market context and a shared nonce claim. It has no
  venue order ID, signature, fill, consumed reservation or network submission.
- A semantic request-key retry returns that same record before applying a newer
  policy/quote. Changed request payload conflicts. UUIDs are normalized before
  hashing/locking; casing alone does not create a different request.
- Ownership uses the existing controller-wallet lock. Cancellation has its own
  nonce and the same economic order/cloid; it does not depend on a BUY cash floor
  or the market remaining ACTIVE, and preparation does not release held funds.
- Binding fields are immutable. Abandoned preparations cannot be revived.
  History cleanup preserves these records; retention reports their exact market
  references. The reader detects this new table independently of older HIP
  account tables. Ownership follows the existing order reparent during merge;
  unsigned preparations are protected evidence, not active money in flight.

These are **internal persistence boundaries, not a public prepare/submit API**.
Current-policy/fee/capacity admission, durable submission states, external
nonce handling, reconciliation, actual trade-registry/API/UI integration and
sealed Telegram app trade consumption remain required. The native signing
helper alone does not authorize or enable any of them.

The Relay status writer also retains role-specific positive destination hashes,
independent of HMAC key rotation and newer sibling lifecycle timestamps. A
successful destination observation is not erased by a later sparse/refund
status. Mixed-role legacy HMACs still follow the lifecycle watermark and cannot
be appended from a rejected stale status. This does **not** prove absence for
old HMAC-only history or close the competing-role publication race. Generic
same-owner history lookup at 5,000 legs still scans linearly; its measured
roughly 160–410 ms and 175k+ local buffer hits are not performance acceptance.

Verification so far: PG16 migration and real unsigned order/cancel/replay,
ownership, merge, immutable binding, history cleanup, two-connection commit/
rollback retry, Relay ordering and generic-plan tests. The preparation lookup
at 50,000 records is indexed (about 0.04–0.07 ms in the isolated fixture).
The status writer regression covers newer success then older refund, plus a
request-local rejected update. The final PG run also exercises an actual
synthetic funding commit claiming a nonce before a trade tries to claim it:
the trade rejects and its transaction rolls back. Unit suites passed 343 funding,
60 order/signing/reply, and 2 destination-reference tests. API typecheck, scoped
lint and a full 16-package backend build passed; the checkpoint records the
last post-fixture build result. No production settings, live
signatures, transactions, personal Telegram, commits or pushes were performed.

P3/P4 remain incomplete. Final whole-implementation no-history GO acceptance:
**0/2**. Scoped reviews of these primitives do not count toward goal closure.

## 34. Durable P4 admission and common funding holds — October 15, 2026

The internal submit boundary now commits a single native action admission before
one exchange POST. Migration 0309 stores this below the existing order, and 0310
requires a complete debit identity. Lost responses/processes retain the exact
action for reconciliation: retry cannot submit another purchase. Signatures are
verified against the immutable preparation but not persisted. A response summary
does not create executions, confirm financial settlement, or release a parent
order's funds after cancel ACK.

Funded BUY claims the real common funding trade attempt and consumer reservation
in the admission transaction. Direct BUY/SELL does not create a fake funding
operation. Admission verifies the exact destination controller, current common
venue lifecycle, frozen debit authorization, and PostgreSQL wall-clock expiry
after lock waits. It uses the same physical-source lock as native funding. Native
withdrawal capacity now includes admitted order holds; the same consumer reserve
and admitted order are counted once. Known first-response rejection restores
capacity; ambiguous responses remain reserved for reconciliation.

Account deletion/merge protection includes admitted or uncertain native actions.
Cancellation remains possible independently of BUY cash and an ACTIVE market,
but bot/worker submission is not permitted. Product Telegram-to-app handoff must
still reach the existing confirmed application trade flow, never bot execution.

PG16 tests cover real common funding claims, rollback, distinct owned wallets,
BUY versus native send contention, duplicate/concurrent submission, crash after
admission, stale signatures after lock waits, cancel ACK, and merge prevention.
The unsigned and submission lookup plans use indexes at 50,000 records. Funding
units (343), order/signing/reply units (60), API typecheck, scoped lint and the
full 16-package backend build passed. A malformed test-only second-wallet
fixture was fixed and the submission/lifecycle PostgreSQL suites rerun.

This remains an **internal boundary, not completed public trading**. Production's
shared HIP financial implementation ceiling remains closed; only tests inject
future capability support. Fresh runtime fee/capacity/policy resolution, actual
registry/API/UI integration, exact order/fill reconciliation, funded acceptance,
balance-snapshot debit inclusion and final hold release remain required. The
current conservative local hold is not a complete production spendability model.
P3 refund-role/legacy-identity recovery, dense history performance and catalog
activation also remain open. No deployment, real signing, financial actions,
production policy changes, commits or pushes occurred. Whole-implementation
independent no-history GO acceptance remains **0/2**.

## 35. Indexed common destination correlation — October 15, 2026

The shared receive/refund destination classifier no longer starts with all past
operations owned by the recipient. Additive concurrent migration 0311 indexes
stable positive destination hashes, compatible legacy reference arrays, and
unresolved route owners. Candidate discovery unions these lanes; the same
operation/network/asset/decimal/recipient/native cash-class checks still run
before ambiguity ranking. Duplicate formats for one segment count once. Exact
matches retain precedence over merely possible routes, including terminal
positive references and current-HMAC legacy compatibility.

Primary-key lateral lookups prevent generic plans from reintroducing owner-wide
history scans. Enumerating the actual input-array positions exposes batch
cardinality without interpolating payloads or truncating candidates. Missing
references remain subject to the pre-existing classification contract: this
optimization does **not** prove external provenance, repair old HMAC-only
negative authority, or resolve concurrent publication of a competing role.

Actual PG16 generic/custom fixtures contain 50,000 routes, 5,000 for the same
owner, and populated 64-character references. Single-event lookups measured
about 4–5 ms and 160–396 local buffer hits versus the earlier 170–400 ms and
175k+ hits. Empty-input plans use no table buffers. Assertions bound inspected
historical rows, not merely returned rows. Dense and sparse 1/16/64-event batches,
legacy-only/overlapping formats, large legacy counts, numeric legacy entries,
cross-owner hits, recipient mismatch, exact ambiguity, and ready exclusion
passed. Sparse batches of 64 still measured roughly 0.8–0.9 seconds, dominated
by JIT compilation; no timeout/JIT setting was changed to hide this cost.

The common receive persistence and refund concurrency suites, P4 submit suite,
profiled funding/order units, scoped lint/typecheck and full 16-package backend
build passed. The migration ran only against the isolated PostgreSQL16 fixture;
all three indexes were confirmed valid and ready. A first migration attempt
caught the runner's semicolon splitting inside a SQL comment, before DDL; the
new comment was corrected and migration rerun successfully.

The separate AccountValue settled-refund history projection still reads full
history (about 178 ms SQL / 433 ms projection for 5,000 fixture legs). This is
not fixed by destination indexes. Public financial activation and remaining
P3/P4 gates in section 34 remain open. Whole-implementation no-history GO: **0/2**.

## 36. Shared financial observations and BUY policy — October 15, 2026

Native funding sends and internal order capacity now use one fresh observation
reader: the same common venue lifecycle, shared request budget, exact native
USDC identity, role and Standard spot-mode checks. It does not use cached
AccountValue, infer balances from fills, or perform provider IO under admission
locks. Freshness starts before IO. SELL selects only the requested outcome's
unheld shares; borrowed or supplied inventory on that side is not spendable.
Restrictions on another outcome do not block a valid owned position.

`hip4_trading` owns the configurable BUY notional minimum, with default `1.00`.
The protocol floor remains separate. The existing admin policy editor validates
the merged policy; no new activation switch or UI design was introduced. The
financial reader is uncached and rejects invalid/unavailable policy rather than
silently lowering the threshold. Only absent override selects defaults. SELL
and cancel do not depend on this BUY-only setting. Existing authorized retries
return the persisted result even if policy has since changed.

Preparation and admission resolve policy on the server. Admission rechecks it
after all blocking locks so a scheduled revision cannot be bypassed while
waiting. A refreshed SELL fee larger than its frozen preparation is rejected
without creating a hold; fresh preparation is the recovery path. The current
internal fee input still needs the production fee resolver and complete
execution accounting before public wiring or activation.

Four disposable PG16 suites passed, including scheduled policy activation during
an actual lock wait, invalid-policy repair, SELL independence, fee consent and
the existing native-send/common-funding regressions. The real runtime policy
query was checked with 55,000 rows under custom and generic plans: indexed
hit/miss queries took 0.009–0.022 ms and 3–4 local buffers. Its SQL is unchanged;
strict missing-table behavior is opt-in for financial callers, preserving other
runtime-policy readers. No migration was added in this increment.

Offline order/signing/financial-policy tests passed 72/72, funding 343/343, and
the common admin-policy test passed. Full backend workspace build passed 16/16;
admin build, 47 tests and lint passed. Scoped independent no-history review gave
GO for this increment after correction of lock-wait revalidation and exact-side
debt handling. That is not a whole P3/P4 review: final acceptance remains **0/2**.
No production policy, signing, trading, Telegram account, commit or push changed.

## 37. Current fee terms and final lifecycle admission — October 15, 2026

The existing budgeted native account client now supports typed `userFees` reads.
A trading-only reader combines those facts with exact-market `outcomeMeta` and
verified native USDC metadata. It retains scope, observation start time, expiry
and revision. It does not add fee queries to funding sends or use a cached
portfolio to authorize a trade. These reads remain outside financial transactions.

The exact-decimal quote follows the pinned mainnet rules in sections 18–19:
known zero opening fees under the no-builder action contract; current spot
maker/taker rates, positive-rate referral discount once, outcome scales and
zero rather than a negative maker rebate. Without current alignment evidence,
the rate bound explicitly does not apply the possible alignment discount. It
does not assert that USDC or future quote tokens are unaligned. Missing closing
terms are unavailable, not zero; they do not invalidate a known free opening.

IOC assumes taker, ALO maker, and GTC the larger current rate. The quote separates
the current rate bound, fee estimate at the limit, and estimated net proceeds.
The native order has no enforceable lifetime base-fee cap: GTC can outlive the
observation, SELL price improvement changes notional, and aggregate rounding is
not proof of per-fill rounding. `lifetimeFeeCapRaw` is therefore null. Actual
execution fees remain the accounting source. Builder and funding charges are
not silently folded into this estimate; builder fields remain disallowed.

Internal preparation can now freeze this server observation and quote. Admission
recomputes from the stored signed action and refreshed terms, rejects a higher
current rate or missing/stale observation, and preserves owned result replay
before refreshing policy or provider data. In this path SELL has no monetary
`feeCapRaw` or guaranteed `minimumNetProceedsRaw`; separately named estimates
replace those meanings. The old internal raw-cap fixture seam is retained for
compatibility, not exposed as a client-controlled fee path.

Common venue lifecycle is also re-read after blocking locks for BUY, SELL and
cancel, with the final revision persisted. Actual two-session PG16 tests exercise
scheduled disabling during admission, no new hold/POST on failure, owned replay
after disabling and recovery after policy repair. Fee-observation tests cover
both sides, increased-rate re-review, missing/stale terms and unchanged replay.

This is not public financial activation. The common executor/API/UI caller must
still obtain these observations after ownership and before opening a transaction,
without fetching before an already-submitted replay. Exact fill reconciliation,
common consumer completion, native hold release and the sealed Telegram-to-app
trade handoff remain required. No new fee table, alternate funding engine,
client design or production policy was introduced. Final whole-implementation
independent no-history GO sequence remains **0/2**.

Verification: offline order tests 79/79 and funding tests 343/343 passed; the
final full backend workspace build passed 16/16. Disposable PostgreSQL16 also
verified expiry during a real action-row lock wait and recovery using fresh
same-rate facts, alongside the existing native funding/preparation/admission
regressions. Scoped independent review found no blocking defect and separately
ran 103 offline tests successfully. This is an increment-level GO only, not one
of the two required final whole-implementation reviews.

## 38. Server-owned submission context — October 15, 2026

The internal runtime submit entry accepts only authenticated user identity,
prepared action ID, client signature and optional funding operation/reservation
IDs. It resolves current fees and capacity through the existing budgeted native
readers, and the confirmed funding intent through the common reservation reader.
Client-supplied profiles, fee caps, observations and reconstructed actions are
rejected. Preparations from the old raw-cap test seam require fresh preparation
before entering this runtime path.

Owned durable replay happens first, before current lifecycle, controller,
provider observations or funding readiness. A consumed reservation therefore
does not make a previously submitted result disappear. The same lookup is
repeated inside locked admission, which remains the sole funding claim/start
writer. A bounded reread also recovers another request's committed result if
observation fails concurrently. No new claim/release wrapper or resend is added.

The frozen profile is only an identity hint: the common controller-wallet
predicate verifies it before private reads and locks it again at admission.
Independent review found a merge race between the unlocked action and submission
lookups. Submission lookup now joins the owned order in the same statement; the
test reparents the order exactly between reads. Cancellation reads no provider
balance or fee terms. ACKs still do not create fills or release native holds.

Five disposable PostgreSQL16 suites passed: common funding action persistence,
native send admission, order preparation, runtime submission and locked order
admission. They include real commits, concurrent one-POST behavior, consumed
funding replay, owner-change recovery, request-budget expiry/retry and max=1 pool
operation with real budget SQL and mocked provider transport. Fixtures now also
satisfy deferred source-reservation constraints at commit and contain canonical
unified tokens. No production DDL or provider financial request was performed.

At 50,000 synthetic rows, custom/generic controller lookups used 2–3 local
buffers in 0.027–0.066 ms; ownership-filtered submission lookups, including wrong
owner and missing action, used 1–9 local buffers in 0.025–0.058 ms, without
sequential scans. Full backend build passed 16/16, order units 79/79 and funding
units 343/343; common trading/delegated-funding regression suites and scoped lint
also passed. Independent no-history scoped review gave GO after the race fix,
and separately ran 15 fee/capacity tests. This is not final P3/P4 acceptance.

Remaining: production preparation/context and common executor/API/UI wiring,
exact order/fill reconciliation and consumer completion, proved hold release,
sealed financial app handoff, and the P3 recovery/route gaps recorded above.
Public financial capability remains off. Whole-implementation no-history
consecutive GO count is still **0/2**; no commit, push or deployment was made.

## 39. Common trading adapter and current preparation — October 15, 2026

Superseding the preparation/registry gap in section 38, native quote, prepare,
submit and execute now have a Hyperliquid adapter in the existing API trading
registry. `SupportedBotTradingVenue` remains unchanged. The durable client-signed
dispatch runs before the generic funding wrapper: the native admission is still
the sole atomic common funding-attempt owner. Existing venues retain their path.
Public financial capability remains off; HTTP routes and client integration are
not yet connected to this increment.

The selected verified controller resolves through the same ownership primitives
and stable wallet identity as funding, without loading unrelated portfolios.
Quotes and preparation share exact decimal/raw terms; quote does not create an
order or nonce claim. Invalid amounts are rejected before provider IO. Current
fee/capacity reads run outside transactions. Actual fee terms are applied again
at persistence, and a PostgreSQL wall-clock fence after all action/nonce writes
rejects expiry during lock waits. Rollback leaves the request key available for
ordinary fresh retry. Successfully stored preparations remain immutable on
idempotent replay, even after expiry: a new review uses a new request key.

Submission accepts the stored action and client signature, not a reconstructed
mutable payload. It returns the original economic order with no invented fill,
referral, position mutation or consumer release from a resting/fill-summary ACK.
Unsupported generic broadcast-management callbacks are rejected before IO;
failure of the post-submit notification callback preserves the durable result.
No wallet signer, alternate funding engine or automatic Telegram execution was
added. Product Telegram-to-app financial handoff remains a separate unfinished
consumer of this common path; personal Telegram is untouched.

Verification: five final disposable PostgreSQL16 suites passed, including real
market/nonce lock-wait expiry and same-key recovery; common quote → prepare →
concurrent funded submit; one provider POST and one funding attempt; replay after
policy disabling and consumed funding; and callback failure without resend.
Full backend workspace build passed 16/16, order units 79/79, funding units
343/343, common trading/delegated-funding regressions, scoped lint and diff checks
passed. Independent scoped preparation and fresh no-history adapter reviews gave
GO; the latter independently ran 26 arithmetic/fee/reply tests. These are NOT
the two required final whole-implementation GO reviews: that counter is **0/2**.

Next: exact cloid/oid order reconciliation with verified fills and common
consumer/hold accounting; production cancel preparation, HTTP/UI and sealed app
handoff; then the unresolved P3 recovery, route and bounded-history gaps above.
The native order-status contract must use the exact account and oid/cloid;
`unknownOid` is not proof of no execution, and time-range fill reads have finite
history/response coverage ([official Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid)).
No production calls, permissions, signing, transactions, commit, push or deploy
were performed. P3/P4 and the goal remain incomplete.

## 40. Native order observation in the existing finance worker — October 15, 2026

The existing account-observer job now also reconciles admitted native orders.
It shares the same pool, single-flight scheduling, provider budget and account
resource policy. It never signs, resubmits or creates a replacement purchase.
Already admitted recovery continues when common venue policy disables new reads
or exposure; discovery environment changes cannot move a stored mainnet order
to testnet. General account reads still respect their normal lifecycle gate.

Exact `orderStatus` reads use the frozen account and cloid, with documented
weight 2. Coin, order ID, side, limit, quantity, original time and known native
status are checked against the immutable preparation. An unknown order is not
absence proof. A retained exact terminal status can support later positive-fill
repair without claiming a new provider status observation. Late submission ACKs
cannot overwrite an order that has advanced to reconciliation.

Bounded `userFillsByTime` pages write the existing P2 execution ledger, not a
second financial ledger. Their cursor is retained on the existing submission
observation, after execution facts commit. Restart/replay deduplicates facts.
Repair resumes the frozen order interval independently of the general account
lookback; timestamp saturation and provider retention remain explicit. Targeted
fill reads preserve the ordinary balance-attempt time and balance/error facts,
so they cannot postpone or manufacture an account snapshot.

Only exact full quantity with known fee accounting completes the existing common
funding consumer. Partial history, unknown fee denomination, conflicting fills,
finite-window exhaustion, cancel ACK and `unknownOid` cannot release funds.
Native debit holds remain retained: balance inclusion, remaining quantity and
safe hold release are the next unfinished accounting step. No public financial
capability was enabled.

Independent review found that always running order repair first could starve P2
history at the default 600-weight budget. The same job now alternates phase
priority per actual pass; a timeout's single-flight replay does not rotate it.
Already fully observed, fee-known orders skip expensive history rereads while
retaining cheap status and exact-ledger checks. Both phases remain bounded by
the unchanged shared budget.

Verification: seven disposable PostgreSQL16 suites passed, covering ordinary P2
history/worker recovery, native preparation/submission/runtime, exact observation
and interrupted concurrent-index retry. Real two-connection tests cover a stale
worker resuming after lease replacement and an ACK waiting behind observed fills.
Actual combined worker passes at 600 weight advance both histories in alternating
priority order. The new exact fill query used 2–23 local buffers at 100,000 rows;
the 50,000-row due queue used 4–27 buffers, including generic and empty-tail plans.
The older P2 account-selection plan also exposed a sparse-queue LIMIT row-goal
failure: 740,147 ownership join rejections at only 10,000 unrelated snapshots.
It now uses the existing normalized-wallet index and materializes owned/due
eligibility before the final locked LIMIT. Due/lease predicates are checked again
at the final row; current ownership is still checked before each provider read.
At 100,000 unrelated snapshots, custom/generic first/empty plans used 228–252
buffers in 0.23–0.61 ms. Mixed-case EVM ownership, concurrent leases, unlink and
policy-off recovery passed again. This is disposable-database evidence, not a
claim of production-plan verification across every ownership distribution.

Order units passed 87/87, native funding units 343/343, finance-worker tests 24/24,
scoped lint and formatting passed, and the full backend build passed 16/16.
The independent no-history observer review accepted the scope after the fairness
fix and independently verified 16 evidence/history tests. This is not one of the
two required final whole-implementation GO verdicts; that counter remains **0/2**.
P3 recovery/route gaps, P4 hold accounting, production cancel/API/UI and sealed
Telegram-to-app financial handoff remain unfinished. No personal Telegram access,
production mutation, financial provider request, commit, push or deploy occurred.

## 41. Terminal order capacity and shared funding availability — October 15, 2026

Native order holds now participate in the existing funding-preparation/shortfall
and Account Value availability calculation, as well as final order/native-send
admission. The existing funded-consumer reservation is replaced by its admitted
order exactly once; unrelated funding holds and post-snapshot native debits stay
in the same SQL snapshot. A failed availability read produces unknown capacity,
not apparently free cash, and does not erase owned asset value. No new ledger,
funding route, policy switch, financial capability or schema migration is added.

An exact native terminal status records a separate local response barrier.
Only a server-owned account snapshot whose request started strictly after that
barrier can exclude the terminal order's local hold. Equality, overlapping slow
reads, missing/legacy/malformed metadata, open orders and ambiguous submissions
retain the hold. A contradictory status invalidates inclusion; successful exact
repair establishes a new barrier, so intervening snapshots cannot use the old
one. `unknownOid` neither advances the barrier nor repairs invalidation.
Cancellation ACK and empty bounded fill history still do not prove no execution.
Funded-consumer completion remains separate and based on verified execution facts.

Status and invalidation now commit under the existing locks and lease fence
before bounded fill repair. A fill HTTP failure or lease expiry cannot erase
that durable status. The subsequent fill transaction remains lease-fenced; an
old claimant cannot restore inclusion or consume the reservation. No provider IO
was introduced under the financial transaction locks.

**Trust boundary:** this is API-observed capacity, not block-proved inclusion.
The [official API server contract](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/api-servers)
describes node-derived state; the [spot balance response](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)
does not provide a block cursor. The existing native funding read model trusts
sufficiently current official provider state. Sequential local timestamps do not
prove monotonicity across lagging replicas. No arbitrary waiting period or fill
coverage gate is presented as fixing that limitation. Public trading remains off;
this checkpoint does not claim protection against arbitrary provider replica lag.

Verification includes PG16 terminal/equal/overlapping snapshot cases, contradiction
and repair, malformed legacy metadata, BUY/SELL/native-send admission boundaries,
and one-time consumer-hold replacement in preparation. Actual observer transport
tests assert committed status before a failed fill request, then committed
invalidation despite lease expiry; no fill is fabricated from terminal status.
Account Value failure/recovery and original-snapshot propagation are unit tested.
Order tests passed 88/88, native funding 344/344, and cash/portfolio tests 25/25.
Common Account Value, preparation, planner and delegated-execution regressions
passed. After strengthening the failure-path assertions against exceptions caught
by production code, the actual PG16 observer suite passed again, all 17 scoped
files passed lint, and the full backend workspace build passed 16/16. The scoped
reviewer verified both test corrections; this is not whole-goal acceptance.

The additional dense P2 queue fixture exposed a generic-plan scan of unrelated
snapshots. Correlated exact-key lookups now retain their planning boundary; sorted
candidates are tried before the final locking `LIMIT`, so a locked first candidate
does not hide the second. Actual two-connection `SKIP LOCKED` recovery passed.
With 100,000 unrelated snapshots, sparse plans used 247–271 buffers in 0.27–0.49 ms;
with 10,000 enrolled accounts, all-due/one-due/empty plans used 70,506–110,298 buffers
in 32–53 ms in the update-heavy disposable fixture. This selection still scales
with enrolled ownership; it is not claimed to be constant-time or production-tested.

The 50,000-terminal-order same-account hold fixture used 4,699–17,198 total local
hit/read buffers in 56–81 ms for custom/generic empty/sparse-pending cases. This is
linear terminal-history filtering, not an indexed history-pruning claim. Existing
sparse native availability/debit plans and financial recovery suites passed.

Scoped independent reviews found no blocking implementation issue under the
stated API-read trust model. They are not final whole-P3/P4 acceptance: **0/2**.
Open-order hold inclusion/fee accounting, terminal partial/no-fill consumer
closure, production cancel/API/UI, sealed Telegram-to-app financial handoff and
the earlier P3 recovery/route/performance gaps remain. No personal Telegram,
live financial submission, production mutation, commit, push or deploy occurred.

## 42. Shared cancellation and partial consumer acceptance — October 15, 2026

The existing trading application service now has optional adapter cancellation
methods. HIP prepares a sign-only cancellation for the owned existing economic
order, preserving its exact account, asset and cloid. It shares the same nonce
registry, one-shot server submission and durable replay as native orders. There
is no new funding engine, autonomous signing or replacement UI. Existing venue
cancel handlers are unchanged; unsupported adapters do not enter this new method.

Cancellation uses common venue `cancel` capability (including `exit-only`) and
current controller ownership, rechecked at submission. Closed-market state,
unavailable price/balance/fee reads and malformed BUY minimum do not block exit.
Its explicit policy-owned signature lifetime is frozen in the unsigned action;
bad lifetime configuration prevents new preparations, while valid replacement
restores them. Replay returns the stored action without renewing authorization.
A signed BUY action or another order cannot be submitted through the cancel
method. A cancel ACK leaves the economic order and native/funding holds alone.
Public HIP financial capability ceilings remain off; HTTP/UI integration and
cancel-result reconciliation are still outstanding.

The shared funding contract completes when the exact consumer purchase is
accepted, not only when all its shares have filled. HIP now consumes its linked
funding reservation on a positive, fully validated P2 execution, including a
partial fill or an unknown fee denomination. All exact identity, price, quantity,
time, projection, conflict, ownership and live-lease checks remain. This does not
assert complete history, known fee accounting, no-fill, terminal order state or
free cash. The independent native order hold and bounded history repair continue
after funding acceptance. Empty/overflow/conflicting evidence cannot newly accept
the consumer. This removes the indefinite wait for a permanently partial order.

PG16 tests passed for common cancellation with concurrent retry, ownership and
policy recovery, closed market, unchanged funding-attempt count and exactly one
mocked exchange POST. The 50,000-row owned-order lookup used indexes for custom
and generic hit/miss/wrong-owner cases (0.025–0.070 ms, 0–6 local hit buffers).
Observer/submission integration tests passed for partial-open, partial-canceled,
unknown-fee and idempotent acceptance, retained native holds and continued repair.
The scoped independent cancellation review found no concrete regressions and
independently ran 55 policy/signing/reply tests. Full order units passed 89/89 and
native funding units 344/344. The final backend workspace build passed 16/16;
all 16 scoped files passed lint and formatting. Common funding-persistence,
trading-service and admin-policy regression suites passed 3/3 after these edits.

This is not whole-P3/P4 acceptance: **0/2 final independent GO reviews**. Remaining
work includes open-order hold inclusion, no-fill/terminal and cancel recovery,
HTTP/OpenAPI/existing UI plus sealed Telegram app handoff, and the earlier P3
refund/route/performance gaps. No personal Telegram access, real financial action,
production changes, commit, push or deploy occurred.

## 43. Native acceptance, definitive rejection and lifecycle — October 15, 2026

This supersedes the consumer-completion rules in sections 40–42. Common funding
tracks acceptance of the exact purchase, not completion of every fill. A freshly
validated native `open`, `filled` or explicitly accepted cancellation status can
complete that consumer even while history is missing or repair is unavailable.
Validated positive executions remain a compatible acceptance path. Native
placement rejections are a distinct explicit taxonomy, not all terminal statuses.
Unknown/malformed responses cannot accept or reject a purchase. Retained terminal
evidence is reusable only with a valid, non-invalidated observation barrier.

An exact definitive rejection can now resolve an ambiguous common attempt and
release its linked reservation through the existing funding repository. A known
initial rejection/no-fill ACK uses the same release path. Neither changes past
broadcast facts or creates a replacement purchase. The exact status writer checks
immutable action/owner/funding identity and its live observation lease. It locks
the same P2 account row before checking for conflicting executions, so an in-flight
P2 writer cannot race rejection into a false release. Contradictory rejection does
not become trusted terminal history: the previous trusted status is invalidated
or remains absent, and a subsequent correct accepted status can repair it.
Cancel ACKs alone still neither prove zero fills nor release cash.

Native lifecycle checks no longer consider every non-rejected submission active
forever: the original order's validated terminal barrier distinguishes ongoing
exposure from retained evidence. Cancellation-only records do not create new
exposure. This does not claim complete fill/fee history. Other funding, receive,
preparation and merge protections are unchanged, including the common prohibition
on merging accounts with funding trade attempts.

Testing real terminal-order merge exposed a pre-existing wallet-copy failure under
global wallet uniqueness. Shared merge now moves the existing wallet and credential
rows in one statement, preserving stable wallet/profile IDs and FK validity.
Cross-type exact-address collisions roll back explicitly; primary-wallet selection
and dry-run semantics remain. An already-claimed observer cannot write with an old
owner after merge; the new owner's normal repair succeeds. The merge-success
fixture intentionally has no common funding attempt; funded races are separate.

Disposable PG16 observation, submission and wallet-merge suites passed 3/3. They
cover real two-connection execution/rejection and stale-worker races, exact accepted
and rejected recovery, the unchanged one-POST boundary, keepSource/dry-run and
stable wallet identity. Exact rejection-proof custom/generic plans on 50,000 rows
used 1–8 buffers in 0.026–0.035 ms; conflict checks on 100,000 fills used 3–4 buffers.
Wallet move/conflict plans used 2–50 buffers, including empty tails. The lifecycle
exposure query still scans same-owner history: at 50,000 terminal orders it used
450,447 buffers in 444–502 ms; sparse pending cases used 143,603 buffers in 149–154
ms. This is recorded performance debt, not production performance acceptance.
No new migration was needed for this slice. Order units passed 90/90 and native
funding units 344/344; common merge/persistence/trading regressions passed 3/3.

## 44. Ordinary authenticated venue HTTP boundary — October 15, 2026

The server registers `/trade/hyperliquid` beside the existing private venue routes:

| POST suffix              | Contract                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/orders/quote`          | Exact share quantity, limit/TIF, side and controller reference; current fee terms and explicitly pre-Hunch-hold provider capacity; no order/nonce created |
| `/orders/prepare`        | Same request plus idempotent request key; frozen native action and exact Agent typed data for client sign-only                                            |
| `/orders/submit`         | Stored action ID, signature and optional existing operation/reservation references; never client capacity, fee facts, unsigned action or confirmed intent |
| `/orders/cancel/prepare` | Owned economic order ID and request key; native cancellation without BUY fee/cash requirements                                                            |
| `/orders/cancel/submit`  | Stored cancel action ID, economic order ID and signature; cannot submit a BUY action or change orders                                                     |

The HTTP layer delegates to the same native runtime/admission used by the common
trading adapter. It has no second funding claim, signer, retry engine or design.
Ordinary session auth, CSRF and selected-wallet checks apply. Current controller
ownership and financial policies are revalidated by existing server code; input
cannot select actor/user or inject a capability override. All responses are private,
no-store, including auth failures. Financial quantities remain decimal/raw strings.
DTOs exclude private snapshots, profiles, provider payloads and signature data.
Deterministic input errors return a safe 400; known current-state conflicts return
409; internal/provider/DB schema errors remain sanitized 503 responses.

Owned durable submit replay still returns its stored result after venue disabling,
without another provider read or POST. It cannot remove/change the funding link.
Submission ACKs remain `reconcile_required`, not filled/cancelled confirmations.
The response's provider capacity explicitly excludes Hunch holds; clients must use
ordinary funding availability and final admission, not treat it as spendable cash.

The same Zod contracts feed actual route registration and `hip4-openapi.ts` offline
generation. Five endpoints generate successfully without provider/DB calls. Real
Fastify + PostgreSQL sessions/CSRF tests exercise no-auth, wrong-CSRF/foreign-wallet,
foreign-user signed submission, strict fields, exact fee/amount DTOs, funded submit,
repeat without rebroadcast, policy-off replay, exit-only cancellation on a closed
market, unchanged reservation after cancel ACK and redacted transport failures.
An independent no-history HTTP review found and reverified correction of the
invalid-amount 503/400 classification; scoped GO is not whole-P3/P4 acceptance.

Public financial capability ceilings remain OFF. Existing UI/Next proxy signing,
USD market sizing, native terminal-order read presentation and sealed Telegram
financial handoff still need integration and acceptance. No live signing/submission,
personal Telegram, production mutation, commit, push or deployment was performed.

Final checks after the shared schema-generator and foreign-user test additions:
runtime + HTTP PG16 suites passed 2/2, finance-worker tests 24/24, scoped lint and
formatting passed, and the full backend workspace build passed 16/16. This does
not verify the unfinished frontend financial flow or close the P3/P4 goal.

## 45. Native orders in ordinary history/open-order reads — October 15, 2026

The existing authenticated `/orders`, `/orders/open` and `/orders/:id` now include
Hunch-originated mainnet HIP orders through their original action and durable
submission. There is no new order API, economic ledger or screen. Unsigned
preparations and cancellation-only records do not become financial orders. Native
records use the existing economic order UUID, so distinct submissions whose
provider OID is still unknown do not collapse in legacy OID deduplication.

The read projection distinguishes exact native terminal state from execution
accounting. A trusted cancellation is displayed as `cancelled` and a trusted
native completion as `filled`; both leave the open list. The validated terminal
barrier is shared with lifecycle/holds. Missing, invalidated, malformed or future
barriers cannot close exposure; a corrected observation takes effect immediately.
Cancel ACKs do not close orders. Actual `filled_size` and average prices are not
rewritten by reads. Unknown fills return `null`, not the order row's initial zero;
positive validated ledger quantities and known zero-fill rejection remain visible.
`nativeOrder` adds exact decimal fill quantity, submission/native state, terminal
observation provenance and explicitly unasserted history coverage. Native `filled`
alone cannot assert complete fills or known fees.

Fresh P2 open-order snapshots remain available for externally originated orders.
An exact owner/environment/OID/token match suppresses an already represented
native order before pagination/counting, including after native termination; an
older snapshot cannot resurrect it. P2 verified-wallet capability checks remain.
Hunch-owned history, like other venue history, remains readable when new venue
activity is disabled; reads require ownership and selected-wallet scope but do
not perform provider IO or change funding reservations. Other venue filters and
legacy deduplication semantics are preserved.

Disposable PG16 tests cover missing OIDs, unsigned/cancel-only records, accepted
partial cancellation, native completion without fills, definitive rejection,
barrier invalidation/recovery, filters, foreign ownership, mixed legacy records
and overlapping P2 snapshots. Generic plans use production-equivalent indexes on
50,000 synthetic orders (5,000 owned, 45,000 unrelated): first/resumed pages were
about 16–19 ms/28,375 local buffers, exact count 12–15 ms, sparse open 20–22 ms,
empty owner 0.02–0.09 ms/2 buffers, and a 5,000-item overlapping snapshot about
58–69 ms/75,000 buffers. Same-owner counts and empty offset tails are still
linear, not constant-time. These are disposable tests, not production EXPLAINs.
UUID detail uses an indexed native equality, not an indexed-column text cast.

Real Fastify sessions exercise the ordinary routes alongside the trade routes:
401, foreign-user 404, cancel ACK still open, terminal partial display, disabled
venue history, no-store and no provider IO. The existing ordinary-venue unit test
was narrowed to its UNION branch so legitimate native terminal exclusions do not
produce a false failure. A fresh independent scoped review approved this slice;
it does not count toward the required **0/2 whole-implementation GO**. Financial
activation, frontend signing/funding recovery and the earlier P3 gaps remain open.

Final verification after nullable-fill and explicit observed-zero cases: native
PG16 and authorized HTTP suites passed; order units 90/90 and native funding units
344/344 passed. Scoped lint/formatting and offline OpenAPI DTO generation passed;
the full backend workspace build passed 16/16. A concurrent build increased the
same 5,000-overlap query to 102–110 ms without increased scan footprint; these
samples are not a latency guarantee. No migration, client design change, live
financial action, personal Telegram access, commit, push or deployment occurred.

## 46. Open-order capacity inclusion through shared funding — October 15, 2026

The existing exact `orderStatus` observer now records an `accepted_observed`
balance barrier for an identity-validated open order. A provider balance read
started strictly afterward already accounts for filled principal and the resting
principal hold. The common capacity adjustment therefore retains only the frozen
BUY fee cap; SELL retains no additional outcome-token hold because fees debit
quote proceeds. Current verified zero-fee opening terms produce zero residual,
but older positive fee caps remain conservative. Missing or malformed frozen
terms retain the whole local debit until exact terminal evidence and a later
balance read provide recovery. No complete fill-history prerequisite was added.

This is the same helper used by new-order admission, native funding sends and
ordinary preparation/shortfall/Account Value. The corresponding common consumer
reservation is replaced exactly once. Other reservations, newer submissions and
post-snapshot debits remain independent. No reservation is released or account
exposure closed merely because principal is included in a provider balance.

Equal/overlapping timestamps do not grant inclusion. Repeated open observations
preserve the first barrier; an identity/status contradiction invalidates it, and
an exact repair establishes a new barrier. `unknownOid` alone preserves prior
validated evidence but cannot establish or repair it. Terminal transition uses
a new terminal barrier and removes the residual fee only after a later balance.
Local timestamps order API reads, not provider replica finality: the ordinary
official-API capacity trust model remains explicit.

Additive migration `0315_hip4_order_capacity_barrier.sql` creates a concurrent
expression index for unaccounted orders. Legacy/malformed observations map to an
unaccounted sentinel above the safe timestamp domain, not a deployment assertion.
Correlated action/order lookups prevent generic plans from hashing every frozen
preparation after the index seek. On disposable PG16 with 50,000 retained terminal
orders, empty/pending terminal queries used 4–11 buffers in 0.04–0.17 ms; sparse
open/foreign-owner/missing-asset cases used 3–13 buffers in 0.04–0.08 ms. Tests
exercise custom and generic plans. These are not production latency guarantees.
The separate same-owner lifecycle/history performance debt is unchanged.

Verification: five PostgreSQL integration suites passed, including actual
observer-to-common-funding behavior, partial fills, BUY/SELL/send admission,
positive and zero fees, malformed legacy snapshots, contradiction/recovery,
new-submission overlap and real concurrent admission. Interrupted index creation
leaves an invalid artifact; the exact migration successfully rebuilds it on two
retries, including malformed historical JSON. Order units passed 91/91, native
funding units 344/344, scoped lint passed, and the full backend workspace build
passed 16/16; finance-worker checks passed 24/24. Fresh independent scoped reviews
approved financial semantics and SQL/recovery. The latter independently reran
11 evidence tests and two PG16 suites, including interrupted-index recovery and
50,000-row custom/generic plans. Neither review is whole-P3/P4 acceptance.

No production migration, live financial action, new UI/design, personal Telegram
access, commit, push or deployment occurred. The remaining client financial flow,
sealed app handoff, P3 recovery/route gaps and full acceptance are still required.
Whole-implementation no-history GO counter remains **0/2**; this scoped slice does
not close P3/P4 or enable financial capabilities.

## 47. Native market quotes and client recovery foundation — October 15, 2026

`/trade/hyperliquid/orders/market-quote` sizes a USD BUY budget or token-sized
SELL into the same exact preparation contract. It reads one bounded native L2
book under the shared request budget, after ownership and lifecycle checks.
IOC limit price respects explicit slippage and protocol ticks; BUY size uses
the worst permitted price, not the displayed VWAP. Whole lots never enlarge
consent to meet the BUY minimum. Fees and capacity use the existing current
server resolvers; quotes do not reserve cash or submit. Partial execution remains
possible, and estimates are not guaranteed. Wrong-side, stale, unsorted or invalid
books are errors with normal refresh recovery, not zero liquidity.

Owned action recovery is read-only through `GET /orders/actions/:actionId` under
the same venue prefix. `POST /orders/abandon` serializes with submission using the
existing funding-policy/user/order/action locks. It abandons only an unsubmitted
preparation, preserves the nonce, and never releases money or calls the provider.
Admission winning the race returns the existing pending state. Discarding a cancel
does not alter its parent order. Recovery remains usable after new trading is
disabled. Exact action/order/request identity is returned without signatures or
private snapshots. These are action recovery endpoints, not another order ledger.

Ordinary `/orders/:id` adds optional `nativeOrder.openConfirmed` from the same
validated `accepted_observed` barrier used by capacity inclusion. Rejected,
missing, invalidated and future observations cannot establish it. It is positive
historical acceptance, not guaranteed current exchange freshness or fill evidence.
No financial holds or order states are changed by the read projection.

The frontend has generated private API calls plus a native sign-only adapter.
It reconstructs the pinned SDK MessagePack/Agent digest from reviewed terms,
validates both BUY/SELL normalization directions and checks the signer. The
existing funding signing lifecycle revokes stale/late responses. Exchange-domain
1337 is not an EVM chain switch or a funding SendAsset domain. No signatures are
persisted. The durable client journal is scoped by owner/controller/ticket, and
browser Web Locks serialize tabs. A lost POST result only permits recovery reads,
not a fresh key, signature or submission. Damaged storage retains uncertainty.
Explicit discard of a null-ID, unsigned preparation is local-only: signing is
impossible before both prepared IDs are durably saved. Known IDs use serialized
server abandonment. Explicit acknowledgment of an exact ordinary owned order
can clear a known open/terminal/rejected attempt; an open parent cannot clear a
pending cancellation. Neither operation releases a shared funding reservation.

Independent scoped reviews found and verified fixes for two client recovery
defects: deterministic unsigned preparation failure could prevent corrected
orders, and a failed recovery GET could incorrectly downgrade persisted submission
uncertainty to “not submitted”. Regression tests now cover both, plus cross-tab
execution, storage failure/replacement, late signing, session changes, expiry,
cancel isolation and quote/fee changes. Real PG16 tests cover both lock-race
directions, nonce preservation, owned reads, auth/CSRF and policy-off recovery.
Recovery SQL on 50,000 synthetic rows uses 2–14 buffers in roughly 0.018–0.041 ms
for hit/foreign/empty generic/custom plans. Separate dense-history query debt is
not fixed by this result.

Current verification: full backend workspace build 16/16, native order units
100/100, disposable PG16 recovery/submission/native-read suites, frontend 1,810
tests, typecheck, full lint and exact Node 20 Turbopack build (42 pages). The shared
funding consumer helper preserves native USDC8 atoms rather than converting to
EVM USDC6, with exact asset/outcome/amount tests. These client modules are **not yet
wired into ordinary Confirmation**. Native funding catalog/refund/receive gaps,
sealed app handoff and full cross-workspace/browser acceptance remain open.
The two required whole-implementation GO reviews remain **0/2**. No activation,
new design, live financial action, personal Telegram access or git mutation.

## 48. Shared preparation, first BUY and freshness — October 15, 2026

Native BUY/SELL preparation now uses the existing purpose-aware runtime and
destination resolver. BUY uses exact native USDC8 cash minus provider holds and
the same Hunch reservation/submission adjustments as order admission and sends.
SELL binds the selected controller's exact existing portfolio position and
canonical active instrument; preparation is not evidence of executable shares.
Market expiry bounds readiness, and lifecycle/revision checks run before cache
reuse and after provider IO. Funding disabled does not independently disable a
direct BUY or SELL. Unsupported modes do not become Standard through projection.

An exactly empty, freshly observed missing/default account may receive its
first deposit and obtain a BUY quote with known-zero capacity. The same pure
recipient predicate is reused by funding preparation and quote observation.
The public topology stays `native_uninitialized_recipient`; the checks assert
`native_recipient_observed`, never a false Standard account. The BUY-purpose
destination remains in the ordinary shortfall planner. Prepare/sign/submit,
native sends and SELL still require fresh Standard evidence. Malformed, stale,
nonempty missing/default or unsupported account modes cannot use this exception.

`/funding/destinations` optionally accepts `refresh=true` for an exact market and
owned controller/position. This bypasses the existing preparation cache, requires
new native core evidence and never counts a failed or contended refresh as fresh.
Unrelated history errors do not invalidate a genuinely new cash observation.
Responses are private/no-store. Optional public `spendability` preserves asset
units, observation/expiry and revision, and is emitted only when the adapter
explicitly attests provider-lock plus Hunch-hold coverage. Legacy destination
evidence, including Polymarket's incomplete provider-lock snapshot, does not
silently acquire this new public availability claim. Internal planner behavior
for other venues is unchanged.

The ordinary Confirmation model consumes native quotes and common destination
cash with exact USDC8 shortfalls. It preserves unknown versus zero and expires
availability using a subscription clock, not a stale shared feed timestamp.
After funding, native readiness requires a forced common inspection followed by
a fresh quote. Manual Refresh reuses existing Confirmation step presentation.
Forced failures cancel/invalidate the ordinary query and retain the fresh-read
requirement until recovery; late pre-funding requests cannot repopulate readiness.
Wallet/ticket/policy changes revoke stale callbacks and clear busy/auto-submit
state. Existing venue readiness/cache paths remain unchanged without explicit
refresh. Shared server-clock reads are bounded and caller cancellation cannot
cancel another caller's clock synchronization.

The existing `hip4_trading` policy owns `marketSlippageBps` (default 30, range
0–10000). An omitted market-quote value resolves from that policy; SELL/cancel
validation does not depend on unrelated BUY minimum configuration. Quote inputs
use explicit decimal strings, inward limit normalization and unchanged IOC
consent caps. Provider capacity is never substituted for Hunch-adjusted UI cash.

Verification: backend full workspace build 16/16; native financial/preparation
units 25/25 plus shared planner/routes assertions; disposable PG16 authenticated
HTTP and common-preparation suites pass. Frontend 1,825 tests, typecheck, full
lint, offline contract-generation check and exact Node 20 Turbopack build pass.
A fresh no-history scoped reviewer found two client recovery issues (stuck busy
state and stale ordinary-query resurrection); both were fixed, covered with real
QueryClient/production-callback tests, and re-reviewed GO. This scoped approval
does not change the **0/2** whole-implementation acceptance counter.

Still required: native execution/recovery wired into ordinary Confirmation,
portfolio SELL/cancel, sealed app handoff, P3 refund/receive/catalog/route and
dense-history gaps, full browser/cross-workspace acceptance. Financial capability
activation remains off. No live financial action, new design, personal Telegram
access, production change, migration, commit, push or deployment occurred.

## 49. Ordinary Confirmation execution and recovery — October 15, 2026

Native BUY/SELL now mounts through the existing venue-adapter map and shared
Confirmation model. A screen-local session wraps the existing durable attempt
journal; it is not another funding engine or order ledger. Mount, reopen and
explicit Check perform exact owned reads only. The selected controller comes
from common preparation, including policy-off recovery. No new screen or design
was introduced, and effective financial capabilities remain off.

Native orders and funding share one sign-only wallet helper. Embedded signing
uses the exact owned Privy wallet; external signing checks `eth_accounts` before
`eth_signTypedData_v4`. Neither switches chains nor sends a transaction. Frozen
typed data and lifecycle revocation protect every asynchronous boundary, including
StrictMode, logout, wallet/amount/policy changes and queued clicks. Post-sign
expiry is checked before the durable submission marker, so an unsigned/unsubmitted
request can be explicitly abandoned without losing submitted-request uncertainty.

The ordinary status step shows frozen terms and confirmed native facts. An ACK
is not a fill. Explicit acknowledgment or discard compares the displayed attempt
under the existing cross-tab lock and cannot clear a replacement request. After
funding, native recovery replaces the shared funding presentation without
reporting success or releasing its reservation. A confirmed admitted order only
detaches the local UI link; server accounting still owns money. New-order review
forces shared readiness and a fresh quote. Other venues retain their adapters.

Verification: frontend 1,853 tests, typecheck, full lint, reproducible contract
check and exact Node 20 Turbopack build pass. Full backend workspace build passes
16/16. Two no-history scoped reviews covered the session and Confirmation wiring;
the latter found and verified fixes for hidden recovery after funding and
post-sign expiry recovery. These are not whole-implementation reviews (**0/2**).

Remaining work includes portfolio SELL/cancel, truthful ordinary execution
receipts, sealed app handoff, P3 joint recovery/catalog/route and dense-history
gaps, full browser/cross-workspace acceptance and two consecutive whole-scope GO
reviews. No live signing, funds, production changes or git mutations occurred.

## 50. Shared event UI, Orders cancellation and refund retry — October 15, 2026

Live HIP events now mount the ordinary desktop EventsTables and mobile
EventActivity, with the same trade tickets and Confirmation as existing venues.
Canonical public trade pagination keeps primary-side actual trades and exact
time/coin/trade identity; it does not invent opposite-side executions. Empty
recent chart windows may bootstrap one archive page, not an unbounded scan.
Private Positions, Orders and History apply current verified ownership and
account-read policy to retained query pages. Exact execution quantities, zero
payouts, fees and incomplete coverage remain explicit. Portfolio SELL uses the
owned-account market endpoint, not discovery permission or fabricated metadata.

Ordinary Events/Portfolio Orders on both surfaces use the shared native journal
and sign-only wallet boundary for cancellation. A native Hunch order, exact
controller, market, outcome and cloid are required; observed external orders do
not acquire cancellation authority. Current `cancel` capability is separate
from permission to buy. Recovery remains read-only when cancellation is disabled.
An ACK or an open parent does not acknowledge cancellation. Terminal parent
evidence allows explicit acknowledgment; a rejected cancellation is explicitly
discarded through its own action before a new user-initiated request. Neither
path releases BUY funding. Existing Polymarket/Limitless mutations are unchanged.
History does not acquire a new Cancel button. No success analytics are emitted
from native transport acceptance.

The receive classification retry registry now includes
`exact_refund_correlation_pending`. Migration 0316 builds the corresponding v5
due index concurrently before removing v4. PostgreSQL 16 tests cover all eight
retry reasons, first/next/empty pages, lease recovery, a large leased prefix and
generic plans. Integration tests demonstrate that an already persisted pending
receipt can resolve to either an internal suppressed refund or a late external
recovery receipt, preserving the selected expired session and not reviving an
old Buy. This fixes retry plumbing only: fresh-source quarantine, joint current
refund/receive/destination authority and writer activation are still unfinished.

Verification includes the disposable PG16 migration and receive/native receipt
suites, full backend workspace build (16/16), and frontend tests, typecheck/lint
and exact Node 20 Turbopack build. Scoped independent reviews covered shared
event activity, owned SELL, retry plumbing, cancellation session and Orders
wiring. The latter found a rejected-cancel recovery mismatch; the UI now selects
the existing discard primitive and a session-composed test verifies it. Scoped
GO verdicts do not count as whole-P3/P4 approval (**0/2**).

Live browser checks confirmed the shared event chart/trades layout with indexed
data, not fresh quotes or financial execution. The local `hip4_local` database
remains behind the current schema and its historical migration checksum differs;
the normal migrator stopped before writes. Ordinary Orders/History browser
acceptance and interactive cancellation remain unverified there. Disposable PG16
checks are not a substitute. Preserve the local login/admin and existing data;
do not overwrite migration checksums to bypass this limitation.

Still required: joint refund recovery and bounded publication authority, common
catalog/route completion including Solana, checked Max/Half/Reduce, authoritative
completion receipts, sealed app handoff, full browser/cross-workspace acceptance
and two consecutive fresh whole-scope GO reviews. Financial capabilities remain
off. No live signing, funds, personal Telegram access, commit, push or deploy.

## 51. Shared smaller-BUY advice and market Max — October 15, 2026

The existing funding advice loop now supports native USDC8 through
`funding/planner/hip4-buy-budget.ts`. It uses the ordinary current quote for
controller, exact outcome, policy, fees, integer lots and protected IOC depth.
Missing/stale evidence is unavailable, not zero capacity. Frozen source routes
are reused, and their fee allowance is rechecked against the smaller actual
debit. No route discovery, reservation, signature or submit is added by advice.
One quote plus at most one depth recheck stays within the existing timeout.

Both event tickets preserve native market Max intent through the ordinary
Confirmation refinement. Initial account cash remains an editable estimate;
only the subsequent quote and funding preflight establish executability. Half
stays custom, no input is raised to meet the BUY minimum, and limit-order Max
is not claimed complete. No visual layout or other-venue behavior was changed.

Scoped independent review found both cent-rounding edge cases; real sizing
regressions now cover four $0.303 lots and 400 $0.00303 lots without losing the
minimum or requesting unavailable depth. The corrected advice and ticket wiring
each received scoped GO, not whole-P3/P4 acceptance. Native advice 10/10,
Polymarket/Limitless parity 38/38, eight affected backend suites and the full
16-package build pass. Frontend 1,899 tests and exact Node 20 Turbopack build
pass. Full browser/financial acceptance and the remaining work in section 50
are still required; whole-scope GO remains **0/2**.

## 52. Resumed main synchronization and execution receipts — October 15, 2026

All three projects are on `hip-next`. Backend merge `b2328f8d` brings in the
Polymarket V2 discovery/lifecycle and bounded position-notification changes from
`origin/main` `5ac117fb`. Incoming maintenance and notification SQL passed on the
isolated PostgreSQL 16 database; no production schema or runtime was changed.

The existing native fill observation now includes a versioned nullable execution
summary. It is computed from validated, deduplicated canonical P2 fills under the
same account lock and worker lease, not requested size or submit ACK. Quantities,
gross notional and signed USDC fees retain their native precision; cash totals
retain up to 13 decimals. Builder fees are not added twice. Unknown fee currency
leaves fee/net cash unknown. Legacy observations need ordinary repair, not a
migration or inferred backfill.

The ordinary owned Orders DTO exposes the summary. Current observation errors
suppress it and invalidate stored receipt evidence; a status-only success cannot
restore it before the fills phase succeeds. No new ledger, endpoint, join or
funding coordinator was introduced.

Shared desktop/mobile Confirmation renders a completed native receipt only with
exact terminal-filled status and the full frozen quantity, plus known cash/fees.
Partial/cancelled, ACK, legacy or failed observations retain ordinary recovery.
Receipt values come from execution facts, not editable ticket amounts. Existing
account/positions/Orders readers are invalidated on changed owned evidence;
neither this nor the receipt acknowledges the journal or releases funds. Explicit
Done acknowledges the displayed attempt through the existing recovery primitive.
Account freshness is not asserted from fills or cache invalidation alone.

Verification so far: full backend workspace build 16/16; native evidence 12/12;
PG16 read projection/observation and incoming maintenance/notification suites;
frontend 1,902 tests, typecheck/lint, generated contract check and exact Node 20
Turbopack build (42 pages). The final PG16 recovery rerun passes. A fresh no-history
review returned scoped GO after the summary-resurrection fix; it independently
ran 46 frontend tests and 12 native evidence tests. Mounted receipt/Done with
linked funding and logout/owner-switch interaction coverage still belong to
browser acceptance. This is not whole-P3/P4 acceptance.
Financial browser acceptance, route/refund gaps, limit advice and sealed app
handoff remain open. Whole-scope reviews remain **0/2**.

## 53. Native limit Max/Half/Reduce in shared funding — October 15, 2026

The ordinary liquidity request now accepts optional exact native limit advice
metadata (`quantity`, `limitPrice`, `timeInForce`). Mixed market/limit advice,
other venues and non-BUY purposes are rejected. These fields are not a consumer
authorization: the existing exact spend, owner, destination and reservation
contracts remain authoritative. Concurrent advisory requests include the complete
limit terms in their identity.

The same frozen-route capacity loop used for market advice calls the ordinary
native limit quote. It does not size resting orders from IOC depth. Candidate
quantity is whole lots, strictly below the original, with exact USDC8 budget;
the ordinary quote checks policy minimum, fee evidence and expiry. A smaller
debit rechecks the route fee allowance before advice is returned. Existing
timeouts/three-pass bounds and other-venue paths are preserved. No new provider
discovery, reservation, transaction, table or SQL query was added.

Both existing event tickets round native limit Max/Half inward. Max retains a
market/outcome/price/quantity key; Half is custom and never raised to a minimum.
The common Confirmation accepts at most two fresh Max adjustments, or an explicit
custom Reduce, then requotes through the usual flow. Expired advice, scope changes,
prepared/submitting/recovering orders or started funding prevent edits. Native
Max continuation uses an exact quantity/debit ceiling, not cent rounding; price
changes invalidate the continuation. Existing market continuation is unchanged.

Scoped no-history review returned GO for this limit block, not all P3/P4. Native
budget tests 13/13 and Polymarket/Limitless parity 38/38 pass; tests also cover
fractional cents, minimum lots, changed terms, concurrent identities, smaller
route economics, stale callbacks, duplicate effects, two-adjustment exhaustion
and explicit retry. Final backend build 16/16, frontend 1,908 tests, typecheck,
full lint, generated contract check and exact Node 20 Turbopack build passed.
Mounted financial acceptance remains separate;
no live signing/funding or production activation was performed. Whole-scope GO
remains **0/2**; section 52 receipt browser gaps and the refund/route/handoff work
remain required.

## 54. Local schema recovery and mounted read acceptance — October 15, 2026

The local schema blocker recorded in sections 50/52 is resolved, without dropping
the database, changing application migrations or removing the user's local admin.
The old 0284 checksum was reproduced exactly by its single historical change from
unquoted `position` to quoted `"position"`. A rollback-only schema comparison
matched all 32 columns, 12 constraints and 9 indexes of the affected 0284/0285
tables. No other applied checksum differed.

A local custom-format backup was restored into a separate PostgreSQL 16 database.
Only after this rehearsal did an exact guarded correction of that one local
schema-migrations row permit the ordinary explicit-target migrator to apply
0286–0316. The restored copy and local database both completed migration, with
zero invalid indexes. The users-table digest and one local admin were unchanged;
the local database had no funding operations. This is a specific proven historical
checksum repair, not permission to ignore future checksum mismatches or a new
production migration procedure. Backup and audit artifacts remain ignored locally.

The local API was restarted with finance worker and Telegram reconciliation still
disabled. Authenticated browser → Next proxy → API checks now return HTTP 200 for
ordinary Order/History on desktop/mobile and show their correct empty states.
No order was submitted or cancelled. Stored October 13 history is not described
as a current executable quote.

Frontend section 30 records ten mounted real-hook recovery checks and their
synthetic IO boundaries. The independent review prompted loaded-owner replacement
and active-reader coverage; full Confirmation Done/close with linked funding is
still separate. Repeated checks pass: backend workspace build 16/16, frontend
1,908 regular tests, app typecheck/lint and isolated harness typecheck. Whole-scope
GO remains **0/2**, and no feature commit, push, deploy or production change occurred.

Refund activation remains unfinished. The current source enumerator/actions and
joint decision helper must not be treated as connected publication authority.
`operations.version` does not cover all provider/evidence mutations. A current-fact
continuation must also account for existing writers that do not hold operation
locks; adding a revision-row FK or an early trigger lock can introduce an inverse
lock edge. Do not activate the refund callback before current-fact validation,
all-role arbitration and durable fresh-event retry are verified together, including
both concurrency orders and post-window recovery. A new invalidation primitive is
not a substitute for that integration or for the remaining route/catalog/handoff
and full financial UI acceptance.

## 55. Classification facts revision primitive — October 15, 2026

Migration 0317 and `funding-classification-revisions.ts` implement the narrow
consistency primitive identified in section 54. This is not a new funding ledger
or an alternative to the existing allocator. The financial writers and shared
receive/funding paths retain their existing roles.

- An absent revision is zero only for an existing, currently owned operation.
  UUID-only revision tombstones have no operation FK and are not reset during
  ownership transfer or cleanup. No legacy-data backfill is required.
- Semantic changes to operation ownership/scope, route bindings/provider facts,
  steps, attempts, receipts, observations and source reservations enqueue one
  transaction-local touch per operation. Poll timestamps, confirmations and
  diagnostic cursors alone do not invalidate paged work.
- A deferred trigger drains the whole transaction's touched set in UUID order.
  The staging table is empty after commit/rollback. Deferred foreign-key work is
  completed before revision locks, avoiding a revision-to-operation lock edge.
- Every bounded facts page checks the same expected revision before and after
  its read. A changed candidate must restart; immutable candidate enumeration
  is not discarded and unrelated candidates are not invalidated.
- Final publication requires all physical-event locks, then operation locks and
  current owner/existence checks, then DB-only effects, then a revision fence and
  **COMMIT only**. The fence locks the sorted union of proof dependencies and its
  own staged operations. Its own revision increments happen at commit. A mismatch
  rolls back all effects and is retried through the existing job mechanism.
  `SET CONSTRAINTS ALL IMMEDIATE` followed by further funding writes is not a
  supported publication protocol; the existing named-deferred-FK merge path is.

The helper cannot prove externality, exact debit, fresh candidate membership or
complete coverage by itself. It is not yet wired into the receive/refund publisher
or finance-worker callback. Those callers must use the same checked dependency
set throughout the final transaction, and must never issue financial actions
from a failed publication. Changes to classifier input fields require updating
the SQL semantic projection in a new migration.

Verified on disposable PostgreSQL 16.2, not `hip4_local` or production: the full
migration chain from an empty database; real two-session observation writes
without operation locks; both fence race orders; child-row contention before the
fence; reversed multi-operation writes; absent-zero materialization; rollback and
ordinary retry; step/attempt/receipt changes; polling-only updates; and actual
terminal admin merge with deferred ownership FKs. Test cleanup retains tombstones;
its replica-mode deletion is not claimed as a normal production deletion test.
Read plans against 50,000 unrelated indexed rows use 2–6 buffers and no sequential
scan for hit, absent-zero, wrong-owner and missing cases with custom/generic plans.
These are local query-plan measurements, not a production throughput guarantee.

Final checks for this increment: 15 affected PostgreSQL integration files passed
across the final-schema runs, 46 assertions in six selected unit files, targeted
ESLint/Prettier and full backend workspace build 16/16. The test database had zero
pending touch rows and zero invalid indexes after completion. A repeated scoped
independent review found no further actionable defect. No new frontend build or
financial browser acceptance is claimed for this backend-only increment.

Independent no-history review found a nullable-revision comparison that could
pass silently; the fence now rejects it using `IS DISTINCT FROM`. This is scoped
review only. Whole-scope consecutive GO remains **0/2**. Refund source continuation,
joint role publication, worker activation, remaining route/handoff work and full
Confirmation acceptance still precede the two final independent reviews.

### Bounded current source-action pages

`relay-refund-source-action-scan.ts` now composes the revision guard with exact
source rehydration and the existing indexed action reader. Each call reads one
bounded page. A constant-size fold retains any earlier possibly issued attempt
through later cancellations/failures; approvals do not establish money movement.
The original one-shot classifier uses the same fold, with unchanged verdicts.
Checkpoints contain identity, revision, cursor and fold, not raw action/receipt
history. A strict versioned decoder rejects malformed checkpoints and restarts
only that candidate. Missing/reassigned sources remain unavailable, never external.

Committed disposable PG16 fixtures exercise serialized continuation, polling-only
updates, revision invalidation, ordinary restart, ownership and 51 attempts over
eight pages. Unit coverage includes 1,000 folded attempts with fixed-size state;
the existing 10,001-attempt query workload checks bounded first/resumed/tail reads.
These are separate tests, not a claim of a full 10,001-attempt worker replay.
The exact source lookup uses primary-key/index hydration with at most one row
per relation: custom/generic hit/missing/foreign cases took 0.031–0.057 ms and
2–9 local buffers against 50,000 unrelated plus 5,000 same-user source rows.
First/resumed 51-row pages used 360–361 buffers and 0.236–0.297 ms; empty tails
used three buffers. These disposable measurements do not establish production
latency. The two affected PG suites, 25 focused unit tests, targeted lint/format
and final full backend build 16/16 passed. No new frontend acceptance is claimed.

This read primitive is not yet persisted by the receive queue. The next integration
uses that existing queue's event lease and frozen session binding: a fixed-size
scan header and per-candidate progress, atomically advancing source pages. It must
also establish complete current source-debit/settlement evidence and membership;
reservation timestamps alone are not commit watermarks. Final arbitration must
include negative handoff/destination dependencies, not only matched operations.
No new external-deposit verdict, refund callback activation or funding path was
introduced. Repeated independent scoped review found no actionable defect in the
primitive; it is not one of the two required whole-implementation GO reviews.

## 56. Durable source-check progress — October 15, 2026

Migration 0318 adds two derived work tables beneath the existing canonical
receive event, not another financial ledger or worker queue. The standalone
`advanceReceiveRefundScan` transaction uses the existing exact event lease and
frozen session/variant/owner. It reads the authoritative stored envelope and
persists one bounded source page or one bounded action page. Candidate insertion
and source-cursor advancement commit together; the cursor keeps PostgreSQL
microseconds. Duplicate use of the same lease cannot advance twice, and a
reclaimed worker cannot overwrite newer progress. Page size is caller-supplied
from the existing worker budget, not a new product threshold.

All candidates rotate fairly, including unavailable and completed ones. A
completed action result is checked cheaply against its full captured identity,
current envelope and facts revision before reuse. A change clears only that
candidate's derived work. Explicit enumeration restart preserves the dependency
set; changed operation/segment identity cannot overwrite an older captured
dependency. Missing or reassigned sources remain unresolved. No private provider
payload, raw action history or signing material is stored in the checkpoint.

The only parent FK is the canonical event. Source operation/reservation IDs are
captured dependencies: cascading deletion would incorrectly erase uncertainty.
Existing receive-session evidence already protects user lifecycle; existing
funding-operation references protect markets. These work rows contain no new
market/token payload and are not pruned by market retention. Bounded cleanup
removes children before the header **only after immutable allocation**. Exact
refund suppression is reversible after a reorg and therefore retains all work.
There is no time-based expiry of unresolved dependencies.

Fresh independent scoped review found and prompted fixes for stale completed
results, premature cleanup of reversible suppression, and overwritten source
identity. Re-review found no remaining actionable issue in this component.
Tests cover atomic rollback between child/cursor writes, concurrent replay,
lease replacement, dense action histories with unavailable peers, completed-fact
invalidation/recovery, malformed checkpoint repair, captured-identity mismatch,
suppression/revival, and bounded final cleanup. The mismatch fixture represents
the post-change captured state; it does not disable immutable financial-plan
guards to manufacture a live reparenting operation.

The final migration chain ran from empty on disposable PostgreSQL 16.2. New
header/lease/fair-candidate custom and generic reads were indexed, visited at most
one row per relation and used 2–4 local buffers (0.016–0.034 ms) against 50,000
unrelated records and 50,000 same-event candidates. Fifty-row cleanup used bounded
indexed plans, 303 local buffers, 0.130–0.474 ms. These are disposable measurements,
not production latency guarantees. The common receive regression and HIP funding
receipt regression passed in an isolated database: shared-database runs initially
picked up another suite's retained open session. New checkpoint fixtures now
remove their own session/event in test-only teardown; this is not a production
financial deletion path. Focused receive/source units passed 28/28; existing HIP
funding unit coverage passed 351/351. The final combined PG16 run passed all four
integration files (receive internal handoff, receive persistence, exact-refund
concurrency and HIP funding receipts). Targeted lint/format, diff checks and the
full backend workspace build passed (16/16, 14 cached). No new frontend or live
financial acceptance is claimed for this backend-only increment.

**Not yet runtime activation or P3/P4 completion.** The checkpoint processor is
not called by the live observer and cannot return an external-deposit verdict or
create receipts/allocations. Complete current debit/settlement evidence, stable
source membership, negative handoff/destination dependencies, joint E→O→effects→F
publication, and worker activation remain next. The separate route/catalog,
sealed Telegram→app claim and full Confirmation acceptance work also remains.
Whole-implementation consecutive fresh GO remains **0/2**. No production changes,
financial actions, frontend redesign, commit or push were made in this increment.

### Current attempt-linked source debit

The existing bounded action reader now hydrates each receipt's exact physical
source observation and its original allocation attempt by indexed keys. The
constant-size fold retains one verified debit plus unresolved-attempt evidence.
It validates the frozen source amount/asset/owner/recipient, current receipt and
observation finality/block anchors, and original step/action/executor provenance.
Repeated reports of the same physical transfer do not double-count it. A second
physical debit, an unresolved issued attempt or a reorg cannot be hidden by one
successful attempt. No new financial writer or source-balance calculation was
introduced; the proof consumes the standard receipt writer's observations.

Derived action checkpoints are now version 2. Older checkpoints restart just
their candidate through the existing fair lease path. The existing exposure
interface is unchanged. The completed result additionally records attempt-linked
accounting in the existing derived result, without another migration. `none`
does **not** prove absence of other debit observations; `single_debit` does
**not** prove complete settlement. Neither enables external receive allocation.

Verified: the real standard receipt writer and its reorg path on both Base and
Polygon; physical replay, distinct/unresolved attempts, mismatched provenance,
anchors and amounts; ordinary revision invalidation/restart. The final combined
PG16 run passed 4/4 integration files, focused units 26/26 and HIP funding units
351/351. Lint/format/diff checks and full backend build passed (16/16, 14 cached).
Custom and generic action plans against 50,000 unrelated actions and 10,001
attempts in one selected step remained indexed: dense first/next pages hydrated
at most 52 rows per relation, used 266–275 local buffers and took 0.268–0.333 ms;
empty tails used seven buffers. These are disposable test measurements.

Independent no-history scoped review found no actionable defect and independently
reran the 15 source-action units. It did not certify PostgreSQL/build itself or
the whole implementation. Complete current settlement/observation coverage and
membership/publication integration remain unfinished; whole-scope GO stays 0/2.

### Current canonical refund-set completion

The same derived candidate now reads one caller-budgeted page of current final
refunds under the captured facts revision. It uses the existing 0305 manifest
index and provider manifest limit, including a sentinel; it does not truncate
older receipts or retain lifetime provider history. The reader validates the
frozen request/location and physical receipt identity, reconstructs the standard
writer's exact completion fingerprint, and reads only that key from its anchor
observation. It does not download or iterate the append-only proof map. Missing,
changed or conflicting proof remains pending; ordinary evidence changes restart
the candidate through the existing lease/revision path. Older v2 checkpoints
default this component to unchecked. No new financial writer was introduced.

Verification used actual standard source/refund writers: partial then complete
refund, serialized pages, semantic changes between pages, reorg and restoration
through the canonical watcher. Focused units passed 49/49 and HIP funding units
351/351. All five affected PG16 integration files passed (four together, receive
session persistence separately); a clean full migration chain through 0318,
targeted lint/format, diff checks and full backend build 16/16 also passed.
After tests: zero revision-touch rows, invalid indexes or derived scan rows.
Custom/generic manifest first/next/tail plans remained indexed against 150,000
observations; eight-row pages took 0.021–0.091 ms. Exact proof-key reads returned
one row in 0.96–1.42 ms with 1,000 retained audit entries. These are disposable
local measurements, not production latency claims.

The older local PostgreSQL 16.2/Timescale image encountered a backend-process
SIGSEGV at 16:06:27 UTC, then reproduced it in the separate disposable container
at 16:26:51 UTC. PostgreSQL recovered automatically. The source-action query's
JSONB-derived origin UUID join had a Memoize plan. It now uses a guarded scalar
primary-key subquery with the same provenance/null semantics; no global planner
setting changed. Repeated probes, committed race tests and the final five-file
PG run passed after this change. The exact engine root cause remains unproven;
this is not a claim that the underlying PostgreSQL defect was diagnosed or fixed.
The malformed-provenance fixture also now hydrates real source-writer rows into
its existing temporary observation table. Subsequent tests used only the separate
disposable instance, not the user's local application database.

Fresh independent scoped review found no remaining defect in this reader after
removing a redundant terminal prefix read that exceeded its page budget. This is
not whole-implementation GO. A complete current refund set does not prove absence
of extra debit, pending settlement or unresolved historical reorg evidence.
Those facts, stable membership and joint publication remain required before
runtime activation. Whole-scope consecutive GO remains **0/2**.

### Current observation coverage and native successful delivery

The candidate scan now examines all operation observation states in bounded
keyset pages, not only finalized refunds. Extra source debits, pending/reorged
facts, mixed refund/destination evidence or unknown target-leg observations cannot
be hidden by an otherwise complete refund. Unrelated legs consume page work but
do not invalidate an independently settled leg.

Successful native delivery uses the existing standard destination-credit writer:
exact physical `hypercore:send:destination_credit`, trusted observer identity,
frozen owner/asset/DEX/minimum, canonical finality and retained positive Relay
destination-hash binding. Synthetic balance-delta rows are not receipts. Split
credits accumulate only up to the frozen minimum; duplicates do not create new
rows. The exact-reference query reads one segment PK and returns only requested
membership IDs, not its whole historical JSON proof map. Current inputs are
already covered by migration 0317; no further migration or financial writer was
added. `observationVersion: 1` rechecks older completed observation summaries at
the same revision without discarding valid source/action/refund work.

PG16 cases use real source/destination writers: partial then complete delivery,
missing references, shortfall, DEX/owner/asset/observer mismatch, synthetic keys,
mixed refunds, reorg, ordinary revision restart and same-revision checkpoint
upgrade. Representative custom/generic reference reads against 50,000 unrelated
segments and 1,000 historical bindings used 16 buffers for a two-reference hit
(0.20–0.24 ms); wrong-operation/missing reads used 2–4 buffers. No sequential scan
or multi-segment hydration occurred. These are disposable, not production, timings.

### Source membership: use existing causal boundaries

No new global membership revision or lock was added. A real committed-action
fixture verifies that another connection cannot prepare/admit the exact step
before its operation transaction commits. The same prepared action succeeds
after commit; a held independent observer connection sees both the source
reservation and admitted attempt before the stub transport is called. Replay
does not call transport twice; rollback publishes no operation. Transport and
policy lookup are substituted, so this is not wallet/API authorization or a
live-signing test. The sampled cutoff deliberately demonstrates that reservation
`created_at` is **not** a commit watermark.

Six real merge/session races exercise both orders, either merge participant and
the applicable `keepSource` branches. The existing immediate session→user FK and
merge's user-row locks serialize them: a committed session prevents merge;
merge-first permits a later target session, rejects a deleted source, and permits
a retained source only after merge completes. Empty-user fixtures establish lock
ordering, not historical-row migration or refreshed wallet ownership. Together
with commit-before-send these narrow causal checks support the supported Hunch
path; they do not establish arbitrary external broadcasts or final classification.

Both affected PG suites and the final combined five-file PG regression passed
after strengthening the positive control. Focused units passed 51/51; HIP funding
units passed 351/351. API typecheck, scoped lint/format/diff checks and full backend
workspace build passed (16/16, 14 cached). Post-test checks found zero pending
revision touches, invalid indexes, scan rows or active test transactions. The
separate disposable container and its synthetic data were removed; local app
database, admin/auth and app servers were preserved. Fresh scoped review found no further
actionable defect in delivery or these causal-boundary tests. They are **not**
whole-implementation GO reviews. Joint current handoff/destination/refund
publication, negative-role dependencies and worker activation still remain before
external allocation can use these results; route/catalog, sealed app handoff and
full Confirmation acceptance remain separate P3/P4 work. Whole-scope GO is **0/2**.

### Existing retry worker: checkpoint progress and terminal cleanup

The known-canonical-event retry caller now advances one derived source/action/
settlement page per claimed event using its existing batch budget and frozen
session/variant. It does not perform provider calls, extend a receive window or
restart a Buy. Unsupported native/Solana events do not invoke the EVM source
reader. Checkpoint errors have separate worker diagnostics and do not disable
existing recorded-evidence repair. Ordinary derived progress is not logged as a
new financial event.

Fresh scoped review found that allocated events would leave the retry queue and
strand their derived rows. The unpublished 0318 migration now marks existing
headers cleanup-eligible in the same allocation transaction, with a partial
eligibility index. The same worker tick drains bounded child pages, one locked
canonical event per transaction; held events are skipped and dense headers
rotate. Reversible suppression never marks a header for deletion. No new
scheduler, provider action or financial authority was introduced.

Tests exercise the actual retry and finalization caller after window expiry,
same-tick replay, checkpoint failure and recovery, post-commit restart, held-event
skip, rollback after a child deletion, and three single-row cleanup pages.
Financial role verdicts are explicitly substituted in that caller test; this
does **not** prove receive-first refund arbitration. All five affected PG16
integration suites passed together on a fresh disposable database, including
custom/generic indexed cleanup selection against 50,000 headers. Focused units
passed 56/56, finance-worker tests 24/24, API typecheck and scoped lint/format
checks passed. Full backend workspace build passed (16/16, 6 cached).
Post-test scan headers/candidates and invalid indexes were zero.
Scoped re-review found no further actionable regression after the cleanup fix.

This connects resumable work, not its allocation verdict. A recorded-refund miss
still uses the existing allocation path; new refund discovery must remain
unactivated until negative handoff/destination/refund dependencies and the joint
publication fence are integrated. The exact-refund driver callback is still
unwired. Catalog/routes, sealed app handoff and full Confirmation acceptance
remain unfinished. Whole-scope consecutive fresh GO remains **0/2**.

### Direct destination publication and bounded handoff history

The existing direct destination-receipt writer now owns its transaction and
prelocks the complete EVM physical-event set before the target operation. Repeated
envelopes are checked before deduplication; a conflicting role, allocated external
event or changed target facts rolls back the entire batch. It reuses the existing
destination-credit writer and transaction reference codec, then applies the
target-operation facts fence immediately before COMMIT. Native credits retain
their native identity and do not manufacture EVM event rows. The fence currently
covers the target, **not yet every negative competitor dependency**.

PG16 tests exercise actual writers, reversed batches, replay, duplicate-envelope
conflicts, receive allocation, a competing refund, a no-operation-lock metadata
writer and ordinary retry. Native positive/replay cases are included. Chain
observation is substituted; no live signing or provider settlement is claimed.
The six affected integration files passed together before the following reader
increment. Independent scoped review found no further actionable defect in the
destination increment, not whole-P3/P4 GO.

The new operation-wide handoff reader includes bound and unbound actions, checks
the same owner/facts revision before and after every page, and preserves canonical
other-hash observations as dependencies. Empty or filtered pages still advance
their source cursor. It is a bounded reader, **not an allocation verdict**.

Fresh review exposed steps × attempts fanout before a final LIMIT. Both this
reader and the existing refund action reader now share one indexed, single-row
cursor traversal. Other route legs consume bounded source work before refund
filtering; they do not enter the target leg's financial fold. This avoids both a
quadratic intermediate result and an unbounded sparse-leg prefix without adding
an index, planner setting, scheduler or financial mechanism. Existing saved
segment cursors remain compatible. The reference lookup also keeps its HMAC
batch-membership check on the input event, leaving the attempt index probe bound
to that event's single HMAC.

Disposable PG16 coverage includes 50–55k unrelated rows, 10k same-operation
sparse steps, 10,001 attempts and 64 × 64 dense steps/attempts. Custom and generic
plans cover first/resumed/empty/foreign/missing-leg reads. Both changed-reader
integration files passed together. Handoff pages used 3–734 buffers and roughly
0.08–0.9 ms; refund pages used 3–730 buffers and 0.10–1.06 ms in the measured run.
The 32-event legacy HMAC batch examined 320 rows after the change (one earlier
generic-plan run failed at 1,856). These are disposable, not production, timings.
Existing 64-event destination classification still spent about 0.8–0.9 seconds,
including substantial JIT; this increment does not claim to resolve that cost.

Focused units passed 67/67, API typecheck and scoped lint/format/diff checks
passed, and the full backend workspace build passed 16/16 (14 cached). Re-review
of the shared pager, segment filtering and HMAC change found no actionable
defect; the reviewer independently ran the 18 directly affected unit tests.
The final combined seven-file PG16 regression passed (exit 0), including the
destination publication, revision races, receive/session/merge, refund manifest,
actual retry worker and both action readers. Finance-worker checks passed 24/24.
Post-run checks found zero pending revision touches, invalid indexes, scan
headers/candidates or other test clients. The isolated disposable container was
removed; local application database/admin/auth and app servers were preserved.
Negative-role membership, final joint publication and runtime refund discovery
activation remain unfinished, as do catalog/routes, sealed app handoff and full
mounted Confirmation acceptance. Whole-scope consecutive fresh GO remains **0/2**.

### Shared receive-role checkpoint increment

The existing canonical-event retry now captures reverse-handoff operations and
route destinations alongside refund-source dependencies. It still uses the same
event lease, source-input index and worker page budget; there is no separate job
queue, provider call, financial writer or automatic trade continuation. Candidate
rotation is fair, with one role page per turn. Version-1 derived headers upgrade
by bounded re-enumeration, preserving previously captured dependencies and their
results rather than deleting them.

Handoff membership includes bound/unbound preparation actions across the current
wallet/composite/preparation plan families, without filtering by the reservation's
source asset or address. Destination membership matches the existing classifier's
operation-final target and leg-output asset, including legacy decimal text and
extension properties; it does not use status, amount thresholds or quote expiry.
Negative role summaries retain operation ownership and facts revisions. Source
enumeration exhaustion is still **not** a committed-membership watermark.

The destination reader shares the bounded action pager and keeps exact references
separate from possible movement. A retained exact reference survives provider
status changes; only attempts bound to that leg imply its source movement.
Terminal or known-destination negatives avoid unnecessary action scanning but
retain their facts dependencies. The handoff fold preserves retryable pending
over exact ambiguity across candidate-page boundaries. Both readers bind progress
to the frozen event and codec context; a transient failed reference read can
recover at the same facts/key revision, without manual checkpoint deletion.
`referenceRetryRequired` is unresolved evidence, never negative allocation proof.

Fresh no-history scoped review found no actionable issue after fixing legacy
membership compatibility, cross-page retry precedence and codec recovery. This
review covers candidate pagination for one frozen event. The legacy handoff
classifier already treats some same-transaction multi-log batches differently
from singleton retries; that distinction remains a joint-publication acceptance
case, not a claim of arbitrary event-batch partition equivalence.

The shared scan is still checkpoint-only. Final all-role dependency arbitration,
atomic publication/fence integration, receive-first/sessionless refund activation,
catalog/routes, sealed app handoff and full mounted Confirmation acceptance remain
open. Neither scoped review nor a completed role scan is whole-P3/P4 GO. No
commits, pushes, deployment, live signing, personal Telegram operations or
production policy/permission changes were performed in this increment.

### Joint role arbitration and exact-evidence binding

A shared read-only arbiter now consumes the stored handoff, destination and
refund summaries through bounded candidate pages. It reuses the existing role
rules, keeps every negative operation dependency, deduplicates repeated operation
scans, and refuses mixed revisions or incomplete/codec-unresolved results. It
does not add a queue, persisted aggregate or historical-action rescan. The final
dependency set is necessarily proportional to distinct relevant operations;
truncating it or committing separate partial fences would not be safe.

Refund-source exclusion requires either no issued debit plus empty observations,
or an exact single debit with a proven complete refund/native-delivery result.
`complete` action pagination alone is insufficient. An exact recorded refund, or
a verified proposed receipt supplied by its writer, exempts only its own
operation/segment before requiring the source scan to finish. Thus a partial
refund need not wait for whole-route settlement, and first-receipt publication
does not depend on that receipt already existing. Other source legs and competing
handoff/destination roles are still evaluated.

The recorded-refund reader now returns receipt facts and their operation revision
from one SQL statement, including negative legacy witnesses. Its old verdict-only
wrapper retains existing caller semantics. Fresh independent review reproduced
an important proof-binding defect: a proof from one block could be reused after
re-mining at the same operation revision. The shared fingerprint now binds block
height/hash as well as the exact transfer envelope. Old summaries restart through
the normal reader; recorded and proposed stale-block rejection/recovery are tested.
The reviewer reran 24 focused tests and found no further actionable defect in
this increment, not whole-implementation GO.

The actual leased-event reader and candidate SQL passed disposable PG16 checks.
With 50,000 same-event and 50,000 unrelated candidate rows, custom/generic pages
examined at most 51 rows, used 54–55 buffers and took approximately 0.036–0.196 ms;
empty tails used three buffers. These are local fixture measurements, not
production guarantees. Focused tests passed 69/69, finance-worker checks 24/24,
API typecheck and scoped lint passed, and the full backend build passed 16/16.

The indexed exact handoff/destination reader now preserves negative witnesses
with their same-statement revisions, without the old 256-candidate truncation.
It binds evidence to the physical event and both lookup-codec contexts. The
arbiter loads it only after captured roles are complete, reusing checked
destination summaries. Legacy-only witnesses use the existing bounded action
pager; unfinished pages return explicit continuations and cannot authorize an
external deposit. Persisting those continuations in the final publication path
is still required. No second financial queue or provider request was added.

Fresh no-history review found and then rechecked three reader defects: stale
negative evidence after key rotation, unbounded legacy attempt reads, and a
singleton log incorrectly receiving a terminal mismatch for a multi-log handoff.
The latter now stays retryable until exact log evidence resolves it; the handoff
context version forces older summaries through ordinary re-reading. The reviewer
reran 23 focused tests and found no remaining reader-level issue. This is scoped
review, not whole-P3/P4 GO or proof of runtime recovery.

**Publication blocker: commit-before-send is not a sufficient membership proof.**
A separate fresh review found that a later Deposit Wallet funding operation can
report an earlier same-envelope transaction. Its receipt validator checks exact
transfer logs but not causal submission identity. At that review, the handoff
receipt writer excluded other handoffs, not an already allocated external receive;
the scoped increment below addresses that writer. Reachable legacy
`DepositConvert`/embedded transfer paths also exist
without a funding reservation. Therefore neither `scan_before` nor revision
fencing only enumerated operations proves absence of a later competing claim.
Earlier checkpoint suggestions relying on universal commit-before-send are
superseded. This is an activation blocker, not evidence of a production loss.

The next integration must cover late claims at a shared physical-event ownership
boundary (including the handoff receipt writer), or establish exact causal
submission binding across applicable paths. Preserve replay/reorg repair and
test both receive-first and handoff-first races; do not substitute an arbitrary
age cutoff. Existing source immutability also does not cover reservation
`segment_id` in the legacy guard; audit normal writers before strengthening it.

This remains a decision/dependency builder, **not financial publication
authority**. Initial/retry receive, destination/refund/handoff writers, durable
legacy continuation recovery and the complete E → sorted O → effects → F → COMMIT
contract still need integration before activating sessionless refund discovery.
Catalog/routes, sealed app handoff and mounted Confirmation acceptance remain
open. Whole-scope consecutive fresh GO remains **0/2**.

### Handoff physical-event ownership and consumer recovery

The existing handoff receipt writer now prelocks the old and incoming physical
transfer keys before operation/attempt locks, then revalidates its exact snapshot.
An absent snapshot becoming visible also restarts reconciliation. Confirmed
handoffs reserve the existing canonical-event row before finality; a previously
allocated external receive or recorded destination/refund credit cannot also
authorize a handoff. No new ledger, account, queue or live signing path is added.

Conflicts retain truthful chain finality and set a per-attempt ownership incident.
They do not fabricate a reorg or a safe nonbroadcast failure. The lifecycle blocks
new trade submission but lets the standard consumer repository record an already
executed, exactly linked trade while retaining manual recovery. An unrelated
recovery reason cannot erase that receipt fact. An ordinary valid recheck clears
only the matching attempt's incident. Reorg polls lock the frozen original key,
without inserting a phantom replacement or releasing suppression.

Real PostgreSQL testing exposed loss of finalized timestamp microseconds through
JavaScript Date. Same-status receipt updates now preserve the original database
value; a 123-microsecond fixture checks the actual upsert and immutable constraint.
PG16 action/consumer suites pass: receive-first/handoff-first sequential orders,
legacy finalized conflicts, repeated/reorged evidence, immutable terminal
mismatch, changed snapshot, blocked new send, and preserved consumer outcome.
These sequential ownership cases are **not** a replacement for simultaneous
multi-session handoff/receive tests. Exact snapshot and physical-key queries have
custom/generic index plans on 55,000-row fixtures, including misses and filtered
credits, examining at most one row per accessed base relation. These are local
test measurements, not production performance claims.

Independent scoped review corrected stale reorg identity, legacy finalized
conflicts and absent-snapshot revalidation, and confirmed the timestamp fix.
It also identified the existing `RelayOwnedRefundObserver.persistScan` as a
reciprocal writer then bypassing E ownership (fixed in the acceptance below). Its integration retains the
existing bounded watch and same-key re-mining recovery: old/new E keys before O,
lossless refund-snapshot revalidation, positive role checks and atomic suppression,
without blocking genuine reorg invalidation. The current canonical-event trigger
permits reanchoring only for the exact-refund observer; compatibility for the
legacy owned-refund observer needs a narrow, tested additive extension.

The joint role arbiter remains unwired as allocation authority, and new refund
discovery remains disabled. Reciprocal writers, complete dependency publication,
durable legacy continuations, catalog/routes, sealed app handoff and mounted
Confirmation acceptance remain open. Whole-scope GO remains **0/2**; no goal
completion, commit, push, deployment or production-policy change is implied.

### Nonfinal handoff recovery acceptance

Further independent review reproduced a new recovery regression: a confirmed
transfer re-mined in another block was treated as a permanent ownership conflict.
The unpublished additive migration 0319 and existing receipt writer now permit
only an unchanged, unallocated, internally suppressed handoff to move its anchor
while its prior receipt is still confirmed. Economic identity, allocated-state
immutability and finalized/reorged rules remain unchanged. A saved server-owned
physical key also survives an intermediate nonfinal reverted inclusion; a later
exact success can recover without inventing a second transfer or releasing the
first key. An actual ownership-conflict marker does not authorize this repair.

Legacy confirmed receipts without an owned marker are tested with no E row, E at
the old anchor, and E already at the current anchor. They still undergo current
economic-envelope, allocation, competing-handoff and historical-credit checks.
The last case was found by the independent reviewer and added to the PG matrix.

The complete migration chain through 0319 passed on a fresh disposable PG16.2
database. Actual receipt writes passed confirmed-to-confirmed/finalized re-mining,
the transient-revert sequence, replay and legacy cases. Direct SQL tests reject
changing value during repair or moving an already finalized handoff. The installed
trigger predicate—not a handwritten equivalent—has custom/generic plans against
55,000 receipt rows: indexed hit 8 buffers, wrong anchor 5, miss 3, approximately
0.014–0.019 ms. Exact anchor-update plans examined at most one base row, about
0.13–0.23 ms and 19–22 buffers for hits. These are disposable local measurements,
not production performance guarantees or concurrent handoff/receive acceptance.

The reviewer independently checked the helper's recovery and rejection paths and
found no remaining reproducible issue in this increment. This is **scoped review,
not either of the two whole-P3/P4 GO verdicts**.

The final combined regression run passed all seven PG integration suites (259 s),
27 focused unit checks, 351 HIP funding tests and 24 finance-worker checks. API
typecheck, scoped lint/format and full backend workspace build passed (16/16).
The disposable database ended with no pending classification touches, invalid
indexes, scan headers/candidates or other client connections. Frontend/admin and
live financial acceptance were not reverified by this backend-only increment.

Independent inspection of the next reciprocal writer confirmed a concrete
cross-table gap in `RelayOwnedRefundObserver.persistScan`: its observation unique
key prevents a second funding observation, but not a handoff receipt or an
external receive receipt/notification for the same physical event. Existing
source-credit routing checks remain a backstop; this is not a claim of an observed
double spend. Integration must use the existing E lock and suppression, with:

- Lossless old-refund/source/provider snapshot capture, sorted old/new E before O,
  and exact revalidation after O; changed facts retry via the existing worker.
- Shared positive handoff/destination checks before refund insert/restoration;
  genuine reorg invalidation must remain possible even when restoration conflicts.
- The existing refund reanchor pattern while the old observation is still
  reorged, extending only its observer-ID condition for this legacy writer.
- Two-session receive/handoff/refund orders, same-key and replacement re-mining,
  changed-proof rollback, repeated polls, and the existing bounded-watch tests.

No new ownership ledger, job system, financial authorization or legacy-to-new
refund-contract fiction is required. The owned-refund increment below supersedes
this pending checklist; broader publication and route/UI acceptance remains open.

### Owned-refund publication acceptance

The existing owned-refund observer now prelocks old/new physical events before
the operation, revalidates its lossless snapshot and checks competing recorded
roles before credit. Refused positive publication rolls back speculative event
inserts. Genuine invalidation commits independently of blocked replacement
publication, so a later re-mined replacement can recover. A finalized refund is
watched even before the reservation projector catches up. Same-key restoration
checks the previous economic envelope even when another observer has already
stored the new block anchor. The final target revision fence immediately precedes
COMMIT; it is not yet the full negative-dependency fence described above.

Unpublished additive migration 0320 extends only the existing refund reanchor
observer predicate to the owned-refund observer. Economic identity, immutable
allocation and recorded reorg conditions stay intact. Shared ownership SQL is
sidecar-safe; worker wiring supplies the existing transaction-reference codec.

The fresh migration chain through 0320 passed on disposable PostgreSQL 16.2.
Actual committed writer tests cover pre/post-snapshot changes, duplicate writers,
pre-projector replacement, suppression, same-key/replacement re-mining and both
receive/refund lock orders with real two-session waits. All seven PG regression
suites passed together (232.57 s); 34 focused checks, 351 HIP funding tests and
24 finance-worker checks passed. API typecheck, scoped lint/format and full
backend build passed (16/16). Exact target/credit/E queries used indexes on
50,000-row custom/generic fixtures, with no sequential scan: target hit 30–31
buffers (~0.31–0.43 ms), other-credit 3–4, E 3–5. These are local measurements.

Independent scoped review found and prompted fixes for speculative orphan E,
pre-projector double-positive replacement, late fact changes and legacy economic
mismatch. The final scoped review found no remaining concrete issue in this
increment, but it does not count toward whole-P3/P4 GO (still 0/2).

### Reservationless legacy continuation acceptance

Unpublished migration 0321 extends the existing derived checkpoint table with a
stable work-row identity, retaining real reservation identity where present and
real operation/segment identity for legacy destination-only witnesses. No new
financial ledger, queue, source reservation or receive session is fabricated.
The checkpoint helper saves incomplete exact-reader progress under the same E
lease; normal bounded candidate rotation resumes it. Incomplete checkpoint work
must commit without financial effects, not be rolled back by the future caller.
Actual financial publication is still not switched to the joint arbiter.

Migration 0321 backfills/indexes only this new derived table. Before deployment,
measure its actual size and apply it with old checkpoint workers stopped: older
binaries cannot page reservationless rows. No production migration or activation
has occurred.

The complete migration chain through 0321 passed on fresh disposable PG16.2.
Committed tests cover exact-reader discovery, checkpoint rollback/replay, bounded
resume, revision/codec recovery and a legacy witness coexisting with its later
source reservation. Mixed 25,000 reservationless and 25,000 reservation-backed
rows plus 50,000 unrelated rows retain indexed custom/generic pagination and
cleanup: 51-row pages use 54–55 buffers, empty tails 3, 50-row cleanup 303–304.
The actual partial-unique checkpoint INSERT uses 17–18 buffers, replay 4.

All seven PG regression suites passed together on a new empty database (223.25 s).
An earlier benchmark used a tiny public revision table against large temporary
operation tables; its fixture now also scales revisions, preserving the strict
row-count checks and adding absent-revision-zero coverage. A reused-database run
was contaminated by retained synthetic jobs; it is not counted as a pass.
These are local fixture results, not production load guarantees. The independent
scoped review returned GO; whole-P3/P4 GO remains **0/2**.

### Shared receive publication effects (in progress)

Initial and retry observation now resolve their existing recorded-role inputs
into the same typed decision used by the joint arbiter, then use one DB-only
publication branch. The explicitly named legacy adapter preserves conflict and
recovery precedence, including refund recovery before handoff recovery. It does
not turn a recorded miss into new source-coverage authority. No new financial
guard, queue, provider call or production SQL is introduced by this refactor.

The initial/retry destination path is exercised with real classifiers, credit
allocation and job wake on PG16: failed credit rolls back suppression, ordinary
retry recovers, duplicate/replayed physical events do not double credit, and
internal transfers create no external receive receipt or deposit notification.
Chain observations are synthetic; no signing or live financial request occurs.
The test asserts the injected write failure and both initial/replay scanner calls
actually ran. One hundred role combinations check legacy decision parity.

Fresh independent review found no blocking refactor issue. Joint arbitration is
still not the publication authority: initial staging, complete batch dependency
collection, sorted operation locks and final revision fence/COMMIT must be wired
together before discovery is enabled. The final refactor/staging regression below
passed; that does not activate the joint authority.

### Initial receive staging prerequisite

`stageFundingReceiveClassificationBatch` now owns a short transaction that commits
scope, all physical event locks, selected-session binding and the existing exact
retry lease before returning. It never acquires operation locks or writes credits,
receipts, notifications or scan headers. Source scans start only afterward, using
their database observation time; event timestamps are not commit watermarks.
At this prerequisite checkpoint it was not yet called by either financial
publication path. The activation below supersedes that historical boundary.

It preserves frozen ownership, existing recovery reasons, final suppressions and
the worker's due time. A cleared token is not permission to skip a future due
time. Foreign selection is rejected before binding; missing ownership remains
explicitly unresolved. No new scheduler, policy default, queue or migration is
introduced.

Real PG16 tests cover duplicate/reversed input, immutable-envelope collision,
failure after the second claim with full rollback, a genuinely locked event
skipped by the ordinary worker, reverse worker-first replay, expired lease reclaim,
foreign ownership, missing ownership and final suppression. Exact claim queries
on 50,000-row event and session fixtures use indexes in custom/generic plans:
successful update 27–35 buffers (~0.13–0.41 ms), missing 2, foreign 7, not due 3.
These are local fixture measurements, not a production throughput guarantee.

The independent scoped review found the fresh foreign-binding issue and the
fixture cleanup issue; both are fixed. It returned scoped code-review GO, not
whole-P3/P4 or deployment GO. API typecheck, scoped lint and full backend build
passed (16/16); all seven PG regression suites passed together on a fresh database
(234.91 s). The 351 HIP funding and 33 classification unit tests also passed.
An earlier publisher regression failed its newly added scan-count
assertion because the test retried after 1 ms while the real claimant enforces
1 second. Only fixture time changed; the real repeated scan now passes.

Remaining activation requirements are unchanged, with two explicit integration
constraints found during this review:

- Classification lease authority must be separate from historical retry mode.
  Supplying an initial lease as today's observer `retry` would mark a normal
  deposit late and omit initial cursor/status maintenance.
- Publication ordering must be tested against the actual receipt router. A
  shared-operation cycle is **not established** for ordinary auto-routing: its
  fresh child operation is uncommitted and invisible to other classifiers.
  A concrete shared lock does exist instead: prepared wallet verification locks
  the user row before later requesting session scope; receive publication holds
  that scope before receipt insertion needs a foreign-key lock on the same user.
  The router correction and actual concurrency tests are described below; do not
  claim global lock-order completion from the staging tests alone.

At this checkpoint both initial and retry publication still required complete
dependency collection, joint arbitration, sorted operation locks and the final
revision fence/COMMIT; the activation below implements this receive-side seam.
Exact-refund callback activation, reciprocal/sessionless writers, routes, trading
and mounted app acceptance remain open. Whole-scope GO remains **0/2**.

### Receive router lock-order correction

The real prepared Relay router and receive observer reproduced PostgreSQL 16
deadlock `40P01`: wallet verification held the user row while receive publication
held session scope and waited for the receipt's user foreign-key check. Router
linking then needed that same scope. Both automatic creation branches now take
the existing scope after policy/authorization locks and before wallet verification
or receipt claim. Ownership, generation, policy and financial checks are unchanged.

Independent review caught a second inversion against a concurrent router deciding
that its quote needs review: disposition previously updated the receipt before
requesting scope. Disposition and settlement now acquire the persisted immutable
scope first, reusing the existing indexed session lookup. No new lock namespace,
retry delay, schema or runtime switch is introduced.

The new `receive-router-lock-order-integration-tests.ts` runs the actual public
router and observer, replacing only provider HTTP responses. It tests both start
orders for router/observer and for two routers with accepted versus over-cap
quotes. `pg_blocking_pids`, advisory wait state and third-connection NOWAIT probes
prove the wait is before owner/receipt locking. The normal next observer poll
recovers a stale snapshot exactly once; competing routing decisions cannot create
a second child or overwrite the winner. Four scenarios passed on PG16. Scoped
fresh review returned GO after the second inversion and timeout cleanup fixes.

API typecheck, scoped lint/format and the full backend build (16/16) passed; 387
focused HIP/funding/classification tests passed. All eight PG integration suites
passed together on a new database migrated from empty through 0321 (246.71 s).
Generic planner fallback **creation** is not yet exercised by this new test;
existing linked-child settlement coverage is not a substitute. Joint-role
publication, reciprocal writers and the remaining P3/P4 product paths remain
open. This scoped GO is not either of the two required whole-scope reviews.

### Joint receive publication: initial observation and historical retry

The existing receive observer now uses joint handoff/destination/refund
classification for supported Base/Polygon canonical events, not a shadow read
followed by legacy external allocation. Initial observation commits the existing
scope, complete event lock set, frozen selected-session binding and retry lease
before reading source pages. Missing codecs or incomplete evidence remain durable
pending work on the existing retry clock. Cursor progress cannot erase that work.
Historical unbound events bind their selected session before creating scan state.

Publication revalidates the event lease, collects the complete positive and
negative operation dependency set, locks the sorted operation union, applies the
shared receipt/quarantine/destination-credit effects, acknowledges leases and
updates the session, then fences revisions immediately before COMMIT. Incomplete
classification checkpoints commit without financial effects. Initial authority
is separate from historical retry mode: fresh receipts retain normal conversion
semantics; historical repairs do not restart an old automatic conversion or Buy.

Mixed EVM/Solana batches include legacy destination effect owners in the same
sorted lock union. Such lock-only owners do not receive invented classification
revisions. Reobserving a legacy owned-refund suppression does not reopen it merely
because the newer exact-refund reader finds no receipt: rechecking requires an
actual recorded exact-refund classification. No new policy, queue or delay was
introduced; the worker passes its existing receive delay separately from the
explicit scan cadence. No signing, source transfer or provider call occurs in the
classification transaction.

`receive-joint-publication-integration-tests.ts` exercises the real PG16 readers,
staging, classification, revision triggers and publisher. It covers normal
initial receipts, reverse/duplicate events, replay, missing-codec recovery,
historical unbound binding, preserved legacy refund suppression and a mixed
Base/Solana credit. Its revision race commits a real mutable segment change,
checks the revision increment, observes both uncommitted receipt effects at the
final fence, then verifies rollback and bounded retry recovery. The mixed test
creates its legacy owner after source enumeration and checks the actual fence
payload, sorted lock union and third-connection NOWAIT probes; it therefore tests
the additional effect-owner lock rather than accidentally warming it as a source.

Synthetic role-precedence/cleanup tests explicitly use
`recordedRoleObserverFixture`; they are not evidence of source completeness.
The legacy destination continuation test remains a real joint-reader test, with
a genuinely legacy plan committed without the newer refund contract. It checks
the verdict, bounded recovery after provider-fact changes, failed-credit rollback
and subsequent initial/retry publication. A separate marked-source test exposed
and fixed a same-leg circular dependency: a verified exact destination must not
wait for its own first destination credit merely to rule out a possible refund.
The exact destination retains its checked facts revision; other source legs,
positive refunds, handoffs and competing exact destinations still arbitrate.
Unit tests cover those conflicts, and PG16 covers first credit, rollback, replay
and ordinary recovery for both legacy and marked-source destinations.
Actual router races retain real joint reads and recover via
bounded ordinary polls rather than assuming one tick is enough for all pages.

Independent no-history scoped review found the unsafe legacy-refund reopen and
the missing mixed-batch operation locks; both were corrected. Its final scoped
verdict is GO. This is **not** whole-P3/P4 GO (still **0/2**). All six focused joint
cases and four router races pass, as does the exact-refund regression. API
typecheck, scoped lint and 411 focused unit tests pass. The full backend build
passed 16/16. All nine integration suites passed together on a fresh PostgreSQL
16.2 database migrated from empty through 0321 (235.23 s). The earlier combined
run had two outdated fixture assumptions and is not counted as a pass.

Remaining: reciprocal/sessionless destination and refund writers still require
full competing-role dependencies; their target-only fences do not complete that
contract. The exact-refund worker callback remains disabled. Generic planner
fallback creation needs its own router acceptance. Funding catalog/routes,
sealed native app handoff and mounted Confirmation lifecycle acceptance remain
open, followed by full cross-repository verification and two consecutive fresh
whole-scope GO reviews. Existing frontend/admin work and local app state are
untouched by this receive-only increment; there was no commit, push or deployment.

### Shared checkpoint adapter for sessionless provider reconciliation

The role-page implementation is shared by validated receive leases and a new
provider-job adapter; it does not fabricate receive sessions or create another
queue. Additive migration 0322 permits a null pair for session/variant provenance.
The adapter verifies the real operation owner, locks and validates the canonical
physical event, checks any existing session owner, and advances at most the
existing page budget under a caller work identity. It creates no financial
receipt, credit, session, suppression or job wake. Its financial callers are
**not activated**: full source membership and joint dependency fences still need
to be supplied by each reciprocal writer.

A receive session must not directly trust enumeration done before its lifecycle
boundary. Independent review caught this adoption gap. Bound reads now remain
pending until the first valid lease atomically adopts the session/variant and
restarts bounded source enumeration; captured candidates are retained. Adoption
precedes work-token replay detection. Subsequent normal leases resume pages, and
same-owner codec recovery does not require manual state deletion.

The actual PG16 merge regression creates ordinary wallet-route plans, cancels
their unbroadcast actions through the existing cancellation service, verifies
released reservations, and calls the real user merger. An older imported source
is then discovered by receive re-enumeration rather than omitted from a stale
negative dependency set. Immutable source/refund snapshots keep their former
account ID while relational ownership moves. The shared identity treatment below
supersedes the initial unresolved-reader limitation; cancellation or a timestamp
in `userMergeAudit` is still **not** proof that an imported dependency may be ignored.

Custom and generic plans were checked on 50,000 temporary events, sessions and
checkpoint headers. Event-owner lookup uses 3–7 buffers; exact header adoption
uses 10–11 (2 for a missing header), with indexed access in every case. Coverage
includes bound, foreign-owner, allocated, unbound and missing events. These are
local PG16 measurements, not production benchmarks. All nine integration suites
passed together on a fresh PG16.2 database migrated through 0322 (248.43 s).
Postchecks found zero pending revision touches, invalid indexes, checkpoint
headers/candidates or remaining test-client connections. Full backend build
passed 16/16; API typecheck, scoped lint/format, 351 HIP-funding tests, 25 focused
classification tests and 24 finance-worker tests passed. Scoped independent static
review found no remaining checkpoint-adapter blocker after adoption was fixed.
It is not either required whole-P3/P4 GO review; that count remains **0/2**.

### Frozen economic identity and common funding catalog — October 16

`readCommittedFundingIdentity` separates the authorized current relational owner
from the original subject in the immutable operation source snapshot. Source,
refund and native settlement readers share it; all bound account IDs must agree
with that independent source lineage. Legacy unscoped snapshots retain their
same-current-owner behavior. Mixed composite subjects and malformed source shapes
are rejected. No frozen snapshot, original-subject HMAC or lookup key version is
rewritten, and no merge timestamp or new keyring becomes financial authority.
Exact-refund context race checks and competing-role queries use the current owner.
Derived role checkpoints were version 3 at this checkpoint (version 4 below
supersedes it); ordinary bounded enumeration upgrades old
invalid candidates without manual cleanup, including reuse of the same work token.

PG16 acceptance uses the actual source-debit writer, exact-refund writer, reducer,
terminal user merge, canonical watcher and replay. It verifies unchanged economic
snapshots, key rotation, current-owner dependencies, no duplicate receipt or job
wake, and a newly competing destination belonging to the current owner. The
sessionless adoption fixture now converges after the real cancelled-source merge.
All nine integration suites passed together on a fresh database migrated through
0322 (245.84 s); postchecks again found no leftover classification touches,
checkpoint rows, invalid indexes or test-client connections.

The existing compact `funding_control_plane` catalog and its admin editor now
include Hyperliquid and `hypercore:usdc`. Native USDC8 uses the existing spot
`venue_account` identity, source/settlement capabilities and registered Relay
routes. It does not invent a manual native receive scanner or grant trading,
withdrawal or delegated-signing permissions. Empty defaults stay off. Pause,
asset/venue removal and re-enable recovery use the ordinary policy paths.
Canonical asset comparison preserves EVM token case semantics.

Scoped no-history identity and catalog reviews returned GO after corrections;
neither is whole-scope acceptance. API typecheck, 351 HIP-funding tests, 24 worker
tests, the 16/16 backend workspace build, admin typecheck/lint/build and 47 admin
tests passed. All 4,096 compact-policy combinations compiled in scoped review.
Reciprocal financial writers, remaining routes, sealed app handoff and mounted
Confirmation/browser acceptance remain open. Whole-scope GO remains **0/2**.

## 57. Membership lifecycle, pUSD recovery and Account Value read aliases — October 16, 2026

This supersedes the earlier unresolved original-owner checkpoint, not the listed
whole-P3/P4 acceptance gaps. The exact-refund callback and reciprocal financial
publication are still **not activated**. No production policy, privileges,
financial action, commit, push or deployment was changed.

### Sessionless membership through the existing merge lifecycle

`funding-role-membership-lifecycle.ts` reuses the existing user-row merge fence.
Derived pages take full physical-event locks, then the owner row KEY SHARE
NOWAIT, reread current ownership and commit checkpoint work without taking an
operation lock afterwards. Financial-ready reads remain pure. Their caller must
collect the full sorted operation dependency union before the late NOWAIT owner
and current-header check; only then may it publish DB effects and fence revisions
immediately before COMMIT. A contended owner or changed membership rolls back
before the ordinary bounded retry. Non-READ-COMMITTED callers are rejected.

The central authorized merge transaction already owns the sorted source/target
users and source operations. After moving ownership it reparents and restarts
both owners' non-cleanup sessionless checkpoints: a new database cutoff, cleared
source cursors/work token and incomplete enumeration. Captured candidate rows
and financial facts remain unchanged. Additive 0323 indexes this exact owner path;
contract version 4 restarts older same-owner derived semantics. Dry-run rolls the
restart back; keepSource does not change which operations move. No new epoch,
queue, arbitrary delay or historical Buy continuation was introduced.

Real PG16 coverage includes absent/existing headers, both merge/page orders,
keepSource variants, dry-run, actual NOWAIT contention and a distinct race where
merge commits while the publisher retains E but before it takes U. The late
current-header read rejects that stale ready result and ordinary enumeration
recovers the imported dependency. Representative custom/generic plans on 50,000
temporary rows use indexed access: owner hit 4 buffers/miss 2, restart hit 25–30
buffers/miss 6. These are local measurements, not production benchmarks.
Old outgoing-owner orphan headers created before this lifecycle hook are not
automatically adopted; no financial runtime caller has created sessionless
headers before activation. Do not claim that unrelated historical recovery is
covered by the same-owner version upgrade.

### Exact pUSD source selection and reorg recovery

The ordinary Relay registry includes `polygon-pusd-to-hypercore-spot-usdc`.
Inbound source currency is pinned independently from the wire response. The
source, fee, protocol order, approval, deposit and both refund envelopes preserve
the exact token/owner/raw units. A shared registered-and-pinned-stable subset is
used by source-action accounting, claim valuation, snapshot eligibility and the
refund evidence currency selector. pUSD is never silently treated as USDC or
USDC.e. The pUSD quote is an explicitly synthetic variant of captured Polygon
wire data, not new live route evidence.

The real three-asset PG suite found a further SQL-only mismatch: published 0302
allowed the exact observer to restore USDC after re-mining but excluded pUSD.
New additive 0324 replaces that trigger function with exactly one token-set
change. Every economic identity, allocation, finality, append-only history,
legacy and native guard is retained. The migration performs no historical DML,
data-dependent assertions or external reads. Published 0302 is unchanged.
The new PG helper uses an actual writer-created refund, accepts its unchanged
economic event with a new anchor, and rejects amount/asset/decimals/network,
source/recipient/hash/index/kind/time changes, erased metadata, valid-history
provenance deletion, missing new anchors and an unknown-token historical row.
The existing canonical watcher also exercises remine and receive-anchor recovery.
Only synthetic fixture lifetime was extended for lengthy SQL plan probes; all
production quote, metadata-age, nonce and expiry checks remain unchanged.

### Canonical read aliases without rewriting financial identity

`funding-read-location-identity.ts` regenerates current-owner read identities from
validated original-subject lineage only in known canonical EVM-wallet and native
spot/perps namespaces. It preserves the original location and never grants
execution authority. Arbitrary legacy IDs, synthetic controller aliases,
`balanceLocationId`, wrong original owners, environment/decimals or incompatible
DEX markers do not become address-only merge authority.

Account Value now reads the immutable operation source alongside bound segment
facts. Source retention/fencing validates that source independently; completion
and refund aliases additionally require every primary/alternative refund owner
to match. A damaged refund binding therefore cannot erase the narrow stale-source
fence when its reservation is missing. The real terminal merge test checks
completed claims, current read aliases, reorg/freshness recovery, unchanged
snapshots/HMAC/key version, ordinary replay and current-owner competitors.
Same-owner rows avoid unnecessary canonical re-hashing.

Verification for this increment: fresh empty PostgreSQL 16.2 migrated through
0324; all nine financial integration suites passed together (257.93 s), including
the updated real merge/reorg test. The three-asset receipt/recovery suite and its
custom/generic SQL plans passed separately. The 5,000-leg local settled-history
probe used indexed per-operation reads (241 ms SQL, 557 ms read projection);
this is not a production latency claim. Final postchecks found zero pending
classification touches, invalid indexes, checkpoint headers/candidates or other
test-client connections. All 356 HIP-funding tests, 80 narrower
claim/cash/refund/identity tests and 24 worker tests passed; sets overlap. Scoped
lint/format and an uncached full backend workspace build passed (16/16,
28.26 s). No frontend code changed in this increment and its inherited dirty
work was preserved; these backend results do not establish browser acceptance.
The two scoped independent reviews found the pUSD guard and final read-alias
increment acceptable after corrections, not the entire P3/P4 implementation.

At this checkpoint Account Value merge support was **partial** (section 58
supersedes this specific debit-read gap): the native/EVM post-snapshot
debit SQL and shared native preparation aggregate still match historical
reservation IDs to current component/location IDs. They need the same validated
canonical treatment before claiming merged spendability coverage. Fresh physical
snapshots must continue to recover through normal reads; do not globally relax
owner, asset, DEX or generation checks.

### Remaining full-path obligations

Independent review reproduced a separate NO-GO in the full Polymarket Deposit
Wallet → controller pUSD → Relay → Core plan. Its source-input reservation is the
venue balance, while the Relay leg uses a synthetic controller location. Merely
accepting `balanceLocationId` would hide the accounting problem: venue 100,
handoff 10, refreshed venue 90, then controller Relay debit 10 must leave venue
90, not 80. Bind the actual same-operation exact handoff and canonical ownership,
use the existing canonical controller future-credit fence, and attribute each
physical debit to its own location/time/segment. Alternatively reuse explicit
preparation followed by a freshly observed/requoted controller leg. The handoff
is operation-scoped; the Relay action fold remains transaction-only.

After those read/accounting fixes, finish reciprocal joint publication and its
worker wiring, generic fallback-creation acceptance, Solana directions, sealed
native app handoff and mounted Confirmation/browser acceptance. Scoped positive
reviews and local suites are not either required independent whole-scope GO.
The whole-scope counter remains **0/2** and the goal remains active.

## 58. Shared merged snapshot debits and narrow unknown recovery — October 16, 2026

The post-snapshot debit gap from section 57 is fixed in the common read path,
not through a HIP-only balance mechanism. `funding-snapshot-debits.ts` starts
with the existing indexed physical/time tail, then reads current operation
ownership and operation-scoped reservation proofs. One statement returns legacy
strict matches and canonical alias candidates. Candidate admission uses the
same immutable source lineage and canonical read-identity helper as the movement
reader. Native physical readers retain the existing optional component guard;
EVM readers require the exact component. Native token identity remains exact;
EVM token equality retains its existing case semantics. Duplicated reservation
proofs do not multiply a debit. No financial snapshot, reservation, HMAC or
execution authority is rewritten.

Account Value, native preparation, native send capacity and HIP order admission
now use that shared admission path. Preparation retains one MVCC statement for
pending holds, order holds and strict/candidate debits; aliases are not pre-read
in another snapshot. Merge still rejects active reservations, so this terminal
merge fix does not claim support for migrating active financial holds.

Independent review reproduced a fail-open edge in the first draft: rejecting a
legacy alias silently returned zero debits. The corrected reader preserves it
as a separate diagnostic, never as admitted money. Account Value marks only the
requested stale component unpriced/unknown and still processes valid debits for
other components. Native preparation/send/order admission return their existing
recoverable evidence/capacity errors. An ordinary physical balance read newer
than the debit removes the candidate through the unchanged indexed time bound;
no manual cleanup, new cooldown or permanent veto is required.

PG16 rollback fixtures cover canonical native/EVM aliases, duplicate proofs,
repeated owner moves, released reservations, reorg and restored canonical debit,
strict native token matching, rejected legacy proof, a narrow component mask and
fresh-snapshot recovery. A separate real central terminal merge uses the actual
source receipt writer and verifies old-snapshot debit suppression plus fresh
recovery. Representative custom/generic plans retain both existing tail indexes
with 400,000 debit rows: hit 12–16 local buffers, resumed/sparse/empty 0–4;
preparation hit 13. These are local fixture results, not production benchmarks.

The scoped independent review returned GO after both findings were corrected.
All 356 HIP-funding tests, 41 focused identity/cash/preparation tests, four common
Account Value/reservation regression files and the full backend workspace build
passed (16/16, 14 cached, 21.21 s). The sets overlap. The three additional real
PG16 native-send/order-runtime/order-submission suites passed together (20.16 s),
including shared holds, stale-capacity retry, concurrent one-submit, replay,
BUY/SELL/cancel and merge guards. Their unchanged active-exposure probe measured
174–589 ms and 144k–450k buffers on dense owned-history fixtures; do not mistake
the new narrow debit-tail results for proof that every financial query is cheap.
Frontend/admin code and the user's local app database/auth were untouched.

This does not close the separate Deposit Wallet handoff accounting gap, activate
reciprocal sessionless publication or finish the remaining routes, sealed native
app handoff and mounted browser acceptance. Two consecutive fresh whole-scope GO
reviews are still required; the whole-scope counter remains **0/2**.

## 59. Exact frozen handoff binding and physical receipt — October 16, 2026

The ordinary source planner now preserves the economic venue source separately
from the canonical controller execution source. A Relay leg retains its original
source-input reservation and the existing operation-scoped controller
future-credit fence. Composite planning counts only economic inputs towards
cash capacity, but retains both physical reservations for rebasing/conflicts.
Provider-paid gas never makes a Deposit Wallet handoff automatic: it still
requires the user's existing review/signing path. No standing allowance,
factory-only Deposit Wallet call or new transaction mechanism was introduced.

`polymarket-handoff-binding.ts` validates the exact immutable source, controller,
profiles, token, amount, reservation pair, handoff action and dependency ancestry.
`polymarket-handoff-binding-repository.ts` reads the existing immutable quote and
actual current source/fence rows by exact keys, rather than reconstructing plans
from attempt history. A finalized handoff additionally requires its same-operation
attempt, action fingerprint, receipt and currently owned canonical physical
event/anchor. A copied receipt from a different operation is rejected even when
the fingerprint is identical. Polling does not replace the first finalization
time. These are read proofs, not permission to continue an old purchase.

PG16 acceptance uses actual quote/commit, deferred segment validation, attempt,
receipt and canonical-event writers; no provider or signer is called. It checks
the null-scoped controller fence, exact storage reads and foreign owner/key
rejection. Handoff creates no second `funding_observations` claim. Prepared
custom/generic queries also run against 100,000 same-owner physical fences and
50,000 unrelated rows in each plan relation, without sequential scans. The full
receipt integration suite passed, as did 357 HIP-funding tests, scoped lint/format,
API typecheck and the full backend workspace build (16/16, 14 cached, 24.18 s).
Scoped independent no-history reviews found no remaining helper/planner blocker
after composite capacity, user-action admission and cross-operation receipt
issues were fixed. They are not whole-P3/P4 GO reviews.

At this checkpoint the physical receipt helper was not yet connected to common Account Value,
reservation settlement or the paged role classifiers. Therefore the full handoff
accounting obligation from section 57 is still open, not implicitly fixed by a
valid frozen plan. The next increment must distinguish the two physical balance
times, preserve the controller credit-lag gap, share hold settlement with commit
admission, and test reorg/recovery. Reciprocal publication, remaining routes,
sealed app handoff and mounted browser acceptance remain open. No production,
user auth/admin, frontend, personal Telegram, git or deployment state changed.

## 60. Shared handoff accounting and exact physical holds — October 16, 2026

This supersedes section 59's unwired Account Value/reservation status, not its
remaining whole-P3/P4 obligations. The normal receipt writer now records a small
server-derived discovery hint on the existing receipt. Transport-supplied hints
are discarded. The hint contains physical asset/addresses and exact plan-row
pointers, not monetary authority. A damaged/deleted current binding retains its
older discovery hint so the reader reports a narrow gap instead of losing it.
No handoff debit/credit observation, new financial ledger or second claim exists.

`funding-handoff-snapshots.ts` uses indexed physical/asset/time tails, then
hydrates the immutable quote, current relational owner, actual source/fence,
step, attempt, receipt and canonical event in **one SQL statement**. Exact-key
subqueries prevent account-history scans. Discovery pointers are safely decoded;
bad pointers or a lost/reorged/conflicting proof cannot admit money. Terminal
destination/refund status does not remove these physical snapshot tails.
Polymarket funder read aliases now reproduce only the existing canonical derived
venue namespace; the shared cash constructor uses the same identity. No
controller alias, arbitrary legacy ID or address-only ownership is accepted.

An independent review caught a timing error in the first draft: a balance read
can already include H **before the first finality poll**. Wallet balance timestamps
are captured before awaiting latest-RPC IO and do not retain a ledger height.
Consequently even a valid H cannot justify subtracting its amount from that
snapshot by wallclock ordering. Both selected source/controller tails are
diagnostic raw zero plus `funding_handoff_snapshot_pending`, not monetary zero
cash or another debit. The common projection marks only those old physical
components unpriced/availability-unknown. An ordinary post-finality physical
refresh removes the tail immediately; there is no housekeeping delay, repair
write, new quote or historical Buy continuation. The proof timestamp is explicitly
named `finalityObservedAt`, not Transfer time. SQL-bound snapshot identity also
preserves the unknown decision when PG microseconds map to the same JS millisecond.

The normal Relay in-transit claim validates the different economic venue input
and canonical controller fence through the exact frozen binding. It is attributed
to the physical controller, never debited again against a fresh venue90. The
legacy submitted-debit aggregate likewise does not report controller D as a
second physical venue debit. The native/EVM monetary debit paths are otherwise
unchanged; a rejected controller debit proof still stays unknown until refresh.

Exact owned finalized H releases only its original source-input reservation.
Exact same-segment controller D releases only its bound future-credit fence.
Both releases are idempotent and use the existing reservation lifecycle. E was
locked before O; the later H settlement only reads that same prelocked identity.
The shared pending guard is used by reducer release, availability and commit
conflict admission. Confirmed/ambiguous H cannot be released by an early D or a
sibling/terminal result. The controller guard follows its exact downstream leg,
not every operation step. H-only user cancellation with no broadcast Relay debit
retains the ordinary safe cancellation/release path. Other venue routes are not
reclassified by this native-inbound structural guard.

Additive 0325 creates concurrent receipt discovery indexes without historical DML
or data-dependent rollout assertions. A dense PG16 probe found a redundant
leading network key could make even empty tails walk old index pages. The final
index omits that constant (already fixed by its partial predicate): with 100,000
old same-physical receipts, custom/generic empty/sparse reads use 12 local buffers
instead of 344; current hit reads used 26–53. These are local fixture measurements,
not production latency evidence. Two new empty disposable databases migrated
through the complete final 0000–0325 chain. An earlier disposable database retains
a draft 0325 checksum and must not be remigrated as the current schema.

Actual PG acceptance covers first confirmed H, early real controller D and commit
conflict, finalized H replay, H-only cancellation, H/D physical releases, one
Relay claim, preexisting controller10, venue90 refreshed before/after finality,
missing fence, reorg, forbidden stale-finalized revival and ordinary fresh-read
recovery. The full receipt integration suite passed after the timing correction.
The broader common-finance regression rerun passed all 11 PostgreSQL suites on
the final 0000–0325 schema, including the last submitted-debit exclusion change.
All 357 HIP-funding tests, 16 focused proof/alias tests, common persistence/lifecycle
regressions, scoped lint/format and the full backend workspace build passed
(16/16, 14 cached, 21.38 s); these sets overlap. Scoped independent review passed
after its timing finding was corrected. This is **not** a whole-scope GO.

Before calling the entire handoff path accepted, finish
merged-owner/legacy discovery and complete failure/terminal/refund coverage, and
the binding-aware paged role classifier integration. The future-fence, dependency,
profile and owned-event fields must be added to the classification projection in
a new additive migration if those paged readers begin consuming them; 0317 is
unchanged. Reciprocal sessionless publication/callback activation, remaining
routes, sealed native app handoff and mounted/browser acceptance still remain.
Whole-scope consecutive fresh GO remains **0/2**. No git/production/financial
activation, personal Telegram, app database/auth/admin, Redis or server change
was performed.

## 61. Reciprocal Relay destination publication — October 16, 2026

The ordinary Relay destination receipt publisher now uses the shared resumable
role scan for supported EVM receipts. It is not a HIP-specific credit path.
Native HyperCore retains its exact native observation contract, without a fake
EVM event or receive session. The existing funding job lease token/deadline is
passed through normal and stopped-evidence provider polls; the worker supplies
the existing runtime batch policy as the page limit. Missing work/codec context
does not fall back to a positively filtered legacy classifier for supported EVM.

Publication takes the complete physical E footprint before alias collapse,
reads all roles without financial effects, locks the sorted union of positive
and negative operation dependencies, then takes the nonwaiting current-owner
membership fence. Only the exact destination decision for this leg can credit.
The final facts fence is immediately followed by COMMIT on the original client.
Derived work instead commits E → U NOWAIT → one page/checkpoint, with no later
O lock or financial effect in that transaction.

Integration acceptance exposed two recovery gaps: an action-complete source can
still require observation pages, and a cached positive decision can retain an
old negative dependency after a failed final fence. Every recovery verdict,
including a conflict containing unfinished evidence, now advances checkpoint
work only; a real positive-role conflict never gains credit authority. A pure
exact-set owner/revision check rejects stale summaries into the same fair page
rotation. It does not replace captured revisions or substitute for final F.
With 50,000 unrelated operations/revisions, actual PG16 custom/generic plans for
100 exact dependencies used 600 local buffers and 0.24–0.27 ms; stale/foreign
tails used 6, missing 2 and empty 0. These are local fixtures, not production SLOs.

Scoped independent review found that checking a deadline once per event did not
bound SQL waits or a dense summary fold. A transaction-local query adapter now
sets statement/lock limits to the remaining existing job budget before each
query. Raw BEGIN/isolation, cleanup and the final F/COMMIT pair bypass that
adapter; expiration cannot prevent rollback or insert a query after F. Budget
exhaustion preserves previously committed pages and retries normally, without a
new queue, arbitrary delay, dependency truncation or historical Buy continuation.

The real PG16 destination suite passed with reversed/duplicate multi-events,
checkpoint-only ordering, same-owner negative-witness races and normal recovery,
missing-codec recovery, actual held-E timeout/fresh-deadline recovery, recorded
refund conflict atomicity, prior external allocation, target no-O writer race,
replay and native positive control. Scope-only independent rereview found no
remaining actionable issue. Additional common persistence, Relay reconciliation
and HIP funding receipt PostgreSQL regressions passed (3/3, sequential, isolated
PG16). API typecheck, scoped lint/format and the final full backend workspace
build passed (16/16, 14 cached, 22.81 s). Database postcheck found no outstanding
classification touches, invalid indexes or other client connections. These
checks do not assert that retained synthetic fixtures contain no financial rows.

This verifies only the listed destination-publication cases, not complete
reorg/remine acceptance (section 62). Owned refund
and exact-refund reciprocal activation, complete race/post-window recovery,
handoff legacy/merged/terminal acceptance, remaining routes, sealed app handoff
and browser acceptance still remain. Whole-scope GO stays **0/2**. No commit,
push, deployment, production policy/permission, financial signing, personal
Telegram or app DB/auth/admin/Redis/server mutation was performed.

The owned-refund remine integration must preserve its existing old/new physical
footprint and controlled anchor repair. The generic sessionless event adapter
currently requires the supplied anchor to match E. It must not be reused with
a new remine anchor by relaxing identity collisions or updating E before role
arbitration. Resolve that authority boundary, add both-order acceptance and
prove normal worker/deadline/terminal-timeout behavior before enabling the
remaining reciprocal refund callbacks. Existing immutable reorged-attempt
no-revival and evidence-only historical Buy detachment remain mandatory.

## 62. Bounded local drain and remaining anchor authority — October 16, 2026

A separate no-history integration-boundary review confirmed that one derived
page per queue tick can manufacture a missing-evidence timeout. Production
defaults use 2-second active polling and a 90-second generic timeout. Immediate
test loops with fixed `now` do not prove normal worker timing.

The destination publisher now drains a bounded number of checkpoint pages under
the **same existing lease deadline**, reusing the runtime batch limit for both
rows/page and pages per observation invocation. Each page commits and releases
its E → U checkpoint transaction before a **fresh** full-E publication attempt;
the final attempt never acquires O after checkpoint U. The provider/RPC
observation is outside this local loop and is not repeated. Page work identities
are deterministic custom UUIDs derived from the existing lease token, incoming
event fingerprint and page ordinal. They are not new leases, financial nonces or
submission authority. Last-token replay suppression is not a durable seen-set:
an older replay can advance derived work again, within that invocation's page
cap and the original deadline. No exactly-once page budget per root lease is claimed.

Actual PG16 acceptance passed normal source/role work plus publication within
one 30-second lease at runtime batch size 25, as well as the existing limit-one,
negative-witness/replay, conflict, deadline and native cases. Three focused budget
and work-identity tests, scoped lint and API typecheck passed. Scoped review found
no new issue in the bounded loop. Final common persistence, Relay integration
and HIP receipt regressions passed (3/3, sequential, isolated PG16). The final
destination/concurrency suite additionally verified one observation per local
drain, the runtime page cap, and rejection of an unproven pending-anchor change.
The full backend workspace build passed (16/16, 14 cached, 23.32 s). Subsequent
queue-path acceptance with advancing `now`, actual lease/due/reducer operations,
dense negatives, multiple events and stale-summary repair is recorded in section 63. Its synthetic provider callback is not full worker/live-provider acceptance.

The same independent review found a genuine remaining canonical recovery gap:
a checkpoint may commit unowned E at anchor A before any financial receipt.
If the exact transfer re-mines at B while classification is pending, current
strict identity and triggers correctly refuse a casual anchor change. Existing
known-event retries reconstruct A without RPC and cannot prove B. This affects
destination checkpoints too; section 61's scoped pass is **not** full acceptance.

The next common primitive must be controlled **canonical-evidence reanchoring**,
not earlier financial allocation or a generic ignore-anchor flag. Reuse the exact
canonical verification already used by refund watch: replaced old block, exact
same transaction/log/asset/parties/amount at a confirmed new canonical block;
inconsistent two-anchor evidence remains pending. Persistence requires a locked
full old-snapshot CAS, truly unallocated/unowned state (including receive binding
and financial/handoff owners), unchanged economics/observation timestamps, and
atomic invalidation of stale retry/anchor-bound derived context while retaining
captured dependency identities. This capability is not yet implemented. A new
additive migration is required if the database admission/provenance changes;
published migrations must not be widened in place.

Recorded owned-refund remine needs its own narrow already-locked authority
adapter into the shared core, preserving incoming fingerprints and all existing
reorg/ownership checks. Exact and owned receipt publication can reuse existing
`verified_proposal` evidence, then full negative/positive O union, late U and F.
The exact runtime must own its final transaction rather than call the F/COMMIT
helper inside `infra.tx`. Canonical-watch **recanonicalization** is another
positive publisher requiring this integration; its existing target-only tests
are not proof of joint authority. Invalidation-only loss of an old refund must
remain available without waiting for positive-role completion or replacement.

Required acceptance includes pending A → B before any receipt, recorded remine,
changed economics rejection, binding/allocation/financial ownership arriving
during RPC, stale A worker after repair, both ownership orders, merge, deadline
and stopped-job repair. The original no-revival/old-Buy-detachment guards remain.
Exact-refund callback remains off. The whole P3/P4 goal is active, **0/2** final
consecutive whole-scope GO reviews. No git/production/financial activation or
personal Telegram change has been performed.

## 63. Physical-key serialization and queue-path recovery — October 16, 2026

The pending-anchor review identified an insertion race that an E-only lock or
two absence reads cannot close: a legacy financial writer can insert an owner
before any E exists and commit after a speculative checkpoint. The solution
reuses the **existing** handoff physical-key advisory namespace, now uniformly
try-only; it is not a new lock domain, ledger or financial authority.

Additive migration **0326** gates new canonical E, observations, receive
receipts and physical step-receipt claims. Anchor-changing E updates and positive
restorations participate too. No historical DML/backfill/assertion is added;
unchanged metadata, ordinary merge and truthful retraction remain available.
Both old/new retained handoff markers are covered even if the outer transaction
hash is absent or different. The explicit handoff call preserves its exact
native namespace as well as EVM keys; replacing it with an EVM-only helper would
silently remove the old native serialization.

No acquisition in this physical namespace waits. In particular, a handoff that
already holds E/O cannot wait on another creator's gate while that creator waits
on E. The exact tagged `55P03` result rolls back the current pass. Destination
publication returns pending only **after rollback**; common queue errors use the
existing active-poll cadence, preserving generic timeouts, facts fences and
submission/lease semantics. Busy/unknown SQL errors are not interchangeable.

Real PG16 tests passed absent-E ownership in both orders, duplicate ON CONFLICT
replay, the actual existing-E/gate lock cycle, native namespace control, reversed
old/new stored-marker contention, and diagnostics/retraction during contention.
The ordinary worker test now requires busy → scheduled +2 seconds → actual
destination publisher → two atomic credits → reducer `completed`, without manual
requeue or any signing/submission. First-key receive/refund overlap explicitly
tests try-busy rollback with O still free and a successful fresh full-E retry;
separate existing-E tests retain actual E-wait/deadline coverage.

Queue-path timing acceptance uses two events and 24 valid negative sibling
contracts, actual job claims/lease tokens/due scheduling/reducer, and advancing
application time. An injected no-O change just before F must produce one failed
pass, zero credits/suppressions and an exact ordinary 30-second retry. Eventual
normal jobs refresh stale summaries and reach `completed`. Fresh-database run:
611 derived pages, 26 job passes, **78 seconds modeled cadence**, not production
wall-clock throughput. The callback supplies synthetic verified chain events;
this is not the full finance-worker/Relay-driver/provider composition.

Both complete fresh 0000–0326 migration and application over retained legacy
fixtures passed. The full profile concurrency/SQL suite passed on both schemas,
including representative custom/generic plans. Five budget/gate unit tests,
scoped lint/format, API typecheck and the full backend build passed (16/16,
6 cached, 24.99 s). Common persistence, Relay integration and HIP receipts passed
again (3/3); eight additional common/native/delegated/receive regressions passed.
Two global-queue test cases now raise and restore only their exact fixture job's
priority; product queue ranking is unchanged. Receive/owned-refund overlap tests
accept only the new tagged contention or the existing facts-change result, then
require ordinary retry and the original exactly-once credit/ownership checks.
Both PG16 databases ended with zero staged classification touches, zero invalid
indexes and no other connected clients. Independent read-only reviews found no remaining scoped
implementation issue after fixes; none counts toward final whole-goal GO.

This increment **does not implement or enable pending reanchor**. It closes the
absent-parent serialization prerequisite only. A later narrow CAS still needs
exact replaced-block/current-log proof, READ COMMITTED and a fresh statement
after gate acquisition, any-status physical owner/receipt checks, retained
handoff ownership, full old envelope/anchor match and immutable observation
timestamps. Preserve bound session/variant ownership and candidate identities;
invalidate old retry authority and refresh anchor-bound summaries through normal
bounded pages. Do not bulk-clear dependencies or make binding itself permanent
financial ownership. Legacy case/null-sender evidence must not become a negative
proof by filtering it out. No generic ignore-anchor switch is acceptable.

Recorded refund remine, joint owned/exact/watch publication, full worker/stopped
repair acceptance and the remaining routes/app/browser/performance obligations
remain open. Exact-refund callback remains off. The P3/P4 goal remains active;
consecutive independent whole-scope GO count is **0/2**. No commit, push, deploy,
production permissions/policy, personal Telegram or local app DB/auth/admin/
Redis/server change was performed.

## 64. Receipt-driver contention recovery and known-anchor proof — October 16, 2026

Real receipt polling aggregates independent inspection/persistence failures.
The shared physical-busy predicate now recognizes a **nonempty, recursively
all-busy** `AggregateError`; empty/mixed aggregates retain normal failure
handling. Terminal polling retains its failed-verification result and separately
identifies pure contention, so every existing canonical/invalidation callback
still runs. It uses the existing active retry cadence with a sanitized specific
diagnostic, while **preserving** the original 15-minute terminal verification
bound. Neither active evidence deadlines nor attempt baselines are extended.

Stopped evidence-only repair retains its existing five-minute/cursor sweep,
not a new fast queue. Pure contention has a specific diagnostic; a later required
substantive failure takes precedence over an earlier busy failure. Provider
refresh remains best-effort. No failed required verifier can authorize reduction
or release a hold, and `evidenceOnlyRecoveryAt` continues to fence an old Buy.

A separate fresh PG16 database migrated through 0000–0326 passed the complete
embedded funding suite plus actual queue → receipt driver → persistence →
reduction recovery. Chain inspection is synthetic; no signatures/submissions or
purchase consumer are involved. Tests cover mixed-stage failures, all callbacks,
retained holds, the established stopped sweep, successful later persistence,
terminal short retry and unchanged terminal incident bound. Focused unit tests
also exercise actual driver aggregation and terminal early returns. Independent
scoped rereview found no remaining actionable issue; this is not whole-goal GO.

The unowned-reanchor precursor now produces a bounded proof for one known EVM
transaction: unchanged canonical envelope, verified exact replacement with a
replaced old block, or explicit deferral. Both anchors use the existing shared
two-confirmation receive threshold. Missing/conflicting receipt identity,
ambiguous log index, changed economics, insufficient finality, two live anchors,
transport failure or exhausted deadline never authorize publication. Returned
RPC transaction hashes are retained and mismatches rejected, not inferred from
the requested hash. Legacy readers may still omit this field; the new proof
requires it.

The default head reader's URL-only fresh memo could otherwise inherit a prior
caller's wider timeout/retry budget. An explicit bounded-fresh read bypasses that
memo while retaining the common RPC's timeout/retry-specific single-flight lane;
existing callers' memo/cache behavior is unchanged. A mocked raw-RPC regression
holds an earlier wide-budget head open and proves that this inspector completes
independently. Seven proof tests pass, including Polygon/Base exact finality
boundaries and positive three/four-read counts. The proof precursor passed an
independent no-history scoped rereview after this correction.

**The new proof is not yet runtime-wired or anchor-write authority.** Pending
reanchor still needs the physical-gate/owner-absence/CAS transaction, revocation
of old lease authority, anchor-bound derived progress and ordinary retry
integration. Known retries must validate stored chain anchors before publication,
including replacements behind the forward-only scan cursor. No generic immutable
identity guard was weakened. Additive **0327** only fixes physical-gate casing:
valid Polygon/Base hashes, including a legacy uppercase `0X` prefix, share the
existing lowercase advisory key. Native/malformed/non-target keys remain exact.
The old behavior was reproduced on two PostgreSQL sessions before the fix. The
full PG16 concurrency/SQL profile passed after 0327, including both helper/adapter
orders, real legacy-cased observation versus normal E insertion in both orders,
and native-case distinction. This adds no claim or reanchor authority; persisted
ownership reads still need alias-safe predicates before a negative is trusted.

Final backend checks after 0327 passed: full workspace build **16/16** (6 cached,
23.68 s), scoped lint/format and common funding / Relay / HIP receipt integration
**3/3** on the migrated legacy-fixture database. The separate full concurrency
profile also passed on PG16; its final queue case used 635 derived pages in 27
passes / 80 seconds **modeled cadence**, not measured provider throughput. No
production or local app database, session, admin flag, Redis or server was changed.

The independent no-history whole-scope review returned **NO GO**: ordinary exact
refund callback/publication, pending reanchor and sealed native Telegram → app
execution remain P3/P4 blockers. It independently passed 182 backend focused
tests, 132 frontend focused tests and the admin capability-label test; those do
not substitute for missing runtime paths or full Confirmation/browser acceptance.
Whole-scope consecutive GO count remains **0/2**, and the goal remains active.

## 65. Pending receive reanchor in the common funding paths — October 16, 2026

The earlier proof-only boundary is superseded by a narrow runtime repair for
**pending, unowned Polygon/Base transfers**. The receive retry queue now verifies
the known transaction before classification. Missing/conflicting chain facts
defer publication; a verified replacement uses the common metadata-only repair
and waits for a new ordinary claim. Initial receive scans and sessionless Relay
destination jobs share the same adapter. Fresh/same-anchor batches add one
indexed hint read, with no extra provider calls. Strict economic/anchor collision
checks in the original upsert are unchanged.

Repair obtains the existing try-only physical gate, locks E, performs a separate
fresh READ COMMITTED global ownership read, and compares the complete exact
PostgreSQL row snapshot. It appends provenance and changes only the anchor and
old lease authority. Amount, asset, parties, event identity, original observation
timestamps, frozen session/variant binding and scheduled retry date survive.
No receipt, observation, reservation, operation, notification or consumer/Buy
execution is created. Derived scan v5 binds its header to the event fingerprint;
bounded restart preserves every captured candidate ID and negative dependency.

Additive **0328** installs the provenance/header fields and narrow runtime guard;
the existing owned refund and confirmed-H exceptions remain unchanged. Ownership
checks include all statuses/kinds/users/assets, case aliases, missing/malformed
log hints and independent retained H markers. Legacy transaction-only claims
also participate in the same try-only namespace through a transaction-footprint
sentinel. Changed/broadened receipt evidence must acquire it even during a
retraction; unchanged-footprint truthful retractions remain unblocked. Contention
uses the established evidence retry, not a new scheduler or waiting O→E lock.
**0329** adds four concurrent fixed-width physical-hash indexes with mandatory
exact residual equality. Neither migration backfills or classifies historical
financial rows. Both migrated an empty PG16 database and retained legacy fixtures.

Known retry admission is rolling, one committed claim before each inspection,
bounded by the existing interval and original batch limit. A slow first event
does not postpone untouched due rows. Invalid original budgets fail before
cleanup, cleanup does not consume the proof window, and expired work starts no
new provider inspection. Reanchor never resets the freshly scheduled due time
to a fixed logical clock or publishes the old anchor after revoking its token.

Real PG16 CAS/legacy-ownership/two-session contention tests and representative
custom/generic plans passed. The exact ownership SQL body used 4–13 buffers on
360,000 synthetic rows; exact canonical/header/hint/CAS plans used 2–21 buffers
on 50,000 rows. These are isolated local plans, not production measurements.
Focused unit checks passed (24 tests/top-level test files), HIP funding passed
357/357, and the full backend
workspace build passed 16/16. Independent no-history scoped reviews returned GO
for the known-retry package and for the initial/sessionless adapters; they do not
count as whole-goal acceptance. The final sequential expanded PG16 run passed
all five suites: concurrency/SQL and actual sessionless remine publication,
joint receive, receive persistence, internal handoff, and embedded receipt-driver
recovery. The timed case completed in 26 passes / 614 pages / 78 seconds
**modeled cadence**, not measured provider throughput. The remine test asserts
the credit's persisted height/hash are B and replay does not create another.

Regression verification also found and fixed a generic-plan issue in both exact
role readers: hydrate the known operation by its PK behind the existing
`OFFSET 0` barrier, then check current owner. Previously one generic plan read
5,002 owner operations for a single ID. The same dense custom/generic assertions
now pass with one operation row examined. A rollback-only canonical-watch plan
fixture retains 50,000 distinct physical logs but reuses one synthetic transaction
so the added transaction sentinel does not allocate 50,000 redundant test locks.
No database lock limits, financial guards or product timeouts were relaxed.
Heavy PG suites run sequentially on the shared disposable server. Common funding
persistence, Relay reconciliation and HIP receipt integration passed separately
on the migrated legacy-fixture DB; earlier failed attempts are not counted as GO.

The larger P3/P4 acceptance remains open: joint owned/exact/watch publication
and the ordinary exact-refund callback, sealed native product Telegram→ordinary
app execution, full Confirmation/browser/routes acceptance and active-order
exposure performance still need completion. Personal Telegram remains out of
scope. The goal remains active with **0/2 consecutive whole-scope GO reviews**.
No commit/push/deploy, production policy/permission or local app database/auth/
admin/Redis/server change is part of this increment.

## 66. Shared exact-refund publication foundation — October 16, 2026

The exact writer now separates read-only preparation, post-lock revalidation and
effects. Context and facts revision come from the same statement; manifest reads
are revision-bracketed. Revalidation keeps the original proposal revision and
rejects a newly visible physical receipt instead of acquiring another E under O.
The existing transaction adapter remains compatible for native/legacy callers.

The new pool-level publisher reuses the destination publisher's extracted role
phase: full verified E footprint, bounded checkpoint-only commits, pure role read,
all positive/negative O dependencies, late U/membership validation, snapshot
revalidation, effects, final F immediately followed by COMMIT. It uses the existing
job identity/deadline/page limit, not another scheduler. A verified first-refund
proposal can fill only checked physical absence with no recorded dependencies;
it cannot replace a recorded owner, conflict, stale envelope or legacy witness.
No source consumer or historical Buy is resumed by this publisher.

Independent review found two concrete correctness defects, both corrected:

- Same-key receipt deduplication now compares the full economic/anchor proof,
  excluding poll time. Fresh block B cannot silently be replaced by stored A.
- Shared observation allocation now takes the existing try-only physical gate
  before an indexed all-kind/all-state EVM alias lookup. One identical retained
  uppercase/`0X` claim is replayed without changing its stored hash, metadata or
  finality. Foreign, incompatible or multiple claims cannot create another credit.
  The exact recorded/manifest readers share this identity. New valid Polygon/Base
  hashes are normalized; native/unsupported/malformed keys retain exact semantics.
  Row contention uses NOWAIT and the existing narrow evidence retry, including
  ungated truthful invalidations. No backfill or new migration was needed.

PG16 tests cover partial/disjoint/repeated refunds, simultaneous writers, a second
receipt committed before O, original-revision rejection, negative-sibling changes
before F, full rollback and ordinary recovery, and exact F/COMMIT adjacency.
Retained alias tests exercise immutable replay, shared publication, conflicting
owners/kinds/values, multiple historical aliases, row/gate contention and native
case distinction. The exact new SQL runs in custom/generic plans over 100,000
synthetic rows: context 3–12 buffers; allocator 1–5, manifest 3–4 and recorded
lookup 3–16 buffers. These are disposable local measurements, not production data.

Final expanded concurrency/SQL acceptance and the three serial common funding,
Relay and HIP receipt suites passed on PG16.2 through 0329. The same-tick queue
test now checks its own event's unchanged lease/due/progress instead of assuming
other retained fixtures cannot advance; scoped review accepted that correction.
HIP funding passed 358/358, finance-worker 24/24, and the final full workspace
build passed 16/16 after the last test edit. Explicit clean-environment import
also confirms the new publisher does not require API-only secrets. Scoped lint,
format and diff checks passed. Both disposable DBs have zero staged revision
touches, invalid indexes or remaining client connections; synthetic fixtures are
intentionally retained. No production prevalence of historical aliases is claimed.

**This is not runtime activation or P3/P4 completion.** The ordinary exact-refund
callback is still not enabled. Owned/watch positive publication needs the narrow
proof-validated prelocked-event adapter and joint fence; truthful invalidation
must remain independently committable. Existing job work must reach these paths
before callback activation. Native product Telegram→app execution, full common
Confirmation/browser/route acceptance and active-order exposure performance
remain open. Scoped review is GO after the fixes; whole-scope consecutive GO
remains **0/2**, and the goal stays active. Personal Telegram, local app sessions,
production, commits, pushes and deployments are untouched.

## 67. Owned-refund joint publication and recorded reorg adapter — October 16, 2026

Owned-refund publication now uses the shared sessionless role phase rather than
running legacy role readers after taking its effect operation lock. The existing
reconciliation job passes its work identity, deadline and batch limit to this
path. First receipts use the same checked-miss-only proposal rule as exact
refunds. Positive effects require full old/new physical E, all captured positive
and negative O dependencies, late U/membership, the unchanged target snapshot,
and original-revision F immediately followed by COMMIT.

Recorded protection is a separate committed transaction: old E, target O,
unchanged receipt/source/authority snapshot, suppression and truthful retraction,
then F/COMMIT. It does not depend on exhaustive role pages, a decryption codec or
replacement publication. An unchanged canonical recorded refund needs no new
positive role authority merely to report its existing result. No replacement E
is introduced by invalidation alone.

The reorg adapter is narrowly scoped to an already recorded, reorged and
suppressed refund with unchanged economics and one matching current owner/leg.
Its private branded proof is constructed from the exact receipt snapshot and
captured revision under E; it cannot override a foreign or additional physical
claim. Derived checkpoints use incoming B's fingerprint on the same protected E
at A, without moving E's anchor. Each E→U checkpoint commits before another
transaction may acquire O. Only the final arbitrated physical CAS may restore B.
Unowned pending A→B continues to use the existing canonical-proof repair, not
this adapter. There is no generic ignore-anchor/already-locked flag.

Fresh no-history scoped review found two historical alias defects. The positive
claim now also checks global retained receive receipts using the existing compact
hash index plus exact normalized equality; a differently cased allocated E and
receipt cannot become a second refund. Additive migration 0330 extends only the
existing recorded-refund anchor exception for valid Base/Polygon hash aliases.
All economic, allocation, provenance, pending-repair and handoff guards remain;
native, malformed and unsupported references retain exact identity. Historical
rows are not rewritten and migration execution does not validate legacy data.
The reviewer re-read both fixes and returned scoped source GO, not whole-goal GO.
Durable known-refund references also retain raw and canonical EVM fingerprints:
an uppercase historical receipt with no remaining provider references must not
look reorged merely because the same canonical chain log is lowercase. Both log
representations enter the protected publisher with one canonical physical key;
the receipt's stored hash remains unchanged.

Disposable PostgreSQL 16.2 accepted 0330 over the existing legacy fixtures.
Committed tests cover initial/repeated refund, competing destination, independent
invalidation, replacement transfer, same-physical remine, stale snapshot and
late-fence rollback, two publishers, both receive/refund ownership orders,
historical uppercase external allocation and uppercase recorded refund remine.
Limit-one checkpoints retain protected A until later ordinary ticks complete B.
New SQL and the actual migration predicate were explained in custom and generic
plans over 50,000 synthetic unrelated rows: receipt exclusion 3–4 buffers,
recorded proof 2–13, and anchor predicate 3–4; no sequential scans. These are local
synthetic measurements, not a claim about production prevalence or latency.

The full delegated-funding regression passed after these source fixes; scoped
lint, API typecheck, clean-environment sidecar import, 26 focused proposal/role/
anchor/budget tests, 67 refund/destination regressions, and a full backend build
(16/16) passed. Final bounded multi-tick owned acceptance and the expanded
shared concurrency/SQL suite passed after 0330. The latter included real expired
retry/failure/resume, merge/membership fences, exact publication, initial and
retry receive publication, physical contention and pending-anchor recovery.
Its timed queue scenario converged in 26 ticks/621 pages/78.38 seconds of modeled
cadence; this is not live provider latency. HIP funding passed 358/358 and the
finance-worker suite 24/24. None of these checks authorizes callback activation.

Fixture-specific queue assertions now temporarily hold other retained synthetic
events so the real claimant exercises SKIP LOCKED for the intended session.
Decision capture and injected write failure are scoped to the asserted event and
operation. No production timestamps, limits or financial assertions are changed;
global timed-queue coverage remains separate. Independent scoped test review
accepted this isolation. Earlier failed runs are not counted as acceptance.

Still open: canonical-watch positive restoration must use this proof-scoped
joint publication; exact runtime work propagation and the fifth refund callback
remain disabled pending that integration and worker/stopped-job acceptance.
Native product Telegram→ordinary app trading, common Confirmation/browser/route
acceptance and active-order exposure performance also remain open. The goal is
active with **0/2 consecutive whole-scope GO reviews**. No commit, push, deploy,
production policy/permission, personal Telegram, local app DB/session/admin,
Redis or server changes are part of this increment.

## 68. Canonical refund watch uses joint funding publication (2026-10-16)

This supersedes section 67's open canonical-watch implementation item, not its
remaining P3/P4 acceptance gates. The watch now separates independently useful
protection/retraction from positive EVM restoration. It uses the same role
arbitration and operation/membership/final-fence contract as receive and owned
refund publication; no new scheduler, lease, financial ledger or UI is added.

The initial bounded receipt query captures the full PostgreSQL receipt snapshot,
current relational owner, committed source, refund binding and classification
revision in one statement. Operation-level owner/revision facts also exist for
an empty page. Protection prelocks the entire old physical footprint in sorted
order before target O, validates the exact receipt and original source binding,
protects/retracts and writes its diagnostic cursor, then performs raw original
F immediately followed by COMMIT. A conflicting allocation cannot prevent
truthful invalidation. RPC admission/deadline failure still protects the known
rows in that same bounded page without retracting them or advancing their
verification cursor.

Positive restoration requires the exact post-protection receipt captured under
lock. A fresh query may adopt the revision caused by this transaction's own
committed retraction only if that exact receipt and original source/refund
binding survive. Each subsequent transaction regenerates the private recorded
proof under E. Derived E→U pages commit before any transaction acquires O. The
ready path takes the complete positive/negative O union, late U/header fence,
receipt/source CAS, shared all-state physical ownership exclusion and controlled
anchor effects, then raw original F/COMMIT. The written anchor must match the
proof-bound event. No chain requests are repeated while role pages drain.

Existing receive recovery owns its own retry acknowledgement. Protection keeps
its retry time, token and binding rather than overwriting a claimable reason
with non-claimable suppression. A recorded reorg can otherwise deadlock at
`exact_refund_correlation_pending`: receive cannot use unowned anchor repair,
while the DB permits recorded anchor movement only in its four existing states.
After exact reorged receipt/current owner/revision/economics/competing-claim
validation, the private proof factory may move that existing quarantine to
`exact_refund_receipt_not_final` at the already locked stored anchor. It preserves
all retry fields. Restoration leaves that retry for its own worker to observe
the canonical refund, suppress and clear its lease atomically. The database
anchor guard, allocations and competing-role checks are not relaxed.

The ordinary reducer/worker passes its existing progress token and full lease
deadline, including stopped evidence-only jobs. Provider inspection retains the
existing half-remaining-budget allocation. Cursor writes occur only in the
protection transaction, never after a derived U checkpoint. A rolled-back
protection/F conflict propagates through the existing worker retry path; a
return-only pending result would not survive terminal scheduling. Successful
restoration makes cash evidence current immediately, even if its conservative
diagnostic pending flag clears on the next ordinary complete sweep.

Fresh no-history scoped review found and re-reviewed the fence propagation,
anchor-binding, budget-row protection and retry-cycle fixes. These reviews are
not the two required whole-scope GO reviews. Committed PG16 tests exercise
limit-one checkpoint commits, replay/no duplicate receipts, exact post-protection
snapshot races and recovery, original-F rollback/propagation, mismatched-anchor
rejection and correlation-pending remine. The separate bound receive fixture
retains its final null retry-time/null lease-token assertions. Legacy effect
fixtures explicitly inject their intended role; they are not substituted for
the committed full-authority tests.

New operation/page/by-ID/locking-CAS SQL ran on disposable PostgreSQL 16.2 with
50,000 dense and 50,000 sparse receipts using installed indexes. Custom and
generic first/resumed/empty/sparse/CAS plans used 2–254 hit-plus-read buffers,
visited at most 25 base rows per scan and had no sequential scans. Recorded local
times were approximately 0.02–0.66 ms; these are synthetic, not production SLOs.
The final sequential acceptance passed all five suites after the retry-cycle
fix: shared concurrency/watch/SQL, common funding persistence, Relay provider
reconciliation, HIP funding receipts and owned/delegated funding. The original
bound receive retry-time/token cleanup assertions passed. Full backend workspace
build passed 16/16; focused tests 13/13, HIP funding 358/358, finance-worker 24/24,
scoped lint/format and clean-environment sidecar import also passed. These are
this increment's regression results, not whole P3/P4 acceptance.

Still open: exact runtime work/publisher integration and all-state receive-alias
exclusion for exact positive publication, fifth callback activation with actual
worker/stopped-job acceptance, native product Telegram→ordinary app trading,
common Confirmation/browser/route acceptance, active-order/settled-history
performance and final cross-repository validation. No new public API or design
is introduced here. The goal remains active with **0/2 consecutive whole-scope
GO reviews**. No commit, push, merge, deploy, production policy/permission,
personal Telegram, local app DB/session/admin, Redis or server changes occurred.

## 69. Exact-refund runtime and ordinary worker integration — October 16, 2026

This increment connects the existing Relay driver's fifth callback to the
shared exact-refund publisher. It supersedes section 68's outstanding
exact-runtime/callback item, not the remaining whole-P3/P4 acceptance gates.
No second funding scheduler, inventory, claim ledger, public API or UI is added.

The callback preserves the existing job's progress token, deadline and bounded
batch limit. Provider evidence is read once per poll, before publication; local
role checkpoints reuse that evidence. The runtime delegates transaction
ownership to the pool-level publisher rather than wrapping it in another
transaction. Supported EVM effects retain full E, the sorted positive/negative
O union, late U/header checks and original F immediately followed by COMMIT.
Native work-bearing publication retains exact USDC8 ledger identity and uses
the same job budget, target O and original F/COMMIT without inventing EVM keys.

The exact writer checks the entire verified footprint for retained external
receive claims before any quarantine, credit, completion proof or wake. It
shares the existing indexed all-state/all-owner Base/Polygon case-alias query
with owned-refund publication. Closed sessions and recovery/review receipts do
not silently become unowned money. Native/unsupported identity rules are not
broadened. This factoring requires no new migration or historical rewrite.

Provider reads use the existing half-remaining-lease split, leaving the rest
for persistence/reduction. Relay evidence flights with different deadlines
cannot inherit a longer unbounded flight. EVM RPC reads receive the shrinking
deadline. Native policy/admission runs in short DB-only transactions with
transaction-local statement/lock budgets, committed before HTTP. The account
client rechecks its absolute deadline after admission and recomputes its
transport timeout there. Deadline/DB-budget denial preserves the last native
second actually read; the next ordinary job starts at the unread second.
Configuration/invalid-data failures are not relabeled as budget exhaustion.

Fresh no-history scoped review found and re-reviewed the admission deadline and
cursor-starvation fixes. Committed PostgreSQL tests cover the actual fifth
callback, partial/completed/replayed refunds, all five retained receive states,
closed/foreign-owner/case-alias exclusions before effects, native USDC8
work-bearing commits, original-F rollback/recovery and expired work without IO.
The actual ordinary worker converged through a pending observation and partial
set in 11 leases, approximately 20 seconds of modeled due time; the model also
accounts for each pass's actual duration. Stopped evidence-only recovery uses
its real lease and callback, blocks old execution consent and creates no new
financial attempt. Compatibility writer race tests remain separate from these
real pool/worker authority tests. No provider transport or signing is exercised
by these synthetic fixtures.

The final sequential disposable PG16 acceptance passed all five suites:
shared concurrency/SQL/runtime/worker, common funding persistence, Relay
reconciliation, HIP funding receipts and owned/delegated funding. The shared
receive-alias query's 50,000-row custom/generic plans used its installed
expression index with 3–4 buffers and approximately 0.015–0.032 ms for hit/empty
probes. These are local synthetic measurements, not production SLOs. The full
backend workspace build passed 16/16; focused HIP funding/client/budget tests
passed 372/372, finance-worker 24/24, scoped lint/format/diff checks and the
clean-environment worker import passed. This is not a production or whole-goal
GO.

Next implementation, confirmed by a separate fresh static app-handoff audit:

1. Extend the existing sealed app-handoff contract with native executable
   terms and explicit HIP dispatch. Keep unattended Telegram signing disabled;
   use ordinary app review, account reads, consent and native order session.
2. Reuse the ordinary protected-IOC quote, exact cash8/outcome5/whole-lot terms,
   controller, canonical token/environment, cap and expiry. Do not relabel the
   legacy FOK/full-fill bound or six-decimal cash as native semantics.
3. Build funded handoff from the same native raw debit and exact destination
   identity as ordinary shortfall funding. Reuse its FundingOperation and
   reservation through reload/refresh; do not enlarge confirmed spending.
4. Extend the shared atomic sealed handoff/intent/funding claim boundary and
   invoke it inside native admission. Merely enabling the generic claim's
   handoff bypass flag is not an implementation.
5. Link the existing native action/order/cloid before submission and recover
   through native order observations. Lost responses, cancel races and browser
   reload must never trigger a second order; partial IOC is not full success.

Common Confirmation/browser/route acceptance, active-order/settled-history
performance and final cross-repository validation remain open. These scoped
reviews do not count toward the required **two consecutive fresh whole-scope
GO reviews (0/2)**. The goal remains active. No commit, push, merge, deploy,
production policy/permission, financial action, personal Telegram, local app
DB/session/admin, Redis or server change occurred.

## 70. Native sealed terms and shared handoff locking — October 16, 2026

This is a verified persistence/locking foundation, **not native app-handoff
activation or P3/P4 completion**. Product venue arrays and the production
scope resolver still admit only the existing Polymarket/Limitless consumers.
Unattended Telegram authorization/signing is not expanded. Personal Telegram
has not been accessed.

The native sealed tuple freezes mainnet market/token/outcome, exact controller
reference, BUY/SELL, whole-lot quantity, representable limit price, IOC and the
original user-consented raw debit cap. Cash is USDC8 and outcome balances use
five decimals. It does not promise full execution, a fill floor or a current
book/fee/signing window. Preparation snapshots now retain the original cap
separately from a smaller calculated debit after lot rounding. A connected
consumer must refresh ordinary fees/nonces/signing expiry after funding while
preserving these economics, not resize the purchase from USD again.

The existing shared direct/funded repository accepts that native tuple and
checks economic equality, requested units and the confirmed native funding
consumer bound. It rejects funded SELL, wrong outcome/cash decimals/spend cap,
and an attempt to link claimed native order A to economically similar B.
Direct recovery uses the existing native action/order/cloid identity; cloid is
not a numeric venue order ID. Linking a native `filled`/`matched` summary does
not declare a full fill; official native observations remain authoritative.
Migration 0331 is additive structural compatibility on the existing intent
table: new native rows require `app_handoff`. It does not scan/backfill legacy
rows or change bot authorization constraints. It has been applied only to the
approved disposable PostgreSQL 16 target, not production or the local app DB.

A fresh independent lock audit found that simply calling the shared handoff
claim from native admission would invert existing locks. The shared scope
dependency now has explicit `lockAuthority` and `validate` methods. Financial
commit and direct/funded consumers take funding policy, then the existing
receive/context, Telegram market and user/legacy-controller authority locks,
then handoff/intent and final validation. Lock-only acquisition grants no
policy eligibility. Exact direct replay still returns before live validation.
Token-only resolve/claim/cancel retain handoff → intent without acquiring the
outer financial locks. A funding-return marker changed while waiting for the
market lock is rejected before user/handoff/intent acquisition; a fresh
ordinary retry recovers without a cooldown, cache purge or handoff deletion.

Acceptance for this increment:

- Native sealed-term unit tests: 17/17; five existing handoff unit suites and
  the route-schema cases passed.
- Seven serial PG16 suites passed: shared multi-connection handoff locking,
  native shared-claim foundation, Polymarket ledger claim, handoff consent,
  composite funding/action races, common funding persistence and ordinary
  native order submission. Migration 0331 also ran against empty and legacy
  temporary-table fixtures, preserving existing rows and rejecting native bot
  writes.
- The lock fixture has a qualifying internal EVM wallet, actual Telegram link,
  complete authority/plan and a successful production-validation baseline. It
  observes real lock waits and proves wallet/link locks precede handoff/intent,
  Cancel wins and loses for BUY/SELL, exact replay, changed-marker rollback and
  recovery, deactivation serialization and policy-before-direct-commit order.
- The actual generation-lock SQL was parsed/executed on an empty tail. Its
  forced-generic plan uses an existing index with both exact session and
  generation conditions, not a sequential scan. This is not proof of populated
  funding-return concurrency or production-scale performance readiness.
- Final full backend workspace build: 16/16. API typecheck, scoped lint,
  formatting/diff checks and clean-environment finance-worker import passed.
  Disposable-target postcheck found no pending classification touches, invalid
  indexes or remaining clients. Synthetic fixtures are intentionally retained.

The scoped independent rereviews found no additional concrete foundation/lock
defect. They do not cover actual merge, funded materialization, populated
funding-return/retained-Solana races or native production authority/admission.
They **do not count** toward the required whole-scope GO reviews (still 0/2).

Next: install native controller scope and invoke this same lock envelope before
the ordinary native admission's user lock; claim and link the existing native
action/order/cloid in its durable pre-POST transaction. Then connect the sealed
producer, existing shortfall funding and ordinary frontend native session,
including supported SELL and response-loss recovery. Existing Confirmation,
browser/route matrix, active-order/settled-history performance, cross-repository
checks and the two consecutive fresh whole-scope GO reviews remain open. No
commit, push, merge, deployment, live financial action, production policy or
permission change was performed.

## 71. Connected native handoff consumer and factual recovery — October 16, 2026

This increment installs the native consumer of section 70's shared contract.
It is **not product activation or whole P3/P4 completion**. The public product
venue arrays still exclude Hyperliquid until the producer, funding continuation
and ordinary frontend session are connected. Unattended bot signing remains
disabled; personal Telegram has not been accessed.

The native authority codec binds the exact user, Telegram account link and
ordinary mainnet controller. An external `web_client` controller needs neither
a Privy server wallet nor a bot grant. Admission uses the same outer policy and
authority envelope as other handoff consumers, before native user/order locks.
The optional paired handoff ID/fingerprint is checked at the ordinary native
submission boundary. The original action/order/cloid and any existing funded
attempt are linked in that transaction **before POST**. A lost response replays
the same owned journal entry, before fresh capacity/policy/provider checks;
omitting or changing its binding conflicts instead of creating another order.

Internal v2 readers/builders now parse native exact IOC terms without legacy
USD6, FOK or full-order receive-floor fields. Funding is bound to the same
controller, canonical outcome context and USDC8 spend, within the original
consented cap. These parser/consumer tests do not prove the still-unconnected
product producer or actual generic funding materialization.

Handoff recovery reuses the official native `/orders` facts, including an owned
original action ID. An ACK, local expiry or generic `filled` summary is not a
terminal fact. Exact terminal status is distinct from execution coverage:
cancelled partial IOC retains its actual fills; missing fills are unknown.
Autoclose additionally requires a current full-quantity execution summary.
Independent review found that the monotonic historical quantity flag alone
could survive a failed recheck; the summary gate and ordinary repair test fix
that presentation error.

Ordinary native reply/observation transactions project only the existing linked
intent's derived status/time, through exact admitted action → committed handoff
PK/fingerprint → owned intent/order/market/token/action. No monetary evidence,
funding release or second ledger is added. Barrier invalidation restores
`submitted`. Cheap state qualification and an explicitly correlated order probe
keep pending queries from scanning completed native order history. Unified
market-feed SQL is unchanged.

A fresh lock audit found a real conflict with the legacy Telegram lifecycle
worker: it takes intent I before an outbox FK needs user U, while native
financial writers take U before I. That renderer also assumes six-decimal
shares and incorrectly describes a cancelled partial IOC as never submitted.
Native intents are therefore excluded **before its I lock** in this intermediate
patch. Ordinary app/API recovery remains available. Native-aware lifecycle
presentation and owner-before-I selection remain explicit implementation work;
the exclusion must not be mistaken for completed native Telegram presentation.

Acceptance for this increment:

- Seven serial PG16 suites passed: shared handoff locks, connected native
  BUY/SELL and funded BUY, Polymarket ledger claim, consent, composite races,
  common funding persistence and ordinary native submissions.
- Additional native public runtime, real-session auth/CSRF HTTP with mocked
  providers, ordinary observation/100k-row plans and legacy lifecycle/market-exit
  regression suites passed. The legacy suite requires an isolated candidate
  population: after detecting old synthetic cards in the shared test DB, it was
  run in a separate disposable clone with only preexisting fixture deliveries
  excluded. Its assertions were not relaxed; no Telegram sender was contacted.
- Connected tests verify pre-POST persistence, rollback after claim, old initial
  quote/token TTL with committed consent, exact replay without current scope or
  capacity, wrong ownership/binding, official terminal before fill coverage,
  partial/full canonical executions, failed summary recheck and repair,
  invalidated status and repair. A two-connection real-selector test holds
  native policy/user locks and verifies that legacy lifecycle takes no native
  intent lock or native outbox row.
- Native pure tests passed 19/19; existing handoff/v2/projection tests passed.
  On disposable PG16, 50,000-row temp histories plus an exact original binding
  use installed indexes, 5,000 owned completed intents, 45,000 foreign rows and
  open/stale-projection holes. Custom/generic detail, projection, sparse,
  count/list and empty-tail plans read 2–44 local/shared buffers and took about
  0.05–5 ms. The probe matches the API's existing `jit=off`; no production JIT
  setting changed. These are local synthetic measurements, not production SLOs.
- Full backend workspace build, API typecheck, scoped lint/format/diff checks
  and clean-environment finance-worker import passed. This is not a financial
  live test, frontend acceptance or deployment GO.

Next: connect native product producer and route dispatch, ordinary USDC8
shortfall funding and supported SELL to the existing frontend native session
and Confirmation. Preserve the same operation/reservation/action/order through
refresh and response loss; do not use the legacy Polymarket/USD6 default.
Legacy retained receive-return markers need their proper native adapter, not a
validation bypass. Native lifecycle presentation/locking, browser/funding/cancel
matrix, existing active-order/settled-history performance, OpenAPI and final
cross-repository checks remain open. The goal remains active with **0/2 fresh
consecutive whole-scope GO reviews**; scoped reviews do not count. No commit,
push, merge, deploy, live financial action, production policy/permission or
local app DB/session/admin/Redis/server change occurred.

## 72. Native Review/shortfall adapter and ordinary browser binding — October 16, 2026

This is another implementation increment, **not whole P3/P4 completion or
native Telegram product activation**. It addresses the concrete producer and
browser contracts identified by a fresh independent integration review.

`quoteTelegramNativeTradeReview` quotes through the ordinary native web IOC
runtime. It retains exact quantity, protected price, original user debit cap,
canonical outcome and current verified controller authority. BUY funding uses
the quote's actual fee-inclusive debit, not the possibly larger original cap.
SELL has no cash-funding request. External controllers require neither a bot
grant nor a Privy server wallet. The adapter performs no prepare, nonce claim,
reservation, signing or submission; it has not yet replaced the product card
and callback's navigation-only native entry.

The explicit native shortfall request carries native USDC8, its exact
controller and canonical outcome context into the **same** Mini App funding
inspection engine as P/L. It never falls back to Polygon pUSD or reconstructs
raw amounts from display dollars. The ordinary planner still owns source
discovery, executable provider floors and the sealed funding plan. Native
inspection refuses stale/partial balances, preserves an observed provider
floor above a tiny shortfall, and retries through fresh ordinary discovery
after a balance change. Unattended/delegated funding remains P/L-only.

V2 HTTP lifecycle dispatch now recognizes a fully parsed native contract and
validates its exact authenticated user/intent/controller/fingerprint/policy
scope. V1 still rejects native execution. Existing in-flight/terminal reads
remain available without re-proving current execution eligibility. These
consumer routes do not create product entry buttons or enable a bot signer.

The ordinary frontend native order session/journal can retain the paired
handoff ID/fingerprint before prepare and POST, pass it to the existing native
submit endpoint, and recover the same action without a second POST. Changing
or omitting the binding cannot hide an unresolved journal. The existing trade
hook retires its session identity when the binding changes. No separate
signing transport, financial ledger, funding coordinator or layout was added.

Actual HTTP and offline OpenAPI generation now share the handoff route
schemas. Native action IDs, terminal status and incomplete fill coverage are
included in generated frontend DTOs instead of being lost during serialization.
The offline contract/fixture command also checks the handoff paths.

Focused tests cover native BUY/SELL × YES/NO, external authority, original cap
versus required debit, wrong scope/asset/units, tiny shortfall/provider floor,
stale and changed balance, direct/funded response loss, binding replacement and
queued session inputs. Disposable PG16 verifies native HTTP-scope validation
against real owned rows, including missing scope, foreign user, changed
fingerprint and V1 rejection, alongside the previous connected admission and
recovery suite. Its existing 50,000-row custom/generic read-plan checks passed;
unified market-feed SQL was not changed. Shared HTTP schema serialization is
tested independently of authentication; that test is not live auth acceptance.

Next implement the native product draft/card/callback producer and connect the
frontend handoff parser/continuation to this ordinary native session. Do not
activate the product venue merely because its internal consumer now works.
Native-aware lifecycle selection/rendering, terminal-before-fills refresh,
partial-cancel presentation, complete browser/funding/Done/abandon matrix and
the existing active-order/settled-history performance work remain open. The
two required fresh **whole-scope** GO reviews remain **0/2**; scoped PASS
reviews do not count. No Git, deployment, production policy/permission, live
financial action or personal Telegram operation was performed.

## 73. Native Review producer and ordinary Mini App continuation — October 16, 2026

The native app-handoff producer now creates exact BUY/SELL drafts without a bot
grant, server wallet authorization, order, nonce, reservation or funding
operation. Exact cash8/token5 bounds live in the native request; the legacy
`amount_usd` column is display metadata only. The ordinary IOC quote adapter
freezes quantity, protected price, original cap and current linked controller.
BUY inspects shortfall through the existing generic Mini App funding service;
SELL never creates cash funding. Callback composition uses the same adapter in
both internal preview and confirm paths, independently of unattended bot
reconciliation. There is no native bot executor or personal Telegram access.

Market-card preset composition is installed behind the existing shared product
capability contract. It uses current policy presets and an unambiguous ordinary
verified controller; unlinked, public, ambiguous-wallet and unavailable cases
retain the normal editable app navigation. It does not choose an arbitrary
wallet. **The product venue arrays are not activated yet.** Native Sell/custom
input entry, lifecycle presentation and the complete acceptance matrix below
must be connected before enabling this producer in normal cards.

Issuance owns the existing policy → market/user/link/wallet → handoff/intent
envelope. Concurrent choices cannot publish competing Reviews for one market.
Reopening an existing token happens before new quote/funding IO and never
replaces its frozen terms. Quote freshness is checked at publication, but its
book expiry does not shorten the independent economic-consent lifetime.
Cancellation keeps draft CAS separate from shared handoff → intent locking;
repeated cancelled/expired outcomes are acknowledged, and a submit winner is
reported as already started rather than falsely cancelled.

Fresh independent review reproduced two producer defects and both were fixed:
a lost Cancel response made repeated cancellation throw, and an old draft could
quote wider slippage after a policy reduction. Current policy now rejects the
stale draft before quoting; a fresh card is the normal recovery. Existing issued
Reviews remain immutable. Real PostgreSQL 16 tests cover these recovery paths,
wallet/link/policy/source changes, direct BUY/SELL, funded Review without an
operation, concurrent selection, ownership and ambiguous controllers. New
controller-choice and exact-intent SQL is parsed and executed on PG16, including
custom/generic and empty-tail plans with 50,000 synthetic wallet rows and the
installed indexes. The hot unified market/feed SQL is untouched.

The frontend parser accepts only the matching `hip4-ioc-v1` tuple. Continuation
refreshes the **exact** IOC through ordinary `/orders/quote`, not market re-sizing,
then uses the existing `useHyperliquidTrade`/session/journal with the same paired
handoff binding and optional common funding reservation. Current user, wallet,
venue policy and execution binding fence the workflow. A restored journal is
never automatically replaced; explicit Check uses ordinary acknowledgement or
checked discard/abandon. Missing native terms cannot fall back to legacy
USD6/FOK/full-fill fields. No layout, signing transport or financial engine was
introduced.

Independent frontend review found that unsigned restored attempts hid their
Check action, and an unrelated unsigned journal could never be acknowledged.
Both recovery paths now use the existing actionable waiting state and checked
discard. The isolated browser harness mounts the actual continuation and native
session in StrictMode: it verifies pre-prepare binding, no automatic replacement,
explicit same/different-handoff recovery, and owner/policy fencing. API/auth
boundaries are synthetic and preparation intentionally fails before signing.
These checks do **not** establish mounted signature/POST, funded completion,
partial-fill display or a live financial flow.

Acceptance for this slice passed: serial PG16 producer and full connected native
admission/recovery suites; focused legacy/native tests; full backend workspace
build 16/16; frontend typecheck and lint, 1,915 tests, separate mounted-fixture
typecheck, offline API-contract check and exact Node 20/Turbopack build. The
latest isolated browser run reports all five checks and `data-verdict=PASS`.
These are synthetic/local results, not a production performance or financial GO.

Next implement native-aware lifecycle selection/rendering with owner-before-intent
locking, truthful terminal-before-fills/partial-cancel presentation and bounded
read-only repair. Finish native Sell/custom entry, complete Confirmation
Done/close/abandon and direct/funded/cancel browser/HTTP matrices, and the existing
active-order/settled-history performance work. Then run final cross-repository
checks and obtain two consecutive fresh independent **whole-scope** GO reviews.
The scoped reviews above are not those approvals: the goal remains active at
**0/2**, with no commit, push, merge, deployment, live financial action or
production policy/permission change.

## 74. Native facts in the shared trade lifecycle — October 16, 2026

The existing lifecycle projector/outbox now accepts native app-handoff trades.
It does not add a Telegram executor, signing service, personal-account access,
financial ledger or new product layout. Its progress snapshot carries exact
cash8/token5 request bounds and the same official order/execution facts used by
ordinary `/orders` and the app. Cancelled IOC remainders are distinct from
before-submit cancellation: recorded partial fills remain visible, missing
history remains unknown, and full-success presentation requires both official
termination and the current complete-quantity execution summary. Unknown fees
remain unavailable, not zero. Expired Review and stopped funded Review retain
ordinary refresh/open-market recovery.

Candidate hints are read without intent locks. A bounded common top-K of the
legacy, native-direct and native-funded branches is followed by sorted owner
`KEY SHARE SKIP LOCKED`, then exact intent-PK locking and authoritative source
rechecks. A concurrently changing owner is skipped for the next ordinary pass,
not trapped behind a cooldown. Native partial cancellation never invokes the
generic pre-submit reservation release after an order/submission boundary.
Linked funding is **not** pruned using a cached terminal operation status:
later evidence/recovery must retain the existing funding-source wake-up gate.

Failed native execution repair now uses the ordinary policy → owner envelope,
rechecks owner/lease after waits, invalidates the current summary and wakes the
exact linked intent in the same transaction. A changed fill/fee observation can
wake presentation without changing the already-terminal order status. The
immutable admitted order binding, rather than a retained handoff token row,
owns this factual repair. Removing a short-lived token cannot abandon an
already admitted order; it does not grant a new submission authority.

Independent fresh scoped review found and drove fixes for snapshot metadata
causing repeated identical revisions, stale full-success after a failed fills
recheck, a post-owner-lock merge race, expired/funded-stop recovery wording,
token-retention dependence and an overly narrow terminal-funding queue filter.
The normalized snapshot stabilizes across delivery timestamp changes. These
scoped reviews are not the two required whole-P3/P4 approvals.

New additive concurrent indexes 0332/0333 cover native derived work and exact
order-to-intent repair. They do not change financial invariants or unified
market-feed SQL. Optional malformed watermark JSON is guarded before casts;
the existing rows are neither auto-confirmed nor deliberately rejected during
migration. Both actual migrations ran on disposable PG16; empty and malformed
legacy index fixtures also exercise the index definitions. Representative
custom/generic plans use 50,000 synthetic native histories. The initial generic
hint plan exposed a 4.27-second/9.5-million-buffer scan; exact-PK rechecking,
one-time filtering of absent funding sources and the native derived-work index
remove that regression. Funded-history scale and the previously open native
capacity/settled-history plans remain explicit performance work, not a claim of
production SLO acceptance.

The frontend native terminal presentation and mounted repair verification, Sell/custom
product entry, complete direct/funded/Confirmation/cancel browser matrix and
final cross-repository acceptance still remain. Product entry arrays are not
enabled by this lifecycle increment. The goal remains active; consecutive
fresh independent **whole-scope** GO is still **0/2**. No commit, push, deploy,
production policy/permission, personal Telegram or live financial action was
performed.

Acceptance for this increment: the full connected native PG16 suite passed,
including stable delivery re-projection, missing/partial/current full fills,
failed-recheck recovery, funded-stop navigation, terminal-funding source parity,
token deletion and owner-before-intent contention. Ordinary native observer
regressions and 100,000-row order/fill plans passed. The existing shared venue
lifecycle/market-exit suite passed on its separate disposable clone. Both test
databases are at 0333 with no invalid indexes. On 50,000 native histories, final
hint plans were 31–75 ms for first/resumed selection and 67–201 ms for empty
tails after bulk fixture updates; exact selected-intent rechecks were about
0.8–1.2 ms. These synthetic results do not settle funded-history or production
performance acceptance. Focused pure suites, 24/24 finance-worker checks, API
typecheck/scoped lint and the full backend workspace build 16/16 passed.

## 75. Native product input and ordinary venue lifecycle — October 16, 2026

Native Buy presets, Custom Buy, Sell all and Custom Sell now use the existing
Telegram product card/input context and immutable app Review. Exact cash8 and
whole-contract token5 parsers reject ambiguous or silently resized amounts.
Owned capacity uses the same account read and Hunch holds as ordinary trading.
Lost-response replay returns its saved input before new provider IO. Current
custom-input policy is rechecked before unissued Review preparation; already
issued Reviews retain immutable terms. Direct card and navigation entrypoints
both preserve the native input writer. This supersedes the product-entry gaps
in sections 73–74; it does not enable an unattended Telegram executor.

Implemented interactive Hyperliquid capabilities now follow the shared venue
lifecycle matrix, including active/exit-only/unreleased behavior, without test
injection. Default policy remains unreleased/off. Autonomous trading, redemption
and signal delivery/source remain unsupported. Production policy was not changed.

## 76. Completed observation lane and explicit Check — October 16, 2026

Officially terminal orders with complete quantity and known-fee summaries now
use a cold lane in the existing observation queue. This is scheduling, not a new
settlement proof. Missing, partial or invalidated facts retain the hot lane. The
first worker slot is always hot; cold work uses the same total batch and current
policy quota. `completedOrderRecheckIntervalMs` defaults to 3,600,000 and
`completedOrderBatchSize` to 1. Both are runtime policy. Additive concurrent
migration 0334 preserves the old due index and adds the class/due lookup.

Ordinary native Check calls authenticated, CSRF-protected
`POST /trade/hyperliquid/orders/recheck` with its exact owned action ID. The same
observer, policy/user locks, lease, provider budget and factual repair writer
apply. Explicit repair bypasses housekeeping due time, never a live lease. It
does not sign, submit, release unknown holds or resume a historical Buy. Passive
mount/resume reads do not call this repair.

All current migrations through 0334 passed on fresh disposable PostgreSQL 16.
Seven serial runtime/HTTP/observer/preparation/native-input/legacy-input/market
navigation suites passed. The 50,000-history queue plans passed custom/generic,
due and empty cases; the measured fixture plans were 0.026–0.168 ms with 4–44
buffers, not a production SLO. Native input identity plans and 100,000-fill
plans also passed. The full backend workspace build passed 16/16, the funding
profile 361/361, frontend tests 1,929/1,929, typecheck/lint, offline contract
generation/check and exact Node 20/Turbopack build passed. Eleven isolated
browser checks mount the actual ordinary native hook/session and verify explicit
Check, passive reads and stale-owner/close fences; APIs/accounts are synthetic.

The diagnostic whole-scope review still found a P3 gap: a verified Relay refund
may land in the owner's perps class, which current production source discovery
does not admit. Reuse native Relay perps-source SendAsset and the existing
funding UI to an owned supported EVM balance; do not mirror it as spot or resume
the stopped Buy. Class-scoped transferable cash, holds/debits and recovery
acceptance remain to implement. The full mounted funding/signing/Confirmation
matrix and final whole-scope acceptance also remain. Scoped reviews passed for
the input/lifecycle and queue/Check slices, not for the whole goal: **0/2**.
No commit, push, deploy, production activation, personal Telegram operation or
real financial action occurred.

## 77. Recovering separate perps refund cash through common funding — October 16, 2026

Section 76's unsupported refund-source gap now has an implementation for
Standard cash-only native perps accounts. The existing account client admits
`clearinghouseState` for the first DEX (`dex: ""`) under the same IP budget.
The optional persisted `perpsCash` observation is independent of spot: failed
reads expose unavailable facts, not old receipts or a fabricated zero balance.
The provider timestamp cannot be made fresher by reading it. Unified/margin
accounts are not duplicated across classes. The
[official perpetual account summary](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
separates withdrawable, raw USD, equity, margin and positions. This cash-only
adapter requires no margin inventory and consistent nonnegative raw cash; free
cash is capped by the reported withdrawable amount. It never counts equity or
borrowing as a transferable cash balance or changes the user's account mode.

The canonical perps refund location is reused as a physical inventory component,
not mirrored into spot. Its asset is still native USDC8; Relay's 16-byte zero
selector is transport identity only. Normal account refresh repairs missing or
stale reads. Unsupported modes/margin inventory remain explicit; they require a
supported current cash account, not a timeout, historical-price approximation or
automatic position closure. Spot errors do not erase independently verified
perps cash.

The perps-source Relay routes reuse the existing quote validator,
nonce-mapping/SendAsset pair, sign-only executor, source reservation, one-shot
submit and reconciliation. Source selection filters physical class before
same-asset route uniqueness. Native send admission obtains a fresh same-class
observation; spot order holds never consume perps cash. Snapshot-debit alias
proofs preserve class across account merges. A proved debit in the other class
neither reduces nor fences this class; incomplete proofs remain unknown until a
fresh physical snapshot repairs them. Frozen economic plans are not rewritten.

The normal Convert/Withdraw path can recover this cash into a supported owned
Base/Polygon balance, with a new explicit user review and signatures. It cannot
resume the historical Buy, perform a class transfer or invent a second funding
engine. Common funding pause/withdrawal behavior is retained; default venue
release remains off. UI changes only distinguish the source label
`Hyperliquid perps cash` inside the existing layout. Receipt/refund/reorg fencing
uses the exact component and its current observation, never newer spot cash.

Acceptance: the funding profile passed 366/366; separate account/schema/debit
checks passed 37/37. Disposable PG16 tests passed actual signed admission with an
offline ephemeral key, a one-raw-unit shortfall, distinct spot/perps funding
holds, durable unknown submission and replay without renewed send authority.
The real account worker persisted verified perps facts, isolated a perps read
failure and recovered on its normal next pass. Native/EVM debit, two merges,
reorg, availability and custom/generic/empty-tail SQL plans passed; perps
candidate plans measured 0.034–0.118 ms and 1–28 buffers on the synthetic indexed
history. The full backend workspace build passed 16/16. Independent no-history
review gave this slice scoped GO, not whole-goal or live-financial approval.

An additional private browser harness mounts the **actual common funding
controller and sequential runner**, with only wallet/API IO synthetic. Seven
checks passed: terminal consumer, revoke, owner switch, logout and unmount while
wallet preflight is pending prevent prepare/action-start/signing; disconnected
wallet has actionable recovery; an explicit reconnect retry reaches ordinary
prepare. Unexpected requests are counted and must remain zero. Signing is
deliberately not reached. This closes the async-preflight mounted-test gap, not
the entire direct/funded/Confirmation/signature/two-tab browser matrix. Final
whole-scope consecutive fresh GO remains **0/2**. No real financial, production,
Git or personal Telegram action occurred.

## 78. Intermediate recovery, consent and ordinary Orders checkpoint — October 16, 2026

This supersedes section 77's seven-check browser scope. Thirteen checks now mount
the actual common funding controller: both pending wallet preflight and a
successful delayed prepare are fenced by terminal consumer, revoked signing,
owner switch, logout and unmount. The captured signing signal and caller's exact
consumer predicate remain checked through all signer/submission callbacks.
Stopping before signing creates no false in-flight journal; an explicit healthy
retry reaches the same ordinary preparation. Already submitted results retain
their original durable reporting path. All IO in these browser tests is
synthetic; no transaction or real signature is produced.

Sixteen mounted app-handoff checks also passed. Explicit native Check invokes the
same factual observer before rereading projection; passive polling does not.
Checks coalesce, failure permits read-only recovery, and late Check/execute/Cancel
responses cannot reactivate work after token/owner/logout/unmount changes.
Funding predicates retain their exact request scope, rather than a boolean that
could become true for a new handoff. Product Telegram code is tested locally;
the user's personal Telegram remains untouched.

A fresh whole-scope diagnostic found two further issues, both corrected and
subsequently given scoped GO. Ordinary Fund+Buy no longer silently replaces an
expired reviewed IOC with a differently sized/priced one merely because the
debit matches. It captures reviewed economics and expiry, checks after funding
and immediately before submission, and returns to ordinary Review on change.
The funded reservation is retained. A still-valid identical order can continue;
a new explicit confirmation provides new consent. Tests include `24 @ 0.4012`
versus `16 @ 0.6018`, both costing `962880000` raw8.

The ordinary Orders mapper retains optional normalized provider CLOID. A lost
submission ACK can therefore deduplicate the observed snapshot against an
admitted native order through exact environment, signer, owner, token and CLOID
while native OID is unknown. Known-OID conflicts, other tokens, external orders
and unadmitted preparations stay visible. The reader does not bind an OID or
change financial state. The provider field was checked with four public read-only
requests; only key names/counts were retained, no participant addresses.

Mapper tests and disposable PG16 native/legacy History suites passed. The
50,000-order/5,000-snapshot custom/generic lost-ACK plans, including resumed empty
pages, measured 99–109 ms and approximately 83,500 local buffers in the synthetic
fixture. The full backend workspace build passed 16/16; exact Node 20/Turbopack
and admin builds also passed. These are intermediate checks, not production
performance or live financial approval. No migration was added for CLOID.

The user authorized committing/pushing this intermediate snapshot to `hip-next`,
without merge, deployment or financial activation. P3/P4 remains active and the
required consecutive fresh whole-scope GO count remains **0/2**. Scoped approval
of corrected findings does not count as either final review.

## 79. Native submission and bounded card repair — October 16, 2026

The actual ordinary native hook/session/journal now has an isolated browser
submission harness (`tests/design/hip4-order-hooks/submission-fixture.tsx` in
the frontend). Thirteen checks cover direct/funded one-shot admission, reopen,
factual receipt and Done, six late-signature lifecycle boundaries, expired
Review, and Cancel ACK/response loss. MessagePack/EIP-712 validation and an
explicit public SDK **test key** are real; API/auth/Privy IO is synthetic and
unexpected requests fail the test. No user's key or actual order is used.
Two real browser tabs also passed serialization: A holds the real WebLock
through a deferred offline signature; B waits, then restores A's exact journal
without another prepare/sign/submit. Reloaded B still performs reads only.
This does not claim a live funded order or the full mounted Confirmation UI.

Native funded lifecycle repair now bounds sources before funding fact joins.
Migrations 0335–0340 add a derived UUID traversal cursor and concurrent indexes;
they do not classify historical financial rows or introduce a financial queue.
The source pool combines bounded new/live hints, historical rotation, and exact
operation hints already returned by the **existing common funding worker**.
The normal batch limit is unchanged. Historical repair reserves a slot; a batch
of one alternates history/live preference. Cursor acknowledgment stops before
displaced or locked due work. Empty tails wrap on the same normal tick. Cached
terminal cards affect priority only and remain eligible for late factual repair.
The unprojected-first phase for new direct/legacy cards is preserved.

Disposable PG16 tests include 50,000 funded sources, new insertion behind the
cursor, mixed-lane competition, consecutive skipped-source repair, and real
two-connection funded owner/intent locks followed by next-tick recovery. Custom
and generic plans measured: source pages 0.009–0.083 ms / 1–12 local blocks,
unchanged hints 0.96–1.16 ms / 76–78 local blocks, hot pages 0.009–0.013 ms /
2 blocks, and operation hit/missing/empty seeks 0.005–0.032 ms / 0–4 blocks.
These are synthetic workload measurements, not production throughput promises.
Independent review approved this corrected slice, not the whole goal.

The shared Account Value exact-refund reader deliberately retains completed
refund balance/reorg fences. With API-equivalent `jit=off`, 5,000 completed legs
measured 248.541 ms SQL and 507.379 ms full read projection. Its cost remains
linear in retained history and direct funding preparation does not always use
the display snapshot cache. Dependency-complete projection optimization is a
separate follow-up: do not omit terminal rows, cap history, or use existing
classification revisions alone (they do not cover every read dependency).

P3/P4 is still active; final consecutive fresh whole-scope GO remains **0/2**.
All additions after the authorized intermediate push are uncommitted. No
production policy, permissions, deployment, live financial or personal Telegram
action is part of this acceptance.

## 80. Mobile close authority and final acceptance — October 16, 2026

The first fresh whole-scope review rejected a real client lifecycle defect:
mobile Confirmation kept `open=true` during its 520 ms exit presence and waited
for asynchronous reservation cleanup before Close/Back navigation. A late native
prepare or signature could therefore continue after the user's close action.

The ordinary wrapper now passes actual `open` independently of visual presence.
Close/Back synchronously revoke the native signing signal and clear automatic
funding/preparation continuations before cleanup or parent navigation. Readiness
has a consent epoch, so returning to identical wallet/ticket values does not
revive a pending response from the previous lifetime. Cleanup remains the common
exact funding-operation cancellation; durable submitted attempts and their
reconciliation are not erased or treated as failed.

Sixteen isolated browser checks passed with the actual wrapper/native hook,
including delayed prepare and signature resolved 50 ms after close while content
is still mounted, immediate revocation before any parent render, and exact
Check/abandon recovery on reopen. The visual Drawer primitive and Review leaf
are synthetic in this harness; it is not a claim of full mounted production
Confirmation UI. Four production-callback tests separately execute ordinary
close, every mobile Close/Back handler, and close/reopen or A/B/A readiness races.
No provider IO, user key, actual order or personal Telegram action is used.

Backend full workspace build passed 16/16 and lint passed 15/15. The corrected
frontend passed 1,938 tests, typecheck, and exact Node 20.11.1 / Next 16.3.4
Turbopack build (42 pages). Final fresh whole-scope reviews are still required;
the earlier NO GO and scoped approvals do not count toward **0/2**. Financial
activation and deployment remain separate, unauthorized operations.

## 81. Explicit recovery of a lost cancellation — October 16, 2026

A second fresh whole-scope review found that a cancellation admitted before a
process/transport loss could stay ambiguous forever while the original GTC
remained open. Correctly preventing replay of the old signed action did not
provide a practical cancellation recovery path.

The ordinary Orders control now offers **Review cancellation again** for an
admitted ambiguous cancel with an exact confirmed-open owned parent. This only
retires its expected local cancellation pointer under the existing cross-tab
lock, after rechecking action and parent identity/CLOID. It does not acknowledge
success, abandon the server action, release holds, change fills, or affect a
BUY/SELL journal. A separate explicit Cancel obtains a fresh request key, server
nonce and signature for that same parent. A late original cancellation cannot
create exposure. Unknown/failed/wrong-identity reads retain recovery; terminal
parent evidence uses factual Done instead. No new financial protocol is added.

Tests cover stale/competing tabs, logout and replacement during reads, missing
or wrong parent, late original closure/fill, policy-disabled review, passive
reopen and fresh explicit cancellation. The actual ordinary-hook offline browser
matrix now passes 17 checks, including distinct cancel action/key/nonce after
lost response, no automatic retry, no BUY/funding and no abandonment. Full frontend
tests pass 1,943/1,943, typecheck/lint and exact Node 20/Turbopack pass. Independent
follow-up approved the correction, not the whole scope. Final consecutive fresh
whole-scope GO remains **0/2** until two new reviews pass.

The complete 350-file migration sequence through 0340 also passed on a new empty
disposable PostgreSQL 16.2 database; no invalid indexes remained. Earlier current
source legacy fixtures, custom/generic plans and concurrency evidence in section
79 remain applicable. Production data and policies were not changed.

## 82. Terminal partial/zero observation cadence — October 16, 2026

A further fresh whole-scope review found that ordinary terminal partial/zero-fill
orders could never satisfy the full-original-quantity cold predicate. Exhausted
repair scans therefore restarted in the hot queue forever, consuming shared
provider budget and delaying newer orders as historical cancellations grew.

Only scheduling changed. An exact terminal order also enters the existing cold
lane after a successful bounded fill scan exhausts through its official terminal
timestamp. Full quantity, history coverage, fee certainty, execution receipts,
funding and holds are not inferred or rewritten. The rows remain eligible for
existing policy-controlled cold rechecks; a failed check returns to hot repair.
Explicit Check still bypasses cadence but never a live lease. No new background
engine, budget or interval was added.

The shared SQL predicate drives both queue selection and post-fenced scheduling
against the just-persisted row in the same transaction. Additive concurrent index
0341 matches it and preserves 0334 for older readers. Malformed optional repair
JSON is tolerated, not a migration failure. Both disposable PostgreSQL 16.2
databases accepted 0341; the empty-database sequence now has 351 migration files.

Actual observer acceptance passed zero/partial financial-fact preservation,
incomplete/error/malformed scans, cold-to-explicit-Check/error recovery, funding
and merge/lease regressions. Mixed 50,000-record full/partial/zero terminal history
did not delay one hot order: custom/generic admission measured 0.167/0.161 ms and
52/56 local blocks. First/next/empty hot/cold probes measured 0.025–0.260 ms and
4–47 blocks. These are synthetic plans, not production throughput guarantees.
The first fixture ordering manufactured excessive dead entries by repeatedly
retiming all history in one unvacuumable transaction; the final phase-separated
fixture retains the same bounds and all empty-tail assertions.

Full backend build/lint passed 31/31 tasks; 29 amount/fee/evidence tests also
passed. Independent follow-up approved this correction only. Fresh whole-scope
acceptance restarts at **0/2**, with no new commit, push, deploy or activation.

## 83. Retained terminal history and provider absence — October 16, 2026

Whole-scope review found one related queue regression: a provider `unknownOid`
retained an already exact terminal observation, but its diagnostic removed the
order from cold cadence permanently. The correction allows only that absence
diagnostic against a retained, non-invalidated terminal barrier and sufficient
full-fill/known-fee facts or successful exhausted repair. Other errors,
contradictions and incomplete repair remain hot. An unknown response never
refreshes terminal provenance, repairs an invalidation, invents a fresh receipt
or releases holds. Existing cold policy and explicit Check are unchanged.

Additive 0342 matches the scheduling predicate while preserving 0341 and older
reader indexes. It passed both legacy-fixture and previously empty disposable
PostgreSQL 16.2 databases, bringing the sequence to 352 files. An unapplied
comment-semicolon splitter error was caught in the first disposable migration
attempt and corrected before successful re-execution; no applied checksum or
historical row was changed.

Final actual observer acceptance passed full/partial/zero retention, diagnostic
and null-summary preservation, invalidated-evidence refusal, explicit recovery,
leases, common consumer and merge races. In the 50,000 mixed historical rows the
hot UUID is deliberately last, not an accidentally first global-queue row.
Custom/generic hot admission measured 0.195/0.155 ms and 50/54 local blocks;
hot/cold first/next/empty probes measured 0.025–0.178 ms and 4–50 blocks. Full
backend build/lint passed 31/31 tasks; final PG postcheck had no invalid indexes
or leaked test connections. These remain local synthetic workload measurements.

Generic native SendAsset `status:err` is still **ambiguous**, not independent
proof that funds can be released: reused nonce/replay/error semantics require
exact receipt evidence. A future diagnostic/rejection classification must prove
its safe subset rather than accepting arbitrary provider error text. No change
to that financial safeguard was made in this review.

Scoped correction reviews do not count as final acceptance. Two new independent
no-history whole-P3/P4 reviews are required, starting at **0/2** on this corrected
snapshot. No production activation, Git push or personal Telegram action occurred.

## 84. Native transfer fee capability — October 16, 2026

A first fresh whole review returned GO; the next returned NO GO on the native
outbound fee boundary. That breaks the consecutive sequence: current final
whole-implementation acceptance is **0/2**. Role `user`, Standard cash and Relay's
fee summary alone did not prove the absence of first-outbound activation cost.
Rejecting all nonzero fee receipts only after a transfer was not a sufficient
pre-submit capability boundary.

The supported outbound subset now requires positive, uncached native fee checks
for the exact sender and independently resolved Relay depository. Both checks
must report an existing, previously transacting, unsanctioned account with zero
activation fee. Native USDC from Standard spot/default perps to that established
default-perps depository is supported; new/fee-bearing/unverified sources and
Core-to-EVM forwarding/system recipients are not admitted. This is a financial
capability check, not another product allowlist or a hardcoded activation fee.

Primary evidence is the SDK's
[preTransferCheck contract](https://github.com/nktkas/hyperliquid/blob/master/src/api/info/_methods/preTransferCheck.ts)
and the official app's dated public `config-1E2uRQO0.js` implementation, inspected
read-only on this date. Its native SendAsset review uses exact recipient/source
`preTransferCheck`, labels the fee USD-stablecoin, and separates forwarding/gas
review. Its ledger formatter identifies nonzero `nativeTokenFee` as HYPE. This
grounds the narrow native-route check; it is not a universal zero-fee promise or
proof that an older redacted transfer was a forwarding transaction. Circle and
Hyperliquid activation descriptions differ; neither is used to guess a charge.

The existing shared client, policy freshness and request-weight budget own these
two reads. Quote creation checks before exposing Review; common action prepare
checks before returning either signature; final SendAsset admission rereads and
rechecks exact binding/expiry after financial lock waits. No provider IO runs
while holding those locks. An admitted replay bypasses new eligibility and never
resends. Existing nonzero-fee/unknown historical receipts retain their conservative
reconciliation; they are not relabeled as zero or released from error text.

Unsupported capability has a distinct `native_transfer_fee_unverified` discovery
reason in generated REST contracts and the ordinary funding presentation. Users
can complete account activation in Hyperliquid, then explicitly refresh/review,
or use another supported source. A successful subsequent authoritative check
recovers immediately, without timers, manual database edits or automatic actions.
If eligibility changes after a browser signature, admission remains unsubmitted;
the ordinary report/recovery path closes only that prepared lease and fences a
late signed request. Real financial actions were not used to test this behavior.

The correction has pure invalid/missing/nonzero/first-use/identity/system/expiry,
shared-budget and positive-recovery tests. Disposable PG16 native send and common
prepare tests prove no attempt before failed eligibility, post-sign expiry with
no money ambiguity, exact ordinary recovery, no-resend replay and two-session
max-one-connection admission. Snapshot/debit regressions pass. New SQL test
statements were executed on PG16; this correction adds no migration. Full backend
build/lint passes 31/31. Final cross-repository checks and two new fresh whole
reviews remain required; financial defaults remain off.

## 85. Final P3/P4 technical acceptance — October 16, 2026

Two sequential independent reviewers, each started with no conversation or prior
review history, returned **WHOLE P3/P4 technical GO** on the same frozen source.
They compared backend/frontend against their local `main` baselines and admin
against `master`, including dirty/untracked implementation and migrations through 0342. Neither approval relied on financial defaults being off. Earlier NO GOs
and scoped correction approvals were not counted. The final consecutive count
is **2/2**, completing the P3/P4 technical implementation goal.

The accepted integration uses the existing Funding catalog, planning, physical
reservations, worker, exact receipt/refund publication and current-fact recovery.
Native order admission, sign-only execution, one-shot submit, cancellation,
ordinary Orders/portfolio SELL and sealed Telegram app handoff retain common
Hunch ownership, policies, consent and UI. No separate financial framework,
product design or discovery query engine was introduced. The optimized unified
feed remains the discovery owner; final post-checkpoint feed changes are nullable
presentation/type assertions, not SQL rewrites.

Corrections before the frozen reviews include immediate mobile Close/Back consent
revocation, explicit fresh cancellation review after a lost response, fair bounded
funded-card repair, cold cadence for exact terminal partial/zero/retained-unknown
observations, and the current exact zero-native-fee transfer capability in section 84. These preserve financial facts: an unknown response does not become a failed
payment, a cancellation ACK does not release order exposure, and delayed callbacks
cannot revive a historical Buy or a retired consent lifetime.

### Final verification

| Check                             | Evidence                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend workspace                 | Full build/lint: 31/31 tasks (16 build, 15 lint); final independent rerun also passed from cache                                                                                                  |
| Funding unit matrix               | 273/273 tests across 100 files; finance-worker 24/24                                                                                                                                              |
| Existing-venue/common regressions | Funding domain/planner/routes/persistence/lifecycle/delegated execution, account value, trading, Polymarket and Limitless: 12/12 entrypoints plus 39 node test cases                              |
| Frontend                          | 1,944/1,944 tests, typecheck, lint, generated-contract consistency; exact Node 20.11.1 / Next 16.3.4 Turbopack production build, 42 pages                                                         |
| Admin                             | 47 tests, TypeScript/Vite build and lint; unchanged final source                                                                                                                                  |
| PostgreSQL                        | Official disposable PG16.2: both legacy fixtures and empty-database bootstrap through 0342, 352 migrations; no invalid indexes or leaked test clients at postcheck                                |
| Independent reviewer G            | 207 backend tests, 88 frontend tests / 833 assertions, admin labels and five real disposable PG16 suites passed                                                                                   |
| Independent reviewer H            | Full backend build/lint, 379 targeted backend tests plus nine native transport tests, all 10 allowlisted PG16 entrypoints, frontend 1,944/typecheck/lint/contracts and admin 47/build/lint passed |
| Browser boundaries                | Actual ordinary wrapper/native hook/session/journal: 17 offline submission checks; real two-tab WebLock recovery; separate common funding and app-handoff consent matrices                        |

The PG16 entrypoints cover native prepare/send/snapshot debit, order observation,
native account and unified order/history reads, account worker, exact funding
receipt/refund and direct/funded Telegram app handoff. They exercise real locks,
concurrency, lease fencing, current-fact/reorg repair, rejection-before-admission
recovery, replay and representative first/resumed/empty custom/generic plans.
Synthetic provider IO and published offline SDK test keys are not live execution.
The browser visual Drawer primitive/Review leaf are test boundaries; the evidence
does not claim a full mounted production Review or live funded E2E run.

### Retained limits and next work

- Native outbound funding supports only the positively checked zero-fee subset
  in section 84. Missing/changed fees recover through explicit refresh/review;
  admitted uncertain transfers keep their evidence and reservations.
- No authoritative negative SendAsset receipt contract was established. Generic
  provider errors, nonce errors, expiry or absent receipts cannot prove non-debit.
  This remains an explicit activation-evidence risk, not permission to invent a
  failure classification, silently resend or release funds. Any future positive
  rejection/invalidation recovery requires its own protocol proof and tests.
- Shared exact-refund accounting remains linear in retained history. At 5,000
  completed legs, independent reruns measured 220–236.755 ms SQL and
  493–570.859 ms full projection. Some ordinary Orders projections are also
  history-linear. These are local fixtures, not production-scale performance
  guarantees; dependency-complete optimization must not drop financial history.
- P4S verified thesis/Copy evidence, P5 complete public-surface parity, P6 matching
  and wallet research, and P7 gradual activation remain separate. Technical
  acceptance neither enables their capabilities nor declares them completed.
- The user explicitly authorized saving this accepted snapshot through commit/push
  to all `hip-next` branches. Financial activation, live signing/funded E2E,
  production permissions/policy and merge/deploy still require a separate
  explicit command. Personal Telegram, user app servers, authentication and local
  admin permissions were not operated by this acceptance.

All final whitespace and targeted documentation checks pass. The known unrelated
frontend global Markdown `AGENTS.md` second-H1 warning was not hidden or changed.

## 86. P4S P5 and P6 implementation and local testing

This section supersedes the P4S/P5/P6 next-work lists in earlier checkpoints.
Backend `origin/main` at `a433c256` was merged into `hip-next` as `f6b0775f`;
frontend `origin/main` at `139cbdee` was merged as `15db0aed`. Admin `hip-next`
already contains its current `origin/master` baseline. These synchronizations
and periodic feature checkpoints do not authorize merge or deployment.

| Phase | Implemented contract                                                                                                                                        | Remaining acceptance boundary                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| P4    | Existing direct/funded interactive orders, cancellation, exact cash/receipts and app handoff retained                                                       | Real signing, provider execution and funded E2E are the user's manual tests                                                  |
| P4S   | Native verified BUY, immutable thesis snapshots, exact pre-submit Copy retention and direct/funded recovery                                                 | Enable only the proved primary-order subset; no inferred dual-order aliases                                                  |
| P5    | Existing market/event UI, Discovery map, factual SEO/share, portfolio publication controls and exact-revision report interactions on desktop/mobile/MiniApp | Two fresh whole-scope GO reviews passed; real financial E2E and production activation remain separate                        |
| P6    | Formal-rule-aware matching, canonical-change invalidation, bounded known-wallet reads, support evidence and app-only signal CTA                             | Incomplete rules remain review-required; partial wallet evidence is not a global holder population or calibrated trader edge |

### Verified purchase and Copy

The canonical purchase key is
`hyperliquid:purchase:v1:<environment>:<lowercase-owner>:<primary-oid>`.
Pre-submit attribution uses
`hyperliquid:cloid:v1:<environment>:<lowercase-owner>:<cloid>` and the frozen
instrument generation. An authoritative primary/dual alias contract has not
been established; transaction hash, time, quantity and price cannot substitute
for it. Only exact original BUY fills count toward gross notional and net
shares. A signed rebate stays a rebate; unknown fees remain unknown.

Admission retains the exact source revision, Copy key, order and submission in
one transaction before the first exchange POST. Replays validate the same pair
before current-policy checks and cannot issue a second POST. Hidden sources
block new Copy, not reconciliation of an admitted purchase. Final admission
checks the current policy, market generation and expiry after lock waits.
Funding uses the existing consumer intent and reservations with the same frozen
Copy pair; it is not an independent payment flow.

The final native instrument check also applies to ordinary direct/funded BUY
and SELL, independently of social permissions. Preparation freezes the exact
native contract and caps the signed expiry to any known market expiry. After
all admission lock waits, the database wall clock fences current market status,
metadata freshness, settlement, expiry and the frozen economic generation.
Refreshing books or snapshot IDs does not change that generation. Compatible
older BUY snapshots may be reconstructed, but an old envelope extending beyond
known expiry requires a fresh Review; signed bytes are never silently renewed.
Already admitted replay and cancellation retain their existing recovery paths.

Migration `0347_hip4_execution_evidence_status.sql` adds nullable row-local
provider-evidence state without inventing historical proof. Contradictory exact
fills preserve immutable raw facts and quarantine proof. Empty, unrelated and
failed reads cannot resolve the conflict. Legacy coarse conflicts are pending
until a bounded exact official reread; matching proof restores the existing
purchase, thesis and Copy count. A short transaction locks the account snapshot,
rereads the complete exact-order fill set after waiting, and finalizes through
the existing verified-buy CTE. Provider IO never runs under those locks.

An explicit social evidence refresh can repair an old fully filled order even
when it no longer enters the general account repair lane. It requests at most
one exact order/time slice and rereads the complete retained order set. Recovery
requires a newer matched P2 revision, the same immutable fill and basis, and
valid original BUY provenance. Budget denial, failed, empty, unrelated or
contradictory responses retain revocation; a callback result alone is not proof.
The PG16 test restores the original purchase, thesis and copier count for a
90-day-old complete order without changing raw facts or creating duplicates.

Social publication and Copy remain independently controlled by the existing
`social.publicationVenues` and `social.copyVenues`; defaults do not include
Hyperliquid. Ordinary $1 BUY eligibility is not the executed-notional publication
threshold. Likes, flat comments and verified copier counts use the common
social service and exact published revision. Author returns describe the frozen
published snapshot, with fees excluded, not current wallet profit.

### Matching and known wallet evidence

Matching normalizes explicit environment, outcome, recurrence, settlement rules
and side conditions. A topic/title match cannot establish equivalent payouts.
Current incomplete native templates retain their source fingerprint and
`review_required` status; the code does not manufacture oracle, timezone,
resolution window or void terms. Only complete validated formal tuples can
establish rule equivalence, including a justified side inversion.

Native canonical changes enqueue the existing embedding owner only after the
market transaction commits. Quote refresh IDs and timestamps do not repeatedly
invalidate unchanged contracts. Indexer REST and WS share this path and the
existing Redis connection. Native cluster quotes and performance marks use the
actual selected side's fresh book, never a synthetic `1 - YES` quote.

Wallet intelligence runs under the existing bounded refresh owner for known
tracked accounts. It does not enroll every exchange participant or reuse the
owned-account finance observer as a public scanner. Mainnet/testnet identity,
exact tied fill keys and source continuation remain separate. Current positions
are authoritative snapshots; missing history does not become cost basis/PnL.
Native flows can support a mixed recent-flow thesis, but cannot claim strong
holder credentials, calibrated win rate or global holder concentration.

Tracked-activity contradictions are durable per source event key, independently
of the wallet refresh result. A new successful empty page, unrelated fill or
transport error cannot clear a disputed row. Matching observations that began
before a concurrent conflict cannot clear it either. Legacy rows without exact
versioned proof are ambiguous for flow only and recover through the next bounded
exact fresh reread; independent current positions stay usable. This state uses
existing event metadata, not a new table or blocking global wallet gate.

The new tracked-source and by-token queries preserve indexed pagination and
batch hydration. The optimized unified feed remains unchanged as the discovery
query owner. Signals keep existing model, reasoning, search and budget policy;
HIP delivery opens a user-reviewed Hunch app ticket, never autonomous bot Buy.

The ordinary `/events/<canonical-native-id>` page and its server rendering use
the coverage-aware public `/markets/hyperliquid?eventId=...` adapter. The legacy
`/events/:eventId` financial hydrator still excludes native contracts; broadening
that legacy helper is not a prerequisite or an alternate source of native
prices. Both device routes adapt the native DTO to existing Hunch components.

### Local manual test setup

Use the ordinary local app on port `3000` and API on `4014`, with local PG16
`hip4_local` on `55436` and Redis on `55437`. Keep the existing local login and
admin identity. Back up the working database and validate migrations through
`0347` on an isolated clone before upgrading it. Run the migrator with explicit
`--database-url` and `--expect-database`; a shell environment prefix is not an
adequate target guard. Never point these commands at production.

The local launcher `ops/hip4-local.mjs` provides a checked configuration for API,
read-only indexer and an explicitly requested finance-worker process. Its check
mode reports key presence and schema readiness without exposing values. The
worker is not started by opening the app. Necessary reconciliation observes
already user-authorized operations; global finance execution and unrelated
Telegram/fee/payout/sweep/content lanes remain off. Only the user performs
interactive signing, final submission and transfers.

The API also needs a dedicated local receive-option HMAC key for the existing
Funding deposit catalog. Put only `ADMIN_SERVICE_TOKEN_PEPPER` in the ignored
`untracked/hip4-local.env`, with 32 cryptographically random bytes encoded as
64 hex characters and owner-only file permissions. The local launcher does not reuse
the production pepper or its public disposable JWT key. Check/start never
creates or replaces this file. Preserve it across restarts so existing option
tokens remain verifiable; missing, short or unsafe configuration has an explicit
startup diagnostic. Restore the saved key or provision a fresh one and refresh
the receive catalog. Key replacement is not permission to repeat an operation.

For a new local stand only, provision once from the backend root; exclusive
creation refuses to overwrite an existing file and prints no secret:

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('untracked', { recursive: true, mode: 0o700 });
writeFileSync('untracked/hip4-local.env',
  `ADMIN_SERVICE_TOKEN_PEPPER=${randomBytes(32).toString('hex')}\n`,
  { mode: 0o600, flag: 'wx' });
JS
```

Set `HIP4_LOCAL_DATABASE_URL` to the existing local connection string without
printing it. From the backend root, check each process before starting it:

```bash
node ops/hip4-local.mjs api --check --database-url "$HIP4_LOCAL_DATABASE_URL" --expect-database hip4_local
node ops/hip4-local.mjs indexer --check --database-url "$HIP4_LOCAL_DATABASE_URL" --expect-database hip4_local
node ops/hip4-local.mjs finance-worker --check --database-url "$HIP4_LOCAL_DATABASE_URL" --expect-database hip4_local
```

Remove `--check` to start the chosen process in its own terminal. API and indexer
are separate processes. Start `finance-worker` only when intentionally beginning
the user's manual funding/repair tests: reconciliation may advance an already
authorized operation, even though autonomous signing and global execution stay
disabled. From `Hunch_App`, start the ordinary frontend separately:

```bash
HUNCH_API_BASE_URL=http://127.0.0.1:4014 node --dns-result-order=ipv4first node_modules/next/dist/bin/next dev --hostname localhost --port 3000
```

Run builds with the installed Node 20 runtime first. The launcher refuses schema
gaps and never migrates automatically. Its stored-policy hints are not validated
effective capabilities; use the normal API/admin policy contract to inspect or
explicitly change activation. No secret value is included in its status output.

Use existing runtime policy/admin controls, not another HIP feature switch:

- `venue_lifecycle.hyperliquid` controls ordinary exposure, source reads and
  indexer capability; exit-only repair remains available as designed.
- `hip4_read`, `hip4_account` and `hip4_trading` own their existing resource,
  environment, freshness, amount and observation parameters.
- Existing funding/capacity/recipient policies must advertise the exact selected
  source, destination and current fee capability. Unknown or nonzero unsupported
  native send fees refuse that route, not silently reduce delivered value.
- `social` must explicitly permit Hyperliquid publication/Copy for those tests.
  No activation is implied by code acceptance.

Before manual money movement, check fresh owned cash/positions, current side
quotes and generated fees, ordinary direct BUY/SELL/cancel, and then shortfall
funding from each advertised source. Exercise user rejection, Close/Back,
timeout/reload and Check without a second payment or Buy. Publish one qualifying
exact purchase and Copy it from another account; verify self-Copy rejection,
immutable entry and unique confirmed copier counts. A pending or uncertain
operation must stay visible and repairable, not be treated as failed cash.

### Acceptance evidence and unresolved activation risks

Current checks include the full backend build/lint (31/31), exact Node 20.11.1
Turbopack frontend build (42 pages), reproducible generated contracts and real
disposable PG16 suites for Copy/verified evidence, funding, lifecycle, wallet
merge, native orders, known-wallet source pagination and read APIs. Empty PG16
bootstrap and a restored legacy local backup both migrate through `0347`.
New evidence queries include custom/generic plans with 100,000 unrelated rows;
they are not estimates from TypeScript or a `LIMIT` clause alone.
The latest frontend suite passes 2,039 tests across 330 files, with 9,608
assertions, plus typecheck and full lint. The exact Turbopack rebuild compiled
successfully in 7.4 seconds and generated all 42 pages. These local build times
are not production performance measurements.

Browser evidence uses the actual shared report/composer components and mounted
Copy-review hook with synthetic API/auth IO, including scoped replay, controller
change, logout and Close recovery. It does not certify live signing or funded
execution. The first fresh whole review found the tracked-flow conflict issue;
its correction passed real PG16 recovery tests. A later review found permanent
read-only orderability in the ordinary feed and missing effective policy in four
client entry controls. Fresh native feed orderability now follows validated
mainnet/USDC metadata, terminal state and expiry, while quotes and admission keep
their own safeguards. All nine production availability calls were audited;
desktop/mobile feed, tracked-wallet Copy and mobile event rows now consume the
existing policy context. Actual component tests and PG16 anonymous/authenticated
feed, Favorites, cache ageing and policy recovery pass without changing feed SQL.
A further whole review found that ordinary admission lacked the final native
market check already applied to Copy. The common native check now protects
ordinary BUY/SELL too, including real two-connection expiry, stale-metadata and
generation-change waits in disposable PG16. Native pre-admission refusal retains
the existing owned Check and explicit Discard path to a fresh-key Review; it
does not automatically repeat a submission or clear an admitted unknown order.
Native event adapters preserve the validated side observations and their exact
deadlines through the ordinary event-to-feed conversion. Missing, expired or
foreign-side books remain unavailable; official fractional payouts remain
independent. Live mobile pages use ordinary Smart Buy under its existing source
and matching policies; recorded fixture pages remain inert. A later whole
review found an additional social action fallback from denied Copy to Buy.
Both thesis presenters and the shared Hunch strip now read ready effective
policy for the actual source venue. Denied, pending and error states retain
only Open market navigation; active ordinary Buy remains available when only
social Copy is unavailable. Real-component tests cover all four source venues,
cached grants during errors and recovery. The final two sequential fresh whole
GO reviews include this correction and all subsequent changes below.

The common client policy hook also projects cached permissions consistently
after an unresolved or failed policy refresh. It removes only new exposure and
trading-funding grants, including consumers of the raw policy object, without
changing the server revision or read environment. Cached reads, SELL, Cancel,
withdrawal and admitted-order repair remain usable. A healthy refresh restores
new review availability, never an earlier queued click or late signature.
Tests exercise the actual feed controls, Confirmation readiness/reset callbacks,
native session and retained journal through failure and recovery.

A subsequent whole review found an expiry-contract mismatch: admission already
supported an explicit `null` deadline, but feed, event and portfolio presenters
disabled it as though it were missing or ended. Those paths now share the same
known-null-or-future rule without inventing a deadline. Missing, malformed and
elapsed values remain unavailable; quote, ownership, settlement, lifecycle and
admission checks are unchanged. Actual desktop/mobile entry and owned-NO Close
tests pass, together with real PG16 feed and both portfolio integration suites.
The portfolio fixture now uses the canonical USDC asset ID rather than its symbol;
the production exact-asset valuation check and financial assertions are unchanged.

The user explicitly authorized upgrading only the working `hip4_local` schema
on port `55436`. The guarded migration applied all 32 missing files: 358 are now
recorded through `0347`, with one existing user/admin, zero funding operations
and no invalid indexes. API `4014`, ordinary frontend `3000` and the public-read
indexer are running; no policy or financial operation was changed. Actual
API-to-Next-proxy reads passed for the native market, seven-market event, feed,
two trade pages without duplicate keys, candles and an eight-second SSE stream
with `tick` and `market_update` events. Mounted authenticated desktop and mobile
pages show the existing Hunch design, seven event markets, Favorites, the common
trade table, Arsenal 61% with YES 60.76 cents and independently observed NO 39.24
cents. The side switch works and no client console error was recorded. The
native account read is fresh but uninitialized: no owned USDC or positions,
default mode and missing role. Unknown spendable cash is not reported as zero.
The later signing/funded tests remain the user's responsibility.

After a separate explicit user approval, local Funding and Social were enabled
through their existing validators and revision-checked publication owner. The
working database permits funding for Hyperliquid, Polymarket and Limitless from
Base USDC, Polygon USDC/pUSD and HyperCore USDC; Privy receive and delegated
execution remain disabled. Native publication/Copy are added without removing
existing social venues or changing the $10 publication threshold. The ordinary
local finance worker is running with global execution disabled, so it can
observe and reconcile user-authorized activity. No funding operation or native
submission existed at activation; the first observed account refresh completed
without errors. Personal Telegram, AI and unrelated fee/payout/sweep lanes stay
off. Matching and research have not been activated.

Final mounted acceptance found that the local launcher omitted the existing
Funding receive-option token key. The dedicated local-only configuration above
fixes that startup gap without changing the Funding service or production
credentials. Its 10 tests pass under Node 20, including read-only configuration,
restart stability, immediate repair, unsafe-file refusal and secret-free
diagnostics. After restarting only the local API, a normal authenticated
browser-to-proxy `GET /funding/receive-options` returned `ok: true` and three
options: Polygon pUSD, Base USDC and Polygon USDC. No receive session, transfer,
signature or order was submitted by this check.

Final acceptance required two consecutive independent, no-history whole-scope
reviews after the last source and launcher fixes. Both returned GO for the same
frozen backend/frontend/admin candidate. The first independently passed 163
backend tests, 104 frontend tests, 10 launcher tests and an admin-label test.
The second passed 164 focused backend tests and the 367-test funding suite
(overlapping suites), 130 frontend tests, 10 launcher tests and an admin-label
test. Both explicitly separated root-owned PG16/build/mounted acceptance from
their own checks. There are no outstanding material review findings. This is
technical readiness for the user's direct/funded/shortfall/Copy tests, not proof
that real signing or provider execution succeeded.

The implemented native route catalog supports Base and Polygon in both
directions, subject to exact fee and account capabilities. Solana to/from Core
is not currently one supported Hunch operation: the existing planner does not
chain intermediary hops. The older Solana/Core provider receipt fixtures are
protocol evidence, not Hunch execution support. Do not advertise that direct
shortfall family or enable it by selecting a policy asset. A user can separately
review existing Solana-to-Base and Base-to-Core operations; this is not automatic
native funding parity. Adding the direct family requires the same exact
protocol, signer, receipt and recovery acceptance as any other new route.

P7 remains separate. Previously documented native negative-receipt uncertainty,
history-linear refund/accounting costs and production-load evidence remain
activation risks. No additional financial permission, production policy,
personal Telegram operation, merge or deployment follows from this work.
