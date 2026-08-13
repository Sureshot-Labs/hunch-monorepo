# Slice D Relay EVM activation runbook

This runbook activates `Base USDC -> Relay Depository V2 -> Polygon pUSD`
without per-wallet policies or wallet allowlists. It does not authorize a
production change by itself.

## Authority shape

Keep the existing shared EVM automation policy ID and signer/quorum. The policy
contains the existing exact BUY+SELL rules plus exactly two Relay rules:

1. Base USDC `approve(RelayDepositoryV2, amount)` with a configured upper cap.
2. Relay Depository V2
   `depositErc20(address(0), BaseUSDC, amount, orderId)` with the same cap.

The application first validates the provider quote with the managed wallet as
the quoted depositor. Before durable commit it rewrites only the depositor
argument to `address(0)`, preserves token, amount, and order ID, and stores a
new action fingerprint. Relay Depository V2 then attributes the deposit to
`msg.sender`. A non-zero committed depositor is rejected.

There is no `HUNCH_FUNDING_RELAY_EVM_ALLOWED_DEPOSITORS` configuration and no
policy update when a new managed wallet is created.

## Exact Relay policy rules

Both rules use:

- action: `ALLOW`;
- method: `eth_sendTransaction`;
- transaction `chain_id eq 8453`;
- transaction `value eq 0x0`.

Approval rule:

- transaction `to eq Base USDC`
  (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`);
- calldata function `approve(address spender,uint256 amount)`;
- `approve.spender eq 0x4cD00E387622C35bDDB9b4c962C136462338BC31`;
- `approve.amount lte HUNCH_FUNDING_RELAY_EVM_MAX_SOURCE_RAW`.

Deposit rule:

- transaction `to eq 0x4cD00E387622C35bDDB9b4c962C136462338BC31`;
- calldata function
  `depositErc20(address depositor,address token,uint256 amount,bytes32 id)`;
- `depositErc20.depositor eq 0x0000000000000000000000000000000000000000`;
- `depositErc20.token eq Base USDC`;
- `depositErc20.amount lte HUNCH_FUNDING_RELAY_EVM_MAX_SOURCE_RAW`.

Do not add a wildcard, a second deposit rule, a user address, another token, an
unbounded amount, or another Depository address. The local combined-policy
validator rejects all of those shapes.

## Pre-activation checks

1. Keep `HUNCH_FUNDING_RELAY_EVM_EXECUTE=false` in API and finance-worker.
2. Verify migration `0208` on the production-compatible PostgreSQL major and
   run the funding migration preflight.
3. Run typecheck, the Relay delegated unit suite, trading policy regression,
   Relay rehearsal/fixture suites, and the delegated execution integration
   suite.
4. Confirm the current Depository bytecode fingerprint and the exact Base USDC
   and Depository addresses used by the rehearsal.
5. Confirm no active Slice D attempt exists. Slice C operations may remain
   active, but schedule a short fail-closed policy maintenance window because
   the shared policy fingerprint changes.

## Privy update

1. Read and export the current shared BUY+SELL policy and its attached policy
   ID. Do not create a wallet-specific policy.
2. Update that same policy ID in place by adding the two exact Relay rules
   above. This preserves existing wallet attachments; no wallet inventory is
   converted into policy rules.
3. Read the policy back from Privy. Verify the full serialized policy with the
   application combined-policy validator, including exact rule count, ABIs,
   Base chain, targets, zero depositor, and equal caps.
4. Compute the fingerprint from the read-back representation, not from the
   request payload. Set the same policy ID and new fingerprint in API and
   finance-worker:
   `PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID` and
   `PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_FINGERPRINT`.
5. Set the same positive raw cap in both processes with
   `HUNCH_FUNDING_RELAY_EVM_MAX_SOURCE_RAW`. Keep the Relay execution flag off.
6. Restart/recreate API and finance-worker so both use the same read-back
   fingerprint and cap. A mixed revision must fail closed.

Updating the Privy policy and updating the configured fingerprint are not one
atomic operation. Treat the interval as a planned fail-closed maintenance
window: trading/funding may be unavailable, but the old authority is never
accepted as the new authority.

## Smoke and rollout

1. With Relay execution still off, verify API and finance-worker health and
   confirm normal Slice C BUY, SELL, and USDC.e funding readiness against the
   revised combined policy.
2. Run one explicitly authorized tiny burner-wallet rehearsal that obtains a
   normal Relay quote, commits the zero-depositor action, and verifies:
   - Base transaction calldata contains the zero depositor;
   - Base USDC leaves the same managed wallet;
   - `RelayErc20Deposit` attributes the same managed wallet and order ID;
   - Relay status reaches success;
   - exact Polygon pUSD becomes ready;
   - no residual allowance, duplicate attempt, or unresolved recovery remains.

   The EVM rehearsal now canonicalizes this scenario to the production
   zero-depositor envelope. Run preflight first and copy its exact confirmation
   string into the separately authorized live invocation:

   ```bash
   pnpm -F api run relay:rehearsal -- \
     --scenario base-usdc-to-polygon-pusd \
     --amount-raw <tiny_raw_amount> \
     --minimum-output-raw <reviewed_floor> \
     --max-gas-raw <reviewed_gas_cap>

   pnpm -F api run relay:rehearsal -- \
     --scenario base-usdc-to-polygon-pusd \
     --amount-raw <same_tiny_raw_amount> \
     --minimum-output-raw <same_reviewed_floor> \
     --max-gas-raw <same_reviewed_gas_cap> \
     --live --confirm '<exact_preflight_confirmation>'
   ```
3. Enable `HUNCH_FUNDING_RELAY_EVM_EXECUTE=true` in finance-worker and API only
   after the rehearsal is terminal and evidence is canonical. Keep
   `HUNCH_FINANCE_EXECUTE=true` as the independent global gate.
4. Start with a conservative global per-authorization and rolling cap. This is
   an amount limit, not a wallet pilot or wallet allowlist.
5. Observe operations, attempts, provider references, receipt canonicality,
   allowance cleanup, refunds, outbox delivery, and reconciliation until the
   first real operation is terminal.
6. On any authority mismatch, ambiguous reference without recovery, receipt
   reorg incident, foreign allowance mutation, or cleanup failure, turn only
   `HUNCH_FUNDING_RELAY_EVM_EXECUTE` off. Observation and reconciliation remain
   on; never resubmit an ambiguous attempt manually.

## Rollback

1. Set `HUNCH_FUNDING_RELAY_EVM_EXECUTE=false` in API and finance-worker.
2. Leave reconciliation running until already-broadcast operations are terminal
   or durably handed to recovery.
3. Remove the two Relay rules from the shared policy only after no unresolved
   Relay attempt or owned allowance cleanup remains.
4. Read back the restored policy, update the configured fingerprint in both
   processes, recreate them together, and repeat the Slice C readiness smoke.
