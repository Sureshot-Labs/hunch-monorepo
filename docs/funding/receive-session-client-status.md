# Deposit address and transfer status

`GET /funding/receive-sessions/:id` returns the Hunch receive session lifecycle
(`session.status`) and observed transfers (`receipts`) independently.
The new `depositStatus` is `observed` when there is at least one receipt
and `not_observed` otherwise. It is also returned when opening a session.
On an older backend, read `receipts` to make the same distinction.

- `session.status: expired` closes the Hunch receive session after 24 hours;
  it does not change or disable the on-chain address. Refresh the receive
  setup before a new deposit; a new session may show the same address.
  Hunch monitors late transfers during a separate grace period. Expiry
  without a receipt doesn't prove that a transfer never happened. Use
  `session.expiresAt` to decide when to refresh the setup, even if the
  background status update hasn't run yet. Don't use it to classify receipts.
- For a new deposit, fetch a fresh receive option, open with a new
  `idempotencyKey`, and poll the `receiveSessionId` returned by that POST.
  Reuse the old key only to recover its original open response. Receipts
  already attached to the original session stay there.
- If a receipt exists, use its `status`, `rawAmount`, and `asset.decimals`
  for the specific transfer. An expired address does not turn an observed
  transfer into an expired transfer. `observed` alone does not mean funds
  are ready in the destination wallet.
- `recovery_required` + `sourceUnavailable: true` means the original
  unconverted funds are no longer available for that receipt's route.
  `recoveryReason: source_spent_after_receipt` means a later finalized
  debit and insufficient source balance were observed.
  `source_balance_insufficient` means insufficient source balance was
  confirmed without attributing it to a particular debit. Don't prompt
  the user to resend to the old address or retry the old conversion.
