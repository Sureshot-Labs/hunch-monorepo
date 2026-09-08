# Telegram receive and client recovery patch

## Scope

Backend-only follow-up to the frontend's
`docs/backend-tasks/funding-recovery-execution-preflight.md` contract.
No production data repair, automatic historical Buy replay, or frontend changes.

## Telegram receive

- Opening a new context with exactly one supported direct receive asset selects
  that asset through the existing consent/selection boundary. The verified
  address still goes through the durable delivery and ownership checks.
- Multiple assets, unknown routes and server-side conversion retain explicit
  selection. Read-only session/status requests never select an asset.
- Selecting pUSD again after Back rearms the existing address delivery. It does
  not create another receive session or another transfer.
- A Buy-associated waiting screen uses the non-cancelling Back to market action.
  Explicit cancellation renders its cancellation result rather than a market
  card that the cancellation outbox immediately overwrites.
- Deposit SOL, USDC & more opens `/tg?deposit=bridge` in Hunch. This uses the
  existing Mini App entry and deposit query contract. It does not attach a new
  app deposit session to the old Telegram context or automatically continue a Buy.

## Operation execution preflight

Every full operation response includes nullable `executionPreflight`:

```json
{
  "operationId": "operation_example",
  "operationVersion": 3,
  "complete": true,
  "requiredControllerWalletRefs": ["controller_wallet_ref"]
}
```

The controller set comes from committed action fingerprints, executor IDs and
the immutable wallet execution snapshot. It includes planned dependent client
legs, deduplicates controller refs, and excludes already submitted or finished
legs and known server-only executors. It is not a list of currently linked
wallets and does not assert that an extension is connected.

Missing, conflicting or malformed controller facts, unknown executors and a
version race return `complete: false`. Status remains readable. No action is
prepared, signed or sent by this read. The frontend's existing recovery preflight
can consume this response without another frontend patch.

## Late submission evidence

The existing action-report endpoint accepts one monotonic enrichment of an
owned attempt: reference-less `ambiguous` can become `submitted` or `ambiguous`
with an encrypted transaction/provider reference. The attempt ID, action binding,
original report timestamp and broadcast uncertainty are preserved.

Exact report replay remains idempotent, including after Privy resolves its
provider reference to a transaction or a definitive failure. An opaque fingerprint
of the accepted late report is retained for acknowledgement; it cannot replace
the resolved reference or outcome. An accepted reference cannot be replaced by
a conflicting report. Reference normalization and ownership checks remain in
the action runtime. The reference triggers ordinary receipt reconciliation; it
does not itself prove a successful transfer or authorize another send. Canonical
completion facts retain precedence over a late report.

## Deployment and smoke checks

Include migration `0252_funding_late_client_reference.sql` with this patch. It
replaces the attempt-update guard function and does not scan or modify historical
rows. The previous provider-resolution and bounded-retry guards are retained.
The migration and changed SQL were exercised against local PostgreSQL 16.

After deployment:

1. Open direct pUSD deposit, then Back and select pUSD again. The verified address
   must return without a duplicate session.
2. Open a deposit from a market and return to the market before sending. This must
   not cancel the receive session or replace the market with Receive cancelled.
3. Open Deposit SOL, USDC & more; verify Hunch's normal deposit flow appears.
4. Restore a composite in a browser without a required external wallet. No new
   leg should execute until all remaining controller connections pass preflight.
5. Deliver a late reference for an acknowledged ambiguous attempt. It should be
   accepted once, reconcile normally, and accept identical report retries.

The old reservation/bridge accounting audit remains separate. This patch does
not claim those rows are repaired or all harmless; defer manual changes until
their individual evidence and current operational impact have been verified.
