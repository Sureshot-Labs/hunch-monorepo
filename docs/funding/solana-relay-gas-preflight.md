# Solana Relay gas preflight

## Evidence, 2026-09-08

Read-only production PostgreSQL inspection found 20 distinct Solana signatures
in `funding_step_receipt_observations`, first observed between August 26 and
September 7. All 20 were read through the configured production RPC at
`finalized`; all had `meta.err = null` and called the Relay depository.

| Source     | Transactions | Network fee (lamports) | Other payer SOL debits           |
| ---------- | -----------: | ---------------------: | -------------------------------- |
| Native SOL |           14 |            5,000–5,136 | Exact native deposit amount only |
| USDC       |            6 |            5,000–5,254 | None                             |

For every sampled transaction, payer SOL debit minus the native deposit amount
(zero for USDC) equaled `meta.fee`. No additional rent/account creation debit
was observed. This is historical evidence, not a guarantee about future quotes.
Legacy `bridge_orders` has 88 Solana source references, but its providers are
Across and deBridge, not Relay; they were not used to justify this exception.

The reported internal wallet had 2,995,000 lamports and 4.7924 USDC. Both funding
discovery and embedded execution previously required the fixed 3,000,000
lamport floor. Fixing discovery alone would still fail before signing.

With the user's explicit permission, a fresh 2 USDC Relay quote to their
Polymarket Deposit Wallet was obtained and validated with the existing adapter
validator. An unsigned RPC simulation succeeded: before 2,995,000 lamports,
after 2,990,000, message fee 5,000, current payer rent reserve 810,624 and 23,574
compute units. The calculated requirement is **870,624 lamports**, below the
existing balance. Quoted destination minimum was 1.927242 pUSD. No transaction
was signed/broadcast and no funding operation was committed.

## Narrow change

Keep the existing global reserve, native SOL sizing and withdrawals unchanged.
A low-gas internally controlled Solana USDC source may proceed to quotation, but it cannot become an
executable quote until the exact validated Relay action passes a gas probe.
The same probe is used before preparing an embedded user's signature request
when the single transaction would otherwise fail the fixed floor.

The probe accepts one recognized Relay SPL deposit plus compute-budget
instructions, with the controlled fee payer/signature, USDC mint/source ATA and
token programs. Native deposits, extra transfers, unrelated programs, batches
and missing lookup tables do not receive the exception. It does not replace
the existing funding authorization/action validator or grant sponsorship.

Required user lamports are conservatively calculated as:

`observed simulation payer debit + getFeeForMessage + rent-exempt payer reserve + 50,000`

Simulation may already deduct the fee, so the formula deliberately counts it
again. The 50,000 lamports are additional headroom, not a fee estimate. With a
5,000-lamport simulation debit, 5,000 fee and 890,880 payer rent reserve, the
requirement is 950,880 lamports; these are illustrative RPC inputs, not a new
fixed floor. Both fee and rent are requested for the actual check. Compare
against the smaller of the observed payer balance and supplied available
balance. Unexpected payer credits, invalid/missing numeric evidence, failed
simulation and RPC errors cannot relax the old guard.

Each probe has a shared 2.5-second deadline, inherits the planner abort signal,
uses configured RPC with existing diagnostics, and does not retry rate limits.
There is no cross-request estimate cache. At embedded preparation, recheck the
actual serialized transaction (including its compute budget and lookup tables).
External wallets retain their existing gas eligibility, client signing and network preflight.

`executionGas` in account snapshots remains a conservative generic indicator;
the fresh route-specific check, not this flag, decides this exception.
No schema migration, production write, Privy dashboard policy edit or frontend change.

## Sponsorship assessment

Before this patch, backend policy permitted Solana sponsorship only for the
separately validated Kalshi loss-close flow. The new Relay capability is
independent: it does not reuse that switch or treat client `sponsor: true` as
authority.

