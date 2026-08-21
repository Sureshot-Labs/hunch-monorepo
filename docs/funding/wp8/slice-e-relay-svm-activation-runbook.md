# Slice E Relay Solana funding runbook

This runbook is the normative design and activation contract for funding a
venue from native SOL or canonical Solana USDC. It records the 2026-08-20
provider research and replaces the earlier assumption that all Solana funding
must start with delegated execution from a Hunch-managed wallet.

Slice E has two required value-moving tracks plus one independently gated
no-conversion receive capability. None is deferred:

- **Slice E2 — strict Relay Solana ingress:** an external wallet or exchange
  sends an exact amount of SOL or Solana USDC to a quote-bound, one-time Relay
  Deposit Address. Relay delivers Polygon pUSD to the user's exact destination;
- **owned SOL Receive:** native SOL is received at the user's managed Solana
  address and stays SOL Account Value;
- **Slice E3 — managed-wallet native-SOL conversion:** SOL already held in the
  user's Hunch-managed Solana wallet is converted only after a fresh Convert or
  composite Trade consent. This requires a separately proved delegated-signing
  boundary. Managed Solana USDC is an independently gated stable sibling, not
  part of the E3 GO claim.

Both tracks reuse the same destination binding, Funding Operation, Relay
correlation, reconciliation, Account Value, venue-readiness, and Return-to-Buy
architecture. They do not introduce separate Telegram or trade workflows.

This document does not authorize a policy mutation, capability enablement,
deployment, signing request, transfer, or production transaction.

## Product contract

The user chooses what they have and where they want to trade. Hunch chooses the
technical route.

- `SOL on Solana` and `USDC on Solana` are first-class funding choices.
- A user sending native SOL can decline conversion. `Receive SOL` shows the
  user's current managed Solana address and keeps the receipt as SOL Account
  Value. `Fund <venue> with SOL` is a different action and discloses conversion
  before showing a strict Relay address.
- The destination is the exact venue collateral owned by the same Hunch user;
  for Polymarket this is Polygon pUSD at the user's canonical Deposit Wallet.
- A user never chooses Relay, Jupiter, Privy, a signer, policy, program, ALT, or
  route implementation.
- Stable input is automatically converted to the destination stable.
- Volatile conversion is disclosed before a strict venue-funding transfer. A
  plain `Receive SOL` has no conversion. An active Trade includes conversion in
  its one Review/Confirm and adds no second prompt.
- Pre-existing volatile Account Value without Deposit or Trade consent requires
  a fresh `Convert to <venue stable>` review.
- SOL is a durable Account Value asset, not a staging token. The Buy planner
  prefers already-available venue collateral and stable sources. When those do
  not cover the order, available managed SOL above its reserve becomes a normal
  internal funding-source option, analogous to an eligible Base balance.
- An out-of-bounds or failed route preserves owned value and never silently
  widens consent, changes the destination, or substitutes another asset.

The primary copy is `Pay with SOL` or `Pay with USDC`, followed by the exact
amount, destination amount floor, fees, expiry, and `converted to pUSD`.

The no-conversion copy is `Receive SOL` followed by `SOL stays as SOL in your
Hunch balance`. It never promises venue readiness or Return-to-Buy.

## Current implementation status

As of this decision:

- Slice E1 application validation accepts the pinned current direct-Depository
  wallet-action shape and retains the Jupiter fixture as negative drift evidence;
- E2 provider research is complete enough to select the strict-address
  architecture, but the implemented strict adapter is still intentionally
  native-EVM/controlled-sender only and has no promoted Solana fixture;
- canonical Solana receipt/action primitives exist, but the user-facing
  `Receive SOL` contract and its independent route gate are not activated by
  this document;
- E3 boundary selection, Solana policy manifest, delegated transport/profile,
  and live policy rehearsal remain implementation work;
- no production route, capability, policy, signer attachment, or UI visibility
  changes merely because this plan was updated.

## Evidence and corrected Relay commitment model

### Protocol v2 signed order

