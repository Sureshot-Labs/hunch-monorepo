# WP8 appendix — Telegram-native Account Value, Receive, Relay, and Buy continuation

Status: implementation plan; local-only delivery first; no production activation.

This appendix refines the WP8 Telegram migration described by WP6/WP7. It is
normative for the first implementation pass. It does not authorize a deploy,
runtime-policy publication, Privy Dashboard mutation, live Telegram bot run,
or real-value transaction.

### Normative vocabulary

- `must`/`must not` are implementation requirements. `May` means an explicitly
  permitted behavior, not an unresolved product decision.
- File/table/endpoint names written as code are the implementation target in
  this appendix. User-facing copy in prose/code blocks is semantic copy and may
  be polished without changing the stated state or promise.
- `current` means reloaded from authoritative storage and verified at the last
  safe boundary immediately before the action; it never means a cached UI fact.
- `automatic` means a server broadcast without a new per-action confirmation,
  under earlier exact consent and a current bounded grant. Direct pUSD receipt
  is not an automatic transaction because no route transaction is required.
- `review` means an ordinary callback and confirmation inside Telegram.
  `authorization ceremony` means the exceptional Privy UI needed to create or
  repair signing authority; WP8 opens that UI in a Telegram Mini App and returns
  to the originating private bot context.
- State labels introduced only for Telegram presentation do not become new
  Funding Operation or Receive Session states. Backend evidence remains the
  authority.

## 1. Product outcome

Telegram is a first-class Account Value and funding controller, not a funding
advertisement that normally sends the user to the web application.

After the one-time setup for each required purpose/profile (batched into one
guided ceremony where Section 6 permits it), the normal Polymarket journey is:

```text
open Telegram
  -> see total and location-specific balances
  -> choose Buy or Add Funds
  -> choose an accepted receive asset/network
  -> receive a verified address and QR
  -> send funds
  -> Hunch observes the canonical receipt
  -> direct pUSD becomes ready, or eligible stable collateral is routed while
     every effective automation gate remains enabled
  -> Hunch reconciles destination pUSD
  -> Telegram shows a fresh Buy review
  -> user confirms once
  -> existing Telegram Polymarket executor submits the trade
```

The intended Polymarket receive matrix is below. It is a capability matrix,
not a promise that every row is shown for every account. Telegram renders only
variants present in the frozen, verified Receive Session and labels a route as
automatic only when its pre-receipt `can_offer_automatic` predicate in Section
12.1 is true. Actual broadcast later requires the stricter receipt/action-level
`can_auto_broadcast` predicate.

| User sends | Receive network | Destination | Normal result                                                           |
| ---------- | --------------- | ----------- | ----------------------------------------------------------------------- |
| pUSD       | Polygon         | Polymarket  | direct destination credit                                               |
| USDC.e     | Polygon         | Polymarket  | eligible Funding Router conversion to pUSD                              |
| USDC       | Base            | Polymarket  | eligible Relay route to Polygon pUSD                                    |
| USDC       | Solana          | Polymarket  | eligible Relay route to Polygon pUSD after fee-payer and recovery gates |

Limitless balances are visible from the first balance release. Limitless
funding/trading execution is a future follow-on outside this normative package.
The first execution package proves the complete Polymarket path without
introducing a generic omnichain or omnivenue signing policy.

The bot remains the normal surface when an execution gate is off: it shows the
applicable waiting, enable, setup, review, or recovery mode defined in Section 12. Mini App or ordinary Hunch web is a last-resort continuation only when the
required Privy authorization ceremony or recovery cannot be expressed safely
inside Telegram. A disabled automation switch alone is not a reason to send the
user to web.

## 2. Corrections to the earlier Receive-first proposal

The earlier narrow proposal was correct that direct receive does not require a
Privy signing policy. It was too conservative in treating the browser as the
normal executor for every child Funding Operation.

The corrected boundary is:

- Receive Session, canonical observation, route selection, quotes, commits,
  attempts, receipts, and reconciliation remain the one backend-owned funding
  lifecycle.
- Telegram adds a server-side `privy_delegated` execution actor for exact
  committed funding steps. It does not add another planner or route state
  machine.
- A Telegram-launched Receive Session is not blanket consent for every asset
  its shared address can receive. The user selects an exact verified
  asset/network/target variant. Only that immutable scope may be routed within
  its frozen amount/fee/slippage caps, provided the user also has a current
  delegated funding authorization.
- A quote outside the frozen automation caps does not auto-execute. Telegram
  renders the exact refreshed economics and asks for an explicit conversion
  confirmation inside the bot.
- Web handoff remains fail-closed recovery, not the default architecture.

`automatic_conversion` must not be presented as automatic until the delegated
executor is implemented, the route-specific activation gate in Section 16.2 is
proved, and every effective automation gate is currently enabled. Today the
receipt router can create the child operation, but the generic action runtime
exposes only a client action and does not broadcast it.

## 3. Non-negotiable invariants

1. Account Value, Receive Session, Funding Operation, step attempt, receipt,
   and trade intent remain the only authorities for their respective states.
2. Telegram never accepts a raw destination address, provider, calldata,
   transaction, quote, operation status, or `user_id` from a callback.
3. Every displayed receive target comes from one current, verified Receive
   Session. The legacy Telegram address resolver is not extended into a second
   receive lifecycle.
4. Every delegated transaction must byte-match the immutable normalized action
   and action fingerprint committed by the funding planner.
5. A Privy policy is an additional enforcement boundary, not a substitute for
   application validation, durable attempts, or settlement observation.
6. Sponsorship is not signing authority.
7. A canonical receipt never submits a trade. It may make venue funds ready
   and create a fresh reviewable Buy intent.
8. The old Buy quote, policy snapshot, and confirmation expire normally while
   the user is funding. Buy continuation always obtains fresh market and
   liquidity facts and requires final confirmation.
9. Worker/API restarts, duplicate chain events, duplicate callbacks, and
   ambiguous broadcasts converge without a second route, transaction, or
   order.
10. Disabling new Telegram funding creation does not stop observation,
    reconciliation, refund, or recovery for existing sessions/operations.
11. No production flag, Privy policy, Telegram bot, or financial execution is
    enabled by merging the local implementation.
12. Balance and funding screens and callbacks are private-chat only. Require
    the exact current link and `chat_id === telegram_user_id`; reported chat
    type alone is not authority. A group chat receives only a safe prompt to
    open the bot privately.
13. `desired_enabled` is product preference, not signing authority. Neither an
    account link nor a Receive Session may synthesize delegated authority.
14. A session's `selectedReceiveTargetId` is presentation state only. The
    delegated executor requires separately persisted, exact asset/network/
    destination/variant consent.
15. Unlink, deleted messages, blocked chats, and Telegram delivery failures do
    not stop receipt observation or reconciliation. They do stop new delegated
    broadcasts until current identity and authorization are re-established.
16. In initial WP8, the existing per-user `desired_enabled` preference is the
    master preference for new Telegram value-moving actions: delegated funding
    broadcasts and new trade submissions. It grants no authority. Turning it
    off does not disable balance, direct receipt, observation, reconciliation,
    recovery, or transactional progress delivery.
17. Once a broadcast may have occurred, no availability, preference, policy,
    or pause transition may create another submission. Reconciliation and
    recovery continue under every switch state.
18. A disabled gate changes bot mode; it does not silently change accounting
    state, discard consent/evidence, or make web the default continuation.

## 4. Existing contracts to reuse

### 4.1 Account Value

`buildAccountValueReadModel()` is the balance source of truth. Telegram must
reuse its public projection rather than recompute balances from wallet RPCs,
venue APIs, or the trading intent service.

Required Telegram presentation fields already exist:

- headline estimated liquid assets/portfolio value and freshness;
- cash available across Hunch;
- available cash by venue;
- per-component amount, location, valuation, and execution eligibility;
- locked, reserved, submitted-debit, and available raw cash;
- in-transit components;
- collector errors and partial/stale state.

The canonical Account Value `headline` is the primary headline. Optional totals
and groups must come from existing projection fields. The bot may group and
format these facts, but may not change their accounting semantics or
independently sum components and call that result available cash.

### 4.2 Receive Session

Reuse the existing amount-free session, verified target snapshot, 24-hour
display window, seven-day late-observation window, canonical EVM/Solana event
allocation, immutable receipts, and child Funding Operation linkage.

The generic Add Funds session remains amount-free in the first release. A
Buy-return context may remember the already known intended spend, but Telegram
does not add a manual amount-entry/indicative-quote branch yet. This keeps
receipt settlement amount-free and avoids a second quote UX before it provides
real execution value.

### 4.3 Funding planner and Relay

Reuse existing destination discovery, source options, Relay quote parser,
`RelayPinnedActionValidator`, normalized EVM/SVM actions, operation commit,
step attempts, encrypted transaction references, reconciliation, and
postconditions.

