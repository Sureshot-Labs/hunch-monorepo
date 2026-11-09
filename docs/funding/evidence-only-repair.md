# Evidence-only funding repair

The reconciliation worker can observe stopped funding operations without reviving
their old authorizations or Buy consumers. This is an internal operational lane;
public funding responses and financial status rules are unchanged.

## Routine observation

Private `support_metadata.evidenceRepairV1` records the evaluator revision,
requested/processed generation, semantic input digest, retry window, and sanitized
source matching diagnostics. Housekeeping timestamps are not evidence changes.

- An unchanged, intrinsically mismatching transaction/action pair is not fetched
  and reduced again. Its matching mask is diagnostic, not an immutable receipt
  correction or proof of a wrapper transaction.
- Pending receipts and applicable provider, destination, and postcondition
  sources remain observable at the existing effective recovery cadence.
- Unchanged acquisition updates the job schedule, not full-repair attempts or the
  operation version. `funding_reconciliation_jobs.due_at` controls the next probe;
  an idle operation with no dynamic source can wait at `infinity`.
- New evidence, a compatible evaluator revision, or explicit repair wakes the
  evidence-only lane. Technical retry accounting belongs to the current
  generation, not thousands of historical attempts.
- An addressed wake of a stopped legacy manual-review operation can establish
  the repair envelope immediately; it does not wait for old housekeeping ages.
  Still-live consent and untouched, unscheduled legacy rows are not detached.
- Lease, expiry, and generation checks fence stale completions. A concurrent wake
  survives an old worker's completion, including dead-letter completion.
- Acquisition runs outside database locks. Its short receipt/provider/destination
  apply transactions recheck the same authority before any evidence or financial
  projection writes; the production clock advances across slow RPC calls.
- Ordinary receipt/reorg watches also capture the repair generation, including
  its absence. A repair arriving during their RPC fences the old observation.
  If the initial dispatch read fails, only the owned job is retried at the
  existing technical cadence; lifecycle/support facts are not changed.
- Unsupported repair metadata is preserved, not overwritten by an older runtime.
  Inspect the deployed runtime/state compatibility before managed recovery.

The sticky evidence-only marker blocks old execution/consumer continuation. No
transfer, approval, deposit, or Buy is submitted by this lane.

## Addressed inspection and wake

From the API package (using the normal runtime secrets wrapper in production):

```sh
pnpm funding:evidence:repair -- --operation-id <uuid> --idempotency-key <key>
```

The default is a read-only inspection. Both arguments are required. Inspect the
target's status and compatibility before considering a wake. With separate
operational authorization, the same exact command plus `--execute` requests
observation only; it does not execute financial actions. Reusing an idempotency
key replays its recorded request rather than creating another generation.

The CLI uses a DB-only import graph and bounded SQL timeouts. It rejects live
non-stopped operations and incompatible repair state. Output contains only a
short hashed operation key, scheduling state, counts/generation, and boolean
matching diagnostics; it omits references, addresses, keys, and raw errors.

No production repair request is part of implementing or testing this command.

## BUY observations

Limitless AMM observations share the same pure address-alias reader as execution.
Polymarket keeps known transaction/fill locators through provider outages. A
locator (including `MINED`) is not purchase proof: only a newly read canonical,
finalized receipt with exact owner, contract, token, side, and purchase identity
can establish economics. Known unresolved additional fills remain pending;
hypothetical fills and aggregate `filled_size` are not new equality gates.
The exact order's fill source is acquired once, using its existing index, without
repeated full-source pagination or a raw-row truncation limit. Memory remains
linear in that order's known fills; unique-transaction and RPC budgets still apply.

Explicit eligibility refresh and meaningful fill evidence wake the observer and
fence its old lease. Canonical outcome rechecks and existing request budgets
remain in force. No legacy BUY cohort is mass-enqueued by this change.

A concretely unresolved new fill can keep the overall purchase pending, but it
cannot keep a disproven old proof public: exact prior evidence freshly rejected
by a canonical failed receipt invalidates overlapping thesis/copy snapshots under
the observer's lease. Mere provider absence is not such negative evidence.