Relay Quote v2 supports `includeProtocolData: true`. The response contains:

- `protocol.v2.orderId`;
- the complete `protocol.v2.orderData`;
- `protocol.v2.orderSignature`.

The official Relay settlement SDK computes `orderId` from the complete order,
including:

- input chain, currency, amount, and weight;
- every refund chain, recipient, currency, minimum, deadline, and extra data;
- output chain and every payment recipient, currency, minimum amount, and
  expected amount;
- calls, fees, deadline, and extra data.

`orderSignature` is the Relay solver's ECDSA signature over `orderId`. A fresh
read-only native-SOL quote was independently verified by recomputing/recovering
the EIP-191 signer; it recovered the documented Relay solver
`0xf70da97812CB96acDF810712Aa562db8dfA3dbEF`. The `orderId` in the signed data
matched the ID embedded in the Solana Depository instruction.

This is the selected semantic commitment. Hunch does not use the older
`/requests/:requestId/signature` response as a substitute, and does not ask
Relay to add destination or refund fields to that older payload.

Verification must use a pinned implementation of Relay's official order hash;
it must not invent a partial Hunch hash. It must:

1. parse a closed, versioned `orderData` schema;
2. recompute `orderId` from the full order;
3. verify `orderSignature` against the pinned Relay solver set;
4. compare every input, output, refund, call, fee, amount, and deadline with the
   frozen Hunch intent;
5. reject extra inputs, outputs, refunds, calls, fees, or unknown fields/shapes.

Primary sources:

- <https://docs.relay.link/references/api/get-quote-v2>
- <https://docs.relay.link/features/deposit-addresses>
- <https://docs.relay.link/references/protocol/guides/for-apps>
- <https://github.com/relayprotocol/relay-settlement>

### Current wallet-action envelope

A fresh read-only native SOL -> Polygon pUSD wallet quote on 2026-08-20 returned
one direct immutable Relay Depository `deposit_native(amount, orderId)`
instruction rather than the historical eight-instruction Jupiter route. The
July Jupiter fixture remains negative drift evidence, not an accepted alternate
runtime shape.

The one frozen validator fixture is used consistently for the TypeScript
reference-order computation, recovered solver signature, Secp256k1 instruction,
and local Guard/CPI test. The proof rejects a mismatch rather than comparing
separately copied order IDs.

The captured direct shape was:

- one versioned Solana transaction and one outer instruction;
- Relay Depository program
  `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`;
- Anchor discriminator `0d9e0ddf5fd51c06` (`deposit_native`);
- exactly 48 data bytes: discriminator, little-endian `u64` amount, and
  `[u8; 32] order ID`;
- five accounts, one signer, two writable accounts, and one active ALT;
- an executable BPF program whose ProgramData has no upgrade authority.

Slice E1 generalized the application validator to the pinned direct-Depository
Polygon destination while retaining the Jupiter fixture as a negative drift
case. That closes the fresh-quote availability bug, not the E3 delegated signer
boundary.

The current direct instruction is bounded in application validation, but a
Privy policy that can inspect only its program ID cannot see the discriminator,
amount, order ID, accounts, signer/writable flags, destination, or refunds. A
program-ID-only rule is therefore not sufficient for delegated E3 activation.

## Slice E2 — strict Relay Solana ingress

### Selected architecture

E2 is the KISS primary ingress for funds outside Hunch custody:

```text
external wallet or exchange
        -> one-time strict Relay Solana Deposit Address
        -> signed Relay order
        -> user's Polygon pUSD destination
        -> venue readiness / Account Value / Return-to-Buy
```

The quote request uses:

```json
{
  "useDepositAddress": true,
  "strict": true,
  "includeProtocolData": true,
  "refundTo": "<user-controlled refund location>"
}
```

Fresh read-only quote captures returned valid strict Solana Deposit Addresses
for both native SOL and canonical Solana USDC. No wallet signature, transfer,
or broadcast was created during that research.

