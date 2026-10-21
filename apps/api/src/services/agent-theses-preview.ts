import type { Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  agentPreviewSchema,
  type AgentPreview,
  type AgentPreviewInput,
} from "../schemas/agent-preview.js";
import { resolveAgentThesesPolicy } from "./agent-theses-policy.js";
import { resolveSocialPolicy } from "./social-policy.js";
import {
  AgentRunState,
  AGENT_PREVIEW_PREFIX,
  type AgentRedis,
} from "./agent-theses-state.js";
import { readAgentPreviewBudget } from "./agent-theses-budget.js";
import { createAgentModelClient } from "./agent-theses-model.js";
import { createAgentInterestEmbedder } from "./agent-theses-retrieval.js";
import {
  agentFailureCode,
  loadAgentResearchContext,
  researchAgent,
} from "./agent-theses-research.js";
import { evaluateAgentPaperEntry } from "./agent-theses-publish.js";
import { socialFingerprint, SocialError } from "./social-primitives.js";

const RESULT_TTL_SECONDS = 86400;
type StoredPreview = AgentPreview & { requestHash: string };
const runKey = (id: string) => `${AGENT_PREVIEW_PREFIX}:run:${id}`;

/** Every SQL query is read-only and bounded; no connection lives across model calls. */
export function agentPreviewReadOnlyDb(pool: Pool): DbQuery {
  return {
    query: (async (sql: string, values?: unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query("begin read only");
        await client.query("set local statement_timeout='15s'");
        await client.query("set local lock_timeout='2s'");
        const result = await client.query(sql, values);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }) as DbQuery["query"],
  };
}

