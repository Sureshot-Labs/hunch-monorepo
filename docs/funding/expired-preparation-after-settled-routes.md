# Expired preparation after settled routes

## Incident

Operation `384ef2af-1c7d-4a82-b168-3f58adc9e57a` completed both bridge
steps but never started its final venue preparation. That action expired at
2026-09-08 21:50:46.401 UTC. A read-only production check at 22:03 UTC
confirmed two `succeeded` steps and an expired `planned` preparation.
The operation continued projecting `in_progress/routing`.

## Cause and fix

The existing settled-partial-Buy predicate supported an omitted bridge after
completed local preparation, but not the reverse. Extend that same predicate:
all local preparation actions must have expired without a possible broadcast,
and every moved route must have canonical final destination evidence meeting
its sealed minimum and successful source execution. A separately required
source-debit observation remains mandatory. For executors without that
requirement, a matched canonical final action receipt is required instead.
Any present conflicting debit still prevents closure.

The funding operation fails terminally; this is not a successful Buy or a
refund. Existing terminal cleanup releases active, non-consumer-settled
reservations. Cash already delivered remains in the destination wallet.
No new transaction, automatic retry, or historical Buy continuation is added.
No schema or migration changes are required.

## Adjacent paths reviewed

- Completed local preparation plus an omitted expired bridge: existing closure.
- Settled bridge plus omitted expired bridge: existing closure, same evidence checks.
- Settled bridge(s) plus omitted expired local preparation: new closure.
- Still-valid preparation: remains actionable; must not close early.
- Possible broadcast, unresolved consumer, missing required debit, reorg or
  underfilled bridge: must remain under evidence reconciliation, not be
  declared safe merely because time elapsed.
- Completely unbroadcast expired operations: existing worker expiry handling.

This is a bounded lifecycle review, not proof that every historical operation
has been reconciled. Production was not mutated. Deployment and the next
worker reduction must be checked separately for the incident operation.