E2 deliberately requires no Hunch delegated Solana signer, managed-wallet
attachment, Privy Solana policy, Jupiter validator, or Hunch on-chain router.
The user or their exchange performs the source transfer. Hunch verifies and
observes the provider order and the owned destination credit.

### Paired no-conversion choice with an independent gate

The same funding picker must also offer a separate owned-receive action when a
current verified managed Solana wallet exists:

```text
Receive SOL
    -> user's managed Solana address
    -> canonical finalized native-SOL receipt
    -> SOL Account Value
```

This is not a Relay order and has no automatic conversion consent. It uses the
ordinary owned Receive contract: exact current wallet ownership, a cursor set
before address disclosure, canonical transaction identity, finalized credit,
and the durable address/QR lifecycle. Initially it accepts native SOL only;
unsupported SPL tokens are not inferred from symbol text.

It is paired in product presentation, not activation. E2 may be enabled without
owned Receive, and owned Receive may be enabled without E2 or E3.

The two choices must remain visibly and technically distinct:

| User action                | Address owner             | Result                         |
| -------------------------- | ------------------------- | ------------------------------ |
| `Fund Polymarket with SOL` | one-time strict Relay     | Polygon pUSD / venue readiness |
| `Receive SOL`              | user's managed SVM wallet | owned SOL, no conversion       |

Owned Receive and Buy shortfall are deliberately separate. `Receive SOL` ends
after canonical SOL credit. Later, when a Buy lacks venue collateral, the
planner may offer `Pay with existing SOL` only from SOL already present in the
user's managed wallet/Account Value. It does not show an address or turn the
shortfall action into a deposit flow. The user performs one fresh
Review/Confirm for the composite `existing SOL -> pUSD -> Buy`. If available SOL
is insufficient, that source is honestly insufficient; Hunch does not silently
open another receive target.

### E2 immutable contract

Before displaying an address or QR, Hunch freezes:

- one Relay request and protocol version;
- one exact source network and source currency;
- one exact positive source amount;
- one exact destination network, currency, and user-owned recipient;
- every refund recipient/currency, all of which must remain inside the same
  user's controlled wallet contour;
- minimum/expected destination output, fees, expiry, and economic caps;
- full `orderData`, recomputed `orderId`, `orderSignature`, solver identity, and
  normalized quote fingerprint;
- the owning Receive/Trade intent and Return-to-Buy generation.

The displayed Deposit Address is one-time and quote-bound. It is not:

- the user's reusable Hunch receive wallet;
- a 24-hour multi-asset address;
- valid for both SOL and USDC;
- reusable after the quote/session reaches a terminal state.

Telegram and web show the exact asset, exact amount, network, address/QR,
expiry, destination output floor, and refund behavior. Wrong asset, wrong
network, late payment, underpayment, overpayment, refund, and provider child
requests remain typed reconciliation states; they never become guessed credit.

For an active Buy, market/price expiry is independent from Relay settlement. If
funds arrive after the original trade quote is stale, pUSD remains owned and the
user receives a fresh Review Buy. Hunch never holds an old market order open
while waiting for an external transfer.

### E2 provider lifecycle and evidence

Completion requires all of:

1. exact request/order correlation, including child request discovery;
2. provider state that is not unknown, delayed, refunded, or ambiguous;
3. canonical destination pUSD credit to the frozen user-owned destination;
4. venue-specific readiness evidence;
5. exact allocation to the owning funding intent/receipt with no duplicate
   operation or Buy continuation.

Relay success alone is not accounting completion. A provider refund is owned
only after the matching source/deposit evidence and exact refund recipient,
currency, amount, transaction, and request relationship are proved.

### E2 implementation boundary

Extend the existing Relay strict Deposit Address adapter instead of creating a
second provider client. The current implementation was intentionally limited to
native-EVM controlled senders, so Solana/manual/exchange ingress is new work and
must not be activated by merely adding a catalog row.

Reuse:

- Relay Quote/Status/Requests clients and encrypted request correlation;
- Funding Receive Session/receipt allocation where their contracts apply;
- Funding Operation and reconciliation state machines;
- Telegram durable single-card/address/QR lifecycle;
- destination pUSD and venue-readiness observers;
- Return-to-Buy generation and fresh trade review.

Add only the missing typed seams:

- strict Solana source/Deposit Address route specs for SOL and canonical USDC;
- full protocol-v2 order hash/signature verifier;
- exact strict-address session/presentation contract;
- manual/exchange-safe refund ownership validation;
- request/child/refund reconciliation and canonical source-deposit evidence;
- explicit provider TTL and late/partial/overpayment behavior.

The paired `Receive SOL` route reuses the canonical Solana owned-receipt
observer and managed-wallet resolver. It does not call Relay, create a Funding
Operation for conversion, attach a signer/policy, or share the strict address's
provider correlation.

Receipt allocation creates owned SOL, not a conversion operation or a pending
Buy continuation. A later Buy discovers that balance through Account Value and
creates a new composite E3 quote in the ordinary planner.

### Solana USDC support status

The live API and official settlement source accept a strict Solana USDC Deposit
Address, while some public prose still describes Deposit Addresses in
native-bridge terms. This is an availability/versioning uncertainty, not a
reason to weaken validation.

Activation requires a frozen USDC fixture plus a tiny real rehearsal. Written
Relay confirmation that SPL strict Deposit Addresses are supported/stable is
useful but not a cryptographic dependency. If the behavior disappears or the
shape drifts, only the USDC strict route remains unavailable; native SOL and E3
are not silently substituted.

### E2 activation gates

1. Freeze sanitized current strict SOL and strict USDC quote fixtures with full
   protocol v2 data and negative mutations.
2. Implement the official full-order hash/signature verification and pin the
   accepted solver identity/version update procedure.
3. Prove address ownership, exact amount/asset, expiry, under/overpayment,
   wrong-token, child request, delayed, refund, ambiguous, and restart paths.
4. Prove Telegram/web address and QR lifecycle, terminal redaction, exact
   message ownership, and no reusable-address wording.
5. Run disposable-Postgres migration/integration/restart tests and the complete
   funding regression suite.
6. Run separately authorized tiny SOL and USDC rehearsals through destination
   pUSD observation, without placing a Buy.
7. Run one strict-ingress Return-to-Buy rehearsal and obtain a history-free GO
   review.
8. Enable each route independently with conservative caps and observe it to a
   terminal state before widening.

### Owned SOL Receive activation gates

1. Prove the current managed-wallet address and observer cursor are frozen
   before disclosure.
2. Prove finalized canonical native-SOL receipt, duplicate/reorg handling,
   wallet rotation, address/QR lifecycle, and unsupported-token rejection.
3. Prove receipt creates only SOL Account Value—no conversion operation,
   reservation, or Buy continuation.
4. Run one tiny owned-SOL receive rehearsal and a separate history-free GO
   review. This gate does not require Relay or a Privy execution policy.

## Slice E3 — managed-wallet native-SOL conversion

E3 begins now as a required research and implementation track. It covers native
SOL already held in the user's Hunch-managed Solana wallet. E2 cannot replace
it because there is no external source transfer for that balance. Managed
Solana USDC may use the same future transport/policy only after its own stable
profile and GO matrix; E3 does not claim it by implication.

### E3 product cases

- **Active Trade:** one composite Review/Confirm authorizes bounded conversion
  and the Buy; no second conversion prompt.
- **Active Trade shortfall:** offer `Pay with existing SOL` from an already
  observed managed-wallet/Account Value balance. Quote the required SOL at
  current economics and include conversion in the one Trade Review/Confirm. No
  receive address is part of this action.
- **Destination-scoped Add Funds from managed balance:** selection freezes the
  exact source wallet, asset, cap, destination, and conversion contract.
- **Pre-existing Account Value:** a standalone fresh Convert review is required
  before volatile SOL moves.

### E3 planner and source-ranking contract

The planner treats managed SOL as an owned source, not as an automatic sweep:

1. use existing venue collateral when it covers the Buy;
2. recommend eligible stable balances/routes before selling volatile SOL;
3. when those balances do not cover the order, expose managed SOL above the
   configured fee/rent reserve for the remaining shortfall;
4. allow the user to choose another eligible source explicitly through the
   existing `Pay with` selector;
5. freeze one composite plan and show the SOL input cap, pUSD output floor,
   fees/slippage, expiry, and subsequent Buy before confirmation.

A combined plan may use stable value first and SOL only for the remainder if the
existing planner can prove sequential reservations and exact postconditions.
Otherwise it offers SOL as one complete alternative source rather than adding a
special-case partial route. No background worker may sell SOL just because a
Buy is underfunded.

### Minimal security objective

The outer signing boundary is custody containment, not an attempt to encode all
business logic in Privy policy. Even if the Hunch submission process is
compromised, an authorized transaction must not be able to move value outside:

- the exact user's managed source wallet;
- native SOL as the E3 source asset;
- the allowlisted venue stable as destination asset;
- the same user's frozen destination and refund wallets;
- a positive bounded input amount, one order, and an expiry/replay boundary.

Application validation remains stricter: it binds the exact serialized action,
economics, instruction/account flags, provider order, destination floor,
operation, consent, policy revision, and durable attempt. The two layers must
not be confused. Economic details that do not enable theft may stay in the
application layer; destination/refund/asset containment must survive compromise
of that layer.

### Known Privy constraints and shared-policy shape

Current Privy behavior constrains the E3 solution space:

- policies are reusable; E3 targets one `chain_type=solana` policy per
  environment, not one policy per user;
- the same existing Hunch authorization signer/quorum and reviewed policy ID
  are attached idempotently to each managed Solana wallet;
- every outer instruction is evaluated separately, `DENY` wins, and no match
  defaults to deny;
- decoded System and SPL Token rules expose useful transfer/mint/authority/
  amount fields, but an arbitrary `solana_program_instruction` exposes only its
  program ID;
- address conditions may not work when the inspected address comes from an ALT;
- `action_request_body` conditions do not decode the raw transaction accepted
  by `signAndSendTransaction`;
- rules are alternatives, so a broad generic System/SPL allow would bypass a
  narrower rule and is forbidden;
- the manifest allows only the reviewed `signAndSendTransaction` family—no
  arbitrary message signing, raw transaction signing, key export, wildcard
  method, or unrelated wallet action.

The complete manifest is compare-and-set, read back, normalized, fingerprinted,
and checked immediately before broadcast. SOL and USDC may share that one
policy only if the complete negative matrix proves both instruction families;
their application capability/profile gates remain separate.

Primary references:

- <https://docs.privy.io/controls/policies/overview>
- <https://docs.privy.io/controls/policies/example-policies/solana>
- <https://docs.privy.io/api-reference/wallets/solana/sign-and-send-transaction>

### What the Relay signature solves—and does not solve

The full signed `orderData` solves the earlier semantic gap: order ID,
destination currency/recipient, refunds, amount, deadline, outputs, calls, and
fees are cryptographically tied together by Relay.

It does not alone constrain a stolen Privy signing capability. The current
Solana Depository instruction carries only amount and order ID, and Privy does
not decode the signed order or custom instruction. A compromised submitter
could request and submit another valid Relay order unless the outer boundary
also verifies that the signed order's destination/refunds/assets stay inside
the user's contour.

### E3 boundary decision — 2026-08-20

The research selection is now **one atomic managed-wallet guard transaction**,
not a second Hunch approval server and not a general Solana router:

```text
Relay Quote
  -> canonical full Relay Order + solver signature
  -> optional Relay oracle trigger attestation

Privy-managed Solana wallet, one transaction
  -> Secp256k1 verification instruction(s)
  -> Hunch Relay Intent Guard
       -> exact predicate + replay/cap/expiry checks
       -> CPI Relay Depository.deposit_native(amount, orderId)
```