export class AgentPreviewService {
  private readonly running = new Map<
    string,
    { abort: AbortController; task: Promise<void> }
  >();
  private closing = false;
  private readonly db: DbQuery;
  constructor(
    private readonly deps: {
      db: Pool;
      redis: () => Promise<AgentRedis>;
      apiKey: string;
      limitlessPositionContract?: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.db = agentPreviewReadOnlyDb(deps.db);
  }

  async budget() {
    const { policy } = await resolveAgentThesesPolicy(this.db);
    return (
      await readAgentPreviewBudget(
        await this.deps.redis(),
        policy.previewDayBudgetUsd,
      )
    ).budget;
  }

  async read(runId: string): Promise<AgentPreview> {
    const redis = await this.deps.redis();
    let raw = await redis.get(runKey(runId));
    if (!raw) throw new SocialError("preview_not_found", 404);
    const observed = JSON.parse(raw) as StoredPreview;
    if (observed.status === "running") {
      const interrupted = JSON.stringify({
        ...observed,
        status: "interrupted",
        stage: "finished",
        reason: "preview_interrupted",
        completedAt: new Date().toISOString(),
      });
      // CAS preserves empty JSON arrays and any concurrent progress/final result.
      raw = String(
        await redis.eval(
          `
        local current=redis.call('GET',KEYS[1]); if not current then return '' end
        if current==ARGV[2] and redis.call('GET',KEYS[2])~=ARGV[1] then
          redis.call('SET',KEYS[1],ARGV[3],'KEEPTTL'); return ARGV[3]
        end
        return current`,
          {
            keys: [runKey(runId), `${AGENT_PREVIEW_PREFIX}:lock`],
            arguments: [runId, raw, interrupted],
          },
        ),
      );
      if (!raw) throw new SocialError("preview_not_found", 404);
    }
    const stored = JSON.parse(String(raw)) as StoredPreview;
    const { policy } = await resolveAgentThesesPolicy(this.db);
    const accounting = await readAgentPreviewBudget(
      redis,
      policy.previewDayBudgetUsd,
      runId,
    );
    // Ledger is authoritative even if the process died before recording a provider response.
    stored.budget = accounting.budget;
    stored.calls = accounting.calls;
    stored.cost = {
      actualUsd: accounting.calls.reduce((n, c) => n + (c.actualUsd ?? 0), 0),
      reservedUsd: accounting.calls.reduce((n, c) => n + c.reservedUsd, 0),
    };
    return agentPreviewSchema.parse(stored);
  }

  async start(
    adminId: string,
    userId: string,
    input: AgentPreviewInput,
  ): Promise<AgentPreview> {
    if (this.closing) throw new SocialError("preview_unavailable", 503);
    const redis = await this.deps.redis();
    const runId = socialFingerprint({ adminId, requestId: input.requestId });
    const requestHash = socialFingerprint({ userId, settings: input.settings });
    const replay = async () => {
      const raw = await redis.get(runKey(runId));
      if (!raw) return null;
      if ((JSON.parse(raw) as StoredPreview).requestHash !== requestHash)
        throw new SocialError("preview_request_conflict", 409);
      return this.read(runId);
    };
    const existing = await replay();
    if (existing) return existing;
    const { policy, revision } = await resolveAgentThesesPolicy(this.db);
    const saved = policy.authors.find((a) => a.userId === userId);
    if (!saved) throw new SocialError("agent_unavailable", 404);
    const users = await this.db.query(
      "select id from users where id=$1 and is_agent and is_active and social_suspended_at is null",
      [userId],
    );
    if (!users.rows.length) throw new SocialError("agent_unavailable", 403);
    if (!this.deps.apiKey) throw new SocialError("model_key_unavailable", 503);
    const budget = (
      await readAgentPreviewBudget(redis, policy.previewDayBudgetUsd)
    ).budget;
    if (budget.remainingUsd <= 0)
      throw new SocialError("agent_budget_exhausted", 409);
    const report: StoredPreview = {
      runId,
      userId,
      requestHash,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: "running",
      stage: "loading",
      reason: null,
      diagnostics: [],
      models: { jev: policy.jevModel, writer: policy.writerModel },
      candidateCount: 0,
      shortlistCount: 0,
      selection: null,
      angle: null,
      result: null,
      draftText: null,
      calls: [],
      cost: { actualUsd: 0, reservedUsd: 0 },
      budget,
    };
    const state = new AgentRunState(redis, runId, AGENT_PREVIEW_PREFIX);
    if (
      !(await state.acquire({
        key: runKey(runId),
        value: JSON.stringify(report),
        ttlSeconds: RESULT_TTL_SECONDS,
      }))
    ) {
      const repeated = await replay();
      if (repeated) return repeated;
      throw new SocialError("preview_busy", 409);
    }
    const abort = new AbortController();
    const task = this.execute({
      state,
      report,
      policy,
      revision,
      author: { ...saved, ...input.settings },
      abort,
    })
      .catch(() => {
        /* Results and sanitized errors are persisted by execute; never log prompts/keys. */
      })
      .finally(() => this.running.delete(runId));
    this.running.set(runId, { abort, task });
    return agentPreviewSchema.parse(report);
  }

  private async execute(input: {
    state: AgentRunState;
    report: StoredPreview;
    policy: Awaited<ReturnType<typeof resolveAgentThesesPolicy>>["policy"];
    revision: string;
    author: Awaited<
      ReturnType<typeof resolveAgentThesesPolicy>
    >["policy"]["authors"][number];
    abort: AbortController;
  }) {
    const { state, report, policy, revision, author, abort } = input;
    const deadline = setTimeout(() => abort.abort(), 300000);
    deadline.unref();
    const authorReport: Record<string, unknown> = {};
    const persist = async () => {
      const saved = Number(
        await state.redis.eval(
          `
        if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
        if redis.call('EXISTS',KEYS[2])==0 then return 0 end
        redis.call('SET',KEYS[2],ARGV[2],'KEEPTTL'); return 1`,
          {
            keys: [state.key("lock"), runKey(state.runId)],
            arguments: [state.runId, JSON.stringify(report)],
          },
        ),
      );
      if (saved !== 1) throw new Error("agent_lease_lost");
    };
    const assertLease = async () => {
      if (abort.signal.aborted) throw new Error("preview_interrupted");
      await state.assertLease();
    };
    const accounting = {
      apiKey: this.deps.apiKey,
      runId: state.runId,
      fetchImpl: this.deps.fetchImpl,
      signal: abort.signal,
      reserve: async (
        id: string,
        amount: number,
        metadata: Record<string, unknown>,
      ) => {
        await assertLease();
        const saved = await resolveAgentThesesPolicy(this.db);
        await state.reserve(
          id,
          amount,
          saved.policy.previewDayBudgetUsd,
          metadata,
        );
      },
      settle: (id: string, amount: number | null) => state.settle(id, amount),
      record: async () => {
        await persist();
      },
    };
    const model = createAgentModelClient(accounting);
    const embed = createAgentInterestEmbedder(accounting);
    try {
      const social = await resolveSocialPolicy(this.db);
      const { pool, context, retrieval } = await loadAgentResearchContext({
        db: this.db,
        redis: state.redis,
        maxMarkets: policy.maxMarkets,
        userId: author.userId,
        maxQuoteAgeSeconds: social.policy.markMaxAgeSeconds,
        limitlessPositionContract: this.deps.limitlessPositionContract,
        authors: [author],
        embed,
        assertLease,
      });
      report.diagnostics.push(...pool.diagnostics, ...context.diagnostics);
      report.diagnostics.push(
        `interest_retrieval:cache_hits=${retrieval.stats.cacheHits},generated=${retrieval.stats.generated},markets=${retrieval.marketIds.length},duration_ms=${retrieval.stats.durationMs}`,
      );
      report.candidateCount = context.candidates.length;
      report.retrieval = {
        poolCount: pool.marketIds.length,
        semanticPoolCount: retrieval.marketIds.length,
        cacheHits: retrieval.stats.cacheHits,
        generated: retrieval.stats.generated,
        durationMs: retrieval.stats.durationMs,
      };
      const researched = await researchAgent({
        db: this.db,
        redis: state.redis,
        author,
        policy,
        revision,
        model,
        now: () => new Date(),
        report: authorReport,
        candidates: context.candidates,
        freshMarketIds: pool.freshMarketIds,
        semanticMarketIds: retrieval.byAuthor[author.userId],
        assertLease,
        onConsidered: async () => {},
        onDraftText: async (body) => {
          report.draftText = body;
          await assertLease();
          await persist();
        },
        onDraft: async ({ candidate, decision }) => {
          const side = candidate.sides.find(
            (s) => s.instrument.outcome === decision.outcome,
          );
          if (!side) return;
          report.stage = "validation";
          report.selection = {
            marketId: candidate.marketId,
            title: candidate.title,
            eventTitle: candidate.eventTitle,
            condition: candidate.condition,
          };
          report.result = {
            market: report.selection,
            outcome: decision.outcome,
            outcomeLabel: side.label,
            body: decision.body,
            counterargument: decision.counterargument,
            changeReason: decision.changeReason,
            maxEntryPrice: decision.maxEntryPrice,
            sources: candidate.sources.filter((s) =>
              decision.sourceIds.includes(s.id),
            ),
            observedAsk: side.ask,
            quoteAsOf: side.quoteAsOf,
            simulation: null,
            validationReason: null,
          };
          await assertLease();
          await persist();
        },
        onProgress: async () => {
          report.stage = authorReport.stage as "selection" | "writing";
          report.shortlistCount =
            (authorReport.candidates as unknown[] | undefined)?.length ?? 0;
          report.shortlist =
            authorReport.shortlist as AgentPreview["shortlist"];
          report.writerCandidates =
            authorReport.writerCandidates as AgentPreview["writerCandidates"];
          report.screening =
            authorReport.screening as AgentPreview["screening"];
          if (typeof authorReport.screeningFallback === "string") {
            const diagnostic = `screening_fallback:${authorReport.screeningFallback}`;
            if (!report.diagnostics.includes(diagnostic))
              report.diagnostics.push(diagnostic);
          }
          report.selection =
            (authorReport.selection as AgentPreview["selection"]) ?? null;
          report.angle =
            typeof authorReport.angle === "string" ? authorReport.angle : null;
          if (typeof authorReport.jevFallback === "string")
            report.diagnostics.push(`jev_fallback:${authorReport.jevFallback}`);
          if (Array.isArray(authorReport.contextDiagnostics))
            report.diagnostics.push(
              ...(authorReport.contextDiagnostics as string[]),
            );
          await assertLease();
          await persist();
        },
      });
      if (!researched) {
        report.reason = String(authorReport.status ?? "no_candidates");
        const writer = authorReport.writer as { reason?: string } | undefined;
        if (writer?.reason) {
          report.reasonDetail = writer.reason;
          report.diagnostics.push(writer.reason);
        }
      } else {
        const { candidate, side, decision, provenance } = researched;
        report.stage = "validation";
        report.selection = {
          marketId: candidate.marketId,
          title: candidate.title,
          eventTitle: candidate.eventTitle,
          condition: candidate.condition,
        };
        report.result = {
          market: report.selection,
          outcome: decision.outcome,
          outcomeLabel: side.label,
          body: decision.body,
          counterargument: decision.counterargument,
          changeReason: decision.changeReason,
          maxEntryPrice: decision.maxEntryPrice,
          sources: provenance.sources,
          observedAsk: side.ask,
          quoteAsOf: side.quoteAsOf,
          simulation: null,
          validationReason: null,
        };
        await assertLease();
        await persist();
        try {
          const evaluated = await evaluateAgentPaperEntry(this.db, {
            userId: author.userId,
            body: decision.body,
            instrument: side.instrument,
            maxEntryPrice: decision.maxEntryPrice,
            provenance,
            maxThesisGraphemes: author.maxThesisGraphemes,
            paperAmountUsd: author.paperAmountUsd,
            maxQuoteAgeSeconds: social.policy.markMaxAgeSeconds,
            limitlessPositionContract: this.deps.limitlessPositionContract,
          });
          report.result.simulation = {
            amountUsd: author.paperAmountUsd,
            shares: evaluated.shares,
            entryPrice: evaluated.quote.ask,
            quoteAsOf: evaluated.quote.asOf,
          };
        } catch (error) {
          report.result.validationReason = agentFailureCode(error);
          report.reason = report.result.validationReason;
        }
      }
      await assertLease();
      report.status = "complete";
    } catch (error) {
      report.reason = abort.signal.aborted
        ? "preview_interrupted"
        : agentFailureCode(error);
      if (report.result) report.result.validationReason = report.reason;
      report.status = ["preview_interrupted", "agent_lease_lost"].includes(
        report.reason,
      )
        ? "interrupted"
        : "failed";
    } finally {
      clearTimeout(deadline);
      report.stage = "finished";
      report.completedAt = new Date().toISOString();
      try {
        await persist();
      } finally {
        await state.close();
      }
    }
  }

  async close() {
    this.closing = true;
    for (const run of this.running.values()) run.abort.abort();
    await Promise.allSettled([...this.running.values()].map((run) => run.task));
  }
}
