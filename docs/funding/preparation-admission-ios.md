# Standalone wallet preparation: admission protocol v1

This contract applies to standalone Trading Wallet preparation, not deposits,
bridge execution, order submission or historical Buy continuation. Implement it
in iOS before enabling automatic recovery of expired preparation. No old Buy is
revived by any endpoint below.

## Negotiate and prepare

`GET /funding/capabilities` advertises `preparationAdmissionVersion: 1`.
Send the existing exact binding, purpose, market, selected controller and fresh
inspection revision to `POST /funding/preparation/prepare`, adding:

```json
{ "admissionProtocolVersion": 1 }
```

For a versioned run, `admissionProtocolVersion` in the response is `1`.
`actions` is empty and `actionAttempts[].action` is null. Neither `prepare`, GET
nor reconciliation is permission to invoke a wallet. `replayed: false` is not
execution permission either. Do not fall back to old executable actions if
negotiation is unavailable or the response describes a legacy run.

The server uses a stable business scope across inspection revisions. A changed
revision cannot bypass an unresolved earlier attempt in that scope. A genuinely
unsubmitted versioned run may receive a new generation; the historical run and
its action/report records remain available by their original IDs. Timestamped
signature payloads are rematerialized rather than required to equal stale ones.

## Client journal and exclusive ownership

Serialize setup work in one actor per account/controller/market/purpose. Persist
the journal atomically in local, non-cloud-synchronized storage. A random request
key must not be shared between devices or logged. UUID v4 is accepted.

Before any admission HTTP request, save:

```json
{
  "runId": "11111111-1111-4111-8111-111111111111",
  "actionId": "action_owned_12345678",
  "requestKey": "22222222-2222-4222-8222-222222222222",
  "phase": "requested"
}
```

Before entering any wallet/provider execution function, durably change phase to
`wallet_entered`. After receiving a result, persist phase `reported` and its
exact report **before** posting that report. Storage failure before wallet entry
must stop execution; storage failure afterwards must never authorize a resend.
Keep account and intent boundaries in storage keys. Abort/revoke local signing
when the user/account/intent changes; do not interpret this as cancellation of
an already entered wallet call.

## One-time admission

```http
POST /funding/preparation/runs/{runId}/actions/{actionId}/admit
Content-Type: application/json

{ "requestKey": "22222222-2222-4222-8222-222222222222" }
```

The authenticated server derives ownership, signer, delivery mode and action.
Do not send replacement payloads, signer addresses, user IDs or execution modes.

Successful first grant:

```json
{
  "ok": true,
  "runId": "11111111-1111-4111-8111-111111111111",
  "actionId": "action_owned_12345678",
  "admitted": true,
  "requestKeyMatches": true,
  "delivery": "embedded",
  "action": { "kind": "evm_transaction", "...": "exact normalized action" },
  "executionKey": "trade-preparation:v1:<runId>:<actionId>:<admissionId>"
}
```

Invoke a wallet at most once, only for a matching `admitted: true` response with
a non-null exact action and execution key. Repeated/concurrent admissions,
including the same request key, return `admitted: false`, `action: null` and
`executionKey: null`. This means status recovery, never another wallet call.
`requestKeyMatches` indicates whether a denied grant belongs to this exact
request key. If false, do not cancel the other actor's admission; discard only
your own never-entered local request record. It is not execution permission.

Expired/closed/changed preparations, foreign owners and mismatched report keys
fail without granting execution. Normal validation errors are HTTP 400,
ownership failures 404 and state/conflict failures 409. An admission denial can
also be HTTP 200 with `admitted: false`; checking HTTP status alone is unsafe.

## Delivery modes

### Embedded EVM

Use the returned execution key unchanged in both
`POST /wallets/embedded/ethereum/prepare` and `/execute`. Preserve exact chain,
to/data/value/gas, sequential/atomic mode and existing sponsorship policy. Use
`returnOnAccepted: true`.

Admission reserves the exact action. Before the provider POST, the server checks
the owned admission, controller/signer and payload, then commits a once-only
dispatch marker. It journals acceptance independently of the mobile report.
Replaying execute after acceptance returns the stored reference, not a new POST.
If dispatch started but its response is unknown, execute is rejected for status
recovery. A client failure/cancellation cannot erase that marker. Only an exact
server-classified authorization rejection or canonical receipt can resolve it.

A reserved action that never reached server dispatch may expire and be replaced;
the old execution key then cannot dispatch. Provider idempotency or Redis cache
retention is not relied upon for this guarantee.

### Client/direct wallet execution

Admission immediately records that execution may occur before exposing the
payload. Persist `wallet_entered` before invoking Phantom/another wallet.
An RPC timeout, disconnected UI or thrown unknown error is `ambiguous`, not
proof that no transaction was sent. Do not repeat the invocation.

