# WP8 appendix — Telegram-native Account Value, Receive, Relay, and Buy continuation

Status: implementation plan; local-only delivery first; no production activation.

### Slice C profile specialization

The first implemented delegated profile,
`polymarket_deposit_usdce_wrap_v1`, is a closed-destination transform. The
rules below supersede generic cap/review language elsewhere in this plan for
that profile only:

- one prospective Polygon USDC.e receipt becomes one operation, one attempt,
  and one Router `fund(expectedNonce, totalAmount, 0)` call for the full raw
  receipt;
- there is no amount cap, conversion quote, rate, slippage, minimum-output
  check, conversion confirmation, or action TTL for this exact wrap;
- temporary Hunch/user availability changes preserve the same unbroadcast
  `started` attempt for later revalidation; they do not terminalize it or
  create a replacement attempt;
- revoked/changed authority, route, action bytes, or runtime contract is hard
  invalidation and can only fail an attempt proved not to have broadcast;
- once broadcast may have occurred, only exact idempotent lookup/recovery and
  reconciliation may advance the attempt; and
- pUSD readiness leads to a separate fresh `Review Buy` and `Confirm`. Funding
  readiness never submits a trade automatically.

Finite caps and Telegram conversion review remain requirements for future
routed-value-movement profiles unless their own closed-destination proof
explicitly replaces them.

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
  asset/network/target variant. Only that immutable scope may be routed,
  provided the user also has a current delegated funding authorization. The
  Slice C profile binds this scope to the full prospective receipt rather than
  to an amount cap.
- Future economically variable routes outside their frozen automation caps do
  not auto-execute and require exact refreshed Telegram review. Slice C has no
  conversion economics or conversion confirmation.
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
   Session. The legacy Telegram address resolver and callback QR/photo renderer
   are absent; they cannot become a second receive lifecycle.
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
  confirmed asset/network, amount, generic in-transit state
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
- Slice A0 exports reusable Account Value presentation primitives and uses them
  for the Balance tile. Existing Buy shortfall remains an Intent Liquidity
  result and is not replaced by Account Value;
- funding-ready and post-trade surfaces reuse those primitives when their
  durable A1/B projections exist. Exact route/provider/current-stage labels are
  owned by that funding-session projection, not inferred from A0 Account Value.

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
- `SOL on Solana — review conversion` only as a future, independently gated
  route; standalone funding opens `Convert to USDC`, while a Trade includes the
  same bounded conversion in its one quoted Review/Confirm.

Telegram funding integrates those routes through one registry keyed by the
frozen `routeKey` and execution `profileId`. A capability-sized adapter owns
target discovery, exact consent validation, current capability/authority,
managed-controller validation, automatic-policy construction, chain-cursor
preparation, and the exact receipt amount/quote plan plus execution binding.
The session, projector, delivery outbox, and receipt router
consume only the generic adapter result. Adding Base, Solana, or another venue
therefore means adding and registering an adapter plus fixtures; it must not add
network/provider branches to those durable state machines.

The receipt-facing adapter contract returns exactly one provider-neutral
disposition: `direct`, `automatic_execution`, `review_required`, or
`hard_invalid`. For execution/review it also returns the exact quote plan; for
`review_required` it returns a frozen action label and fresh-quote continuation
descriptor. The generic router only persists and routes those facts. Native
reserve economics, provider error classification, and venue predecessor
serialization remain adapter hooks. Core does not import Relay, Solana, or
venue policy code. This makes the future SOL route a
registration/configuration task, not another receipt state machine.
Provider/RPC-derived account and route facts are prepared before receipt or
Telegram lifecycle locks. Confirm then reacquires the exact context/receipt,
locks only durable DB facts through one supplied client, checks a fresh DB
clock against every frozen deadline, and atomically consumes/links the quote.
The locked callback must never re-enter the global pool or a provider client.
Likewise, `review_required` is actionable evidence, not a label: continuation
and quote plan are written together, otherwise the receipt becomes
`recovery_required`.
Until such an adapter is registered, the venue is absent from the Receive
picker and every stale/forged legacy `deposit:<venue>` or
`deposit_qr:<venue>` callback returns an address-free unavailable card. The
internal deposit endpoint and legacy builder enforce the same rule, so a hidden
button is not the security boundary. The legacy builder contains no wallet,
RPC, address-resolution, or QR transport dependency.