The follow-up RPC investigation below proves fee-only execution is possible
for the current Relay USDC deposit. The user explicitly selected the trust
model: Relay supplies trusted route actions; users must not be able to modify
them or abuse sponsorship. Privy's existing managed execution remains a trusted
dependency. This is not a proof against a malicious Relay or Privy provider.

### Follow-up: transaction-level evidence

All six historical USDC receipts were inspected again, including **every inner
instruction and every account's pre/post lamports**. Each contains exactly one
SPL Token `transferChecked`, for the exact USDC deposit. There are no account
creation, account closure, SOL transfer or other CPI instructions. Only the fee
payer's lamports change, by `meta.fee` (five receipts: 5,000; one: 5,254).

Public transaction signatures for independent reproduction:

```text
3BfKKXwCBNdFq3uJiQoQiTTEbJsfsmj2wpjkZJKG4buZERiz1g7AA6JSky2x3MZf5rbtrFC9dYxaqewrpievKuMo
3w7XCARSW7WAPYZpCWCw2Y1GL94xG6wwVZu4Dqj4Y2Ft9R8yXGhDFy88SS16HJjuDM9fHVo6SJTbdtHVHp2WTBQk
5AtGZYufJcCmuPB9LQpGdtLHsUKJzfs8oSHehasumHoTKUF8tsXHfmFYXzbDArm7AEQvASqSCf4DEDLDGuBK8nHM
dho9FDhDrF8sdMSMz4s7CXwVxNRQWefDZPScXRQED5gttf5XddkxddXpqsZPmLZCRdMkTj7W8rpa45CZaN7jJZD
fE6HKYvYWxAVgcCurtbQVUXZd9KxAs6CsafhdfWiL4pbCdB7NCnb7KevuTFWEhMGEKq53MGFo4WnTS7S3Ci3jFt
jhG1MnLCFWn8A7eVcnGnvMjKkUgee7KLrGnNiWhqxR9ULDoeRvjcpNKR9ECHhBcFNstFo6BLJi8DHnmXgajuadW
```

One additional authorized 2 USDC quote was validated with the production
`validateRelaySolanaDirectQuote` and simulated twice, unsigned. Its quoted
minimum destination was 1.934396 pUSD; this is a different quote from the first
probe, not a promised exchange rate.

| Unsigned simulation | Required signatures | RPC message fee | User SOL debit | Inner calls              |
| ------------------- | ------------------: | --------------: | -------------: | ------------------------ |
| User as fee payer   |                   1 |  5,000 lamports | 5,000 lamports | One USDC transferChecked |
| Separate fee payer  |                   2 | 10,000 lamports |              0 | One USDC transferChecked |

Both succeeded, consuming 23,574 compute units. The separate fee payer was an
existing address used **only in unsigned simulation**, not a configured Hunch
sponsor. No keys were loaded for signing, no signatures created, no transaction
sent and no funding operation created. No Privy sponsorship request was sent.

At the inspected confirmed slot 445424759, the user's USDC ATA and Relay's
USDC vault ATA already existed, were initialized, held 2,039,280 lamports each,
and had no explicit close authority or delegate in the RPC parsed response.
The user's ATA belongs to the user; the vault ATA belongs to
`7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ`, not the user. Neither simulation
created or closed an ATA. Source and fee-payer SOL deltas matched the table.

Do not interpret deltas in unrelated, shared Relay vault state between the
pre-read and a later simulation bank as this transaction's transfers. Those
reads are not an atomic pre/post snapshot. Historical finalized receipts above
provide the atomic full-account comparison; simulation CPI shows only USDC.

The Relay program is upgradeable: ProgramData
`6y7C7Lfh1WRRbKohE2FQmFBD2asw3yMi17kStwEcAWWF`, last upgrade slot 386211280,
upgrade authority present. Historical success cannot be treated as a permanent
proof of program behavior.

### Implemented boundary

- Authenticated internal Privy wallet only. The request ID locates an owned,
  persisted Relay funding step with an unexpired action and a started attempt.
  Recompute its canonical fingerprint and re-project its current lifecycle
  before broadcast; cancellation, siblings and receipts remain authoritative.