This is logically two-phase—Relay creates evidence, then the managed wallet
executes it—but the value movement is one atomic Solana transaction. Do not
split it into an on-chain `approve` transaction followed by an `execute`
transaction: that would create needless stale-intent, replay, fee, and recovery
states.

#### What exists at Relay, and why it is not directly reusable

Relay's public `lit-deposit-address` source already implements the right
_predicate_. Before its TEE signs a transaction from a Relay/Lit-derived deposit
wallet, it verifies an oracle threshold attestation, canonical full Relay order
and recomputed `orderId`, solver signature, exact input, every refund, exactly
one output, no output calls, price impact, and an exact one-instruction Solana
Depository sweep. Its Solana verifier is the authoritative behavioral reference
for our restricted E3 order shape.

It is **not** a direct E3 authorizer: its public interface signs only a
Relay/Lit-derived deposit wallet transaction, not a Privy managed wallet
transaction, and it does not emit a compact authorization ticket for another
program to consume. Also, no independent audit evidence for this Lit predicate
has been established in this repository. A Relay Depository audit must never be
treated as an audit of this separate verifier.

The official Depository and Forwarder are execution components, not the missing
boundary. `deposit_native(amount, id)` transfers SOL and emits `(depositor,
amount, id)`; it does not validate the full order, user destination, refunds,
or expiry. The legacy Forwarder merely sweeps its own PDA balance into that
Depository. Neither is sufficient as the outer E3 verifier.

References captured during research:

- <https://github.com/relayprotocol/relay-settlement/blob/main/packages/lit-deposit-address/src/attestation/index.ts>
- <https://github.com/relayprotocol/relay-settlement/blob/main/packages/lit-deposit-address/src/derivation/vm/solana/SolanaVmWalletDeriver.ts>
- <https://github.com/relayprotocol/relay-settlement/blob/main/packages/lit-deposit-address/docs/README.md>
- <https://github.com/relayprotocol/relay-depository/blob/main/packages/solana-vm/programs/relay-depository/src/lib.rs>
- <https://github.com/relayprotocol/relay-depository/blob/main/packages/solana-vm/programs/relay-forwarder/src/lib.rs>

#### Selected Plan A — minimal immutable Relay Intent Guard

The guard is a custody boundary, not a second planner. It has no quote client,
provider HTTP, pricing engine, route selection, Telegram state, or custody
balance. Its value-moving entry point accepts only the restricted current
native-SOL order form and does all of the following before its single CPI:

1. proves the managed source wallet signed this transaction;
2. verifies the pinned Relay solver signature over a recomputed restricted
   canonical `orderId`; any deployed oracle-attestation requirement is verified
   against its pinned threshold as well;
3. requires exactly native SOL, one positive bounded input, one output payment,
   no output calls, an unexpired deadline, and a fresh `orderId` replay marker;
4. requires Polygon pUSD and the exact destination/refund wallets stored for
   that user binding; every refund remains in the user's contour;
5. enforces the consent/operation cap and leaves the configured SOL fee reserve;
6. pins the official Relay Depository program, vault, `deposit_native`
   discriminator, amount, and order ID; then CPI-calls it with the original
   source wallet as `sender`.

Solana propagates signer privilege into a CPI and Relay's `DepositNative`
expects its `sender` to be a signer, so the guard does not need to custody,
prefund, or temporarily hold user SOL. This is still a mandatory local-validator
proof, not an assumption carried into activation.

#### Minimal Rust shape

This is the entire value-moving shape to preserve during implementation. It is
an illustrative, deliberately incomplete Anchor-style entry point rather than
copy-paste deployable code: account declarations, error types, parsing, and
the binding lifecycle are omitted here so the custody boundary is visible.

