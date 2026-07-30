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
          reductionCompleted: false,
        }),
        "complete",
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
      assert.match(claim, /for update skip locked/i);
      assert.match(
        claim,
        /coalesce\(last_observed_at, opened_at\)[\s\S]*interval '1 millisecond'/i,
      );
      assert.match(
        claim,
        /status in \('expired', 'cancelled'\) then \$5::bigint/i,
      );
      assert.match(
        claim,
        /opened_at <= \$1 - \(\$6::bigint \* interval '1 millisecond'\)[\s\S]*then \$4::bigint/i,
      );
      assert.match(claim, /set last_observed_at = \$1/i);
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
        ["wallet_profile_evm_v1", "wallet_profile_svm_v1"],
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
];

for (const test of tests) {
  test.run();
  console.log(`[funding-persistence-tests] ok ${test.name}`);
}
console.log(
  `[funding-persistence-tests] passed ${tests.length}/${tests.length}`,
);
