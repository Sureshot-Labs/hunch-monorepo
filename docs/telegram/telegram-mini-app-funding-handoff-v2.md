# Telegram → Mini App trade handoff v2

## Purpose

`handoff_th1_…` is a one-time, user-bound Telegram start parameter. New
handoffs use one generic contract (v2). A Buy may enter the existing funding
flow; a Sell is always a direct, client-signed venue trade:

```text
Telegram Review with sealed Confirm link
  → opening Mini App atomically claims the exact trade consent
  ├─ Buy with shortfall
  │   → bounded funding-source scope → generic FundingPlanningRuntime
  │   → Mini App action prepare/report loop → consumer reservation
  │   → fresh Buy quote and continuation
  └─ direct Buy or Sell
      → ordinary signed venue consumer → reconciliation
```

There is no second funding planner and no second operation state machine.

## Rollout gate

The `signal_bot` runtime policy controls both the delivery choice and the
client protocol:

- `miniAppHandoffMode`: `off | fallback | always`;
- `miniAppHandoffContractVersion`: `1 | 2` (default `1`).

- A v2 handoff requires both version `2` and a non-`off` mode at each
  materialization boundary. The backend issues it while rendering the exact
  Review. `resolve` and `projection` are read-only; opening the Confirm link
  leads to `claim`, which atomically records consent on the bound trade intent
  and performs `issued → claimed`. A policy below version `2` emits no new
  handoff.
- The old v1 API is retained only to read and safely finish rows issued before
  v2 existed. It is not a frontend integration target and the bot never mints
  a new v1 token.
- Enable only after the frontend has shipped the v2 branch below and an
  end-to-end smoke has covered a client-signed route.
- The gate affects v2 plan selection and materialization only. It does not
  broaden a Privy policy or enable unattended server-side Solana execution.

The v2 handoff deliberately does **not** inherit the narrower direct-bot / Privy
automation cap. It may carry any Buy up to the Hunch runtime policy's
`maxTradeAmountUsd`, provided the user confirms its sealed quote and source
caps. The direct server path remains limited by its exact Privy envelope.
Sell has no Buy USD cap or funding policy: it seals exact shares and a quoted
proceeds value. That value is a provider-enforced lower bound only where the
venue payload supports one; Limitless CLOB FOK presents it as an estimate.
Both are client-authorized paths, not ways to widen unattended authority.

## Capability vocabulary

These are mutually exclusive delivery results for a concrete funding plan;
they are not venue/chain booleans.

| Result             | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `server_bot_exact` | Existing delegated bot envelope can perform this exact route.                                          |
| `web_funding_plan` | Generic plan is fully executable by Mini App contract v2.                                              |
| `external_deposit` | A user must make an external receive/deposit transfer; it remains interactive and does not auto-close. |
| `unavailable`      | No safe current route.                                                                                 |

For contract v2, the backend admits only a server-produced generic plan whose
destination is Polymarket or Limitless, whose sources are owned by the same
user, and whose user actions are all one of:

- `evm_transaction`
- `evm_transaction_batch`
- `svm_transaction`
- exact Polymarket Deposit Wallet `external_handoff`

`signature` is intentionally unsupported until a named, audited executor
exists. Kalshi is unavailable: its current web consumer does not accept a
`FundingConsumerReservation` and no funding destination adapter is active.

## Sealed v2 snapshot

`telegram_app_handoffs.plan_snapshot` remains the existing JSONB column. The
raw `th1_` token is stored only as a hash. A funding v2 snapshot has:

```ts
{
  version: 2,
  executionContractVersion: 2,
  kind: "funding",
  trade: { /* exact Telegram intent and economic bounds */ },
  funding: {
    discoveryRequest: FundingDiscoveryRequest,
    fundingPolicyRevision: string,
    destination: {
      venueId: "polymarket" | "limitless",
      destinationOptionId: string,
      venueBindingId: string,
      venueBindingOptionId: string,
      controllerWalletId: string,
      requiredAsset: AssetRef,
      topology: string,
    },
    sourceDebits: [{
      sourceFingerprint: string,
      locationId: string | null,
      asset: AssetRef,
      maximumRaw: string,
    }]
  }
}
```

