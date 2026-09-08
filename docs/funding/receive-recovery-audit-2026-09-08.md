# Eleven receive-recovery receipts: individual audit

## Method and scope

Read-only production PostgreSQL and secret-bootstrapped Base/Polygon RPC checks
on 8 September 2026. Scope: exactly eleven `recovery_required` receipts whose
stored `lateReceipt` is false. No production writes or transactions were made.

For every incoming receipt, independently verified successful transaction,
canonical block hash matching the persisted hash, exact ERC20 contract, log
index, sender, recipient and raw amount. **All eleven passed.**

For four receipts with children, inspected all eight operations, including
detached `routingOperationHistory`, not only the latest child. All eight are
failed, their jobs completed, and each has zero active balance reservations.
All eight Relay status reads returned `waiting`, with no input/output transaction
hash fields. The only recorded broadcast actions are seven approvals; all seven
were independently verified onchain against the exact Approval event.

These facts do not prove the original tokens are still unspent today. Tokens
are fungible and may have been used by later unrelated operations. Do not add
these historical amounts to today's balance or issue a second credit.

## Individual results

| Receipt ID                             | Received asset and amount | Routing evidence                                                                                                          | Disposition                                                                              |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `74731151-2cd0-4441-845c-d7f656e433f7` | Base USDC 0.505054        | `receipt_quote_plan_invalid`, six attempts, no child/history                                                              | Received, conversion not created; close old scenario without claiming conversion/refund. |
| `9e340c64-65fa-47ff-9c94-7f1dc2eba480` | Base USDC 0.000002        | Same plan error, six attempts, no child/history                                                                           | Received dust; no conversion to resume.                                                  |
| `b1127559-0cd5-42fe-97d2-9a6b84e42f95` | Base USDC 1               | Three failed children; three confirmed approvals; outgoing action unattempted or rejected with `delegated_action_invalid` | Old conversion failed before recorded debit; do not retry old children.                  |
| `7af114be-3c95-4562-9d62-4c5591544f74` | Base USDC 1               | Three failed children; three confirmed approvals; outgoing action unattempted or rejected with `delegated_action_invalid` | Same; preserve detached history and approval evidence.                                   |
| `4a9ddf67-e5d7-45a1-9f59-e12d227c74af` | Base USDC 0.5             | One failed child; confirmed exact 500000 approval; outgoing action rejected with `delegated_action_invalid`               | Conversion stopped; approval is not payment.                                             |
| `f05f2b22-70c4-4f8e-a40d-d694bf3c5ae9` | Polygon pUSD 1            | One failed child, `relay_action_expired_before_broadcast`; neither approval nor transfer has an attempt                   | Conversion expired before submission; no Relay poll/retry needed.                        |
| `f4dadc3e-1268-4a7e-bd8a-dfa4271257ce` | Polygon USDC.e 0.3        | `routing_attempt_failed`, five attempts, no child/history                                                                 | Received, route creation failed; no unresolved submitted child.                          |
| `2cf4007e-2832-44ce-823b-8b6442b55e8e` | Base USDC 0.000001        | `routing_http_error`, five attempts, no child/history                                                                     | Received dust, no route created.                                                         |
| `794ea55e-d0cf-4735-9d63-206460308b6e` | Base USDC 0.012942        | Same HTTP error, five attempts, no child/history                                                                          | Small received amount, no route created. Do not infer exact provider HTTP cause.         |
| `ac3c822d-2739-469e-9f3a-13933a3fd1b4` | Base USDC 0.000004        | Same HTTP error, five attempts, no child/history                                                                          | Received dust, no route created.                                                         |
| `77324124-31b9-4367-a026-a1e91a5cd50e` | Base USDC 0.000001        | Same HTTP error, five attempts, no child/history                                                                          | Received dust, no route created.                                                         |

Seven no-child receipts have no outgoing execution journal under these routing
links. This is not a universal onchain proof that the wallet never sent another
transaction. The five old generic routing errors lack a precise durable cause;
do not relabel all of them rate limiting, minimum amount or missing gas.

## Child operation manifest

