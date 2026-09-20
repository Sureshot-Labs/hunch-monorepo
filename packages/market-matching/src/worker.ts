import {
  readMatchingPolicy,
  approvalRevision,
  matchingWorkerEnabled,
} from "./policy.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  approveContract,
  eligible,
  hash,
  readPolicy,
  EXPECTED_MODEL,
  PROMPT_VERSION,
  type Contract,
} from "./contracts.js";
import {
  decide,
  eventApproved,
  InferenceError,
  type JevResult,
  inferenceEvidence,
} from "./jev.js";
import {
  claim,
  loadSnapshot,
  versionId,
  withTransaction,
  type Job,
} from "./store.js";

export type WorkerOptions = {
  key: string;
  dailyBudget?: number;
  infer?: typeof decide;
};
export async function runJob(
  pool: Pool,
  options: WorkerOptions,
): Promise<string> {
  const matching = await readMatchingPolicy(pool);
  if (!matchingWorkerEnabled(matching)) return "disabled";
  const revision = approvalRevision(matching);
  const halt = await pool.query(
    "select state_key from market_matching_state where state_key in ('model_drift','cost_drift')",
  );
  if (halt.rows.length) throw new InferenceError(halt.rows[0].state_key);
  if (!options.key && !options.infer)
    throw new InferenceError("missing_openrouter_key");
  const allowLazy =
    matching.lazyEnabled &&
    matching.alternativesEnabled &&
    process.env.MATCHING_LAZY_ENABLED !== "false";
  const job = await claim(pool, matching.attempts, allowLazy);
  if (!job) return "idle";
  let budgetDay: string | null = null;
  const lazy = job.candidate_source === "lazy";
  const budget = Math.min(
    options.dailyBudget ?? matching.dailyBudgetUsd,
    matching.dailyBudgetUsd,
  );
  if (!Number.isFinite(budget) || budget < 0)
    throw new Error("invalid_matching_budget");
  const reserve = 0.01; // Exceeds worst-case input cost at the enforced 90KB request bound.
  try {
    const [a, b] = await Promise.all([
      loadSnapshot(pool, job.entity_kind, job.left_id),
      loadSnapshot(pool, job.entity_kind, job.right_id),
    ]);
    const policy = await readPolicy(pool);
    if (
      job.policy_version !== revision ||
      !a ||
      !b ||
      versionId(a) !== job.left_version ||
      versionId(b) !== job.right_version ||
      !matching.venues.some((v) => v === a.venue) ||
      !matching.venues.some((v) => v === b.venue) ||
      a.id === b.id ||
      (!matching.sameVenueEnabled && a.venue === b.venue) ||
      !eligible(policy, a.venue) ||
      !eligible(policy, b.venue) ||
      ("eventStatus" in a && a.eventStatus !== "ACTIVE") ||
      ("eventStatus" in b && b.eventStatus !== "ACTIVE") ||
      a.status !== "ACTIVE" ||
      b.status !== "ACTIVE"
    ) {
      await finish(pool, job, "stale");
      return "stale";
    }
    const reserved = await pool.query<{ budget_day: string }>(
      `insert into market_matching_budget(budget_day,reserved_usd,request_count,lazy_reserved_usd,lazy_request_count)
      select (now() at time zone 'UTC')::date,$1::numeric,1,case when $3 then $1::numeric else 0 end,case when $3 then 1 else 0 end
      where $5::int>0 and (not $3 or $6::int>0) and $1::numeric<=$2::numeric and (not $3 or $1::numeric<=$2::numeric*$4)
      on conflict(budget_day) do update set reserved_usd=market_matching_budget.reserved_usd+$1,request_count=market_matching_budget.request_count+1,
        lazy_reserved_usd=market_matching_budget.lazy_reserved_usd+case when $3 then $1::numeric else 0 end,
        lazy_request_count=market_matching_budget.lazy_request_count+case when $3 then 1 else 0 end
      where market_matching_budget.spent_usd+market_matching_budget.reserved_usd+$1<=$2
        and market_matching_budget.request_count<$5
        and (not $3 or (market_matching_budget.lazy_spent_usd+market_matching_budget.lazy_reserved_usd+$1<=$2*$4 and market_matching_budget.lazy_request_count<$6))
      returning budget_day::text`,
      [
        reserve,
        budget,
        lazy,
        matching.lazyBudgetFraction,
        matching.dailyRequests,
        matching.lazyDailyRequests,
      ],
    );
    budgetDay = reserved.rows[0]?.budget_day ?? null;
    if (!budgetDay) {
      await pool.query(
        `update market_matching_jobs set status='queued',attempts=attempts-1,lease_token=null,lease_until=null,next_attempt_at=now()+interval '5 minutes' where id=$1 and lease_token=$2`,
        [job.id, job.lease_token],
      );
      return "budget_wait";
    }
    const result = await (options.infer ?? decide)(
      job.entity_kind,
      inferenceEvidence(a),
      inferenceEvidence(b),
      options.key,
      fetch,
      matching.timeoutMs,
    );
    await pool.query(
      "update market_matching_budget set reserved_usd=greatest(0,reserved_usd-$2),spent_usd=spent_usd+$3,lazy_reserved_usd=greatest(0,lazy_reserved_usd-case when $4 then $2::numeric else 0 end),lazy_spent_usd=lazy_spent_usd+case when $4 then $3::numeric else 0 end where budget_day=$1::date",
      [budgetDay, reserve, result.cost, lazy],
    );
    budgetDay = null;
    if (result.cost > reserve) {
      await pool.query(
        "insert into market_matching_state(state_key,payload) values('cost_drift',$1) on conflict(state_key) do nothing",
        [{ cost: result.cost, reserve }],
      );
      throw new InferenceError("cost_drift");
    }
    if (result.model !== EXPECTED_MODEL)
      await pool.query(
        "insert into market_matching_state(state_key,payload) values('model_drift',$1) on conflict(state_key) do nothing",
        [{ expected: EXPECTED_MODEL, observed: result.model }],
      );
    const contractGate =
      job.entity_kind === "contract"
        ? approveContract(
            a as Contract,
            b as Contract,
            result.answer,
            result.model,
            result.outcomeAnswers,
            matching,
          )
        : null;
    const approved = contractGate
      ? contractGate.approved
      : eventApproved(result, matching);
    const publication = await withTransaction(pool, async (db) => {
      const lease = await db.query(
        "select id from market_matching_jobs where id=$1 and lease_token=$2 and lease_until>now() and status='running' for update",
        [job.id, job.lease_token],
      );
      if (!lease.rows.length) return "lease_lost";
      // Lock source rows against indexer updates through publication. Readers revalidate again.
      const table =
        job.entity_kind === "event" ? "unified_events" : "unified_markets";
      if (job.entity_kind === "contract")
        await db.query(
          "select id from unified_events where id=any($1::text[]) order by id for share",
          [[(a as Contract).eventId, (b as Contract).eventId]],
        );
      await db.query(
        `select id from ${table} where id=any($1::text[]) order by id for share`,
        [[a.id, b.id]],
      );
      const freshPolicy = await readPolicy(db);
      const freshMatching = await readMatchingPolicy(db);
      const currentA = await loadSnapshot(db, job.entity_kind, a.id),
        currentB = await loadSnapshot(db, job.entity_kind, b.id);
      const current =
        matchingWorkerEnabled(freshMatching) &&
        approvalRevision(freshMatching) === revision &&
        freshMatching.venues.some((v) => v === a.venue) &&
        freshMatching.venues.some((v) => v === b.venue) &&
        (freshMatching.sameVenueEnabled || a.venue !== b.venue) &&
        !!currentA &&
        !!currentB &&
        versionId(currentA) === job.left_version &&
        versionId(currentB) === job.right_version &&
        eligible(freshPolicy, a.venue) &&
        eligible(freshPolicy, b.venue);
      const modelHalt = await db.query(
        "select state_key from market_matching_state where state_key in ('model_drift','cost_drift')",
      );
      const disposition = !current
        ? "stale"
        : approved && !modelHalt.rows.length
          ? "approved"
          : "review";
      const evaluationId = randomUUID();
      await db.query(
        `insert into matching_evaluations(id,entity_kind,left_version,right_version,policy_version,model,request_payload,response_payload,decision,disposition,diagnostics,cost_usd,elapsed_ms)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          evaluationId,
          job.entity_kind,
          job.left_version,
          job.right_version,
          revision,
          result.model,
          result.request,
          result.response,
          result.answer.choice,
          disposition,
          {
            blockers: contractGate?.blockers ?? [],
            candidateSource: job.candidate_source,
            matchingPolicy: matching,
            promptVersion: PROMPT_VERSION,
          },
          result.cost,
          result.elapsedMs,
        ],
      );
      if (current) {
        const links =
          job.entity_kind === "event" ? "event_links" : "market_links";
        const linkId = hash([job.entity_kind, a.id, b.id]);
        await db.query(
          `insert into ${links}(id,left_id,right_id,left_version,right_version,evaluation_id,decision,disposition)
          values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(left_id,right_id) do update set
          left_version=excluded.left_version,right_version=excluded.right_version,evaluation_id=excluded.evaluation_id,decision=excluded.decision,disposition=excluded.disposition,updated_at=now()`,
          [
            linkId,
            a.id,
            b.id,
            job.left_version,
            job.right_version,
            evaluationId,
            contractGate?.approved ? "equivalent" : result.answer.choice,
            disposition,
          ],
        );
        if (contractGate) {
          await db.query(
            "delete from market_outcome_links where market_link_id=$1",
            [linkId],
          );
          if (disposition === "approved")
            for (const mapping of contractGate.mapping)
              await db.query(
                "insert into market_outcome_links(market_link_id,left_outcome_id,right_outcome_id) values($1,$2,$3)",
                [linkId, mapping.left, mapping.right],
              );
        }
      }
      await finish(db, job, current ? "completed" : "stale");
      return disposition;
    });
    if (result.model !== EXPECTED_MODEL)
      throw new InferenceError("model_drift");
    return publication;
  } catch (error) {
    // An uncertain request may have been billed: charge its reservation conservatively.
    if (budgetDay)
      await pool.query(
        "update market_matching_budget set reserved_usd=greatest(0,reserved_usd-$2),spent_usd=spent_usd+$2,lazy_reserved_usd=greatest(0,lazy_reserved_usd-case when $3 then $2::numeric else 0 end),lazy_spent_usd=lazy_spent_usd+case when $3 then $2::numeric else 0 end where budget_day=$1::date",
        [budgetDay, reserve, lazy],
      );
    const typed = error instanceof InferenceError ? error : null;
    const retry = typed?.retryable && job.attempts < matching.attempts;
    await pool.query(
      `update market_matching_jobs set status=$3,last_error=$4,lease_token=null,lease_until=null,next_attempt_at=now()+($5::double precision*interval '1 millisecond') where id=$1 and lease_token=$2`,
      [
        job.id,
        job.lease_token,
        retry ? "queued" : "error",
        typed?.code ?? "worker_error",
        Math.max(typed?.retryAfterMs ?? 0, 1000 * 2 ** job.attempts),
      ],
    );
    if (
      typed?.code === "model_drift" ||
      typed?.code === "cost_drift" ||
      typed?.code === "missing_openrouter_key" ||
      typed?.code === "http_401" ||
      typed?.code === "http_402" ||
      typed?.code === "http_403"
    )
      throw error;
    return retry ? "retry" : "error";
  }
}
async function finish(db: Pick<Pool, "query">, job: Job, status: string) {
  await db.query(
    "update market_matching_jobs set status=$3,lease_token=null,lease_until=null where id=$1 and lease_token=$2",
    [job.id, job.lease_token, status],
  );
}
export type { JevResult };