For a Buy whose destination already has enough executable balance, or for any
Sell, `kind` is `"direct_trade"` and the snapshot has only the versioned trade
scope. A direct Buy seals `amountUsd`, `maxSpendUsd`, and optional
`minReceiveShares`; a Sell seals `sharesRaw` and its quoted
`minimumReceiveRaw`, plus the same exact controller, venue, market, outcome
token, side, and slippage. The latter is enforced as a minimum receive only
where the venue order/transaction supports it; Limitless CLOB FOK treats it as
an estimate. A Sell never has a funding operation, source debit, or
reservation. This is the same sealed handoff contract, not a fallback to v1.

It never contains calldata, a signature, a raw funding consent token, or a
provider quote reference. On materialization the backend plans again and may
choose a different combination of only the sealed source fingerprints. Every
committed reservation is rechecked against its sealed source asset, location
when applicable, and raw cap. A new wallet, asset, network, destination
topology, policy revision, or cap needs a fresh Telegram Review.

## Backend endpoints

All requests include the existing authenticated `initDataRaw` and `th1_`
`token`. Telegram init data, the start parameter, linked Hunch user, and
Telegram user must agree.

1. `POST /telegram/app-handoffs/resolve`
2. `POST /telegram/app-handoffs/claim`
3. `POST /telegram/app-handoffs/commit` with the sealed `planFingerprint`

The Review's `Confirm Buy` or `Confirm Sell` button opens this handoff
directly. There is no intermediate Telegram callback or `Continue in Hunch`
card. For v2, `claim` is the consent boundary: in one transaction it verifies
the immutable plan/quote against the still-current Review, records the consent
without changing the trade status, and changes the handoff from `issued` to
`claimed`. The following idempotent commit attaches the execution marker and
moves the intent to `funding` or `external_handoff`; there is no half-committed
Buy or Sell state. Server-executed trades keep their existing Telegram callback
Confirm and never enter this path.

If Telegram delivery is interrupted after issuance, a reopened bot market card
must not expose the `issued` token behind a generic Continue button: opening it
would itself record consent without displaying the sealed economics. The card
shows `Restore Review`, and that callback rebuilds the exact Review from the
persisted plan and quote. Generic Continue/resume links are valid only after
the handoff is already `claimed` or `committed`.

For v2, `commit` atomically commits the generic funding operation and returns:

```ts
{
  handoff: TelegramAppHandoff,
  execution: {
    kind: "client_execution_required",
    requiredContractVersion: 2,
    handoffId: string,
    fundingOperationId: string,
  }
}
```

For `kind: "direct_trade"`, `commit` instead records the one-time handoff
commit and returns `direct_trade_continuation_required` with the handoff ID,
plan fingerprint, and trade-intent ID. There is no funding operation to
prepare or poll.

The operation idempotency key is
`telegram-app-handoff:<handoffId>:funding`. A retry or two tabs receive the
same operation; the intent is attached through the same transaction as the
commit. `POST /telegram/app-handoffs/execute` returns the same envelope shape
`{ handoff, execution }` while client funding is pending and **never** replays
the Telegram callback. Once the operation has a canonical ready consumer
reservation, it atomically attaches that reservation to the original intent
and returns this `execution` value:

```ts
{
  kind: "trade_continuation_required",
  fundingOperationId: string,
  fundingReservationId: string,
  handoffId: string,
  requiredContractVersion: 2,
}
```

The existing venue trade endpoint validates that reservation against the
stored market/outcome and exact maximum spend before it can submit an order.
Once that ordinary web consumer persists its order/execution, the shared
consumer boundary atomically links its generic `funding_trade_attempt` back to
the original Telegram intent and consumes the reservation. A later
`/execute` returns `trade_continuation_in_flight`, never the earlier funding
action again. Terminal intent states return `trade_terminal`; neither result
can authorize a second Buy.