The bot neither selects a provider nor constructs Relay calldata or Solana
instructions.

### 4.4 Telegram trading

Reuse the existing linked-account identity, managed setup preferences,
authorization rows, policy snapshots, short-lived intents, callback capture,
fresh preview/final confirmation, Polymarket executor, venue reconciliation,
notifications, and durable Telegram outbox.

## 5. User-visible Telegram surfaces

### 5.1 Balance

Add a `Balance` menu tile and callback. The compact screen shows:

```text
Estimated liquid assets
Total portfolio value

Trading balances
  Polymarket       available / locked
  Limitless        available / locked

Wallet balances
  Polygon wallet   pUSD, USDC.e
  Base wallet      USDC
  Solana wallet    USDC

In transit
  route, amount, current stage
```

Rules:

- zero groups may be collapsed, but stale/partial/in-transit groups may not be
  hidden;
- location labels and token/network labels are server-generated safe labels;
- raw opaque IDs, provider IDs, full wallet identifiers, reason-code dumps,
  and unsupported token metadata are not rendered;
- `Available` comes from `cashAvailability.availableRaw`, not the observed
  component balance;
- locked/reserved values are visible when non-zero;
- `Refresh`, `Add funds`, `Buy`, and `Back` are ordinary callbacks;
- the same presenter is used for the menu tile, shortfall screen, funding-ready
  notification, and post-trade receipt.

### 5.2 Add Funds / Receive

The bot asks for the destination venue first. In the initial execution slice,
Polymarket is the only funding destination, while all venue balances remain
visible. Opening/reusing a session is non-value-moving and returns its verified
frozen targets. Only then does the user select an exact target asset.

The next screen lists only capability-backed targets returned by that Receive
Session:

- `pUSD on Polygon — direct`;
- `USDC.e on Polygon — automatic` only when the full effective automation
  offer predicate in Section 12 is true for the PM Funding Router profile;
- `USDC on Base — automatic` only when that offer predicate is true for Relay
  EVM;
- `USDC on Solana — automatic` only when that offer predicate is true for Relay
  SVM, including its fee-payer and submission-recovery gates.

Selecting a target persists immutable consent to the exact asset, network,
destination, and internal variant IDs before revealing the address as
auto-routable. This is required because pUSD and USDC.e may share the same
Polygon target address and the receive observer intentionally scans all
variants. An unexpected asset can be observed and credited, but it cannot
inherit automation consent from the selected address.

Consent classification is fixed by the selection transaction. A non-direct
selection writes `automation_enabled=true` only when
`can_offer_automatic=true` at the compare-and-set boundary; otherwise it writes
an exact review-only revision with `automation_enabled=false` and a null
automatic cap. Re-enabling a gate never upgrades that historical revision in
place. The user must make a fresh exact selection before sending, or confirm a
fresh exact review after receipt. A soft pause that begins after an automatic
revision was created does not rewrite that revision; Section 12.3 determines
whether its receipt can resume.

If the target list said `automatic` but the selection-time reload is false, the
selection response must show the downgraded review/wait/setup mode before the
address and must not repeat the automatic promise. The list render never pins a
gate value.

Each target displays exact network, asset, verified address, QR/copy buttons,
session expiry, sender native-fee requirements, and the correct semantic
progress stages. A non-direct target also displays the frozen maximum
fee/slippage caps. A target whose receipt can still be safely observed but whose
execution predicate is false says the exact mode from Section 12 rather than
promising routing. A route removed from receive/runtime policy is hidden from
new target selection; funds already sent remain observable and recoverable.

The Telegram presenter must not reuse the current generic `You can send any
amount` instruction for a non-direct target. It shows the positive automatic
raw cap in user units and states that a larger receipt will not auto-execute.
If it is still inside every absolute route/grant cap, it can enter Telegram
review; above an absolute cap it enters recovery/unsupported handling. Direct
pUSD remains amount-free because it needs no conversion transaction.

### 5.3 Funding progress

One logical Telegram progress card reflects backend state. Editing the current
message is best effort; a durable action outbox sends a replacement or terminal
message when the original was deleted, became stale, or cannot be edited.

| Backend evidence                     | Telegram state                                         |
| ------------------------------------ | ------------------------------------------------------ |
| open, no receipt                     | Waiting for transfer                                   |
| canonical receipt allocated          | Funds received                                         |
| child operation committed            | Preparing conversion                                   |
| delegated attempt started/submitted  | Routing funds                                          |
| chain/provider receipt pending       | Confirming                                             |
| destination postconditions satisfied | pUSD ready                                             |
| economics exceed frozen caps         | Review conversion                                      |
| user master preference off           | Automation off; enable in Telegram                     |
| Hunch execution soft-paused          | Waiting for routing to resume                          |
| grant/policy missing or revoked      | Setup required                                         |
| action/route semantics invalidated   | Review a fresh route                                   |
| retryable provider/RPC failure       | Retrying; show last safe stage                         |
| ambiguous broadcast                  | Confirming; never offer a second submit                |
| recovery required                    | Needs attention; show bot actions or last-resort Hunch |

The message renderer reads public session/operation summaries. It does not
infer success from a Privy or Relay response.

### 5.4 Return to Buy

When Add Funds originated from a Buy flow, the channel context stores the
market, outcome, intended spend, chat, and message to resume. Call this a
`buy_return_context`, not trade shortfall authority: it creates no trade
reservation and does not keep the old quote alive.

After pUSD readiness:

1. refresh Account Value and Polymarket readiness;
2. determine whether the requested Buy appears coverable;
3. if the master preference, Telegram trading product gate, or Buy continuation
   gate is off, render the matching Telegram enable/unavailable state and do
   not create an intent;
4. otherwise render a `Review Buy` button scoped to the saved linked
   account/chat and readiness revision;
5. only after that user callback, atomically claim one resume generation, fetch
   a fresh market/trade quote, and create or reuse its one short-lived Telegram
   Buy intent;
6. render the ordinary Telegram Buy review;
7. require final confirmation;
8. submit through the existing Polymarket Telegram executor.

If the deposit is insufficient, show the remaining shortfall and keep the
Receive Session open for another receipt. The newest explicit Buy flow replaces
the active return context without cancelling the session or changing ownership
of any funds. Excess becomes ordinary Account Value and is never silently added
to the order.

Duplicate callbacks reuse the intent for the claimed generation. Readiness
never increments a generation. Once that intent is terminal (including expired
or cancelled), a later explicit `Review Buy` click atomically advances the
generation and may create a new fresh intent. Thus idempotency suppresses callback
replay without permanently preventing the user from retrying a Buy.

## 6. One-time Telegram trading and funding authorization

The desired product default is `desired_enabled = true` after a verified
Telegram account link, controlled by `autoEnableOnTelegramLink`. A manual
disable remains sticky across relinks until the user explicitly enables it
again.

This default must not be confused with silently granting a server signer.
`desired_enabled` means product intent only. Privy delegated authority requires
an explicit one-time user authorization and a current server-verifiable funding
grant.
The existing managed setup currently performs that ceremony from the Hunch
frontend. WP8 exposes it as a Telegram-first onboarding action. The action opens
only the Privy authorization surface in a Telegram Mini App and returns to the
originating private bot context. After that one-time ceremony, normal balance,
receive, routing, review, and trading stay in Telegram.

If a valid grant already exists, linking/finalization is automatic and no Mini
App is opened. If the user refuses or revokes the grant, direct receive remains
available when Receive creation is enabled, while value-moving routes show
`Setup required` and offer the one-time authorization action in Telegram.

Do not weaken or bypass this boundary merely to claim that setup happens
without a browser. A one-time embedded authorization ceremony is different
from using the web application as the normal funding executor.

`One-time` means once per purpose/profile revision, not one lifetime omnibus
grant. Initial Polymarket onboarding presents trading and PM Funding Router
grants in one guided Mini App session while storing them as separate revocable
authorizations. A later Relay EVM/SVM purpose or policy revision requires its
own explicit setup once before the bot labels that routed target automatic. No
per-transaction ceremony is required while the exact grant remains current.

Do not reuse or extend a generic Telegram trade authorization as funding
authority. Introduce the separate `telegram_funding_authorizations` table with
an immutable grant snapshot:

- exact purpose: `pm_funding_router`, `relay_evm`, or `relay_svm`;
- user, current linked Telegram account, chain, internal wallet, and Privy
  wallet ID;
- Privy policy ID plus validated revision/fingerprint;
- authorization/key identity and last verification timestamp;
- allowed action kinds, assets, destination venues, and per-operation cap;
- expiry, revoke state, and later a separate atomic cumulative-cap ledger if
  daily limits become a product requirement.

