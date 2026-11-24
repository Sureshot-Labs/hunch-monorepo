# House Trader pilot

The pilot is an internal, segregated Polymarket account for Hunch capital, with
no user login, no third-party deposits, and no dependency on Telegram or Mini App.
Use a fresh controller key. Do not copy a treasury, rewards, operator,
or employee key. The balance of this wallet, not the software cap, is the
maximum exposure if its raw key is compromised.

## Local checks

- `node --import tsx apps/api/src/house-trader-tests.ts` and the same script
  under Bun verify policy, signatures and receipt parsing without network.
- `HOUSE_FIXTURE_URL=postgresql://…@127.0.0.1:PORT/house_fixture node --import tsx apps/api/src/house-trader-pg-fixture.ts`
  uses a fresh schema in an explicitly named disposable PostgreSQL 16 database.
- Review the deployment and funding steps separately before starting any live
  process. Local tests do not attest provider allowlists, EIP-1271 verification
  on the live deployed wallet, live relayer credentials, or execution quality.

## Pilot configuration (not automatic rollout)

- Normal production Compose does **not** start the `house-trader` profile.
  Start/Pause for trading is controlled in the admin panel.
  The application API uses the existing common service modules; their
  bootstrap imports API config, but the trader does not sign with Privy.
- Create `/hunch/prod/house-trader` in the same AWS region as the deployment.
  Store a JSON object with **only** `HUNCH_HOUSE_TRADER_PRIVATE_KEY`. Keep it
  out of the repo, common secret bundles, and all `.env` files.
- The worker reads this bundle directly from Secrets Manager at startup with
  the same client and EC2 instance role as the other production workers.
  No wallet key file, staging script, or new AWS credentials are needed.
  The worker keeps the key in memory and checks that it matches the expected
  public controller. A separate bundle keeps it out of other workers' startup
  config, but is not an IAM boundary: workloads with the same role can read it.
- The only House Trader setting in `/opt/hunch/.env` is
  `HUNCH_HOUSE_TRADER_EXPECTED_CONTROLLER` (the public address derived
  offline).

The worker has no automatic restart policy. Never switch keys for an
existing funded controller or to recover an in-flight operation. Compose
supports standalone 1.29 and v2; its launcher uses the immutable image ID
of the healthy running API.
The optional worker is not in the normal deployment service list. Pause and
stop it before subsequent backend releases with `bash ops/house-trader-worker.sh stop`.
Starting it again automatically selects the new healthy API image; no image
tag or environment variable needs editing.

From the deployed backend directory, run the config check. It calls AWS to
verify the dedicated key, prints only its public controller and status, and
exits before opening the database or contacting Polymarket. Neither it nor
the worker-start command downloads or builds images.

```bash
bash ops/house-trader-worker.sh check
```

Before any real run, confirm venue eligibility from the actual deployment
environment; do not use routing to bypass access restrictions. Only then
start just the worker explicitly:

```bash
bash ops/house-trader-worker.sh start
```

- Finance → Trading Bot (interactive superadmin) creates the account paused.
  Setup deploys the canonical Deposit Wallet if needed and verifies its
  controller and approvals at a finalized Polygon block, plus CLOB
  credentials, before showing the deposit address. Order approvals cover
  pUSD and Conditional Tokens for standard and negative-risk CTF markets
  (including both for the distinct Neg Risk Adapter), and pUSD and
  PositionManager for the shared V2 ExchangeV3. After repeated proven
  setup failures, check the venue/relayer and use **Retry wallet setup**.
  Fund a small amount of Polygon pUSD only after setup is complete. Native
  Polygon gas for cash-out is sent separately to the controller.
- The trader follows native Hunch holder-research signals accepted for
  publication, with the recorded contract, side and price; no chat receipts
  are consulted. Optional AI uses context already stored for the instrument.
  Strategy, limits, and optional AI instructions are edited in the admin panel.
  Start/Resume starts with signals published after that click, not the existing
  backlog. There is no cron: the worker waits one minute **after each cycle**
  and does not overlap cycles. Each cycle reads up to 32 signal candidates and
  picks up to six queued actions, prioritizing exits and operator actions.
- BUY checks the live catalog before quoting and again immediately before
  submitting: published signal, matching side and token, signal age, category,
  active market, and time to close. Entry is a FOK order within the saved
  price/slippage and capital limits. While an order or position is open for
  that market, another BUY on either side cannot send; the same signal cannot
  send again after a restart. A new qualifying signal may enter after a
  verified close. An uncertain submission is reconciled by its original hash,
  not replaced. Finalized receipts can still be found from locally retained
  transaction references when the provider order is unavailable. A missing order
  or transaction without trustworthy evidence leaves the reserve pending and
  needs investigation; it is not proof of no execution. Automatic exits do not enqueue alongside another exit for the
  position, and failed automatic exits wait five minutes before another try.
- Defaults are 100 pUSD capital cap, 10/day UTC, 5/event, 2/order including
  fees; entry filters are signal age up to 30 minutes and 5 minutes to seven
  days to market close. AI entry/exit, take-profit and stop-loss default off.
  Save deliberately small limits for the first funded pilot; the defaults are
  not a one-order mode. The **Activity** section shows recent decisions and
  outstanding actions, including rejection, missing evidence, transaction
  finality, and the worker's last completed cycle.
- The panel lists open positions by market and side, confirmed shares,
  average entry and remaining cost basis. A delayed or unavailable balance
  check is not reported as a closed position. Realized P&L is separate from
  estimated unrealized P&L (value minus remaining filled cost). Open-market
  estimates use the freshest indexed bid for the exact held token, and settled
  markets use the listed payout. Missing or expired marks are not treated as
  zero; a portfolio subtotal identifies its coverage. Estimates exclude exit
  fees and order book depth and never drive order execution.
- For a withdrawal, enter an amount and recipient address in the admin panel,
  then confirm the exact Polygon pUSD preview. Once confirmed, subsequent
  execution and recovery remain bound to that address and amount. A confirmed
  manual sell/withdrawal must reach its first send boundary within three
  minutes. If it does not, request a fresh preview; already submitted work
  still reconciles.
- Pause blocks new automatic BUY/SELL authorizations. It does not recall a
  submission whose send boundary was already crossed, disable settled
  redemption, or disable confirmed manual actions. Unknown outcomes remain
  reserved. Never clear a pending row merely because an API returned not found.
  For batch recovery, an expired deadline plus an unchanged nonce on finalized
  Polygon proves that the old signed batch did not execute.
- If the batch acknowledgment is lost, the worker can recover withdrawal and
  redemption from bounded, exact finalized transfer/nonce evidence. If it
  cannot establish that proof, leave the batch pending. A restart can replay
  the exact same encrypted and hash-bound treasury transaction, never replace
  it with a new nonce while its outcome is unknown. A consumed nonce without
  exact evidence still requires operator investigation.

First live acceptance, separately authorized: exact preview and known pilot
funding → one minimal entry → reconcile the order and finalize fills → exact
exit or redemption → withdraw pUSD to the confirmed destination. Inspect both wallet
balances and actual transaction receipts. Do not scale up based on gross
historical signal results.
