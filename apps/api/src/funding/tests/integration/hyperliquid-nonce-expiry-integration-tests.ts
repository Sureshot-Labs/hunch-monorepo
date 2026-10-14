// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { hypercorePlanTestFixture } from "../../../funding-providers/relay/hypercore-plan-test-fixture.js";
import { normalizeRelayHypercoreWalletQuote } from "../../../funding-providers/relay/wallet-adapter.js";
import { buildRelayPlanningQuote } from "../../../funding-providers/relay/operation-plan.js";
import {
  commitFundingOperationInTransaction,
  createFundingQuoteInTransaction,
  FundingPersistenceError,
} from "../../persistence/funding-operation-repository.js";

const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=10000",
});
const control = await pool.connect(),
  first = await pool.connect(),
  second = await pool.connect();
try {
  assert.equal(
    (
      await control.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  const fixtureUser: string = (
    await control.query(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`native-expiry-${randomUUID()}@example.com`],
    )
  ).rows[0].id;
  assert.ok(fixtureUser);
  const at = new Date();
  const quoteIds: string[] = [];
  async function prepare(ttl: number) {
    const fixture = hypercorePlanTestFixture(at, fixtureUser);
    fixture.quoteInput.validation = {
      ...fixture.quoteInput.validation,
      maximumQuoteTtlMs: ttl,
    };
    fixture.input.quote = normalizeRelayHypercoreWalletQuote(
      fixture.quoteInput,
    );
    const plan = (await buildRelayPlanningQuote(fixture.input)).commitPlan;
    assert.ok(plan.operation.sourceSnapshot);
    const consentToken = randomUUID();
    const quote = await createFundingQuoteInTransaction(control, {
      userId: fixtureUser,
      discoveryProjectionId: randomUUID(),
      selectedSourceOptionSnapshot: plan.operation.sourceSnapshot,
      marketContextSnapshot: null,
      destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: plan,
      policyVersion: 1,
      policyRevision: "native-expiry-test",
      canonicalRequest: { test: true },
      consentToken,
      expiresAt: new Date(fixture.input.quote.candidate.expiresAt),
    });
    quoteIds.push(quote.id);
    return {
      userId: fixtureUser,
      quoteId: quote.id,
      consentToken,
      idempotencyKey: randomUUID(),
      plan,
      subjectLookupHmac: "f".repeat(64),
      subjectLookupKeyVersion: 1,
    };
  }
  const firstInput = await prepare(60000),
    secondInput = await prepare(1800);
  await first.query("begin");
  await second.query("begin");
  await commitFundingOperationInTransaction(first, firstInput);
  const firstPid = (await first.query("select pg_backend_pid() as pid")).rows[0]
    .pid;
  const secondPid = (await second.query("select pg_backend_pid() as pid"))
    .rows[0].pid;
  const waiting = commitFundingOperationInTransaction(second, secondInput).then(
    () => null,
    (error: unknown) => error,
  );
  let blocked = false;
  for (let poll = 0; poll < 60; poll++) {
    const blockers = (
      await control.query("select pg_blocking_pids($1) as ids", [secondPid])
    ).rows[0].ids as number[];
    if (blockers.includes(firstPid)) {
      blocked = true;
      break;
    }
    await delay(20);
  }
  assert.equal(
    blocked,
    true,
    "second common commit reached the contended nonce claim",
  );
  // Expire the short quote while its exact nonce INSERT waits. Bound to <2s.
  await control.query(
    "select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz-clock_timestamp())))+0.05)",
    [new Date(at.getTime() + 1800)],
  );
  await first.query("rollback");
  const error = await waiting;
  assert.ok(error instanceof FundingPersistenceError);
  assert.equal(error.code, "quote_expired");
  await second.query("rollback");
  assert.equal(
    (
      await control.query(
        "select count(*)::int as amount from funding_operations where user_id=$1",
        [fixtureUser],
      )
    ).rows[0].amount,
    0,
  );
  assert.equal(
    (
      await control.query(
        "select count(*)::int as amount from balance_reservations where user_id=$1",
        [fixtureUser],
      )
    ).rows[0].amount,
    0,
  );
  // The aborted commits leave only our unconsumed quotes. Preflight their exact
  // IDs before cleanup; never touch another user's or a consumed quote.
  const cleanup = await control.query(
    "select id from funding_quotes where user_id=$1 and id=any($2::uuid[]) and consumed_at is null",
    [fixtureUser, quoteIds],
  );
  assert.equal(cleanup.rowCount, quoteIds.length);
  await control.query(
    "delete from funding_quotes where user_id=$1 and id=any($2::uuid[]) and consumed_at is null",
    [fixtureUser, quoteIds],
  );
  const fixtureAccount = await control.query(
    "select id from users where id=$1 and email like 'native-expiry-%@example.com'",
    [fixtureUser],
  );
  assert.equal(fixtureAccount.rowCount, 1);
  await control.query(
    "delete from users where id=$1 and email like 'native-expiry-%@example.com'",
    [fixtureUser],
  );
  console.log(
    JSON.stringify({
      suite: "native-common-commit-expiry-pg16",
      expiredAfterLock: true,
      operations: 0,
      reservations: 0,
    }),
  );
} finally {
  for (const client of [first, second, control]) await client.query("rollback");
  first.release();
  second.release();
  control.release();
  await pool.end();
}