- Recompile the **entire** stored action with the supplied blockhash and the
  stored lookup tables. Require exact message equality and empty signatures.
  Extra instructions/accounts, fee increases, another amount, another signer,
  another recipient or a client-generated Relay-shaped transaction do not pass.
- One USDC deposit only. Both canonical token accounts and the user's system
  account must already exist and be rent-exempt. Reject missing/frozen ATAs,
  insufficient tokens and unexpected destination delegate/close authority.
- Unsigned simulation uses a separate existing payer and must contain exactly
  one authorized USDC `transferChecked` CPI. No ATA creation/closure, native
  SOL, WSOL, swap or other inner instruction. Simulated message fee must be at
  most 15,000 lamports. This is an admission ceiling, not a promised final
  managed-service bill; Privy may optimize fees and charge its service fee.
- Redis retains the first accepted bytes for that canonical action. The Privy
  idempotency key and backend singleflight key derive from the user plus the
  committed action fingerprint, never the client's execution key. Repeating
  prepare or changing a client key cannot create another sponsored action.
- An atomic Redis reservation limits new sponsored actions to **20 per user
  and 1,000 app-wide per rolling 24-hour counter window**. Retries of the same
  canonical action reuse a reservation; failed/uncertain submissions do not
  refund the allowance. Redis absence/errors fail closed. These are request
  quotas, not a new financial ledger or a fiat-denominated provider spend cap.
- Preparation and execution both validate the action. Existing managed-wallet
  balance-based selection still decides whether Privy or the user pays; enough
  SOL does not force a sponsored send. Existing loss-close behavior is retained.

The current local validator itself was bundled in memory and exercised against
another authorized fresh 2 USDC quote using the secret-bootstrapped production
RPC: `proof: true`, minimum destination 1.932171 pUSD. This included the actual
ATA/rent, exact CPI and separate-payer fee checks, not only a mocked simulation.
No signing, broadcast, database write or server-file write was performed.

### Activation and limits of this patch

The narrow capability is enabled by default in the patch. Set
`FUNDING_RELAY_SOLANA_SPONSORSHIP_ENABLED=false` to disable it independently of
Kalshi; invalid values also disable it. No production configuration or Privy
dashboard policy was changed during this work. Activation occurs only when
the user deploys the code, subject to the existing Privy app's ability to sponsor.

Low-gas discovery still tries the measured user-paid preflight. If that fails,
only an eligible internal source with the enabled, verified fee-only capability
may bypass that gas floor. External wallets and native SOL sizing are unchanged.
The existing frontend contracts already carry payer/signing requirements.

**Zero-SOL authorities are supported**, including an absent system account.
The earlier authority rent-floor guard was conservative, not a demonstrated
Relay requirement, and has been removed. An existing authority must still be
a non-executable, empty system account. Both canonical USDC token accounts
must already exist, be initialized and rent-exempt; the sponsor never creates
them. Unknown RPC evidence, exhausted quotas, provider rejection and missing
token accounts are not silently treated as success.
No standing allowances, raw Hunch sponsor key, schema migration or historical
operation restart is introduced.

The installed Privy SDK exposes a sponsorship boolean, not a no-rent toggle or
transformed-message preview. Safety here rests on the accepted trusted-provider
boundary plus exact persisted actions, existing accounts, current simulation,
idempotency and quotas. A real sponsored end-to-end transaction has **not** been
sent as part of the audit; verify a small user-confirmed transaction after deploy.

