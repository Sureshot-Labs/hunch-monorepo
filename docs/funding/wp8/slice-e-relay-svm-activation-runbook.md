# Slice E Relay SVM activation runbook

This runbook defines the next funding slice for users who want to fund or buy
with native SOL. The current primary economic route is:

`native SOL -> Relay Depository -> Polygon pUSD -> Polymarket readiness`

A fresh read-only quote captured on 2026-08-20 no longer contains an outer
Jupiter swap. Relay now treats native SOL as a solver currency and returns one
direct `deposit_native(amount, orderId)` instruction. The July eight-instruction
Jupiter fixture remains historical drift/regression evidence; it is not an
activation fixture for the current provider envelope.

Solana USDC remains part of the same SVM capability, but it is not the product
priority. This document is a design and activation contract. It does not
authorize a Privy policy change, production flag, deployment, or transaction.

## Product contract

The user chooses the economic intent; Hunch chooses the technical route.

- In an active Buy, the single fresh Trade Review states the maximum SOL sold,
  minimum pUSD received, fees, slippage/price impact, expiry, and that Hunch
  will convert SOL before placing the order. The existing Trade Confirm
  authorizes conversion and trade. There is no second conversion prompt.
- In destination-scoped Add Funds, selecting `SOL on Solana` must disclose the
  same bounded conversion before the receive address is shown. That selection
  creates append-only consent for automatic conversion of the canonical
  receipt inside the frozen cap. Receipt arrival does not add another prompt.
- SOL that was already present in Account Value and has no matching active
  Deposit or Trade consent remains owned SOL. It requires a fresh standalone
  `Convert to <venue stable>` review before value moves.
- If the eventual quote is outside the frozen amount, fee, slippage, output, or
  expiry bounds, Hunch preserves the receipt as owned Account Value. It never
  silently widens consent or substitutes another route.

The primary UX says `Pay with SOL`, `SOL will be converted to pUSD`, and the
economic bounds. It does not mention Jupiter, Relay, Privy, policies, grants,
program IDs, address lookup tables, or transaction instructions.

## One shared policy, not one policy per user

Privy policies are reusable resources. Slice E uses:

- the existing Hunch authorization key/quorum;
- one separate `chain_type=solana` policy per environment;
- the same Solana policy ID as the signer override on every managed Solana
  wallet;
- one exact read-back policy fingerprint checked before every broadcast.

The existing combined EVM policy cannot be reused because its chain type is
`ethereum`. Creating one Solana policy does not imply creating one policy per
wallet. Managed provisioning idempotently attaches the same signer and policy
ID to each user's Solana wallet. Per-user wallet, consent, receipt, amount,
route, and destination facts remain in Hunch authorization and operation
records; they are not copied into Privy rules.

The current Hunch known-signer contract accepts exactly one override policy for
this signer/wallet shape. Therefore USDC and SOL profiles share one combined
Solana policy and retain separate Hunch capability/profile gates. The policy is
extended only by a complete-manifest compare-and-set update followed by
read-back fingerprinting.

## Privy policy semantics that the design must respect

As documented by Privy on 2026-08-20:

1. Each outer Solana instruction is evaluated independently. Every instruction
   must match an `ALLOW` rule; otherwise the transaction is denied.
2. `DENY` wins over `ALLOW`, and no matching rule defaults to `DENY`.
3. `solana_system_program_instruction` exposes decoded System Program fields,
   including transfer source, destination, and lamports.
4. `solana_token_program_instruction` exposes decoded SPL Token fields,
   including instruction name, mint, authority, source, destination, and
   amount for supported instructions.
5. `solana_program_instruction` exposes only `programId` for an arbitrary
   program. It does not expose custom-program instruction bytes, discriminator,
   account order, signer/writable flags, or protocol order ID.
6. Address conditions fail when the inspected address is supplied through an
   Address Lookup Table. Program ID, instruction name, amount, and time
   conditions remain usable with ALT transactions.
7. Rules are alternatives. A broad generic System or SPL Token `ALLOW` rule
   can bypass a narrower amount/mint rule and is forbidden.
8. `action_request_body` conditions apply to Wallet Action API requests, not to
   the raw transaction body accepted by `signAndSendTransaction`; they cannot
   supply the missing Relay instruction-field boundary.
9. Only `signAndSendTransaction` is allowed. No wildcard RPC rule, message
   signing, raw transaction signing, key export, or unrelated wallet action is
   included.

Primary references:

- <https://docs.privy.io/controls/policies/overview>
- <https://docs.privy.io/controls/policies/example-policies/solana>
- <https://docs.privy.io/api-reference/wallets/solana/sign-and-send-transaction>
- <https://docs.privy.io/wallets/gas-and-asset-management/gas/solana>