Funding authorization is durable financial evidence, not disposable link
state. Unlink first revokes it, then nulls any live account foreign key while
retaining immutable user/Telegram IDs, grant fingerprint, signer/quorum/policy
IDs, authorization signature/reference, and timestamps. Operations/attempts
retain the exact grant revision/fingerprint they used. Never copy the existing
trade-authorization `ON DELETE CASCADE` pattern for this evidence. Fresh
execution resolution still requires the current linked private account.

The first delegated slice uses per-operation/session caps only. It must not claim
daily/cumulative protection until an atomic reservation ledger exists; an
ambiguous broadcast would have to retain that reservation until resolution.

## 7. Telegram funding channel context

Add the narrow `telegram_funding_sessions` channel-context table, linked
one-to-one to `funding_receive_sessions`, plus the append-only
`telegram_funding_consents` table. These are persistence/audit structures, not
a second workflow.

Required `telegram_funding_sessions` fields:

```text
id uuid primary key
user_id uuid not null
telegram_account_id uuid null references user_telegram_accounts(id) on delete set null
telegram_user_id text not null
chat_id text not null
telegram_message_id bigint null
receive_session_id uuid not null unique
origin generic_add_funds | buy_return_context
market_id text null
event_id text null
side YES | NO null
requested_spend_usd numeric null
active_consent_revision integer null
idempotency_key text not null unique
expires_at timestamptz not null
resume_generation integer not null default 0
resume_intent_id uuid null
resumed_at timestamptz null
cancelled_at timestamptz null
created_at / updated_at
```

Persist exact target selection and automation consent as append-only revisions,
not mutable columns on that context row. Each
`telegram_funding_consents` record contains:

```text
id uuid primary key
telegram_funding_session_id uuid not null
revision integer not null
selected_receive_target_id text not null
selected_asset_network_id text not null
selected_asset_id text not null
selected_asset_decimals integer not null
consented_variant_ids text[] not null
automation_enabled boolean not null
max_auto_execute_source_raw numeric(78, 0) null
automation_policy_snapshot jsonb not null
consent_fingerprint text not null
consented_at timestamptz not null
unique (telegram_funding_session_id, revision)
```

For an automatic revision, `max_auto_execute_source_raw` is positive and equals
the minimum applicable session/runtime, user, grant, provider, and Privy
per-operation cap expressed in the selected asset's raw units. `NULL` always
means automation disabled, never unlimited. Direct pUSD selection may therefore
have an exact revision with automation disabled because it needs no route.

Creating the revision and compare-and-setting `active_consent_revision` is one
transaction. Changing target, asset, variant scope, or cap appends another
revision and never rewrites history. During delegated eligibility, select the
latest exact matching consent whose `consented_at` is no later than the
receipt's immutable `first_seen_at`, then persist that consent ID/fingerprint in
the attempt application-authorization snapshot before broadcast. Later consent
cannot retroactively make an observed transfer automatic.

This table is not a second funding state machine:

- receipt and route state are derived from Receive/Funding Operation;
- trade authority is created later as a fresh Telegram trade intent;
- active/expired/resumed/cancelled presentation is derived from timestamps and
  the linked session;
- it stores channel return context and points to exact, immutable consent
  revisions only;
- it never stores calldata, provider payloads, transaction references, route
  status, quote authority, or reservation state.

The selected target is never itself execution authority. Before persisting a
revision, the API maps the selected public target plus exact asset to the
internal frozen variant IDs. Empty variants, disabled automation, or a null cap
mean no automatic route. A transfer of another asset to the same address is
still observed but becomes review/setup-required.

The migration must update user merge/deletion guards, market-retention
protected references and cleanup, Telegram unlink behavior, admin inspection,
and integration fixtures. Active/financial contexts block unsafe account merge;
terminal context must not be reassigned during merge. Cleanup may delete it only
after every linked receipt/operation is terminal and the configured financial
retention window is satisfied. Active Buy-return market references are
protected until that cleanup.

An active financial session continues safely after Telegram unlink because the
historical Telegram identity remains on the row and the account foreign key is
set null. Observation/reconciliation continue; delivery and every new delegated
broadcast require a fresh current linked-account lookup plus current funding
authorization and therefore fail closed.

## 8. Delegated Funding Operation executor

### 8.1 Why it is required

The current generic action runtime starts a client-owned attempt and returns
`web_client`, `privy_authorization`, or `venue_relayer`. Automatic Telegram
funding requires a server actor for steps whose exact wallet profile and active
Telegram authorization permit `privy_delegated`.

Do not call existing venue trading services directly from the receipt router.
That would create a second orchestration path and make retries capable of
double broadcasting.

### 8.2 Shape

Implement a side-effect-free eligibility/validation layer and a durable worker
executor:

```text
receive receipt router
  -> commits exact child Funding Operation
  -> operation exposes a planned delegated-eligible step
finance-worker
  -> atomically claims one exact eligible step and creates its attempt
  -> revalidates session consent + Telegram authorization + runtime policy
  -> resolves a fresh, exact delegated funding capability
  -> revalidates immutable action fingerprint and route validator result
  -> calls injected Privy EVM or Solana wallet adapter
  -> persists accepted/ambiguous reference immediately
  -> ordinary reconciliation proves settlement and destination readiness
```

Select eligible planned steps with `FOR UPDATE SKIP LOCKED` and create the
attempt in the same transaction; WP8 adds no parallel execution queue or lease
table. A `started`, `submitted`, or `ambiguous` attempt is never re-executed
because worker ownership disappeared. Reconciliation first searches by the
durable provider/reference fact; only a proved definitive failure can permit a
fresh attempt.

For EVM, derive and durably persist a deterministic provider request/reference
ID from the attempt/action fingerprint before the RPC call. This pre-submit
correlation is distinct from the later transaction/receipt reference and must
not overload terminal `receipt_ref` semantics. Add immutable
`submission_request_ref_ciphertext`, `submission_request_ref_lookup_hmac`, and
`submission_request_key_version` fields to the attempt and populate them during
attempt creation. Claim, attempt, and request identity are therefore committed
before external submission. After timeout or crash, lookup that reference
before any retry. The post-provider/pre-result crash boundary is `ambiguous`
and cannot cause another send.

After claim and immediately before the adapter call, reload the effective
automation predicate. If any gate closed before submission, finish the attempt
as a proved pre-submit cancellation with `broadcast_may_have_occurred=false`
and a stable reason code, keep the immutable step planned, and project the
matching OFF mode; do not leave a blocking `started` attempt. A later soft
re-enable may create a new attempt only under the rules in Section 12.3.

An expired child action is never silently re-quoted or re-broadcast under old
consent. It becomes review/recovery required; only a fresh quote and explicit
new consent may produce another committed action. Solana adds a stronger gate:
server delegation is unavailable until the adapter proves durable submission
idempotency/lookup for unknown outcome and safe blockhash-expiry semantics.

The receipt router must not call Privy. It remains deterministic and safe to
retry.

### 8.3 Eligibility

A step is auto-executable only when all conditions are true:

- it belongs to a Telegram-launched session whose receipt is bound to an exact,
  pre-existing consent revision, whose variant is in `consented_variant_ids`,
  whose automation is enabled, and whose raw amount is no greater than its
  positive effective source-raw cap;
- receipt handling is `automatic_conversion`, never volatile
  `review_required`;
- current session and runtime policy revisions still allow execution;
- a new `DelegatedFundingCapabilityResolver` proves an internal exact-network
  wallet, server wallet reference, active Privy authorization/key quorum and
  exact policy/profile; ordinary Account Value `signingModes` are never trusted
  as this fact;
- the Telegram authorization belongs to the same user, linked Telegram
  account, wallet, chain, venue/purpose, and current policy revision;
- amount, per-operation cap, fee, slippage, destination, and action kind are
  inside both the session automation snapshot and Telegram authorization;
- the committed route/action validator is the expected version;
- no started, submitted, ambiguous, or unfinished attempt already exists;
- emergency broadcast pause is off.

Any uncertainty fails closed without discarding the observed receipt.

A review-confirmed step uses the same executor, claim, attempt, and
reconciliation path. It substitutes the one-time exact review confirmation for
pre-receipt automation consent and evaluates `can_execute_confirmed`; it is not
a second provider- or Telegram-specific execution path.

The resolver returns a channel- and purpose-scoped capability to a dedicated
executor ID such as `telegram_privy_delegated_evm_v1` or
`telegram_privy_delegated_svm_v1`. It never adds `privy_delegated` globally to
the wallet profile and never extends the public client action endpoint. The
executor repeats the fresh authorization check immediately before broadcast.

### 8.4 Execution profiles

Use separate revocable policy profiles; do not create an omnibus EVM/Solana
policy.