The product distinguishes stable routing from volatile conversion. A supported
stablecoin may be converted automatically to the underlying stable accepted by
the selected venue. A non-stable asset is never covered by that implicit
stable-conversion consent. In a standalone Deposit/Account Value flow, the
surface shows a separate `Convert to <venue stable>` action, a fresh
amount/fee/slippage preview, and an explicit user confirmation before commit.
Wallet/account surfaces should keep `Deposit funds` and `Convert to USDC` (or
the venue-specific stable) as separate primary choices so a user never has to
understand internal routes, policies, grants, or signers. In an already-started
Trade flow, the fresh trade quote includes the volatile conversion, the Review
surface explicitly says what will be converted and its bounds, and the existing
trade `Confirm` authorizes the complete route; there is no second conversion
prompt that could let the quote expire.

Every standalone Convert continuation is receipt-specific. If multiple
volatile receipts await review, the bot exposes one deterministic oldest
receipt at a time rather than hiding every CTA or guessing a context-wide
target. Telegram callback delivery is at-least-once: quote issuance persists
the exact message and consent token under the callback idempotency key in the
same lifecycle/receipt transaction. An exact replay returns that response;
reuse for a different receipt/message is an idempotency conflict.

Selecting a target persists immutable consent to the exact asset, network,
destination, and internal variant IDs before revealing the address as
auto-routable. This is required because pUSD and USDC.e may share the same
Polygon target address and the receive observer intentionally scans all
variants. An unexpected asset can be observed and credited, but it cannot
inherit automation consent from the selected address.

For a V2 automatic selection, persistence re-resolves and locks the exact
funding authorization, Telegram link, wallet, user preference, and Funding
Policy revision inside the consent transaction. A capability result obtained
before chain-cursor refresh is presentation/preflight only; it cannot authorize
the append-only consent if authority changes before commit.

For a Receive Session opened from a Buy shortfall, every address and waiting
surface must also answer how much to send. The immutable Buy amount is the
destination requirement; a fresh Buy quote supplies maximum spend and current
destination readiness supplies the executable balance. Direct Polygon pUSD
therefore shows the nominal order, current maximum spend, available pUSD, and
the pUSD shortfall rounded up for display. Generic Add Funds remains
amount-free.

Future activated source assets use the same destination requirement. A stable
route supplies an exact source amount and its asset selection is sufficient
consent for the bounded automatic stable conversion. A volatile route supplies
a clearly labelled current estimate plus expiry. Standalone funding requires
the separate `Convert to <venue stable>` review/confirmation described above;
an already-started Trade uses its one composite quoted Review/Confirm.
Execution remains bounded by the route's fee, slippage, minimum-output, cap,
and recovery policy. An
underfunded transfer keeps waiting for the remainder, while excess destination
value remains in Account Value. If a safe source quote is unavailable, the bot
shows an explicit unavailable/Refresh state and never invents an amount.
This paragraph applies to future economically variable routes. Slice C always
uses the exact full observed USDC.e receipt, has no conversion economics, and
does not wait for a requested remainder.
The live picker/address/progress card owns this dynamic amount guidance. QR is
an edit of that same durable card, not a separately sent photo, so revocation
has one known Telegram message to redact and no second address-bearing surface.
Address-bearing payloads are valid only for `funding_edit`/`funding_qr` against
that retained immutable message ID. Both application validation and a DB check
forbid an address in `funding_send` or `funding_replacement`. If Telegram says
the edit target is missing/non-editable, the address attempt stops fail-closed;
it never falls back to a new untrackable message. Address-free terminal cards
may still use a tracked replacement send.

