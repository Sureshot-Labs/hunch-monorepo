# Partial source reservations at funding commit

## Incident and change

The planner offered 384360 raw USDC from a source with 1782570 raw USDC and
an existing hold of 1398210. Commit rejected any existing hold on the component,
even though the planner had already deducted it.

Shared admission now retains the existing per-user/component advisory locks,
in the same deterministic order. It locks all currently held source reservations
and checks a newly collected account availability snapshot before inserting the
new reservation. The snapshot must include at least the locked holds, belong to
the exact owner/location/asset, be fresh, and cover the new amount. Native SOL
also retains the existing native execution reserve.

The runtime collects that snapshot only for shared sources, after the locks;
it does not reuse the account loaded before commit. This adds one account read
to shared admission, not a Relay quote. Collection failure, stale data or a
concurrent accounting transition fails closed. Quote expiration is rechecked
after capacity verification, before any operation is persisted.

Future-credit fences and combined source/future-credit reservations retain
exclusive admission. They are not promises of present spendable cash. Callers
without the capacity verifier also retain the previous exclusive behavior.
Normal web and Telegram handoff commits use the common funding runtime verifier.

No reservation is released by this change. In particular, the historical
unknown Solana submission remains held. No historical Buy is resumed.
There are no migrations, public API changes, or frontend changes.

## Verification

- Raw remainder: exact 384360 succeeds; 384361 is rejected.
- EVM USDC, Solana USDC and native SOL gas reserve boundaries.
- Wrong owner/location/asset, stale observations, unknown availability and
  snapshots missing held amounts are rejected.
- Real PostgreSQL 16 concurrency: with the old hold present, two requests for
  the last 384360 produce one commit and one rejection. The second capacity
  check sees the winner's committed reservation; idempotent replay adds none.
- Future-credit fences remain exclusive; expiration during shared verification
  rejects the commit atomically.
- Funding unit suite and PostgreSQL persistence, composite-race, receipt/action
  persistence and reservation-lifetime regression suites.

Live purchase execution is not part of these tests. After deployment, request
a fresh quote; do not replay an expired quote or resend the old unknown transfer.
