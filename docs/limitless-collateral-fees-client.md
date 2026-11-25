# Limitless CLOB: signing and collateral-fee checks

Use the authenticated
`GET /trade/limitless/market/exchange?slug=<slug>&checkFeeAllowance=true`
with the **selected trading wallet**. The response retains
`exchangeAddress` and `adapterAddress` and adds `feePolicy`:

| API field                     | Legacy CLOB                  | Collateral-fee CLOB                       |
| ----------------------------- | ---------------------------- | ----------------------------------------- |
| `feePolicy.mode`              | `legacy`                     | `collateral`                              |
| `feePolicy.signingFeeRateBps` | Live profile rate, or `null` | `0`                                       |
| `feePolicy.feeModule`         | Absent                       | Exact Base spender for this market        |
| `feePolicy.collateralToken`   | Absent                       | Base USDC contract                        |
| `feeModuleAllowanceRaw`       | Absent                       | Decimal string; `null` if the read failed |

- Keep the existing legacy signing logic. For collateral mode, set the order
  field `feeRateBps` to zero **before** EIP-712 signing. Use `exchangeAddress`,
  not the fee module, as the signing domain. Never modify a signed order.
  When the legacy rate cannot be read, use the account profile and existing
  fallback; a stored credential cannot override the live rate.
  The server does not add a legacy signed-fee rate check. For a new CLOB
  submission it still needs a live market response to determine the fee mode;
  an unavailable mode cannot safely be assumed to be legacy.
- For FOK Buys and Sells, zero allowance needs a separate, explicit
  Base USDC approval to `feeModule`. Keep the existing exchange and conditional
  token approvals. Check the same wallet/module again after confirmation.
  An unavailable read is not a request for another approval.
- If using the sponsored embedded EVM transaction flow for this approval,
  include `limitlessFeeMarketSlug` on the transaction in both prepare and
  execute. The API independently checks the exact market's fee module, token,
  chain and call. It does not sign an approval without user authorization.
- A confirmed venue rejection with
  `limitless_fee_module_allowance_insufficient` can also mean a positive
  allowance was too small. Offer a separate explicit allowance update. Do
  not automatically repeat the order or create a new funding operation.
- On the funding quote or commit, `409 limitless_fee_module_approval_required`
  means the sealed destination wallet has no fee-module approval. The pending
  trade funding flow can be reviewed again after approval. No transfer or
  venue order is automatically retried. The same positive-allowance check
  runs before new funding actions leave their server-side prepare/broadcast
  boundary. It does not prevent an allowance from changing later on-chain.
- `409 limitless_fee_rate_mismatch` at fresh signing/submit means refresh and
  obtain a new user signature. For an already submitted or uncertain request,
  keep following the original order status; do not make a new order.
- If `/funding/capabilities` advertises `limitlessGtcFundingOrderBinding`,
  a Limitless limit Buy can send `limitlessOrderType: "GTC"` to
  `/funding/quotes`. This seals the funding reservation for a GTC order;
  a FOK order cannot use that reservation. Omit the field for market orders.
- `503 limitless_fee_policy_unavailable` or
  `limitless_fee_module_allowance_unavailable` is retryable read unavailability.
  Address-only consumers can omit `checkFeeAllowance`; they may see a null
  policy for non-CLOB or unavailable venue data.

`0` is a signing value, **not** a fee estimate. Limitless checks the Buy
principal plus a fee reserve and charges the actual USDC fee on execution.
Do not display `0%`, reuse the legacy profile fee for a collateral quote, or
infer order acceptance from approval. A nonzero allowance alone does not
prove it covers the actual fee. Hunch does not silently increase an existing
approval or ask for approval to resolve a balance shortfall.