This contract does not activate native SOL. Solana USDC and a future reviewed
SOL-to-venue-stable route remain hidden until their exact capability, fee-payer,
policy, quote, confirmation, and recovery gates are independently enabled. SOL
must never inherit the automatic-stable consent merely because it reaches the
same Relay destination.

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
progress stages. Economically variable non-direct targets also display their
frozen maximum fee/slippage caps; Slice C does not display invented economics.
A target whose receipt can still be safely observed but whose execution
predicate is false says the exact mode from Section 12 rather than promising
routing. A route removed from receive/runtime policy is hidden from new target
selection; funds already sent remain observable and recoverable.

Economically variable routed targets must not reuse a generic `You can send any
amount` instruction: they show their positive automatic raw cap and the
out-of-cap consequence. Slice C is the explicit exception: every positive
prospective USDC.e receipt is wrapped in full without a conversion review or
amount cap. Direct pUSD remains amount-free because it needs no conversion
transaction.

### 5.3 Funding progress

One logical Telegram progress card reflects backend state. Editing the current
message is best effort; a durable action outbox sends a replacement or terminal
message when the original was deleted, became stale, or cannot be edited.
Address and QR renders have exactly one egress: the durable delivery worker.
Interactive callbacks may request a projection, but their API response contains
only an address-free queued acknowledgement. The worker alone requests the
explicit internal `delivery` view after rechecking the current wallet,
authorization, frozen Funding Policy revision, and lifecycle locks.
Immediately before an address/QR edit, the worker persists a pessimistic
disclosure-attempt watermark while those locks are held. Confirmed Telegram
address delivery is a second watermark. Confirmed address-free edit of the same
immutable `address_disclosure_message_id` is a third, explicit redaction
watermark; an edit of another card is not proof. A crash or
ambiguous response therefore leaves a durable redaction obligation; a new send
or replacement cannot clear it, relink re-arms only the known address-free
edit, and retention cannot delete the context until that edit is confirmed.
Cancel uses the lifecycle fence and the final pre-egress CAS requires an open,
unexpired Receive Session. Migration preflight blocks historical attempted
disclosures that have no known edit target.

The QR is part of that same edit, never a separate photo. Telegram text QR uses
Unicode 2×2 quadrant glyphs so two modules fit in each axis per character; the
bounded width is covered by presentation tests.

| Backend evidence                     | Telegram state                                         |
| ------------------------------------ | ------------------------------------------------------ |
| open, no receipt                     | Waiting for transfer                                   |
| canonical receipt allocated          | Funds received                                         |
| child operation committed            | Preparing conversion                                   |
| delegated attempt started/submitted  | Routing funds                                          |
| chain/provider receipt pending       | Confirming                                             |
| destination postconditions satisfied | pUSD ready                                             |
| future route economics exceed caps   | Review conversion                                      |
| user master preference off           | Automation off; enable in Telegram                     |
| Hunch execution soft-paused          | Waiting for routing to resume                          |
| grant/policy missing or revoked      | Setup required                                         |
| action/route semantics invalidated   | Review a fresh route                                   |
| retryable provider/RPC failure       | Retrying; show last safe stage                         |
| ambiguous broadcast                  | Confirming; never offer a second submit                |
| recovery required                    | Needs attention; show bot actions or last-resort Hunch |

The message renderer reads public session/operation summaries. It does not
infer success from a Privy or Relay response. Once an attempt's durable
`broadcast_may_have_occurred` boundary is set, current capability flags cannot
project that routing receipt back to a pre-broadcast wait or terminal state.
The projector candidate query observes this attempt-only transition directly;
it wakes once even if the Receive Session version is unchanged, then stops
selecting the context after the persisted state becomes `converting`.

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
- allowed action kinds, assets, destination venues, and any profile-specific
  cap (none for the Slice C closed-destination transform);
- expiry, revoke state, and later a separate atomic cumulative-cap ledger if
  daily limits become a product requirement.

