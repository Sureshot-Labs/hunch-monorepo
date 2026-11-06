// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import type { Pool } from "@hunch/infra";
import { AuthService, type UserWallet } from "../../../auth.js";
import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import { FundingPlanningRuntime } from "../../planner/runtime-service.js";
import type { PreparationResult } from "../../domain/contracts.js";
import { EmbeddedEvmAuthorizationRejectedError } from "../../../services/embedded-ethereum.js";
import {
  admitFundingPreparationAction,
  createOrReplayFundingPreparationRun,
  fetchFundingPreparationRun,
  reportFundingPreparationAction,
  resolveFundingPreparationRun,
  type FundingPreparationRun,
  type FundingPreparationRunRequest,
} from "../../persistence/funding-preparation-run-repository.js";
import {
  inspectEmbeddedPreparationAdmission,
  beginPreparationProviderDispatch,
  journalPreparationProviderAcceptance,
  journalPreparationProviderRejection,
} from "../../preparation/embedded-admission.js";
import { parsePreparationExecutionKey } from "../../preparation/admission-contract.js";
import { materializePreparationAction } from "../../preparation/core-adapter.js";
import type { NormalizedAction } from "../../domain/types.js";
import type { EmbeddedFundingPayload } from "../../execution/embedded-funding-submission-contract.js";

const schema = `preparation_admission_${randomUUID().replaceAll("-", "")}`;
const db = await createIntegrationTestPool({
  max: 8,
  options: `-c search_path=${schema},public`,
});
const userId = randomUUID(),
  controllerId = randomUUID();
