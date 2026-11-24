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
- The normal EC2 instance profile, API, and other workloads must be denied
  `secretsmanager:GetSecretValue` and `secretsmanager:BatchGetSecretValue`
  on this secret (including the actual ARN suffix). Verify the effective IAM
  permissions without retrieving its value. Do not give the instance role
  access merely to make startup pass. Stage the key using an **operator AWS
  session** that can read this dedicated secret. Docker/host root can still
  read process memory and files; this is isolation from other ordinary
  containers on that host, not from host or Docker administrators.
- The only House Trader setting in `/opt/hunch/.env` is
  `HUNCH_HOUSE_TRADER_EXPECTED_CONTROLLER` (the public address derived
  offline). Compose passes the existing AWS region. The worker launcher
  uses the immutable image ID of the healthy running API.

After both repos have been released, the authorized operator can stage the key
from their workstation without printing it. The host needs `jq`. A host
administrator first installs the reviewed version of
`ops/stage-house-trader-key.sh` as `/usr/local/sbin/hunch-stage-house-trader-key`,
owned by root and not editable by the SSH user. Use noninteractive sudo only
for that installed entrypoint; do not grant sudo to a mutable source checkout.
Do not use AWS CLI debugging/response history or session stdin recording for
this stream. This replaces only
the dedicated staged file, so stage while the worker is stopped. Replace the
deployment host/IP or app directory below only if they differ from the actual
release.

```bash
set -o pipefail
aws secretsmanager get-secret-value --secret-id /hunch/prod/house-trader \
  --query SecretString --output text --no-cli-pager |
  ssh -T ubuntu@13.51.155.185 'sudo -n /usr/local/sbin/hunch-stage-house-trader-key'
```

The staging file is `/run/hunch-house-trader/key.json` (owner UID 10001,
mode `0400`, parent root-only). It is bind-mounted read-only only into
`house-trader-worker`. It disappears after a host reboot and must be staged
again. The worker has no automatic restart policy. Never switch to the new
key for an existing funded controller or to recover an in-flight operation.
The Compose file supports standalone Compose 1.29 as well as Compose v2.
The launcher's strict Docker bind check rejects a missing key file before
Compose can create a directory at that path.
The optional worker is not in the normal deployment service list. Pause and
stop it before subsequent backend releases with `bash ops/house-trader-worker.sh stop`.
Starting it again automatically selects the new healthy API image; no image
tag or environment variable needs editing.

From the deployed backend directory, run the **offline** config check against
the authorized worker image after staging. It loads no application secrets,
contacts no providers, and prints only the public controller and check status.
Neither it nor the worker-start command downloads or builds images.

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
  credentials, before showing the deposit address. After repeated proven
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