Funding authorization is durable financial evidence, not disposable link
state. Unlink first revokes it, then nulls any live account foreign key while
retaining immutable user/Telegram IDs, grant fingerprint, signer/quorum/policy
IDs, authorization signature/reference, and timestamps. Operations/attempts
retain the exact grant revision/fingerprint they used. Never copy the existing
trade-authorization `ON DELETE CASCADE` pattern for this evidence. Fresh
execution resolution still requires the current linked private account.

The first delegated slice deliberately has no amount cap: exact full-receipt
calldata and the non-redirectable destination are its security boundary. It
must not claim daily/cumulative protection until an atomic reservation ledger
exists; a future capped profile would have to retain an ambiguous reservation
until resolution.

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

For a generic capped automatic revision, `max_auto_execute_source_raw` is
positive and equals the minimum applicable bound. Slice C V2 is the only
implemented unlimited exception: `automation_enabled=true`, a null cap, and an
exact `polymarket_usdce_full_receipt_wrap`/`fullReceipt=true` policy snapshot
mean the entire prospective receipt. For every other automatic policy, null
means disabled. Direct pUSD selection may have an exact revision with
automation disabled because it needs no route. The snapshot also freezes its
presentation mode and exact user-visible route copy (labels, button,
settlement, and instructions). Live capability may restrict or hide that
presentation, but must never expand a direct-only revision into automatic
USDC.e consent or relabel an existing consent. The one-time 0206 migration
derives v2 presentation only from the mode already frozen in the same consent
and upgrades its retained current/terminal/outbox projections atomically.
Runtime parsing rejects v1 and missing/malformed presentation; it never
reconstructs historical copy from live route constants.

Creating the revision and compare-and-setting `active_consent_revision` is one
transaction. Changing target, asset, variant scope, or cap appends another
revision and never rewrites history. During delegated eligibility, select the
latest exact matching consent whose `consented_at` is no later than the
canonical event's immutable `first_observed_at`, then persist that consent ID/fingerprint in
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
authorization and therefore fail closed. The unlink transaction first revokes
the account-bound active funding grant, then deletes the link. Authorization
grant and link/relink/unlink take the same per-user advisory transaction lock,
so no grant can be inserted between the revocation scan and link deletion;
relinking cannot inherit or be blocked by that stale grant.

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
  -> atomically proves operation Funding Policy revision equals frozen consent
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

When the internal Slice C profile is requested, the normal planner emits an
exact receipt-only venue-preparation plan rather than the ordinary user-wallet
plan: requested source is the full USDC.e receipt, the single step is `planned`,
and its executor is `polymarket_deposit_usdce_wrap_v1`. Receipt linkage verifies
those facts before activating the step. The router locks the still-observed
receipt before insertion and commits the operation, exact receipt attachment,
canonical source-credit evidence, and step activation in the same transaction.
Losing the receipt claim or failing exact-plan validation therefore cannot
leave an unresolved orphan operation.

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

Use one Hunch automation signer and one combined policy per wallet chain family.
Privy permits only one override policy ID for an additional signer, so the EVM
policy contains separate strict BUY, SELL, capped trade-funding, and delegated
execution rules. EVM and Solana remain separate policy objects because their
rule schemas and `chain_type` differ, but they may reuse the same authorization
quorum/key.

The finite signer registry therefore binds the existing Hunch automation
signer to the exact wallet/chain, combined policy ID, quorum fingerprint, and
complete policy fingerprint. The application keeps trading and funding grants
as separate revocable authorities; it does not create another Privy signer for
each purpose. Unknown, duplicate, malformed, multi-policy, or second Hunch
signers still fail closed. Legacy BUY/SELL policy IDs are recognized only long
enough for the managed setup to replace an old binding with the combined EVM
policy.

Runtime verification is symmetric: a funding broadcast live-checks the shared
signer against its exact public key/quorum fingerprint and attached combined
policy fingerprint, then verifies the exact route rule. Merely recognizing a
signer and policy ID is insufficient.

