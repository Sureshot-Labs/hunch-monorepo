import type { DbQuery } from "../db.js";
import {
  agentInterests,
  type AgentAuthor,
  type AgentThesesPolicy,
} from "./agent-theses-policy.js";
import { AGENT_THESES_PREFIX, type AgentRedis } from "./agent-theses-state.js";
import {
  loadAgentCandidates,
  loadAgentMarketPool,
  selectAgentShortlist,
  enrichAgentSelectedContext,
  type AgentCandidate,
} from "./agent-theses-context.js";
import { recentAgentTheses } from "./agent-theses-publish.js";
import {
  agentProvenance,
  selectAgentCandidate,
  writeAgentThesis,
  type AgentHistory,
  type AgentModelClient,
} from "./agent-theses-model.js";
import {
  retrieveAgentInterests,
  type AgentInterestEmbedder,
} from "./agent-theses-retrieval.js";

export function agentFailureCode(error: unknown): string {
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

export async function loadAgentResearchContext(input: {
  db: DbQuery;
  redis: AgentRedis;
  maxMarkets: number;
  userId: string;
  maxQuoteAgeSeconds: number;
  limitlessPositionContract?: string;
  now?: Date;
  authors?: Pick<AgentAuthor, "userId" | "interests">[];
  embed?: AgentInterestEmbedder;
  assertLease?: () => Promise<void>;
}) {
  const retrieval = await retrieveAgentInterests({
    redis: input.redis,
    authors: input.authors ?? [],
    maximum: input.maxMarkets,
    embed: input.embed,
    assertLease: input.assertLease ?? (async () => {}),
  });
  const pool = await loadAgentMarketPool(
    input.db,
    input.redis,
    input.maxMarkets,
    input.userId,
    retrieval.marketIds,
  );
  const context = await loadAgentCandidates({
    ...input,
    marketIds: pool.marketIds,
  });
  pool.diagnostics.push(...retrieval.diagnostics);
  return { pool, context, retrieval };
}

/** Shared single-author pass. Only the scheduled runner supplies progress mutations. */
export async function researchAgent(input: {
  db: DbQuery;
  redis: AgentRedis;
  author: AgentAuthor;
  policy: AgentThesesPolicy;
  revision: string;
  candidates: AgentCandidate[];
  freshMarketIds: string[];
  semanticMarketIds?: string[];
  model: AgentModelClient;
  now: () => Date;
  report: Record<string, unknown>;
  recent?: Awaited<ReturnType<typeof recentAgentTheses>>;
  assertLease: () => Promise<void>;
  onConsidered: (marketIds: string[]) => Promise<void>;
  onProgress: () => Promise<void>;
  onDraft?: (draft: {
    candidate: AgentCandidate;
    decision: Extract<
      Awaited<ReturnType<typeof writeAgentThesis>>,
      { decision: "publish" }
    >;
  }) => Promise<void>;
  onDraftText?: (body: string) => Promise<void>;
}) {
  const {
    db,
    redis,
    author,
    policy,
    revision,
    model,
    now,
    report: authorReport,
  } = input;
  const recent = input.recent ?? (await recentAgentTheses(db, author.userId));
  await input.assertLease();
  const eligible = input.candidates;
  const scores = eligible.length
    ? await redis.zmScore(
        `${AGENT_THESES_PREFIX}:considered:${author.userId}`,
        eligible.map((c) => c.marketId),
      )
    : [];
  const shortlist = selectAgentShortlist(
    eligible,
    input.freshMarketIds,
    scores,
    policy.candidatesPerAuthor,
    agentInterests(author),
    input.semanticMarketIds,
  );
  authorReport.candidates = shortlist.map((c) => c.marketId);
  authorReport.shortlist = shortlist.map((c) => {
    const rank = input.semanticMarketIds?.indexOf(c.marketId) ?? -1;
    return {
      marketId: c.marketId,
      title: c.title,
      eventTitle: c.eventTitle,
      category: c.category,
      semanticRank: rank < 0 ? null : rank + 1,
    };
  });
  if (!shortlist.length) {
    authorReport.status = "no_candidates";
    await input.onConsidered(shortlist.map((c) => c.marketId));
    return null;
  }
  // Exact-contract last views can be older than the short recent-post history.
  const exact = await db.query(
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
        new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
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
    await input.onProgress();
    const choice = await selectAgentCandidate({
      model,
      author,
      candidates: shortlist,
      history,
      policy,
      now: now(),
    });

    await input.onConsidered(shortlist.map((c) => c.marketId));
    authorReport.jev = choice.decision;
    if (!choice.candidate) {
      authorReport.status = "jev_none";
      return null;
    }
    selected = [choice.candidate];
    authorReport.selection = {
      marketId: choice.candidate.marketId,
      title: choice.candidate.title,
      eventTitle: choice.candidate.eventTitle,
      condition: choice.candidate.condition,
    };
    if (!choice.angle) throw new Error("agent_invalid_selection");
    angle = choice.angle;
  } catch (error) {
    const code = agentFailureCode(error);
    if (["agent_budget_exhausted", "agent_lease_lost"].includes(code))
      throw error;

    await input.onConsidered(shortlist.map((c) => c.marketId));
    authorReport.jevFallback = code;
  }
  await input.assertLease();
  authorReport.angle = angle;
  const enriched = await enrichAgentSelectedContext({
    db,
    redis,
    candidates: selected,
    now: now(),
  });
  selected = enriched.candidates;
  authorReport.contextDiagnostics = enriched.diagnostics;
  authorReport.enrichedSources = selected.map((c) => ({
    marketId: c.marketId,
    sources: c.sources.length,
  }));
  await input.assertLease();
  authorReport.stage = "writing";
  await input.onProgress();
  const decision = await writeAgentThesis({
    model,
    author,
    candidates: selected,
    history,
    angle,
    policy,
    now: now(),
    onDraft: async (decision) => {
      // Only supplied markets can be displayed; source URLs always come from context.
      const candidate = selected.find((c) => c.marketId === decision.marketId);
      if (candidate) await input.onDraft?.({ candidate, decision });
    },
    onDraftText: input.onDraftText,
  });
  authorReport.writer = decision;
  if (decision.decision === "skip") {
    authorReport.status = "writer_skip";
    return null;
  }
  const candidate = selected.find((c) => c.marketId === decision.marketId);
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

  return { candidate, side, decision, provenance };
}
