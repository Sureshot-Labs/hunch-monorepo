import type { DbQuery } from "../db.js";
import {
  verifiedBuyFactsSchema,
  type SocialSourceRef,
  type VerifiedBuyFacts,
} from "../schemas/social-trade.js";
import { SocialError } from "./social-primitives.js";

// Caller aliases are fixed to n (note), t (thesis), u (author); viewer is $1.
export const SOCIAL_PUBLIC_AI = `n.producer_type = 'holder_research' and n.source_kind = 'market'
  and n.status <> 'retracted' and ((n.note_type = 'signal'
    and n.metrics #>> '{publicationDecisionV1,status}' = 'PUBLISH'
    and n.metrics #>> '{publicationDecisionV1,authority}' = 'holder_research_quality_gate')
    or (n.note_type = 'context' and n.metrics ? 'publicContextV1'))`;
export const SOCIAL_PUBLIC_AUTHOR = `u.is_active and u.social_suspended_at is null`;
export const SOCIAL_NO_BLOCK = `not exists(select 1 from user_blocks b where (b.blocker_user_id=$1::uuid and b.blocked_user_id=u.id) or (b.blocked_user_id=$1::uuid and b.blocker_user_id=u.id))`;
export const SOCIAL_PUBLIC_THESIS = `${SOCIAL_PUBLIC_AUTHOR} and ${SOCIAL_NO_BLOCK} and t.author_hidden_at is null and t.moderation_hidden_at is null and t.proof_invalidated_at is null`;
export const SOCIAL_VALID_ROOT_JOIN = `left join ai_notes valid_root on valid_root.id=case
  when n.lineage->>'thesis_root_note_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then (n.lineage->>'thesis_root_note_id')::uuid else null end and n.note_type='signal' and valid_root.note_type='signal'
  and valid_root.producer_type=n.producer_type and valid_root.source_kind=n.source_kind and valid_root.source_id=n.source_id
  and valid_root.lineage->>'thesis_key'=n.lineage->>'thesis_key'`;

export type VisibleSocialSource =
  | { kind: "thesis"; id: string; authorId: string; facts: VerifiedBuyFacts }
  | {
      kind: "hunch";
      id: string;
      authorId: null;
      marketId: string;
      side: "YES" | "NO";
      metrics: Record<string, unknown>;
      lineage: Record<string, unknown>;
    };

export async function readVisibleSocialSource(
  db: DbQuery,
  viewerId: string,
  source: SocialSourceRef,
): Promise<VisibleSocialSource> {
  if (source.kind === "thesis") {
    const { rows } = await db.query<{
      id: string;
      author_id: string;
      buy_snapshot: unknown;
    }>(
      `select t.id,t.author_id,t.buy_snapshot from user_theses t join users u on u.id=t.author_id
      where t.id=$2 and ${SOCIAL_PUBLIC_THESIS}`,
      [viewerId, source.id],
    );
    const row = rows[0];
    if (!row) throw new SocialError("source_unavailable", 404);
    if (row.author_id === viewerId) throw new SocialError("self_copy", 409);
    const facts = verifiedBuyFactsSchema.safeParse(row.buy_snapshot);
    if (!facts.success)
      throw new SocialError("source_evidence_unavailable", 409);
    return {
      kind: "thesis",
      id: row.id,
      authorId: row.author_id,
      facts: facts.data,
    };
  }
  const { rows } = await db.query<{
    id: string;
    source_id: string;
    metrics: Record<string, unknown>;
    lineage: Record<string, unknown>;
    side: string;
  }>(
    `select n.id,n.source_id,n.metrics,n.lineage,upper(n.lineage->>'side') as side from ai_notes n
    where n.id=$1 and n.note_type='signal' and ${SOCIAL_PUBLIC_AI}`,
    [source.id],
  );
  const row = rows[0];
  if (!row || (row.side !== "YES" && row.side !== "NO"))
    throw new SocialError("source_unavailable", 404);
  return {
    kind: "hunch",
    id: row.id,
    authorId: null,
    marketId: row.source_id,
    side: row.side,
    metrics: row.metrics,
    lineage: row.lineage,
  };
}