Before attaching another Privy signer, define a finite Hunch-owned purpose
signer registry. Each entry binds one purpose to an exact signer ID, key quorum,
wallet/chain, policy ID, and validated policy fingerprint. The existing trading
inspector currently treats every additional non-trading signer as foreign;
Slice C must update it to tolerate only fully verified other-purpose registry
entries while continuing to reject unknown, duplicate, malformed, or
multi-policy signers. Trading and funding grants must coexist and revoke
independently. If Privy cannot support that topology safely, delegated funding
stays unavailable; do not collapse the purposes into an omnibus signer/policy.

1. `telegram_pm_funding_router_v1`
   - Polygon only;
   - exact Funding Router contract;
   - exact `fund()` semantics and bounded total amount;
   - Privy policy bounds the external transaction envelope;
   - application authorization separately binds the exact immutable action,
     Funding Operation/step, canonical receipt allocation, internal signer,
     target venue wallet, and limits;
   - extracts and reuses the existing PM policy parser/validator as a pure
     primitive; no second Funding Router ABI validator is introduced.
2. `telegram_relay_evm_funding_v1`
   - Base source initially;
   - exact allowlisted Relay transaction targets/spenders and chain;
   - zero native value unless an explicitly validated action requires it;
   - exact committed source amount and bounded fee/slippage;
   - no arbitrary token approval, transfer, or contract call.
3. `telegram_relay_svm_funding_v1`
   - Solana USDC source initially;
   - exact wallet, mint, amount, program/account allowlist, blockhash/expiry,
     and committed instruction bytes;
   - no native SOL route in the automatic-stable slice;
   - no arbitrary message signing or transaction submission.

The Relay EVM profile has an activation gate: prove that current Relay Base
actions use a finite target/spender envelope expressible in Privy policy. If
the target is dynamic or cannot be safely bounded, the route stays
user-authorized. Relay Deposit Address is not part of this Privy ingress flow.

Solana USDC-only UX additionally requires a fee strategy. Current target facts
correctly report a sender requirement of 3,000,000 lamports (0.003 SOL), and
the normalized SVM action does not yet encode a fee payer. The preferred
end-state for WP8 is an explicit, capped Hunch/Privy fee-payer relationship
represented in the normalized action and outer policy. Gas top-up is not a WP8
fallback. Until the explicit fee-payer contract is proved, Telegram must show
the 0.003 SOL sender requirement and must not label
`USDC only -> automatic pUSD` as supported.

Local application validation is necessary but insufficient. Before any live
activation, prove that the actual Privy policy language can enforce a useful
outer bound for each profile. If Solana policy conditions cannot safely bound
Relay instructions, Solana delegated execution remains unavailable and it must
not inherit a broad signer grant. A bot review alone cannot repair that missing
execution capability; expose an executable reviewed flow only after
`can_execute_confirmed` can be satisfied.

### 8.5 Worker process boundary

Use the existing finance-worker; WP8 does not add another service. Add
finance-worker-local optional configuration and inject the Privy
clients/validators. If the required sidecar-safe dependency boundary cannot be
implemented, Slice C is blocked and this plan must be revised rather than
silently adding a process. Do not import `apps/api/src/env.ts` or another
API-wide required-secret graph.

Use a dedicated
`HUNCH_FINANCE_TELEGRAM_FUNDING_DELEGATED_EXECUTION_ENABLED=false` gate that is
not inferred from the existing general finance execution flag, plus a separate
optional secret bundle and adapter factory. Broadcast requires all of
`HUNCH_FINANCE_EXECUTE=true`, the dedicated delegated-execution flag, the exact
profile gate, funding runtime policy, and emergency pause being clear. The
general flag alone never enables delegation, and the dedicated flag never
bypasses the global kill switch. The delegated adapter import graph must not
reach API-wide env, `privy-service.ts`, `embedded-ethereum.ts`, or
`embedded-solana.ts`; extract sidecar-safe pure clients/validators instead.

When delegated funding is disabled or any required secret/profile is absent,
the worker continues observation/reconciliation, does not claim delegated
steps, and reports the action as unavailable. It must still boot successfully.

For same-cycle progress, order the worker batch as receive observation and
receipt routing, then delegated claim/execution, then ordinary reconciliation.
This lets a newly created child step execute in the same scheduled run without
a busy loop while preserving the existing reconciliation authority. No fixed
latency promise is made until measured; the design must add no avoidable extra
worker interval between these phases.

## 9. Review-inside-Telegram flow

Stable receipts inside frozen caps auto-execute only while the complete
effective automation predicate is true. The following require a bot review or
setup state rather than a broadcast:

- fresh route economics exceed the session's automatic caps;
- the route changed materially after the indicative estimate;
- automation consent or delegated authorization expired but can be renewed;
- a recoverable operation needs a new quote and explicit consent.

The Review message includes source asset/amount, destination pUSD minimum,
provider-independent fee, slippage/price impact, expiry, and destination. The
callback contains only a compact opaque review/continuation ID. On Confirm,
the API reloads and validates the current quote/operation/authorization; it
never trusts callback economics.

That confirmation authorizes one exact newly committed action. It may approve
economics outside the earlier session automation cap only when they remain
inside every current runtime/user/grant/Privy absolute cap. It does not mutate
the append-only pre-receipt automation consent or authorize future receipts.

If `can_execute_confirmed` is true, execution continues server-side. If
authority is missing/invalid, the bot shows
`Setup required`; its setup button opens the Privy ceremony in the Telegram
Mini App and returns to the same bot context. Ordinary Hunch web is offered only
when that ceremony or the required recovery is unsupported by the Mini App.

A Telegram review is application consent, not a wallet signature and not a
capability bypass. If the exact route has no safe delegated executor, policy
envelope, fee-payer contract, or submission-recovery contract, confirmation is
disabled and the bot renders `Unavailable` or `Needs attention` with the exact
missing prerequisite. It must not accept a confirmation that can only succeed
by silently opening web or by broadening signing authority.

## 10. Internal API and bot-client changes

Add the following thin internal-token-authenticated contracts under the
existing Telegram route family. Their request/response semantics and paths are
part of WP8; later renaming requires updating this appendix and generated client
tests together.

```text
POST /internal/telegram-bot/account
POST /internal/telegram-bot/funding/open
POST /internal/telegram-bot/funding/session
POST /internal/telegram-bot/funding/select-target
POST /internal/telegram-bot/funding/cancel
POST /internal/telegram-bot/funding/review
POST /internal/telegram-bot/funding/confirm-review
POST /internal/telegram-bot/funding/resume-buy
```

Endpoint responsibilities are single-purpose:

| Endpoint                 | Normative responsibility                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`                | Build and render current Account Value; never mutate funding/trading state                                                                                                                              |
| `funding/open`           | Open or restore one amount-free Receive Session for the exact destination binding and return its frozen verified targets; do not select one silently                                                    |
| `funding/session`        | Read the current channel projection by opaque Telegram funding context ID                                                                                                                               |
| `funding/select-target`  | Validate one exact target+asset from the frozen session, append/CAS its consent revision, and return its address/copy/QR projection                                                                     |
| `funding/cancel`         | Stop this context from accepting new UI actions; preserve late observation/reconciliation/recovery windows and immutable evidence                                                                       |
| `funding/review`         | Produce fresh non-binding review economics for one observed non-direct receipt/action-required context                                                                                                  |
| `funding/confirm-review` | Revalidate current authority/economics and commit exactly one reviewed action using its one-time planner consent/confirmation; do not mutate session automation consent and never trust callback fields |
| `funding/resume-buy`     | Apply the Section 5.4 generation transaction and create/reuse one fresh Telegram trade intent only after explicit user click                                                                            |

Every mutating endpoint requires a unique idempotency/continuation key scoped to
the resolved user, current private link, and context. Replays return the same
semantic result; they never append another consent, action, attempt, or intent.

Input boundary:

- accept Telegram user/chat/message, venue, exact safe target/asset choice, and
  opaque continuation/review ID;
- resolve `telegram_user_id -> user_id` server-side;
- require the exact current linked private chat with
  `chat_id === telegram_user_id` for every balance/funding screen and callback;
  reported chat type alone is insufficient and group contexts receive no
  financial data;
- resolve destination/binding/source/route/action server-side;
- reject ambiguity rather than selecting the first wallet or destination;
- scope all reads/mutations to the linked Hunch user;
- never return internal wallet/provider authority or policy internals.

Extend `TelegramBotTradingInternalApiClient` and the existing callback/menu
dispatcher. Keep Telegram Bot API transport in the signal-bot process and all
financial decisions in the API/funding domain.

Callback data must remain within Telegram's size limit. Persist context and use
compact opaque IDs rather than encoding market, amount, route, or address into
callback data.

## 11. Notifications and message updates

Project funding transitions into durable Telegram delivery. Do not send
Telegram messages directly from the receipt observer, router, delegated
executor, or reconciler.

Required events:

- `funding_receipt_observed`;
- `funding_conversion_started`;
- `funding_ready`;
- `funding_review_required`;
- `funding_recovery_required`.

These are transactional funding projection events, not optional notification
topics. Extend `telegram_bot_action_outbox` with typed funding `send`, `edit`,
and `replacement` actions and keep its existing claim/retry/dead-letter
contract. Do not emit a second generic `telegram_user_notifications` message
for these transitions in WP8; that avoids duplicate and preference-dependent
financial progress.

The progress projection requires `(funding_session_id, state_revision)` dedupe,
claim/retry, compare-and-set of `telegram_message_id`, and fallback send when an
edit is stale or rejected. Terminal readiness/recovery must remain deliverable
even if the original card was deleted. Finance-worker emits facts/outbox rows;
only signal-bot owns Telegram transport.

Retain the latest terminal projection independently of a delivery action's dead
state. A blocked or unlinked destination stops retries but does not erase that
projection. On an explicit `/start`, relink, or verified current-link
restoration, enqueue exactly one replacement action for the latest unseen
terminal revision. This is rearming, not an infinite retry loop.

Dedupe by canonical receipt/operation transition identity. Coalesce a legacy
`deposit_received` only by exact canonical transfer identity (network,
transaction hash/signature, and event index), not by approximate amount or
address. Receipt, conversion, and destination-ready are distinct revisions.
Reorg/recovery after a prior ready projection emits a newer recovery revision.

The `Review Buy` callback contains only an opaque continuation ID and is scoped
to the saved current linked account/chat plus ready revision. It cannot be
replayed to create multiple trade intents.

Funding progress and terminal/recovery cards are transactional and are not
suppressed by optional notification-topic preferences. Message-edit failure or
a blocked chat affects delivery only and cannot affect funding state. Telegram
unlink also cannot affect observation/reconciliation, but it separately blocks
delivery and new delegated broadcasts until a current link and authorization
are verified again.

## 12. Runtime controls for local implementation

Every new WP8 control defaults off in source and production fallback policy.
The existing global finance execute switch retains its configured value but is
necessary and never sufficient for delegated funding.

### 12.1 Independent controls and effective predicate

Required independent semantic controls:

- Telegram Account Value surface enabled;
- Telegram Receive Session creation enabled;
- per-user Telegram `desired_enabled` master preference;
- Telegram stable auto-execution enabled;
- PM Funding Router delegated execution enabled;
- Relay EVM delegated execution enabled;
- Relay SVM delegated execution enabled;
- Telegram Buy continuation enabled;
- emergency delegated broadcast pause.

The dedicated finance-worker delegated-execution flag and each exact execution
profile gate are also off independently. A general worker/reconciliation or
Telegram-trading switch never implies value-moving funding capability.

Funding runtime policy still owns routes, assets, venues, quote/commit/action
gates, caps, observation, reconciliation, and recovery. Signal-bot policy owns
Telegram product availability, managed authorization targets, confirmation,
and per-user caps. Privy policies own the outer signing boundary. These control
planes must remain explicit and must not infer one another.

Before a receipt exists, `can_offer_automatic` is the target-presentation and
consent-creation predicate. It is true only when user `desired_enabled`, stable
auto-execution, global execute, the dedicated worker flag, the exact profile,
sidecar adapter/secrets, current private link, current purpose grant/signer/
policy fingerprint, the route/action family, positive finite automatic caps,
fee-payer requirements, and emergency-pause state all currently permit that
target. It contains no receipt amount, committed action bytes, attempt, or
postcondition because those facts do not exist yet. The label means “eligible
receipts within the displayed cap will be considered for automatic routing”; it
is not a guarantee that a later receipt will pass the fresh broadcast check.

The target-selection transaction reloads `can_offer_automatic`. Only a true
result creates `automation_enabled=true` consent. Any false result creates an
exact review-only consent, even if the false gate is expected to recover soon;
later ON transitions never mutate it into automatic consent.

For a non-direct receipt, `can_auto_broadcast` is true only when every condition
below is true at the immediate pre-submit boundary:

```text
user desired_enabled
AND Telegram stable auto-execution enabled
AND HUNCH_FINANCE_EXECUTE
AND HUNCH_FINANCE_TELEGRAM_FUNDING_DELEGATED_EXECUTION_ENABLED
AND exact route/profile execution enabled
AND required sidecar secrets/adapters available
AND emergency delegated broadcast pause is off
AND current exact private Telegram link exists
AND current purpose grant + signer/quorum + Privy policy fingerprint match
AND route/provider/action semantics are still current
AND receipt is bound to pre-existing exact consent
AND amount/fee/slippage are inside every current finite cap
AND committed action is unexpired and byte-exact
AND no attempt may already have broadcast
```

`can_execute_confirmed` uses the same predicate except that Telegram stable
auto-execution and pre-receipt automation consent/session cap are replaced by a
fresh one-time Telegram review confirmation for the exact action. The action
must still fit every current runtime/user/grant/Privy absolute cap. Therefore
turning automatic execution off can degrade to in-bot review, while global
execute, dedicated worker, route/profile, authority, or emergency gates still
block every server broadcast.

False means no new broadcast; it never means receipt evidence is ignored. New
target copy may say `automatic` only when `can_offer_automatic` is true for that
exact target at render time. The worker may broadcast only when the stricter
`can_auto_broadcast` or `can_execute_confirmed` predicate is true immediately
before submission.

When several conditions are false, render one primary mode using this strict
precedence, while secondary details may list the remaining blockers:

1. submitted/ambiguous evidence -> `Confirming` and reconciliation only;
2. backend `recovery_required` -> `Needs attention`;
3. missing/revoked link, grant, signer, or Privy policy -> `Setup required`;
4. expired/changed route, action, consent, or cap -> `Review a fresh route`;
5. user `desired_enabled=false` -> `Automation off`;
6. Hunch-controlled soft pause/unavailable adapter -> `Waiting for routing to
resume`;
7. stable auto-execution off while confirmed execution remains available ->
   `Review conversion`;
8. all auto gates true -> `Automatic`/execute.

Direct pUSD bypasses this non-direct execution precedence: it waits for and
settles the receipt without a delegated broadcast.

A still-current exact review confirmation replaces only the old automation
consent/session-cap blocker for that one action. It does not override missing
authority, changed route/action semantics, absolute caps, or a system execution
gate. After confirmation, a newly closed global/profile/emergency gate projects
`Waiting for routing to resume`; it does not ask the user to confirm the same
unchanged action again.

### 12.2 OFF-state behavior matrix

Modes such as `Waiting for routing to resume` are Telegram projections over
authoritative funding evidence, not new backend lifecycle states.

The consent effect of an OFF condition is deterministic:

| OFF plane at target selection                                                                                                 | New consent result                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Account Value surface only                                                                                                    | No effect on funding consent                                    |
| Receive creation                                                                                                              | No new target selection or consent                              |
| User preference, stable auto, global/dedicated execute, exact profile, adapter/secrets, emergency pause, or current authority | Exact review-only consent; never silently upgraded on re-enable |
| Route removed or target/action family no longer capability-backed                                                             | Target hidden; no new consent                                   |
| Trading/Buy continuation or Telegram delivery only                                                                            | No change to funding-consent semantics                          |

Direct pUSD always records exact non-automation selection evidence; none of
these rows turns direct settlement into a delegated transaction.

| OFF condition                                                                                           | New bot behavior                                                                                                                                   | Existing receipt with no possible broadcast                                                                                              | Submitted/ambiguous action                                                                                                                                            | When ON/restored                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account Value surface                                                                                   | Hide Balance and return a stable unavailable response; other enabled bot surfaces remain                                                           | Unchanged                                                                                                                                | Reconcile                                                                                                                                                             | Refresh only; no financial action                                                                                                                          |
| Receive creation                                                                                        | Do not create or reveal a new session/target                                                                                                       | Continue observation, routing assessment, reconciliation, recovery, and progress for existing sessions                                   | Reconcile                                                                                                                                                             | New sessions become available; never reuse an expired target promise                                                                                       |
| User `desired_enabled`                                                                                  | Balance and direct pUSD Receive remain; no new delegated broadcast or trade submission; render `Automation off`/`Enable`                           | Preserve receipt and exact consent; render waiting-for-enable                                                                            | Reconcile; never resubmit                                                                                                                                             | May resume only under the soft-resume rules in Section 12.3                                                                                                |
| Telegram stable auto-execution                                                                          | Label a capability-backed routed target `Telegram review required`, persist no automatic consent for a new selection, and keep confirmation in bot | Render `Review conversion`; a fresh exact confirmation may execute only through `can_execute_confirmed`                                  | Reconcile; never resubmit                                                                                                                                             | A receipt with pre-existing still-valid automatic consent may resume only under the soft-resume rules; review-only consent never becomes future automation |
| Global execute, dedicated worker, exact profile, adapter secrets, or emergency pause                    | Do not advertise routed targets as automatic; a new selection is review-only; render `Waiting for routing to resume` for existing eligible funds   | Close any claimed pre-submit attempt as proved non-broadcast cancellation; keep receipt/action; review may be shown but cannot broadcast | Reconcile; never resubmit                                                                                                                                             | Only a pre-pause automatic consent may resume automatically, and only under the soft-resume rules; a selection made while OFF remains review-only          |
| Current link, purpose grant, signer/quorum, or Privy policy missing/revoked/changed                     | Direct receipt and accounting remain; render `Setup required`; do not broadcast                                                                    | Preserve funds/evidence; require fresh authorization and consent/review                                                                  | Reconcile; never resubmit                                                                                                                                             | Hard invalidation: never auto-resume the old authority                                                                                                     |
| Route removed, action semantics/policy fingerprint changed, cap shrank below receipt, or action expired | Hide route from new target selection; render `Review a fresh route` or recovery for existing funds                                                 | Preserve receipt; no use of the old action                                                                                               | Reconcile; never resubmit                                                                                                                                             | Hard invalidation: fresh quote/action plus explicit Telegram review/consent                                                                                |
| Telegram trading/Buy continuation                                                                       | Funding may reach ready; do not create a Buy intent; render enable/unavailable state                                                               | Funding lifecycle continues                                                                                                              | Existing submitted trade reconciles; a confirmation arriving while OFF is rejected and marks its unsubmitted intent cancelled, while untouched drafts expire normally | Never auto-create/submit; user must click a fresh `Review Buy`                                                                                             |
| Chat blocked/unreachable but link remains                                                               | Financial lifecycle continues without transport retries after dead-letter                                                                          | Retain latest progress/terminal projection                                                                                               | Reconcile                                                                                                                                                             | Explicit `/start` rearms exactly one unseen terminal replacement                                                                                           |
| Telegram unlink                                                                                         | Apply both delivery-off and hard-authorization behavior; no new broadcasts or intents                                                              | Observation/reconciliation continue against immutable user/funding evidence                                                              | Reconcile                                                                                                                                                             | Relink restores delivery, but value-moving actions require current grant and the hard-resume rules                                                         |

For a route disabled before target rendering, hide the routed target. If an
address was already displayed or is shared with direct pUSD, an unexpected
non-direct transfer is still observed and shown as waiting/setup/review; it is
never broadcast merely because the address remained valid.

### 12.3 Re-enable and resume rules

Classify transitions before doing anything value-moving:

1. **Soft pause:** only availability changed (`desired_enabled`, stable
   auto-execution, global/dedicated execute, unchanged route/profile gate,
   adapter availability, or emergency pause); signer, grant, policy fingerprint,
   consent, cap, action bytes, and expiry remain identical. An unbroadcast
   planned action or a proved pre-submit-cancelled attempt may create one new
   attempt automatically only if its pre-receipt automatic consent remains
   valid. All eligibility checks rerun immediately before submission.
2. **Hard invalidation:** link/grant revoked, signer/quorum/policy fingerprint
   changed, consent/target/cap semantics changed, route/action semantics
   changed, or action/quote expired. The old action never auto-resumes. Telegram
   obtains fresh authorization where needed, replans, shows fresh economics,
   and requires new explicit consent/review.
3. **Broadcast may have occurred:** `submitted`, `ambiguous`, or any durable
   evidence that submission crossed the provider boundary. No switch transition
   can produce another send. Only lookup, reconciliation, postconditions,
   recovery, or proved failure may advance it.
4. **Trade continuation restored:** readiness never creates a trade intent on
   re-enable. The user must click `Review Buy`, which follows the generation
   rules in Section 5.4 and produces a fresh intent/confirmation.
5. **Delivery restored:** `/start` or relink rearms only the latest unseen
   terminal projection; it does not replay every intermediate update or trigger
   financial execution.

Local fixtures may enable the complete matrix with fake Privy/Relay adapters.
No production policy publication is part of WP8 local implementation.

## 13. Concrete source surfaces

Required backend changes:

- `apps/api/src/routes/telegram-bot-trading.ts`
  - internal Account Value/funding routes and strict schemas;
- `apps/api/src/services/telegram-bot-trading-client.ts`
  - typed internal client and callback handling;
- new `apps/api/src/services/telegram-account-value.ts`
  - pure safe Account Value presenter;
- replace/retire the data-source role of
  `apps/api/src/services/telegram-bot-deposit.ts`
  - retain narrow QR/presentation helpers where useful;
- new `apps/api/src/services/telegram-funding.ts`
  - channel orchestration over existing domain services;
- new `apps/api/src/services/telegram-funding-sessions.ts`
  - persistence for channel context/consent/return-to-Buy;
- new `apps/api/src/services/telegram-funding-authorizations.ts`
  - purpose-scoped immutable funding grant and current Privy-policy facts;
- `apps/api/src/services/api-trading-wallet-signing.ts`
  - exact purpose-signer registry coexistence validation without tolerating
    unknown additional signers;
- new `apps/api/src/funding/execution/delegated-funding-capability-resolver.ts`
  - fresh, exact capability resolution without globally marking wallets as
    delegated;
- `apps/api/src/funding/execution/operation-action-runtime.ts`
  - extract common exact action/attempt validation without making the public
    client endpoint auto-broadcast;
- new `apps/api/src/funding/execution/delegated-funding-action-executor.ts`
  - injected EVM/SVM execution adapters and ambiguous-broadcast handling;
- new `apps/api/src/funding/execution/delegated-funding-action-policy.ts`
  - the single effective automation predicate, blocker precedence,
    soft-vs-hard transition classifier, and session/Telegram/runtime cap checks;
- `apps/api/src/funding/persistence/*`
  - `FOR UPDATE SKIP LOCKED` eligible-step claim, append-only consent revisions,
    dedicated attempt `submission_request_ref_*` correlation, and exact
    attempt/report reuse;
- `apps/finance-worker/src/*`
  - sidecar-safe optional Privy adapters and delegated-execution batch after
    receipt routing and before normal reconciliation;
- funding projection/action-outbox producer and signal-bot delivery services
  - revisioned funding progress projection, edit/replacement fallback, and
    Telegram rendering;
- next forward-only DB migration
  - `telegram_funding_sessions`, `telegram_funding_consents`,
    `telegram_funding_authorizations`, attempt `submission_request_ref_*`, typed
    funding actions, plus lifecycle/retention constraints;
- admin merge, financial deletion, market retention, unlink, admin inspection,
  and cleanup services.

Required frontend changes are limited to the one-time managed authorization
ceremony and optional recovery deep link. The normal successful funding and
Buy journey must not depend on opening `Hunch_App`.

## 14. Local test strategy without a real Telegram bot

### 14.1 Pure unit tests

- Account Value presenter: complete/partial/stale, available vs locked/reserved,
  venue/wallet/in-transit grouping, zero balances, safe labels, no raw IDs;
- Receive and progress renderers for every public session/receipt/operation
  state;
- callback parsing, size limits, malformed/foreign opaque IDs;
- private-chat enforcement for every financial screen/callback;
- exact target/asset/variant consent, including the shared pUSD/USDC.e address;
- null/zero effective cap disables automation; the persisted cap is the minimum
  applicable source-raw bound and cannot be mutated in place;
- non-direct target copy never says `any amount`; it renders automatic and
  absolute-cap consequences without soliciting an expected amount;
- authorization/cap matrix for EVM/Solana/PM Funding Router, including proof
  that product preference and ordinary wallet signing modes grant nothing;
- exact immutable-action fingerprint checks;
- transition-to-progress-action mapping and dedupe;
- fresh Buy continuation and insufficient/excess deposit calculations.

### 14.2 API/service tests with fakes

- internal-token authorization;
- Telegram identity ownership and cross-user IDOR rejection;
- exact destination ambiguity fails closed;
- unexpected asset at a selected/shared address is observed but never
  delegated-broadcast without matching pre-existing consent;
- Receive Session replay/reopen/cancel;
- fake canonical receipt creates the expected child operation;
- fake Privy EVM/Solana executor captures only the exact committed action;
- accepted, submitted, ambiguous, definitive failure, retry, and revoke paths;
- all combinations of global execute, dedicated execution, profile, runtime,
  and emergency gates, with broadcast possible only when every gate allows it;
- stable auto-execution OFF excludes automatic broadcast but still permits one
  exact reviewed broadcast when `can_execute_confirmed` is true; global/profile/
  emergency OFF blocks both predicates;
- known trading and funding purpose signers coexist and revoke independently,
  while unknown/duplicate/multi-policy signers remain unsafe;
- bot callback capture returns the correct edit/send actions without calling
  Telegram;
- `desired_enabled=false` produces `Automation off`/enable state, not setup,
  accidental web default, or server broadcast;
- missing/revoked/stale delegated profile never causes the capability resolver
  to emit a delegated executor;
- group-chat callbacks disclose no balance/address and produce only a private
  bot CTA;

### 14.3 Database integration tests

- channel context uniqueness/idempotency, append-only consent CAS, and proof
  that consent created after receipt observation cannot authorize it;
- active session survives API, bot, and worker restart;
- duplicate canonical EVM/Solana event creates one receipt;
- multi-worker delegated-step claim creates one attempt;
- ambiguous broadcast prevents a second attempt;
- durable provider request identity exists before the external call and is
  distinct from the later transaction/receipt reference;
- unlink sets the account foreign key null and blocks new broadcasts while
  receipt observation/reconciliation and revoked grant evidence continue;
- receipt -> child operation -> delegated attempt -> reconciliation -> ready;
- late receipt and recovery window;
- unlink, merge, deletion protection, retention, cleanup, and funding action
  outbox replay;
- duplicate Return-to-Buy callbacks reuse one generation; after its intent is
  terminal, a later explicit click advances the generation and creates one new
  fresh intent;
- deleted/stale progress message falls back to a replacement/terminal send;
- blocked delivery becomes dead without retry spin, then `/start`/relink rearms
  exactly one replacement for the latest unseen terminal revision;
- action TTL expiry requires fresh quote/consent and never silently rebuilds;
- active financial context blocks unsafe merge and protects its market
  reference until cleanup.

### 14.4 Fixture journeys

Run the full journey using local Postgres/Redis where available and injected
fixture adapters, never public RPC/Relay/Privy/Telegram:

1. PM pUSD direct receive -> ready -> fresh Buy review.
2. PM USDC.e receipt -> exact Funding Router fake execution -> pUSD ready ->
   fresh Buy review.
3. Base USDC receipt -> Relay EVM fake execution/reconciliation -> pUSD ready.
4. Solana USDC receipt -> Relay SVM fake execution/reconciliation -> pUSD ready.
5. Route outside caps -> fresh Telegram Review/consent -> confirm -> delegated
   execution of the newly committed exact action.
6. Policy revoked between quote and broadcast -> no broadcast, funds retained,
   `Setup required` state.
7. `desired_enabled=false` -> direct receipt still settles; conversion waits for
   in-bot enable, and no web handoff or broadcast occurs merely because the
   preference is off.
8. Worker crash immediately before and after provider acceptance -> no duplicate
   transaction.
9. User selects Polygon pUSD but sends USDC.e to the shared address -> receipt
   observed, no automatic Funding Router broadcast.
10. Solana USDC wallet has zero SOL -> no false automatic promise or broadcast;
    sender fee requirement/review is rendered until fee strategy is proven.
11. Original Telegram progress message is deleted -> terminal ready/recovery
    arrives as a replacement message.
12. Automation cap is null or a policy/user/grant cap shrinks -> no unlimited
    execution; a new append-only consent revision is required.
13. Trading and PM Funding Router signers are both attached -> each inspector
    accepts only its exact registry entry; revoking funding leaves trading
    valid.
14. Global finance execute is false while the dedicated flag is true -> no
    broadcast; observation/reconciliation still run.
15. A resumed Buy intent expires -> duplicate old callback reuses the terminal
    generation, while a later explicit `Review Buy` advances once and creates a
    fresh intent.
16. Bot is blocked at readiness, then the user sends `/start` -> exactly one
    replacement terminal card is delivered from the retained projection.
17. Receive creation turns off with an existing session -> no new target opens,
    while its late receipt, progress, reconciliation, and recovery continue.
18. Global/dedicated execution soft-pauses before submit, then restores with
    identical grant/policy/consent/action -> the pre-submit attempt is proved
    cancelled and exactly one fresh attempt may resume.
19. Grant/policy fingerprint changes while paused, then availability restores ->
    the old action never auto-resumes; fresh setup/review is required.
20. Every product/execution switch turns off after provider acceptance -> no
    second send; provider lookup and reconciliation still reach terminal state.
21. Buy continuation restores after funding became ready -> no intent appears
    until the user explicitly clicks a fresh `Review Buy`.
22. Stable auto-execution is OFF while all confirmed-execution gates are ON ->
    target promises Telegram review, receipt waits for review, and one exact
    confirmation executes without web.
23. Stable auto-execution and global execute are OFF -> review may display, but
    confirmation cannot broadcast until the global soft pause is restored.

### 14.5 Static and package checks

- API and finance-worker typecheck/lint/format;
- focused funding, Telegram, notification, lifecycle, and retention suites;
- frontend typecheck only if managed-setup contracts change;
- import-graph test proving finance-worker does not reach API-wide required
  secrets;
- deterministic duplication audit over new Telegram presenter/orchestrator and
  delegated executor boundaries;
- no network, real bot, Docker, production DB, or wallet calls unless separately
  authorized later.

## 15. Implementation sequence

### Slice A0 — private Account Value surface

1. Add the pure Account Value presenter and compact Balance message.
2. Add internal account route/client/callback and strict private-chat gate.
3. Reuse the presenter in balance, shortfall, ready, and post-trade views.
4. Cover complete/partial/stale, available/locked/reserved, Limitless, wallet,
   and in-transit states without a real Telegram bot, including independent
   Account Value surface and `desired_enabled` OFF behavior.

Exit: a local callback fixture renders the same accounting truth as web and
discloses nothing in group chat. This is the first implementation slice because
it delivers immediate user value without any new value-moving authority.

### Slice A1 — direct pUSD Receive and durable progress

1. Add `telegram_funding_sessions` with nullable unlink-safe account reference,
   return context, retained historical evidence, and lifecycle guards; add
   `telegram_funding_consents` for append-only exact target/asset/variant/cap
   revisions.
2. Add Telegram funding orchestration over Receive Session open/read/select/
   cancel; replace the deposit tile's bespoke address data source.
3. Render the verified Polygon pUSD direct target, native-fee facts, and QR/copy
   actions; keep unsupported variants accurately labelled.
4. Add revisioned durable progress action outbox with edit/replacement/terminal
   delivery projection and `/start`/relink terminal rearming.
5. Prove receipt allocation, readiness, late receipt, unlink, restart, deleted
   message, Receive-creation OFF, merge, retention, and cleanup behavior.

Exit: complete local `pUSD receive -> destination ready` journey, without a real
bot, delegated signer, route transaction, or web handoff.

### Slice B — fresh Buy continuation

1. Implement one active `buy_return_context` per session; newest explicit Buy
   supersedes older return context without affecting funds.
2. At readiness render only an idempotent, scoped `Review Buy` callback; model
   explicit resume generations.
3. On that callback atomically create/reuse one fresh quote/Telegram Buy intent
   per generation and reuse ordinary preview/final confirmation.
4. Prove insufficient, sufficient, excess, expiry, callback replay, retry, and
   restart paths, including Buy-continuation OFF/restore without automatic
   intent creation.

Exit: complete local `pUSD -> ready -> user Review Buy -> fresh confirmable PM
Buy` journey. Readiness never submits an order automatically.

### Slice C — delegated security foundation and PM Funding Router

1. Add purpose-scoped `telegram_funding_authorizations` and the fresh
   `DelegatedFundingCapabilityResolver`; preference/wallet ownership alone must
   never yield a delegated actor.
2. Add the exact purpose-signer/quorum/policy registry and make trading/funding
   inspection coexist without accepting unknown additional signers.
3. Extract sidecar-safe immutable action, finite effective cap, policy, and
   attempt validation; define a separate EVM executor ID and a secret/config
   bundle that is optional at worker boot but mandatory for delegated claiming.
4. Implement the single effective automation predicate, OFF-mode projection,
   strict blocker precedence, and soft-vs-hard resume classifier from Section 12.
5. Add atomic eligible-step claim + attempt, a distinct durable pre-submit EVM
   provider request ID, lookup-before-retry, ambiguous outcome, and action-TTL
   contracts.
6. Order the local worker batch as observer/router -> delegated executor ->
   reconciliation and use an injected fake Privy EVM adapter.
7. Reuse/extend exact PM Funding Router envelope validation, persist exact
   USDC.e consent, and prove automatic-within-caps plus Review-in-Telegram.

Exit: complete fake-adapter `USDC.e -> pUSD -> fresh PM Buy` journey with no web
execution and a green crash/idempotency/import-graph suite. This is not a live
Privy activation claim.

### Slice D — Relay EVM from Base USDC

1. Prove that the actual Relay Base target/spender envelope is finite and
   expressible by the intended Privy outer policy; otherwise retain bot review.
2. Add the exact Relay EVM delegated profile and enable only capability-backed
   Base USDC targets in local policy.
3. Prove quote/commit/fake broadcast/reconciliation/destination readiness.
4. Prove cap, expiry, policy-revocation, refund/recovery, and ambiguous paths.

Exit: complete fake-adapter `Base USDC -> Relay -> pUSD -> fresh PM Buy`
journey. Relay Deposit Address is not used in this flow.

### Slice E — Relay SVM from Solana USDC

1. Decide and model an explicit bounded fee-payer/gas strategy; test the zero
   SOL wallet path before advertising a USDC-only journey.
2. Complete Privy Solana outer-policy expressiveness and server submission/
   lookup/idempotency gates, including blockhash-expiry behavior.
3. Add an isolated sidecar-safe Solana adapter and exact instruction/account/
   mint/amount validator.
4. Enable only capability-backed Solana USDC targets in local policy and prove
   restart/unknown-outcome safety with a fake adapter.

Exit: complete fake-adapter `Solana USDC -> Relay -> pUSD -> fresh PM Buy`
journey only after all three gates pass. Otherwise the receive target shows its
0.003 SOL requirement and an explicit unavailable/recovery state; a Telegram
review is not presented as executable, and the route never inherits a broad
delegated signer grant.

### Slice F — future Limitless expansion (outside this normative package)

This is a follow-on WP after the Polymarket package is green. The current pass
ends at Limitless Account Value visibility; it does not implement Limitless
funding or delegated trading. Future work may:

- retain cross-venue balance visibility;
- add Limitless Base USDC direct receive;
- add a distinct Limitless funding/trading authorization profile;
- AMM BUY before CLOB delegated execution;
- preserve web handoff only for unsupported/recovery cases.

## 16. Exit criteria and activation boundary

### 16.1 Local implementation package

The local WP8 primitives are complete when:

- Telegram renders the same Account Value accounting truth as web;
- private-chat and exact target/asset/variant consent boundaries are proved;
- every automatic route has a positive finite source-raw cap; null means
  disabled and later consent cannot retroactively authorize an observed receipt;
- fixture capabilities can represent the intended Polymarket receive matrix
  without promising unavailable variants at runtime;
- direct and routed receipts survive retry/restart without duplication;
- fake supported stable routes execute through the durable delegated executor
  only when the exact fresh funding grant/profile/caps allow;
- out-of-cap routes are reviewable and confirmable inside Telegram;
- destination pUSD readiness, not provider acceptance, unlocks continuation;
- continuation always creates a fresh quote/intent and final confirmation;
- Return-to-Buy generations permit a later explicit retry without callback
  replay creating duplicate intents;
- the latest terminal progress revision can be rearmed once after `/start` or
  relink;
- disabled/revoked policy fails closed while preserving funds and recovery;
- every OFF combination resolves through the Section 12 precedence to one
  deterministic primary bot mode; observation/reconciliation never depend on
  execution availability;
- soft resume can create at most one fresh attempt from proved non-broadcast
  state, while hard invalidation never reuses old authority/action;
- all tests run without a real Telegram bot or public financial service;
- every new runtime/production control remains off;
- no legacy reconciliation or recovery path is removed.

### 16.2 Per-route activation gate

Local fake-adapter success does not make a route ready for production. Each
Funding Router, Relay EVM, and Relay SVM profile separately requires:

- an explicit current Privy policy whose real serialized form was verified;
- exact grant/profile resolution immediately before broadcast;
- a verified purpose-signer/quorum/policy topology that coexists with trading
  without an omnibus policy;
- provider submission correlation, timeout/crash recovery, and ambiguous
  outcome behavior proved for the real adapter;
- action-envelope/policy expressiveness proved for the real route;
- finite caps, historical revoke evidence, global plus dedicated execution
  gates, emergency pause, audit, and runtime policy configured;
- a separately authorized production rehearsal and activation decision.

Solana additionally requires the explicit fee-payer strategy and safe blockhash
expiry contract. Until then, its local fake journey is architecture proof only.

## 17. Explicitly out of scope for this implementation pass

- production deployment or runtime-policy publication;
- creating/editing real Privy Dashboard policies;
- real Telegram Bot API calls;
- real Relay/Privy/RPC transaction execution;
- native SOL automatic sale;
- arbitrary tokens, networks, providers, or user-supplied routes;
- automatic trade submission after funding;
- Limitless receive/funding or delegated CLOB/AMM execution; current pass is
  Account Value visibility only;
- deletion of web/legacy fallback paths;
- a generic workflow engine or second funding state machine.

## 18. Independent sanity-review record

Four independent implementation reviews challenged this appendix against the
current Receive/Telegram/Privy/worker surfaces. The following corrections were
accepted into the normative plan:

- replace address/session-wide automation with exact target + asset + internal
  variant consent, because one Polygon address may receive both pUSD and
  USDC.e and `selectedReceiveTargetId` is presentation-only;
- make every financial Telegram surface private-chat only;
- treat `desired_enabled` as preference and introduce a fresh, purpose-scoped
  funding capability resolver rather than globally adding
  `privy_delegated` to internal wallets;
- make unlink survivable for financial observation while blocking delivery and
  new broadcasts until a current link/grant exists;
- formalize atomic worker claim, attempt-before-broadcast, EVM reference lookup,
  ambiguous outcome, action TTL, and sidecar-secret/import boundaries;
- extend the revisioned bot action outbox instead of pretending the existing
  send-only generic notification outbox can maintain one editable progress
  message;
- require a user `Review Buy` callback after readiness before creating a fresh
  trade intent;
- stop promising Solana USDC-only routing until both the 0.003 SOL fee-payer
  problem and Privy submission/policy recovery contracts are solved;
- split local fake-adapter completeness from real Privy/Relay route activation.

The final Sol review used a frozen finite-constraint model after strict model
critique and added these source-backed corrections:

- every automatic consent has a positive effective raw cap; null is disabled,
  and consent revisions are append-only/non-retroactive;
- purpose-specific funding signers must coexist with the current trading
  inspector through an exact known registry, never an omnibus policy;
- worker broadcast requires both the global execute kill switch and the
  dedicated/profile/runtime gates;
- provider request correlation is stored before submission and is distinct
  from the later transaction/receipt reference;
- Return-to-Buy uses explicit retryable generations;
- the latest terminal progress projection is retained and rearmed once after
  `/start` or relink;
- funding authorization remains revoked historical evidence across unlink;
- Limitless execution is a future follow-on, not part of current WP8 exit.

A final whole-plan policy-state and ambiguity audit then made the following
normative clarifications:

- separated pre-receipt `can_offer_automatic`, receipt/action-level
  `can_auto_broadcast`, and one-action `can_execute_confirmed`; target rendering
  can no longer depend on receipt/action facts that do not yet exist;
- fixed consent at target-selection time: any closed offer gate writes
  review-only consent, and later ON never silently upgrades it;
- retained automatic soft resume only for exact automatic consent created
  before the pause, with all facts unchanged and no possible prior broadcast;
- made a Telegram review application consent rather than a wallet signature or
  substitute for a missing delegated executor/policy/fee-payer contract;
- removed a contradictory mutable target field from
  `telegram_funding_sessions`; exact target state exists only in append-only
  `telegram_funding_consents`, selected by `active_consent_revision`;
- locked one deterministic blocker precedence, notification-outbox owner,
  endpoint set, persistence split, worker owner, and Limitless boundary instead
  of leaving implementation alternatives.

Three finite-domain checks were frozen and strictly critiqued. The first
execution-mode check exposed a counterexample in which a review could appear to
override a closed global execution gate; the predicate and precedence were
corrected. In the final execution model, unsafe automatic broadcast, unsafe
confirmed broadcast, resubmission after possible broadcast, and blocking direct
pUSD with an execution gate were all impossible, while valid proved soft resume
remained reachable. The independent surface/delivery model made Balance leakage
while OFF, Receive creation while OFF, stopping existing financial lifecycle,
Buy review while its gates were OFF, and notification rearm without restoration
or an unseen terminal impossible. The selection-time model made silent consent
upgrade and post-broadcast resubmission impossible while preserving a valid
pre-pause resume path.

The model warning is important: finite solver fractions are not real-world
probabilities. Only satisfiability, logical query status, and witness
assignments were used.

Three tempting additions were deliberately deferred for KISS:

- manual expected-amount/rate entry in generic Add Funds; the session remains
  amount-free and Buy already supplies its intended spend;
- cumulative/day limits in the first delegated slice; per-operation/session
  caps ship first, while a future cumulative limit requires its own atomic cap
  reservation ledger;
- a separate provider-request service/table. WP8 uses the dedicated immutable
  `submission_request_ref_*` attempt fields defined in Section 8.2.

The resulting product rule is simple: after the one-time explicit delegation
ceremony, supported flows complete in Telegram. A conversion review and Buy
confirmation are Telegram callbacks. The Telegram Mini App appears only to
create or repair signing authorization. Ordinary Hunch web is offered only for
recovery that neither the bot nor that ceremony can safely express; an OFF gate
or reviewable action never defaults to web.