1. `telegram_pm_funding_router_v1`
   - Polygon only;
   - exact Funding Router contract;
   - implemented by Slice C as `polymarket_deposit_usdce_wrap_v1` with exact
     `fund(expectedNonce, totalAmount, 0)` semantics;
   - `totalAmount` is the backend-frozen full receipt and is intentionally
     unrestricted by the key policy because the Router has no caller-selected
     destination; see
     [the Slice C runbook](./slice-c-delegated-funding-executor.md);
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
   - Solana USDC source initially, automatic only as a stable-to-stable route;
   - future native SOL source is a separately advertised reviewed
     `Convert to USDC` route with a fresh quote and explicit confirmation;
   - exact wallet, mint, amount, program/account allowlist, blockhash/expiry,
     and committed instruction bytes;
   - no native SOL route in the automatic-stable slice and no reuse of a USDC
     consent for SOL;
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

Use a separate profile gate for each executor. Slice C uses
`HUNCH_FUNDING_PM_WRAP_EXECUTE=false` and the existing optional Hunch automation
signer secret plus the combined EVM policy ID/fingerprint.
Broadcast requires both it and `HUNCH_FINANCE_EXECUTE=true`, plus the exact
profile, funding runtime policy, grant, and Privy fingerprint checks. The
general flag alone never enables delegation, and a profile gate never bypasses
the global kill switch. The delegated adapter import graph must not reach
API-wide env, `privy-service.ts`, `embedded-ethereum.ts`, or
`embedded-solana.ts`; extract sidecar-safe pure clients/validators instead.

When delegated funding is disabled or any required secret/profile is absent,
the worker continues observation/reconciliation, does not claim delegated
steps, and reports the action as unavailable. It must still boot successfully.
An execution-flag or current profile-ID rollback does not unmount recovery for
an already-crossed boundary: it uses the persisted signer/policy identity and
the same provider idempotency key while the separate recovery credentials
remain available. Provider failure labels without an exact transaction hash
are not proof that broadcast was impossible.

For same-cycle progress, order the worker batch as receive observation and
receipt routing, then delegated claim/execution, then ordinary reconciliation.
This lets a newly created child step execute in the same scheduled run without
a busy loop while preserving the existing reconciliation authority. No fixed
latency promise is made until measured; the design must add no avoidable extra
worker interval between these phases.
Receipt routing must keep `reconcile_required` and automatic-evidence
`recovery_required` children attached and pending; only a manual/non-automatic
recovery mode is terminal receipt recovery. The worker schema-readiness gate
must require an atomic migration-0204 marker before entering this pipeline.

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

While the receipt's exact quote is still live, another Review callback reuses
that financial quote and response even when Telegram moved the card to a new
message. The new callback keeps its own delivery fingerprint/idempotency row;
message identity never replaces a live financial quote or invalidates an
already-visible confirmation token.

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
| `funding/session`        | Read the current channel projection by opaque Telegram funding context ID; address-bearing rendering is reserved for the durable worker's internal `delivery` view                                      |
| `funding/select-target`  | Validate one exact target+asset from the frozen session, append/CAS its consent revision, queue its durable address/copy/QR projection, and return no address to the interactive callback               |
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

Every new WP8 creation or execution control defaults off in source and
production fallback policy. The read-only Account Value surface is not an
execution control: for an exactly linked user in their own private chat it
remains available regardless of trading, funding-creation, Relay, automation,
or `desired_enabled` state. It returns `Unavailable` only when the link or
canonical projection cannot be resolved. The existing global finance execute
switch retains its configured value but is necessary and never sufficient for
delegated funding.

### 12.1 Independent controls and effective predicate

Required independent semantic controls:

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
Telegram value-moving product availability, managed authorization targets,
confirmation, and per-user caps. Privy policies own the outer signing boundary.
These control planes must remain explicit and must not infer one another. None
of them gates read-only Account Value visibility.

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
later ON transitions never mutate it or its address presentation into automatic
consent.

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
| Receive creation                                                                                                              | No new target selection or consent                              |
| User preference, stable auto, global/dedicated execute, exact profile, adapter/secrets, emergency pause, or current authority | Exact review-only consent; never silently upgraded on re-enable |
| Route removed or target/action family no longer capability-backed                                                             | Target hidden; no new consent                                   |
| Trading/Buy continuation or Telegram delivery only                                                                            | No change to funding-consent semantics                          |

