# Solana Prefund Sponsorship Plan

## Summary

Replace broad Solana transaction sponsorship with a shared Solana readiness and wallet-prefund flow.

The current DFlow sponsorship work proved the core risk: when Hunch pays rent for a user-owned Solana token/outcome account, the rent is not recoverable by Hunch. A user can eventually close that account and receive the rent lamports. Repeating that across markets/outcomes turns sponsorship into a rent faucet.

The safer model is one reusable preflight gate for every Solana operation:

1. Preflight the selected Solana wallet.
2. Determine the required SOL floor for the requested operation.
3. If the wallet already has enough SOL for that operation, continue normally with user-paid SOL.
4. If the wallet lacks SOL but has usable funds, show a UI action such as `Add SOL for Solana operations`, with supporting text that explains the exact USDC -> SOL top-up quote.
5. That action runs one constrained sponsored prefund transaction that converts the user's funds into SOL for the same selected wallet.
6. Run the original operation normally after the wallet has enough SOL.

This makes sponsorship a small Privy-backed bootstrap tool, not a standing subsidy for user-owned account rent.

Develop branch scope:

- Start from `develop`; the current Solana sponsorship branch is reference-only.
- Do not introduce `HUNCH_SOLANA_SPONSOR_SECRET_KEY` or any local Hunch sponsor-wallet signing path.
- Do not implement broad Solana sponsorship for user operations.
- Use Privy sponsorship only for the explicitly allowed prefund and admin/system market-init primitives.
- Use normal application logs/metrics for observability; do not create a new sponsorship ledger or rent-reclaim accounting system.

## Core Principle

Privy may sponsor a transaction fee for a tightly validated SOL top-up, but Hunch should not sponsor the actual DFlow, Across, deBridge, direct-transfer, or future Solana operation.

The actual operation must always require the user wallet to have enough SOL. If the user later recovers rent from a user-owned account, that rent came from the user's own SOL balance.

Allowed:

- Sponsor fee for a constrained top-up from user funds into SOL.
- Output SOL must land in the same selected Solana wallet.
- Any temporary accounts created by the top-up route must be closed in the same transaction.
- Top-up amount is capped to a small operational buffer.
- Use Privy sponsorship only for strict prefund and admin/system market-init transactions, not for trade/bridge payloads.

Not allowed:

- Generic Solana sponsorship for arbitrary DFlow, bridge, direct-transfer, or deBridge payloads.
- Sponsor-funded creation of user-owned outcome/token accounts.
- Treating requested `outputCloseAuthority=sponsor` as proof that final async DFlow accounts are sponsor-closeable.
- Reclaim-based accounting as the primary safety mechanism.
- Any new local Hunch sponsor-wallet signing or sponsor-wallet ledger branch.

Separate from prefund:

- DFlow market initialization can remain a dedicated admin/system operation.
- It must not be hidden inside user trade sponsorship.
- It must not require the user wallet to pay or sign.
- It should be run ahead of user trading when possible, or triggered by a narrow admin/internal endpoint.

## Proposed Flow

### 1. Shared Wallet Preflight

Before requesting or signing any Solana operation:

- Confirm the active wallet is a Solana wallet.
- Fetch wallet SOL balance.
- Classify the operation and load its configured SOL floor:
  - `dflow_buy`
  - `dflow_sell`
  - `dflow_redeem`
  - `across`
  - `debridge`
  - `direct_transfer`
  - future operation keys
- Estimate or select the required SOL buffer:
  - transaction fee,
  - priority fee,
  - expected account setup/rent for the requested operation,
  - small safety margin.
- If SOL balance is above the operation floor, skip prefund.
- If SOL balance is below the operation floor, calculate the top-up target, for example `targetSolBalance = operationFloor + safetyMargin`.

Use one shared preflight endpoint for all user-facing Solana flows:

```http
POST /wallets/solana/readiness
```

Request:

```json
{
  "walletAddress": "selected-solana-wallet",
  "operation": "dflow_buy",
  "marketId": "optional-market-id",
  "inputMint": "optional-input-mint",
  "outputMint": "optional-output-mint",
  "amountRaw": "optional-amount"
}
```

Response:

```json
{
  "ok": true,
  "walletAddress": "selected-solana-wallet",
  "operation": "dflow_buy",
  "solBalanceLamports": "1200000",
  "minSolLamports": "5000000",
  "targetSolLamports": "30000000",
  "needsPrefund": true,
  "marketInitialized": true,
  "blockingReason": null
}
```

This endpoint answers readiness only. It does not sponsor, sign, submit, or write sponsorship ledger rows.

Suggested floor model:

- DFlow BUY: highest floor, because it may require outcome account setup/rent.
- DFlow SELL/redeem: lower floor unless account closure or settlement requires extra setup.
- Across/deBridge: flow-specific floor based on provider route requirements; normally lower unless the route can create Solana accounts.
- Direct transfer: fee-only floor unless the transfer path has account setup.
- Unknown/future Solana flows: conservative floor or manual SOL funding only.

### 2. Prefund Quote

If prefund is needed:

- Use a single approved provider path for user funds to SOL.
- Prefer an in-wallet Solana USDC -> SOL swap when the user has Solana USDC.
- If using deBridge or another bridge provider, keep it as a dedicated prefund provider, not a generic sponsored bridge path.
- Quote must bind:
  - authenticated user,
  - selected Solana wallet,
  - requested operation key,
  - required SOL floor,
  - input asset,
  - output asset SOL/native SOL equivalent,
  - max input amount,
  - min SOL output,
  - expiry,
  - route/program allowlist,
  - transaction digest.

### 3. Sponsored Prefund Submit

The sponsored transaction may only submit the prepared prefund payload. Use Privy sponsorship for this transaction if it can be bound to the prepared prefund intent and validated fail-closed.

Validation must fail closed unless all are true:

- The selected wallet is the user wallet and is the SOL recipient.
- The transaction spends user-owned funds, not sponsor funds, except for transaction fees.
- The output is SOL to the same selected wallet.
- The transaction does not leave sponsor-funded user-owned rent accounts behind.
- Any WSOL or temporary token accounts are closed atomically.
- The transaction digest matches the prepared prefund intent.
- The top-up does not exceed configured per-wallet/per-user caps.
- The top-up amount is enough to reach the operation floor but not materially above the configured target.
- The transaction shape matches the dedicated prefund provider, not a generic provider route.

### 4. Normal Operation

After prefund confirmation:

- Refresh wallet balances.
- Continue with the original DFlow, Across, deBridge, direct-transfer, or future Solana flow.
- Do not mark the original operation as sponsored.
- If account creation rent happens during the original operation, it is paid from the user's SOL balance.
- If the user later closes that account, they recover their own rent, not Hunch sponsor rent.

### 5. DFlow Market Initialization

DFlow market initialization is a separate system concern from user wallet prefund.

Reference behavior to reimplement on `develop`:

- Endpoint shape: `POST /admin/prediction-market-init`.
- Request body: `{ "outcomeMint": "...", "maxRetries": 0 }`.
- Business behavior:
  - requires admin permissions `finance:write` and `sponsorship:write`;
  - rejects legacy admin fallback;
  - resolves the outcome mint to exactly one Hunch Kalshi market;
  - refuses already initialized markets;
  - asks DFlow for `/prediction-market-init` using a Privy-backed admin/system payer context if DFlow requires an explicit payer;
  - validates the returned transaction as prediction-market-init only;
  - submits through Privy sponsorship, not a local Hunch sponsor wallet;
  - marks `unified_markets.is_initialized = true` after confirmation.

Implementation details that should not be introduced on `develop`:

- local sponsor keypair resolution;
- local sponsor-wallet signing;
- Solana sponsorship ledger writes;
- rent status or reclaim accounting.

Keep the core, simplify the product model:

- Market init is an admin/system maintenance operation, not a user-sponsored trade.
- Market init is Privy-sponsored infrastructure setup, not a Hunch sponsor-wallet transaction.
- If a signer/payer identity is needed, use a Privy-managed admin/system Solana wallet or equivalent Privy server-side path; do not store a raw Solana sponsor key in Hunch.
- User preflight should treat `is_initialized = false` separately from low SOL.
- If a market is not initialized, show a "market is being prepared" state or trigger a controlled backend/admin init path.
- Once market init is complete, the user still needs normal SOL readiness for the trade.

Recommended endpoint shape from `develop`:

```http
POST /admin/prediction-market-init
```

```json
{
  "outcomeMint": "raw-or-sol-prefixed-outcome-mint",
  "maxRetries": 2
}
```