[Limitless SDK documentation](https://github.com/limitless-labs-group/limitless-exchange-ts-sdk/blob/main/docs/orders/README.md#collateral-fee-venues)

## Check a FOK BUY before signing

With the same authenticated account and selected wallet, read
`GET /trade/limitless/clob/quote?slug=...&tokenId=...&side=BUY&amountUsd=2&checkCollateral=true`.
The original depth quote is unchanged. The optional `collateralBuy` object
checks the wallet's Base USDC and subtracts Hunch-known open BUY locks. It is
`null` on legacy venues. All amounts ending in `Raw` are integer micro-USDC
strings or null when the value could not be verified.

- `ready`: the observed available balance covers the documented standard
  reserve for a new trade. This isn't a guarantee of matching or settlement.
- `insufficient_principal`: even the on-chain balance cannot cover the order
  amount. Review the amount or add funds; this is not an allowance issue.
- `standard_reserve_shortfall`: compare `availableRaw` with
  `standardRequiredRaw` and show `standardShortfallRaw` if useful.
- `unavailable`: refresh the check instead of assuming a zero fee or a
  missing approval.

The published standard reserve is 500 bps on fee-enabled COLLATERAL markets,
zero on fee-disabled markets. For a 2 USDC order, the standard requirement
is 2.10 USDC, not the amount of the actual fee. A per-profile cap can lower
the reserve; the Hunch partner lookup does not expose that cap. On the
standard path, pass `requireStandardFeeReserve: true` to both embedded
signature endpoints and to `POST /trade/limitless/order` to require the
standard reserve instead of displaying it as advisory. This flag does not
change the order, allowance or its signed `feeRateBps`. Without it, a known
principal shortfall still blocks, while a standard-reserve warning does not
block accounts that might have a lower rate. An already-submitted order
keeps its existing recovery path regardless of live balance.
`standardMaxBuyRaw` is the maximum principal under the same standard
reserve and observed balance, before depth and size checks. Round down to the
client's amount step. The server's smaller-Buy suggestion also leaves this
reserve in the funding budget.

See [Limitless balance and approval checks](https://docs.limitless.exchange/developers/migrate-to-new-trading-venues#balance-and-approval-checks).

### Prepare the fee approval with the trading wallet

For a COLLATERAL FOK BUY, pass the exact order principal in micro-USDC as
`limitlessMarketBuyRaw` to both `POST /funding/preparation/inspect` and
`POST /funding/preparation/prepare`. Use the same owned binding on both calls
and send `admissionProtocolVersion: 1` when preparing. Inspect even if the
unscoped destination says it is ready. The server verifies the market and fee
spender, and requests a bounded approval only when the observed allowance is
zero. The embedded executor must forward the admitted action's
`limitlessFeeMarketSlug` unchanged. Continue an existing run through its
status and admission endpoints instead of recreating an uncertain action.
This opt-in does not replace the balance/fee-reserve check before signing.

## Checking an existing Copy

For a client-signed collateral FOK Copy, generate and persist a UUID locally
as `copyIdempotencyKey` before the first POST; keep it if the entire HTTP
response is lost. A `409 limitless_submit_reconciling` can include the retained
`copyIdempotencyKey`, including a server-generated key for older callers.
Treat the returned key as an opaque string. Check
`GET /social/copies/{url-encoded-key}` with the original Hunch account.
Use the original `copyIdempotencyKey` from the request if it was supplied and
the response didn't return one. Do not retry `POST /trade/limitless/order` to
obtain status. This route reads the original Copy and never sends an order.

- `pending`: keep the existing attempt; do not make a replacement Buy.
- `confirmed`: the purchase was verified. Use `purchaseRef` when present; a
  worker-verified Copy can be confirmed without a local order or execution ID.
- `failed` with `purchaseRef: null`: close this attempt without treating it
  as a purchase. Any new order requires a fresh user confirmation.
- `revoked`: the attribution was revoked; this is not proof of no purchase.
  A 404 or a failed status request also isn't proof of no purchase.

The same status route works for an existing Copy if the client kept its key.
Non-Copy direct order recovery still uses `GET /trade/limitless/orders/:orderId`.

## Finance-worker

The `fees_reconcile` job uses the same Limitless fee-share program and
cashback tiers as before. For COLLATERAL FOK, a provider status only supplies
a candidate transaction. The worker creates a verified accrual after matching
the frozen exchange and signed order hash, the fee module's charge, and the
exact Base USDC debit in a canonical finalized receipt. The exchange's
`OrderFilled.fee` can be zero. The Base transaction and charge log index
identify the debit across order aliases. The settlement block time selects
the fee-share policy and cashback snapshot; the treasury guard still applies.

Unknown evidence is retried in bounded batches without dispatching the order.
An exact history transaction takes precedence over a contradictory
`not_found` or no-fill response as a reason to keep checking, not as evidence
that money moved. The worker can adopt that order when the receipt proves the
exact frozen fill. The separate debit check still controls cashback.
Direct COLLATERAL FOK stores unsigned identity before dispatch; sending the
same signed fields again checks that record and does not send a second order.
An unresolved attempt is also checked across funding, direct, Mini App and
Copy before a new FOK to the same wallet, token and side can leave Hunch.
An explicit venue rejection with a transaction hash is still ambiguous until
a finalized receipt resolves the conflict.
Unknown fee receipts stay eligible on the backoff schedule; a newly recorded
receipt locator wakes the check without resetting a proven terminal skip.
The web remembers only the recovery ID across reload and checks the existing
`GET /trade/limitless/orders/:orderId` with that ID and the selected wallet.
COLLATERAL GTC execution is unchanged, but cashback for its multi-settlement
orders is not supported until the worker has a complete fill journal.
Known LEGACY GTC evidence keeps its existing path. Historical imports that
cannot establish a fee regime do not get a status-only cashback payout.

[Observed Base BUY](https://basescan.org/tx/0x6dc5d11186a012965f75caa54b19442b06993e1ad88f44e59ac9502f48548016) ·
[Observed Base SELL](https://basescan.org/tx/0xf3c4ef69e4954e4f957c1cb30a857e5de6d76bc18e6f92ba541a634556b98aa8)