## Current exact envelopes

The repository already contains provider-neutral `svm_transaction` actions,
Relay Solana route mappings, strict direct-USDC and native-SOL quote validators,
canonical Solana receive scanning, finalized receipt reconciliation, and a
guarded live-rehearsal path. These are real foundations, not delegated
activation:

- the production delegated Privy driver currently submits EVM actions only;
- live signer/policy verification currently requires an Ethereum policy;
- no reviewed Solana policy manifest/fingerprint validator or SVM execution
  profile is registered;
- native SOL valuation is disabled until a price/cap policy is selected;
- the normalized SVM action does not yet freeze fee payer/sponsorship identity.

Slice E should fill those narrow seams. It must not duplicate the funding
planner, receipt router, operation state machine, Telegram lifecycle, or
reconciliation worker.

### Current product and rollout impact

The live drift is not currently a silent value-moving bug:

- production Funding Policy already lists `solana:sol` and `solana:usdc`, so
  those assets are present in control-plane data even though no delegated SVM
  capability is active;
- the production web `main` branch has the unified Funding UI reverted and
  therefore does not expose the SVM action flow;
- the web `develop` branch already builds and user-signs normalized
  `svm_transaction` actions, but the backend rejects the current Polygon quote
  before an action or quote can be committed;
- Telegram registers Polygon/Base adapters only and does not advertise a
  Solana receive route;
- read-only production aggregates since the current Funding Policy publication
  contain no persisted Solana funding quote or Solana funding step.

The immediate effect is therefore future-web unavailability/UX failure, not an
unsafe transaction. Before the unified web UI returns to production, either
update the Polygon validator for the direct Depository shape or remove the
Solana assets from the published policy. Telegram Solana remains a separate
Slice E activation and must not become visible merely because the compact
Funding Policy already contains those assets.

The historical fixture is not read by production quote execution. Runtime asks
Relay for a fresh quote and then dispatches validation by route/destination.
The bug is in that dispatch boundary: Base already selects the direct
Depository validator, while Polygon still selects the historical
native-SOL/Jupiter validator. The smallest code change is to parameterize the
existing direct validator with the exact registered destination, pin the
Polygon route spec to the direct-Depository shape, and reject every other shape.
Keep the old fixture as a negative provider-drift test and add a new sanitized
direct-Polygon fixture; do not dynamically accept both envelopes, delete
evidence, or add a second Solana execution workflow.

### Solana USDC direct Relay

Current evidence normalizes one Relay Depository instruction and one ALT. The
Hunch validator binds the exact Relay program, discriminator, raw amount,
protocol order ID, controlled signer, source ATA/mint, account order,
signer/writable flags, recipient/refund evidence, and destination floor.

Privy can independently restrict the method and Relay program ID, but cannot
read that custom instruction's discriminator, amount, order ID, or accounts.
Activation therefore also requires proof that the pinned Relay Depository
program/version is itself a narrow immutable boundary whose other entrypoints
cannot move user value outside the intended deposit contract.

### Native SOL through the Relay Depository

The fresh 2026-08-20 Polygon pUSD quote has this bounded outer shape:

- one versioned Solana transaction;
- one outer instruction;
- official Relay Depository program
  `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`;
- Anchor discriminator `0d9e0ddf5fd51c06` (`deposit_native`);
- exactly 48 data bytes: discriminator, little-endian `u64 amount`, and
  `[u8; 32] orderId`;
- five accounts, exactly one signer, and two writable accounts;
- one active ALT;
- an executable BPF program whose ProgramData has no upgrade authority.

No wallet signature or broadcast was created during this capture. Official
Relay documentation confirms that the Depository is non-upgradable, that
`deposit_native` transfers SOL into its PDA vault, and that the Solana program
uses the same 8/8/32-byte instruction layout. This is materially smaller than
the historical Jupiter envelope and reuses the direct-Depository shape already
validated by Hunch for `solana-sol-to-base-usdc`.

The current Polygon path nevertheless remains fail-closed: it still selects
the historical native-SOL/Jupiter validator, which rejects the fresh quote at
`origin swap output currency mismatch`. Slice E must generalize the existing
direct-Depository validator to bind the route's exact destination instead of
adding another provider-specific workflow.

The immutable Depository is strong containment, but a bare Privy program-ID
allowlist is not exact authorization. Privy cannot inspect the discriminator,
amount, order ID, account roles, or writable flags for this custom program.
Relay documents `orderId` as the protocol deposit/correlation identifier; the
Depository does not verify the requested destination or minimum output. A
compromised submitter could therefore choose another amount or another Relay
order while still calling the allowlisted program.

