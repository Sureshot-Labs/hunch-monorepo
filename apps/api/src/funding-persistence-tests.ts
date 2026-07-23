import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalJson,
  canonicalJsonEqual,
  canonicalJsonHash,
  hashOpaqueToken,
  lookupHmac,
} from "./funding/persistence/canonical.js";
import { legacyBridgeCreationAllowed } from "./funding/legacy/bridge-adapter-classifier.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  PRODUCTION_FUNDING_REGISTRY,
} from "./funding/policies/funding-policy.js";

type Test = Readonly<{ name: string; run: () => void }>;

const tests: readonly Test[] = [
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
    name: "WP4 registers reviewed provider components but keeps execution unreachable",
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
      assert.deepEqual(PRODUCTION_FUNDING_REGISTRY.networkExecutors, []);
      assert.ok(
        PRODUCTION_FUNDING_REGISTRY.reconcilers.some(
          ({ id }) => id === "relay_status_v3",
        ),
      );
      assert.equal(legacyBridgeCreationAllowed("across_swap_api_v1"), false);

      const persistenceSource = readFileSync(
        new URL(
          "./funding/persistence/funding-operation-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const evidenceSource = readFileSync(
        new URL(
          "./funding/persistence/funding-evidence-repository.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const workerSource = readFileSync(
        new URL(
          "./funding/worker/funding-reconciliation-worker.ts",
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
        new URL("./funding/reconciliation/funding-reducer.ts", import.meta.url),
        "utf8",
      );
      assert.match(reducerSource, /listFundingObservationsForOperation/);
      assert.doesNotMatch(reducerSource, /notifications?/i);
      assert.doesNotMatch(reducerSource, /telegram_notification_outbox/i);

      const ingestionSource = readFileSync(
        new URL(
          "./funding/reconciliation/funding-observation-ingestion.ts",
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
