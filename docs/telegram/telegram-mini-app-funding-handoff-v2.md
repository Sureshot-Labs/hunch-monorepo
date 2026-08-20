# Telegram → Mini App funding handoff v2

## Purpose

`handoff_th1_…` is a one-time, user-bound Telegram start parameter. New
handoffs use one generic contract (v2) and enter the existing funding flow:

```text
Telegram Confirm
  → sealed trade bounds + bounded funding-source scope
  → generic FundingPlanningRuntime quote and operation
  → Mini App action prepare/report loop
  → funding consumer reservation
  → fresh trade quote and continuation
```

There is no second funding planner and no second operation state machine.

## Rollout gate

The `signal_bot` runtime policy controls both the delivery choice and the
client protocol:

- `miniAppHandoffMode`: `off | fallback | always`;
- `miniAppHandoffContractVersion`: `1 | 2` (default `1`).

- A v2 handoff requires both version `2` and a non-`off` mode at each
  materialization boundary; read-only `resolve`/`claim`/`projection` remain
  safe observations. A policy below version `2` emits no new handoff.
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
This is a client-authorized path, not a way to widen unattended authority.

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
      venueBindingId: string,
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

For a Buy whose destination already has enough executable balance, `kind` is
`"direct_trade"` and the snapshot has only the versioned trade scope. It has
no invented funding operation, source debit, or reservation. This is the same
sealed handoff contract, not a fallback to v1.

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
commit. `POST /telegram/app-handoffs/execute` returns that same typed v2
response while client funding is pending and **never** replays the Telegram
callback. Once the operation has a canonical ready consumer reservation, it
atomically attaches that reservation to the original intent and returns:

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
funding. For v2 it may be used alongside the ordinary funding-operation
projection to show the intent's current state.

The v2 quote is owner-scoped with immutable `commit_scope`:

```ts
{
  kind: ("telegram_app_handoff_v2", handoffId, tradeIntentId);
}
```

It cannot be committed from the public generic funding endpoint.

## Enablement contract

New handoffs have one target contract: **v2 only**. V1 stays readable solely
so that a token issued before the v2 rollout can finish safely; it is neither
a feature flag nor a second implementation to test or extend.

The ordinary Polymarket CLOB order path accepts a sealed direct-trade binding.
Limitless remains available through a funded reservation continuation, but its
direct CLOB recovery record is not implemented yet, so the bot must not issue
a direct-trade v2 handoff for it. The exact public fields are deliberately explicit so the
Mini App cannot mistake this for a funding reservation:

```ts
{
  telegramAppHandoffId: handoffId,
  telegramAppHandoffPlanFingerprint: planFingerprint,
}
```

It must validate the same user, handoff state, venue, market, side, maximum
spend, fee and slippage bounds that were sealed by Telegram. In the _same
database transaction_ that persists the resulting order or execution, it must
advance the original `telegram_trade_intent` to the matching submitted or
terminal state. A replay must return the already-persisted result and cannot
create another order.

That is the direct-Buy analogue of the existing funding-reservation consumer
bridge. It does not create a funding operation, reservation, second planner or
second trade state machine. It simply gives the standard web Buy a durable
reference to its exact Telegram consent. Before the provider request, the
order endpoint atomically claims the handoff intent; after it persists the
ordinary order, the same transaction records the order ID on that intent.

After the v2 Mini App consumer is present, enabling the feature is only a
runtime-policy change:

1. Deploy the backend with migration `0226` applied.
2. Ship the v2 Mini App client and verify one direct Buy and one client-funded
   Buy end-to-end.
3. Set `miniAppHandoffContractVersion: 2` and choose
   `miniAppHandoffMode: fallback` or `always`.

No Privy policy is widened by this switch. It only makes the bot issue the
already-sealed, client-authorized v2 handoff. Until all three prerequisites
are met, leave the runtime policy at its current v1/off setting: neither v1
nor v2 has been accepted as a production user flow yet.

## Frontend implementation sequence

`useTelegramTradeHandoff` implements the generic v2 flow:

`resolve → claim → commit`; read `execution.fundingOperationId`, then use the
existing funding operation endpoints and `useFundingActionExecutor`. A client
that encounters a pre-v2 row must render a safe unavailable state rather than
creating a second interpretation of the old callback-replay contract.

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
the ordinary venue Buy continuation with the sealed `handoffId` and
`planFingerprint`; do not call the funding operation APIs or manufacture a
reservation. Pass them as `telegramAppHandoffId` and
`telegramAppHandoffPlanFingerprint` to the normal CLOB order endpoint. The
normal trade persistence endpoint performs the direct-binding transaction
described above. Its fresh quote may submit only within the sealed bounds;
otherwise it presents a fresh Review without moving money.

Current direct Polymarket v2 execution is FOK-only. Before the provider call,
the endpoint writes the order hash and a non-replayable recovery payload; if
the response or local persistence is lost, normal reconciliation can persist
the discovered order without signing or sending a second order.

Limitless has no direct-trade v2 handoff yet: AMM has its own client-transaction
lifecycle and CLOB still needs a durable pre-provider recovery record. Do not
issue or enable either direct Limitless path until its matching claim and
reconciliation boundary are added. This does **not** limit funded Limitless
continuation: it continues through the existing funding-reservation claim/report
path.

After that endpoint claims the direct Buy, `/execute` returns
`direct_trade_in_flight` until the normal order reconciliation is terminal.
That response is informational only: it must never trigger a second submit.

When `/execute` returns `trade_continuation_required`, pass its exact consumer
reservation to the existing Polymarket or Limitless trade consumer, which
creates a fresh quote. Continue the Buy automatically only when the new quote
stays inside the Telegram sealed max-spend, fee, and slippage bounds. Outside
those bounds, show a fresh Review without moving another source balance.
Pass the same `handoffId` and `planFingerprint` alongside the reservation as
`telegramAppHandoffId` and `telegramAppHandoffPlanFingerprint`: the ordinary
consumer validates both the reservation and the sealed controller/market/spend
scope immediately before it claims the venue trade attempt.

## Cancellation and close

- Before v2 materialization: cancel the handoff.
- Before any funding broadcast: cancel the funding operation and the linked
  Telegram Buy atomically; a later `/execute` returns its terminal state and
  never replays client actions.
- At/after a broadcast boundary: cancel only the later Buy continuation; the
  funding operation keeps reconciling to protect money already in flight.
- `Close` only leaves the screen. It never cancels money or a Buy.

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