## Selected outer boundary and activation gate

The decision on 2026-08-20 is deliberately split by execution mode:

- **user-authorized web execution:** use the existing client authorization
  signature over the prepared Privy request, or the connected-wallet signature
  over the exact versioned transaction, together with Hunch validation. The
  current generic frontend SVM assembler already supports one instruction and
  one ALT; no Relay/Jupiter-specific frontend executor is required;
- **delegated automatic execution:** reject the current Relay-program-ID-only
  Privy policy as the outer boundary. The selected target is a narrow on-chain
  exact-intent router, but it is not implementation-ready until the Relay order
  ID is cryptographically bound to the authorized destination, refund, minimum
  output, amount cap, nonce, and expiry. A router that merely CPI-calls the
  Relay Depository is not a security improvement;
- **safe fallback:** keep delegated SVM off. If the exact-intent commitment is
  unavailable, retain user-authorized web execution and do not expose automatic
  Telegram SOL funding.

Native SOL server execution remains disabled until one of these boundaries is
proved and reviewed:

1. **Privy-decoded boundary:** Privy exposes enforceable custom Solana
   conditions for the Relay `deposit_native`/`deposit_token` discriminator,
   accounts, signer, order ID, and bounded amount; or
2. **Narrow on-chain intent boundary:** an immutable, audited Hunch/partner
   Solana router accepts a user-authorized frozen intent, enforces source wallet,
   maximum amount, one-time nonce/expiry, exact Relay Depository state/vault,
   and the authorized Relay order ID before CPI. The order ID must itself be
   bound to the disclosed destination/refund/minimum-output facts by the user's
   signature or an independently verified Relay commitment; application DB
   state alone is insufficient. Privy permits only this router program; or
3. **Equivalent independent boundary:** a reviewed mechanism provides the same
   key-compromise containment and is demonstrated by negative live policy
   tests.

Application validation alone is not sufficient for this gate. A user clicking
Trade Confirm is necessary economic consent, but it does not replace a
key-level restriction on what the server signer can submit.

If none of the three boundaries is available, the route may remain an explicit
user-signed client action, but it must not be advertised as delegated automatic
funding. For external destination-scoped Deposit, a future separately reviewed
strict Relay Deposit Address could avoid delegated SVM signing entirely. The
current Hunch adapter is native-EVM/controlled-sender only, so Solana/manual or
exchange ingress is not an available shortcut. Any extension remains an
exact-amount, quote/expiry/refund contract and must not be confused with the
owned reusable receive-address flow.

## Candidate policy shape after the gate passes

The complete shared Solana policy must contain only reviewed instruction
families needed by activated SVM profiles:

- `method = signAndSendTransaction` for every rule;
- exact allowlist of the proved intent-router program, or the Relay Depository
  only after Privy supports the required decoded custom fields;
- no System/SPL rules for the current direct native-SOL envelope: its SOL
  movement is an inner CPI and a System Transfer rule would not bound the outer
  custom instruction;
- separate decoded SPL rules only for a route that actually contains outer SPL
  instructions, with mint and amount restrictions wherever Privy exposes them;
- exact fee-payer requirement at the Privy or independently enforced boundary;
  do not assume a static fee payer is policy-visible without proving it;
- optional time window only as defense in depth, never as the sole amount or
  destination bound;
- no general System/SPL allow rule, `method=*`, private-key export, arbitrary
  signing, historical Jupiter/Relay programs, or unreviewed utility program.

The candidate policy is generated as one complete manifest. The validator
rejects extra rules, duplicate rules, missing caps, broad alternatives, unknown
program IDs, the wrong chain type, and a serialized read-back fingerprint that
differs from the reviewed manifest.

## Fee payer and zero-SOL wallets

`Pay with SOL` naturally has source SOL, but Solana USDC users may have no SOL.
The normalized action must explicitly identify the fee payer and sponsorship
mode. The preferred product path is a capped Hunch/Privy fee payer so a user can
fund with USDC alone. Privy documents both `sponsor: true` server submission and
custom Solana fee-payer flows; neither is assumed to work with the exact
delegated wallet/policy until rehearsed.

Activation must prove:

- who signs as source owner and who pays the fee;
- that policy evaluation observes the expected fee payer after transaction
  assembly and sponsorship;
- that sponsor changes do not alter instruction/account/ALT identity;
- that a zero-SOL USDC wallet either succeeds through the proved sponsor or is
  honestly unavailable before address/Buy confirmation;
- that native SOL input retains the larger of the measured fee/rent reserve and
  the Funding Policy reserve rather than promising the full balance.

## Required proof matrix

### Read-only envelope capture