```rust
pub fn execute(ctx: Context<Execute>, order: RestrictedRelayOrder) -> Result<()> {
    let binding = &ctx.accounts.binding;
    require_keys_eq!(ctx.accounts.source.key(), binding.source);
    require_keys_eq!(ctx.accounts.destination, binding.destination);
    require!(Clock::get()?.unix_timestamp < order.deadline, GuardError::Expired);

    // Full Relay order hash + solver signature; never trust a caller-supplied id.
    let order_id = relay_order_id(&order)?;
    verify_relay_solver_signature(&ctx.accounts.instructions, order_id)?;
    validate_restricted_order(&order, binding)?;
    // SOL only; one pUSD output; bound amount; exact refunds; no calls/fees.
    require!(!ctx.accounts.replay_marker.used, GuardError::Replay);
    ctx.accounts.replay_marker.used = true; // rolls back atomically if CPI fails

    // Construct this instruction here. The caller never supplies arbitrary CPI data.
    let deposit = relay_deposit_native(order.input_amount, order_id);
    invoke(&deposit, &[
        ctx.accounts.relay_config.to_account_info(),
        ctx.accounts.source.to_account_info(), // sender
        ctx.accounts.source.to_account_info(), // depositor
        ctx.accounts.relay_vault.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    ])?;
    Ok(())
}
```

The outer transaction contains the pinned Secp256k1 precompile instruction and
this one Guard instruction. `relay_deposit_native` is constructed only with the
pinned Relay Depository program/config/vault/discriminator; it is not supplied
by the caller. The original managed `source` is an outer signer and is passed
through to the CPI, so the only user-SOL movement is `source -> Relay vault`.
The replay-marker rent, if any, is paid by the configured Hunch fee payer, not
by temporarily holding or forwarding user SOL in the Guard.

#### Feasibility-proof scope

A local-validator proof establishes the Guard/CPI mechanics and exact source
debit only. It deliberately does **not** assert that the currently installed
Privy policy already authorizes the new top-level Guard instruction: no Privy
application, policy, signer attachment, or dashboard setting is changed during
research. The read-back of a restrictive shared policy and a separately
authorized tiny-value rehearsal remain activation gates.

Likewise, the validator loads the pinned Relay Depository source at the official
program ID with synthetic config/vault account data. That proves the pinned
`deposit_native` ABI and transfer semantics, not the deployed mainnet program
binary or live configuration. Activation must independently freeze and verify
the deployed program/ProgramData, config, vault, and upgrade-authority state.

The guard program must be immutable at activation: revoke its upgrade authority
after independent review/audit, or keep it behind a separately governed,
time-delayed upgrade process. The Privy policy pins the exact deployed program
ID; an upgradeable unrestricted guard is not a custody boundary.

#### One shared policy and one per-user binding

E3 still uses one reusable Privy `chain_type=solana` policy per environment,
not one policy per wallet. That policy permits only:

- the Hunch Relay Intent Guard program;
- the Solana Secp256k1 precompile(s) required to verify Relay EVM signatures;
- the minimum reviewed Compute Budget instruction(s).

It explicitly has no direct Relay Depository, Relay Forwarder, Jupiter, System
transfer, SPL transfer, message-signing, raw-signing, or wildcard RPC path.
The guard's CPI is safe precisely because the guard validates it; Privy need not
and cannot decode the guard's custom payload. Every permitted outer instruction
must remain in the exact policy manifest.

The only per-user state is one binding PDA, **not** a Privy policy. It binds a
managed Solana source wallet to its permitted Polymarket destination and Solana
refund wallet(s). Creation, rotation, and revocation of that binding require a
user-controlled setup authority outside the delegated E3 execution policy. The
delegated signer may execute an already-bound intent but may never create or
change a binding. If this separation cannot be proved, E3 stays off: application
knowledge that two wallets belong to the same user is not a custody boundary.

#### Future Relay shortcut, not an assumption

The smallest future form would be a Relay/Lit-issued signed
`ExecutionApproval` containing the source wallet, input asset/amount, order ID,
destination chain/currency/recipient, all refunds, minimum output, and expiry.
Then the guard could verify this compact ticket plus the binding instead of
recomputing the restricted full-order hash. The currently public Relay/Lit
interface does not return such a ticket. It must be obtained from Relay as a
documented, versioned feature with audit evidence; it is not inferred from the
existing deposit-wallet signer.

