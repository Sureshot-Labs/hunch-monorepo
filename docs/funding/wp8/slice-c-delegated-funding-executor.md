# Slice C: delegated funding executor

This slice adds a reusable, durable executor substrate and its first profile:
`polymarket_deposit_usdce_wrap_v1`. It does not create or activate a Privy
policy, attach a signer, grant a wallet, publish Funding Policy V2, or enable
production execution.

## Security boundary

The wrap profile is a closed-destination transform. The backend supplies the
exact full receipt amount. The Privy policy restricts the key to one Polygon
Funding Router call with zero native value and `pUsdAmount = 0`; it does not cap
`totalAmount`. The Router derives the user's canonical Deposit Wallet from the
caller, so calldata cannot redirect the resulting pUSD.

The combined EVM policy must contain exactly one wrap rule with this shape;
the existing strict BUY, SELL, and capped funding rules remain alongside it:

```json
{
  "chain_type": "ethereum",
  "rules": [
    {
      "action": "ALLOW",
      "method": "eth_sendTransaction",
      "conditions": [
        {
          "field": "chain_id",
          "field_source": "ethereum_transaction",
          "operator": "eq",
          "value": "137"
        },
        {
          "field": "to",
          "field_source": "ethereum_transaction",
          "operator": "eq",
          "value": "<canonical Polygon Funding Router>"
        },
        {
          "field": "value",
          "field_source": "ethereum_transaction",
          "operator": "eq",
          "value": "0x0"
        },
        {
          "field": "function_name",
          "field_source": "ethereum_calldata",
          "operator": "eq",
          "value": "fund",
          "abi": [
            {
              "type": "function",
              "name": "fund",
              "stateMutability": "nonpayable",
              "inputs": [
                { "name": "expectedNonce", "type": "uint256" },
                { "name": "totalAmount", "type": "uint256" },
                { "name": "pUsdAmount", "type": "uint256" }
              ],
              "outputs": []
            }
          ]
        },
        {
          "field": "fund.pUsdAmount",
          "field_source": "ethereum_calldata",
          "operator": "eq",
          "value": "0",
          "abi": [
            {
              "type": "function",
              "name": "fund",
              "stateMutability": "nonpayable",
              "inputs": [
                { "name": "expectedNonce", "type": "uint256" },
                { "name": "totalAmount", "type": "uint256" },
                { "name": "pUsdAmount", "type": "uint256" }
              ],
              "outputs": []
            }
          ]
        }
      ]
    }
  ]
}
```

The live inspector reuses the existing Hunch automation authorization key and
quorum. It requires threshold one, no nested quorums/users, the expected
wallet/address/chain, and exactly one combined EVM override policy with exact
signer and policy fingerprints. Unknown, duplicate, broader, partially
configured, or changed signers fail closed. Privy allows only one override
policy ID per additional signer, so BUY, SELL, capped trade funding, and this
exact full-receipt wrap are separate strict rules inside that one policy.

## Runtime controls

Both switches must be true before a new automatic route may broadcast:

```dotenv
HUNCH_FINANCE_EXECUTE=true
HUNCH_FUNDING_PM_WRAP_EXECUTE=true
```

An operation already committed while they were true still receives its one
durable `started` attempt while either switch is off; the boundary remains
soft-paused and makes no provider call until both switches are restored.

The profile also needs these values in the finance-worker environment (and in
the API/CLI environment used to inspect or grant it). The automatic capability
soft-pauses unless the Router address is present and equals the canonical
deployment exactly. A missing or non-canonical optional Router value is treated
as unavailable rather than crashing the sidecar; immutable committed actions
and post-broadcast recovery are still checked against the canonical contract:

```dotenv
POLYMARKET_FUNDING_ROUTER_ADDRESS=0x0fEF62E1CD0600C132070855A45443852940EE72
PRIVY_WALLET_AUTHORIZATION_ID=
PRIVY_WALLET_AUTHORIZATION_KEY=<base64 DER PKCS#8 P-256 private key>
PRIVY_WALLET_AUTHORIZATION_FINGERPRINT=
PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID=
PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT=
```