const signer = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}`;
const data = `0x095ea7b3${"0".repeat(24)}${"3".repeat(40)}${"0".repeat(62)}63`;
const future = () => new Date(Date.now() + 60_000);
function inspection(
  overrides: Partial<PreparationResult> = {},
): PreparationResult {
  return {
    status: "setup_required",
    binding: {
      bindingId: "binding_fixture_12345678",
      venueId: "polymarket",
      controllerWalletId: controllerId,
      executionWalletId: controllerId,
      accountRef: signer,
      signingMode: "web_client",
      settlementLocation: {
        kind: "venue_account",
        locationId: "location_fixture_12345678",
        accountId: userId,
        asset: { networkId: "evm:8453", assetId: token, decimals: 6 },
        details: {},
      },
    },
    safeLabel: "Wallet fixture",
    purpose: "buy",
    marketClass: "clob",
    readinessClass: "external_setup_available",
    executionMode: "web_client",
    topology: "signer",
    inspectionRevision: "inspection_fixture_12345678",
    inspectedAt: new Date().toISOString(),
    expiresAt: future().toISOString(),
    requiredActions: [],
    postconditions: [],
    reasonCodes: [],
    evidence: { facts: {}, checks: [] },
    ...overrides,
  };
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`[preparation-admission] ok ${name}`);
}
function action(runId: string, dataOverride = data): NormalizedAction {
  return {
    kind: "evm_transaction",
    actionId: `approval_${runId}`,
    networkId: "evm:8453",
    senderWalletId: "wallet_owned_controller",
    to: token,
    data: dataOverride,
    valueRaw: "0",
    gasLimitRaw: null,
  };
}
function request(): FundingPreparationRunRequest {
  return {
    venueBindingOptionId: `binding_${randomUUID()}`,
    purpose: "buy",
    marketContextId: null,
    marketClass: "clob",
    positionActionRef: null,
    controllerWalletRef: null,
    expectedInspectionRevision: `inspection_${randomUUID()}`,
  };
}
const prepare = (
  scope: FundingPreparationRunRequest,
  protocol: 0 | 1 = 1,
  expiresAt = future(),
  materialize = async (runId: string) => ({
    controllerWalletRef: controllerId,
    actions: [action(runId)],
  }),
) =>
  createOrReplayFundingPreparationRun(db, {
    userId,
    request: scope,
    admissionProtocolVersion: protocol === 1 ? 1 : undefined,
    expiresAt,
    materialize,
  });
async function fixture(protocol: 0 | 1 = 1) {
  const scope = request();
  return { scope, run: await prepare(scope, protocol) };
}
async function read(run: FundingPreparationRun) {
  const result = await fetchFundingPreparationRun(db, {
    userId,
    runId: run.runId,
  });
  assert.ok(result);
  return result;
}
function first(run: FundingPreparationRun) {
  const value = run.actions[0];
  assert.ok(value);
  return value;
}
function admit(
  run: FundingPreparationRun,
  requestKey = randomUUID(),
  mode: "web_client" | "privy_authorization" = "web_client",
) {
  return admitFundingPreparationAction(db, {
    userId,
    runId: run.runId,
    actionId: first(run).actionId,
    requestKey,
    inspectionRevision: run.inspectionRevision,
    controllerWalletRef: controllerId,
    executionMode: mode,
    signer,
  });
}
const payload = (): EmbeddedFundingPayload => ({
  kind: "ethereum",
  signer,
  chainId: 8453,
  executionMode: "sequential",
  returnOnAccepted: true,
  transactions: [{ to: token, data, value: "0", sponsor: true }],
});
async function expire(run: FundingPreparationRun) {
  await db.query(
    "update funding_preparation_runs set expires_at=now()-interval '1 minute' where id=$1",
    [run.runId],
  );
}
async function journalCount(scope: FundingPreparationRunRequest) {
  return Number(
    (
      await db.query(
        "select count(*)::int as count from funding_preparation_runs where user_id=$1 and request_snapshot->>'venueBindingOptionId'=$2",
        [userId, scope.venueBindingOptionId],
      )
    ).rows[0]?.count,
  );
}
async function embeddedFixture() {
  const base = await fixture();
  const key = randomUUID();
  const grant = await admit(base.run, key, "privy_authorization");
  assert.ok(grant.executionKey);
  const parsed = parsePreparationExecutionKey(grant.executionKey);
  assert.ok(parsed);
  return { ...base, key, grant, parsed };
}

let created = false;
try {
  assert.equal(
    Math.floor(
      Number(
        (await db.query("show server_version_num")).rows[0]?.server_version_num,
      ) / 10000,
    ),
    16,
  );
  await db.query(`create schema ${schema}`);
  created = true;
  await db.query(
    `create table users(id uuid primary key); create function funding_touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$`,
  );
  for (const migration of [
    "0193_funding_preparation_runs.sql",
    "0256_preparation_approval_receipt_failure.sql",
  ])
    await db.query(
      await readFile(
        new URL(
          `../../../../../../packages/db/migrations/${migration}`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  await db.query("insert into users(id) values($1)", [userId]);

  await test("expired never-admitted run creates a fresh generation and preserves historical actions", async () => {
    const { scope, run } = await fixture();
    await expire(run);
    assert.equal((await read(run)).status, "expired");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => prepare(scope)),
    );
    assert.ok(results.every((result) => result.runId !== run.runId));
    assert.equal(new Set(results.map((result) => result.runId)).size, 1);
    assert.equal(results.filter((result) => !result.replayed).length, 1);
    assert.equal(await journalCount(scope), 2);
    const historical = await read(run);
    assert.equal(historical.status, "expired");
    assert.deepEqual(historical.actions, run.actions);
    await assert.rejects(
      admit(historical),
      /closed, changed or already submitted/,
    );
  });

  await test("only one simultaneous admission obtains executable payload; retries never do", async () => {
    const { run } = await fixture();
    const keys = Array.from({ length: 8 }, () => randomUUID());
    const grants = await Promise.all(keys.map((key) => admit(run, key)));
    assert.equal(grants.filter((grant) => grant.admitted).length, 1);
    for (const grant of grants.filter((grant) => !grant.admitted)) {
      assert.equal(grant.action, null);
      assert.equal(grant.executionKey, null);
      assert.equal(grant.requestKeyMatches, false);
    }
    const winner = grants.findIndex((grant) => grant.admitted);
    const replay = await admit(run, keys[winner]);
    assert.equal(replay.admitted, false);
    assert.equal(replay.action, null);
    assert.equal(replay.requestKeyMatches, true);
    const stored = await read(run);
    assert.equal(stored.status, "ambiguous");
    assert.equal(first(stored).broadcastMayHaveOccurred, true);
    assert.doesNotMatch(
      JSON.stringify(stored.request),
      new RegExp(keys[winner] ?? "missing-key"),
    );
  });

  await test("an unresolved admission cannot be bypassed by expiry or a different inspection revision", async () => {
    const { scope, run } = await fixture();
    await admit(run);
    await expire(run);
    const replay = await prepare({
      ...scope,
      expectedInspectionRevision: `inspection_${randomUUID()}`,
    });
    assert.equal(replay.runId, run.runId);
    assert.equal(replay.status, "ambiguous");
    assert.equal(await journalCount(scope), 1);
    assert.equal(
      (await prepare(scope, 0)).runId,
      run.runId,
      "an old client cannot create a parallel legacy run",
    );
  });

  await test("positive never-invoked report closes only its matching grant and enables fresh setup", async () => {
    const { scope, run } = await fixture();
    const key = randomUUID();
    await admit(run, key);
    await assert.rejects(
      reportFundingPreparationAction(db, {
        userId,
        runId: run.runId,
        actionId: first(run).actionId,
        report: {
          outcome: "cancelled",
          transactionReference: null,
          networkFeeRaw: null,
          admissionKey: randomUUID(),
          notStartedReason: "wallet_not_invoked",
        },
      }),
      /matching preparation admission/,
    );
    await reportFundingPreparationAction(db, {
      userId,
      runId: run.runId,
      actionId: first(run).actionId,
      report: {
        outcome: "cancelled",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
        notStartedReason: "wallet_not_invoked",
      },
    });
    const next = await prepare(scope);
    assert.notEqual(next.runId, run.runId);
    await assert.rejects(
      reportFundingPreparationAction(db, {
        userId,
        runId: run.runId,
        actionId: first(run).actionId,
        report: {
          outcome: "submitted",
          transactionReference: hash,
          networkFeeRaw: null,
          admissionKey: key,
        },
      }),
      /closed without execution/,
    );
  });

  await test("a generic negative or later not-started assertion cannot erase reported uncertainty", async () => {
    const { scope, run } = await fixture();
    const key = randomUUID();
    await admit(run, key);
    const report = { userId, runId: run.runId, actionId: first(run).actionId };
    await reportFundingPreparationAction(db, {
      ...report,
      report: {
        outcome: "failed",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
      },
    });
    assert.equal((await read(run)).status, "ambiguous");
    await reportFundingPreparationAction(db, {
      ...report,
      report: {
        outcome: "ambiguous",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
      },
    });
    await reportFundingPreparationAction(db, {
      ...report,
      report: {
        outcome: "cancelled",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
        notStartedReason: "wallet_not_invoked",
      },
    });
    assert.equal((await read(run)).status, "ambiguous");
    assert.equal((await prepare(scope)).runId, run.runId);
  });

  await test("safe negative actions recover alongside untouched/completed siblings, never unknown siblings", async () => {
    for (const preceding of ["untouched", "succeeded", "unknown"] as const) {
      for (const negative of ["failed", "cancelled"] as const) {
        const scope = request();
        const run = await prepare(scope, 1, future(), async (runId) => ({
          controllerWalletRef: controllerId,
          actions: [
            action(runId),
            action(`${runId}_second`),
            action(`${runId}_third`),
          ],
        }));
        let current = run;
        if (preceding !== "untouched") {
          const key = randomUUID();
          await admit(run, key);
          current = await reportFundingPreparationAction(db, {
            userId,
            runId: run.runId,
            actionId: first(run).actionId,
            report: {
              outcome: preceding === "unknown" ? "ambiguous" : "submitted",
              transactionReference: preceding === "unknown" ? null : hash,
              networkFeeRaw: null,
              admissionKey: key,
            },
          });
          if (preceding === "succeeded")
            current = await resolveFundingPreparationRun(db, {
              userId,
              runId: run.runId,
              expectedActions: current.actions,
              approvalOutcomes: [
                {
                  actionId: first(run).actionId,
                  status: "succeeded",
                  evidence: {
                    transactionReference: hash,
                    canonical: true,
                    actionMatch: true,
                  },
                },
              ],
            });
        }
        const second = run.actions[1];
        assert.ok(second);
        const key = randomUUID();
        await admitFundingPreparationAction(db, {
          userId,
          runId: run.runId,
          actionId: second.actionId,
          requestKey: key,
          inspectionRevision: run.inspectionRevision,
          controllerWalletRef: controllerId,
          executionMode: "web_client",
          signer,
        });
        await reportFundingPreparationAction(db, {
          userId,
          runId: run.runId,
          actionId: second.actionId,
          report: {
            outcome: negative,
            transactionReference: null,
            networkFeeRaw: null,
            admissionKey: key,
            notStartedReason: "wallet_rejected",
          },
        });
        const next = await prepare(scope);
        if (preceding === "unknown") assert.equal(next.runId, run.runId);
        else {
          assert.notEqual(next.runId, run.runId);
          assert.equal(
            (await read(run)).actions[1]?.broadcastMayHaveOccurred,
            false,
          );
          if (preceding === "succeeded")
            assert.equal((await read(run)).actions[0]?.state, "succeeded");
        }
      }
    }
  });

  await test("reserved embedded permission can expire; the old execution key then cannot dispatch", async () => {
    const { scope, run, parsed } = await embeddedFixture();
    await expire(run);
    const next = await prepare(scope);
    assert.notEqual(next.runId, run.runId);
    let providerCalls = 0;
    await assert.rejects(
      (async () => {
        await beginPreparationProviderDispatch(db, userId, parsed, payload());
        providerCalls++;
      })(),
      /status recovery/,
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual((await read(run)).actions, run.actions);
  });

  await test("two real dispatch paths call the mocked provider once, beyond Redis/idempotency windows", async () => {
    const { run, grant, parsed } = await embeddedFixture();
    let providerCalls = 0;
    assert.ok(grant.executionKey);
    const send = async () => {
      await inspectEmbeddedPreparationAdmission(
        db,
        userId,
        grant.executionKey ?? undefined,
        payload(),
      );
      await beginPreparationProviderDispatch(db, userId, parsed, payload());
      providerCalls++;
      await journalPreparationProviderAcceptance(db, userId, parsed, [
        { kind: "transaction", value: hash },
      ]);
    };
    await Promise.allSettled([send(), send()]);
    assert.equal(providerCalls, 1);
    const recovered = await inspectEmbeddedPreparationAdmission(
      db,
      userId,
      grant.executionKey,
      payload(),
    );
    assert.equal(recovered?.acceptedReference?.value, hash);
    assert.equal(first(await read(run)).transactionReference, hash);
  });

  await test("lost provider response stays ambiguous after reconstructing all runtime objects", async () => {
    const { scope, run, grant, parsed } = await embeddedFixture();
    await beginPreparationProviderDispatch(db, userId, parsed, payload());
    await assert.rejects(
      inspectEmbeddedPreparationAdmission(
        db,
        userId,
        grant.executionKey ?? undefined,
        payload(),
      ),
      /status recovery/,
    );
    await expire(run);
    assert.equal((await prepare(scope)).runId, run.runId);
    await assert.rejects(
      beginPreparationProviderDispatch(db, userId, parsed, payload()),
      /status recovery/,
    );
    assert.equal((await read(run)).status, "ambiguous");
  });

  await test("a weaker client timeout converges with independently stored provider acceptance", async () => {
    const { run, key, parsed } = await embeddedFixture();
    await beginPreparationProviderDispatch(db, userId, parsed, payload());
    await journalPreparationProviderAcceptance(db, userId, parsed, [
      { kind: "transaction", value: hash },
    ]);
    const result = await reportFundingPreparationAction(db, {
      userId,
      runId: run.runId,
      actionId: first(run).actionId,
      report: {
        outcome: "ambiguous",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
      },
    });
    assert.equal(result.status, "submitted");
    assert.equal(first(result).transactionReference, hash);
    assert.equal(first(result).broadcastMayHaveOccurred, true);
    await assert.rejects(
      beginPreparationProviderDispatch(db, userId, parsed, payload()),
      /status recovery/,
    );
  });

  await test("failed acceptance persistence never authorizes a second provider dispatch", async () => {
    const { run, parsed } = await embeddedFixture();
    await beginPreparationProviderDispatch(db, userId, parsed, payload());
    const faulty = {
      connect: async () => {
        const client = await db.connect();
        return {
          query: async (sql: string, params?: readonly unknown[]) => {
            if (sql.includes("transaction_reference = $6"))
              throw Error(
                "injected persistence failure after provider acceptance",
              );
            return client.query(sql, [...(params ?? [])]);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    await assert.rejects(
      journalPreparationProviderAcceptance(faulty, userId, parsed, [
        { kind: "transaction", value: hash },
      ]),
      /persistence failure/,
    );
    assert.equal((await read(run)).status, "ambiguous");
    await assert.rejects(
      beginPreparationProviderDispatch(db, userId, parsed, payload()),
      /status recovery/,
    );
  });

  await test("late provider acceptance enriches a client timeout without losing its reference", async () => {
    const { run, key, parsed } = await embeddedFixture();
    await beginPreparationProviderDispatch(db, userId, parsed, payload());
    await reportFundingPreparationAction(db, {
      userId,
      runId: run.runId,
      actionId: first(run).actionId,
      report: {
        outcome: "ambiguous",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
      },
    });
    await journalPreparationProviderAcceptance(db, userId, parsed, [
      { kind: "transaction", value: hash },
    ]);
    const saved = await read(run);
    assert.equal(saved.status, "submitted");
    assert.equal(first(saved).transactionReference, hash);
    await assert.rejects(
      reportFundingPreparationAction(db, {
        userId,
        runId: run.runId,
        actionId: first(run).actionId,
        report: {
          outcome: "submitted",
          transactionReference: `0x${"cd".repeat(32)}`,
          networkFeeRaw: null,
          admissionKey: key,
        },
      }),
      /different report/,
    );
    assert.equal(first(await read(run)).transactionReference, hash);
  });

  await test("client cancellation cannot undo dispatch; only exact server authorization rejection can close it", async () => {
    const { scope, run, key, parsed } = await embeddedFixture();
    await beginPreparationProviderDispatch(db, userId, parsed, payload());
    await reportFundingPreparationAction(db, {
      userId,
      runId: run.runId,
      actionId: first(run).actionId,
      report: {
        outcome: "cancelled",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
        notStartedReason: "wallet_rejected",
      },
    });
    assert.equal((await read(run)).status, "ambiguous");
    await journalPreparationProviderRejection(
      db,
      userId,
      parsed,
      1,
      new Error("network failed"),
    );
    assert.equal((await read(run)).status, "ambiguous");
    await journalPreparationProviderRejection(
      db,
      userId,
      parsed,
      1,
      new EmbeddedEvmAuthorizationRejectedError("rejected", 401),
    );
    const closed = await read(run);
    assert.equal(closed.status, "failed");
    assert.equal(first(closed).broadcastMayHaveOccurred, false);
    assert.notEqual((await prepare(scope)).runId, run.runId);
  });

  await test("exact signer/network/contract/calldata/value and owner are checked before provider entry", async () => {
    const { run, grant, parsed } = await embeddedFixture();
    const base = payload();
    assert.equal(base.kind, "ethereum");
    if (base.kind !== "ethereum") throw Error("fixture");
    const call = base.transactions[0];
    assert.ok(call);
    const variants: EmbeddedFundingPayload[] = [
      { ...base, signer: token },
      { ...base, chainId: 137 },
      { ...base, transactions: [{ ...call, to: signer }] },
      { ...base, transactions: [{ ...call, data: "0x" }] },
      { ...base, transactions: [{ ...call, value: "1" }] },
      { ...base, returnOnAccepted: false },
    ];
    for (const candidate of variants)
      await assert.rejects(
        beginPreparationProviderDispatch(db, userId, parsed, candidate),
        /match/,
      );
    await assert.rejects(
      inspectEmbeddedPreparationAdmission(
        db,
        randomUUID(),
        grant.executionKey ?? undefined,
        base,
      ),
      /match/,
    );
    assert.equal(first(await read(run)).broadcastMayHaveOccurred, false);
  });

  await test("admission/report ownership and protocol cannot be supplied or bypassed by a caller", async () => {
    const { run } = await fixture();
    await assert.rejects(
      admitFundingPreparationAction(db, {
        userId: randomUUID(),
        runId: run.runId,
        actionId: first(run).actionId,
        requestKey: randomUUID(),
        inspectionRevision: run.inspectionRevision,
        controllerWalletRef: controllerId,
        executionMode: "web_client",
        signer,
      }),
      /not found/,
    );
    await assert.rejects(
      reportFundingPreparationAction(db, {
        userId,
        runId: run.runId,
        actionId: first(run).actionId,
        report: {
          outcome: "submitted",
          transactionReference: hash,
          networkFeeRaw: null,
        },
      }),
      /matching preparation admission/,
    );
    const legacyScope = request();
    const legacy = await prepare(legacyScope, 0);
    await assert.rejects(admit(legacy), /predates/);
  });

  await test("legacy expired absence is not proof; explicit never-invoked evidence has a recovery path", async () => {
    const legacyScope = request();
    const legacy = await prepare(legacyScope, 0);
    await expire(legacy);
    const replay = await prepare({
      ...legacyScope,
      expectedInspectionRevision: `inspection_${randomUUID()}`,
    });
    assert.equal(replay.runId, legacy.runId);
    assert.equal(replay.request.executionJournal, undefined);
    await reportFundingPreparationAction(db, {
      userId,
      runId: legacy.runId,
      actionId: first(legacy).actionId,
      report: {
        outcome: "cancelled",
        transactionReference: null,
        networkFeeRaw: null,
        notStartedReason: "wallet_not_invoked",
      },
    });
    const next = await prepare(legacyScope);
    assert.notEqual(next.runId, legacy.runId);
    assert.equal(next.request.executionJournal?.version, 1);
    assert.equal(
      first(await read(legacy)).report?.notStartedReason,
      "wallet_not_invoked",
    );
  });

  await test("a reported legacy submission cannot be cancelled or bypassed by protocol/revision changes", async () => {
    const legacyScope = request();
    const legacy = await prepare(legacyScope, 0);
    await reportFundingPreparationAction(db, {
      userId,
      runId: legacy.runId,
      actionId: first(legacy).actionId,
      report: {
        outcome: "submitted",
        transactionReference: hash,
        networkFeeRaw: null,
      },
    });
    await assert.rejects(
      reportFundingPreparationAction(db, {
        userId,
        runId: legacy.runId,
        actionId: first(legacy).actionId,
        report: {
          outcome: "cancelled",
          transactionReference: null,
          networkFeeRaw: null,
          notStartedReason: "wallet_not_invoked",
        },
      }),
      /different report/,
    );
    assert.equal(
      (
        await prepare({
          ...legacyScope,
          expectedInspectionRevision: `inspection_${randomUUID()}`,
        })
      ).runId,
      legacy.runId,
    );
  });

  await test("timestamped signature materializers recover with fresh generation rather than equality loops", async () => {
    const scope = request();
    let timestamp = 1;
    const materialize = async (runId: string) => ({
      controllerWalletRef: controllerId,
      actions: [
        materializePreparationAction(
          {
            actionKey: "connect_signature",
            summary: {
              kind: "signature",
              safeLabel: "Connect",
              actor: "user",
              valueMoving: false,
              sponsorship: "none",
            },
            action: {
              kind: "signature",
              networkId: "evm:137",
              signerWalletId: "wallet_owned_controller",
              payload: { timestamp },
              payloadKind: "eip712",
            },
          },
          { operationId: runId },
        ),
      ],
    });
    const firstRun = await prepare(scope, 1, future(), materialize);
    await expire(firstRun);
    timestamp++;
    const next = await prepare(scope, 1, future(), materialize);
    assert.notEqual(next.runId, firstRun.runId);
    assert.notDeepEqual(first(next).action, first(firstRun).action);
    assert.equal((await read(firstRun)).status, "expired");
  });

  await test("an exact cancelled legacy row cannot hide an unresolved older revision", async () => {
    const scope = request();
    const older = await prepare(scope, 0);
    // Model historical rows created before the business-scope fence existed.
    const otherScope = { ...scope, expectedInspectionRevision: randomUUID() };
    const { fundingPreparationRequestFingerprint } =
      await import("../../persistence/funding-preparation-run-repository.js");
    const cancelledId = randomUUID();
    await db.query(
      `insert into funding_preparation_runs(id,user_id,request_fingerprint,request_snapshot,inspection_revision,controller_wallet_ref,status,expires_at,resolved_at)
      values($1,$2,$3,$4::jsonb,$5,$6,'cancelled',now(),null)`,
      [
        cancelledId,
        userId,
        fundingPreparationRequestFingerprint(otherScope),
        otherScope,
        otherScope.expectedInspectionRevision,
        controllerId,
      ],
    );
    assert.equal((await prepare(otherScope)).runId, older.runId);
    assert.equal(await journalCount(scope), 2);
  });

  await test("provider and user-operation acceptance converge with the web's ambiguous report", async () => {
    for (const accepted of [
      {
        kind: "provider_transaction" as const,
        value: "privy-transaction-v1:provider_accepted_fixture",
      },
      {
        kind: "user_operation" as const,
        value: `privy-user-operation-v1:${hash}`,
      },
    ]) {
      const { run, key, parsed } = await embeddedFixture();
      await beginPreparationProviderDispatch(db, userId, parsed, payload());
      await journalPreparationProviderAcceptance(db, userId, parsed, [
        accepted,
      ]);
      const acceptedRun = await read(run);
      const reference = first(acceptedRun).transactionReference;
      assert.ok(reference);
      await reportFundingPreparationAction(db, {
        userId,
        runId: run.runId,
        actionId: first(run).actionId,
        report: {
          outcome: "ambiguous",
          transactionReference: reference,
          networkFeeRaw: null,
          admissionKey: key,
        },
      });
      assert.equal(first(await read(run)).state, "ambiguous");
    }
  });

  await test("mixed multi-action preparation preserves canonical success and renews only remaining setup", async () => {
    const original = AuthService.getUserWallets;
    const scope = request();
    const iface = new ethers.Interface([
      "event Approval(address indexed owner,address indexed spender,uint256 value)",
    ]);
    const log = iface.encodeEventLog("Approval", [
      signer,
      `0x${"3".repeat(40)}`,
      99n,
    ]);
    const opaque = stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: "evm:8453",
      address: signer,
    });
    const makeActions = (runId: string) => [
      {
        kind: "signature" as const,
        actionId: `sig_${runId}`,
        networkId: "evm:8453",
        signerWalletId: opaque,
        payloadKind: "eip712" as const,
        payload: { fixture: true },
      },
      { ...action(runId), senderWalletId: opaque },
      { ...action(`${runId}_remaining`), senderWalletId: opaque },
    ];
    let ready = false;
    let unknown = false;
    let revision = scope.expectedInspectionRevision;
    const runtime = new FundingPlanningRuntime(db, {
      preparationReceiptReader: async () => {
        if (unknown) return { transaction: null, receipt: null };
        return {
          transaction: {
            chainId: 8453n,
            from: signer,
            to: token,
            data,
            value: 0n,
          },
          receipt: {
            succeeded: true,
            blockNumber: 1,
            blockHash: hash,
            canonicalBlockHash: hash,
            confirmations: 100,
            logs: [{ address: token, topics: log.topics, data: log.data }],
          },
        };
      },
    });
    Object.defineProperty(runtime, "preparationRuntime", {
      value: {
        inspectBindingOption: async () =>
          inspection({
            status: ready ? "ready" : "setup_required",
            executionMode: "web_client",
            inspectionRevision: revision,
            requiredActions: [],
          }),
      },
    });
    try {
      AuthService.getUserWallets = async () => [
        {
          id: controllerId,
          walletType: "ethereum",
          walletAddress: signer,
          isVerified: true,
        } as UserWallet,
      ];
      const run = await prepare(scope, 1, future(), async (runId) => ({
        controllerWalletRef: controllerId,
        actions: makeActions(runId),
      }));
      const approval = run.actions[1];
      assert.ok(approval);
      const key = randomUUID();
      await admitFundingPreparationAction(db, {
        userId,
        runId: run.runId,
        actionId: approval.actionId,
        requestKey: key,
        inspectionRevision: revision,
        controllerWalletRef: controllerId,
        executionMode: "web_client",
        signer,
      });
      await reportFundingPreparationAction(db, {
        userId,
        runId: run.runId,
        actionId: approval.actionId,
        report: {
          outcome: "submitted",
          transactionReference: hash,
          networkFeeRaw: null,
          admissionKey: key,
        },
      });
      unknown = true;
      ready = true;
      assert.notEqual(
        (await runtime.reconcilePreparationRun(userId, run.runId))?.status,
        "succeeded",
        "readiness cannot clear an unknown chain action",
      );
      unknown = false;
      ready = false;
      const reconciled = await runtime.reconcilePreparationRun(
        userId,
        run.runId,
      );
      assert.ok(reconciled);
      assert.equal(
        reconciled.actions[1]?.state,
        "succeeded",
        "mixed signature must not suppress approval receipt verification",
      );
      revision = randomUUID();
      const remaining = run.actions[2];
      assert.ok(remaining);
      await assert.rejects(
        runtime.admitPreparationAction(userId, {
          runId: run.runId,
          actionId: remaining.actionId,
          requestKey: randomUUID(),
        }),
        /requirements changed/,
      );
      const next = await prepare(
        { ...scope, expectedInspectionRevision: revision },
        1,
        future(),
        async (runId) => ({
          controllerWalletRef: controllerId,
          actions: [
            { ...action(`${runId}_remaining`), senderWalletId: opaque },
          ],
        }),
      );
      assert.notEqual(next.runId, run.runId);
      assert.equal(next.actions.length, 1);
      assert.equal((await read(run)).actions[1]?.state, "succeeded");
      assert.equal(
        (
          await runtime.admitPreparationAction(userId, {
            runId: next.runId,
            actionId: first(next).actionId,
            requestKey: randomUUID(),
          })
        ).admitted,
        true,
      );
    } finally {
      AuthService.getUserWallets = original;
    }
  });

  await test("completed connect signature unblocks remaining approvals only after authoritative postcondition", async () => {
    const original = AuthService.getUserWallets;
    const scope = request();
    const opaque = stableWalletOpaqueId({
      walletType: "ethereum",
      networkId: "evm:8453",
      address: signer,
    });
    const run = await prepare(scope, 1, future(), async (runId) => ({
      controllerWalletRef: controllerId,
      actions: [
        {
          kind: "signature",
          actionId: `signature_${runId}`,
          networkId: "evm:8453",
          signerWalletId: opaque,
          payloadKind: "eip712",
          payload: { fixture: true },
        },
        { ...action(runId), senderWalletId: opaque },
      ],
    }));
    const signature = first(run),
      approval = run.actions[1];
    assert.ok(approval);
    const key = randomUUID();
    await admitFundingPreparationAction(db, {
      userId,
      runId: run.runId,
      actionId: signature.actionId,
      requestKey: key,
      inspectionRevision: run.inspectionRevision,
      controllerWalletRef: controllerId,
      executionMode: "web_client",
      signer,
    });
    await reportFundingPreparationAction(db, {
      userId,
      runId: run.runId,
      actionId: signature.actionId,
      report: {
        outcome: "ambiguous",
        transactionReference: null,
        networkFeeRaw: null,
        admissionKey: key,
      },
    });
    let connected = false;
    const nextRevision = randomUUID();
    const runtime = new FundingPlanningRuntime(db, {
      preparationReceiptReader: async () => ({
        transaction: null,
        receipt: null,
      }),
    });
    Object.defineProperty(runtime, "preparationRuntime", {
      value: {
        inspectBindingOption: async () =>
          inspection({
            status: "setup_required",
            executionMode: "web_client",
            inspectionRevision: connected
              ? nextRevision
              : run.inspectionRevision,
            requiredActions: connected
              ? [
                  {
                    kind: "evm_transaction",
                    safeLabel: "Approve",
                    actor: "user",
                    valueMoving: false,
                    sponsorship: "none",
                  },
                ]
              : [
                  {
                    kind: "signature",
                    safeLabel: "Connect",
                    actor: "user",
                    valueMoving: false,
                    sponsorship: "none",
                  },
                  {
                    kind: "evm_transaction",
                    safeLabel: "Approve",
                    actor: "user",
                    valueMoving: false,
                    sponsorship: "none",
                  },
                ],
          }),
      },
    });
    try {
      AuthService.getUserWallets = async () => [
        {
          id: controllerId,
          walletType: "ethereum",
          walletAddress: signer,
          isVerified: true,
        } as UserWallet,
      ];
      assert.equal(
        (await runtime.reconcilePreparationRun(userId, run.runId))?.actions[0]
          ?.state,
        "ambiguous",
        "a client report alone does not prove connect",
      );
      connected = true;
      await assert.rejects(
        runtime.admitPreparationAction(userId, {
          runId: run.runId,
          actionId: approval.actionId,
          requestKey: randomUUID(),
        }),
        /requirements changed/,
      );
      assert.equal((await read(run)).actions[0]?.state, "succeeded");
      const next = await prepare(
        { ...scope, expectedInspectionRevision: nextRevision },
        1,
        future(),
        async (runId) => ({
          controllerWalletRef: controllerId,
          actions: [{ ...action(runId), senderWalletId: opaque }],
        }),
      );
      assert.notEqual(next.runId, run.runId);
      assert.equal(next.actions.length, 1);
      assert.equal(
        (
          await runtime.admitPreparationAction(userId, {
            runId: next.runId,
            actionId: first(next).actionId,
            requestKey: randomUUID(),
          })
        ).admitted,
        true,
      );
    } finally {
      AuthService.getUserWallets = original;
    }
  });

  await test("runtime admission refreshes exact controller evidence and derives mode/signer on the server", async () => {
    const original = AuthService.getUserWallets;
    const make = async (validActor: boolean) => {
      const scope = request();
      return prepare(scope, 1, future(), async (runId) => ({
        controllerWalletRef: controllerId,
        actions: [
          {
            ...action(runId),
            senderWalletId: validActor
              ? stableWalletOpaqueId({
                  walletType: "ethereum",
                  networkId: "evm:8453",
                  address: signer,
                })
              : "foreign_actor",
          } as NormalizedAction,
        ],
      }));
    };
    try {
      AuthService.getUserWallets = async () => [
        {
          id: controllerId,
          walletAddress: signer,
          walletType: "ethereum",
          isVerified: true,
        } as UserWallet,
      ];
      const run = await make(true);
      let inspections = 0;
      const runtime = new FundingPlanningRuntime(db);
      Object.defineProperty(runtime, "preparationRuntime", {
        configurable: true,
        value: {
          inspectBindingOption: async (
            input: { controllerWalletRef: string },
            options: { forceFresh: boolean },
          ) => {
            inspections++;
            assert.equal(input.controllerWalletRef, controllerId);
            assert.equal(options.forceFresh, true);
            return {
              status: "setup_required",
              executionMode: "privy_authorization",
              inspectionRevision: run.inspectionRevision,
            } as PreparationResult;
          },
        },
      });
      const input = {
        runId: run.runId,
        actionId: first(run).actionId,
        requestKey: randomUUID(),
      };
      assert.equal(
        (await runtime.admitPreparationAction(userId, input)).delivery,
        "embedded",
      );
      assert.equal(
        (await runtime.admitPreparationAction(userId, input)).admitted,
        false,
      );
      assert.equal(
        inspections,
        1,
        "replayed admission must not re-enter RPC inspection",
      );
      const foreign = await make(false);
      Object.defineProperty(runtime, "preparationRuntime", {
        configurable: true,
        value: {
          inspectBindingOption: async () => ({
            status: "setup_required",
            executionMode: "privy_authorization",
            inspectionRevision: foreign.inspectionRevision,
          }),
        },
      });
      await assert.rejects(
        runtime.admitPreparationAction(userId, {
          runId: foreign.runId,
          actionId: first(foreign).actionId,
          requestKey: randomUUID(),
        }),
        /exact controller/,
      );
      assert.equal(first(await read(foreign)).broadcastMayHaveOccurred, false);
    } finally {
      AuthService.getUserWallets = original;
    }
  });
  console.log(
    `[preparation-admission] passed ${passed}/${passed} on PostgreSQL 16`,
  );
} finally {
  if (created) await db.query(`drop schema ${schema} cascade`);
  await db.end();
}