Direct pUSD always records exact non-automation selection evidence; none of
these rows turns direct settlement into a delegated transaction.

| OFF condition                                                                                      | New bot behavior                                                                                                         | Existing receipt with no possible broadcast                                                            | Submitted/ambiguous action                                                                                                                                            | When ON/restored                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Receive creation                                                                                   | Do not create or reveal a new session/target                                                                             | Continue observation, routing assessment, reconciliation, recovery, and progress for existing sessions | Reconcile                                                                                                                                                             | New sessions become available; never reuse an expired target promise                                                                          |
| User `desired_enabled`                                                                             | Balance and direct pUSD Receive remain; no new delegated broadcast or trade submission; render `Automation off`/`Enable` | Preserve receipt and exact consent; render waiting-for-enable                                          | Reconcile; never resubmit                                                                                                                                             | May resume only under the soft-resume rules in Section 12.3                                                                                   |
| Telegram stable auto-execution                                                                     | Future variable routes become review-only; Slice C is unavailable for new automatic consent                              | Future routes may render `Review conversion`; Slice C waits without adding a conversion confirmation   | Reconcile; never resubmit                                                                                                                                             | A pre-pause Slice C consent may resume only under the soft-resume rules; review-only consent never becomes future automation                  |
| Global execute, dedicated worker, exact profile, adapter secrets, or emergency pause               | Do not advertise routed targets as automatic; render `Waiting for routing to resume` for existing eligible funds         | Preserve the same unbroadcast `started` Slice C attempt and receipt/action; no broadcast while paused  | Reconcile; never resubmit                                                                                                                                             | The exact pre-pause automatic consent/attempt may resume after all facts are revalidated; a selection made while OFF is not silently upgraded |
| Current link, purpose grant, signer/quorum, or Privy policy missing/revoked/changed                | Direct receipt and accounting remain; render `Setup required`; do not broadcast                                          | Preserve funds/evidence; require fresh authorization and consent/review                                | Reconcile; never resubmit                                                                                                                                             | Hard invalidation: never auto-resume the old authority                                                                                        |
| Route removed, action semantics/runtime contract changed, or future-profile cap/expiry invalidated | Hide route from new target selection; render `Review a fresh route` or recovery for existing funds                       | Preserve receipt; no use of the old action                                                             | Reconcile; never resubmit                                                                                                                                             | Hard invalidation: future routes require fresh quote/review; Slice C requires a new valid authority/route                                     |
| Telegram trading/Buy continuation                                                                  | Funding may reach ready; do not create a Buy intent; render enable/unavailable state                                     | Funding lifecycle continues                                                                            | Existing submitted trade reconciles; a confirmation arriving while OFF is rejected and marks its unsubmitted intent cancelled, while untouched drafts expire normally | Never auto-create/submit; user must click a fresh `Review Buy`                                                                                |
| Chat blocked/unreachable but link remains                                                          | Financial lifecycle continues without transport retries after dead-letter                                                | Retain latest progress/terminal projection                                                             | Reconcile                                                                                                                                                             | Explicit `/start` rearms exactly one unseen terminal replacement                                                                              |
| Telegram unlink                                                                                    | Apply both delivery-off and hard-authorization behavior; no new broadcasts or intents                                    | Observation/reconciliation continue against immutable user/funding evidence                            | Reconcile                                                                                                                                                             | Relink restores delivery, but value-moving actions require current grant and the hard-resume rules                                            |

For a route disabled before target rendering, hide the routed target. If an
address was already displayed or is shared with direct pUSD, an unexpected
non-direct transfer is still observed and shown as waiting/setup/review; it is
never broadcast merely because the address remained valid.