Response:

```json
{
  "ok": true,
  "signature": "solana-signature",
  "status": "fulfilled",
  "marketRowsUpdated": 1
}
```

Optional KISS improvement:

```http
POST /admin/kalshi/markets/:marketId/onchain-init
```

Use this only if market-id-based admin UX is materially cleaner. Internally it should resolve the market's outcome mint and call the same init service. Do not maintain two validation paths.

## Policy Changes

Sponsorship policy for the `develop` implementation:

- DFlow trade sponsorship: do not implement.
- Direct-transfer sponsorship: do not implement.
- Across/deBridge sponsorship: do not implement.
- Generic Solana transaction sponsorship: do not implement.
- Local Hunch sponsor-wallet flow: do not implement.
- Sponsorship ledger/reclaim flow: not part of the `develop` implementation.
- DFlow market init remains allowed only as a Privy-sponsored dedicated admin/system endpoint, not as user trade sponsorship.

Introduce one policy section for the shared readiness gate:

```json
{
  "solanaPrefund": {
    "enabled": true,
    "maxTopUpLamports": "30000000",
    "allowedInputMints": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    "allowedProviders": ["solana_swap"],
    "operationFloors": {
      "dflow_buy": {
        "minSolLamports": "5000000",
        "targetSolLamports": "30000000"
      },
      "dflow_sell": {
        "minSolLamports": "5000000",
        "targetSolLamports": "10000000"
      },
      "dflow_redeem": {
        "minSolLamports": "5000000",
        "targetSolLamports": "10000000"
      },
      "across": {
        "minSolLamports": "3000000",
        "targetSolLamports": "10000000"
      },
      "debridge": {
        "minSolLamports": "3000000",
        "targetSolLamports": "10000000"
      },
      "direct_transfer": {
        "minSolLamports": "1000000",
        "targetSolLamports": "5000000"
      }
    }
  }
}
```

The exact floor values should be tuned from observed transaction requirements. The important design point is that floors are operation-specific and the prefund primitive is shared.

Policy notes:

- `maxTopUpLamports` is a sanity cap. It can also be derived from the largest configured `targetSolLamports` if we want one fewer knob.
- Do not add daily wallet lamport caps in v1. The user spends their own USDC; the main abuse risk is sponsored fee spam.
- Handle fee-spam risk through normal authenticated API rate limits and provider-level controls.
- Log the SOL deficit, operation key, configured floor, quote, and whether prefund was used.

## Separate Bug To Carry Forward: Explicit Solana Wallet Public Key

There is a separate DFlow order bug that must be carried forward independently from this sponsorship redesign.

Observed behavior:

- UI can show the selected wallet as Solana.
- The DFlow order request can still fail with `DFlow order requires a Solana wallet address`.
- Switching away and back fixes it, which points to stale or mismatched selected-wallet plumbing.

Required fix:

- DFlow order requests must use the explicit selected Solana wallet public key.
- Do not rely on a generic/global wallet header that may still point to an EVM wallet.
- If `walletAddress` is missing but `userPublicKey` is present, use `userPublicKey` as the request wallet context.
- Query keys and request params must include the selected Solana wallet so wallet switches refetch cleanly.
- Backend should reject if the effective request wallet is absent or not Solana, but frontend should not send an EVM wallet context for DFlow.

This is not part of prefund sponsorship. Implement it first or carry it as a small independent patch when moving back to `develop`.

## Implementation Plan From Develop

1. Add prefund policy parsing.
2. Add one shared Solana preflight/readiness endpoint that maps each operation to a SOL floor.
3. Add backend prefund prepare endpoint.
4. Add backend prefund submit endpoint through Privy sponsorship only.
5. Add strict transaction-shape validation for prefund.
6. Add frontend preflight state shared by DFlow, Across, deBridge, and other Solana flows.
7. Add a reusable UI action: `Add SOL for Solana operations`, with exact top-up quote details.
8. Add prefund confirmation before requesting or submitting the original operation.
9. Implement the dedicated DFlow market-init business logic as admin/system-only.
10. Implement market init through Privy sponsorship, not local sponsor-wallet signing.
11. Make user preflight distinguish `market_not_initialized` from `low_sol`.
12. Leave broad Solana sponsorship paths unimplemented.
13. Do not implement sponsorship ledger, rent reclaim, or repair-token flows.
14. Carry forward the explicit Solana wallet public-key fix as a separate patch.