`POST /telegram/app-handoffs/projection` is read-only and cannot materialize
funding. For v2 it returns the authoritative current intent projection
(`attaching`, `funding`, `submitting`, `reconciling`, or terminal), including
the attached operation/order references. `resolve` remains the source of the
sealed handoff snapshot; projection is the source of runtime state.

The v2 quote is owner-scoped with immutable `commit_scope`:

```ts
{
  kind: "telegram_app_handoff_v2";
  handoffId: string;
  tradeIntentId: string;
}
```

It cannot be committed from the public generic funding endpoint. The direct
trade branch has no funding quote or operation to commit.

## Enablement contract

New handoffs have one target contract: **v2 only**. V1 stays readable solely
so that a token issued before the v2 rollout can finish safely; it is neither
a feature flag nor a second implementation to test or extend.

The ordinary Polymarket and Limitless CLOB paths, plus the Limitless AMM
broadcast path, accept the same sealed direct-trade binding. The exact public
fields are deliberately explicit so the Mini App cannot mistake this for a
funding reservation:

```ts
{
  telegramAppHandoffId: handoffId,
  telegramAppHandoffPlanFingerprint: planFingerprint,
}
```

It must validate the same user, handoff state, venue, market, side, and sealed
source limits: maximum spend for Buy, or maximum shares for Sell. It also
enforces a provider-supported receive floor where one exists. Limitless CLOB
FOK is the explicit exception: it has immediate-or-no-fill semantics but no
provider-enforced price or receive floor, so it spends/sells the sealed source
amount at the current venue price or does not fill. In the _same
database transaction_ that persists the resulting order or execution, it must
advance the original `telegram_trade_intent` to the matching submitted or
terminal state. A replay must return the already-persisted result and cannot
create another order.

That is the direct-trade analogue of the existing funding-reservation consumer
bridge. It does not create a funding operation, reservation, second planner or
second trade state machine. It simply gives the standard web trade a durable
reference to its exact Telegram consent. Before the provider request, the
order endpoint atomically claims the handoff intent; a direct Sell claim also
serializes the exact wallet/outcome debit and counts earlier unpersisted Sell
claims. After it persists the ordinary order, the same transaction records the
order ID on that intent.

After the v2 Mini App consumer is present, enabling the feature is only a
runtime-policy change:

1. Deploy the backend, including migration `0228_telegram_app_handoff_sell_execution.sql`.
   It replaces the intent-delivery and handoff-lifecycle write constraints and
   the lifecycle guard function, all as `NOT VALID` write checks: direct v2
   Sell is valid, while Sell with funding/reservation or v1 remains impossible.
2. Ship the v2 Mini App consumer and verify one direct Buy, one direct Sell,
   and one client-funded Buy end-to-end.
3. Set `miniAppHandoffContractVersion: 2` and choose
   `miniAppHandoffMode: fallback` or `always`.

No Privy policy is widened by this switch. It only makes the bot issue the
already-sealed, client-authorized v2 handoff. Until all three prerequisites
are met, leave the runtime policy at its current v1/off setting: neither v1
nor v2 has been accepted as a production user flow yet.

## Frontend implementation sequence

`useTelegramTradeHandoff` implements the generic v2 flow. It must first call
`resolve`, then branch by the returned handoff state instead of blindly
repeating `claim → commit`:

| Resolved state      | Next request                         | Safe retry / resume behavior                                                                |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `issued`            | `claim`, then `commit`               | Claim is the exact Review consent; a second tab re-resolves and follows the returned state. |
| `claimed`           | `commit` with the sealed fingerprint | Commit is idempotent; it returns the existing operation or direct continuation.             |
| `committed`         | `execute` and/or `projection`        | Never claim or commit again; resume the existing operation or direct trade.                 |
| `cancelled`         | `projection` / `execute` read-only   | Show the terminal result; never create another operation or order.                          |
| expired-token error | No state-changing request            | Show expiry and return to a fresh Telegram Review.                                          |

