import { createHash } from "node:crypto";
import type { DbQuery } from "../db.js";
import type { SignalBotFollowthroughCandidateRow } from "./signal-bot-contracts.js";
import type { SignalBotFollowthroughPolicy } from "./signal-bot-followthrough-policy.js";
import { buildWalletIntelAcceptingOrdersSql } from "./wallet-intel-market-eligibility.js";

export type FollowthroughLane = "terminal" | "stats";
export type FollowthroughCursor = { sentAt: string; id: string };
export type FollowthroughScanRow = SignalBotFollowthroughCandidateRow & {
  initial_id: string;
  initial_sent_at: string;
  eligible: boolean;
};
export const FOLLOWTHROUGH_SOURCE_PAGE_SIZE = 100;

export function followthroughCursorKey(input: {
  lane: FollowthroughLane;
  chatIds: string[];
  policy: SignalBotFollowthroughPolicy;
}): string {
  // Model/prompt changes must not restart a delivery sweep.
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        [...new Set(input.chatIds)].sort(),
        [...input.policy.types].sort(),
        input.policy.terminalInitialCutoff,
        input.policy.minAgeHours,
      ]),
    )
    .digest("hex")
    .slice(0, 20);
  return `tg:signal_bot:v1:followthrough_scan:${input.lane}:${scope}`;
}

export function parseFollowthroughCursor(
  raw: string | null,
): FollowthroughCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as FollowthroughCursor;
    return typeof value.sentAt === "string" &&
      Number.isFinite(Date.parse(value.sentAt)) &&
      typeof value.id === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Page initial deliveries BEFORE joining/filtering their markets. A skipped
 * outcome still returns its cursor, so it cannot starve later deliveries. */
export function buildFollowthroughPageQuery(input: {
  lane: FollowthroughLane;
  chatIds: string[];
  policy: SignalBotFollowthroughPolicy;
  cursor: FollowthroughCursor | null;
  now: Date;
  preview: boolean;
  retryCooldownMs: number;
  editorialProfile: string;
}): { sql: string; params: unknown[] } {
  const terminal = input.lane === "terminal";
  const acceptingSql = buildWalletIntelAcceptingOrdersSql({
    eventAlias: "e",
    marketAlias: "m",
  });
  const params: unknown[] = [
    input.chatIds,
    terminal ? input.policy.terminalInitialCutoff : null,
    terminal
      ? input.now.toISOString()
      : new Date(
          input.now.getTime() - input.policy.minAgeHours * 3_600_000,
        ).toISOString(),
    FOLLOWTHROUGH_SOURCE_PAGE_SIZE,
    input.preview,
    new Date(input.now.getTime() - input.retryCooldownMs).toISOString(),
    input.editorialProfile,
  ];
  // Separate first/resumed query shapes let Postgres use the existing
  // (message_kind, sent_at) index without an optional-cursor OR predicate.
  const afterSql = input.cursor
    ? "and (root.sent_at, root.id) > ($8::timestamptz, $9::uuid)"
    : "";
  if (input.cursor) params.push(input.cursor.sentAt, input.cursor.id);
  return {
    params,
    sql: `
    with initial_page as materialized (
      select root.* from signal_bot_messages root
      where root.message_kind = 'initial'
        and root.chat_id = any($1::text[])
        and ($2::timestamptz is null or root.sent_at >= $2::timestamptz)
        and root.sent_at <= $3::timestamptz
        ${afterSql}
      order by root.sent_at asc, root.id asc
      limit $4
    )
    select root.id::text as initial_id, root.sent_at::text as initial_sent_at,
      root.chat_id, root.thread_root_note_id::text,
      root.telegram_message_id::text as reply_to_message_id,
      root.baseline_at::text as baseline_at,
      n.title, n.direction, n.metrics, root.metrics as root_metrics,
      pt.target_meta, holder.address as holder_address, holder.chain as holder_chain,
      holder.target_meta as holder_target_meta,
      m.id as market_id, m.event_id, m.title as market_title, m.slug as market_slug,
      m.description as market_description, e.title as event_title,
      e.description as event_description, m.outcomes, m.venue,
      m.best_bid, m.best_ask, m.last_price, m.resolved_outcome,
      m.resolved_outcome_pct::text as resolved_outcome_pct,
      nullif(coalesce(nullif(m.metadata->>'resolutionSource',''),
        nullif(e.metadata->>'resolutionSource','')), '') as resolution_source,
      ${acceptingSql} as accepting_orders,
      coalesce(n.id is not null and m.id is not null and (
        (root.telegram_message_id is not null and coalesce(root.metrics->>'status','sent') = 'sent')
        or (root.metrics->>'contentProfile' = $7 and (
          coalesce(root.metrics->>'status','') = 'skipped'
          or root.metrics #>> '{deliveryStateV2,status}' = 'skipped'
          or root.metrics #>> '{editorialDraftV1,status}' = 'blocked'
          or root.metrics #>> '{editorialComposerV1,terminal}' = 'true'
        ))
      ) and ${terminal ? "(m.resolved_outcome is not null or m.resolved_outcome_pct is not null)" : acceptingSql}
      and ($5::boolean or not exists (
        select 1 from signal_bot_messages sent
        where sent.chat_id = root.chat_id and sent.note_id = root.thread_root_note_id
          and sent.message_kind ${terminal ? "in ('resolved_win','resolved_loss')" : "= 'followthrough_stats'"}
          and (coalesce(sent.metrics->>'status','sent') in ('blocked','delivery_unknown','sent')
            or sent.sent_at > $6::timestamptz)
      )), false) as eligible
    from initial_page root
    left join ai_notes n on n.id = root.thread_root_note_id
    left join lateral (
      select target_id, target_meta from ai_note_targets
      where note_id = n.id and target_kind = 'market' and is_primary = true
      order by target_rank asc, target_id asc limit 1
    ) pt on true
    left join unified_markets m on m.id = coalesce(
      nullif(root.metrics #>> '{publicationSnapshotV1,marketId}', ''),
      nullif(root.metrics #>> '{delivery,view,target,marketId}', ''), pt.target_id)
    left join unified_events e on e.id = m.event_id
    left join lateral (
      select w.address, w.chain, t.target_meta from ai_note_targets t
      join wallets w on w.id = t.target_id::uuid
      where t.note_id = n.id and t.target_kind = 'wallet'
      order by t.target_rank asc, t.target_id asc limit 1
    ) holder on true
    order by root.sent_at asc, root.id asc
  `,
  };
}

export async function loadFollowthroughPage(
  db: DbQuery,
  input: Parameters<typeof buildFollowthroughPageQuery>[0],
): Promise<FollowthroughScanRow[]> {
  const { sql, params } = buildFollowthroughPageQuery(input);
  return (await db.query<FollowthroughScanRow>(sql, params)).rows;
}