## Reporting and recovery

Post to the existing endpoint, including the original request key:

```http
POST /funding/preparation/runs/{runId}/actions/{actionId}/report
Content-Type: application/json

{
  "outcome": "submitted",
  "transactionReference": "0x<transaction-hash-or-supported-provider-reference>",
  "actualCosts": { "networkFeeRaw": null },
  "admissionKey": "22222222-2222-4222-8222-222222222222"
}
```

| Durable client evidence                                            | Permitted recovery                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `reported` with saved result                                       | Repeat only the exact report, then GET/reconcile                                    |
| `wallet_entered`, result unknown                                   | GET/reconcile existing run; never invoke wallet again                               |
| `requested`, original actor is exclusively stopped                 | Retry admission with its same key; if denied, report positively known non-execution |
| Another actor/device owns the attempt, or local history is missing | Status-only; absence of a server report is not non-execution evidence               |

Only if the original exclusive actor can prove the transaction wallet function
was never invoked, post `outcome: "cancelled"`, null reference,
`notStartedReason: "wallet_not_invoked"` and its original `admissionKey`.
A positively identified pre-submission wallet rejection can use
`notStartedReason: "wallet_rejected"`. Never infer either reason from elapsed
time, `broadcastMayHaveOccurred: false`, a generic exception, or a missing row.

The web implementation holds a Web Lock across the runner before recovering a
saved `requested` record across tabs. Without cross-tab exclusion it does not
automatically reclassify an older requested record. Native must provide the
equivalent exclusive-actor guarantee. After explicit non-execution is accepted,
a normal fresh inspect/prepare can create a new generation without waiting for
an arbitrary housekeeping delay.
Status restoration also drains saved reports. Under the same exclusive lock it
can retry a durable `requested` key and close a matching, never-entered grant
without invoking a wallet. A denied admission before any grant (for example
`evidence_stale`) must not fabricate a cancellation report for a nonexistent
grant; preserve its request key while normal inspect/prepare safely advances.

A known reference cannot be replaced by a conflicting reference. Later exact
provider acceptance can enrich a timeout with no reference, including after a
client disconnect/restart. Never clear an unknown attempt merely to obtain a
new grant.

For multi-action setup, a canonical receipt may finish one approval while
other actions remain. If admission returns `evidence_stale`, refresh inspect and
call normal prepare again with the fresh revision. The server can create a
successor containing only currently required actions after confirming that all
earlier actions are either canonically completed or never executable. Preserve
the original run for status/history; never resend its completed action. A changed
revision cannot bypass a still-unknown blockchain action. Provider transaction
IDs and user-operation IDs are reported as `ambiguous`; a chain transaction hash
is `submitted`. Neither is final receipt confirmation by itself.
For a connect signature, signing/reporting alone is not completion. Fresh
authoritative inspection must confirm that signature-backed connect setup is
no longer required. Only that off-chain postcondition can complete signature
steps while approvals remain; it never marks an unknown chain approval done.

## Legacy runs

Old runs have null/absent `admissionProtocolVersion`. A bare expired run with
`action_required`, no report and `broadcastMayHaveOccurred: false` is still
uncertain: the old client may have entered a wallet before losing its report.
New clients must not automatically execute it or bypass it using a new revision.

If the **original client has positive durable evidence that it never invoked
the transaction wallet**, it can explicitly report that legacy action as
`cancelled` with `notStartedReason: "wallet_not_invoked"` through the existing
owner-scoped report endpoint. Legacy reports do not have an admission key.
Only then may fresh versioned prepare replace that closed setup. This is an
affirmative client fact, not an inference or a general “retry” button. If that
evidence is unavailable, use status reconciliation/support instead. Previously
submitted/ambiguous reports cannot be overwritten by this assertion.

This does not retry a bridge or order, grant permission to sign for another
wallet, or resume a cancelled/abandoned Buy. For the iOS 37/38 case, distinguish
the original no-wallet-call evidence from the later expired server replay.

## Integration checklist

- Advertise/request admission v1; never fall back silently.
- Persist the request key before HTTP and `wallet_entered` before wallet entry.
- Enforce exclusive ownership across screens, tasks and app restoration.
- Test lost admit/report responses, app termination, duplicate taps, stale
  screens, multiple devices and account switches.
- For embedded EVM, propagate the returned execution key through both endpoints.
- Do not label a reservation/claim as actively converting or submitting.
- Keep existing quote, price, slippage, receipt and fresh trade-intent checks.
- Backend first, then admission-aware clients; coordinate native adoption before
  retiring legacy compatibility. No production operation is repaired by release.