References: [Privy sponsorship behavior](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview),
[rent-refund security](https://docs.privy.io/wallets/gas-and-asset-management/gas/security),
[Alchemy fee payer transformation](https://www.alchemy.com/docs/wallets/api-reference/gas-manager-admin-api/gas-abstraction-api-endpoints/alchemy-request-fee-payer),
[Solana fee estimation](https://solana.com/docs/rpc/http/getfeeformessage).

## Regression checks

- Single USDC transaction below the old floor, measured safe and unsafe costs.
- Extra rent/debits, missing fee/account data, simulation errors, wrong mint,
  native deposit, extra transfers and multiple deposits.
- User-paid gas preparation rechecks one transaction; unknown evidence/batches
  cannot receive that exception or implicitly enable sponsorship.
- Existing funding/native SOL/withdrawal/sponsorship tests remain unchanged in
  behavior, including client sponsorship requests not granting server consent.
- PostgreSQL 16 checks the exact candidate query and ownership/provider/attempt/
  expiry cases; real Redis checks concurrent quota admission and retry reuse.
- Sponsored message comparison rejects extra fee instructions, amount changes,
  supplied signatures and batches. Missing ATA, invalid authority, extra CPI, high
  fees, failed simulation and external-wallet capability are covered.

The authorized fresh quote and unsigned simulation were completed as recorded
above. No transaction was signed or broadcast as part of this verification.

Final local verification: 68/68 funding/Relay/embedded unit suites; 63/63 fast
plus targeted suites with sponsorship enabled; 2/2 PostgreSQL 16 integration
suites (existing funding action persistence and the new sponsorship/Redis
checks). TypeScript, ESLint, Prettier and `git diff --check` passed. These are
not a substitute for the first user-authorized sponsored transaction after
deployment. No commit or deployment was performed.

## Zero-SOL follow-up and critical review, 2026-09-08

At configured mainnet RPC slot **445438082**, an unsigned simulation executed
the fresh, validated Relay 2-USDC deposit with a separate simulation fee payer.
For this diagnostic only, a preceding system transfer moved all 2,995,000
authority lamports to that payer **inside the simulated bank**. Consequently
the unchanged Relay instruction ran with the authority at zero SOL. This is
not a real transfer, not a client-acceptable production transaction, and not
a test of Privy's actual transformed transaction.

Results:

- `err: null`; 23,721 compute units including the diagnostic prefix.
- Two signatures required; fee estimate 10,000 lamports.
- Authority after simulation: 0 lamports (no prefunding).
- Source USDC: 4,792,400 → 2,792,400 raw.
- Relay vault USDC: 421,790,055,184 → 421,792,055,184 raw.
- Relay's only inner instruction: exact USDC `transferChecked` for 2,000,000.
  No ATA creation, rent transfer, close-account or additional CPI.
- The current local production validator also passed the ordinary fresh quote;
  its minimum destination was 1,916,821 raw pUSD.

The zero-authority simulation is protocol evidence, not a live new-user
Privy smoke test. Unit tests separately cover absent and zero-lamport authority
RPC responses, the new user's zero-SOL source discovery, and generation of
`sponsor: true` only with server-granted capability. With the capability off,
the same client flag still fails the insufficient-SOL guard.

Critical review covered **all uncommitted files in this patch**, not just the
removed balance check:

1. Inventory retains observed zero SOL; it does not confuse zero with an RPC
   failure. Source discovery admits USDC only to exact quote/preflight checks.
2. Existing ATA checks and exact simulated CPI still forbid rent-funded setup.
   A missing authority is not a missing token account.
3. Client input is matched against the owned, committed Relay action and live
   funding attempt. Whole-message comparison includes amount, recipient,
   program, account privileges, provider reference bytes and compute budget.
4. Prepare and execute recheck eligibility. Canonical server-derived Privy
   idempotency, first-prepared bytes, lifecycle guards and atomic Redis limits
   remain in place. A client execution key cannot create a new sponsorship
   identity for the same action. Quota reservations are not refunded on errors.
5. External wallets, native SOL routing, EVM sponsorship and the separate
   Kalshi loss-close gate are unchanged. No migration or frontend patch.

Remaining operational boundaries: Relay and Privy are trusted providers, RPC
proof is rechecked but cannot guarantee future provider availability, and a
real sponsored user-confirmed transaction still needs a smoke check after
deployment. Changes to the prepared request (including expiry or fee-payer
choice after a balance change) may require fresh preparation; they must not
create a second independent broadcast under the same funding action.