### 12.3 Re-enable and resume rules

Classify transitions before doing anything value-moving:

1. **Soft pause:** only availability changed (`desired_enabled`, stable
   auto-execution, global/dedicated execute, unchanged route/profile gate,
   adapter availability, or emergency pause); signer, grant, policy fingerprint,
   consent and action bytes remain identical. Slice C preserves and resumes the
   same unbroadcast `started` attempt; it never creates a replacement attempt.
   Provider-bounded actions store `action_expires_at` on their step. The exact
   Polymarket full-receipt wrap stores `NULL`; its 60-second quote gates commit,
   not execution of the immutable amount/nonce/destination contract.
   Future profiles may define bounded retry rules. All eligibility checks rerun
   immediately before submission.
2. **Hard invalidation:** link/grant revoked, signer/quorum/policy fingerprint
   changed, consent/target semantics changed, route/action semantics changed,
   runtime contract changed, or a future profile's cap/expiry invalidated. The
   old action never auto-resumes. Slice C has no conversion action TTL or fresh
   economics review; it requires valid current authority/route before any new
   receipt can produce a new operation.
3. **Broadcast may have occurred:** `submitted`, `ambiguous`, or any durable
   evidence that submission crossed the provider boundary. No switch transition
   can produce another send. Only lookup, reconciliation, postconditions,
   recovery, or proved failure may advance it.
   For the Polygon Router wrap, completion additionally requires the exact pUSD
   amount attributed from ERC-20 `Transfer` logs in the same finalized
   transaction, an exact one-step Router nonce advance, and the expected
   destination/CLOB balance floors. Balance floors tolerate concurrent credits;
   they do not replace exact transaction attribution.
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
  - exact shared automation-signer registry validation without tolerating
    unknown or second Hunch signers;
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
- generic null/zero cap behavior plus the exact Slice C V2 full-receipt/null-cap
  exception; neither consent form can be mutated in place;
- non-direct copy renders the real profile contract: cap consequences for
  capped routes, and full-receipt/no-conversion-economics for Slice C;
- authorization/profile matrix for EVM/Solana/PM Funding Router, including
  proof that product preference and ordinary wallet signing modes grant
  nothing;
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
- stable auto-execution OFF excludes automatic broadcast; future variable
  routes may support exact reviewed execution, while Slice C never invents a
  conversion-confirmation path; global/profile/emergency OFF blocks broadcast;
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
  that consent created after canonical immutable first observation cannot
  authorize it even when it becomes the active revision before receipt insert;
- active session survives API, bot, and worker restart;
- duplicate canonical EVM/Solana event creates one receipt;
- multi-worker delegated-step claim creates one attempt;
- ambiguous broadcast prevents a second attempt;
- `reconcile_required` and automatic-evidence recovery retain the exact routing
  receipt until the child completes, then project it ready;
- policy publication between routing eligibility and quote/commit cannot link
  an operation whose revision differs from the historical consent snapshot;
- a paused replacement policy, including one that temporarily omits the route,
  remains a soft wait and resumes only when the exact consented revision returns;
- early hard rejection waits behind Funding Policy publication and decides from
  the revision authoritative after that serialization point;
- worker schema readiness fails closed before migration 0204;
- fresh pre-send profile invalidation is definitive, while the same proof in
  recovery remains pending without an exact provider lookup result;
- lifecycle lock ordering is identical for consent/grant/unlink and the
  delegated pre-broadcast boundary;
- exact ERC-20 credit attribution rejects a multi-UserOp ERC-4337 bundle;
- nonterminal projection rechecks control-plane capability on its bounded
  timer even when Receive Session state is unchanged;
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
3. Export reusable Account Value presentation primitives. Keep the existing Buy
   shortfall on canonical Intent Liquidity; wire ready/post-trade consumers only
   when A1/B creates those surfaces.
4. Cover complete/partial/stale, known/unknown available, locked/reserved,
   Limitless, wallet,
   and in-transit states without a real Telegram bot, including Account Value
   visibility under every execution/creation OFF state and `desired_enabled`
   OFF behavior.