Capture fresh normal Relay quotes for both:

- `solana-usdc-to-polygon-pusd`;
- `solana-sol-to-polygon-pusd`.

Record sanitized program IDs, instruction count/order, discriminators,
account-role fingerprints, signer/writable sets, ALTs, quote TTL, blockhash
contract, source/minimum-output bounds, Relay request ID, recipient/refund, and
program deployment fingerprints. The 2026-08-20 native-SOL capture satisfies
the read-only shape check but must still be promoted to a sanitized current
fixture during implementation. A quote change blocks activation; it is not
silently normalized into the old profile.

### Policy rehearsal

Use a non-production wallet and the real serialized versioned transaction.
Prove the reviewed positive envelope passes and each mutation below fails at
the claimed boundary:

- extra instruction or reordered instruction;
- another program or the historical Jupiter/Relay envelope;
- changed Relay discriminator/order/recipient/refund;
- SOL transfer above cap or to another account;
- wrong SPL mint, source, authority, destination, or amount;
- unexpected signer/writable flag;
- unreviewed ALT or movement of a policy-inspected address into an ALT;
- different fee payer/sponsorship mode;
- message signing, raw transaction signing, wallet action, or key export;
- replay after blockhash expiry and lookup after an ambiguous submission.

The test report must state which failures were enforced by Privy, the narrow
on-chain boundary, and Hunch. A mutation rejected only by Hunch does not count
as proof of the Privy/on-chain outer boundary.

### Durable execution and recovery

After policy proof, the existing Funding Operation machinery must demonstrate:

- immutable Trade/Deposit consent and exact operation fingerprint;
- attempt persisted before provider submission;
- `reference_id`/idempotency correlation and lookup-before-retry;
- no blind retry for an unresolved signature or expired blockhash;
- exact finalized source debit and destination pUSD credit;
- owned refund only after proved source debit and matching Relay reference;
- restart at every possible-broadcast boundary;
- no duplicate conversion, Relay deposit, destination credit, or Buy;
- current wallet, signer, policy ID/fingerprint, authorization, cap, and pause
  rechecked immediately before first broadcast.

## Implementation boundary

Slice E extends the existing architecture; it does not add another workflow:

- reuse the durable delegated attempt/recovery executor;
- add an SVM-specific transaction assembler/transport behind the existing
  executor interface rather than branching Telegram or the receipt router;
- parameterize signer verification by chain type instead of weakening the EVM
  verifier;
- keep Solana quote/action validation in the Relay adapter;
- add exact Solana source-debit/refund evidence and SVM postconditions;
- keep API and finance-worker configuration sidecar-safe;
- retain separate capability IDs and activation flags for Solana USDC and
  native SOL even though they share one Privy policy.

## Activation sequence

1. Keep the SVM execution gate absent or false.
2. Freeze the current direct-Depository envelope and choose one acceptable
   native-SOL outer boundary.
3. Implement and review the complete Solana policy manifest validator.
4. Create one owned shared Solana policy, read it back, and record its exact
   fingerprint. Do not attach it to production wallets yet.
5. Prove the positive/negative policy matrix on a disposable wallet.
6. Prove idempotent managed attachment of the same signer/policy to multiple
   Solana wallets; no per-user policy creation is allowed.
7. Run disposable-Postgres migration/integration/restart tests and the full
   funding regression suite.
8. Run one separately authorized tiny live native-SOL rehearsal with a hard raw
   cap and no Buy submission, then a second tiny end-to-end Buy rehearsal.
9. Attach the policy and enable capability only for the reviewed route/profile.
10. Observe the first real operations until terminal before widening caps.

## Rollback

1. Disable only the SVM first-broadcast gate; keep receipt observation,
   reconciliation, provider lookup, and refunds running.
2. Do not remove the policy or signer from wallets with an unresolved possible
   broadcast.
3. Preserve received SOL/USDC as Account Value and present a typed recovery or
   explicit user-signed path.
4. After every SVM attempt is terminal, remove unneeded rules through a complete
   manifest update, read back the fingerprint, and update runtime configuration
   together.

## Exit criterion

Slice E is ready for activation only when a history-free reviewer can answer
all of the following with evidence:

- one shared Solana policy is attached safely without per-user policies;
- every instruction in the actual native-SOL transaction is allowed only by an
  intended rule;
- arbitrary Relay Depository instructions, amounts, and order IDs cannot be
  authorized by compromise of the Hunch submission process;
- fee payer, ALT, blockhash, caps, exact action, source debit, destination
  credit, refund, retry, restart, and policy-revocation behavior are proved;
- `Pay with SOL` needs one understandable economic confirmation and no
  technical route choice or second conversion prompt.
