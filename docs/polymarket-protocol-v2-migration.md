# Polymarket protocol V2 migration

Status: implementation is present locally on `polymarket-v2`; verification and
acceptance limitations are recorded in section 12. **No production trading GO.**
Research date: 2026-10-05 UTC. Backend baseline: `develop`,
`2ade5f71c3131a6b758c24e308dd4e8ddd11f571`.
Frontend companion: [frontend migration plan](../../Hunch_App/docs/polymarket-protocol-v2-migration.md).

This document separates official requirements, observed public behavior, current
Hunch code and proposed changes. Research used public HTTP GETs, Polygon
`eth_getCode`/`eth_call`, local source inspection and independent review. It did
not create credentials, sign, approve, post orders, transfer funds, change
production, run reconciliation, or install an SDK.

Sections 1–11 retain the initial research/implementation plan and its evidence.
Section 12 supersedes their documentation-only readiness statements with the
actual implementation checks. Research reviewers reviewed that plan, not the
subsequent implementation diff.

## 1. Decision and scope

Implement an **additive, generation-aware extension** of the existing Polymarket
adapter. Keep functioning legacy CTF markets, pUSD funding, wallet topology,
credentials, exact-amount routing, submission recovery and historical orders.
Do not globally replace the current exchange or Conditional Tokens address.

There are two related but independent workstreams:

1. Protocol V2: PositionManager positions, ExchangeV3 signatures/approvals,
   Router redemption, correct market identity, indexing and reconciliation.
2. Data API V2: snake-case DTOs, cursor pagination and changed accounting/holder
   semantics. **Data API v1 retirement is October 24, 2026**; this work is needed
   even if every currently discovered market remains protocol v1.

Initial execution scope is the current Hunch product surface: binary outcome
markets, including supported NegRisk markets, BUY/SELL, market/limit orders,
cancellation, funding, withdrawal and redemption. Native combo construction,
horizontal NegRisk conversion, optional conversion of legacy holdings and an
AutoRedeemer operator service are not implicit additions to that surface. Index
their identity/context where encountered; unsupported operations must be explicit
before funding/signing, not silently represented as ordinary binary execution.

Retain custom backend HTTP/HMAC/ethers integration and the existing frontend
signing boundary. No mandatory SDK replacement or new venue is necessary. A
future unified-SDK adoption is a separate dependency change, not the migration's
prerequisite. Never invoke auto-setup/create-and-post helpers merely to inspect
support or to bypass Hunch's submission journal.

