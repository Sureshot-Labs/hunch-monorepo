# External Solana submission without a reference

## Incident evidence (read-only)

Operation: `e9a660c5-f8b6-476b-8c50-151ba1cac059`.
Attempt: `44375a1b-1786-4ba3-8f34-21185a9021a0`.

- The Polygon preparation has a matched canonical finalized receipt.
- The external Solana attempt reported ambiguous, possible broadcast, without
  a transaction reference. The following Base action never started.
- The browser logged Phantom's disconnected service-worker port during
  `signAndSendTransaction`.
- Relay returned waiting for both exact route references, with no transaction
  hashes. References were decrypted only inside the production process.
- Confirmed RPC history for the source wallet had no transaction after
  September 4. Its USDC token account had none after June 21.
- At finalized slot 445454415, the token account held 1.782570 USDC. The
  planned transfer was 1.398210 USDC.

These facts establish no observed execution at the check, not a reusable
proof that an arbitrary wallet request cannot later broadcast. Do not convert
this attempt to failed/non-broadcast by overwriting its original report.

## Implemented recovery contract

The old external wallet path combined signing and sending. Connected state
does not establish service-worker health. The new funding path separates them:

1. Prepare stores a server-observed blockhash and last-valid block height on
   the started attempt. Replays cannot extend it.
2. The external wallet signs only. During signing the recovery journal denotes
   no broadcast, not an unknown send. Rejection or a disconnected port fails
   before submission.
3. Before broadcast, the journal durably retains signed bytes and the exact
   signature. The action report sends `signedTransaction` with an ambiguous
   reference. The server verifies Ed25519, the entire committed message,
   source signer, lookup tables and its own blockhash; the client cannot supply
   the trusted expiry metadata. Delayed registration also works after expiry.
4. Only an acknowledged report allows the frontend's single broadcast of those
   same bytes. A reload replays evidence, never a signature or a send.
5. Reconciliation uses that signature. A finalized block height beyond its
   last-valid height plus fresh absent history/status and transaction reads
   produces authoritative non-execution. RPC errors, pending execution or an
   earlier confirmed/finalized receipt cannot be replaced by timeout failure.
6. An expired omitted source with final failure can terminate an otherwise
   settled partial Buy. Existing successful credits remain cash; the old Buy
   does not revive. Failed transactions may still have paid a network fee.

The diagnostic `funding_wallet_submission_unknown` still explains historical
no-reference ambiguity without granting retry. No migration, sponsorship
permission or production mutation is introduced.

## All-chain reserve scope and EVM boundary

The shared reservation predicate applies to EVM and Solana. An unrelated
operation-level preparation no longer holds every source segment. An actual
dependency ancestor still holds its own source; unscoped historical rows remain
conservative. Admission, displayed availability and stopped-source reduction use
the same predicate.

Embedded EVM provider references, relayer references, exact receipt checks and
late-reference enrichment remain unchanged and covered by tests. External EVM
`eth_sendTransaction` can still lose its response before a hash is returned.
It remains an explicitly unknown outcome, without a resend or an invented
timeout release. Solana blockhash expiry is not an EVM nonce-expiry rule.

## Deployment order

Backend first, then the narrow frontend continuation/signing change. Both web
and Telegram handoff use the shared funding executor. Internal sponsored
Solana, EVM execution and non-funding position actions keep their existing path.
The additive API fields are optional for older clients. New external Solana
funding refuses to sign without a server signing context. Regenerated client
types change only the two affected funding shapes.

## Required regression coverage for the recovery protocol

- Wallet fails before returning signed bytes: no broadcast by the application.
- Reload after signing, after durable registration, and after broadcast.
- Accepted RPC broadcast with lost response: recover the registered signature.
- Expired transaction absent at finalized commitment: close without a Buy.
- Pending, landed, conflicting or reorged receipt: never classify by timeout alone.
- Signature/message/blockhash substitution and wrong account/attempt: reject.
- Completed Polygon sibling retains its credit; only unused reservations release.

## Historical operation: exact restoration plan

Read-only DB recheck at **2026-09-08 23:29:04 UTC**: operation remains version 23,
`recovery_required/manual_review`. There is still no Solana reference or
receipt; the Base action still has no attempt.

| Reservation                            | Source                 | Plan                                                                                                                                                                      |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d1b45492-95c1-4278-8743-290df86bc0bb` | Polygon, 0.305535 pUSD | Already released with finalized preparation; retain its accounting.                                                                                                       |
| `36e5784c-1996-4135-a1d3-c8f07e4ce5b4` | Base, 2.821918 USDC    | Quote expired, own segment never submitted, no dependency on Polygon. New shared predicate stops subtracting it; no manual DB mutation is needed to restore availability. |
| `8294ca6c-3bcc-4736-b79a-e56c2829f67b` | Solana, 1.398210 USDC  | Own attempt is unknown and has no historical signed identity. Retain this hold pending evidence; do not falsify a failed receipt.                                         |

After deployment, recheck these exact rows, source availability and the worker
state. A completed manual-review job need not be requeued just to make Base
spendable; the balance predicate handles the expired row independently. If
materializing its released status is operationally needed, use the existing
locked release/reduction path only after an exact fresh preflight and approval,
not an operation-wide `UPDATE state`.

The new predicate was also executed as a **read-only SELECT on production**
for these two active rows: Base returned `would_hold_after_fix = false`, Solana
returned `true`. This checks the actual stored topology, not only the fixture.

For Solana, obtain any recoverable wallet signature/signed bytes and reconcile
the exact canonical action, source debit and Relay outcome. A positive receipt
continues accounting, not a historical Buy. A proven finalized failure permits
release. Absent that evidence, a blanket manual unlock is not a verified repair.
The future protocol does not retroactively supply an old signature. No
production rows were changed during this investigation.

## Verification and remaining smoke check

- Funding unit suites, exact signed-message mutation tests and receipt expiry
  checks pass; EVM hashes/Privy/relayer recovery remain covered.
- PostgreSQL 16 disposable integration suites cover source hold isolation,
  immutable signing context, replay conflicts, late reports, cancellation,
  source/action races and funding lifecycle persistence.
- Frontend full suite, type checks, lint and formatting are checked separately.
- A real Phantom/Telegram reload-and-disconnect smoke test has not been run:
  this change was not deployed and no transaction was signed or submitted by
  the agent. Run it after backend-first deployment with user-confirmed amounts.
