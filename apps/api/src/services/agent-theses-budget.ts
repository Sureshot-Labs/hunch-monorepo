import { AGENT_PREVIEW_PREFIX, type AgentRedis } from "./agent-theses-state.js";
import type { AgentPreview } from "../schemas/agent-preview.js";

/** Atomic, read-only view of the same rolling-window ledger used by reservations. */
export async function readAgentPreviewBudget(
  redis: AgentRedis,
  limitUsd: number,
  runId?: string,
) {
  const rows = (await redis.eval(
    `
    local tm=redis.call('TIME')
    local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
    local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'('..(now-86400000),'+inf')
    local result={}
    for _,id in ipairs(ids) do
      table.insert(result,{id,redis.call('HGET',KEYS[2],id) or '0',redis.call('HGET',KEYS[3],id) or '{}'})
    end
    return result`,
    {
      keys: [
        `${AGENT_PREVIEW_PREFIX}:calls`,
        `${AGENT_PREVIEW_PREFIX}:costs`,
        `${AGENT_PREVIEW_PREFIX}:call_details`,
      ],
      arguments: [],
    },
  )) as string[][];
  let actualUsd = 0,
    reservedUsd = 0;
  const calls: AgentPreview["calls"] = [];
  for (const [callId, rawCost, rawDetail] of rows) {
    const detail = JSON.parse(rawDetail) as {
      actualUsd?: number;
      stage?: string;
      model?: string;
    };
    const cost = Number(rawCost) / 1e10;
    if (detail.actualUsd === undefined) reservedUsd += cost;
    else actualUsd += cost;
    if (runId && callId.startsWith(`${runId}:`))
      calls.push({
        callId,
        stage: detail.stage ?? "unknown",
        model: detail.model ?? null,
        actualUsd: detail.actualUsd === undefined ? null : cost,
        reservedUsd: detail.actualUsd === undefined ? cost : 0,
      });
  }
  return {
    budget: {
      limitUsd,
      actualUsd,
      reservedUsd,
      remainingUsd: Math.max(0, limitUsd - actualUsd - reservedUsd),
    },
    calls,
  };
}