## Validator Requirements

The prefund validator should check:

- payer/signers as required by the Privy-sponsored prefund path,
- recipient wallet,
- operation key,
- operation SOL floor,
- user input asset,
- SOL output target,
- max spend,
- min receive,
- route/program allowlist,
- no unexpected account creations,
- no sponsor-funded persistent rent,
- digest binding to prepared intent,
- expiry and replay protection.

If the validator cannot prove the transaction is a bounded prefund, it must refuse sponsorship.

The implementation should not introduce a sponsorship ledger. Keep only short-lived prepare/intent state, preferably in Redis or an equivalent TTL cache, for digest binding, expiry, and replay protection.

## UX Requirements

The user-facing behavior should be simple:

- If SOL is sufficient: the requested operation proceeds normally.
- If SOL is low but prefund is possible: show `Add SOL for Solana operations`.
- Under the action, show the actual quote, for example: `We'll swap about 1.25 USDC into 0.03 SOL for Solana network fees and account setup.`
- If the quote has a fixed maximum spend and minimum receive, show both values, for example: `Spend up to 1.25 USDC. Receive at least 0.029 SOL.`
- Keep the copy clear that this funds the user's wallet, not the trade/bridge operation itself.
- After the button is clicked: show a short "Preparing wallet" step, then continue.
- If prefund is not possible: ask the user to add SOL manually.
- Do not describe the original operation as sponsored once prefund is complete.
- Do not show DFlow account-setup errors when the real problem is missing SOL.
- Use the same UI gate for DFlow, Across, deBridge, direct transfer, and future Solana flows.

## Tests

Backend:

- Prefund prepare rejects non-Solana wallets.
- Prefund prepare selects the correct per-operation SOL floor.
- Prefund prepare rejects unsupported input assets/providers.
- Prefund submit rejects digest mismatch.
- Prefund submit rejects output SOL to a different wallet.
- Prefund submit rejects route payloads that leave sponsor-funded rent accounts.
- Prefund submit respects the configured top-up cap.
- Prefund submit refuses payloads that do not match the prepared operation key and floor.
- Prefund requests are covered by normal authenticated API rate limits.
- Market init endpoint requires admin `finance:write` and `sponsorship:write`.
- Market init endpoint rejects already initialized, unknown, or ambiguous outcome mints.
- Market init validation requires Privy-sponsored admin/system payer semantics and prediction-market-init transaction shape.
- Market init updates `unified_markets.is_initialized` only after confirmation.
- No new sponsorship ledger/reclaim/repair tables or flows are created.

Frontend:

- DFlow order uses explicit selected Solana wallet public key.
- Wallet switch invalidates/refetches DFlow order state.
- Low-SOL wallet shows `Add SOL for Solana operations` plus the exact USDC spend and SOL receive quote.
- Sufficient-SOL wallet skips prefund.
- Uninitialized DFlow market shows a market-preparation state, not a SOL-prefund state.
- DFlow, Across, deBridge, and direct-transfer flows use the same preflight gate.
- Failed prefund blocks the original operation and shows manual SOL funding guidance.

Regression:

- User-owned DFlow outcome account rent is never treated as sponsor-recoverable in the new flow.
- Generic Solana sponsorship is not used for DFlow, Across, deBridge, or direct-transfer operations after prefund rollout.

## Rollout

1. Ship explicit Solana wallet public-key fix.
2. Implement dedicated DFlow market init as Privy-sponsored admin/system-only.
3. Ship shared Solana readiness/preflight gate.
4. Ship prefund quote/submit behind the normal feature flag.
5. Compare observed prefund need against current DFlow, Across, and deBridge failures.
6. Enable prefund for one small wallet/user cohort.
7. Keep broad DFlow/Across/deBridge/direct-transfer sponsorship out of scope.

## Non-Goals

- Do not attempt to recover user-owned position rent.
- Do not sponsor arbitrary DFlow transactions.
- Do not sponsor arbitrary Across, deBridge, or direct-transfer transactions.
- Do not combine DFlow market initialization with user trade sponsorship.
- Do not rely on rent reclaim to make sponsorship safe.
- Do not expand bridge/deBridge sponsorship beyond the prefund primitive.