5. A0 renders each confirmed in-transit claim without combining distinct
   operations. Route/provider/current-stage detail begins in A1 from the durable
   funding-session projection.

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
2. Reuse the existing automation signer/quorum, attach one combined EVM policy,
   and keep rejecting unknown additional signers; legacy BUY/SELL bindings are
   transition-only.
3. Extract sidecar-safe immutable action, finite effective cap, policy, and
   attempt validation; define a separate EVM executor ID whose config reuses
   the shared signer secret and is optional at worker boot but mandatory for
   delegated claiming.
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
- every generic automatic route has a positive finite source-raw cap; the exact
  Slice C V2 full-receipt snapshot is the sole implemented null-cap exception,
  and later consent cannot retroactively authorize an observed receipt;
- fixture capabilities can represent the intended Polymarket receive matrix
  without promising unavailable variants at runtime;
- direct and routed receipts survive retry/restart without duplication;
- fake supported stable routes execute through the durable delegated executor
  only when their exact fresh funding grant/profile contract allows;
- future out-of-cap routes are reviewable in Telegram; Slice C has neither a
  cap nor conversion confirmation;
- destination pUSD readiness, not provider acceptance, unlocks continuation;
- continuation always creates a fresh quote/intent and final confirmation;
- Return-to-Buy generations permit a later explicit retry without callback
  replay creating duplicate intents;
- the latest terminal progress revision can be rearmed once after `/start` or
  relink;
- the first retained terminal projection is absorbing across projector,
  delivery, interactive Refresh/QR, standalone Convert, and Buy continuation;
  malformed terminal evidence repairs only to address-free unavailable;
- standalone conversion Review issue/confirm shares the Telegram lifecycle
  and receipt transaction, so stale buttons cannot survive cancel, expiry,
  controller replacement, or terminalization;
- disabled/revoked policy fails closed while preserving funds and recovery;
- every OFF combination resolves through the Section 12 precedence to one
  deterministic primary bot mode; observation/reconciliation never depend on
  execution availability;
- soft resume preserves at most one existing Slice C attempt in proved
  non-broadcast state, while hard invalidation never reuses old authority/action;
- all tests run without a real Telegram bot or public financial service;
- every new runtime/production control remains off;
- no legacy reconciliation or recovery path is removed.

### 16.2 Per-route activation gate

Local fake-adapter success does not make a route ready for production. Each
Funding Router, Relay EVM, and Relay SVM profile separately requires:

- an explicit current Privy policy whose real serialized form was verified;
- exact grant/profile resolution immediately before broadcast;
- the verified shared Hunch signer/quorum and exact chain-family combined policy
  that contains only the expected strict rules;
- provider submission correlation, timeout/crash recovery, and ambiguous
  outcome behavior proved for the real adapter;
- action-envelope/policy expressiveness proved for the real route;
- profile-appropriate amount safety (the closed-destination full-receipt proof
  for Slice C; finite caps for routed value movement), historical revoke
  evidence, execution gates, emergency pause, audit, and runtime policy;
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

- every generic automatic consent has a positive effective raw cap; Slice C V2
  is the explicit full-receipt/null-cap exception, and all consent revisions
  remain append-only/non-retroactive;
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
- amount/day limits in the first closed-destination delegated slice; future
  routed-value profiles require their own atomic cap reservation ledger;
- a separate provider-request service/table. WP8 uses the dedicated immutable
  `submission_request_ref_*` attempt fields defined in Section 8.2.

The resulting product rule is simple: after the one-time explicit delegation
ceremony, supported flows complete in Telegram. Slice C converts the full
USDC.e receipt without a conversion review; when pUSD is ready, `Review Buy`
and `Confirm` are separate Telegram callbacks. The Telegram Mini App appears
only to create or repair signing authorization. Ordinary Hunch web is offered
only for recovery that neither the bot nor that ceremony can safely express;
an OFF gate or reviewable future action never defaults to web.