Do not configure or attach a standalone wrap policy. If one already exists in
Privy, leave it unattached; Slice C does not read its ID.

The combined policy ID and fingerprint are an inseparable pair. The legacy
BUY/SELL policy IDs may remain in the API environment only while existing
wallet bindings are automatically replaced; new grants always attach the
combined policy. The signer fingerprint is
the canonical hash of signer ID, sorted public keys, threshold, nested quorum
IDs, and user IDs. A policy fingerprint is the canonical hash of its normalized
`chainType`, ID, and complete rules. Generate these only from a live policy that
has already passed the existing purpose-specific trading-policy inspector; a
fingerprint records that validated policy and does not make an unsafe policy
safe.

The existing durable-reference protection must also be configured in both
processes; otherwise the automatic capability remains unavailable:

```dotenv
CREDENTIALS_ENCRYPTION_KEY=
FUNDING_REFERENCE_LOOKUP_HMAC_KEY=
```

Funding Policy V2 must contain `polymarket` and `polygon:usdce` and must not be
paused. `telegram_bot_trading_preferences.desired_enabled` must be true, and a
current per-wallet `telegram_funding_authorizations` grant plus prospective V2
Telegram consent are also required. Turning execution off or disabling the
user preference does not stop observation or reconciliation. The executor
profile stays mounted for already-crossed boundaries when the execution flag is
off or the current profile IDs are unavailable; recovery uses the immutable
signer/policy identity stored with the authorization. The Privy app credentials,
authorization key, and durable-reference protection are still required to look
up or replay an exact provider request. A malformed authorization key makes the
adapter unavailable without crashing the finance worker.

Automatic target selection is only committed after the API transaction
re-resolves and locks the exact grant, Telegram link, wallet, user preference,
and Funding Policy revision named by the V2 consent snapshot. Cursor discovery
may happen before that transaction, but a revoke, unlink, preference change, or
policy publication that wins the race prevents the append-only automatic
consent from being recorded. Routing, progress projection, and later address
rendering compare that frozen Funding Policy revision again; a different
enabled revision does not inherit the old consent. The atomic receipt link also
requires the committed operation revision to equal the historical consent
snapshot, closing a policy-publication race between the earlier routing check
and quote/commit. Address rendering is also bounded by the persisted
`presentationMode`: current capability may narrow or hide that mode, but a later
grant cannot broaden a frozen direct-only consent into USDC.e automation.
Missing or malformed frozen presentation state fails closed instead of being
inferred from live capability.

## Capability and pause semantics

The router, Telegram target rendering, and executor use one decision model:

- `allowed`: every current control-plane and user-authority fact matches;
- `soft_paused`: user automation, execution flag, profile environment, or
  Funding Policy availability is temporarily off;
- `hard_invalid`: authority, route, immutable action, or runtime contract no
  longer matches; and
- `reconciliation_only`: the broadcast boundary may already have been crossed.

The executor rechecks policy, operation, exact action bytes, receipt amount,
the historical consent ID/fingerprint, wallet/account/link, authorization
fingerprint, and `desired_enabled` in one short transaction immediately before
broadcast. Both the early non-broadcast rejection decision and the broadcast
boundary use the same policy lock as publication, so neither can terminalize
from a stale policy snapshot. Grant, unlink, consent, and
the pre-broadcast check first take the same per-user lifecycle advisory lock
before mutable link/authorization/preference rows, so there is one lock order
and whichever transition commits first is authoritative.

A soft pause leaves the one `started` attempt resumable. Restoring availability
revalidates and resumes that same attempt; it does not create another attempt.
A pause that lands after route commit but before the first worker claim still
creates that single `started` attempt, which prevents the ordinary action TTL
from cancelling the committed receipt work. A policy pause/unavailable snapshot
does not let a temporarily removed route or its revision mismatch override the
soft pause: it may resume only when the exact prior policy returns. A different enabled Funding
Policy revision hard-invalidates the stale operation even when the runtime
contract version and route remain unchanged.
A hard invalidation finishes only a proved non-broadcast attempt as failed. If
the boundary was already committed, later pause/revoke/unlink cannot cancel the
exact idempotent provider call, and recovery never creates another logical
submission.