Primary requirements: [overview](https://docs.polymarket.com/migrate/polymarket-v2/overview),
[API integrations](https://docs.polymarket.com/migrate/polymarket-v2/api-integrations),
[contract integrations](https://docs.polymarket.com/migrate/polymarket-v2/contract-integrations),
[SDK integrations](https://docs.polymarket.com/migrate/polymarket-v2/sdk-integrations),
[Data API migration](https://docs.polymarket.com/migrate/data-api-v1-to-v2).

## 2. Do not confuse the version axes

| Axis                                  | Current CTF path                       | New position path                       | Consequence                                  |
| ------------------------------------- | -------------------------------------- | --------------------------------------- | -------------------------------------------- |
| Gamma market `version`                | `v1`                                   | `v2`                                    | Selects asset identity and position ledger   |
| Gamma outcome IDs                     | `clobTokenIds`: JSON text array        | `positionIds`: array of decimal strings | Normalize at ingress, not by field presence  |
| Hunch order payload marker            | `polymarket_clob_v2`                   | Same eleven-field shape                 | Not a protocol discriminator                 |
| Order EIP-712 domain                  | Version `2`, legacy exchange           | Version `3`, ExchangeV3                 | Different order hashes/signatures            |
| Position ledger                       | CTF ERC-1155                           | PositionManager ERC-1155                | Different balance/approval/receipt target    |
| CLOB conditional balance type         | `CONDITIONAL`                          | `CONDITIONAL-V2`                        | Exact asset ID still required                |
| Collateral                            | Polygon pUSD, six decimals             | Same pUSD                               | No new deposit/Relay rail                    |
| Wallet signature type                 | Existing Safe `2` / Deposit Wallet `3` | Same supported wallet families          | Not selected from market version             |
| ClobAuth                              | Domain version `1`                     | Unchanged                               | Do not bump it                               |
| Deposit Wallet Batch/wrapper identity | `DepositWallet`, version `1`           | Unchanged wallet identity               | Inner order domain changes separately        |
| Hunch Telegram handoff                | Hunch contract version `2`             | Still Hunch version `2`                 | Seal the market execution context separately |
| Data API                              | v1 REST                                | `/v2` REST                              | Independent service/DTO migration            |

Public CLOB `GET /version` returned `{"version":2}`. It does **not** prove that
a Gamma market is protocol v2. Existing `@polymarket/clob-client-v2` use similarly
does not prove ExchangeV3 support.

## 3. Verified deployment and identifiers

All addresses below are Polygon mainnet, chain ID 137. Use published **proxy**
addresses for transactions, domains and event filtering, not implementation
addresses. Recheck contract configuration during implementation/rollout because
upgradable implementations can change.

| Contract                          | Published address                            |
| --------------------------------- | -------------------------------------------- |
| Legacy CTF                        | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| Legacy standard exchange V2       | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Legacy NegRisk exchange V2        | `0xe2222d279d744050d28e00520010520000310F59` |
| PositionManager                   | `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF` |
| Protocol Router                   | `0x12121212006e4CD160D18e3f00711DA5c3372600` |
| Binary module                     | `0x1000008dD9001B968442c1000017eaE6E0dA00Ba` |
| NegRisk module                    | `0x200000900045e3B6259600682756002200028933` |
| Combinatorial module              | `0x30000034706C7d8e12009DAB006Be20000c031A8` |
| ExchangeV3                        | `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` |
| AutoRedeemer                      | `0xa1200000d0002264C9a1698e001292D00E1b00af` |
| Common pUSD                       | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| Existing collateral onramp        | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| Existing collateral offramp       | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` |
| Legacy CTF collateral adapter     | `0xAdA100Db00Ca00073811820692005400218FcE1f` |
| Legacy NegRisk collateral adapter | `0xadA2005600Dec949baf300f4C6120000bDB6eAab` |
| Existing Deposit Wallet factory   | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` |

Sources: [contracts](https://docs.polymarket.com/resources/contracts),
[pinned official Solidity source](https://github.com/Polymarket/polymarket-v2-external/tree/741f8bbe88c3f29a1c55d1248a3dd411f622f111).
The protocol Router above is **not Hunch's `PolymarketFundingRouter`**.

### Identity rules

- Read explicit Gamma `version`; select `clobTokenIds` for `v1`, `positionIds`
  for `v2`, even if both fields exist. Decode outcome labels and match the same
  index. Missing/unsupported version, unmatched outcome or missing/non-decimal
  ID prevents **new execution for that market**, with a bounded metadata refresh
  and clear recovery; it must not shut down otherwise valid legacy markets.
- Keep all uint256 IDs as decimal strings/BigInt, never JavaScript Number.
  Existing Hunch `tokenId` can remain the opaque execution asset ID.
- Hunch position-row UUID (`Position.id`, share `positionId`), Hunch market/event
  IDs, Gamma IDs, protocol event ID, condition ID and asset ID are distinct.
- CLOB market subscriptions use the selected asset in `assets_ids`. User-channel
  market subscriptions and market-scoped cancellation use **condition ID**.
- V2 `ConditionId` is `bytes31`; API bytes32 representation is right-padded with
  one zero byte. Validate that padding before taking the first 31 bytes.
  Protocol `EventId` is `bytes29`, padded with three zero bytes. Do not left-pad,
  remove leading bytes or narrow arbitrary legacy CTF condition hashes.
- Position ID layout is module 8 bits, base hash 128, arity 16, reserved 64,
  resolution-chain 16, condition index 16, outcome index 8. The resolution-chain
  field is a **protocol enum** (`POLYGON=0` in the pinned source), not EVM chain
  ID 137. Keep IDs opaque outside a tested protocol codec.
- Legacy registration/migration IDs can use precomputed legacy identity; do not
  regenerate them with native V2 hashing. Registration events are the mapping
  evidence. A similar title or matching market is not proof of token conversion.

Sources: [on-chain position data](https://docs.polymarket.com/resources/onchain-position-data),
[Ids.sol](https://github.com/Polymarket/polymarket-v2-external/blob/741f8bbe88c3f29a1c55d1248a3dd411f622f111/src/libraries/Ids.sol).

## 4. Current gaps and implementation owners

Paths and line numbers below describe the pinned backend baseline; lines will
move when implementation starts. These are confirmed source assumptions, not
claims that production has already lost funds or received V2 markets.
Abbreviated `services/`, `repos/`, `lib/`, `schemas/` and `funding/` paths are
under `apps/api/src/`; fully qualified indexer/package paths are repository-relative.

| Area                            | Current source                                                                                                                       | Required change                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Gamma schema/ingress            | `apps/indexer-polymarket/src/types.ts:86`, `bootstrap.ts:92,373,1306,1874`                                                           | Type version/position IDs/resolution; resolve active asset pair everywhere, including hot selection                   |
| Normalization                   | `apps/indexer-polymarket/src/mappers.ts:620,1037`                                                                                    | Persist generation, selected IDs, ledger and resolution provenance                                                    |
| Structural change detection     | `apps/indexer-polymarket/src/polymarket-repo.ts:84,805`                                                                              | Include version/positionIds/resolutionStatus in business projection; generation-only updates must survive bulk upsert |
| Canonical token mapping         | `packages/db/src/unified-repo.ts:1693,1817,1890`                                                                                     | Current mapping selects active IDs; preserve old bindings/history instead of destructive identity replacement         |
| Market reads                    | `apps/api/src/repos/polymarket-markets.ts:50`, `canonical-market-token-sql.ts`                                                       | Resolve immutable asset-generation binding, not only current clob-token fallback                                      |
| Domain/hash                     | `services/polymarket-order-hash.ts:23`, `polymarket-signing-schema.ts`                                                               | Shared generation-aware domain builder; same eleven signed fields                                                     |
| Quote/submit                    | `services/polymarket-trading-execution-service.ts:3321,5575,6766,8772`, `polymarket-quote.ts`                                        | One backend-authoritative execution context through quote, prepare, signing and validation                            |
| Embedded signing                | `services/polymarket-embedded.ts:1327,1641`                                                                                          | Remove independent domain-2 assumption while retaining CTF path                                                       |
| Order persistence/recovery      | `services/polymarket-trading-execution-service.ts:1509,2529,6495,6510,6535,9009`, `repos/orders-repo.ts:305`, migration `0098`       | Freeze protocol/domain/exchange/ledger separately from payload version; reconcile against frozen values               |
| On-chain status                 | `services/polygon-rpc.ts:1001`                                                                                                       | Verify V3 status ABI and raw remaining semantics, keep V2 exchange history                                            |
| Policies                        | `services/polymarket-automation-policy.ts:1090`, `api-trading-wallet-signing.ts:164,709`, `embedded-evm-sponsorship.ts:270`          | Exact V3 domain and target rules; preserve caps, builder/side/owner restrictions                                      |
| Account readiness               | `services/polymarket-onchain.ts:96`, `polymarket-embedded.ts:975,1748`, `funding/preparation/polymarket-adapter.ts`                  | Contract-indexed approvals/balances; one legacy conditional-token slot cannot describe mixed holdings                 |
| Funding worker readiness        | `funding/preparation/runtime-actions.ts`, `runtime-service.ts`, `funding/runtime/sidecar-runtime-config.ts`                          | Market-specific ledger/operators, without importing API-wide required env into sidecars                               |
| CLOB balance cache              | `schemas/polymarket-private.ts:158`, execution service `:4798`                                                                       | Add CONDITIONAL-V2; require token ID for either conditional type                                                      |
| Redemption                      | `services/polymarket-redemption-plan.ts`, `funding/position-actions/polymarket-redemption-driver.ts`, `telegram-bot-trading.ts:5292` | V2 Router driver, exact amount, outcome 0/1, pUSD receipt, zero-payout handling                                       |
| Holdings/sync                   | `services/positions-sync.ts:688,715,1002,1082,1799`, `repos/positions-repo.ts:1025`                                                  | Partition CTF/PositionManager reads; complete V2 Data API pagination; immutable provenance                            |
| Holders/intel                   | `services/holders-core.ts:201,853`, `wallet-intel-refresh.ts:2147,3068`, `routes/wallets.ts:1729`                                    | V2 holder adapter and correct ledger fallback; do not manufacture zero holders from old CTF reads                     |
| PNL marks                       | `lib/pnl-sql.ts:10`                                                                                                                  | Canonical selected asset/binding, not first historical clob-token ID                                                  |
| Builder fee evidence            | `services/polymarket-builder-fees.ts:26,656,702`                                                                                     | Same event shape verified; add frozen V3 emitter and per-fill idempotent accounting                                   |
| Prices/WS                       | `apps/indexer-polymarket/src/wsMarket.ts:602,678,1127`, `services/polymarket-client.ts`                                              | New asset subscriptions, correct history adapter, normalized resolution refresh                                       |
| Matching/execution verification | `services/cluster-execution-verifier.ts:94`, canonical quote lookup                                                                  | Use selected asset/generation; preserve semantic rules and Jev matching provenance                                    |
| Retention                       | `apps/api/src/market-retention-selector.ts:158` and cleanup paths                                                                    | Protect any new binding/provenance references before hard deletion                                                    |

### Proposed minimal contract boundary

Add one pure backend resolver for a validated market/asset binding and one
shared signing-domain builder. Existing services consume their outputs; do not
add competing generation selectors to each signer, redemption path and worker.

Illustrative contract, **not existing implementation**:

```ts
type PolymarketExecutionContext = {
  protocolVersion: "v1" | "v2";
  assetKind: "ctf" | "position_manager";
  assetId: string;
  conditionId: string;
  outcomeIndex: 0 | 1;
  positionContract: string;
  exchangeAddress: string;
  orderDomainVersion: "2" | "3";
  conditionalAssetType: "CONDITIONAL" | "CONDITIONAL-V2";
  collateralAddress: string;
  chainId: 137;
  bindingRevision: string;
};
```

Keep wallet execution context separate: controller, maker/funder, signer,
signature type and ownership evidence. Combine both into the existing prepared
trade/handoff fingerprint. A generation change invalidates a cached quote/Max
and requires fresh user-authorized preparation before signing, not a hidden
change of exchange after consent.

Persist an additive historical asset binding (proposed
`polymarket_asset_bindings`, or an equivalent existing durable repository)
keyed by chain, ledger contract and asset ID, with market/outcome/generation
provenance. `unified_market_tokens` remains the current market subscription
mapping; its one-token-per-side constraints cannot be the sole historical
ledger. Preserve old order/position references if the active market mapping
changes. Do not duplicate two representations of one holding in account value.

Historical order backfill uses proven stored exchange/hash/payload and known
legacy contracts. A missing field alone is not evidence of v1. Unattributable
records retain their safe historical reconciliation mode and diagnostic reason;
they do not block an availability-sensitive migration or revive old Buys.
The illustrative execution-context type above is for newly prepared
eleven-field orders. Preserve older `polymarket_clob_v1` payload/status readers
and their original proven exchanges/domains too; do not relabel every historical
protocol-v1 order as current CLOB-v2/domain-2 merely because both use CTF.

## 5. Signing, execution and financial invariants

Order EIP-712 fields stay:
`salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType,
timestamp, metadata, builder`.
V2 domain is `Polymarket CTF Exchange`, version `3`, chain 137, ExchangeV3.
V1 keeps version `2` and the correct legacy standard/NegRisk exchange.
The contract ABI's Order tuple additionally includes `bytes signature`; that
field is **excluded from the eleven-field EIP-712 type**. Do not derive a
`hashOrder()` selector from the typed-data fields alone.

For existing Deposit Wallet type 3, maker and order signer are the Deposit
Wallet; its controller signs the ERC-7739 wrapper. For Safe type 2, keep the
existing controller signer and Safe maker. Hunch currently validates deployed
Deposit Wallet/Safe funders for execution and does not implement general EOA
or Magic order submission merely because an enum contains types 0/1.

Persist frozen exchange/domain before submission; recompute and validate the
exact signed amounts/asset/context server-side. Never infer an old order's
exchange from mutable current market metadata during reconciliation. An
ambiguous submission cannot be re-signed to another domain or replayed as a new
order. Definitive rejection and unknown-after-broadcast remain distinct.

BUY pUSD allowance is to ExchangeV3; include fee-inclusive debit in balance and
allowance readiness. SELL PositionManager operator approval is to ExchangeV3.
Router merge/redeem separately require PositionManager operator approval to
Router; split requires pUSD allowance to Router. No broad module allowances are
necessary for the documented Router entrypoints.

Keep per-market ticks/minimums, MAR39 limit checks, post-only rules, FOK/FAK
versus GTC/GTD size semantics, SELL rules, integer raw units and existing fee
bounds. No universal new minimum follows from the migration. GTC/GTD BUY
targets shares; FOK/FAK BUY targets collateral. Settlement counterpart amounts
use integer floor. BUY remaining collateral decreases by actual collateral
spent, with BUY fees additional; SELL fees reduce proceeds. Do not use a
floating approximation to unlock raw reserved collateral.

`getOrderStatus(bytes32)` returns `(bool filled, uint248 remaining)` in the
pinned V3 source. The unchanged `OrderFilled` event includes side/token ID,
maker/taker filled raw amounts, fee, builder and metadata. Filter by the frozen
exchange emitter and attribute exact order/fill IDs. Do not count both
`OrdersMatched` and `OrderFilled` as separate executions or charge twice.

Current builder-fee code filters only E111/e222. Its event decoder can be
retained for the verified shape, but extending emitters is mandatory. Current
legacy FeeAuth endpoints remain disabled (410); no reason to re-enable them.
`PolymarketFeeCollectorClobV2` has a constructor-set exchange allowlist: do not
assume an old collector accepts V3. Validate the actual active builder-fee path
before proposing a collector deployment; native builder fees do not themselves
require replacing it.

Sources: [OrderStructs.sol](https://github.com/Polymarket/polymarket-v2-external/blob/741f8bbe88c3f29a1c55d1248a3dd411f622f111/src/exchange/OrderStructs.sol),
[Exchange.sol](https://github.com/Polymarket/polymarket-v2-external/blob/741f8bbe88c3f29a1c55d1248a3dd411f622f111/src/exchange/Exchange.sol).

## 6. Funding, wallet permissions and Telegram

The collateral and supported wallet addresses do not need replacement. Keep
existing CLOB credentials, HMAC signing, Deposit Wallet factory derivation and
controller/funder ownership checks. No automatic credential rotation.

Unchanged paths include Hunch funding router exact nonce/amount checks,
shortfall allocation, Relay destination pUSD receipts, receive sessions,
USDC.e wrapping/offramp, withdrawal, refunds, balance reservations and
same-funder deduplication. A quote/preparation must carry the frozen generation
context, but a new market ledger is not a new collateral token or receive
address. Do not route the same dollars twice for mixed-generation holdings.

**Deposit Wallet constraint remains binding:** its `execute(Batch,signature)`
is factory-only. A direct Privy-sponsored call reverts `OnlyFactory()`. Privy
policy cannot expand the Polymarket relayer's independent allowlist. Retain the
supported user-authorized, exact pUSD transfer back to its controller followed
by Hunch routing; never rely on a standing third-party allowance from it.

V3 approvals and Router calldata need exact backend authorization and verified
relayer acceptance. Prepare/report/reconcile via existing durable machinery;
do not bypass it with direct wallet sends. If relayer capability is unsupported,
report the specific operation as unavailable with a tested alternate supported
wallet path; do not hold unrelated funds indefinitely or claim nothing moved
after a preceding funding transfer actually completed.

Extend managed Privy/bot policy profiles with precise domain version 3,
ExchangeV3, PositionManager and allowed Router selectors/amount bounds. Keep
old domain 2 rules, BUY caps, SELL constraints, builder binding, owner checks,
policy revision fingerprints and revocation semantics. No wildcard domain,
exchange or arbitrary-calldata allowance. Policy creation/update is a separate
authorized persistent permission action, not part of this research.

API-wide env modules must not become transitive imports of signal-bot/indexer/
finance-worker. Pure contract registries and optional sidecar-safe config
should be consumed by API policy code, not the reverse.

Seal protocol/ledger/domain/asset binding in Telegram managed orders and
interactive web/MiniApp handoff plans. Retain current claim/report/recovery,
consent, exact spending bounds and signer ownership. Hunch handoff version 2 is
not changed merely because Polymarket protocol version is 2. A resumed plan
must not silently trade a newly substituted asset.

## 7. Redemption, migration and ledger indexing

### Position operations

| Operation      | V2 ABI                                       | Authorization/input                                                  | Output evidence                                                      |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Split          | `split(bytes31,uint256)`                     | Exact pUSD pull from caller through Router allowance                 | Both outcomes minted to caller                                       |
| Merge          | `merge(bytes31,uint256)`                     | Router approved on PositionManager; equal exact amount of both sides | pUSD to caller                                                       |
| Redeem         | `redeem(bytes31,uint256,uint256)`            | Outcome 0/1, exact held amount, Router approved on PositionManager   | Burn/transfer and payout to caller, including legitimate zero payout |
| Payout preview | `PositionManager.getPayout(uint256,uint256)` | Selected position ID and exact amount; view only                     | pUSD raw amount or unresolved revert                                 |

All amounts have six decimals. Router pulls input and returns output atomically;
do not pre-transfer tokens/collateral to a module. Legacy CTF redemption's
index sets `[1,2]` are not V2 outcome indices `0,1`. The backend plan must specify
the position-contract approval target, Router calldata and pUSD payout token.

Use the existing normalized position-action inspect/prepare/claim/report/
reconcile framework for V2. Its current registry allows only one driver per
venue (`funding/position-actions/venue-driver.ts:103`), and
`conditionalTokensAddress()` takes no market/operation context (`:83`). Runtime
inspection, missing-submission recovery and receipt observation use that global
address (`runtime-service.ts:320,697,758`). **Registering a second Polymarket
driver is not a working migration.** Keep one generation-aware Polymarket driver
dispatching to legacy and V2 planners, and replace the context-free ledger lookup
with the immutable asset binding.

Freeze generation, ledger, asset, condition, outcome, exact redeemed amount,
Router/adapter, owner and payout token in position-action evidence/plan snapshots
before claim. Runtime facts and operator approvals consume that binding;
recovery/receipt checks use the frozen operation, not current market metadata.
Extend `redemption-runtime-facts.ts`, `canonical-redemption-evidence.ts`,
`canonical-redemption-recovery.ts` and `position-action-repository.ts` attribution
for V2 Router calldata and PositionManager events. The existing canonical parser
only decodes legacy `redeemPositions(...)` and its payout identity is
positive-only. Preserve historical CTF behavior and Limitless compatibility
through additive, versioned snapshot handling; add explicit V2 resolved-zero
consumption evidence instead of weakening legacy proof.

Missing-reference recovery currently scans legacy CTF `PayoutRedemption`
events. Extend bounded discovery to exact PositionManager consumption and
Router/module attribution for the frozen V2 binding. A missing/ambiguous
candidate remains reconciliation work, never permission to send a second
redemption. Preserve pending legacy fingerprints and their original decoder.

Generic successful-receipt plus ERC-20 payout sum is not enough: for a zero
payout that sum can be zero on an unrelated successful transaction. V2 proof
must bind the exact Router call (including an authorized Safe/Deposit Wallet
envelope), owner, ledger, position and consumed amount to the frozen plan,
resolution and payout. A wrong-asset/wrong-owner/zero-consumption receipt must
not complete a losing-position redemption or recover its missing submission.
Preserve the legacy CTF collateral adapter planner. Backend-calldata-driven
legacy frontend fallback also needs the correct position contract, not a
hardcoded CTF approval. Positive V2 pUSD redemption
does not need another USDC.e wrap. A resolved losing position's zero payout is
valid; require exact token consumption and resolution evidence, not a positive
cash receipt. Unresolved reverts are not losing-position success.

Current completion also assumes the refreshed position is entirely zero
(`runtime-service.ts:831–839`). V2 exact-amount redemption must instead verify
the frozen consumed amount and canonical receipt; a legitimate residual holding
or incoming shares after claim must not leave a proven completed redemption
stuck. Refresh/update the residual position rather than removing its entire
cache row. Keep existing full-redemption behavior; add partial/residual and
incoming-after-claim fixtures for postconditions and frontend cache effects.

### Resolution and indexing

- Normalize V2 Gamma `resolutionStatus` (`inactive`, `active`, `resolved`);
  retain v1 UMA status. Proposed/disputed legacy states must not be invented
  for V2 or inferred from a price sentinel.
- Read balances from the ledger of each binding. Old CTF zero does not mean a
  PositionManager holding vanished. Partial/error/dust-filtered Data API pages
  are never complete evidence for flattening holdings.
- Index PositionManager ERC-1155 `TransferSingle`/`TransferBatch`, including
  mint/burn, with ledger/chain/transaction/log identity and reorg-safe replay.
  Exchange/Router/module events add operation attribution, not a second balance
  credit. Protocol unsafe transfers/mints do not invoke receiver callbacks;
  callback hooks cannot be the sole deposit/position detector.
- Native Binary/NegRisk conditions have no legacy `ConditionPreparation` event.
  Combo and registration events have their own context. Keep module type and
  condition/event binding; a legacy CTF event parser cannot discover all V2.
- Resolution payout vectors use PPM (`1_000_000`). Combo settlement depends on
  underlying legs, not an assumed standalone legacy resolution event.
- Native NegRisk derived NO/Other resolution differs from registered legacy
  migration: registered real conditions use CTF-backed resolution evidence.
  Do not synthesize their NO outcome from another native sibling event.

### Optional features are not prerequisites

Old holdings remain CTF until an explicitly authorized migration. Legacy
conditions/events first require protocol registration. Preserve source receipt,
mapping and destination receipt if implementing conversion later; do not replace
historical ledger IDs in place or offer conversion solely from title matching.

AutoRedeemer is not magic scheduling: the pinned `redeem` is `onlyOperator`,
consumes the holder's full approved balance and returns pUSD to that holder.
Approval alone does not prove an operator will redeem. Do not auto-grant it,
promise automatic redemption or count its event twice. Hunch's normal durable
redemption remains the initial supported path.

Sources: [Router.sol](https://github.com/Polymarket/polymarket-v2-external/blob/741f8bbe88c3f29a1c55d1248a3dd411f622f111/src/routers/Router.sol),
[PositionManager.sol](https://github.com/Polymarket/polymarket-v2-external/blob/741f8bbe88c3f29a1c55d1248a3dd411f622f111/src/positionManager/PositionManager.sol),
[position data](https://docs.polymarket.com/resources/onchain-position-data),
[position lifecycle](https://docs.polymarket.com/trading/positions/how-positions-work).

## 8. Data API V2 adapter: required independently

Use explicit `/v2/...` paths on the existing Data API host. Setting a base URL
to `.../v2` is insufficient: existing `new URL("/positions", base)` discards
that path. One side-effect-free DTO/pagination adapter should serve positions,
holders and public trades; never change financial authority to floating-point
Data API values.

Current direct consumers found: `services/positions-sync.ts`,
`services/holders-core.ts`, `routes/trades.ts`. Price history currently uses
`services/polymarket-client.ts` on the CLOB host; migrate the documented new
history route separately rather than blindly changing every CLOB URL.

| Existing read                                                   | V2 replacement / important difference                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/positions`                                                    | `/v2/positions`, `data[]`, snake-case, cursor; current holding is `current_size`                                             |
| `/closed-positions`, `/market-positions` if added/used in tools | Same `/v2/positions` with documented status/scope; not separate old routes                                                   |
| `/holders`                                                      | `/v2/holders`, `data[{token_id,holders[]}]`; `condition`, `min_balance`, `include_pnl`                                       |
| `/trades`                                                       | `/v2/trades`, `condition`/Gamma `event_id`, cursor; `token_id`, `transaction_hash` and seconds timestamps                    |
| CLOB `/prices-history`                                          | Data API `/v2/prices-history`, `token_id`, seconds/bucket options, cursor envelope                                           |
| Optional aggregate/profile reads                                | `/v2/value`, `/v2/user-pnl`, `/v2/user-stats`, `/v2/user-volume`, `/v2/leaderboard` and documented V2 activity/volume routes |
| `/v1/accounting/snapshot`                                       | No V2 counterpart; explicitly excluded from retirement, do not remove                                                        |
| Freshness                                                       | `/v2/status`, serving/custody lag and computation time; not order settlement authority                                       |

### Pagination and failure behavior

Follow opaque `pagination.next_cursor` until null, not offset arithmetic or
short-page inference. Resend identical scope/filters; some endpoints bind the
cursor and reject changed parameters. Positions/trades/activity use keyset
pagination; holders/leaderboards can still have offset-based walk semantics
inside the opaque cursor and are not atomic historical snapshots.

Bound total pages/time, detect repeated cursors, deduplicate at the endpoint's
real row grain and report incomplete snapshots. Preserve the last complete
snapshot when a later page fails; never treat incompleteness as zero balances.
`filter_amount=0` is needed where complete inventory is intended; default 0.1
dust filtering is not complete holdings evidence. Request `include_archived=true`
where applicable to open/redeemable inventory; CLOSED does not accept that flag.
Even with the flag, **inactive markets are excluded**. A complete cursor walk is
therefore a complete API projection, not a complete wallet ledger. Preserve
known archived/inactive holdings/economics and use direct, generation-correct
on-chain balances for disappearance/spendability evidence. Do not zero their
cost basis merely because a Data API row was omitted. Condition lists allow at most
20 distinct IDs; `include_pnl=true` holders requires one condition and limit at
most 100 (without it, limit at most 1000).

Keep Hunch's internal offset pagination for local DB reads. For public trade
read-through, add an optional upstream cursor to the Hunch response/query and
frontend consumer, retaining existing offset clients on the bounded local
repository path. Do not translate a deep UI offset into an unbounded series of
HTTP calls; do not pass `offset` to V2 (observed 400). The current upstream-first
branch in `routes/trades.ts` must change, not just its field parser.

Handle typed error `code/retryable/trace_id`, 429 `Retry-After` and bounded
dependency retries. Empty success, delayed enrichment, stale projection and
unavailable upstream are different states. Partial market metadata must not
create a fabricated zero position, zero PNL or unsupported outcome side.

### Economics and holder semantics

Actual live Position fields include `current_size`, `total_size`,
`entry_cost_usdc`, `entry_fees_usdc`, `total_cost_usdc`, `current_price`,
`current_value`, `realized_pnl`, `unrealized_pnl`, `total_pnl`, `percent_pnl`,
`percent_realized_pnl`, `status`, `redeemable` and `negative_risk`.

- `total_size` is lifetime bought quantity, **not** the current balance.
- `entry_cost_usdc` excludes fees; `total_cost_usdc` equals entry cost plus entry
  fees. Fees are a disclosure field, not permission to subtract them again from
  served PNL columns.
- `unrealized_pnl = current_value - entry_cost_usdc`; `total_pnl = realized_pnl +
unrealized_pnl`. Compare Hunch's explicit accounting basis/periods before
  replacing its portfolio metrics. This is not a mandate to rewrite its ledger.
- `percent_pnl` is the unrealized fee-exclusive return. Despite its name,
  `percent_realized_pnl` is a compatibility expression involving current value
  and lifetime size/average price, **not realized return on cost**.
- Default holders are NET across outcomes. For Hunch's current per-side gross
  holder research, use `include_pnl=true`, parse nested `proxy_wallet`, `amount`,
  `outcome_index`, `token_id` and nullable economics. Choosing NET accidentally
  changes rankings/evidence; it is not merely a field rename.
- `outcome_index=999` means unknown even if a human outcome label is present;
  verify with the canonical asset pair, never convert 999 to YES/NO by truthiness.
- `OPEN` can include `REDEEMABLE`; a held loser can be redeemable with zero value.
  Redeemable is not won. API token IDs do not include a guaranteed protocol
  generation field: join their immutable market/ledger binding.
- History timestamps and bucket sizes are seconds; end bounds are exclusive.
  Do not map old fidelity-in-minutes directly to seconds, interpolate empty
  coarse history as zero, or reject the live current-point
  `resolution_seconds=0` without the documented point semantics.

History compatibility needs an explicit window adapter. Current
`polymarket-client.ts:449–474` fetches upstream `interval=max` then slices to
Hunch's requested start/end locally; it does not currently send those absolute
windows upstream. V2 explicit `start/end` spans are capped at **15 days**. Keep
full-life/long-range charts on `max/all` with the documented permanent coarse
grain (3h/12h); finer `max/all` requests cover only 30 days. Use bounded fixed
absolute windows no wider than 15 days for requested recent detail, with a grain
whose retention actually covers the window. Do not blindly forward 1M/MAX Hunch
windows or silently replace full history with 30-day fine history.

Complete cursor paging and local slicing must preserve sparse timestamps,
exclusive end bounds and a possible non-bucket-aligned terminal point. Resolved
settlement points use resolution_seconds 0 and appear on the final page; merge
overlapping coarse/detail data without duplicate terminal points. Add full-life,

> 15-day, recent detail, resolution-final-page and expired fine-grain fixtures.

The official unified SDK supports Data API V2 from 0.10.0 and the protocol V2
guide requires 0.12.0 for its illustrated unified-client operations. Hunch's raw
adapter remains valid if it satisfies these contracts. PolyBolt/reference-price
feeds are separate from CLOB books/user order streams; no existing RTDS client
was found in the inspected `apps/` and `packages/` source.

Sources: [live OpenAPI](https://data-api.polymarket.com/v2/openapi.json),
[Data API overview](https://docs.polymarket.com/api-reference/data-api/overview),
[Data API migration](https://docs.polymarket.com/migrate/data-api-v1-to-v2),
[price-history contract](https://docs.polymarket.com/market-data/prices-order-books),
[unified SDK migration](https://docs.polymarket.com/migrate/clob-sdk-to-unified-sdk).

## 9. Read-only verification evidence

Public response `Date` headers below are UTC on October 5, 2026. Observations
are samples, not a complete inventory of production markets/accounts.

| Time        | Probe                                               | Actual result / what it proves                                                    |
| ----------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| 16:59:38    | CLOB `/version`                                     | 200, version 2; service version only                                              |
| 16:59:39    | Latest 100 open Gamma markets                       | 200, all explicit v1; no V2 execution fixture obtained                            |
| 17:01:18    | Volume sample with `version=v2` query               | 200, still 100 v1; undocumented query cannot be used for V2 filtering             |
| 17:14:53    | Top-volume 100 open markets                         | 200, all v1; not proof that all Gamma markets are v1                              |
| 16:59:39    | Data API `/v2/status`                               | 200; computation 16:59:18, age 20s, serving/custody lag 1 block                   |
| 17:01:18    | `/v2/positions` public sample                       | 200, snake-case/data/pagination; held redeemable losers observed                  |
| 17:01:19    | `/v2/positions` with `offset=0`                     | 400 `invalid_request`, retryable false; cursor-only contract                      |
| 17:01:18    | `/v2/trades?limit=2`                                | 200; outcome_index 999 observed, not automatically YES/NO                         |
| 17:04:36    | Legacy asset `/book`                                | 200, min_order_size 5, tick .01, correct condition/asset                          |
| 17:04:36    | Same asset `/fee-rate`                              | 200, base_fee 1000; not a complete fee-schedule calculation                       |
| 17:04:36    | `/v2/resolutions`                                   | 200, proposed state; price sentinel `69` is not a resolved probability            |
| 17:04:36    | `/v2/prices-history`                                | 200, current point includes resolution_seconds 0                                  |
| 17:14:53    | `/v2/holders`, include_pnl true                     | Nonempty, two token groups; nested holder snake-case/nullable economics confirmed |
| 17:15:29    | Two consecutive positions pages for a public holder | 200 both, one row each, cursor continuation works; no user profiles persisted     |
| 17:02:52    | Code at seven new proxy addresses                   | All 61 bytes; proxy code present, not proof of identical implementation           |
| 17:04:33    | ExchangeV3 `domainSeparator()`                      | Matches local EIP-712 version-3 domain                                            |
| 17:12:28–29 | PM collateral / Exchange and Router manager getters | Published pUSD and PositionManager addresses match deployed configuration         |
| 17:14:15    | PM `moduleById(uint256)` for 1/2/3                  | Published Binary/NegRisk/Combo addresses match                                    |
| 17:14:15    | V3 `hashOrder(Order)` for unsigned synthetic order  | Exact match with local ethers eleven-field typed hash                             |

Additional deployment checks at 17:28:42–43 UTC: EIP-1967 implementation slots
for PositionManager, ExchangeV3 and Router matched the published implementation
addresses. `getOrderStatus` for the deliberately unsubmitted synthetic hash
decoded as `filled=false, remaining=0`. This is an ABI check, **not proof of
failure, cancellation or absence of a broadcast** for a real order; reconciliation
must retain its existing multi-source evidence requirements.

Offline checks using the current pure Hunch signing schema also passed: official
ORDER_TYPEHASH, V3 golden hash, domain2/domain3 separation, right-padded bytes31
Router encoding for outcomes 0/1 and maximum uint256 round-trip. These verify
documentation assumptions; they are not tests of an implemented migration.

Public legacy fixture for read/parser tests:

- Gamma market `5331723`.
- Condition `0xdaeb69f6671cc915dc6ee135786cd95b7131890283d3f947d11a2e77379f50e5`.
- First asset
  `113370520490507646250500701219384673009095163173294222529417095958546047347489`.
- Populated holders sample: Gamma market `2063134`, condition
  `0x7d0aaf81bbd3fd73b6a1651cce08a452c0cbf9c0cbb4520ce0f981065b639d88`.

Verified domain separator:
`0x466c63910185bbd55e8679264200c4e0abdcbb0c6264eb3d41d13326022e095b`.
Synthetic golden order: salt 1, maker/signer zero address, asset 1, maker amount
1,000,000, taker amount 2,000,000, BUY 0, signature type 3, timestamp 1791220000,
zero metadata/builder, empty ABI signature. It is intentionally **not a valid
trade**. Typed hash and deployed view result both equal
`0x529d440652102e5d9aea11536d90c0a43148fc1dc7e80c525de83cd0cfe14040`.
ORDER_TYPEHASH in the pinned source:
`0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589`.

Probe limitations: a larger public RPC batch timed out; corrected smaller calls
succeeded. Initial selectors omitting ABI `signature` or using `moduleById(uint8)`
reverted; verified ABI is the full Order tuple and uint256 module getter. An
alternate public RPC returned disabled-tenant HTTP 401. These are not evidence
of a Hunch production RPC outage. Authenticated CONDITIONAL-V2 balance-cache
requests, live V2 order acceptance, wallet signing/relayer acceptance and
settlement were not executed under the read-only scope.

## 10. Sequenced implementation and acceptance

### A. Data API compatibility first

Create pure V2 DTO/pagination adapters and fixtures for the observed envelopes,
nested holders, nulls, economics, cursor-bound scope, unknown outcomes and
failure-after-first-page. Integrate positions enrichment, per-side holders,
public trades/cursor transport and history. Preserve old Hunch API consumers
with additive fields; compare normalized old/new reads read-only before enabling
V2 consumers. Do not claim equal rankings without choosing the same GROSS grain.

Acceptance: complete/partial inventory distinction, no PNL double fees, no
disappearing dust, no deep-offset HTTP fan-out, and no remaining retired route
in active consumers. This phase can ship before V2 trading.

### B. Market identity and durable context

Normalize explicit generation once; extend Gamma business projection and
bootstrap/refresh/hot paths. Add durable historical bindings and execution
context, preserve current subscription mapping and historical asset references.
Make quote/max-spend/market-info/contracts additive, then regenerate frontend
OpenAPI. Test generation-only transitions in the optimized bulk writer.

Any SQL/migration needs actual disposable PostgreSQL parsing/execution on the
deployment's major version, representative legacy rows, read-only scope/perf
facts, index plans and retention protection. No assertion/RAISE gate on malformed
historical rows: deployment stops services before migration, so a data-dependent
failure would be an availability incident. No SQL was created in this research.

### C. Approvals, signing, execution and recovery

Extend the shared domain registry, server verification, account/readiness and
worker config. Introduce narrowly scoped V3 policy profiles without replacing
V1 authorization. Freeze context in order rows/attempts/fingerprints before
submission. V2 CLOB balance type and PM SELL transfer/approval use the same
context. Preserve ambiguous recovery, exact receipt accounting and fee safety.

Acceptance: V1 and V2 independent hash/domain fixtures; signature2/3 routes;
market change between quote and submit safely returns to editing **before**
submission; old order reconciliation does not change domain; cancelled wallet
signature releases only provably unsent work; timeout cannot duplicate orders.

### D. Holdings, redemption, intel and public propagation

Partition ledger reads; add V2 normalized position-action planning and generation
resolution mapping within the one generation-aware Polymarket registry entry.
Freeze the action's ledger/context and extend canonical receipt and
missing-submission attribution, including legacy snapshot compatibility.
Add PM/Router/module event fixtures with exact zero/positive
payout evidence and reorg replay. Extend builder emitter attribution, PNL marks,
holder fallbacks, cluster execution verification and matching evidence.
Use existing desktop/mobile/MiniApp funding/trade/redemption shells.

Acceptance: mixed portfolio/account values, winner/loser/partial redemption,
historical CTF history intact, no double-counted fills/transfers/rewards, no
fabricated zero holders or price marks from unsupported ledgers.

### E. Authorized staging and rollout, separate from this research

Public read-only verification is necessary but cannot prove a signed purchase.
Before enabling V2 execution, obtain one explicitly versioned live/test fixture
and perform authorized acceptance of BUY/SELL/cancel/redeem through actual
supported Safe/Deposit Wallet paths. Verify CONDITIONAL-V2 credential behavior,
exact Privy/relayer acceptance, canonical position/cash receipts and recovery.
Do not label an unsupported V2 market executable until those capabilities exist.

Roll out V2 capability narrowly by generation without switching off CTF; observe
model-independent trade outcomes, fees, funding continuations and scheduled
indexer/reconciliation logs. Rollback disables new V2 submissions, not settled
holdings, history, cancellations or reconciliation of submitted V2 work. Data
API v1 is not a lasting rollback option after its retirement.

### Regression suite

- Indexer Gamma/schema/mappers/bootstrap/upsert telemetry; raw generation-only
  changes; real PostgreSQL canonical-token sync/history/retention fixtures.
- Quote/order-execution/max-spend/minimum/post-only tests for both generations;
  FOK below book share minimum remains valid under existing rules.
- Hash/embedded/ERC-7739/ClobAuth/Batch fixtures; domain2 and domain3 independent;
  wrong ledger/domain/exchange/collateral fails before signature/submission.
- Policies/delegated signing/sponsorship exact scopes; prepared existing wallet
  can acquire missing V3 capability without losing legacy capability.
- Funding lifecycle/receive/withdraw/conversion/Relay receipt/shortfall/MAX/Half/
  Reduce; wallet cancellation, partial funding then definitive order rejection,
  late signature, lost response, leases and reload recovery.
- Legacy and V2 redemption/position-actions; resolved zero versus unresolved;
  bytes31 padding, outcome0/1, PM balances; no repeat redemption after completion.
  Include mixed-generation reload, missing hash/report, changed global defaults,
  partial consumption/residual cache, incoming-after-claim, legacy snapshots and
  unrelated successful zero-payout txs.
- Position sync/intel/research/PNL/canonical marks/fees/rewards with mixed ledgers;
  all cursor pages, partial pages, archived/inactive omissions, null economics,
  dust and outcome999; missing projection rows never flatten actual holdings.
- WebSocket asset versus condition IDs; books/top/prices/history/SSE, cancellation
  and delayed fills; stable market/position/share IDs and Jev matching semantics.
  Include >15-day/full-life charts, recent detail, sparse/expired fine-grain data
  and final-page resolution points without duplicated endpoints.
- Frontend desktop/mobile/Telegram MiniApp; managed bot policy and interactive
  handoff have separate capability/consent checks.

Run targeted suites, TypeScript/lint, **full backend workspace build**, and the
actual frontend deploy-equivalent build. API-only typecheck or old-SDK signature
parity is not deployment GO. Compare representative read-only historical outputs
and real SQL plans; do not promise zero regressions from this documentation.

## 11. Readiness and resolved decisions

Architecture decisions are explicit: preserve legacy CTF; keep common pUSD and
funding framework; keep existing supported wallets/credentials; use one
generation resolver and frozen durable context; separate Data API V2; preserve
historical bindings; use normalized position-actions for redemption; do not
bundle optional auto-migration/combo/operator-service features.

Remaining work is **implementation and execution acceptance**, not an unresolved
choice of domain, contracts, IDs or cash rail. No authentic V2 Gamma market was
obtained in the bounded samples, and read-only probes cannot verify signing,
relayer permission or fills. Those limitations must not be hidden behind a GO.
The documents can be committed after review; product migration/deployment is
not ready merely because the documents are complete.

Research validation completed: a fresh history-free reviewer checked both plans
against source and official documents, then verified corrections; a separate
backend source-level reviewer also returned documentation GO. Closed findings
cover the single-driver/frozen-ledger redemption contract, canonical zero-payout
and lost-reference proof, partial/residual completion, archived/inactive API
omissions and long-range chart compatibility. Scoped Prettier, Markdown lint and
workspace companion-link checks passed. The full frontend Markdown command has
one existing `AGENTS.md:398` MD025 error, unrelated to these documents. No
product build or regression suite was run for this documentation-only change.

## 12. Implemented package and acceptance boundary

Implementation verification: 2026-10-05, backend `polymarket-v2` based on
`2ade5f71c3131a6b758c24e308dd4e8ddd11f571`. No commit, push, deployment,
production mutation, new permission grant or real financial action was made.

| Area               | Local implementation                                                                                                                                                | Evidence                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Identity/indexing  | Shared closed registry and packed IDs; explicit generation; immutable historical bindings; current projections serialized under market locks                        | Protocol/mappers tests; real PG16 transition, retry, collision and concurrency fixtures                                      |
| Storage/retention  | Migrations 0270/0271; independent position ledger; frozen context; retention protected references                                                                   | Unmodified migrations on legacy/malformed optional rows; legacy uniqueness preserved and PM collision allowed                |
| Quotes/orders      | Context before funding/signing; domain 2/3 and balance type; signed amount checks; durable payload/hash/recovery context                                            | Quote/minimum/max-spend, execution/hash, funding and prepared-order regression groups                                        |
| Wallet setup       | Generation/action-specific allowance/operator reads; exact V3/PM approval validation; selected-generation Privy coverage; no direct Deposit Wallet execute fallback | Embedded signer/sponsorship tests; legacy policy fails V3 and V3-only policy fails legacy                                    |
| Holdings/intel/PNL | Complete per-ledger RPC reads; canonical frozen outcome marks; mixed holdings aggregated without erasing their asset provenance                                     | PG16 mixed-ledger snapshot, metrics, fill reconstruction, lock and PNL fixtures; incomplete read preserves previous snapshot |
| Redemption         | Exact positive Router amount; module result/payout; PM consumption and pUSD mint evidence; canonical bundle/recovery; legitimate residual allowed                   | PG16 real runtime/observer fixtures, legacy replay, zero payout and exact bundle attribution                                 |
| Fees/notifications | Selected order emitter; frozen ledger in order notification; exact position UUID/ledger in redemption notification                                                  | Builder-fee units, actual verifier/notification SQL on PG16, position-action effect replay                                   |
| Data API           | Bounded complete cursor walks; OPEN/archived holdings; GROSS holders; cursor trades; bounded history windows and terminal points                                    | DTO/envelope/cursor/partial-read/holder/trade/history fixtures based on public response contracts                            |
| Frontend           | One domain/signing builder; pre-sign/refreshed-context checks; correct SELL ledger; ledger-aware optimistic/average/removal caches; additive API fields             | Frontend tests, TypeScript/lint and diagnostic webpack build; see build limitation below                                     |

Full backend workspace `build` and `lint` passed (16 build tasks, 15 lint
tasks), including preview and integration-fixture TypeScript. No package or
lockfile was changed. The local pnpm workspace emits a pre-existing installation
structure warning; no dependency installation/purge was attempted. This proves
the build with available dependencies, not a clean lockfile installation.

Backend regression runs passed 146 selected groups plus 85 Node tests:
Polymarket, positions, funding/Relay/EVM/Solana, trading, public trades, intel,
notifications and embedded Ethereum. Indexer mapper tests passed independently.
Frontend passed 1,633 tests in 269 files, TypeScript and full lint. These are
the actual tested scopes, not a claim that every repository integration suite
or every browser/wallet interaction ran.

Eleven PostgreSQL 16 integration groups passed across the final runs: asset
bindings, position ledgers, V2 redemption runtime, legacy position-action
persistence, SQL scale, Telegram consent/lifecycle/market/custom input/direct
claims and public trade routes. Two older SQL suites with their own fixed-name
disposable databases also passed in the regression run; their guards were not
weakened. Test runtime settings disable background reconciliation, Redis and
separate content pools for the public trade route fixture.
The SQL-scale fixture uses 100,000 bindings and 50,000 markets in a rolled-back
transaction. Exact binding lookups use indexes; the three-holding mark query
uses indexed bindings/markets. Observed execution was roughly 0.01–0.15 ms on
this local fixture, **not a production latency guarantee or an audit of every
existing SQL path**. The two-row token projection can appropriately use a scan.

The completion audit also closed two additional propagation gaps: generated
frontend OpenAPI request types were refreshed from the real local route schemas
without invoking route handlers/background jobs (unrelated path declarations
were mechanically checked unchanged), and authenticated Portfolio/Telegram
metadata now uses a bounded batch of frozen position contexts rather than a
token-only join. A colliding CTF YES / PM NO retains two independent market
entries and live-cache identities. `priceTokens` identifies the current
underlying-outcome tick without replacing the historical trading token pair.
Missing Polymarket metadata does not remove a positive holding from the API.
Real PG16 metadata/mapper fixtures and frontend SSE/cache tests cover this case.
On the same 100k-binding/50k-market local fixture the new three-context metadata
query used index lookups and executed in about 0.3 ms; this is not production
scale proof for unrelated inherited joins.

The focused historical Telegram SELL/handoff propagation audit is closed locally:
an owned Position UUID resolves its canonical frozen context, selected token and
side. Quote, persisted preview, restored Buy/Sell intent, sealed plan, frontend
continuation, signer and submit carry that identity. A token-only historical
replacement or contradictory market/side/context is rejected before signing.
Reviewed readiness and repair select the same generation without adding a second
SELL quantity/balance gate; a market-only readiness target derives NO from its
frozen context instead of silently defaulting to YES. SELL capacity claims are
ledger-scoped, while legacy CTF claim/lock semantics remain unchanged.

PG16 fixtures cover private owner/wallet/market binding, colliding CTF/PM IDs,
independent claim capacity, idempotent retry and scope mismatch rollback. Unit
fixtures round-trip the frozen preview/plan and test malformed context, NO
readiness and legacy plans without the new field. Public single-token metadata
accepts an optional serialized context only after validating the canonical DB
binding; its generated API field and frontend query/cache key were updated
without changing unrelated path declarations. These are local contract/state
tests, not evidence of actual wallet, CLOB or relayer acceptance.

The pinned PositionManager source inherits Solady ERC1155: ordinary safe transfer,
balance and operator APIs remain inherited. Protocol mint and explicit unsafe
transfer paths omit receiver callbacks but emit TransferSingle/TransferBatch.
Do not mistake this for removal of every inherited safe-transfer selector.
See the [pinned PositionManager implementation](https://github.com/Polymarket/polymarket-v2-external/blob/741f8bbe88c3f29a1c55d1248a3dd411f622f111/src/positionManager/PositionManager.sol).

Frontend standard Turbopack builds on available Node 26.8.1 and bundled Node
24.19.0 fail with an environment `EPERM` when a CSS/PostCSS worker creates a
process/binds a port. Node 26 webpack compilation/prerender/build completed;
its transitive Privy optional-module and dynamic-require warnings are not proof
of new migration failure. The user chose available Node verification without
downloading Node 20. The actual Node 20/Turbopack deploy build therefore remains
unverified; neither webpack success nor unit tests are a deployment GO.

The authenticated CLOB `CONDITIONAL-V2` call, actual V2 Safe/Deposit Wallet
signature/relayer acceptance and BUY/SELL/cancel/redeem settlement still require
separately authorized live acceptance. No authentic V2 Gamma fixture was found
in bounded public samples. Synthetic IDs and unsigned on-chain hash equality
are not evidence of venue order acceptance. Existing external policies/relayer
allowlists were not expanded; a policy without V3 remains legacy-only.

Current frontend/backend combinations fail closed for an explicit V2 submit
without validated context. Legacy orders lacking context keep their historical
CTF namespace/hash semantics. An ambiguous broadcast must not be re-signed or
revived by this migration. MAX remains a cached account estimate, not execution
authority; the fresh quote/context and raw financial bounds are rechecked
before funding/signing. No migration-specific auto-funding or hidden input
increase was introduced.

The primary implementation was reviewed against these invariants and corrected
iteratively; the independent reviews cited in section 11 were documentation
reviews only. Do not describe them as fresh independent implementation GO.
Commit/readiness review must include all added files, not only `git diff` of
tracked files. A final execution GO requires the outstanding build and live
acceptance checks above, with no implicit authorization for funds or policies.
