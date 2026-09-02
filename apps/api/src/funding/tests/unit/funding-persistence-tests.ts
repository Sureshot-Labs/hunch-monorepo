import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalJson,
  canonicalJsonEqual,
  canonicalJsonHash,
  hashOpaqueToken,
  lookupHmac,
} from "../../persistence/canonical.js";
import { legacyBridgeCreationAllowed } from "../../legacy/bridge-adapter-classifier.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  PRODUCTION_FUNDING_REGISTRY,
} from "../../policies/funding-policy.js";
import {
  FUNDING_RECONCILIATION_EVIDENCE_REDUCTION_GRACE_MS,
  fundingReconciliationDisposition,
  fundingReconciliationPollDelayMs,
  fundingReconciliationTerminalTimeoutReached,
} from "../../reconciliation/funding-reducer.js";

type Test = Readonly<{ name: string; run: () => void }>;

const tests: readonly Test[] = [
  {
    name: "reconciliation stops active operations at a named terminal timeout without timing out user-funded waits",
    run: () => {
      const startedAt = new Date("2026-07-29T15:00:00.000Z");
      const common = {
        reconciliationStartedAt: startedAt,
        now: new Date("2026-07-29T15:01:30.000Z"),
        terminalTimeoutMs: 90_000,
      };
      assert.equal(
        fundingReconciliationDisposition({
          ...common,
          state: { status: "in_progress", stage: "source_action" },
          reductionCompleted: false,
        }),
        "recovery_required",
      );
      assert.equal(
        fundingReconciliationDisposition({
          ...common,
          canonicalFinalizedStepEvidencePendingReduction: true,
          state: { status: "in_progress", stage: "source_action" },
          reductionCompleted: false,
        }),
        "requeue",
        "already-finalized canonical step evidence must be reduced, not timed out",
      );
      assert.equal(
        fundingReconciliationDisposition({
          ...common,
          canonicalFinalizedStepEvidencePendingReduction: true,
          state: { status: "in_progress", stage: "source_action" },
          reductionCompleted: false,
          now: new Date(
            startedAt.getTime() +
              common.terminalTimeoutMs +
              FUNDING_RECONCILIATION_EVIDENCE_REDUCTION_GRACE_MS,
          ),
        }),
        "recovery_required",
        "finalized step receipts cannot hide a missing operation postcondition forever",
      );
      assert.equal(
        fundingReconciliationDisposition({
          ...common,
          state: {
            status: "awaiting_external_funds",
            stage: "source_action",
          },
          reductionCompleted: false,
        }),
        "requeue",
      );
      assert.equal(
        fundingReconciliationDisposition({
          ...common,
          state: { status: "in_progress", stage: "source_action" },
          reductionCompleted: false,
          reconciliationStartedAt: null,
        }),
        "requeue",
      );
      assert.equal(
        fundingReconciliationDisposition({
          ...common,
          state: { status: "recovery_required", stage: "source_action" },
          canonicalFinalizedStepEvidencePendingReduction: true,
          recoveryMode: "manual_review",
          reductionCompleted: false,
        }),
        "complete",
        "manual recovery remains an explicit operator boundary even when step receipts finalized",
      );
      assert.equal(
        fundingReconciliationDisposition({
          ...common,
          state: { status: "in_progress", stage: "source_action" },
          reductionCompleted: true,
        }),
        "complete",
      );
      assert.equal(
        fundingReconciliationTerminalTimeoutReached({
          reconciliationStartedAt: startedAt,
          now: new Date("2026-07-29T15:01:29.999Z"),
          terminalTimeoutMs: 90_000,
        }),
        false,
      );
      assert.equal(fundingReconciliationTerminalTimeoutReached(common), true);
    },
  },
  {
    name: "funding reconciliation polls active operations without hot-looping idle operations",
    run: () => {
      const delays = {
        activePollDelayMs: 2_000,
        idlePollDelayMs: 15_000,
      };
      assert.equal(
        fundingReconciliationPollDelayMs(
          { status: "in_progress", stage: "routing" },
          delays,
        ),
        2_000,
      );
      assert.equal(
        fundingReconciliationPollDelayMs(
          { status: "reconcile_required", stage: "source_action" },
          delays,
        ),
        2_000,
      );
      assert.equal(
        fundingReconciliationPollDelayMs(
          { status: "awaiting_external_funds", stage: "source_action" },
          delays,
        ),
        15_000,
      );
      assert.equal(
        fundingReconciliationPollDelayMs(
          { status: "awaiting_user", stage: "source_action" },
          delays,
        ),
        15_000,
      );
    },
  },
  {
    name: "terminal metadata patches preserve the first completion timestamp",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../persistence/funding-operation-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      assert.match(
        source,
        /when \$10::boolean then coalesce\(completed_at, \$11::timestamptz\)/i,
      );
      assert.doesNotMatch(source, /when \$10::boolean then \$11::timestamptz/i);
      assert.match(
        source,
        /when \$2 = 'recovery_required'[\s\S]+then \$4::text[\s\S]+else null/i,
      );
    },
  },
  {
    name: "action start takes a fresh snapshot after the operation lock before inspecting sibling stop states",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../persistence/funding-evidence-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const start = source.slice(
        source.indexOf(
          "export async function startFundingStepAttemptForUserInTransaction",
        ),
        source.indexOf("export async function startFundingStepAttemptForUser("),
      );
      const operationLock = start.indexOf("from funding_operations");
      const siblingRead = start.indexOf("from funding_operation_steps step");
      assert.ok(operationLock >= 0 && siblingRead > operationLock);
      assert.match(
        start.slice(0, siblingRead),
        /from funding_operations[\s\S]*for update/u,
      );
      assert.match(
        start,
        /sibling_step\.state in \([\s\S]*'failed'[\s\S]*'cancelled'[\s\S]*'reconcile_required'[\s\S]*'recovery_required'/u,
      );
      assert.match(start, /if \(row\.sibling_stop_state\)/u);
    },
  },
  {
    name: "attempt mutation paths lock operation then step then attempt with fresh statements",
    run: () => {
      const evidence = readFileSync(
        new URL(
          "../../persistence/funding-evidence-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const receipt = readFileSync(
        new URL(
          "../../persistence/funding-step-receipt-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const delegatedExecutor = readFileSync(
        new URL(
          "../../execution/delegated-funding-executor.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const relayExecutor = readFileSync(
        new URL(
          "../../execution/relay-evm-delegated-executor-profile.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const slices = [
        evidence.slice(
          evidence.indexOf(
            "export async function finishFundingStepAttemptForUserInTransaction",
          ),
          evidence.indexOf(
            "export async function resolveAmbiguousProviderFundingStepAttemptForUserInTransaction",
          ),
        ),
        evidence.slice(
          evidence.indexOf(
            "export async function resolveAmbiguousProviderFundingStepAttemptForUserInTransaction",
          ),
          evidence.indexOf(
            "export async function finishFundingStepAttemptForUser(",
          ),
        ),
        receipt.slice(
          receipt.indexOf(
            "export async function applyFundingStepReceiptEvidenceInTransaction",
          ),
          receipt.indexOf(
            "export async function applyFundingStepReceiptEvidence(",
          ),
        ),
        delegatedExecutor.slice(
          delegatedExecutor.indexOf(
            "async function polymarketRouterPreBroadcastDecisionInTransaction",
          ),
          delegatedExecutor.indexOf(
            "export function createPolymarketRouterDelegatedFundingProfile",
            delegatedExecutor.indexOf(
              "async function polymarketRouterPreBroadcastDecisionInTransaction",
            ),
          ),
        ),
        relayExecutor.slice(
          relayExecutor.indexOf("async function preBroadcastRelay"),
          relayExecutor.indexOf(
            "async function allocateFinalizedRelaySourceDebitInTransaction",
          ),
        ),
      ];
      for (const mutationPath of slices) {
        const operationLock = mutationPath.indexOf("from funding_operations");
        const stepLock = mutationPath.indexOf("from funding_operation_steps");
        const attemptLock = mutationPath.indexOf(
          "from funding_operation_step_attempts",
        );
        assert.ok(
          operationLock >= 0 &&
            stepLock > operationLock &&
            attemptLock > stepLock,
        );
        assert.doesNotMatch(
          mutationPath,
          /for update of operation, step, attempt/u,
        );
      }
    },
  },
  {
    name: "Relay source-debit allocation acquires the allowance lane before canonical funding row locks",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../execution/relay-evm-delegated-executor-profile.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const allocator = source.slice(
        source.indexOf(
          "async function allocateFinalizedRelaySourceDebitInTransaction",
        ),
        source.indexOf(
          "export async function recordFinalizedRelaySourceDebitForOperation",
        ),
      );
      const discovery = allocator.indexOf("const candidates");
      const laneLock = allocator.indexOf(
        "tryLockFundingAuthorizationReservationScope",
      );
      const operationLock = allocator.indexOf(
        "from funding_operations",
        laneLock,
      );
      const stepLock = allocator.indexOf(
        "from funding_operation_steps",
        operationLock,
      );
      const receiptLock = allocator.indexOf(
        "from funding_step_receipt_observations",
        stepLock,
      );
      const reservationLock = allocator.indexOf(
        "from telegram_funding_authorization_reservations",
        receiptLock,
      );
      assert.ok(
        discovery >= 0 &&
          laneLock > discovery &&
          operationLock > laneLock &&
          stepLock > operationLock &&
          receiptLock > stepLock &&
          reservationLock > receiptLock,
      );
      assert.doesNotMatch(allocator.slice(discovery, laneLock), /for update/u);
      assert.doesNotMatch(
        allocator,
        /for update of operation, deposit_step, deposit_receipt, reservation/u,
      );
    },
  },
  {
    name: "reducer clears unresolved attempt fencing only for canonical finalized success or failure",
    run: () => {
      const source = readFileSync(
        new URL("../../reconciliation/funding-reducer.ts", import.meta.url),
        "utf8",
      );
      const startedAttemptAlias = source.indexOf("as has_started_attempt");
      const startedAttemptTable = source.indexOf(
        "from funding_operation_step_attempts started_attempt",
      );
      const attemptFacts = source.slice(
        source.lastIndexOf("exists (", startedAttemptTable),
        source.indexOf(
          "from funding_operation_steps step",
          startedAttemptAlias,
        ),
      );
      assert.equal(attemptFacts.match(/and not exists \(/gu)?.length, 2);
      assert.match(
        attemptFacts,
        /receipt\.status = 'finalized'[\s\S]*receipt\.canonical[\s\S]*receipt\.action_match/u,
      );
      assert.match(
        attemptFacts,
        /receipt\.status = 'failed'[\s\S]*receipt\.canonical[\s\S]*failureFinalized/u,
      );
      assert.doesNotMatch(
        attemptFacts,
        /receipt\.status not in \('finalized', 'failed'\)/u,
      );
    },
  },
  {
    name: "consumer reservation expiry uses intent-operation-reservation order and preserves broadcast-capable trade attempts",
    run: () => {
      const source = readFileSync(
        new URL("../../reconciliation/funding-reducer.ts", import.meta.url),
        "utf8",
      );
      const preflight = source.slice(
        source.indexOf(
          "async function preflightSettledConsumerReservationExpiry",
        ),
        source.indexOf("async function reconcileBoundStepsForSegment"),
      );
      const intentLock = preflight.indexOf(
        "from telegram_trade_intents intent",
      );
      const operationLock = preflight.indexOf(
        "fetchFundingOperationForWorkerInTransaction",
      );
      const reservationLock = preflight.indexOf(
        "expireSettledConsumerReservation(client",
      );
      assert.ok(
        intentLock >= 0 &&
          operationLock > intentLock &&
          reservationLock > operationLock,
      );
      const expiryQueries = source.slice(
        source.indexOf("async function expireSettledConsumerReservation"),
        source.indexOf("async function reconcileBoundStepsForSegment"),
      );
      assert.match(
        expiryQueries,
        /trade_attempt\.state in \('submission_started', 'ambiguous'\)[\s\S]*or trade_attempt\.broadcast_may_have_occurred/u,
      );
    },
  },
  {
    name: "cancellation and implicit order recovery acquire canonical funding locks before mutation locks",
    run: () => {
      const cancellation = readFileSync(
        new URL(
          "../../reconciliation/funding-operation-cancellation.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const cancelPath = cancellation.slice(
        cancellation.indexOf(
          "export async function cancelFundingOperationForUser",
        ),
      );
      const unlockedScope = cancelPath.indexOf(
        "fetchFundingOperationForUser(client, input)",
      );
      const intentLock = cancelPath.indexOf(
        "from telegram_trade_intents intent",
      );
      const operationLock = cancelPath.indexOf("from funding_operations");
      const stepLock = cancelPath.indexOf("from funding_operation_steps");
      assert.ok(
        unlockedScope >= 0 &&
          intentLock > unlockedScope &&
          operationLock > intentLock &&
          stepLock > operationLock,
      );

      const attempts = readFileSync(
        new URL(
          "../../persistence/funding-trade-attempt-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const recovery = attempts.slice(
        attempts.indexOf(
          "export async function recoverFundingTradeAttemptForOrderInTransaction",
        ),
      );
      const recoveryIntent = recovery.indexOf(
        "from telegram_trade_intents intent",
      );
      const recoveryOperation = recovery.indexOf("from funding_operations");
      const recoveryReservation = recovery.indexOf("from balance_reservations");
      const recoveryAttempt = recovery.indexOf(
        "from funding_trade_attempts attempt",
        recoveryOperation,
      );
      assert.ok(
        recoveryIntent >= 0 &&
          recoveryOperation > recoveryIntent &&
          recoveryReservation > recoveryOperation &&
          recoveryAttempt > recoveryReservation,
      );
      assert.doesNotMatch(recovery, /for update of reservation, attempt/u);

      const orders = readFileSync(
        new URL("../../../repos/orders-repo.ts", import.meta.url),
        "utf8",
      );
      const storeOrder = orders.slice(
        orders.indexOf("export async function storeOrderInTransaction"),
        orders.indexOf("export async function storeOrder("),
      );
      assert.ok(
        storeOrder.indexOf("pg_advisory_xact_lock") <
          storeOrder.indexOf("recoverFundingTradeAttemptForOrderInTransaction"),
      );
      assert.ok(
        storeOrder.indexOf("recoverFundingTradeAttemptForOrderInTransaction") <
          storeOrder.indexOf("FOR UPDATE"),
      );
    },
  },
  {
    name: "receive-session polling is durably throttled and claimed across workers",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../persistence/funding-receive-session-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const start = source.indexOf(
        "export async function claimObservableFundingReceiveSessions",
      );
      const end = source.indexOf(
        "export async function listFundingReceiveReceiptsForUser",
        start,
      );
      assert.ok(start >= 0 && end > start);
      const claim = source.slice(start, end);
      assert.match(claim, /for update of receive_session skip locked/i);
      assert.match(
        claim,
        /coalesce\(last_observed_at, opened_at\)[\s\S]*interval '1 millisecond'/i,
      );
      assert.match(
        claim,
        /status in \('completed', 'expired', 'cancelled'\) then \$5::bigint/i,
      );
      assert.match(
        claim,
        /coalesce\(observation_requested_at, opened_at\)[\s\S]*\$6::bigint[\s\S]*then \$4::bigint/i,
      );
      assert.match(claim, /last_observed_at < observation_requested_at/i);
      assert.match(claim, /as next_poll_at/i);
      assert.match(
        claim,
        /order by eligible_session\.next_poll_at asc,[\s\S]*eligible_session\.request_priority asc/i,
      );
      assert.match(claim, /set last_observed_at = \$1/i);
      assert.match(
        source,
        /export async function requestFundingReceiveSessionObservation[\s\S]*observation_requested_at = greatest/i,
      );
    },
  },
  {
    name: "funding worker projects routed receipts before delegated execution and aggregates the final projection",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../worker/funding-reconciliation-worker.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const routing = source.indexOf("const receiveRouting =");
      const earlyProjection = source.indexOf(
        "const earlyTelegramFundingProgress =",
      );
      const delegatedExecution = source.indexOf(
        "const delegatedFundingExecution =",
      );
      const finalProjection = source.indexOf(
        "const finalTelegramFundingProgress =",
      );
      assert.ok(
        routing >= 0 &&
          earlyProjection > routing &&
          delegatedExecution > earlyProjection &&
          finalProjection > delegatedExecution,
        "queued progress must be projected after routing but before provider execution",
      );
      assert.match(
        source,
        /earlyTelegramFundingProgress\.created \+[\s\S]*finalTelegramFundingProgress\.created/,
      );
      assert.match(
        source.slice(earlyProjection, delegatedExecution),
        /\.catch\(\(\) => \(\{ candidates: 0, created: 0, skipped: 0 \}\)\)/,
        "an early presentation failure must not block provider execution",
      );
    },
  },
  {
    name: "Relay recovery keeps unbroadcast retry and provider replay leases distinct",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../execution/relay-evm-delegated-executor-profile.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const recovery = source.slice(
        source.indexOf("async function recoverRelay"),
      );
      assert.ok(recovery.length > 0);
      assert.equal(
        recovery.match(
          /when attempt\.outcome = 'started' then \$2::timestamptz\s+else \$3::timestamptz/giu,
        )?.length,
        2,
        "main and cleanup recovery SQL must use the short lease only for started attempts",
      );
      assert.equal(
        recovery.match(
          /attempt_outcome === "started"\s+\? input\.recoverUnbroadcastRetryBefore\s+: input\.recoverProviderReplayBefore/gu,
        )?.length,
        2,
        "both recovery lease CAS updates must preserve the same threshold split",
      );
    },
  },
  {
    name: "trade-attempt lease arithmetic pins timestamp parameters before adding intervals",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../persistence/funding-trade-attempt-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      assert.match(
        source,
        /claim_lease_until = \$2::timestamptz \+ interval '15 seconds'/i,
      );
      assert.match(
        source,
        /\$14::timestamptz \+ interval '15 seconds', \$14::timestamptz/i,
      );
      assert.doesNotMatch(
        source,
        /claim_lease_until = \$2 \+ interval '15 seconds'/i,
      );
    },
  },
  {
    name: "funded trade terminal paths share intent operation reservation attempt lock order",
    run: () => {
      const attemptSource = readFileSync(
        new URL(
          "../../persistence/funding-trade-attempt-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const lockStart = attemptSource.indexOf(
        "async function lockFundingOperationForAttempt",
      );
      const lockEnd = attemptSource.indexOf(
        "export async function claimFundingTradeAttemptInTransaction",
        lockStart,
      );
      const lockSource = attemptSource.slice(lockStart, lockEnd);
      const intentLock = lockSource.indexOf("from telegram_trade_intents");
      const operationLock = lockSource.indexOf("from funding_operations");
      const reservationLock = lockSource.indexOf("from balance_reservations");
      assert.ok(intentLock >= 0);
      assert.ok(intentLock < operationLock);
      assert.ok(operationLock < reservationLock);

      const evidenceSource = readFileSync(
        new URL(
          "../../persistence/funding-evidence-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const consumeStart = evidenceSource.indexOf(
        "export async function consumeFundingReservationForLinkedConsumerInTransaction",
      );
      const consumeEnd = evidenceSource.indexOf(
        "export async function consumeFundingReservationForLinkedConsumer(",
        consumeStart,
      );
      const consumeSource = evidenceSource.slice(consumeStart, consumeEnd);
      const consumeIntent = consumeSource.indexOf(
        "from telegram_trade_intents",
      );
      const consumeOperation = consumeSource.indexOf("from funding_operations");
      const consumeReservation = consumeSource.indexOf(
        "const lockedReservation",
      );
      const consumeAttempt = consumeSource.indexOf(
        "acceptFundingTradeAttemptInTransaction",
      );
      assert.ok(consumeIntent >= 0);
      assert.ok(consumeIntent < consumeOperation);
      assert.ok(consumeOperation < consumeReservation);
      assert.ok(consumeReservation < consumeAttempt);
    },
  },
  {
    name: "Limitless ambiguity reconciliation is leased and status-only",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../reconciliation/limitless-trade-attempt-reconciler.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const attemptRepositorySource = readFileSync(
        new URL(
          "../../persistence/funding-trade-attempt-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      assert.match(
        source,
        /claimAmbiguousLimitlessTradeAttemptsForReconciliation/,
      );
      assert.match(source, /\/orders\/status\/batch/);
      assert.doesNotMatch(source, /requestPath:\s*["']\/orders["']/);
      assert.match(
        source,
        /releaseFundingReservationForProvenAbsentLimitlessTrade/,
      );
      assert.match(source, /storeOrder/);
      assert.match(
        attemptRepositorySource,
        /state in \('submission_started', 'ambiguous'\)/,
      );
      assert.match(
        attemptRepositorySource,
        /resolved_at = coalesce\(resolved_at, \$3\)/,
      );
      assert.match(
        attemptRepositorySource,
        /claim_token = \$4::uuid[\s\S]*claim_lease_until > clock_timestamp\(\)/,
      );
      assert.match(
        attemptRepositorySource,
        /expectedReconciliationClaimToken[\s\S]*claim_lease_until > clock_timestamp\(\)/,
      );
    },
  },
  {
    name: "canonical JSON is key-order independent and rejects non-JSON values",
    run: () => {
      assert.equal(
        canonicalJson({ z: 1, nested: { b: true, a: false }, a: [2, 1] }),
        '{"a":[2,1],"nested":{"a":false,"b":true},"z":1}',
      );
      assert.equal(
        canonicalJsonHash({ a: 1, b: 2 }),
        canonicalJsonHash({ b: 2, a: 1 }),
      );
      assert.equal(canonicalJsonEqual({ a: [1, 2] }, { a: [1, 2] }), true);
      assert.throws(() => canonicalJson({ invalid: undefined }));
      assert.throws(() => canonicalJson({ invalid: Number.POSITIVE_INFINITY }));
    },
  },
  {
    name: "opaque identifiers use one-way hash/HMAC material",
    run: () => {
      const token = "consent-token-with-enough-entropy";
      assert.equal(hashOpaqueToken(` ${token} `), hashOpaqueToken(token));
      assert.notEqual(
        lookupHmac("provider-reference", "a".repeat(32)),
        lookupHmac("provider-reference", "b".repeat(32)),
      );
      assert.throws(() => lookupHmac("provider-reference", "short"));
    },
  },
  {
    name: "production funding registry pins reviewed providers and wallet-profile executors",
    run: () => {
      assert.equal(DEFAULT_FUNDING_RUNTIME_POLICY.creationMode, "off");
      assert.deepEqual(DEFAULT_FUNDING_RUNTIME_POLICY.providers, []);
      assert.equal(DEFAULT_FUNDING_RUNTIME_POLICY.gates.quoteCreation, false);
      assert.equal(DEFAULT_FUNDING_RUNTIME_POLICY.gates.commit, false);
      assert.equal(
        DEFAULT_FUNDING_RUNTIME_POLICY.gates.startUnsubmittedAction,
        false,
      );
      assert.deepEqual(
        PRODUCTION_FUNDING_REGISTRY.providerAdapters.map(({ id }) => id),
        ["relay_quote_v2", "relay_strict_deposit_address_v1"],
      );
      assert.deepEqual(
        PRODUCTION_FUNDING_REGISTRY.actionValidators.map(({ id }) => id),
        ["relay_evm_action_v1", "relay_svm_action_v1"],
      );
      assert.deepEqual(
        PRODUCTION_FUNDING_REGISTRY.networkExecutors.map(({ id }) => id),
        [
          "wallet_profile_evm_v1",
          "wallet_profile_svm_v1",
          "polymarket_deposit_pusd_fund_v1",
        ],
      );
      assert.ok(
        PRODUCTION_FUNDING_REGISTRY.reconcilers.some(
          ({ id }) => id === "relay_status_v3",
        ),
      );
      assert.equal(legacyBridgeCreationAllowed("across_swap_api_v1"), false);

      const persistenceSource = readFileSync(
        new URL(
          "../../persistence/funding-operation-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const evidenceSource = readFileSync(
        new URL(
          "../../persistence/funding-evidence-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const workerSource = readFileSync(
        new URL(
          "../../worker/funding-reconciliation-worker.ts",
          import.meta.url,
        ),
        "utf8",
      );
      for (const source of [persistenceSource, evidenceSource, workerSource]) {
        assert.doesNotMatch(source, /\bfetch\s*\(/);
        assert.doesNotMatch(source, /\baxios\b/i);
        assert.doesNotMatch(source, /\brelay_api_key\b/i);
      }
    },
  },
  {
    name: "notifications cannot become settlement evidence",
    run: () => {
      const reducerSource = readFileSync(
        new URL("../../reconciliation/funding-reducer.ts", import.meta.url),
        "utf8",
      );
      assert.match(reducerSource, /listFundingObservationsForOperation/);
      assert.doesNotMatch(reducerSource, /notifications?/i);
      assert.doesNotMatch(reducerSource, /telegram_notification_outbox/i);

      const ingestionSource = readFileSync(
        new URL(
          "../../reconciliation/funding-observation-ingestion.ts",
          import.meta.url,
        ),
        "utf8",
      );
      assert.match(ingestionSource, /allocateFundingObservationInTransaction/);
      assert.match(ingestionSource, /wakeFundingReconciliationInTransaction/);
      assert.match(ingestionSource, /"webhook"/);
      assert.match(ingestionSource, /"polling"/);
    },
  },
  {
    name: "empty Relay maintenance does not plan branch-specific queries",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../execution/relay-evm-delegated-executor-profile.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const guardedBranches = [
        ["approval", "approval"],
        ["releasable", "releasable"],
        ["strandedAllowance", "stranded"],
        ["deposit", "deposit"],
        ["cleanup", "cleanup"],
      ] as const;
      for (const [variableName, maintenanceKind] of guardedBranches) {
        assert.match(
          source,
          new RegExp(
            `const ${variableName} =\\s+maintenance\\?\\.kind === "${maintenanceKind}"\\s+\\? await client\\.query`,
            "u",
          ),
        );
      }
      assert.match(source, /name: "funding-relay-observe-postcondition-v1"/u);
    },
  },
];

for (const test of tests) {
  test.run();
  console.log(`[funding-persistence-tests] ok ${test.name}`);
}
console.log(
  `[funding-persistence-tests] passed ${tests.length}/${tests.length}`,
);