Telegram ownership is classified from the immutable receive-session channel,
not from the nullable current account link. Revocation, unlink, or another hard
authority mismatch sends the receipt directly to recovery/setup-required and
never to the generic economic-conversion review API.

## Grant and revoke

The grant command is dry-run by default. Even dry-run verifies the live wallet,
shared signer/quorum, combined policy, key, and fingerprints. It does not
attach or create Privy resources; the existing managed Telegram automation
setup owns the one signer attachment.

```bash
pnpm -F api run funding:authorization:grant -- \
  --user-id <uuid> \
  --telegram-account-id <uuid> \
  --telegram-user-id <id> \
  --user-wallet-id <uuid> \
  --privy-wallet-id <id> \
  --wallet-address <0x...> \
  --destination-option-id <id> \
  --venue-binding-option-id <id>
```

After reviewing the dry-run, the persistent grant additionally requires:

```text
--execute --confirm "GRANT POLYMARKET USDC.E WRAP"
```

Revocation is dry-run by default and requires the authorization and user IDs.
Persistent revoke additionally requires:

```text
--revoke --execute --confirm "REVOKE POLYMARKET USDC.E WRAP"
```

Privy Telegram unlink revokes every still-active funding authorization bound
to that Telegram account in the same transaction before deleting the link.
Grant, link/relink, and unlink share one per-user advisory transaction lock, so
a concurrent grant either commits before the unlink revocation scan or observes
the deleted link and fails. Relinking never inherits the old grant; a new
current grant is required.

## Durable execution contract

One eligible receipt creates one Funding Operation for its entire raw amount.
The internal delegated profile makes the planner build an exact receipt-only
venue-preparation plan: `requestedSourceAmount` is that USDC.e receipt, the one
step starts as `planned`, and its executor is
`polymarket_deposit_usdce_wrap_v1`. Existing deposit pUSD or signer balances
are not swept into this plan. The receipt link verifies this shape before it
activates the step. Receipt `FOR UPDATE` claim, operation/step insertion,
evidence allocation, receipt attachment, and step activation commit in one
transaction; a lost claim or exact-plan failure rolls back the operation rather
than leaving an orphan that blocks the binding. Telegram routing selects the
latest exact V2 consent present at or before the canonical event's immutable
`first_observed_at`; it does not use the later active revision or worker
`observed_at`. The link atomically compares the new operation's Funding Policy
revision with that historical consent snapshot, freezes the consent ID and
fingerprint in operation metadata, and every claim/recovery/broadcast-boundary
query rebinds them to the append-only consent row.
The worker claims a step with `FOR UPDATE SKIP LOCKED`, commits a `started`
attempt before Privy, crosses a durable pre-broadcast boundary, and uses the
attempt UUID as both Privy `reference_id` and idempotency key. A submitted or
ambiguous attempt is never broadcast again. Recovery looks up or replays only
that exact idempotency/reference ID. Provider labels such as `failed`,
`replaced`, or `execution_reverted` without an exact transaction hash do not
prove non-broadcast and remain in recovery. The normalized action is bound to
the domain `wallet_*` ID derived from chain/address, while Privy calls use the
separate persisted provider wallet ID. Reconciliation requires the exact
receipt/action, the exact pUSD amount attributed from ERC-20 `Transfer` logs in
that finalized transaction, an exact one-step Router nonce advance, and at
least the expected pUSD balance floor. The transaction attribution proves this
operation's amount; the balance floor tolerates unrelated concurrent positive
pUSD credits without making the proved action permanently unreconcilable. For
a sponsored ERC-4337 transaction, exact destination-credit attribution is
accepted only when `handleOps` contains one UserOp. A multi-UserOp bundle is
scope-ambiguous because its transaction-wide logs cannot attribute the pUSD
credit to one matched UserOp, so it fails closed to reconciliation/recovery.