- `b1127559`: `1b9a7fd0-cca8-4a55-815a-5e1a275da7da`,
  `5b72fde2-153b-4993-b5ea-d84c0e621d03`,
  `13196e38-261a-436f-bdb4-8ff9abcc3cbb`.
- `7af114be`: `631dd632-1576-4778-a003-90b195093e2b`,
  `f18f6d4d-f4fb-4c45-8638-5fc1ae14e780`,
  `75df3ff1-f368-43c6-b049-206659d09d51`.
- `4a9ddf67`: `b964c3d9-fd10-4818-9a7a-efe23a563023`.
- `f05f2b22`: `8bba5d11-0d99-4d28-adbc-fdf661887200`.

The four current children contain canonical `source_credit` observations for
the corresponding incoming amounts. No source debit, destination credit or
refund is recorded for any of these eight operations. Do not interpret an
incoming `source_credit` as successful conversion.

## Allowance caveat

Owner `0x09c88f1d3cdD98C356A21434Cd4Af40CcE795314`, spender
`0x4cD00E387622C35bDDB9b4c962C136462338BC31`:

- Base block 51018450: USDC allowance 8393456 raw; balance 81778 raw.
- Polygon block 93414144: pUSD allowance zero; balance zero.

The present Base allowance differs from the historical approval amounts. It
cannot be attributed solely to these receipts. Do not revoke it automatically
when archiving them: it may belong to later authorized activity. This audit did
not establish an unauthorized spender or drain. Separate allowance cleanup
requires checking current usage and fresh transaction authorization.

## Correct closure semantics, including late unrelated transfers

The user clarified that an expired deposit scenario must not own every later
transfer to the same reusable wallet address. Separate three facts:

1. The receive/consent window is closed (`expired` or `cancelled`).
2. A canonical transfer was received and remains in financial history.
3. No conversion is running or authorized by that old scenario.

For these eleven records, closing the **old scenario** is justified; calling
the requested conversion successful is not. Current sessions are already
expired and child jobs stopped. No money-moving repair is needed merely to
remove their stale recovery presentation.

Minimal implementation and boundaries:

- Preserve terminal receive-session state when a late transfer is observed.
  The local patch stops `fundingReceiveObservationDisposition` from escalating
  a closed session merely for a late non-direct receipt. The closed-session
  writer retains its terminal status. Genuine allocation ambiguity still has
  its separate recovery path.
- Preserve canonical receipt/deduplication history. Exclude a closed,
  unconverted receipt from active-work presentation when it has no unresolved
  child. Do not use `ready` as a shortcut: that would assert destination readiness
  for an asset that was never converted.
- Retain historical errors as history, not as a promise of ongoing recovery.
  If useful, expose “received; old conversion not performed” as a derived
  presentation, not an instruction to a worker.
- An actually submitted child stays under its existing reconciler even after
  receive-session expiry. Never apply the closed/no-work classification to
  an unknown broadcast or unresolved child.
- A later incoming transfer must not revive a Buy or satisfy its shortfall
  solely because the wallet address matches. Allocation still needs the
  canonical identity, observation window and applicable consent.

For the separately classified 44 late receipts: do not automatically convert,
refund or require the user to finish the old scenario. Keep the received money
in the normal wallet/account view without a second credit. Distinguish an
observation association from proof that the user intended the old deposit.

## Repair preflight

Before any historical update, pin these exact IDs, session versions, child
history and current attempts. Recheck no newly attached child/reference,
active reservation or live consumer. Preserve amount, token, transfer identity,
canonical event allocation and source-credit observations. The repair changes
only obsolete workflow classification, not money balances or receipt evidence.

No repair SQL was executed. This audit completes the individual classification
of all eleven. The local patch now prevents closed-session reopening, with unit
coverage and PostgreSQL 16 integration coverage for completed, expired and
cancelled sessions. It retains the existing receipt-level recovery label as
historical unconverted evidence; it does not rename receipt enums or pretend
destination readiness. Any separate receipt-history copy change belongs to
the frontend contract, not a financial state rewrite.