An independent Hunch approver/quorum is Plan B only if neither the restricted
full-order guard nor a Relay-issued approval can be made sound. A
Relay-program-ID-only Privy rule, arbitrary Solana transaction permission, or
application-only check is never an alternative.

#### E3 implementation and QA gates

Before any policy creation, capability enablement, or production transaction:

1. Freeze a fresh direct native-SOL envelope and prove it still has no managed
   wallet Jupiter step. The historical eight-instruction Jupiter fixture remains
   a negative drift case, not a supported guard path.
2. Build the restricted order encoder/hash against the Relay reference and
   prove byte-for-byte `orderId` parity for positive and mutated fixtures.
3. Run the guard on a local validator: successful CPI with the original source
   signer, exact debit, replay rejection, and no guard-held balance.
4. Run the negative custody matrix: foreign destination/refund/source,
   wrong asset, output call, fee/cap/reserve breach, wrong solver/attestation,
   expired or replayed order, altered Depository/vault/discriminator, direct
   Relay/Jupiter instruction, and policy method escape must all reject.
5. Prove the binding lifecycle: interactive bind, unauthorized rotate/revoke
   rejection, post-revoke execution rejection, and user merge/wallet rotation
   handling.
6. Prove worker/operation recovery across quote expiry, possible broadcast,
   final source debit, destination credit, owned refund, policy pause/revocation,
   and restart—without duplicate deposit or Buy.
7. Audit/review the frozen guard, deployment immutability, policy manifest, and
   all generated operation code. Then run a separately authorized tiny-value
   rehearsal before enabling E3.

### E3 execution and recovery contract

After a boundary is selected, reuse the durable delegated attempt/recovery
executor and prove:

- exact managed wallet, signer, shared policy ID/fingerprint, authorization,
  consent, cap, and pause immediately before first broadcast;
- attempt persisted before provider submission and lookup-before-retry;
- no blind retry for unresolved signature or expired blockhash;
- explicit fee payer/sponsorship and zero-SOL USDC behavior;
- finalized source debit, destination credit, owned refund, and provider
  reference correlation;
- restart at every possible-broadcast boundary;
- no duplicate conversion, Relay deposit, destination credit, or Buy;
- pause/revocation blocks new broadcast without disabling recovery of a
  possible prior broadcast.

## Shared rollout and rollback

E2 strict ingress, owned SOL Receive, and E3 managed conversion have separate
route/capability IDs, flags, caps, fixtures, and smoke evidence. Enabling one
never enables another or both assets implicitly.

Rollback disables only new first broadcasts/address creation for the affected
track. Observation, provider lookup, reconciliation, destination credit,
refunds, QR/card terminalization, and recovery continue until every accepted
request/attempt is terminal. Never detach a signer/policy from an unresolved E3
possible broadcast.

## Exit criteria

### E2 GO

- external SOL and Solana USDC each produce one exact strict address/order;
- full order hash/signature, destination, refund, amount, asset, expiry, child,
  and destination-credit evidence are proved;
- the UX requires no provider knowledge and Return-to-Buy creates a fresh trade
  review after readiness;
- no delegated Solana signer or per-user policy is involved;

### Owned SOL Receive GO

- the exact current managed address is shown only after observation starts;
- finalized native SOL becomes Account Value without conversion or Buy state;
- wallet rotation, duplicate receipt, QR/card lifecycle, and unsupported tokens
  fail closed;
- neither Relay nor a Privy execution policy is required.

### E3 GO

- managed SOL can fund an active Buy with one economic confirmation;
- the selected outer boundary prevents value leaving the user's wallet/token
  contour under submitter compromise;
- one shared Solana policy is attached idempotently without per-user policies;
- exact fee payer, caps, source debit, destination credit, refund, retry,
  restart, pause, revocation, and policy read-back behavior are proved;
- a history-free reviewer returns GO on the frozen implementation.