A timeout, 5xx, or other transport failure while fetching the live Privy
wallet/quorum/policy snapshot remains pending. Only a fully fetched snapshot
that proves the exact signer or policy invalid can finish the still-local call
as non-broadcast; no provider send is attempted in that case. That proof is
terminal only for the fresh worker invocation before its first provider call.
Recovery first looks up the exact durable reference; if none is found, a live
profile failure remains pending because a prior provider call may have occurred.

A terminal pre-broadcast failure of this delegated child remains attached to
the receipt and projects `recovery_required`; it is never detached into the
generic economic-conversion review path. This preserves one receipt, one
operation, and one attempt even for hard invalidation.
An operation in `reconcile_required`, or in `recovery_required` with
`automatic_evidence`, is not terminal receipt recovery: routing retains the
exact child binding while ordinary reconciliation can still finalize it. Only
manual/non-automatic recovery becomes terminal receipt attention.

The profile has no amount cap, conversion quote, rate, slippage,
minimum-output screen, conversion confirmation, or action TTL. Its safety
boundary is the exact full-receipt call and non-redirectable pUSD destination.
After pUSD is ready, Telegram offers a separate fresh `Review Buy` and
`Confirm`; readiness never places an order. For an automatic USDC.e receipt,
that gate requires the same frozen prospective consent plus its linked exact
single-step Router operation in `completed`/`succeeded` state with matching
source amount, pUSD destination amount, authorization, and receipt ID.

The finance-worker phase order is observation, receipt routing, delegated
execution, ordinary reconciliation, then Telegram progress projection. This
lets a single cycle expose the newest safe state without allowing presentation
to become execution authority. Before the durable broadcast boundary, current
capability may project a soft wait or hard attention state. After the boundary,
the persisted attempt remains routing/confirming regardless of later capability
changes; it can only reconcile or recover, never return to a pre-broadcast UI.
Candidate selection observes that attempt-only boundary directly and wakes the
projection once even when the Receive Session version did not change. Once the
card is `converting`, the boundary predicate is no longer hot; receipt
settlement supplies the next normal version change. Independently, every
nonterminal consent receives a bounded capability recheck at most once per 60
seconds, so Funding Policy, profile, link, or preference changes can update a
stable waiting/converting card without a Receive Session version bump.
The worker schema gate requires `telegram_funding_authorizations` as the atomic
migration-0204 marker before any of these phases run.

The common Funding Router commit boundary serializes unresolved operations per
user and venue binding. Future Relay EVM profiles reuse the same Hunch signer
and combined EVM policy by adding separately validated strict rules. Solana may
reuse the same authorization quorum but needs its own combined Solana policy
because Privy policies are chain-family specific. Every profile still defines
its own driver, value/recipient constraints, and activation flag.

## Activation order

1. Apply migration `0204` and run the funding migration preflight.
2. Deploy code with `HUNCH_FUNDING_PM_WRAP_EXECUTE=false`.
3. Verify a dark worker cycle has zero delegated claims.
4. Add and verify the exact wrap rule in the existing combined EVM policy.
5. Let the existing managed setup replace a canary wallet's legacy BUY/SELL
   binding with the combined policy, then issue one funding grant.
6. Preview and publish Funding Policy V2 with the full intended asset array,
   including `polygon:usdce`.
7. Enable the profile for the canary and perform a separately approved tiny
   real receipt.
8. Prove one receipt, one attempt, one transaction, exact action/nonce, exact
   transaction-attributed pUSD credit, and the expected pUSD balance floor,
   then the separate `Review Buy` and `Confirm`
   flow.

Rollback is `HUNCH_FUNDING_PM_WRAP_EXECUTE=false` or removal of
`polygon:usdce` from a newly previewed/published compact policy. Do not delete
attempts, receipts, operations, or grants; observation and reconciliation
continue.