An `execute` result of `trade_terminal` is likewise read-only regardless of
the sealed handoff state.

Every v2 endpoint returns `{ handoff, execution }` where it has execution
state. Read `execution.fundingOperationId`, then use the existing funding
operation endpoints and `useFundingActionExecutor`. A client that encounters a
pre-v2 row must render a safe unavailable state rather than creating a second
interpretation of the old callback-replay contract.

For every required client action:

1. `POST /funding/operations/:operationId/steps/:stepId/prepare`.
2. Execute only the returned normalized action with the existing executor.
3. Report the result with the existing action-report endpoint.
4. Refresh/poll the operation projection, then call `/execute` again. Do not
   construct calldata from the handoff snapshot.

Supported v2 action executors are EVM single/batch, SVM transaction, and the
existing exact Polymarket Deposit Wallet external-handoff executor. Unknown
`signature` or handoff kinds must fail closed and surface a fresh Review.

When `commit` or `execute` returns `direct_trade_continuation_required`, enter
the ordinary venue trade continuation with the sealed `handoffId` and
`planFingerprint`; do not call the funding operation APIs or manufacture a
reservation. Its fresh quote may submit only within the sealed Buy or Sell
bounds; otherwise it presents a fresh Review without moving money.
For Limitless CLOB FOK, see the explicit exact-source/current-price exception
below rather than treating its preview proceeds as an enforceable quote floor.

Direct Polymarket v2 execution is FOK-only. Before the provider call,
the endpoint writes the order hash and a non-replayable recovery payload; if
the response or local persistence is lost, normal reconciliation can persist
the discovered order without signing or sending a second order.

Limitless CLOB is a direct sealed-handoff consumer only for **FOK** trades;
GTC is never used. The sealed scope binds the controller and exact outcome,
plus Buy maximum spend or Sell maximum shares. Limitless defines signed
`takerAmount = 1` as a market-order sentinel rather than a provider-enforced
minimum-receive field, so a CLOB Sell is bounded by its source shares and
immediate-or-no-fill semantics; its displayed proceeds estimate is not a
signed floor. Before calling the venue, the API durably claims its deterministic
`clientOrderId`; reconciliation uses `/orders/status/batch`. A FOK no-fill
terminates the trade without creating a resting or replacement order. A
changing CLOB preview before the POST is not a reason to reject this branch:
FOK executes immediately at the current venue price or fills nothing.
The direct claim records a canonical fingerprint of the exact signed order as
well as that id, so a retry can only resend the same signed FOK payload.

For that CLOB branch, call the ordinary endpoint with the existing client-signed
Limitless order payload and the two sealed-binding fields:

```ts
POST /trade/limitless/order
{
  marketSlug,
  order, // existing signed Limitless CLOB order; takerAmount is exactly "1"
  orderType: "FOK",
  telegramAppHandoffId: handoffId,
  telegramAppHandoffPlanFingerprint: planFingerprint,
}
```

Do not send a client order ID: the backend derives its deterministic one from
the handoff. If this request times out or its response is lost, first reopen
the same handoff and read its projection or call `/execute`. If the direct
claim remains in flight and no persisted order or terminal result exists,
resend **the same signed FOK order** and the same handoff binding; do **not**
build or sign a replacement order. The backend reuses its deterministic client
order ID and reconciliation owns the result.

Limitless AMM has a separate, equally exact direct boundary; it must not call
the receipt-recorder `POST /trade/limitless/orders/amm` first. The Mini App
builds either the exact `buy(amount, outcomeIndex, minOutcomeTokens)` or
`sell(returnAmount, outcomeIndex, maxOutcomeTokens)` transaction, signs its
raw EIP-155 bytes, then calls:

```ts
POST /trade/limitless/orders/amm/handoff-broadcast
{
  telegramAppHandoffId: handoffId,
  telegramAppHandoffPlanFingerprint: planFingerprint,
  tokenId,
  marketSlug,
  signedTransaction,
}
```

