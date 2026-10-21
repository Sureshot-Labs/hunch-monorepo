import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import {
  agentInterests,
  resolveAgentThesesPolicy,
} from "./agent-theses-policy.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  AgentRunState,
  AGENT_THESES_PREFIX,
  type AgentRedis,
} from "./agent-theses-state.js";
import {
  loadAgentCandidates,
  loadAgentMarketPool,
  selectAgentShortlist,
} from "./agent-theses-context.js";
import {
  recentAgentTheses,
  publishAgentThesis,
} from "./agent-theses-publish.js";
import {
  agentProvenance,
  createAgentModelClient,
  selectAgentCandidate,
  writeAgentThesis,
  type AgentHistory,
  type AgentModelClient,
} from "./agent-theses-model.js";

function failureCode(error: unknown): string {
  // Never persist full provider/network errors (may include credentials or request bodies).
  const message = error instanceof Error ? error.message : "unknown_error";
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code)
  )
    return `database_${error.code}`;
  return /^[a-z][a-z0-9_:]{0,100}$/.test(message)
    ? message
    : "invalid_response_or_dependency_error";
}
/** Least-recent ownership is fair even when peers are ready at different cadences. */
export function agentPoolOwnerIndex(
  ready: number[],
  lastOwned: Array<number | null>,
): number {
  return (
    ready
      .map((index, position) => ({ index, turn: lastOwned[position] ?? 0 }))
      .sort((a, b) => a.turn - b.turn || a.index - b.index)[0]?.index ?? -1
  );
}
export async function runAgentTheses(input: {
  db: Pool;
  redis: AgentRedis;
  apiKey: string;
  limitlessPositionContract?: string;
  model?: AgentModelClient;
  now?: () => Date;
}) {
  const { policy, revision } = await resolveAgentThesesPolicy(input.db);
  if (!policy.enabled) return { status: "disabled" };
  const social = await resolveSocialPolicy(input.db);
  if (!social.policy.enabled || !social.policy.publicationsEnabled)
    return { status: "social_disabled" };
  if (!input.apiKey && !input.model) return { status: "model_key_unavailable" };
  const state = new AgentRunState(input.redis, randomUUID());
  if (!(await state.acquire())) return { status: "lock_held" };
  const now = input.now ?? (() => new Date());
  const report: {
    runId: string;
    policyRevision: string;
    startedAt: string;
    completedAt?: string;
    status: string;
    diagnostics: string[];
    candidates: string[];
    calls: Record<string, unknown>[];
    authors: Record<string, unknown>[];
  } = {
    runId: state.runId,
    policyRevision: revision,
    startedAt: now().toISOString(),
    status: "running",
    diagnostics: [],
    candidates: [],
    calls: [],
    authors: [],
  };
  const model =
    input.model ??
    createAgentModelClient({
      apiKey: input.apiKey,
      runId: state.runId,
      reserve: (id, amount, metadata) =>
        state.reserve(id, amount, policy.dayBudgetUsd, metadata),
      settle: (id, amount) => state.settle(id, amount),
      record: (record) => {
        report.calls.push(record);
      },
    });
  try {
    await state.record(report);
    const ready: Array<{
      index: number;
      author: (typeof policy.authors)[number] & { userId: string };
      authorReport: Record<string, unknown>;
      recent: Awaited<ReturnType<typeof recentAgentTheses>>;
    }> = [];
    for (const [index, author] of policy.authors.entries()) {
      if (!author.enabled || !author.userId) continue;
      const authorReport: Record<string, unknown> = {
        userId: author.userId,
        stage: "history",
        status: "not_attempted",
      };
      report.authors.push(authorReport);
      try {
        await state.assertLease();
        const users = await input.db.query(
          `select id from users where id=$1 and is_agent and is_active and social_suspended_at is null`,
          [author.userId],
        );
        if (!users.rows.length) {
          authorReport.status = "agent_unavailable";
          continue;
        }
        const recent = await recentAgentTheses(input.db, author.userId);
        if (
          recent[0] &&
          now().getTime() - new Date(recent[0].published_at).getTime() <
            policy.publishIntervalSeconds * 1000
        ) {
          authorReport.status = "publication_cooldown";
          continue;
        }
        ready.push({
          index,
          author: { ...author, userId: author.userId },
          authorReport,
          recent,
        });
      } catch (error) {
        authorReport.status = failureCode(error);
        if (authorReport.status === "agent_lease_lost") throw error;
      }
    }
    if (!ready.length) {
      report.status = "complete";
      return report;
    }
    const lastOwned = await input.redis.hmGet(
      `${AGENT_THESES_PREFIX}:pool_owners`,
      ready.map((row) => row.author.userId),
    );
    const ownerIndex = agentPoolOwnerIndex(
      ready.map((row) => row.index),
      lastOwned.map((value) => {
        const turn = Number(value);
        return Number.isSafeInteger(turn) && turn >= 0 ? turn : null;
      }),
    );
    const owner = ready.find((row) => row.index === ownerIndex) ?? ready[0];
    const pool = await loadAgentMarketPool(
      input.db,
      input.redis,
      policy.maxMarkets,
      owner.author.userId,
    );
    report.diagnostics.push(...pool.diagnostics);
    const context = await loadAgentCandidates({
      ...input,
      marketIds: pool.marketIds,
      maxQuoteAgeSeconds: social.policy.markMaxAgeSeconds,
      now: input.now?.(),
    });
    report.diagnostics.push(...context.diagnostics);
    report.candidates = context.candidates.map((c) => c.marketId);
    owner.authorReport.poolOwner = true;
    // One shared bounded/hydrated pool, independent progress per author.
    // Process its owner first so budget exhaustion cannot consume their unseen page.
    const ordered = [owner, ...ready.filter((row) => row !== owner)];
    let cursorSaved = false;
    const consumePool = async (userId: string) => {
      if (cursorSaved || userId !== owner.author.userId) return;
      await state.saveCursor(pool.cursor, userId);
      cursorSaved = true;
    };
    for (const { author, authorReport, recent } of ordered) {
      try {
        await state.assertLease();
        const eligible = context.candidates;
        const scores = eligible.length
          ? await input.redis.zmScore(
              `${AGENT_THESES_PREFIX}:considered:${author.userId}`,
              eligible.map((c) => c.marketId),
            )
          : [];
        const shortlist = selectAgentShortlist(
          eligible,
          pool.freshMarketIds,
          scores,
          policy.candidatesPerAuthor,
          agentInterests(author),
        );
        authorReport.candidates = shortlist.map((c) => c.marketId);
        if (!shortlist.length) {
          authorReport.status = "no_candidates";
          await consumePool(author.userId);
          continue;
        }
        // Exact-contract last views can be older than the short recent-post history.
        const exact = await input.db.query(
          `select distinct on (market_id) id,market_id,outcome,body,published_at,buy_snapshot
           from user_theses where author_id=$1 and market_id=any($2::text[])
           order by market_id,published_at desc,id desc`,
          [author.userId, shortlist.map((c) => c.marketId)],
        );
        const history: AgentHistory = [
          ...new Map([...exact.rows, ...recent].map((h) => [h.id, h])).values(),
        ]
          .sort(
            (a, b) =>
              new Date(b.published_at).getTime() -
              new Date(a.published_at).getTime(),
          )
          .map((h) => ({
            id: h.id,
            marketId: h.market_id,
            side: h.outcome,
            body: h.body,
            publishedAt: new Date(h.published_at).toISOString(),
            argumentKey: h.buy_snapshot?.provenance?.argumentKey ?? null,
          }));
        let selected = shortlist.slice(0, 3);
        let angle =
          "Choose the strongest distinct, supported analytical question from this shortlist.";
        try {
          authorReport.stage = "selection";
          const choice = await selectAgentCandidate({
            model,
            author,
            candidates: shortlist,
            history,
            policy,
            now: now(),
          });
          await state.considered(
            author.userId,
            shortlist.map((c) => c.marketId),
          );
          await consumePool(author.userId);
          authorReport.jev = choice.decision;
          if (!choice.candidate) {
            authorReport.status = "jev_none";
            continue;
          }
          selected = [choice.candidate];
          if (!choice.angle) throw new Error("agent_invalid_selection");
          angle = choice.angle;
        } catch (error) {
          const code = failureCode(error);
          if (["agent_budget_exhausted", "agent_lease_lost"].includes(code))
            throw error;
          await state.considered(
            author.userId,
            shortlist.map((c) => c.marketId),
          );
          await consumePool(author.userId);
          authorReport.jevFallback = code;
        }
        await state.assertLease();
        authorReport.stage = "writing";
        const decision = await writeAgentThesis({
          model,
          author,
          candidates: selected,
          history,
          angle,
          policy,
          now: now(),
        });
        authorReport.writer = decision;
        if (decision.decision === "skip") {
          authorReport.status = "writer_skip";
          continue;
        }
        const candidate = selected.find(
          (c) => c.marketId === decision.marketId,
        );
        const side = candidate?.sides.find(
          (s) => s.instrument.outcome === decision.outcome,
        );
        if (!candidate || !side) throw new Error("agent_invalid_selection");
        const provenance = agentProvenance({
          decision,
          candidate,
          previous: history.find((h) => h.marketId === candidate.marketId),
          revision,
          model: policy.writerModel,
          angle,
        });
        authorReport.stage = "publication";
        const created = await publishAgentThesis({
          db: input.db,
          userId: author.userId,
          idempotencyKey: state.runId,
          body: decision.body,
          instrument: side.instrument,
          maxEntryPrice: decision.maxEntryPrice,
          provenance,
          assertLease: () => state.assertLease(),
          limitlessPositionContract: input.limitlessPositionContract,
        });
        authorReport.status = created.replayed ? "replayed" : "published";
        authorReport.thesisId = created.id;
      } catch (error) {
        const code = failureCode(error);
        authorReport.status = code;
        if (["agent_budget_exhausted", "agent_lease_lost"].includes(code)) {
          report.status = code;
          break;
        }
      } finally {
        await state.record(report);
      }
    }
    if (report.status === "running") report.status = "complete";
  } catch (error) {
    report.status = failureCode(error);
  } finally {
    report.completedAt = now().toISOString();
    try {
      await state.record(report);
    } finally {
      await state.close();
    }
  }
  return report;
}
