import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { resolveAgentThesesPolicy } from "./agent-theses-policy.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  AgentRunState,
  AGENT_THESES_PREFIX,
  type AgentRedis,
} from "./agent-theses-state.js";
import {
  recentAgentTheses,
  publishAgentThesis,
} from "./agent-theses-publish.js";
import {
  createAgentModelClient,
  type AgentModelClient,
} from "./agent-theses-model.js";
import {
  researchAgent,
  loadAgentResearchContext,
  agentFailureCode as failureCode,
} from "./agent-theses-research.js";
import {
  createAgentInterestEmbedder,
  type AgentInterestEmbedder,
} from "./agent-theses-retrieval.js";

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
  embed?: AgentInterestEmbedder;
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
  const embed =
    input.embed ??
    (!input.model && input.apiKey
      ? createAgentInterestEmbedder({
          apiKey: input.apiKey,
          runId: state.runId,
          reserve: (id, amount, metadata) =>
            state.reserve(id, amount, policy.dayBudgetUsd, metadata),
          settle: (id, amount) => state.settle(id, amount),
          record: (record) => {
            report.calls.push(record);
          },
        })
      : undefined);
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
    const ordered = [owner, ...ready.filter((row) => row !== owner)];
    const { pool, context, retrieval } = await loadAgentResearchContext({
      ...input,
      userId: owner.author.userId,
      maxMarkets: policy.maxMarkets,
      maxQuoteAgeSeconds: social.policy.markMaxAgeSeconds,
      now: input.now?.(),
      authors: ordered.map((row) => row.author),
      embed,
      assertLease: () => state.assertLease(),
    });
    owner.authorReport.retrieval = retrieval.stats;
    report.diagnostics.push(...pool.diagnostics);
    report.diagnostics.push(...context.diagnostics);
    report.candidates = context.candidates.map((c) => c.marketId);
    owner.authorReport.poolOwner = true;
    // One shared bounded/hydrated pool, independent progress per author.
    // Process its owner first so budget exhaustion cannot consume their unseen page.
    let cursorSaved = false;
    const consumePool = async (userId: string) => {
      if (cursorSaved || userId !== owner.author.userId) return;
      await state.saveCursor(pool.cursor, userId);
      cursorSaved = true;
    };
    for (const { author, authorReport, recent } of ordered) {
      try {
        await state.assertLease();
        const result = await researchAgent({
          ...input,
          author,
          policy,
          revision,
          model,
          now,
          report: authorReport,
          recent,
          candidates: context.candidates,
          freshMarketIds: pool.freshMarketIds,
          semanticMarketIds: retrieval.byAuthor[author.userId],
          assertLease: () => state.assertLease(),
          onConsidered: async (ids) => {
            if (ids.length) await state.considered(author.userId, ids);
            await consumePool(author.userId);
          },
          onProgress: () => state.record(report),
        });
        if (!result) continue;
        const { decision, side, provenance } = result;
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