The API verifies the recovered signer, Base chain, AMM address, exact Buy or
Sell selector, outcome, maximum source debit, and minimum destination receive
against the sealed scope. It durably claims the raw transaction hash **before**
broadcasting those same bytes. Timeouts and lost RPC responses remain
reconcilable by that hash; they never reopen the trade. The signed raw
transaction is not persisted by the server. If this endpoint returns
`status: "reconciling"` with `retrySameSignedTransaction: true`, or its HTTP
response is lost, first re-open the handoff. Resend **only the identical
signedTransaction bytes** while the direct claim is still executing and there
is no persisted order or terminal result. Once an order reference or terminal
projection exists, only poll; never construct or sign a replacement AMM trade.
The Mini App must use this endpoint before AMM handoffs are advertised by the
bot; a generic wallet-send followed by the receipt recorder is not a valid
handoff protocol. Telegram advertises both Limitless CLOB FOK and AMM in
`fallback` and `always` modes; the Mini App selects this endpoint for AMM.

After that endpoint claims the direct trade, `/execute` returns
`direct_trade_in_flight` until the normal order reconciliation is terminal.
That response is informational only: it must never trigger a second submit.

When `/execute` returns `trade_continuation_required`, pass its exact consumer
reservation to the existing Polymarket or Limitless Buy consumer, which creates
a fresh quote. Continue only when the new Buy quote stays inside the Telegram
sealed max-spend, fee, and slippage bounds. Outside those bounds, show a fresh
Review without moving another source balance.
Pass the same `handoffId` and `planFingerprint` alongside the reservation as
`telegramAppHandoffId` and `telegramAppHandoffPlanFingerprint`: the ordinary
consumer validates both the reservation and the sealed controller/market/spend
scope immediately before it claims the venue trade attempt.

For a Limitless AMM funding continuation, claim the existing reservation before
the wallet signs or broadcasts its transaction:

```ts
POST /trade/limitless/orders/amm/funding-claim
{
  fundingOperationId,
  fundingReservationId,
  idempotencyKey,
  marketAddress,
  marketSlug,
  tokenId,
  amountUsdRaw,
  transactionData, // exact buy(amount, outcomeIndex, minOutcomeTokens)
  telegramAppHandoffId: handoffId,
  telegramAppHandoffPlanFingerprint: planFingerprint,
}
```

The API checks the calldata, market address, token and exact reservation in one
transaction with the v2 handoff claim. It then returns the normal attempt id
and claim token for `funding-start`; do not omit the handoff fields or use an
unbound AMM claim for a sealed continuation. Once claimed, the Buy has crossed
its no-cancel boundary and the Mini App must resume that same attempt rather
than create another one.

## Cancellation and close

- `POST /telegram/app-handoffs/cancel` cancels a v2 handoff and linked intent
  at every pre-venue-submit state (`issued`, `claimed`, or `committed`).
- Before funding broadcasts, ordinary operation cancellation also stops the
  funding operation. After a funding broadcast, handoff cancellation stops only
  the future Buy: funding continues reconciliation, but can never create a
  reservation-backed venue trade for the cancelled intent.
- A direct Buy or Sell remains cancellable until its durable direct claim
  starts. The endpoint atomically cancels both the handoff and linked intent.
  After claim, `Close` and cancellation only leave the screen while
  reconciliation finishes the already-submitted trade.
- `Close` never cancels money or a trade.

## Solana

The generic runtime already emits `svm_transaction` for supported Solana
USDC/SOL source routes and reconciles their receipts. V2 lets the existing
embedded or external Solana wallet sign those client actions; no Telegram
server policy is required for that.

Future unattended Solana automation must be a separate `server_svm_exact`
profile, with an exact signer/fee payer, allowlisted Relay programs and
accounts, source mint/destination/amount caps, no extra instructions, SOL
rent/fee reserve, a wallet lane, Privy Solana signer-policy inspection, and
SVM receipt/reorg recovery. It must not reuse EVM allowance semantics.
