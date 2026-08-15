# Polymarket Deposit Wallet Puller activation runbook

This runbook activates the optional reverse route
`Polymarket Deposit Wallet pUSD -> controller -> Relay -> destination`. It does
not replace `PolymarketFundingRouter` and does not use the Polymarket Relayer.

## Authority boundaries

`PolymarketDepositWalletPuller` is immutable. It fixes Polygon pUSD and the
canonical Polymarket Deposit Wallet derivation. `pullPusd(expectedNonce,
amount)` always derives the source wallet from `msg.sender` and always sends
the exact amount back to `msg.sender`. It has no admin, proxy, arbitrary token,
recipient, or calldata.

There are two separate authorities:

1. User setup: the embedded controller signs the Deposit Wallet EIP-712 Batch.
   The sponsored outer transaction calls the canonical Deposit Wallet's
   `execute`. The Batch contains exactly one zero-value call:
   `pUSD.approve(Puller, MaxUint256)` (or an exact revoke to zero). This action
   is not added to the background automation policy.
2. Background route: the existing automation signer may call only the exact
   Puller function below, followed by the already constrained Relay approval
   and deposit rules.

## Deploy and verify the Puller

Preflight the configured Polygon RPC, deployer, factory beacon, legacy
implementation, and golden Deposit Wallet vector. Then deploy with:

```bash
pnpm -F @hunch/contracts deploy:deposit-wallet-puller
```

The deploy script refuses to overwrite an existing manifest and records the
creation transaction, runtime bytecode hash, dependency bytecode hashes,
factory beacon, and constructor-independent constants. Verify the source and
runtime bytecode before using the address.

## Capability probe

Before granting background authority, open Hunch with a test controller and
run managed setup using `approve(Puller, 0)`. Verify all of the following:

- the outer transaction is sponsored on chain 137;
- its target is the controller's canonical Deposit Wallet;
- calldata is exactly `DepositWallet.execute(Batch, signature)`;
- the signed Batch has the current Deposit Wallet nonce, a deadline no more
  than ten minutes away, one zero-value call, and only the exact pUSD revoke;
- the receipt succeeds and the Deposit Wallet nonce increases by one.

Do not continue if the direct sponsored call is rejected or the nonce does not
advance.

## Shared Privy policy update

Keep the existing shared BUY+SELL policy ID and existing Relay rules. Add
exactly one rule:

- action `ALLOW`;
- method `eth_sendTransaction`;
- transaction `chain_id eq 137`;
- transaction `value eq 0x0`;
- transaction `to eq <POLYMARKET_DEPOSIT_WALLET_PULLER_ADDRESS>`;
- calldata function
  `pullPusd(uint256 expectedNonce,uint256 amount)`;
- `pullPusd.amount lte HUNCH_FUNDING_RELAY_EVM_MAX_SOURCE_RAW`.

Do not add `DepositWallet.execute` to this policy. Do not add a second Puller
rule, a different target, another function, an arbitrary token/recipient, or
an unbounded amount. The combined validator permits the old policy while the
feature is unconfigured, but marks reverse routing ready only when the one
exact Puller rule exists and its cap equals the Relay cap.

Read the policy back from Privy after the update. Compute
`PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT` from that read-back
representation, not from the update request.

The reverse route also requires the already-reviewed exact Polygon pUSD Relay
pair (`pUSD.approve(RelayDepositoryV2, amount)` and the matching
`depositErc20(address(0), pUSD, amount, orderId)`) at the same raw cap. The
Puller rule does not replace or broaden that pair.

## Staged application rollout

1. Deploy backend and frontend with
   `POLYMARKET_DEPOSIT_WALLET_PULLER_ADDRESS` absent. Existing funding and
   trading remain unchanged; the reverse route is unavailable.
2. Set the verified Puller address in API and finance-worker. The frontend
   learns the canonical address from the authenticated account snapshot; it
   has no separate Puller env. Keep the reverse route out of user traffic until
   policy read-back and fingerprint validation pass.
3. Update the existing shared Privy policy in place, read it back, install the
   new fingerprint in API and finance-worker, and recreate both from the same
   image/config revision.
4. Increment the managed policy revision. On the next Hunch open, an enabled
   user with missing allowance returns to pending setup and performs the one
   exact MaxUint approval. Existing exact allowance skips the transaction.
5. Run one small reverse-route smoke and verify:
   - one setup transaction (or a confirmed existing allowance);
   - one `source_pull` attempt and one exact
     `DepositWallet -> controller` pUSD Transfer;
   - one Relay approval and one Relay deposit;
   - one exact destination receipt and continuation;
   - no duplicate sends, unresolved provider references, retained Puller
     balance delta, stuck reservation, or residual owned Relay allowance.

If Puller config is removed, only new reverse-route planning is disabled.
Already-broadcast operations remain under ordinary receipt/recovery handling.
Do not remove the policy rule while a `source_pull` or downstream Relay attempt
is unresolved.
